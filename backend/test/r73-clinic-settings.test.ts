/*
 * R73 package C — clinic settings: an append-only, audited, tenant-isolated record of the clinic policies the code
 * already relies on (timezone, owner checkpoint reminder, day-board not-arrived grace), and removal of the remaining
 * hard-coded UTC / literal timezone handling (owner exceptions, card reconciliation, medical review due date, paper
 * reconciliation). Fictional data only. No hosting, payment-provider, fiscal or clinical policy is introduced.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, seedClinic, STANDARD_STAFF, newVisit, reauth, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
const fixture = async (opts: { openCashPeriod?: boolean } = {}) => standardFixture(api, db, `r73-set-${++n}`, { openCashPeriod: opts.openCashPeriod ?? false });
const localDate = (tz: string, d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
async function bootstrapTz(clinicId: string, tz: string) {
  const a = await adminConn(db.name);
  try { await a.query("UPDATE clinics SET settings = jsonb_set(settings, '{timezone}', to_jsonb($2::text)) WHERE id = $1", [clinicId, tz] as never[]); } finally { a.end(); }
}
async function change(owner: string, body: Record<string, unknown>) {
  await reauth(api, owner);
  return api.call('POST', '/api/v1/clinic/settings', { token: owner, body });
}
/** A timezone whose local date differs from the UTC date right now. */
const offsetTz = () => new Date().getUTCHours() >= 12 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';

test('T-SET-1 defaults are readable by every role; only the owner (with password re-entry) can change them', async () => {
  const f = await fixture();
  for (const t of [f.owner, f.dentist, f.desk]) {
    const r = await api.call('GET', '/api/v1/clinic/settings', { token: t });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.settings, { timezone: 'Africa/Tunis', checkpointDueDays: 7, notArrivedGraceMinutes: 15 });
    assert.equal(r.body.sources.timezone, 'default');
  }
  for (const t of [f.dentist, f.desk]) assert.equal((await api.call('POST', '/api/v1/clinic/settings', { token: t, body: { changes: { checkpointDueDays: 3 }, reason: 'Fictional' } })).status, 403);
  // Password re-entry is enforced by the route declaration (a fresh login counts as a recent entry, so no 401 here).
  const { settingsRoutes } = await import('../src/modules/settings.ts');
  const post = settingsRoutes.find(r => r.method === 'POST' && r.path === '/api/v1/clinic/settings')!;
  assert.deepEqual([post.permission, post.reauth, post.idempotent], ['clinic.settings.manage', true, true]);
});

test('T-SET-2 validation: unknown keys, invalid timezone, out-of-range numbers and a missing reason are refused; nothing is written', async () => {
  const f = await fixture();
  for (const body of [
    { changes: { currency: 'EUR' }, reason: 'Fictional' },
    { changes: { timezone: 'Mars/Olympus_Mons' }, reason: 'Fictional' },
    { changes: { checkpointDueDays: 0 }, reason: 'Fictional' },
    { changes: { notArrivedGraceMinutes: 600 }, reason: 'Fictional' },
    { changes: { checkpointDueDays: 3 } },
    { changes: {}, reason: 'Fictional' },
  ]) {
    const r = await change(f.owner, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  const h = await api.call('GET', '/api/v1/clinic/settings/history', { token: f.owner });
  assert.deepEqual(h.body.changes, []);
});

test('T-SET-3 changing the timezone: impact confirmation when visits exist, audited, history kept, day lists follow immediately', async () => {
  const f = await fixture();
  const v = await newVisit(api, f.desk, f.patientId, '2026-10-28T19:00:00Z'); // 20:00 Tunis on the 28th; 00:30 Kolkata on the 29th
  const before = await api.call('GET', '/api/v1/day-board?day=2026-10-29', { token: f.desk });
  assert.ok(!before.body.visits.some((x: { id: string }) => x.id === v));
  const unconfirmed = await change(f.owner, { changes: { timezone: 'Asia/Kolkata' }, reason: 'Fictional: clinic configured in the wrong zone' });
  assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.body));
  assert.match(unconfirmed.body.error.message, /visits/);
  const ok = await change(f.owner, { changes: { timezone: 'Asia/Kolkata' }, reason: 'Fictional: clinic configured in the wrong zone', confirmTimezoneImpact: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.settings.timezone, 'Asia/Kolkata');
  const after = await api.call('GET', '/api/v1/day-board?day=2026-10-29', { token: f.desk });
  assert.equal(after.body.timezone, 'Asia/Kolkata');
  assert.ok(after.body.visits.some((x: { id: string }) => x.id === v), 'the board uses the new zone at once');
  const h = await api.call('GET', '/api/v1/clinic/settings/history', { token: f.owner });
  assert.equal(h.body.changes.length, 1);
  assert.deepEqual([h.body.changes[0].key, h.body.changes[0].from, h.body.changes[0].to], ['timezone', 'Africa/Tunis', 'Asia/Kolkata']);
  assert.equal((await api.call('GET', '/api/v1/clinic/settings/history', { token: f.desk })).status, 403);
  const a = await adminConn(db.name);
  try {
    const ev = (await a.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_events WHERE clinic_id = $1 AND action = 'clinic.setting_changed'", [f.clinic.id] as never[])).rows;
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]!.payload.key, ev[0]!.payload.from, ev[0]!.payload.to], ['timezone', 'Africa/Tunis', 'Asia/Kolkata']);
  } finally { a.end(); }
  await reauth(api, f.owner);
  assert.equal((await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false })).body.ok, true);
});

