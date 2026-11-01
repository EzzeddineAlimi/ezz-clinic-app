/*
 * U014 — clinic-local opening hours and explicitly confirmed closed days.
 * Synthetic patients only. Tests use real PostgreSQL/RLS through the API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, seedClinic, STANDARD_STAFF, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api; let n = 0;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });
const fixture = () => standardFixture(api, db, `u014-${++n}`, { openCashPeriod: false });
const weekly = () => Array.from({ length: 7 }, () => [{ start: '09:00', end: '17:00' }]);
const read = (token: string) => api.call('GET', '/api/v1/clinic/schedule', { token });
const save = (token: string, body: Record<string, unknown>) =>
  api.call('POST', '/api/v1/clinic/schedule', { token, body });
const book = (f: Awaited<ReturnType<typeof fixture>>, scheduledAt: string, extra: Record<string, unknown> = {}) =>
  api.call('POST', '/api/v1/visits', { token: f.desk,
    body: { patientId: f.patientId, dentistId: f.clinic.staff.dentist, scheduledAt, durationMin: 30, ...extra } });

test('U014-1 default calendar preserves legacy bookings; closed dates block booking even with overlap override; another clinic is unaffected', async () => {
  const a = await fixture(), b = await fixture();
  const initial = await read(a.desk);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.weeklyHours, null);
  assert.deepEqual(initial.body.closedDays, []);
  assert.equal(initial.body.revision, null);
  const set = await save(a.desk, { expectedRevision: null, weeklyHours: null, closedDays: ['2027-02-09'], reason: 'Fictional manual clinic closure' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.ok(set.body.revision);
  const denied = await book(a, '2027-02-09T09:00:00Z', { allowOverlap: true });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.equal(denied.body.error.details.reason, 'CLINIC_CLOSED');
  assert.equal((await book(a, '2027-02-10T09:00:00Z')).status, 201);
  assert.equal((await book(b, '2027-02-09T09:00:00Z')).status, 201, 'clinic B must not inherit A closure');
  assert.deepEqual((await read(b.owner)).body.closedDays, []);
});

test('U014-2 weekly windows enforce start, end and duration; overlap override remains separate from closure policy', async () => {
  const f = await fixture();
  const configured = await save(f.dentist, { expectedRevision: null, weeklyHours: weekly(), closedDays: [], reason: 'Fictional desk working hours' });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  for (const at of ['2027-02-09T07:30:00Z', '2027-02-09T15:45:00Z']) {
    const denied = await book(f, at);
    assert.equal(denied.status, 409, `${at} ${JSON.stringify(denied.body)}`);
    assert.equal(denied.body.error.details.reason, 'OUTSIDE_OPENING_HOURS');
  }
  const first = await book(f, '2027-02-09T08:30:00Z');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal((await book(f, '2027-02-09T08:30:00Z')).status, 409, 'dentist overlap still warns');
  assert.equal((await book(f, '2027-02-09T08:30:00Z', { allowOverlap: true })).status, 201, 'explicit overlap override still works for an open slot');
});

test('U014-3 role permissions, strict dates and windows, optimistic revision, and append-only audit', async () => {
  const c = await seedClinic(db, `u014-assist-${++n}`, [...STANDARD_STAFF, { username: 'helper', roles: ['ASSISTANT'] }]);
  const owner = await api.login(c.code, 'owner'), dentist = await api.login(c.code, 'dentist');
  const desk = await api.login(c.code, 'desk'), assistant = await api.login(c.code, 'helper');
  const initial = { expectedRevision: null, weeklyHours: weekly(), closedDays: [], reason: 'Fictional weekly timetable' };
  assert.equal((await save(assistant, initial)).status, 403);
  assert.equal((await save(desk, { ...initial, closedDays: ['2027-02-30'] })).status, 400);
  assert.equal((await save(desk, { ...initial, closedDays: ['2027-02-09', '2027-02-09'] })).status, 400);
  const bad = weekly(); bad[1] = [{ start: '13:00', end: '11:00' }];
  assert.equal((await save(desk, { ...initial, weeklyHours: bad })).status, 400);
  const accepted = await save(dentist, initial);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await save(owner, { ...initial, closedDays: ['2027-02-10'] })).status, 409, 'stale revision must not overwrite a coworker');
  const revision = (await read(desk)).body.revision;
  assert.equal(revision, accepted.body.revision);
  assert.equal((await save(owner, { ...initial, expectedRevision: revision, closedDays: ['2027-02-10'] })).status, 200);
  const a = await adminConn(db.name);
  try {
    const rows = (await a.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE clinic_id = $1 AND action = 'clinic.setting_changed' AND payload->>'key' = 'clinic_calendar'", [c.id] as never[])).rows;
    assert.equal(rows.length, 2, 'each successful schedule revision has a durable audit event');
  } finally { a.end(); }
});

test('U014-4 changing the schedule cannot silently invalidate an already-booked future visit', async () => {
  const f = await fixture();
  assert.equal((await book(f, '2027-02-09T09:00:00Z')).status, 201);
  const rejected = await save(f.owner, { expectedRevision: null, weeklyHours: null, closedDays: ['2027-02-09'], reason: 'Fictional closure with pending appointments' });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.details.reason, 'EXISTING_VISITS');
  assert.equal((await read(f.desk)).body.revision, null, 'rejected update must roll back completely');
});

test('U014-5 the clinic timezone, not the API host timezone, determines opening hours', async () => {
  const f = await fixture();
  const a = await adminConn(db.name);
  try { await a.query("UPDATE clinics SET settings = jsonb_set(settings, '{timezone}', to_jsonb($2::text)) WHERE id = $1", [f.clinic.id, 'Asia/Kolkata'] as never[]); }
  finally { a.end(); }
  assert.equal((await save(f.desk, { expectedRevision: null, weeklyHours: weekly(), closedDays: [], reason: 'Fictional clinic-local timetable' })).status, 200);
  assert.equal((await read(f.desk)).body.timezone, 'Asia/Kolkata');
  assert.equal((await book(f, '2027-02-09T02:30:00Z')).status, 409, '08:00 Kolkata is before opening');
  assert.equal((await book(f, '2027-02-09T03:30:00Z')).status, 201, '09:00 Kolkata is open');
});

test('U014-6 changing timezone cannot invalidate a future visit; a compatible change remains possible', async () => {
  const f = await fixture();
  const configured = await save(f.owner, { expectedRevision: null, weeklyHours: weekly(), closedDays: [], reason: 'Fictional weekly timetable' });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal((await book(f, '2027-02-09T09:00:00Z')).status, 201, '10:00 in Africa/Tunis is open');
  const rejected = await api.call('POST', '/api/v1/clinic/settings', { token: f.owner,
    body: { changes: { timezone: 'America/Toronto' }, confirmTimezoneImpact: true, reason: 'Fictional timezone impact test' } });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error.details.reason, 'EXISTING_VISITS', '04:00 Toronto would invalidate the booked visit');
  const unchanged = await api.call('GET', '/api/v1/clinic/settings', { token: f.owner });
  assert.equal(unchanged.body.settings.timezone, 'Africa/Tunis', 'rejected timezone change must roll back');
  assert.equal((await read(f.desk)).body.revision, configured.body.revision, 'calendar revision must stay intact');
  const compatible = await api.call('POST', '/api/v1/clinic/settings', { token: f.owner,
    body: { changes: { timezone: 'Europe/Paris' }, confirmTimezoneImpact: true, reason: 'Fictional compatible timezone test' } });
  assert.equal(compatible.status, 200, JSON.stringify(compatible.body));
  assert.equal((await read(f.desk)).body.timezone, 'Europe/Paris', '10:00 Paris keeps the visit inside opening hours');
});
