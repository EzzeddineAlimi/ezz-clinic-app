/*
 * R73-H — B06 hardening for Muse M-267 (objections 1-7) and CH-033/CH-034. Each test reproduces a privileged edit
 * (superuser, append-only triggers bypassed) that the integrity check missed; it must now be reported, neutrally.
 * Limits that stay: a consistent rewrite of rows AND audit chain is caught only with an outside owner checkpoint
 * (R73-A); money never recorded anywhere stays invisible (CH-002). Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, adminConn, reauth, type Api, type TestDb } from './helpers.ts';
import { canonicalJson, sha256 } from '../src/platform/canonical.ts';
import { Db } from '../src/platform/db.ts';
import { integrityCheck } from '../src/modules/integrity.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic() {
  const f = await standardFixture(api, db, `b06h-${++n}`, { openingFloatMillimes: 50_000 });
  const period = (await api.call('GET', '/api/v1/cash/periods/current', { token: f.desk })).body.period as { id: string };
  return { ...f, periodId: period.id };
}
type F = Awaited<ReturnType<typeof clinic>>;
async function pay(f: F, visitId: string, amountMillimes: number, tender: 'CASH' | 'CARD' = 'CASH') {
  const r = await api.call('POST', `/api/v1/visits/${visitId}/payments`, { token: f.desk, body: { amountMillimes, tender, confirmDuplicate: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { payment: { id: string }; receipt: { id: string; number: number } };
}
async function count(f: F, counted: number, extra: Record<string, unknown> = {}) {
  const r = await api.call('POST', `/api/v1/cash/periods/${f.periodId}/counts`, { token: f.dentist, body: { countedMillimes: counted, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.count.id as string;
}
async function checks(f: { owner: string }) {
  const r = await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.findings as Array<{ check: string; refs?: Record<string, unknown>; detail: string }>;
}
/** Superuser edit with append-only triggers disabled for this transaction only. */
async function tamper(sqls: Array<[string, unknown[]]>) {
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    for (const [s, p] of sqls) await a.query(s, p as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
}
const has = (fs: Array<{ check: string }>, check: string) => fs.some(x => x.check === check);
/** A refund needs patient credit: the dentist lowers the fee first (correction), then the owner refunds. */
async function refund(f: F, careId: string, paymentId: string, amount: number, reasonNote?: string) {
  const c = await api.call('POST', `/api/v1/care-items/${careId}/corrections`, { token: f.dentist, body: { deltaMillimes: -amount, reason: 'Fictional fee lowered' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await reauth(api, f.owner);
  const r = await api.call('POST', `/api/v1/payments/${paymentId}/refund`, { token: f.owner, body: { amountMillimes: amount, reasonCode: 'FEE_CORRECTED', ...(reasonNote ? { reasonNote } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.refund.id as string;
}

test('T-INT-CASH-0 a clean cash day (payments, movement, count, refund, close, carry-forward count) has no findings', async () => {
  const f = await clinic();
  const careId = await confirmCare(api, f.dentist, f.visitId, 30_000);
  const p = await pay(f, f.visitId, 20_000);
  await pay(f, f.visitId, 10_000, 'CARD');
  await reauth(api, f.owner);
  const mv = await api.call('POST', `/api/v1/cash/periods/${f.periodId}/movements`, { token: f.owner, body: { kind: 'PETTY_EXPENSE', amountMillimes: 5_000, reason: 'Fictional supplies', voucherRef: 'V-1' } });
  assert.equal(mv.status, 201, JSON.stringify(mv.body));
  await refund(f, careId, p.payment.id, 2_000, 'Fictional partial refund');
  const c = await count(f, 63_000, { denominations: { '20000': 3, '1000': 3 } });
  const close = await api.call('POST', `/api/v1/cash/periods/${f.periodId}/close`, { token: f.owner, body: { acceptedCountId: c, handoverMillimes: 13_000 } });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  const next = (await api.call('GET', '/api/v1/cash/periods/current', { token: f.desk })).body.period.id as string;
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${next}/counts`, { token: f.dentist, body: { countedMillimes: 50_000 } })).status, 201);
  assert.deepEqual(await checks(f), []);
});

test('T-INT-CASH-CLOSE-1 a privileged edit to closed-period handover is detected against its audit event', async () => {
  const f = await clinic();
  const acceptedCountId = await count(f, 50_000);
  await reauth(api, f.owner);
  const close = await api.call('POST', `/api/v1/cash/periods/${f.periodId}/close`, {
    token: f.owner, body: { acceptedCountId, handoverMillimes: 10_000 },
  });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  assert.deepEqual(await checks(f), [], 'the unchanged fictional close is consistent');

  await tamper([['UPDATE cash_periods SET handover_millimes = handover_millimes + 1000 WHERE id = $1', [f.periodId]]]);
  const findings = await checks(f);
  assert.ok(findings.some(x => x.check === 'CASH_PERIOD_AUDIT_VALUE_MISMATCH' && x.detail.includes('handoverMillimes')),
    'a changed handover must disagree with cash.period_closed: ' + JSON.stringify(findings));
});

test('T-INT-CASH-A (M-267 1) opening float + stored expected edited together is reported (first period and a carry-forward period)', async () => {
  const f = await clinic();
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  await pay(f, f.visitId, 20_000);
  const c = await count(f, 70_000);
  await tamper([['UPDATE cash_periods SET opening_float_millimes = opening_float_millimes - 20000 WHERE id = $1', [f.periodId]],
    ['UPDATE cash_counts SET expected_millimes = expected_millimes - 20000, difference_millimes = counted_millimes - (expected_millimes - 20000) WHERE id = $1', [c]]]);
  assert.ok(has(await checks(f), 'CASH_PERIOD_AUDIT_VALUE_MISMATCH'), 'first period float edit');
  // Carry-forward period (no cash.period_opened event; its float comes from the previous close).
  const g = await clinic();
  const cg = await count(g, 50_000);
  await reauth(api, g.owner);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${g.periodId}/close`, { token: g.owner, body: { acceptedCountId: cg, handoverMillimes: 0 } })).status, 200);
  const next = (await api.call('GET', '/api/v1/cash/periods/current', { token: g.desk })).body.period.id as string;
  const c2 = (await api.call('POST', `/api/v1/cash/periods/${next}/counts`, { token: g.dentist, body: { countedMillimes: 50_000 } })).body.count.id as string;
  await tamper([['UPDATE cash_periods SET opening_float_millimes = 30000 WHERE id = $1', [next]],
    ['UPDATE cash_counts SET expected_millimes = 30000, difference_millimes = 20000 WHERE id = $1', [c2]]]);
  assert.ok(has(await checks(g), 'CASH_PERIOD_AUDIT_VALUE_MISMATCH'), 'carry-forward float edit');
});

test('T-INT-CASH-B (M-267 1) count submitted_at moved back + expected edited to match is reported', async () => {
  const f = await clinic();
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  await pay(f, f.visitId, 20_000);
  const c = await count(f, 70_000);
  await tamper([["UPDATE cash_counts SET submitted_at = (SELECT opened_at FROM cash_periods WHERE id = period_id) + interval '1 millisecond', expected_millimes = 50000, difference_millimes = 20000 WHERE id = $1", [c]]]);
  assert.ok(has(await checks(f), 'CASH_COUNT_AUDIT_VALUE_MISMATCH'));
});

test('T-INT-CASH-C (CH-034) a cash payment moved past the count cut-off + expected edited to match is reported', async () => {
  const f = await clinic();
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  const p = await pay(f, f.visitId, 20_000);
  const c = await count(f, 70_000);
  await tamper([["UPDATE payments SET recorded_at = recorded_at + interval '6 hours' WHERE id = $1", [p.payment.id]],
    ['UPDATE cash_counts SET expected_millimes = 50000, difference_millimes = 20000 WHERE id = $1', [c]]]);
  assert.ok(has(await checks(f), 'PAYMENT_AUDIT_VALUE_MISMATCH'));
});

test('T-INT-CASH-D (CH-034) a cash movement or a refund moved in time is reported', async () => {
  const f = await clinic();
  const careId = await confirmCare(api, f.dentist, f.visitId, 20_000);
  const p = await pay(f, f.visitId, 20_000);
  await reauth(api, f.owner);
  const m = await api.call('POST', `/api/v1/cash/periods/${f.periodId}/movements`, { token: f.owner, body: { kind: 'PETTY_EXPENSE', amountMillimes: 5_000, reason: 'Fictional supplies', voucherRef: 'V-2' } });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const rf = await refund(f, careId, p.payment.id, 2_000);
  await count(f, 63_000);
  await tamper([["UPDATE cash_movements SET recorded_at = recorded_at + interval '3 hours' WHERE id = $1", [m.body.movement.id]],
    ["UPDATE adjustments SET created_at = created_at + interval '3 hours' WHERE id = $1", [rf]]]);
  const fs = await checks(f);
  assert.ok(has(fs, 'CASH_MOVEMENT_AUDIT_VALUE_MISMATCH'), JSON.stringify(fs.map(x => x.check)));
  assert.ok(has(fs, 'ADJUSTMENT_AUDIT_VALUE_MISMATCH'), JSON.stringify(fs.map(x => x.check)));
});

test('T-INT-CASH-E (M-267 6) a deleted cash period returns findings instead of aborting the integrity check', async () => {
  const f = await clinic();
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  await pay(f, f.visitId, 20_000, 'CARD');
  await count(f, 50_000);
  await tamper([['ALTER TABLE cash_counts DISABLE TRIGGER ALL', []], ['ALTER TABLE payments DISABLE TRIGGER ALL', []],
    ['DELETE FROM cash_periods WHERE id = $1', [f.periodId]], ['ALTER TABLE cash_counts ENABLE TRIGGER ALL', []], ['ALTER TABLE payments ENABLE TRIGGER ALL', []]]);
  const r = await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.findings.some((x: { check: string; refs?: { table?: string } }) => x.check === 'AUDITED_ROW_MISSING' && x.refs?.table === 'cash_periods'), JSON.stringify(r.body.findings.map((x: { check: string }) => x.check)));
});

test('T-INT-CASH-F (M-267 5) stored difference or denominations edited alone are reported', async () => {
  const f = await clinic();
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  await pay(f, f.visitId, 20_000);
  const c = await count(f, 65_000, { denominations: { '20000': 3, '5000': 1 } });
  // The stored difference alone cannot be edited: a database CHECK ties it to counted - expected (even for a superuser).
  await assert.rejects(tamper([['UPDATE cash_counts SET difference_millimes = 0 WHERE id = $1', [c]]]), /check constraint/);
  await tamper([[`UPDATE cash_counts SET denominations = '{"20000": 2, "5000": 5}' WHERE id = $1`, [c]]]);
  assert.ok(has(await checks(f), 'CASH_COUNT_AUDIT_VALUE_MISMATCH'), 'denominations');
});

test('T-INT-RCPT-1 (M-267 2) a receipt snapshot field edited with its hash recomputed is reported', async () => {
  const f = await clinic();
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  const p = await pay(f, f.visitId, 20_000);
  const a = await adminConn(db.name);
  let snap: Record<string, unknown>;
  try { snap = (await a.query<{ snapshot: Record<string, unknown> }>('SELECT snapshot FROM receipts WHERE id = $1', [p.receipt.id] as never[])).rows[0]!.snapshot; } finally { a.end(); }
  const forged = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
  const key = ['patientName', 'payeeName', 'patient', 'payee'].find(k => k in forged) ?? 'tender';
  forged[key] = typeof forged[key] === 'object' && forged[key] !== null ? { ...(forged[key] as object), familyName: 'Autre Fictif' } : key === 'tender' ? 'CARD' : 'Autre Fictif';
  await tamper([['UPDATE receipts SET snapshot = $1, snapshot_sha256 = $2 WHERE id = $3', [forged, sha256(canonicalJson(forged)), p.receipt.id]]]);
  assert.ok(has(await checks(f), 'RECEIPT_VALUE_MISMATCH'), `edited snapshot field ${key}`);
});

test('T-INT-CORR-1 (M-267 3) a correction row tooth/procedure edited, or a care reason edited, is reported', async () => {
  const f = await clinic();
  const care = (await api.call('POST', `/api/v1/visits/${f.visitId}/care`, { token: f.dentist, body: { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'MO', feeMillimes: 0, reason: 'Fictional free follow-up' } })).body.careItem.id as string;
  const v2 = await newVisit(api, f.desk, f.patientId, '2026-10-28T11:00:00Z');
  const c2 = await confirmCare(api, f.dentist, v2, 80_000, 'RESTO');
  const corr = await api.call('POST', `/api/v1/care-items/${c2}/corrections`, { token: f.dentist, body: { deltaMillimes: -10_000, reason: 'Fictional: shorter session' } });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  await tamper([["UPDATE care_items SET tooth_fdi = 11, procedure_code = 'EXTRACT' WHERE id = $1", [corr.body.correction.id]]]);
  assert.ok(has(await checks(f), 'CARE_AUDIT_VALUE_MISMATCH'), 'correction clinical fields');
  const g = await clinic();
  const free = (await api.call('POST', `/api/v1/visits/${g.visitId}/care`, { token: g.dentist, body: { procedureCode: 'CHECK', procedureLabel: 'Fictional check', feeMillimes: 0, reason: 'Fictional free follow-up' } })).body.careItem.id as string;
  await tamper([["UPDATE care_items SET reason = 'Edited reason' WHERE id = $1", [free]]]);
  assert.ok(has(await checks(g), 'CARE_AUDIT_VALUE_MISMATCH'), 'care reason');
  void care;
});

test('T-INT-ADJ-1 (M-267 4) a refund moved to another visit, or an adjustment note edited, is reported (note compared by hash only)', async () => {
  const f = await clinic();
  const careId = await confirmCare(api, f.dentist, f.visitId, 20_000);
  const p = await pay(f, f.visitId, 20_000);
  const other = await newVisit(api, f.desk, f.patientId, '2026-10-28T12:00:00Z');
  const id = await refund(f, careId, p.payment.id, 2_000, 'Fictional note');
  await tamper([['UPDATE adjustments SET visit_id = $1 WHERE id = $2', [other, id]]]);
  const fs = await checks(f);
  assert.ok(fs.some(x => x.check === 'ADJUSTMENT_AUDIT_VALUE_MISMATCH' && x.refs?.field === 'visitId'), JSON.stringify(fs.map(x => [x.check, x.refs?.field])));
  await tamper([['UPDATE adjustments SET visit_id = $1 WHERE id = $2', [f.visitId, id]], ["UPDATE adjustments SET reason_note = 'Edited note' WHERE id = $1", [id]]]);
  const fs2 = await checks(f);
  const hit = fs2.find(x => x.check === 'ADJUSTMENT_AUDIT_VALUE_MISMATCH' && x.refs?.field === 'reasonNoteSha256');
  assert.ok(hit, JSON.stringify(fs2.map(x => [x.check, x.refs?.field])));
  assert.ok(!JSON.stringify(fs2).includes('Edited note') && !JSON.stringify(fs2).includes('Fictional note'), 'free text never appears in findings');
});

test('T-INT-SCOPE-1 (M-267 7) called without row-level security, the check still only looks at the requested clinic', async () => {
  const a = await clinic(); const b = await clinic();
  await confirmCare(api, a.dentist, a.visitId, 100_000); await pay(a, a.visitId, 20_000);
  await confirmCare(api, b.dentist, b.visitId, 100_000); await pay(b, b.visitId, 20_000); await pay(b, b.visitId, 30_000);
  const adminUrl = new URL(process.env.EZZ_TEST_ADMIN_URL!);
  adminUrl.pathname = '/' + db.name; // preserve TLS/host query parameters
  const su = new Db(adminUrl.toString()); // superuser: RLS does not apply
  try {
    const r = await su.tx(a.clinic.id, tx => integrityCheck(tx, a.clinic.id));
    assert.deepEqual(r.findings.map(x => x.check), []);
    assert.equal(r.receiptsIssued, 1, 'only clinic A receipts are counted');
  } finally { await su.close(); }
});
