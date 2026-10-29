/*
 * C1 — Dentist authority, authentication, clinic isolation, hostile HTTP input.
 * Test IDs map to GPT_SECURITY_BASELINE / MODEL_INBOX C-138 / C-139 (see docs/testing/results-matrix.md).
 * All data synthetic. Each assertion records the EXACT expected result.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, seedClinic, STANDARD_STAFF, adminConn, PASSWORD, key, type TestDb, type Api } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';
import http from 'node:http';

/** fetch() cannot override Host, so DNS-rebinding style requests use node:http directly. */
function rawGet(url: string, host: string): Promise<number> {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { host } }, r => { r.resume(); res(r.statusCode ?? 0); });
    req.on('error', rej); req.end();
  });
}

let db: TestDb; let api: Api; let A: Awaited<ReturnType<typeof standardFixture>>;
let B: Awaited<ReturnType<typeof standardFixture>>;

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  A = await standardFixture(api, db, 'clinic-a');
  B = await standardFixture(api, db, 'clinic-b');
});
after(async () => { await api.close(); await db.drop(); });

const careBody = { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: 100_000 };

test('T-CARE-1 unauthenticated care confirmation -> 401, visit stays unconfirmed', async () => {
  const r = await api.call('POST', `/api/v1/visits/${A.visitId}/care`, { body: careBody });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'UNAUTHENTICATED');
  const c = await api.call('GET', `/api/v1/visits/${A.visitId}/care`, { token: A.owner });
  assert.equal(c.body.items.length, 0);
});

test('T-CARE-2 receptionist session -> 403 and a rate-limited denial counter for the owner', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await api.call('POST', `/api/v1/visits/${A.visitId}/care`, { token: A.desk, body: careBody });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FORBIDDEN_ROLE');
  }
  const a = await adminConn(db.name);
  try {
    const d = await a.query<{ count: number }>("SELECT count FROM security_denials WHERE staff_id = $1 AND action = 'care.confirm'", [A.clinic.staff.desk!]);
    assert.equal(d.rows.length, 1, 'one counter row, not one row per attempt');
    assert.equal(d.rows[0]!.count, 3);
  } finally { a.end(); }
});

test('T-CARE-4 body-supplied identity is ignored: receptionist sending role DENTIST -> 403', async () => {
  const r = await api.call('POST', `/api/v1/visits/${A.visitId}/care`, { token: A.desk, body: { ...careBody, role: 'DENTIST', actor: A.clinic.staff.dentist, confirmedBy: A.clinic.staff.dentist } });
  assert.equal(r.status, 403);
});

test('T-CARE-3 dentist confirms; duplicate rejected; correction is a new linked row; original unchanged', async () => {
  const r = await api.call('POST', `/api/v1/visits/${A.visitId}/care`, { token: A.dentist, body: careBody });
  assert.equal(r.status, 201);
  assert.equal(r.body.careItem.confirmedBy, A.clinic.staff.dentist);
  assert.equal(r.body.visitTotalMillimes, 100_000);
  const dup = await api.call('POST', `/api/v1/visits/${A.visitId}/care`, { token: A.dentist, body: careBody });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CARE_ALREADY_CONFIRMED');
  const corr = await api.call('POST', `/api/v1/care-items/${r.body.careItem.id}/corrections`, { token: A.dentist, body: { deltaMillimes: -20_000, reason: 'Fictional fee correction' } });
  assert.equal(corr.status, 201);
  assert.equal(corr.body.visitTotalMillimes, 80_000);
  const list = await api.call('GET', `/api/v1/visits/${A.visitId}/care`, { token: A.desk });
  assert.equal(list.body.items.length, 2);
  assert.equal(list.body.items[0].feeMillimes, 100_000, 'original row unchanged');
  assert.equal(list.body.items[1].kind, 'CORRECTION');
  // receptionist cannot correct either
  const deskCorr = await api.call('POST', `/api/v1/care-items/${r.body.careItem.id}/corrections`, { token: A.desk, body: { deltaMillimes: -80_000, reason: 'desk attempt' } });
  assert.equal(deskCorr.status, 403);
  // correction below zero rejected
  const neg = await api.call('POST', `/api/v1/care-items/${r.body.careItem.id}/corrections`, { token: A.dentist, body: { deltaMillimes: -90_000, reason: 'too much' } });
  assert.equal(neg.status, 400);
  // audit event bound to the dentist actor
  const a = await adminConn(db.name);
  try {
    const ev = await a.query<{ actor_staff_id: string; actor_roles: string }>("SELECT actor_staff_id, actor_roles FROM audit_events WHERE action = 'care.confirmed' AND clinic_id = $1", [A.clinic.id]);
    assert.equal(ev.rows[0]!.actor_staff_id, A.clinic.staff.dentist);
    assert.equal(ev.rows[0]!.actor_roles, 'DENTIST');
  } finally { a.end(); }
});

