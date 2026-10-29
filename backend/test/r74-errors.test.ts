/*
 * R74 package D — expected "no row" cases are written as maybeOne, never as a catch-all that also hides real errors.
 *   T-ERR-1  Voiding a paper-outage payment (it has no desk receipt) issues a VOID receipt that refers to no original
 *            receipt number (null), exactly as before; billing used `.catch(() => ({ number: 0 }))` for this case.
 * Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

test('T-ERR-1 voiding a receipt-less paper-outage payment refers to no original receipt', async () => {
  const f = await standardFixture(api, db, 'r74-err-1');
  await reauth(api, f.owner);
  const book = await api.call('POST', '/api/v1/paper-books', { token: f.owner, body: { firstNo: 201, lastNo: 210, custodianStaffId: f.clinic.staff.dentist } });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  const v = await newVisit(api, f.desk, f.patientId, '2026-10-20T09:00:00Z');
  await confirmCare(api, f.dentist, v, 40_000);
  const posted = await api.call('POST', `/api/v1/paper-books/${book.body.book.id}/entries`, { token: f.desk,
    body: { slips: [{ slipNo: 201, kind: 'USED', amountMillimes: 40_000, tender: 'CASH', visitId: v, writtenOn: '2026-10-20' }] } });
  const paymentId = posted.body.results[0].paymentId as string;
  assert.ok(paymentId, JSON.stringify(posted.body));
  const voided = await api.call('POST', `/api/v1/payments/${paymentId}/void`, { token: f.owner, body: { reasonCode: 'ENTERED_TWICE', reasonNote: 'Fictional duplicate slip' } });
  assert.equal(voided.status, 201, JSON.stringify(voided.body));
  const a = await adminConn(db.name);
  try {
    const ev = (await a.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_events WHERE action = 'payment.voided' AND payload->>'paymentId' = $1", [paymentId] as never[])).rows[0]!;
    assert.equal(ev.payload.voidsReceiptNumber, null);
  } finally { a.end(); }
  const integ = await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false });
  assert.deepEqual(integ.body.findings, []);
});