test('T-SET-4 tenant isolation and append-only history: another clinic is unaffected; the app role cannot edit or delete a change', async () => {
  const A = await fixture(); const B = await fixture();
  assert.equal((await change(A.owner, { changes: { checkpointDueDays: 3 }, reason: 'Fictional: weekly is too slow' })).status, 200);
  const b = await api.call('GET', '/api/v1/clinic/settings', { token: B.owner });
  assert.equal(b.body.settings.checkpointDueDays, 7);
  assert.deepEqual((await api.call('GET', '/api/v1/clinic/settings/history', { token: B.owner })).body.changes, []);
  const { PgConnection, parseDatabaseUrl } = await import('../src/platform/postgres.ts');
  const c = new PgConnection(parseDatabaseUrl(db.appUrl)); await c.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [A.clinic.id]);
    await assert.rejects(c.query("UPDATE clinic_setting_changes SET value = '30'"), /append-only|permission denied/);
    await c.query('ROLLBACK');
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [B.clinic.id]);
    assert.equal((await c.query('SELECT 1 FROM clinic_setting_changes')).rowCount, 0, 'RLS: clinic B sees none of A');
    await c.query('ROLLBACK');
  } finally { c.end(); }
});

test('T-SET-5 a superuser edit of a setting change (e.g. shifting the clinic day) is caught by the integrity check', async () => {
  const f = await fixture();
  assert.equal((await change(f.owner, { changes: { notArrivedGraceMinutes: 20 }, reason: 'Fictional: elderly patients arrive late' })).status, 200);
  const a = await adminConn(db.name);
  try { await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica'); await a.query("UPDATE clinic_setting_changes SET value = '60' WHERE clinic_id = $1", [f.clinic.id] as never[]); await a.query('COMMIT'); } finally { a.end(); }
  await reauth(api, f.owner);
  const r = await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false });
  assert.ok(r.body.findings.some((x: { check: string }) => x.check === 'SETTING_AUDIT_VALUE_MISMATCH'), JSON.stringify(r.body.findings));
});

test('T-SET-6 the bootstrap timezone (clinics.settings) is honoured until the owner changes it; settings drive the board grace and checkpoint reminder', async () => {
  const f = await fixture();
  await bootstrapTz(f.clinic.id, 'Asia/Kolkata');
  let s = (await api.call('GET', '/api/v1/clinic/settings', { token: f.desk })).body;
  assert.deepEqual([s.settings.timezone, s.sources.timezone], ['Asia/Kolkata', 'bootstrap']);
  assert.equal((await change(f.owner, { changes: { timezone: 'Africa/Tunis', notArrivedGraceMinutes: 45, checkpointDueDays: 1 }, reason: 'Fictional: correct zone', confirmTimezoneImpact: true })).status, 200);
  s = (await api.call('GET', '/api/v1/clinic/settings', { token: f.desk })).body;
  assert.deepEqual([s.settings.timezone, s.sources.timezone, s.settings.notArrivedGraceMinutes], ['Africa/Tunis', 'changed', 45]);
  const cp = await api.call('GET', '/api/v1/owner/checkpoints', { token: f.owner });
  assert.equal(cp.body.dueAfterDays, 1);
  // 30 minutes after the start is within a 45-minute grace: not flagged.
  const v = await newVisit(api, f.desk, f.patientId, new Date(Date.now() - 30 * 60_000).toISOString());
  const board = await api.call('GET', `/api/v1/day-board?day=${localDate('Africa/Tunis', new Date(Date.now() - 30 * 60_000))}`, { token: f.desk });
  const row = board.body.visits.find((x: { id: string }) => x.id === v);
  assert.ok(row && !row.flags.includes('NOT_ARRIVED_PAST_START'), JSON.stringify(row));
});