test('T-CARE-5 free care needs an explicit reason', async () => {
  const v = await api.call('POST', '/api/v1/visits', { token: A.desk, body: { patientId: A.patientId, scheduledAt: '2026-10-29T09:00:00Z' } });
  const no = await api.call('POST', `/api/v1/visits/${v.body.visit.id}/care`, { token: A.dentist, body: { ...careBody, feeMillimes: 0 } });
  assert.equal(no.status, 400);
  const yes = await api.call('POST', `/api/v1/visits/${v.body.visit.id}/care`, { token: A.dentist, body: { ...careBody, feeMillimes: 0, reason: 'Fictional free follow-up' } });
  assert.equal(yes.status, 201);
});

test('T-CARE-6 / T-ISO-1 cross-clinic: clinic B staff cannot see or act on clinic A records (404, no existence leak)', async () => {
  const care = await api.call('POST', `/api/v1/visits/${A.visitId}/care`, { token: B.dentist, body: { ...careBody, procedureCode: 'XRAY' } });
  assert.equal(care.status, 404);
  const pat = await api.call('GET', `/api/v1/patients/${A.patientId}`, { token: B.desk });
  assert.equal(pat.status, 404);
  const list = await api.call('GET', '/api/v1/patients', { token: B.desk });
  assert.ok(list.body.patients.every((p: { id: string }) => p.id !== A.patientId));
  const visit = await api.call('POST', '/api/v1/visits', { token: B.desk, body: { patientId: A.patientId, scheduledAt: '2026-10-28T11:00:00Z' } });
  assert.equal(visit.status, 404);
});

test('T-ISO-2 database-level RLS: app role sees nothing without clinic context and only its clinic with it', async () => {
  const c = new PgConnection(parseDatabaseUrl(db.appUrl)); await c.connect();
  try {
    assert.equal((await c.query('SELECT * FROM patients')).rowCount, 0, 'no app.clinic_id -> zero rows');
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [B.clinic.id]);
    const rows = (await c.query<{ clinic_id: string }>('SELECT clinic_id FROM patients')).rows;
    assert.ok(rows.length >= 1 && rows.every(r => r.clinic_id === B.clinic.id));
    await assert.rejects(c.query('INSERT INTO patients (clinic_id, file_no, family_name, given_name, created_by) VALUES ($1, 999, $2, $2, $3)', [A.clinic.id, 'X', A.clinic.staff.desk!]), /row-level security/);
    await c.query('ROLLBACK');
  } finally { c.end(); }
});

test('T-ISO-3 composite foreign keys block cross-clinic references even for the schema owner', async () => {
  const c = new PgConnection(parseDatabaseUrl(db.ownerUrl)); await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [B.clinic.id]);
    await assert.rejects(c.query(`INSERT INTO care_items (clinic_id, visit_id, patient_id, kind, procedure_code, procedure_label, fee_millimes, confirmed_by, confirmed_by_role)
      VALUES ($1, $2, $3, 'CARE', 'CHECKUP', 'Fictional checkup', 1000, $4, 'DENTIST')`, [B.clinic.id, A.visitId, A.patientId, B.clinic.staff.dentist!]), /foreign key/);
    await c.query('ROLLBACK');
  } finally { c.end(); }
});

