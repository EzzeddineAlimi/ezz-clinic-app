/*
 * R72 / M-265 (2)(3) — executed evidence for treatment-plan perform concurrency and rollback on the integrated build.
 * M-265 confirmed statically that the terminal check runs before the visit lock, so the real guard is the partial unique
 * index plan_item_events_one_terminal plus transaction rollback. This runs it: many concurrent performs of one plan item
 * must yield exactly one care item, one COMPLETED event, no orphan charge, and an intact audit chain. Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, reauth, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

test('T-PLAN-3 eight concurrent performs on eight visits, then four on one visit: one care item, one COMPLETED event, no orphan charge, chain intact', async () => {
  const f = await standardFixture(api, db, 'r72-plan', { openCashPeriod: false });
  const post = (path: string, token: string, body: Record<string, unknown>) => api.call('POST', path, { token, body });
  const visits = [f.visitId];
  for (let i = 1; i < 8; i++) visits.push(await newVisit(api, f.desk, f.patientId, `2026-10-2${i % 9}T1${i}:00:00Z`));
  const item = (await post(`/api/v1/patients/${f.patientId}/treatment-plan-items`, f.dentist, { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'O', estimatedFeeMillimes: 60_000 })).body.planItem.id as string;
  assert.equal((await post(`/api/v1/treatment-plan-items/${item}/status`, f.dentist, { status: 'ACCEPTED' })).status, 201);
  const rs = await Promise.all(visits.map(v => post(`/api/v1/treatment-plan-items/${item}/perform`, f.dentist, { visitId: v })));
  const statuses = rs.map(r => r.status).sort();
  assert.equal(statuses.filter(s => s === 201).length, 1, JSON.stringify(rs.map(r => [r.status, r.body.error?.code])));
  assert.ok(statuses.every(s => s === 201 || s === 409), JSON.stringify(statuses));
  const winner = rs.find(r => r.status === 201)!.body.careItem.visitId as string;
  // Second wave on the winning visit.
  const again = await Promise.all([0, 1, 2, 3].map(() => post(`/api/v1/treatment-plan-items/${item}/perform`, f.dentist, { visitId: winner })));
  assert.ok(again.every(r => r.status === 409), JSON.stringify(again.map(r => r.status)));
  const a = await adminConn(db.name);
  try {
    const q = async (sql: string) => Number((await a.query<{ n: number }>(sql, [f.clinic.id] as never[])).rows[0]!.n);
    assert.equal(await q("SELECT count(*) AS n FROM care_items WHERE clinic_id = $1 AND kind = 'CARE'"), 1, 'exactly one care item (no orphan charge)');
    assert.equal(await q("SELECT count(*) AS n FROM plan_item_events WHERE clinic_id = $1 AND status = 'COMPLETED'"), 1);
    assert.equal(await q("SELECT count(*) AS n FROM audit_events WHERE clinic_id = $1 AND action = 'care.confirmed'"), 1, 'rolled-back performs left no audit event');
    assert.equal(await q("SELECT coalesce(sum(b.charged_millimes),0) AS n FROM visit_balances b WHERE b.clinic_id = $1"), 60_000, 'only one visit carries the charge');
  } finally { a.end(); }
  await reauth(api, f.owner);
  const v = await api.call('POST', '/api/v1/audit/verify', { token: f.owner, body: {}, idem: false });
  assert.equal(v.body.ok, true, JSON.stringify(v.body.findings));
  const i = await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false });
  assert.equal(i.body.ok, true, JSON.stringify(i.body.findings));
});
