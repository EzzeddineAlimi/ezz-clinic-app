/*
 * C2 — Independent blind cash counting, periods, float, owner movements, retries, carry-forward.
 * GPT_SECURITY_BASELINE T-CASH-1/3 (v0.1 RED: 2 anonymous counts accepted; expected 100,000 leaked) must be GREEN.
 * Physical independence is NOT provable by software; these tests check the software side only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, seedClinic, reauth, type TestDb, type Api } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic(float: number) {
  const F = await standardFixture(api, db, `cash-${++n}`, { openingFloatMillimes: float });
  const cur = await api.call('GET', '/api/v1/cash/periods/current', { token: F.owner });
  return { ...F, periodId: cur.body.period.id as string };
}
async function cashPayment(F: Awaited<ReturnType<typeof clinic>>, fee: number, amount: number, token = F.desk) {
  const v = await newVisit(api, F.desk, F.patientId, `2026-10-28T${String(8 + (n % 10)).padStart(2, '0')}:${String(Math.floor(Math.random() * 59)).padStart(2, '0')}:00Z`);
  await confirmCare(api, F.dentist, v, fee);
  const r = await api.call('POST', `/api/v1/visits/${v}/payments`, { token, body: { amountMillimes: amount, tender: 'CASH', confirmDuplicate: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r;
}
const count = (F: { periodId: string }, token: string, counted: number, recountReason?: string, periodId = F.periodId) =>
  api.call('POST', `/api/v1/cash/periods/${periodId}/counts`, { token, body: { countedMillimes: counted, ...(recountReason ? { recountReason } : {}) } });
const review = (F: { owner: string; periodId: string }, periodId = F.periodId) => api.call('GET', `/api/v1/cash/periods/${periodId}/review`, { token: F.owner });

test('T-CASH-1 BLIND: counter-visible responses before and at submission contain no expected total or cash amounts', async () => {
  const F = await clinic(50_000);
  await cashPayment(F, 70_000, 70_000);
  await cashPayment(F, 25_000, 25_000); // expected = 50,000 + 70,000 + 25,000 = 145,000
  const seen: string[] = [];
  seen.push(JSON.stringify((await api.call('GET', '/api/v1/cash/periods/current', { token: F.dentist })).body));
  const ownerEarly = await review(F);
  assert.equal(ownerEarly.status, 409, 'even the owner cannot see expected before a count exists');
  seen.push(JSON.stringify(ownerEarly.body));
  const deskReview = await api.call('GET', `/api/v1/cash/periods/${F.periodId}/review`, { token: F.dentist });
  assert.equal(deskReview.status, 403, 'counter (dentist) has no review permission');
  seen.push(JSON.stringify(deskReview.body));
  const submit = await count(F, F.dentist, 145_000);
  assert.equal(submit.status, 201);
  assert.equal(submit.body.status, 'RECORDED_PENDING_OWNER_REVIEW');
  seen.push(JSON.stringify(submit.body));
  for (const body of seen) for (const leak of ['145000', '70000', '25000', '50000', 'expected', 'difference']) {
    assert.ok(!body.includes(leak) || (leak === 'expected' && body.includes('Expected cash is hidden')) || (leak === 'expected' && body.includes('expected cash is revealed')), `leak of "${leak}" in ${body}`);
  }
  const r = await review(F);
  assert.equal(r.status, 200);
  assert.equal(r.body.expected.expectedMillimes, 145_000);
  assert.equal(r.body.attempts[0].differenceMillimes, 0);
});

test('T-CASH-2/3 retries are stored; recount needs a reason; owner sees first and latest difference', async () => {
  const F = await clinic(0);
  await cashPayment(F, 100_000, 100_000);
  assert.equal((await count(F, F.owner, 95_000)).status, 201);
  const noReason = await count(F, F.owner, 100_000);
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.error.code, 'RECOUNT_REASON_REQUIRED');
  const second = await count(F, F.owner, 100_000, 'Fictional: coins found under tray');
  assert.equal(second.body.count.attemptNo, 2);
  const r = await review(F);
  assert.equal(r.body.attempts.length, 2);
  assert.equal(r.body.attempts[0].differenceMillimes, -5_000);
  assert.equal(r.body.attempts[1].differenceMillimes, 0);
  assert.match(r.body.summary, /2 attempt\(s\); first differed by -5000 millimes; latest differs by 0/);
  assert.match(r.body.attempts[0].wording, /not an accusation/);
  // closing must accept the latest attempt only
  await reauth(api, F.owner);
  const wrong = await api.call('POST', `/api/v1/cash/periods/${F.periodId}/close`, { token: F.owner, body: { acceptedCountId: r.body.attempts[0].id, handoverMillimes: 0 } });
  assert.equal(wrong.status, 409);
});

test('T-CASH-4 receptionist cannot submit a count (403) and cannot record drawer movements', async () => {
  const F = await clinic(10_000);
  const r = await count(F, F.desk, 10_000);
  assert.equal(r.status, 403);
  const m = await api.call('POST', `/api/v1/cash/periods/${F.periodId}/movements`, { token: F.desk, body: { kind: 'PETTY_EXPENSE', amountMillimes: 5_000, reason: 'Fictional' } });
  assert.equal(m.status, 403);
  const open = await api.call('POST', '/api/v1/cash/periods', { token: F.desk, body: { openingFloatMillimes: 0 } });
  assert.equal(open.status, 403);
});

test('T-CASH-6 software independence flags: owner who took cash, or a person holding RECEPTIONIST, is NOT independent', async () => {
  const F = await clinic(0);
  await cashPayment(F, 30_000, 30_000, F.owner);
  await count(F, F.owner, 30_000);
  const r = await review(F);
  assert.equal(r.body.attempts[0].counterIndependent, false);
  assert.match(r.body.attempts[0].independenceNotes, /recorded 1 cash payment/);
  assert.equal(r.body.evidence, 'COUNT_NOT_INDEPENDENT');
  const c2 = await seedClinic(db, 'cash-solo', [{ username: 'solo', roles: ['OWNER', 'DENTIST', 'RECEPTIONIST'] }]);
  const solo = await api.login('cash-solo', 'solo');
  const p = await api.call('POST', '/api/v1/cash/periods', { token: solo, body: { openingFloatMillimes: 0 } });
  await api.call('POST', `/api/v1/cash/periods/${p.body.period.id}/counts`, { token: solo, body: { countedMillimes: 0 } });
  const rr = await api.call('GET', `/api/v1/cash/periods/${p.body.period.id}/review`, { token: solo });
  assert.equal(rr.body.attempts[0].counterIndependent, false);
  assert.match(rr.body.attempts[0].independenceNotes, /RECEPTIONIST/);
  assert.match(rr.body.attempts[0].independenceNotes, /cannot be proven by software/);
  void c2;
});

test('T-WIN-1 float + cash - owner-approved petty expense: expected 100,000; without float the old design showed a false +50,000', async () => {
  const F = await clinic(50_000);
  await cashPayment(F, 70_000, 70_000);
  await reauth(api, F.owner);
  const m = await api.call('POST', `/api/v1/cash/periods/${F.periodId}/movements`, { token: F.owner, body: { kind: 'PETTY_EXPENSE', amountMillimes: 20_000, reason: 'Fictional cleaning supplies', voucherRef: 'V-001' } });
  assert.equal(m.status, 201);
  await count(F, F.dentist, 100_000);
  const r = await review(F);
  assert.equal(r.body.expected.expectedMillimes, 100_000);
  assert.equal(r.body.expected.breakdown.pettyExpensesMillimes, 20_000);
  assert.equal(r.body.attempts[0].differenceMillimes, 0);
});

test('T-WIN-2 / T-CASH-5 two periods: counted carry-forward after owner handover; closed period cannot be recounted; late cash goes to next period', async () => {
  const F = await clinic(0);
  await cashPayment(F, 120_000, 120_000);
  const c = await count(F, F.dentist, 120_000);
  // a payment recorded AFTER the count but BEFORE the owner closes belongs to the next period
  await cashPayment(F, 5_000, 5_000);
  const r1 = await review(F);
  assert.equal(r1.body.cashRecordedAfterLatestCount.totalMillimes, 5_000);
  await reauth(api, F.owner);
  const over = await api.call('POST', `/api/v1/cash/periods/${F.periodId}/close`, { token: F.owner, body: { acceptedCountId: c.body.count.id, handoverMillimes: 130_000 } });
  assert.equal(over.status, 400, 'handover cannot exceed counted');
  const close = await api.call('POST', `/api/v1/cash/periods/${F.periodId}/close`, { token: F.owner, body: { acceptedCountId: c.body.count.id, handoverMillimes: 70_000, note: 'Fictional owner handover' } });
  assert.equal(close.status, 200);
  assert.equal(close.body.nextPeriod.openingFloatMillimes, 50_000);
  assert.equal(close.body.nextPeriod.openingBasis, 'COUNTED_CARRY_FORWARD');
  const closedReview = await review(F);
  assert.equal(closedReview.status, 200);
  assert.equal(closedReview.body.cashRecordedAfterLatestCount.count, 0,
    'closed-period warning must not include cash carried into the next period');
  assert.equal(closedReview.body.cashRecordedAfterLatestCount.totalMillimes, 0);
  const recount = await count(F, F.dentist, 1, 'late', F.periodId);
  assert.equal(recount.status, 409);
  assert.equal(recount.body.error.code, 'CASH_PERIOD_CLOSED');
  const next = { ...F, periodId: close.body.nextPeriod.id as string };
  await cashPayment(F, 30_000, 30_000);
  await count(next, F.dentist, 85_000);
  const r2 = await review(next);
  assert.equal(r2.body.expected.expectedMillimes, 50_000 + 5_000 + 30_000, 'float 50,000 + late 5,000 + day-2 30,000');
  assert.equal(r2.body.attempts[0].differenceMillimes, 0);
});

test('T-WIN-3 / FRAUD-SCENARIO-70-CASH patient pays 70,000, desk records 100,000 and pockets 30,000 -> count differs by -30,000 (neutral wording)', async () => {
  const F = await clinic(20_000);
  await cashPayment(F, 100_000, 100_000); // recorded 100,000
  // physically the drawer holds 20,000 float + 70,000 really handed over = 90,000
  await count(F, F.owner, 90_000);
  const r = await review(F);
  assert.equal(r.body.expected.expectedMillimes, 120_000);
  assert.equal(r.body.attempts[0].differenceMillimes, -30_000);
  assert.match(r.body.attempts[0].wording, /owner review pending \(not an accusation\)/);
  assert.match(r.body.scope, /never recorded cannot appear/);
  // Residual: if the desk had recorded 70,000 (the true amount) and the patient's paper receipt said 70,000,
  // nothing differs; the reverse case (desk records LESS than paid, e.g. 70,000 recorded while 100,000 paid)
  // balances the drawer and is only exposed by the patient-held receipt / balance shown to the patient (CH-002 Mode B).
});

test('T-CASH-CONC count submitted while 8 cash payments are in flight: stored expected equals recomputed expected for its cut-off', async () => {
  const F = await clinic(0);
  const visits: string[] = [];
  for (let i = 0; i < 8; i++) { const v = await newVisit(api, F.desk, F.patientId, `2026-11-1${i}T09:00:00Z`); await confirmCare(api, F.dentist, v, 10_000); visits.push(v); }
  const ops = visits.map(v => api.call('POST', `/api/v1/visits/${v}/payments`, { token: F.desk, body: { amountMillimes: 10_000, tender: 'CASH' } }));
  ops.splice(4, 0, count(F, F.dentist, 40_000));
  const rs = await Promise.all(ops);
  assert.ok(rs.every(r => r.status === 201), JSON.stringify(rs.map(r => r.status)));
  const r = await review(F);
  assert.equal(r.body.attempts[0].expectedMillimes, r.body.expected.expectedMillimes, 'no payment straddles the cut-off');
  assert.equal(r.body.expected.expectedMillimes + r.body.cashRecordedAfterLatestCount.totalMillimes, 80_000);
});

test('T-CASH-7 cash cannot be recorded with no open period; denominations must add up', async () => {
  const F = await standardFixture(api, db, 'cash-noperiod', { openCashPeriod: false });
  await confirmCare(api, F.dentist, F.visitId, 10_000);
  const r = await api.call('POST', `/api/v1/visits/${F.visitId}/payments`, { token: F.desk, body: { amountMillimes: 10_000, tender: 'CASH' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'NO_OPEN_CASH_PERIOD');
  const card = await api.call('POST', `/api/v1/visits/${F.visitId}/payments`, { token: F.desk, body: { amountMillimes: 10_000, tender: 'CARD' } });
  assert.equal(card.status, 201, 'card does not need a drawer');
  const G = await clinic(0);
  const bad = await api.call('POST', `/api/v1/cash/periods/${G.periodId}/counts`, { token: G.owner, body: { countedMillimes: 30_000, denominations: { '10000': 2 } } });
  assert.equal(bad.status, 400);
  const good = await api.call('POST', `/api/v1/cash/periods/${G.periodId}/counts`, { token: G.owner, body: { countedMillimes: 30_000, denominations: { '10000': 2, '5000': 2 } } });
  assert.equal(good.status, 201);
});


test('T-CASH-SCOPE after-count warning includes only this clinic and the open period', async () => {
  const F = await clinic(0);
  const G = await clinic(0);
  await count(F, F.dentist, 0);
  await cashPayment(G, 15_000, 15_000);
  const before = await review(F);
  assert.equal(before.status, 200);
  assert.equal(before.body.cashRecordedAfterLatestCount.count, 0,
    'other clinic cash must not appear in this owner review');
  assert.equal(before.body.cashRecordedAfterLatestCount.totalMillimes, 0);
  await cashPayment(F, 9_000, 9_000);
  const after = await review(F);
  assert.equal(after.body.cashRecordedAfterLatestCount.count, 1);
  assert.equal(after.body.cashRecordedAfterLatestCount.totalMillimes, 9_000);
  const denied = await api.call('GET', `/api/v1/cash/periods/${F.periodId}/review`, { token: G.owner });
  assert.equal(denied.status, 404, 'another clinic cannot inspect this period');
});