test('T-PRIV-1 receptionist cannot escalate: staff management and audit checkpoints are owner-only', async () => {
  const r1 = await api.call('POST', '/api/v1/staff', { token: A.desk, body: { username: 'evil', displayName: 'Evil', password: 'x'.repeat(12), roles: ['OWNER'] } });
  assert.equal(r1.status, 403);
  const r2 = await api.call('POST', `/api/v1/staff/${A.clinic.staff.desk}/roles`, { token: A.desk, body: { role: 'DENTIST', op: 'GRANT' } });
  assert.equal(r2.status, 403);
  const r3 = await api.call('POST', '/api/v1/audit/checkpoints', { token: A.desk, body: {} });
  assert.equal(r3.status, 403);
  const r4 = await api.call('POST', '/api/v1/staff', { token: A.dentist, body: { username: 'evil2', displayName: 'Evil', password: 'x'.repeat(12), roles: ['OWNER'] } });
  assert.equal(r4.status, 403);
});

test('T-SESS-1 employee departure: deactivation revokes live sessions immediately', async () => {
  const clinic = await seedClinic(db, 'clinic-c', [...STANDARD_STAFF, { username: 'temp', roles: ['RECEPTIONIST'] }]);
  const owner = await api.login('clinic-c', 'owner');
  const temp = await api.login('clinic-c', 'temp');
  assert.equal((await api.call('GET', '/api/v1/session', { token: temp })).status, 200);
  const d = await api.call('POST', `/api/v1/staff/${clinic.staff.temp}/deactivate`, { token: owner, body: { reason: 'Fictional departure' } });
  assert.equal(d.status, 200);
  assert.equal(d.body.sessionsRevoked, 1);
  assert.equal((await api.call('GET', '/api/v1/session', { token: temp })).status, 401);
  const relogin = await api.call('POST', '/api/v1/session/login', { body: { clinicCode: 'clinic-c', username: 'temp', password: PASSWORD }, idem: false });
  assert.equal(relogin.status, 401);
});

test('T-SESS-2 lockout after 5 failures: correct password then refused (423)', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await api.call('POST', '/api/v1/session/login', { body: { clinicCode: 'clinic-a', username: 'dentist', password: 'wrong-password-xx' }, idem: false });
    assert.equal(r.status, 401);
  }
  const r = await api.call('POST', '/api/v1/session/login', { body: { clinicCode: 'clinic-a', username: 'dentist', password: PASSWORD }, idem: false });
  assert.equal(r.status, 423);
});

test('T-SESS-3 sensitive owner action requires recent re-authentication', async () => {
  const a = await adminConn(db.name);
  try { await a.query("UPDATE sessions SET reauth_at = now() - interval '10 minutes' WHERE staff_id = $1", [A.clinic.staff.owner!]); } finally { a.end(); }
  const r = await api.call('POST', '/api/v1/audit/checkpoints', { token: A.owner, body: {} });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'REAUTH_REQUIRED');
  const bad = await api.call('POST', '/api/v1/session/reauth', { token: A.owner, body: { password: 'nope-nope-nope' }, idem: false });
  assert.equal(bad.status, 401);
  const ok = await api.call('POST', '/api/v1/session/reauth', { token: A.owner, body: { password: PASSWORD }, idem: false });
  assert.equal(ok.status, 200);
  const r2 = await api.call('POST', '/api/v1/audit/checkpoints', { token: A.owner, body: {} });
  assert.equal(r2.status, 201);
});

test('T-ORG-1..3 / CH-019 HTTP guards: text/plain 415, foreign Origin 403, foreign Host 421, bad JSON 400, big body 413', async () => {
  const t = await api.call('POST', '/api/v1/patients', { token: A.desk, headers: { 'content-type': 'text/plain' }, rawBody: '{"familyName":"x"}' });
  assert.equal(t.status, 415);
  const o = await api.call('POST', '/api/v1/patients', { token: A.desk, headers: { origin: 'https://evil.example' }, body: { familyName: 'x', givenName: 'y', isSynthetic: true } });
  assert.equal(o.status, 403);
  assert.equal(o.body.error.code, 'FORBIDDEN_ORIGIN');
  const h = await rawGet(api.base + '/api/v1/health', 'evil.example');
  assert.equal(h, 421);
  assert.equal(await rawGet(api.base + '/api/v1/health', '127.0.0.1'), 200);
  const j = await api.call('POST', '/api/v1/patients', { token: A.desk, rawBody: '{"familyName":' });
  assert.equal(j.status, 400);
  const big = await api.call('POST', '/api/v1/patients', { token: A.desk, rawBody: JSON.stringify({ familyName: 'x'.repeat(70_000) }) });
  assert.equal(big.status, 413);
});

