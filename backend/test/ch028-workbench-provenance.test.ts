/*
 * CH-028 — the visit workbench must not present a zeroed (written-off / corrected-to-zero) visit as
 * "no payment required", and must show the owner how a balance was reduced (adjustments, corrections,
 * refunds/voids with their receipt numbers). Test IDs follow MODEL_INBOX C-166 / C-173 (T-WB-ADJ-*,
 * T-WB-PRIV-1, T-WB-TENANT-1, T-WB-VOID-1, T-WB-REFUND-1) and CH-031 (T-STATE-1).
 * All data synthetic. Neutral wording only: a zeroed balance is a review item, never an accusation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, reauth, type Api, type TestDb } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';

let db: TestDb; let api: Api;
let A: Awaited<ReturnType<typeof standardFixture>>;
let B: Awaited<ReturnType<typeof standardFixture>>;

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  A = await standardFixture(api, db, 'wb-prov-a');
  B = await standardFixture(api, db, 'wb-prov-b');
});
after(async () => { await api.close(); await db.drop(); });

const view = (token: string, visitId: string) => api.call('GET', `/api/v1/visits/${visitId}/workbench`, { token });
let slot = 0;
const visit = () => newVisit(api, A.desk, A.patientId, `2026-10-29T${String(8 + slot++).padStart(2, '0')}:00:00Z`);

test('T-WB-ADJ-1 care 100,000 written off to zero, no payment -> OWNER_REVIEW_ZEROED_BALANCE with the write-off visible', async () => {
  const v = await visit();
  await confirmCare(api, A.dentist, v, 100_000);
  const adj = await api.call('POST', `/api/v1/visits/${v}/adjustments`, { token: A.dentist, body: { kind: 'WRITE_OFF', amountMillimes: 100_000, reasonCode: 'HARDSHIP', reasonNote: 'Fictional hardship note' } });
  assert.equal(adj.status, 201, JSON.stringify(adj.body));
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.balance.balanceMillimes, 0);
  assert.equal(w.nextAction, 'OWNER_REVIEW_ZEROED_BALANCE');
  assert.equal(w.adjustments.length, 1);
  assert.deepEqual(
    { kind: w.adjustments[0].kind, amountMillimes: w.adjustments[0].amountMillimes, reasonCode: w.adjustments[0].reasonCode, authorizedRole: w.adjustments[0].authorizedRole, reasonNote: w.adjustments[0].reasonNote },
    { kind: 'WRITE_OFF', amountMillimes: 100_000, reasonCode: 'HARDSHIP', authorizedRole: 'DENTIST', reasonNote: 'Fictional hardship note' });
  assert.equal(w.adjustments[0].authorizedByName, 'Fictional dentist');
  assert.deepEqual(w.provenance, { correctionCount: 0, correctionNetMillimes: 0, adjustmentCount: 1, reducedMillimes: 100_000, returnedMillimes: 0, freeCareCount: 0, siteAmendmentCount: 0 });
});

test('T-WB-ADJ-2 care 100,000 corrected by -100,000 -> OWNER_REVIEW_ZEROED_BALANCE; correction row links to the original', async () => {
  const v = await visit();
  const care = await confirmCare(api, A.dentist, v, 100_000);
  const c = await api.call('POST', `/api/v1/care-items/${care}/corrections`, { token: A.dentist, body: { deltaMillimes: -100_000, reason: 'Fictional fee withdrawn' } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.balance.chargedMillimes, 0);
  assert.equal(w.nextAction, 'OWNER_REVIEW_ZEROED_BALANCE');
  const corr = w.care.find((i: { kind: string }) => i.kind === 'CORRECTION');
  assert.equal(corr.correctsId, care);
  assert.equal(corr.hasReason, true);
  assert.equal(corr.reason, 'Fictional fee withdrawn');
  assert.equal(w.provenance.correctionCount, 1);
  assert.equal(w.provenance.correctionNetMillimes, -100_000);
});

test('T-WB-ADJ-3 explicitly free care (fee 0 + reason, nothing else) keeps VISIT_COMPLETE_NO_PAYMENT_REQUIRED', async () => {
  const v = await visit();
  const r = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: 0, reason: 'Fictional free follow-up' } });
  assert.equal(r.status, 201);
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.nextAction, 'VISIT_COMPLETE_NO_PAYMENT_REQUIRED');
  assert.equal(w.provenance.freeCareCount, 1);
  assert.equal(w.care[0].hasReason, true);
});

test('T-WB-ADJ-4 discount then full cash payment -> reconciliation pending, discount still visible', async () => {
  const v = await visit();
  await confirmCare(api, A.dentist, v, 100_000);
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/adjustments`, { token: A.dentist, body: { kind: 'DISCOUNT', amountMillimes: 30_000, reasonCode: 'LOYALTY' } })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, body: { amountMillimes: 70_000, tender: 'CASH' } })).status, 201);
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.balance.balanceMillimes, 0);
  assert.equal(w.nextAction, 'CHECKOUT_RECORDED__RECONCILIATION_PENDING');
  assert.equal(w.adjustments.length, 1);
  assert.equal(w.adjustments[0].kind, 'DISCOUNT');
  assert.equal(w.adjustments[0].reasonNote, null);
});

test('T-WB-PRIV-1 receptionist sees reason codes and that a reason exists, but not free-text notes or reasons', async () => {
  const v = await visit();
  const care = await confirmCare(api, A.dentist, v, 100_000);
  await api.call('POST', `/api/v1/care-items/${care}/corrections`, { token: A.dentist, body: { deltaMillimes: -20_000, reason: 'Fictional clinical reason text' } });
  await api.call('POST', `/api/v1/visits/${v}/adjustments`, { token: A.dentist, body: { kind: 'DISCOUNT', amountMillimes: 10_000, reasonCode: 'LOYALTY', reasonNote: 'Fictional private note' } });
  const desk = (await view(A.desk, v)).body.visit;
  const corr = desk.care.find((i: { kind: string }) => i.kind === 'CORRECTION');
  assert.equal(corr.hasReason, true);
  assert.equal('reason' in corr, false, 'receptionist must not receive the free-text reason');
  assert.equal(desk.adjustments[0].reasonCode, 'LOYALTY');
  assert.equal('reasonNote' in desk.adjustments[0], false, 'receptionist must not receive the free-text note');
  const owner = (await view(A.owner, v)).body.visit;
  assert.equal(owner.adjustments[0].reasonNote, 'Fictional private note');
});

test('T-WB-TENANT-1 adjustments of another clinic never appear; foreign visit id -> 404 identical to unknown id', async () => {
  const vb = await newVisit(api, B.desk, B.patientId, '2026-10-29T07:00:00Z');
  await confirmCare(api, B.dentist, vb, 50_000);
  await api.call('POST', `/api/v1/visits/${vb}/adjustments`, { token: B.dentist, body: { kind: 'WRITE_OFF', amountMillimes: 50_000, reasonCode: 'HARDSHIP' } });
  const foreign = await view(A.owner, vb);
  const unknown = await view(A.owner, '00000000-0000-4000-8000-000000000000');
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, unknown.body);
  const own = (await view(B.owner, vb)).body.visit;
  assert.equal(own.adjustments.length, 1);
  const a = (await view(A.owner, A.visitId)).body.visit;
  assert.deepEqual(a.adjustments, []);
});

test('T-WB-VOID-1 owner void: payment shows VOIDED and the VOID receipt number is visible on the visit', async () => {
  const v = await visit();
  await confirmCare(api, A.dentist, v, 100_000);
  const pay = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, body: { amountMillimes: 100_000, tender: 'CASH' } });
  assert.equal(pay.status, 201);
  await reauth(api, A.owner);
  const vd = await api.call('POST', `/api/v1/payments/${pay.body.payment.id}/void`, { token: A.owner, body: { reasonCode: 'ENTERED_IN_ERROR' } });
  assert.equal(vd.status, 201, JSON.stringify(vd.body));
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.payments[0].status, 'VOIDED');
  const voidAdj = w.adjustments.find((x: { kind: string }) => x.kind === 'PAYMENT_VOID');
  assert.equal(voidAdj.receiptLabel, vd.body.receipt.label);
  assert.equal(voidAdj.paymentId, pay.body.payment.id);
  assert.equal(w.balance.balanceMillimes, 100_000);
  assert.equal(w.nextAction, 'RECORD_OR_FOLLOW_UP_PAYMENT');
});

test('T-WB-REFUND-1 partial refund after a fee correction: payment PARTLY_RETURNED, refund receipt visible', async () => {
  const v = await visit();
  const care = await confirmCare(api, A.dentist, v, 100_000);
  const pay = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, body: { amountMillimes: 100_000, tender: 'CASH' } });
  await api.call('POST', `/api/v1/care-items/${care}/corrections`, { token: A.dentist, body: { deltaMillimes: -40_000, reason: 'Fictional fee lowered' } });
  await reauth(api, A.owner);
  const rf = await api.call('POST', `/api/v1/payments/${pay.body.payment.id}/refund`, { token: A.owner, body: { amountMillimes: 40_000, reasonCode: 'FEE_CORRECTED' } });
  assert.equal(rf.status, 201, JSON.stringify(rf.body));
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.payments[0].status, 'PARTLY_RETURNED');
  assert.equal(w.payments[0].returnedMillimes, 40_000);
  const refund = w.adjustments.find((x: { kind: string }) => x.kind === 'REFUND');
  assert.equal(refund.receiptLabel, rf.body.receipt.label);
  assert.equal(w.balance.balanceMillimes, 0);
  assert.equal(w.nextAction, 'CHECKOUT_RECORDED__RECONCILIATION_PENDING');
  assert.equal(w.provenance.returnedMillimes, 40_000);
});

test('T-STATE-1 (CH-031 latent) a privileged DB change to CANCELLED after care+payment is surfaced for owner review, not CLOSED_WITHOUT_CARE', async () => {
  const v = await visit();
  await confirmCare(api, A.dentist, v, 60_000);
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, body: { amountMillimes: 60_000, tender: 'CASH' } })).status, 201);
  // Simulates a privileged out-of-band edit (no API route can do this, C-170/M-258).
  const c = new PgConnection(parseDatabaseUrl(db.ownerUrl));
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [A.clinic.id]);
    await c.query("UPDATE visits SET status = 'CANCELLED' WHERE id = $1", [v]);
    await c.query('COMMIT');
  } finally { c.end(); }
  const w = (await view(A.owner, v)).body.visit;
  assert.equal(w.status, 'CANCELLED');
  assert.equal(w.nextAction, 'OWNER_REVIEW_CLOSED_VISIT_WITH_RECORDS');
  const plain = await newVisit(api, A.desk, A.patientId, '2026-10-30T09:00:00Z');
  assert.equal((await api.call('POST', `/api/v1/visits/${plain}/status`, { token: A.desk, body: { status: 'CANCELLED', reason: 'Fictional patient call' } })).status, 200);
  assert.equal((await view(A.owner, plain)).body.visit.nextAction, 'CLOSED_WITHOUT_CARE');
});