test('T-SET-7 (RED before fix) owner exceptions use the clinic day: an early-morning visit today (Kolkata) is not a past visit', async () => {
  const f = await fixture();
  await bootstrapTz(f.clinic.id, 'Asia/Kolkata');
  const asOf = '2026-10-29';
  const v = await newVisit(api, f.desk, f.patientId, '2026-10-29T02:00:00+05:30'); // 28 Oct 20:30 UTC, but 29 Oct locally
  const r = await api.call('GET', `/api/v1/owner/exceptions?asOf=${asOf}`, { token: f.owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.open.some((e: { refs?: { visitId?: string } }) => e.refs?.visitId === v), 'a visit on the as-of day itself is not "past"');
  const r2 = await api.call('GET', '/api/v1/owner/exceptions?asOf=2026-10-30', { token: f.owner });
  assert.ok(r2.body.open.some((e: { kind: string; refs?: { visitId?: string } }) => e.kind === 'VISIT_WITHOUT_DENTIST_RECORD' && e.refs?.visitId === v), 'the next day it is past');
});

test('T-SET-8 (RED before fix) card claims are dated by the clinic day, not UTC: a card payment at 00:30 Tunis belongs to that day', async () => {
  const f = await fixture();
  await reauth(api, f.owner);
  assert.equal((await api.call('POST', '/api/v1/card/settings', { token: f.owner, body: { accountLast4: '4321' } })).status, 200);
  const { confirmCare } = await import('./helpers.ts');
  await confirmCare(api, f.dentist, f.visitId, 50_000);
  const pay = await api.call('POST', `/api/v1/visits/${f.visitId}/payments`, { token: f.desk, body: { amountMillimes: 50_000, tender: 'CARD', cardLast4: '1111' } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const a = await adminConn(db.name);
  try { await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica'); await a.query("UPDATE payments SET recorded_at = '2026-10-20T00:30:00+01:00' WHERE id = $1", [pay.body.payment.id] as never[]); await a.query('COMMIT'); } finally { a.end(); }
  const rec = await api.call('GET', '/api/v1/card/reconciliation?asOf=2026-10-21', { token: f.owner });
  const claim = rec.body.claims.find((c: { paymentId: string }) => c.paymentId === pay.body.payment.id);
  assert.equal(claim.date, '2026-10-20', JSON.stringify(claim));
  assert.equal(claim.ageDays, 1);
});

test('T-SET-9 (RED before fix) the medical-history next-review date counts from the clinic day, not the UTC day', async () => {
  const tz = offsetTz();
  const c = await seedClinic(db, `r73-set-${++n}`, STANDARD_STAFF);
  await bootstrapTz(c.id, tz);
  const dentist = await api.login(c.code, 'dentist'), desk = await api.login(c.code, 'desk');
  const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictif', givenName: 'Review', isSynthetic: true } });
  const pid = p.body.patient.id as string;
  const hash = (await api.call('GET', `/api/v1/patients/${pid}/medical-alerts`, { token: dentist })).body.alertSetHash;
  const r = await api.call('POST', `/api/v1/patients/${pid}/medical-history-reviews`, { token: dentist, body: { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: hash, nextReviewInMonths: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await adminConn(db.name);
  let expected = '';
  try { expected = (await a.query<{ d: string }>("SELECT ($1::date + interval '1 month')::date::text AS d", [localDate(tz)] as never[])).rows[0]!.d; } finally { a.end(); }
  assert.equal(r.body.review.nextReviewDue, expected, `zone ${tz}: local today ${localDate(tz)}, UTC today ${new Date().toISOString().slice(0, 10)}`);
  assert.equal(r.body.reviewStatus, 'CURRENT');
});
