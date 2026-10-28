/*
 * C4 — Idempotent financial operations, concurrency, receipt numbering, partial payments, adjustments.
 * GPT_SECURITY_BASELINE T-IDEM-1 (v0.1 RED: 2 payments, receipts #2 and #3) must be GREEN here.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, adminConn, key, reauth, type TestDb, type Api } from './helpers.ts';

let db: TestDb; let api: Api; let A: Awaited<ReturnType<typeof standardFixture>>;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); A = await standardFixture(api, db); });
after(async () => { await api.close(); await db.drop(); });

const pay = (visitId: string, token: string, body: Record<string, unknown>, idem?: string) => api.call('POST', `/api/v1/visits/${visitId}/payments`, { token, body, idem });

async function counts(visitId?: string) {
  const a = await adminConn(db.name);
  try {
    const p = await a.query<{ n: number }>('SELECT count(*)::int AS n FROM payments' + (visitId ? ' WHERE visit_id = $1' : ''), visitId ? [visitId] : []);
    const r = await a.query<{ n: number }>('SELECT count(*)::int AS n FROM receipts');
    return { payments: p.rows[0]!.n, receipts: r.rows[0]!.n };
  } finally { a.end(); }
}

test('FRAUD-SCENARIO-70 partial payment: fee 100,000; pay 70,000 cash -> receipt states 70,000 and balance 30,000', async () => {
  await confirmCare(api, A.dentist, A.visitId, 100_000);
  const r = await pay(A.visitId, A.desk, { amountMillimes: 70_000, tender: 'CASH' });
  assert.equal(r.status, 201);
  assert.equal(r.body.balanceAfterMillimes, 30_000);
  assert.equal(r.body.receipt.number, 1);
  const rc = await api.call('GET', `/api/v1/receipts/${r.body.receipt.id}`, { token: A.desk });
  assert.equal(rc.body.receipt.snapshot.amountMillimes, 70_000);
  assert.equal(rc.body.receipt.snapshot.balanceAfterMillimes, 30_000);
  assert.equal(rc.body.receipt.snapshot.amountText, '70.000 TND');
  assert.match(rc.body.receipt.snapshot.notice, /NOT A FISCAL DOCUMENT/);
  // The receipt states what was recorded. If the patient really paid 70,000 but the desk records 100,000,
  // the patient-held receipt shows 100,000 and the drawer count is 30,000 short (see C2 tests); the software
  // alone cannot know which figure the patient handed over (Mode B residual, CH-002).
});

test('T-IDEM-1 same key + same body twice -> ONE payment, ONE receipt; replay flagged', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  const before = await counts();
  const k = key();
  const r1 = await pay(v, A.desk, { amountMillimes: 50_000, tender: 'CASH' }, k);
  const r2 = await pay(v, A.desk, { amountMillimes: 50_000, tender: 'CASH' }, k);
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  assert.equal(r2.body.replayed, true);
  assert.equal(r2.body.payment.id, r1.body.payment.id);
  assert.equal(r2.body.receipt.number, r1.body.receipt.number);
  const after_ = await counts();
  assert.equal(after_.payments - before.payments, 1);
  assert.equal(after_.receipts - before.receipts, 1);
});

test('T-IDEM-2 same key + different body -> 409 IDEMPOTENCY_KEY_REUSED, nothing written', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  const k = key();
  assert.equal((await pay(v, A.desk, { amountMillimes: 30_000, tender: 'CASH' }, k)).status, 201);
  const before = await counts();
  const r = await pay(v, A.desk, { amountMillimes: 40_000, tender: 'CASH' }, k);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(await counts(), before);
  // a different user replaying someone else's key is also a different request
  const r3 = await pay(v, A.owner, { amountMillimes: 30_000, tender: 'CASH' }, k);
  assert.equal(r3.status, 409);
});

test('T-IDEM-3 different keys, identical amount within 2 minutes -> needs explicit confirmation', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  assert.equal((await pay(v, A.desk, { amountMillimes: 30_000, tender: 'CASH' })).status, 201);
  const r = await pay(v, A.desk, { amountMillimes: 30_000, tender: 'CASH' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'POSSIBLE_DUPLICATE_PAYMENT');
  const ok = await pay(v, A.desk, { amountMillimes: 30_000, tender: 'CASH', confirmDuplicate: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.balanceAfterMillimes, 40_000);
});

test('T-IDEM-CONC 10 parallel requests with the same key (network retry storm) -> exactly one payment and one receipt', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  const before = await counts();
  const k = key();
  const rs = await Promise.all(Array.from({ length: 10 }, () => pay(v, A.desk, { amountMillimes: 25_000, tender: 'CASH' }, k)));
  assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.status)));
  assert.equal(new Set(rs.map(r => r.body.payment.id)).size, 1);
  assert.equal(rs.filter(r => r.body.replayed).length, 9);
  const after_ = await counts();
  assert.equal(after_.payments - before.payments, 1);
  assert.equal(after_.receipts - before.receipts, 1);
});

test('T-RACE-1 two parallel different-key payments of 60,000 on a 100,000 balance -> one succeeds, one 409', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  const rs = await Promise.all([pay(v, A.desk, { amountMillimes: 60_000, tender: 'CASH' }), pay(v, A.owner, { amountMillimes: 60_000, tender: 'CARD' })]);
  const statuses = rs.map(r => r.status).sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = rs.find(r => r.status === 409)!;
  assert.equal(loser.body.error.code, 'AMOUNT_EXCEEDS_BALANCE');
  const bal = await api.call('GET', `/api/v1/visits/${v}/balance`, { token: A.desk });
  assert.equal(bal.body.balance.balanceMillimes, 40_000);
});

test('T-REC-CONC 20 parallel payments on 20 visits -> receipt numbers unique and contiguous', async () => {
  const visits: string[] = [];
  for (let i = 0; i < 20; i++) { const v = await newVisit(api, A.desk, A.patientId, `2026-11-0${1 + (i % 9)}T0${i % 9}:00:00Z`); await confirmCare(api, A.dentist, v, 10_000); visits.push(v); }
  const rs = await Promise.all(visits.map(v => pay(v, A.desk, { amountMillimes: 10_000, tender: 'CASH' })));
  assert.ok(rs.every(r => r.status === 201));
  const a = await adminConn(db.name);
  try {
    const nums = (await a.query<{ number: number }>('SELECT number FROM receipts ORDER BY number')).rows.map(r => r.number);
    assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1), 'gap-free 1..N');
  } finally { a.end(); }
});

test('T-PAY-2 hostile payment inputs: zero, negative, float, string, over balance, no tender, no care', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  const noCare = await pay(v, A.desk, { amountMillimes: 1_000, tender: 'CASH' });
  assert.equal(noCare.status, 409); assert.equal(noCare.body.error.code, 'CARE_NOT_CONFIRMED');
  await confirmCare(api, A.dentist, v, 100_000);
  for (const amt of [0, -1, 1.5, '1000', 100_001, Number.MAX_SAFE_INTEGER]) {
    const r = await pay(v, A.desk, { amountMillimes: amt, tender: 'CASH' });
    assert.ok(r.status === 400 || r.status === 409, `amount ${String(amt)} -> ${r.status}`);
  }
  assert.equal((await pay(v, A.desk, { amountMillimes: 1_000 })).status, 400, 'tender is an explicit choice');
  assert.equal((await pay(v, A.desk, { amountMillimes: 1_000, tender: 'BITCOIN' })).status, 400);
  assert.equal((await pay(v, A.desk, { amountMillimes: 1_000, tender: 'CASH', cardLast4: '1234' })).status, 201, 'card fields ignored for cash');
});

test('T-ADJ-1 receptionist cannot discount, refund or void; dentist discount works; owner refund needs credit', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  const care = await confirmCare(api, A.dentist, v, 100_000);
  const p = await pay(v, A.desk, { amountMillimes: 100_000, tender: 'CASH' });
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/adjustments`, { token: A.desk, body: { kind: 'DISCOUNT', amountMillimes: 10_000, reasonCode: 'LOYALTY' } })).status, 403);
  assert.equal((await api.call('POST', `/api/v1/payments/${p.body.payment.id}/refund`, { token: A.desk, body: { amountMillimes: 10_000, reasonCode: 'OVERCHARGE' } })).status, 403);
  assert.equal((await api.call('POST', `/api/v1/payments/${p.body.payment.id}/void`, { token: A.desk, body: { reasonCode: 'WRONG_PATIENT' } })).status, 403);
  assert.equal((await api.call('POST', `/api/v1/payments/${p.body.payment.id}/void`, { token: A.dentist, body: { reasonCode: 'WRONG_PATIENT' } })).status, 403);
  // owner refund without any credit -> refused (dentist must correct the fee first)
  await reauth(api, A.owner);
  const noCredit = await api.call('POST', `/api/v1/payments/${p.body.payment.id}/refund`, { token: A.owner, body: { amountMillimes: 10_000, reasonCode: 'OVERCHARGE' } });
  assert.equal(noCredit.status, 409);
  // dentist corrects fee down by 10,000 -> credit of 10,000 -> owner refunds 10,000 -> balance 0, REFUND receipt numbered
  await api.call('POST', `/api/v1/care-items/${care}/corrections`, { token: A.dentist, body: { deltaMillimes: -10_000, reason: 'Fictional fee correction' } });
  const ref = await api.call('POST', `/api/v1/payments/${p.body.payment.id}/refund`, { token: A.owner, body: { amountMillimes: 10_000, reasonCode: 'OVERCHARGE' } });
  assert.equal(ref.status, 201);
  assert.equal(ref.body.balance.balanceMillimes, 0);
  assert.equal(ref.body.receipt.number, p.body.receipt.number + 1);
  // discount by dentist on another visit
  const v2 = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v2, 100_000);
  const d = await api.call('POST', `/api/v1/visits/${v2}/adjustments`, { token: A.dentist, body: { kind: 'DISCOUNT', amountMillimes: 20_000, reasonCode: 'SOCIAL_CASE', reasonNote: 'Fictional' } });
  assert.equal(d.status, 201);
  assert.equal(d.body.balance.balanceMillimes, 80_000);
  assert.equal(d.body.adjustment.authorizedRole, 'DENTIST');
});

test('T-VOID-1 owner void: original payment and receipt preserved, VOID receipt numbered, cannot void twice', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 50_000);
  const p = await pay(v, A.desk, { amountMillimes: 50_000, tender: 'CARD' });
  await reauth(api, A.owner);
  const r = await api.call('POST', `/api/v1/payments/${p.body.payment.id}/void`, { token: A.owner, body: { reasonCode: 'WRONG_PATIENT', reasonNote: 'Fictional' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.balance.balanceMillimes, 50_000);
  const again = await api.call('POST', `/api/v1/payments/${p.body.payment.id}/void`, { token: A.owner, body: { reasonCode: 'WRONG_PATIENT' } });
  assert.equal(again.status, 409);
  const orig = await api.call('GET', `/api/v1/receipts/${p.body.receipt.id}`, { token: A.desk });
  assert.equal(orig.status, 200, 'original receipt still exists');
});

test('T-REPRINT-1 reprint is marked COPY and never consumes a number', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 20_000);
  const p = await pay(v, A.desk, { amountMillimes: 20_000, tender: 'CASH' });
  const before = await counts();
  const r = await api.call('POST', `/api/v1/receipts/${p.body.receipt.id}/reprint`, { token: A.desk, body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.receipt.copy, true);
  assert.equal(r.body.receipt.number, p.body.receipt.number);
  assert.deepEqual(await counts(), before);
});

test('T-MONEY-1 exact millime arithmetic: 3 x 33,333 + 1 = 100,000 with no float drift', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  for (let i = 0; i < 3; i++) assert.equal((await pay(v, A.desk, { amountMillimes: 33_333, tender: 'CASH', confirmDuplicate: true })).status, 201);
  const last = await pay(v, A.desk, { amountMillimes: 1, tender: 'CASH' });
  assert.equal(last.body.balanceAfterMillimes, 0);
  assert.equal((await pay(v, A.desk, { amountMillimes: 1, tender: 'CASH' })).status, 409, 'overpayment by 1 millime rejected');
});
