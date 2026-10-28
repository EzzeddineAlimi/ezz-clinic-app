/*
 * B06 / issue #5 / CH-027 — business rows vs the values captured in their audit events.
 * Threat model (same as CH-026): a privileged database actor bypasses the append-only triggers
 * (session_replication_role = replica) and edits a financial row, leaving the audit chain intact.
 * The chain alone stays green; these checks must not. A finding is a RECORD MISMATCH, never a theft claim.
 * Test IDs follow MODEL_INBOX C-165 and GPT R65 (T-INT-VAL-*, T-INT-LIMIT-1). Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, adminConn, type Api, type TestDb } from './helpers.ts';
import { canonicalJson, sha256 } from '../src/platform/canonical.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
/** Clinic with one visit: care 100,000; cash payment 70,000 (R-000001). */
async function scenario() {
  const f = await standardFixture(api, db, `b06-${++n}`);
  const careId = await confirmCare(api, f.dentist, f.visitId, 100_000);
  const pay = await api.call('POST', `/api/v1/visits/${f.visitId}/payments`, { token: f.desk, body: { amountMillimes: 70_000, tender: 'CASH' } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  return { ...f, careId, paymentId: pay.body.payment.id as string, receiptId: pay.body.receipt.id as string };
}

/** Superuser edit with triggers bypassed, committed, in the test database. */
async function tamper(sql: string, params: unknown[] = []) {
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN');
    await a.query('SET LOCAL session_replication_role = replica');
    await a.query(sql, params as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
}

async function check(owner: string, body: Record<string, unknown> = {}) {
  await reauth(api, owner);
  const r = await api.call('POST', '/api/v1/integrity/check', { token: owner, body, idem: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { ok: boolean; findings: Array<{ check: string; severity: string; detail: string; refs?: Record<string, unknown> }>; auditHead: { seq: number; hash: string } };
}
async function periodId(token: string) {
  const r = await api.call('GET', '/api/v1/cash/periods/current', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.period?.id ?? r.body.id) as string;
}
const codes = (r: { findings: Array<{ check: string }> }) => [...new Set(r.findings.map(f => f.check))].sort();
async function chainOk(owner: string) {
  const v = await api.call('POST', '/api/v1/audit/verify', { token: owner, body: {}, idem: false });
  return v.body.ok as boolean;
}

test('T-INT-VAL-0 a full fictional day with every financial action produces no false alarm', async () => {
  const s = await scenario();
  // card payment, then a fee correction + partial refund, a void, a discount, a write-off, free care,
  // cash movements, a count, and a period close — with French/Arabic free text where the API allows it.
  const v2 = await newVisit(api, s.desk, s.patientId, '2026-10-28T11:00:00Z');
  const c2 = await confirmCare(api, s.dentist, v2, 80_000, 'EXAM');
  const card = await api.call('POST', `/api/v1/visits/${v2}/payments`, { token: s.desk, body: { amountMillimes: 80_000, tender: 'CARD', cardLast4: '4242' } });
  assert.equal(card.status, 201);
  assert.equal((await api.call('POST', `/api/v1/care-items/${c2}/corrections`, { token: s.dentist, body: { deltaMillimes: -20_000, reason: 'Fictif: tarif réduit / تخفيض' } })).status, 201);
  await reauth(api, s.owner);
  assert.equal((await api.call('POST', `/api/v1/payments/${card.body.payment.id}/refund`, { token: s.owner, body: { amountMillimes: 20_000, reasonCode: 'FEE_CORRECTED', reasonNote: 'Remboursement partiel — استرجاع جزئي' } })).status, 201);
  const v3 = await newVisit(api, s.desk, s.patientId, '2026-10-28T12:00:00Z');
  await confirmCare(api, s.dentist, v3, 40_000, 'SCALE');
  const p3 = await api.call('POST', `/api/v1/visits/${v3}/payments`, { token: s.desk, body: { amountMillimes: 40_000, tender: 'CASH' } });
  assert.equal((await api.call('POST', `/api/v1/payments/${p3.body.payment.id}/void`, { token: s.owner, body: { reasonCode: 'ENTERED_IN_ERROR' } })).status, 201);
  const v4 = await newVisit(api, s.desk, s.patientId, '2026-10-28T13:00:00Z');
  await confirmCare(api, s.dentist, v4, 60_000, 'XRAY');
  assert.equal((await api.call('POST', `/api/v1/visits/${v4}/adjustments`, { token: s.dentist, body: { kind: 'DISCOUNT', amountMillimes: 10_000, reasonCode: 'LOYALTY' } })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/visits/${v4}/adjustments`, { token: s.owner, body: { kind: 'WRITE_OFF', amountMillimes: 50_000, reasonCode: 'HARDSHIP', reasonNote: 'حالة اجتماعية' } })).status, 201);
  const v5 = await newVisit(api, s.desk, s.patientId, '2026-10-28T14:00:00Z');
  assert.equal((await api.call('POST', `/api/v1/visits/${v5}/care`, { token: s.dentist, body: { procedureCode: 'CHECKUP', procedureLabel: 'Contrôle gratuit', feeMillimes: 0, reason: 'Fictif: suivi' } })).status, 201);
  const pid = await periodId(s.owner);
  await reauth(api, s.owner);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${pid}/movements`, { token: s.owner, body: { kind: 'PETTY_EXPENSE', amountMillimes: 5_000, reason: 'Fictif: fournitures' } })).status, 201);
  // Paper-outage slip re-entered after recovery (payment without electronic receipt).
  const book = await api.call('POST', '/api/v1/paper-books', { token: s.owner, body: { firstNo: 1, lastNo: 5, custodianStaffId: s.clinic.staff.dentist, note: 'Carnet fictif' } });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  const v6 = await newVisit(api, s.desk, s.patientId, '2026-10-28T15:00:00Z');
  await confirmCare(api, s.dentist, v6, 30_000, 'PAPER');
  const slips = await api.call('POST', `/api/v1/paper-books/${book.body.book.id}/entries`, { token: s.desk, body: { slips: [{ slipNo: 1, kind: 'USED', amountMillimes: 30_000, tender: 'CASH', visitId: v6, writtenOn: '2026-10-28' }] } });
  assert.equal(slips.body.summary.posted, 1, JSON.stringify(slips.body));
  const cnt = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: s.dentist, body: { countedMillimes: 95_000 } });
  assert.equal(cnt.status, 201, JSON.stringify(cnt.body));
  // Owner closes the period on that count; the next period opens with a counted carry-forward.
  await reauth(api, s.owner);
  const close = await api.call('POST', `/api/v1/cash/periods/${pid}/close`, { token: s.owner, body: { acceptedCountId: cnt.body.count.id, handoverMillimes: 50_000, note: 'Remise fictive' } });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  const v7 = await newVisit(api, s.desk, s.patientId, '2026-10-28T16:00:00Z');
  await confirmCare(api, s.dentist, v7, 20_000, 'LATE');
  assert.equal((await api.call('POST', `/api/v1/visits/${v7}/payments`, { token: s.desk, body: { amountMillimes: 20_000, tender: 'CASH' } })).status, 201);
  const pid2 = await periodId(s.owner);
  assert.notEqual(pid2, pid);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${pid2}/counts`, { token: s.dentist, body: { countedMillimes: 65_000 } })).status, 201);
  const r = await check(s.owner);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
  assert.deepEqual(r.findings, []);
});

test('T-INT-VAL-1 payment amount edited 70,000 -> 7,000: PAYMENT_AUDIT_VALUE_MISMATCH while the audit chain stays valid', async () => {
  const s = await scenario();
  assert.equal((await check(s.owner)).ok, true);
  await tamper('UPDATE payments SET amount_millimes = 7000 WHERE id = $1', [s.paymentId]);
  assert.equal(await chainOk(s.owner), true, 'the hash chain alone does not see a business-row edit');
  const r = await check(s.owner);
  assert.equal(r.ok, false);
  const f = r.findings.find(x => x.check === 'PAYMENT_AUDIT_VALUE_MISMATCH');
  assert.ok(f, JSON.stringify(r.findings));
  assert.deepEqual(f!.refs, { table: 'payments', id: s.paymentId, field: 'amountMillimes', recorded: 7000, audited: 70000 });
  assert.match(f!.detail, /does not by itself show who/i, 'neutral wording, no accusation');
});

test('T-INT-VAL-1b cash relabelled as card on the payment row (CH-013 pattern) -> PAYMENT_AUDIT_VALUE_MISMATCH on tender', async () => {
  const s = await scenario();
  await tamper("UPDATE payments SET tender = 'CARD' WHERE id = $1", [s.paymentId]);
  const r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'PAYMENT_AUDIT_VALUE_MISMATCH' && f.refs?.field === 'tender' && f.refs?.recorded === 'CARD' && f.refs?.audited === 'CASH'), JSON.stringify(r.findings));
});

test('T-INT-VAL-2 allocation edited to 7,000: ALLOCATION_MISMATCH (visit balance silently grows)', async () => {
  const s = await scenario();
  await tamper('UPDATE payment_allocations SET amount_millimes = 7000 WHERE payment_id = $1', [s.paymentId]);
  const bal = await api.call('GET', `/api/v1/visits/${s.visitId}/balance`, { token: s.owner });
  assert.equal(bal.body.balance.balanceMillimes, 93_000, 'the tamper is effective on the balance');
  const r = await check(s.owner);
  const f = r.findings.find(x => x.check === 'ALLOCATION_MISMATCH');
  assert.ok(f, JSON.stringify(r.findings));
  assert.deepEqual({ allocated: f!.refs?.allocated, amount: f!.refs?.paymentAmount }, { allocated: 7000, amount: 70000 });
});

test('T-INT-VAL-3 receipt snapshot amount edited: RECEIPT_VALUE_MISMATCH and RECEIPT_SNAPSHOT_HASH_MISMATCH', async () => {
  const s = await scenario();
  await tamper(`UPDATE receipts SET snapshot = jsonb_set(snapshot, '{amountMillimes}', '7000') WHERE id = $1`, [s.receiptId]);
  const r = await check(s.owner);
  assert.deepEqual(codes(r).filter(c => c.startsWith('RECEIPT_')), ['RECEIPT_SNAPSHOT_HASH_MISMATCH', 'RECEIPT_VALUE_MISMATCH'], JSON.stringify(r.findings));
});

test('T-INT-VAL-4 same edit with a recomputed snapshot hash: still RECEIPT_VALUE_MISMATCH (a stored hash alone proves nothing)', async () => {
  const s = await scenario();
  const a = await adminConn(db.name);
  let snap: Record<string, unknown>;
  try { snap = (await a.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM receipts WHERE id = $1', [s.receiptId])).rows[0]!.snapshot; } finally { a.end(); }
  snap!.amountMillimes = 7000;
  await tamper('UPDATE receipts SET snapshot = $2, snapshot_sha256 = $3 WHERE id = $1', [s.receiptId, snap!, sha256(canonicalJson(snap!))]);
  const r = await check(s.owner);
  assert.ok(codes(r).includes('RECEIPT_VALUE_MISMATCH'), JSON.stringify(r.findings));
  assert.ok(!codes(r).includes('RECEIPT_SNAPSHOT_HASH_MISMATCH'));
});

test('T-INT-VAL-4b receipt number swapped on the receipt row: RECEIPT_VALUE_MISMATCH against the audited number', async () => {
  const s = await scenario();
  await tamper('UPDATE receipts SET number = 999 WHERE id = $1', [s.receiptId]);
  const r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'RECEIPT_VALUE_MISMATCH' && f.refs?.field === 'number'), JSON.stringify(r.findings));
});

test('T-INT-VAL-5 adjustments: refund relabelled as discount, and refund amount edited -> ADJUSTMENT_AUDIT_VALUE_MISMATCH', async () => {
  const s = await scenario();
  await api.call('POST', `/api/v1/care-items/${s.careId}/corrections`, { token: s.dentist, body: { deltaMillimes: -40_000, reason: 'Fictional fee lowered' } });
  await reauth(api, s.owner);
  const rf = await api.call('POST', `/api/v1/payments/${s.paymentId}/refund`, { token: s.owner, body: { amountMillimes: 10_000, reasonCode: 'FEE_CORRECTED' } });
  assert.equal(rf.status, 201, JSON.stringify(rf.body));
  const adj = rf.body.refund.id as string;
  assert.equal((await check(s.owner)).ok, true);
  await tamper('UPDATE adjustments SET amount_millimes = 30000 WHERE id = $1', [adj]);
  let r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'ADJUSTMENT_AUDIT_VALUE_MISMATCH' && f.refs?.field === 'amountMillimes'), JSON.stringify(r.findings));
  await tamper("UPDATE adjustments SET amount_millimes = 10000, kind = 'DISCOUNT', payment_id = NULL, tender = NULL WHERE id = $1", [adj]);
  r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'ADJUSTMENT_AUDIT_VALUE_MISMATCH' && f.refs?.field === 'kind'), JSON.stringify(r.findings));
});

test('T-INT-VAL-5b care fee and correction delta edited -> CARE_AUDIT_VALUE_MISMATCH', async () => {
  const s = await scenario();
  const corr = await api.call('POST', `/api/v1/care-items/${s.careId}/corrections`, { token: s.dentist, body: { deltaMillimes: -20_000, reason: 'Fictional fee lowered' } });
  await tamper('UPDATE care_items SET fee_millimes = 150000 WHERE id = $1', [s.careId]);
  await tamper('UPDATE care_items SET fee_millimes = -90000 WHERE id = $1', [corr.body.correction.id]);
  const r = await check(s.owner);
  const care = r.findings.filter(f => f.check === 'CARE_AUDIT_VALUE_MISMATCH').map(f => f.refs?.id).sort();
  assert.deepEqual(care, [s.careId, corr.body.correction.id].sort(), JSON.stringify(r.findings));
});

test('T-INT-VAL-6 cash: counted figure edited, and the stored expected figure lowered to hide a shortfall -> both detected', async () => {
  const s = await scenario();
  const pid = await periodId(s.owner);
  const cnt = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: s.dentist, body: { countedMillimes: 50_000 } });
  assert.equal(cnt.status, 201, JSON.stringify(cnt.body));
  await reauth(api, s.owner);
  const mv = await api.call('POST', `/api/v1/cash/periods/${pid}/movements`, { token: s.owner, body: { kind: 'OWNER_WITHDRAWAL', amountMillimes: 10_000, reason: 'Fictional handover' } });
  assert.equal(mv.status, 201, JSON.stringify(mv.body));
  assert.equal((await check(s.owner)).ok, true);
  await tamper('UPDATE cash_counts SET expected_millimes = 50000, difference_millimes = 0 WHERE id = $1', [cnt.body.count.id]);
  let r = await check(s.owner);
  const exp = r.findings.find(f => f.check === 'CASH_COUNT_EXPECTED_RECOMPUTE_MISMATCH');
  assert.ok(exp, JSON.stringify(r.findings));
  assert.deepEqual({ stored: exp!.refs?.storedExpected, recomputed: exp!.refs?.recomputedExpected }, { stored: 50000, recomputed: 70000 });
  await tamper('UPDATE cash_counts SET counted_millimes = 70000, expected_millimes = 70000, difference_millimes = 0 WHERE id = $1', [cnt.body.count.id]);
  await tamper('UPDATE cash_movements SET amount_millimes = 1000 WHERE id = $1', [mv.body.movement.id]);
  r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'CASH_COUNT_AUDIT_VALUE_MISMATCH' && f.refs?.field === 'countedMillimes'), JSON.stringify(r.findings));
  assert.ok(r.findings.some(f => f.check === 'CASH_MOVEMENT_AUDIT_VALUE_MISMATCH' && f.refs?.field === 'amountMillimes'), JSON.stringify(r.findings));
});

test('T-INT-VAL-7 a deleted adjustment or care row whose audit event remains -> AUDITED_ROW_MISSING', async () => {
  const s = await scenario();
  const adj = await api.call('POST', `/api/v1/visits/${s.visitId}/adjustments`, { token: s.dentist, body: { kind: 'DISCOUNT', amountMillimes: 5_000, reasonCode: 'LOYALTY' } });
  await tamper('DELETE FROM adjustments WHERE id = $1', [adj.body.adjustment.id]);
  const r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'AUDITED_ROW_MISSING' && f.refs?.table === 'adjustments' && f.refs?.id === adj.body.adjustment.id), JSON.stringify(r.findings));
});

test('T-INT-VAL-8 tenant isolation: clinic B sees none of clinic A findings', async () => {
  const a = await scenario();
  const b = await scenario();
  await tamper('UPDATE payments SET amount_millimes = 7000 WHERE id = $1', [a.paymentId]);
  assert.equal((await check(a.owner)).ok, false);
  const rb = await check(b.owner);
  assert.equal(rb.ok, true, JSON.stringify(rb.findings));
  assert.ok(!JSON.stringify(rb).includes(a.paymentId));
});

test('T-INT-LIMIT-1 honest limit: an edit that also rewrites the audit chain is invisible WITHOUT an owner checkpoint, and caught WITH one', async () => {
  const s = await scenario();
  await reauth(api, s.owner);
  const cp = await api.call('POST', '/api/v1/audit/checkpoints', { token: s.owner, body: { note: 'fictional owner paper copy' } });
  assert.equal(cp.status, 201);
  const anchor = { seq: cp.body.checkpoint.seq as number, hash: cp.body.checkpoint.hash as string };
  // Superuser changes the payment AND rewrites its audit event plus every later event with valid hashes.
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN');
    await a.query('SET LOCAL session_replication_role = replica');
    await a.query('UPDATE payments SET amount_millimes = 7000 WHERE id = $1', [s.paymentId]);
    await a.query('UPDATE payment_allocations SET amount_millimes = 7000 WHERE payment_id = $1', [s.paymentId]);
    const snap = (await a.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM receipts WHERE id = $1', [s.receiptId])).rows[0]!.snapshot;
    snap.amountMillimes = 7000;
    await a.query('UPDATE receipts SET snapshot = $2, snapshot_sha256 = $3 WHERE id = $1', [s.receiptId, snap, sha256(canonicalJson(snap))]);
    const evs = (await a.query<{ seq: number; canonical: string; payload: Record<string, unknown>; entity_id: string; action: string }>(
      'SELECT seq, canonical, payload, entity_id, action FROM audit_events WHERE clinic_id = $1 ORDER BY seq', [s.clinic.id])).rows;
    const start = evs.find(e => e.action === 'payment.recorded' && e.entity_id === s.paymentId)!.seq;
    let prev = (await a.query<{ hash: string }>('SELECT hash FROM audit_events WHERE clinic_id = $1 AND seq = $2', [s.clinic.id, start - 1])).rows[0]!.hash;
    for (const e of evs.filter(x => x.seq >= start)) {
      const doc = JSON.parse(e.canonical);
      if (e.seq === start) doc.payload = { ...doc.payload, amountMillimes: 7000 };
      doc.prevHash = prev;
      const canonical = canonicalJson(doc);
      const hash = sha256(prev + '\n' + canonical);
      await a.query('UPDATE audit_events SET payload = $3, canonical = $4, prev_hash = $5, hash = $6 WHERE clinic_id = $1 AND seq = $2', [s.clinic.id, e.seq, doc.payload, canonical, prev, hash]);
      prev = hash;
    }
    await a.query('UPDATE audit_heads SET last_hash = $2 WHERE clinic_id = $1', [s.clinic.id, prev]);
    await a.query('COMMIT');
  } finally { a.end(); }
  const blind = await check(s.owner);
  assert.equal(blind.ok, true, 'documented limit: a consistent rewrite of rows AND chain is not detectable from inside the database');
  const anchored = await check(s.owner, { anchors: [anchor] });
  assert.equal(anchored.ok, false);
  assert.ok(codes(anchored).includes('AUDIT_ANCHOR_HASH_MISMATCH'), JSON.stringify(anchored.findings));
});