test('T-INPUT-1 hostile money and identifier inputs are rejected, never rounded', async () => {
  const v = await api.call('POST', '/api/v1/visits', { token: A.desk, body: { patientId: A.patientId, scheduledAt: '2026-10-30T09:00:00Z' } });
  const url = `/api/v1/visits/${v.body.visit.id}/care`;
  for (const fee of [1.5, '100000', 1e20, -1, null, true, 100_000_001]) {
    const r = await api.call('POST', url, { token: A.dentist, body: { ...careBody, feeMillimes: fee } });
    assert.equal(r.status, 400, `fee ${String(fee)} must be rejected`);
  }
  for (const tooth of [19, 10, 49, 56, 90, 0]) {
    const r = await api.call('POST', url, { token: A.dentist, body: { ...careBody, toothFdi: tooth } });
    assert.equal(r.status, 400, `tooth ${tooth} must be rejected`);
  }
  const inj = await api.call('POST', url, { token: A.dentist, body: { ...careBody, procedureCode: "X'); DROP TABLE care_items;--" } });
  assert.equal(inj.status, 400);
  const name = await api.call('POST', '/api/v1/patients', { token: A.desk, body: { familyName: "O'Brien'); DELETE FROM patients;--", givenName: 'Test', isSynthetic: true } });
  assert.equal(name.status, 201, 'stored literally via parameters');
  const search = await api.call('GET', '/api/v1/patients?q=' + encodeURIComponent("' OR 1=1 --"), { token: A.desk });
  assert.equal(search.status, 200);
  assert.equal(search.body.patients.length, 0);
  const notUuid = await api.call('GET', '/api/v1/patients/not-a-uuid', { token: A.desk });
  assert.equal(notUuid.status, 404);
  const realPatient = await api.call('POST', '/api/v1/patients', { token: A.desk, body: { familyName: 'Real', givenName: 'Person' } });
  assert.equal(realPatient.status, 400, 'isSynthetic:true is mandatory in this build');
  const valid = await api.call('POST', url, { token: A.dentist, body: { ...careBody, toothFdi: 36, surfaces: 'MO', procedureCode: 'FILLING' } });
  assert.equal(valid.status, 201);
  const primary = await api.call('POST', url, { token: A.dentist, body: { ...careBody, toothFdi: 85, procedureCode: 'SEALANT' } });
  assert.equal(primary.status, 201, 'primary tooth 85 is valid FDI');
});

test('T-VIS-2 desk cannot cancel or no-show a visit that has dentist-confirmed care', async () => {
  const r = await api.call('POST', `/api/v1/visits/${A.visitId}/status`, { token: A.desk, body: { status: 'NO_SHOW', reason: 'Fictional' } });
  assert.equal(r.status, 409);
});

test('T-PAT-1 patient contact change keeps old and new values in the audit chain', async () => {
  const r = await api.call('POST', `/api/v1/patients/${A.patientId}/contact`, { token: A.desk, body: { phone: '20 000 000', contactPreference: 'BASIC_PHONE_CALL', reason: 'Fictional update' } });
  assert.equal(r.status, 200);
  const a = await adminConn(db.name);
  try {
    const ev = await a.query<{ payload: { before: { phone: string | null }; after: { phone: string } } }>("SELECT payload FROM audit_events WHERE action = 'patient.contact_changed' AND entity_id = $1", [A.patientId]);
    assert.equal(ev.rows[0]!.payload.before.phone, null);
    assert.equal(ev.rows[0]!.payload.after.phone, '20 000 000');
  } finally { a.end(); }
});

test('T-IDEM-0 idempotency key is mandatory on writes', async () => {
  const r = await api.call('POST', '/api/v1/patients', { token: A.desk, idem: false, body: { familyName: 'x', givenName: 'y', isSynthetic: true } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const k = key();
  const r1 = await api.call('POST', '/api/v1/patients', { token: A.desk, idem: k, body: { familyName: 'Idem', givenName: 'One', isSynthetic: true } });
  const r2 = await api.call('POST', '/api/v1/patients', { token: A.desk, idem: k, body: { familyName: 'Idem', givenName: 'One', isSynthetic: true } });
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  assert.equal(r2.body.replayed, true);
  assert.equal(r2.body.patient.id, r1.body.patient.id);
});
