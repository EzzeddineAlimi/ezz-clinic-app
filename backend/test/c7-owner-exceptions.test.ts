/*
 * C7 — Owner exception list (MF17) on the C-135 AC-DASH-1 synthetic day, blindness of the dashboard, per-item
 * resolution with reason (no bulk clear), scope line. CH-018 T-VIS-1/T-VIS-2.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, type TestDb, type Api } from './helpers.ts';

let db: TestDb; let api: Api; let F: Awaited<ReturnType<typeof standardFixture>>;
let periodId = ''; let visitC = '';
before(async () => {
  db = await createTestDb(); api = await startApi(db.appUrl);
  F = await standardFixture(api, db, 'dash-a');
  periodId = (await api.call('GET', '/api/v1/cash/periods/current', { token: F.owner })).body.period.id;
  const A = F.visitId;
  const B = await newVisit(api, F.desk, F.patientId, '2026-10-28T10:00:00Z');
  visitC = await newVisit(api, F.desk, F.patientId, '2026-10-28T11:00:00Z');
  await confirmCare(api, F.dentist, A, 100_000);
  await confirmCare(api, F.dentist, B, 100_000);
  await api.call('POST', `/api/v1/visits/${A}/payments`, { token: F.desk, body: { amountMillimes: 70_000, tender: 'CASH' } });
  await api.call('POST', `/api/v1/visits/${A}/payments`, { token: F.desk, body: { amountMillimes: 30_000, tender: 'CARD' } });
  await api.call('POST', `/api/v1/visits/${B}/payments`, { token: F.desk, body: { amountMillimes: 100_000, tender: 'CASH' } });
});
after(async () => { await api.close(); await db.drop(); });

const ex = (asOf = '2026-10-29') => api.call('GET', `/api/v1/owner/exceptions?asOf=${asOf}`, { token: F.owner });

test('T-DASH-BLIND before any count the owner list holds no expected-cash figure (170000 never appears)', async () => {
  const r = await ex();
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('170000'));
  assert.ok(!r.body.open.some((e: any) => e.kind === 'CASH_COUNT_DIFFERS'));
});

test('AC-DASH-1 synthetic day: count 150,000 vs expected 170,000 -> one -20,000 item; visit C unresolved; no receipt gaps; scope line present', async () => {
  await api.call('POST', `/api/v1/cash/periods/${periodId}/counts`, { token: F.owner, body: { countedMillimes: 150_000 } });
  const r = await ex();
  const kinds = r.body.open.map((e: any) => e.kind);
  const diff = r.body.open.find((e: any) => e.kind === 'CASH_COUNT_DIFFERS');
  assert.ok(diff, JSON.stringify(kinds));
  assert.match(diff.wording, /-20000 millimes \(review, not an accusation\)/);
  assert.equal(diff.severity, 'HIGH');
  const unresolved = r.body.open.filter((e: any) => e.kind === 'VISIT_WITHOUT_DENTIST_RECORD');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].refs.visitId, visitC);
  assert.ok(!kinds.some((k: string) => k.startsWith('INTEGRITY_')), 'no receipt gaps / integrity findings');
  assert.match(r.body.scope, /Zero items does not mean nothing is wrong/);
  for (const e of r.body.open) {
    assert.ok(e.known && e.unknown && e.nextStep, 'every item says known / unknown / next step');
    assert.ok(!/theft|steal|vol |سرقة/i.test(e.wording), 'neutral wording');
  }
});

test('T-RES-1 resolution is per item with a reason code; receptionist cannot resolve; resolved items leave the list but are counted', async () => {
  const r = await ex();
  const item = r.body.open.find((e: any) => e.kind === 'VISIT_WITHOUT_DENTIST_RECORD');
  const desk = await api.call('POST', '/api/v1/owner/exceptions/resolve', { token: F.desk, body: { key: item.key, reasonCode: 'PATIENT_LEFT_BEFORE_CARE' } });
  assert.equal(desk.status, 403);
  const noReason = await api.call('POST', '/api/v1/owner/exceptions/resolve', { token: F.owner, body: { key: item.key } });
  assert.equal(noReason.status, 400);
  const bogus = await api.call('POST', '/api/v1/owner/exceptions/resolve', { token: F.owner, body: { key: 'visit:not-real:no_dentist_record', reasonCode: 'OTHER', asOf: '2026-10-29' } });
  assert.equal(bogus.status, 404);
  const ok = await api.call('POST', '/api/v1/owner/exceptions/resolve', { token: F.owner, body: { key: item.key, reasonCode: 'PATIENT_LEFT_BEFORE_CARE', note: 'Fictional', asOf: '2026-10-29' } });
  assert.equal(ok.status, 201);
  const again = await api.call('POST', '/api/v1/owner/exceptions/resolve', { token: F.owner, body: { key: item.key, reasonCode: 'OTHER', asOf: '2026-10-29' } });
  assert.equal(again.status, 409, 'one resolution per item');
  const after_ = await ex();
  assert.ok(!after_.body.open.some((e: any) => e.key === item.key));
  assert.equal(after_.body.resolvedCountByReason.PATIENT_LEFT_BEFORE_CARE, 1);
});

test('T-DASH-2 receptionist and dentist cannot read the owner exception list', async () => {
  assert.equal((await api.call('GET', '/api/v1/owner/exceptions', { token: F.desk })).status, 403);
  assert.equal((await api.call('GET', '/api/v1/owner/exceptions', { token: F.dentist })).status, 403);
});

test('T-DASH-3 desk-marked no-show surfaces as INFO for the owner', async () => {
  const v = await newVisit(api, F.desk, F.patientId, '2026-10-28T15:00:00Z');
  await api.call('POST', `/api/v1/visits/${v}/status`, { token: F.desk, body: { status: 'NO_SHOW', reason: 'Fictional: did not come' } });
  const r = await ex();
  const item = r.body.open.find((e: any) => e.kind === 'DESK_MARKED_NO_SHOW' && e.refs.visitId === v);
  assert.ok(item);
  assert.equal(item.severity, 'INFO');
  assert.equal(item.evidence, 'DESK_RECORD_ONLY');
});
