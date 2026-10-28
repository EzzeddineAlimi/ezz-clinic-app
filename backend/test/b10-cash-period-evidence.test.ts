/*
 * B10 / C-166 P10-2 — the workbench must reflect an owner-accepted drawer count without over-claiming:
 * "the drawer period holding this cash payment was counted and closed" is NOT "this payment is verified".
 * The desk never sees counted, expected or difference amounts (blind count), the evidence follows the period
 * that actually covered the payment by time, and other clinics' periods never matter. Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic() { return standardFixture(api, db, `b10-${++n}`); }
const view = (token: string, visitId: string) => api.call('GET', `/api/v1/visits/${visitId}/workbench`, { token }).then(r => r.body.visit);
async function currentPeriod(owner: string) { return (await api.call('GET', '/api/v1/cash/periods/current', { token: owner })).body.period.id as string; }
async function payCash(F: Awaited<ReturnType<typeof clinic>>, visitId: string, amount: number) {
  const r = await api.call('POST', `/api/v1/visits/${visitId}/payments`, { token: F.desk, body: { amountMillimes: amount, tender: 'CASH' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.payment.id as string;
}
async function countAndClose(F: Awaited<ReturnType<typeof clinic>>, counted: number) {
  const pid = await currentPeriod(F.owner);
  const c = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: F.dentist, body: { countedMillimes: counted } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await reauth(api, F.owner);
  const close = await api.call('POST', `/api/v1/cash/periods/${pid}/close`, { token: F.owner, body: { acceptedCountId: c.body.count.id, handoverMillimes: 0 } });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  return pid;
}

test('T-WB-CASH-1 open period: cash stays "independent count required"; the period is shown as OPEN', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 100_000);
  await payCash(F, F.visitId, 100_000);
  const w = await view(F.desk, F.visitId);
  assert.equal(w.payments[0].evidenceStatus, 'DESK_CASH__INDEPENDENT_COUNT_REQUIRED');
  assert.deepEqual(w.payments[0].cashPeriod, { periodNo: 1, status: 'OPEN' });
  assert.equal(w.nextAction, 'CHECKOUT_RECORDED__RECONCILIATION_PENDING');
});

test('T-WB-CASH-2 owner-accepted count closes the period: wording says the PERIOD was counted, never that the payment is verified; desk sees no amounts', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 100_000);
  await payCash(F, F.visitId, 100_000);
  await countAndClose(F, 123_456); // distinctive figure: a 23,456 overage that must never reach the desk
  const desk = await view(F.desk, F.visitId);
  assert.equal(desk.payments[0].evidenceStatus, 'DESK_CASH__DRAWER_PERIOD_COUNTED');
  assert.deepEqual(desk.payments[0].cashPeriod, { periodNo: 1, status: 'COUNTED_AND_CLOSED' });
  assert.equal(desk.nextAction, 'CHECKOUT_RECORDED__CASH_PERIOD_COUNTED');
  const deskJson = JSON.stringify(desk);
  for (const secret of ['123456', '23456', 'expected', 'difference', 'counted', 'Independent']) assert.ok(!deskJson.includes(secret), `desk payload leaks ${secret}`);
  assert.ok(!/verified/i.test(desk.payments[0].evidenceStatus), 'never "verified"');
});

test('T-WB-CASH-3 the owner (only) sees the accepted count independence flag and period difference', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 100_000);
  await payCash(F, F.visitId, 100_000);
  await countAndClose(F, 90_000);
  const owner = await view(F.owner, F.visitId);
  assert.deepEqual(owner.payments[0].cashPeriod, { periodNo: 1, status: 'COUNTED_AND_CLOSED', periodDifferenceMillimes: -10_000, countIndependent: true });
  const dentist = await view(F.dentist, F.visitId);
  assert.deepEqual(dentist.payments[0].cashPeriod, { periodNo: 1, status: 'COUNTED_AND_CLOSED' }, 'count details are owner-only');
});

test('T-WB-CASH-4 cash recorded after the accepted count (but before closing) is covered by the NEXT period, not the closed one', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 100_000);
  await payCash(F, F.visitId, 60_000);
  const pid = await currentPeriod(F.owner);
  const c = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: F.dentist, body: { countedMillimes: 60_000 } });
  await payCash(F, F.visitId, 40_000); // after the count, before the owner closes the period
  await reauth(api, F.owner);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${pid}/close`, { token: F.owner, body: { acceptedCountId: c.body.count.id, handoverMillimes: 0 } })).status, 200);
  const w = await view(F.desk, F.visitId);
  assert.deepEqual(w.payments.map((p: { cashPeriod: { periodNo: number; status: string } }) => [p.cashPeriod.periodNo, p.cashPeriod.status]), [[1, 'COUNTED_AND_CLOSED'], [2, 'OPEN']]);
  assert.deepEqual(w.payments.map((p: { evidenceStatus: string }) => p.evidenceStatus), ['DESK_CASH__DRAWER_PERIOD_COUNTED', 'DESK_CASH__INDEPENDENT_COUNT_REQUIRED']);
  assert.equal(w.nextAction, 'CHECKOUT_RECORDED__RECONCILIATION_PENDING', 'one payment is still uncounted');
});

test('T-WB-CASH-5 a submitted count that the owner has NOT accepted changes nothing (no premature claim)', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 50_000);
  await payCash(F, F.visitId, 50_000);
  const pid = await currentPeriod(F.owner);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: F.dentist, body: { countedMillimes: 50_000 } })).status, 201);
  const w = await view(F.owner, F.visitId);
  assert.equal(w.payments[0].evidenceStatus, 'DESK_CASH__INDEPENDENT_COUNT_REQUIRED');
  assert.equal(w.payments[0].cashPeriod.status, 'OPEN');
});

test('T-WB-CASH-6 card and mixed tenders: a counted drawer never upgrades card evidence; mixed visit stays pending', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 100_000);
  await payCash(F, F.visitId, 60_000);
  assert.equal((await api.call('POST', `/api/v1/visits/${F.visitId}/payments`, { token: F.desk, body: { amountMillimes: 40_000, tender: 'CARD' } })).status, 201);
  await countAndClose(F, 60_000);
  const w = await view(F.owner, F.visitId);
  const card = w.payments.find((p: { tender: string }) => p.tender === 'CARD');
  assert.equal(card.evidenceStatus, 'DESK_CLAIM__OWNER_PROOF_SEPARATE');
  assert.equal(card.cashPeriod, null);
  assert.equal(w.nextAction, 'OWNER_REVIEW_CARD_CLAIM');
});

test('T-WB-CASH-7 another clinic closing its period does not affect this clinic', async () => {
  const A = await clinic();
  const B = await clinic();
  await confirmCare(api, A.dentist, A.visitId, 30_000);
  await payCash(A, A.visitId, 30_000);
  await confirmCare(api, B.dentist, B.visitId, 30_000);
  await payCash(B, B.visitId, 30_000);
  await countAndClose(B, 30_000);
  const a = await view(A.owner, A.visitId);
  assert.equal(a.payments[0].cashPeriod.status, 'OPEN');
  assert.equal(a.payments[0].evidenceStatus, 'DESK_CASH__INDEPENDENT_COUNT_REQUIRED');
  assert.equal((await view(B.owner, B.visitId)).payments[0].cashPeriod.status, 'COUNTED_AND_CLOSED');
});

test('T-WB-CASH-8 a voided cash payment in a counted period reads VOIDED, and the visit is not called counted', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 40_000);
  const p = await payCash(F, F.visitId, 40_000);
  await reauth(api, F.owner);
  assert.equal((await api.call('POST', `/api/v1/payments/${p}/void`, { token: F.owner, body: { reasonCode: 'ENTERED_IN_ERROR' } })).status, 201);
  await countAndClose(F, 0);
  const w = await view(F.owner, F.visitId);
  assert.equal(w.payments[0].status, 'VOIDED');
  assert.equal(w.nextAction, 'RECORD_OR_FOLLOW_UP_PAYMENT');
});

test('T-WB-CASH-9 visit list on a new day after a long-closed period: nothing in the desk payload reveals any count figure', async () => {
  const F = await clinic();
  await confirmCare(api, F.dentist, F.visitId, 70_000);
  await payCash(F, F.visitId, 70_000);
  await countAndClose(F, 77_777);
  const v2 = await newVisit(api, F.desk, F.patientId, '2026-10-30T09:00:00Z');
  await confirmCare(api, F.dentist, v2, 10_000);
  await payCash(F, v2, 10_000);
  for (const id of [F.visitId, v2]) assert.ok(!JSON.stringify(await view(F.desk, id)).includes('77777'));
});
