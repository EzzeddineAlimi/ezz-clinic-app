/*
 * MEDICAL ALERTS, HISTORY REVIEW, DISPLAY-BEFORE-TREATMENT (clinical-requirements §5, §12).
 * The desk can declare an alert but never read detail back; the dentist verifies/resolves via immutable
 * revisions; care cannot be signed against an alert set the dentist has not seen; a stale view is refused.
 * Alert codes and the review interval are PROVISIONAL. All data synthetic.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, seedClinic, type Api, type TestDb } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/pgwire.ts';

let db: TestDb; let api: Api;
let A: Awaited<ReturnType<typeof standardFixture>>;
let B: Awaited<ReturnType<typeof standardFixture>>;
let ownerDentist: string;

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  A = await standardFixture(api, db, 'med-a');
  B = await standardFixture(api, db, 'med-b');
  await seedClinic(db, 'med-c', [{ username: 'owner-dentist', roles: ['OWNER', 'DENTIST'] }]);
  ownerDentist = await api.login('med-c', 'owner-dentist');
});
after(async () => { await api.close(); await db.drop(); });

async function newPatient(name: string, token = A.desk) {
  const p = await api.call('POST', '/api/v1/patients', { token, body: { familyName: 'Fictif', givenName: name, isSynthetic: true } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return p.body.patient.id as string;
}
let slot = 0;
const visitFor = (patientId: string) => newVisit(api, A.desk, patientId, `2026-11-04T${String(7 + (slot % 12)).padStart(2, '0')}:${String(slot++).padStart(2, '0')}:00Z`);
const declare = (patientId: string, body: Record<string, unknown>, token = A.desk) => api.call('POST', `/api/v1/patients/${patientId}/medical-alerts`, { token, body });
const alerts = (patientId: string, token = A.dentist) => api.call('GET', `/api/v1/patients/${patientId}/medical-alerts`, { token });
const summary = (patientId: string, token = A.desk) => api.call('GET', `/api/v1/patients/${patientId}/medical-alerts/summary`, { token });
const careBody = { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', feeMillimes: 30_000 };

test('T-MED-1 desk declares an alert: gets only an id back, sees presence counts, cannot read detail', async () => {
  const p = await newPatient('Declared');
  const d = await declare(p, { code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL', detail: 'Fictional: says takes blood thinner' });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.deepEqual(Object.keys(d.body).sort(), ['alertId', 'declared', 'note', 'recordedAt', 'source']);
  assert.equal(d.body.source, 'PATIENT_DECLARED');
  const s = await summary(p);
  assert.equal(s.status, 200);
  assert.deepEqual({ a: s.body.activeAlertCount, c: s.body.criticalAlertCount, u: s.body.unverifiedAlertCount, r: s.body.reviewStatus }, { a: 1, c: 1, u: 1, r: 'NEVER_REVIEWED' });
  assert.equal(JSON.stringify(s.body).includes('ANTICOAGULANT'), false, 'presence summary carries no codes');
  assert.equal(JSON.stringify(s.body).includes('blood'), false);
  assert.equal((await alerts(p, A.desk)).status, 403, 'receptionist cannot read alert detail');
  assert.equal((await alerts(p, A.owner)).status, 403, 'non-clinician owner cannot read alert detail');
  assert.equal((await summary(p, A.owner)).status, 403, 'non-clinician owner has no clinical presence view either (§12)');
  const full = await alerts(p);
  assert.equal(full.body.alerts[0].code, 'ANTICOAGULANT_VKA');
  assert.equal(full.body.alerts[0].source, 'PATIENT_DECLARED');
  assert.equal(full.body.alerts[0].detail, 'Fictional: says takes blood thinner');
});

test('T-MED-2 dentist verifies, updates, resolves via revisions; old revisions kept; stale revision -> 409', async () => {
  const p = await newPatient('Revised');
  const d = await declare(p, { code: 'DIABETES', severity: 'CAUTION' });
  const id1 = d.body.alertId as string;
  const v = await api.call('POST', `/api/v1/medical-alerts/${id1}/revisions`, { token: A.dentist, body: { action: 'VERIFY', expectedRevision: 1 } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.deepEqual([v.body.alert.revision, v.body.alert.source, v.body.alert.status], [2, 'DENTIST_VERIFIED', 'ACTIVE']);
  const stale = await api.call('POST', `/api/v1/medical-alerts/${id1}/revisions`, { token: A.dentist, body: { action: 'UPDATE', severity: 'CRITICAL', expectedRevision: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.currentRevision, 2);
  const noReason = await api.call('POST', `/api/v1/medical-alerts/${id1}/revisions`, { token: A.dentist, body: { action: 'RESOLVE', expectedRevision: 2 } });
  assert.equal(noReason.status, 400);
  const res = await api.call('POST', `/api/v1/medical-alerts/${id1}/revisions`, { token: A.dentist, body: { action: 'RESOLVE', reason: 'Fictional: entered for wrong condition', expectedRevision: 2 } });
  assert.equal(res.status, 201);
  assert.equal(res.body.alert.status, 'RESOLVED');
  const h = await api.call('GET', `/api/v1/patients/${p}/medical-alerts?history=true`, { token: A.dentist });
  assert.deepEqual(h.body.history.map((r: { revision: number; status: string }) => `${r.revision}:${r.status}`), ['1:ACTIVE', '2:ACTIVE', '3:RESOLVED']);
  assert.equal((await summary(p)).body.activeAlertCount, 0);
  const desk = await api.call('POST', `/api/v1/medical-alerts/${id1}/revisions`, { token: A.desk, body: { action: 'VERIFY', expectedRevision: 3 } });
  assert.equal(desk.status, 403);
});

test('T-MED-3 concurrent revisions of one alert: exactly one wins, no forked chain', async () => {
  const p = await newPatient('Race');
  const d = await declare(p, { code: 'EPILEPSY', severity: 'CAUTION' }, A.dentist);
  const id = d.body.alert.id as string;
  const rs = await Promise.all(['CRITICAL', 'CAUTION', 'CRITICAL'].map((sev, i) =>
    api.call('POST', `/api/v1/medical-alerts/${id}/revisions`, { token: A.dentist, body: { action: 'UPDATE', severity: sev, detail: `Fictional detail ${i}`, expectedRevision: 1 } })));
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409, 409]);
  const h = await api.call('GET', `/api/v1/patients/${p}/medical-alerts?history=true`, { token: A.dentist });
  assert.equal(h.body.history.length, 2);
});

test('T-MED-4 care confirmation is gated by the CURRENT alert set (stale hash refused, implicit ack recorded)', async () => {
  const p = await newPatient('Gated');
  const v = await visitFor(p);
  const clean = await alerts(p);
  const emptyHash = clean.body.alertSetHash as string;
  await declare(p, { code: 'ALLERGY_LATEX', severity: 'CRITICAL' });
  const noAck = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: careBody });
  assert.equal(noAck.status, 409);
  assert.equal(noAck.body.error.code, 'MEDICAL_ALERTS_NOT_ACKNOWLEDGED');
  assert.equal(noAck.body.error.details.criticalAlertCount, 1);
  const stale = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: { ...careBody, alertSetHash: emptyHash } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'MEDICAL_ALERTS_CHANGED');
  const cur = (await alerts(p)).body.alertSetHash as string;
  assert.notEqual(cur, emptyHash);
  const ok = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: { ...careBody, alertSetHash: cur } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const c = new PgConnection(parseDatabaseUrl(db.appUrl));
  await c.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [A.clinic.id]);
    const acks = await c.query<{ via: string; alert_set_sha256: string }>('SELECT via, alert_set_sha256 FROM alert_acknowledgements WHERE visit_id = $1', [v]);
    assert.deepEqual(acks.rows.map(r => [r.via, r.alert_set_sha256]), [['CARE_CONFIRMATION', cur]]);
    await c.query('COMMIT');
  } finally { c.end(); }
  // A second item on the same visit needs no hash: the current set is already acknowledged for this visit.
  const second = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: { ...careBody, procedureCode: 'XRAY', procedureLabel: 'Fictional radiograph' } });
  assert.equal(second.status, 201);
});

test('T-MED-5 explicit acknowledgement for the visit unblocks care; a new alert afterwards blocks again', async () => {
  const p = await newPatient('Explicit');
  const v = await visitFor(p);
  await declare(p, { code: 'PREGNANCY', severity: 'CAUTION' });
  const h1 = (await alerts(p)).body.alertSetHash;
  const ack = await api.call('POST', `/api/v1/visits/${v}/alert-acknowledgements`, { token: A.dentist, body: { alertSetHash: h1 } });
  assert.equal(ack.status, 201, JSON.stringify(ack.body));
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/alert-acknowledgements`, { token: A.desk, body: { alertSetHash: h1 } })).status, 403);
  await declare(p, { code: 'DIABETES', severity: 'CAUTION' });
  const blocked = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: careBody });
  assert.equal(blocked.body.error.code, 'MEDICAL_ALERTS_NOT_ACKNOWLEDGED', 'acknowledgement of the old set does not cover the new alert');
  const h2 = (await alerts(p)).body.alertSetHash;
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/alert-acknowledgements`, { token: A.dentist, body: { alertSetHash: h2 } })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: careBody })).status, 201);
});

test('T-MED-6 no-known-allergies is an explicit dated assertion, refused while an allergy alert is active', async () => {
  const p = await newPatient('Nka');
  const before = await alerts(p);
  assert.equal(before.body.allergyStatus, 'NOT_RECORDED');
  assert.equal(before.body.reviewStatus, 'NEVER_REVIEWED');
  const r = await api.call('POST', `/api/v1/patients/${p}/medical-history-reviews`, { token: A.dentist, body: { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: before.body.alertSetHash } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.allergyStatus, 'NO_KNOWN_ALLERGIES');
  assert.equal(r.body.reviewStatus, 'CURRENT');
  assert.match(r.body.review.nextReviewDue, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await summary(p)).body.allergyStatus, 'NO_KNOWN_ALLERGIES');
  await declare(p, { code: 'ALLERGY_PENICILLIN', severity: 'CRITICAL' });
  const after = await alerts(p);
  assert.equal(after.body.allergyStatus, 'ALLERGIES_RECORDED');
  assert.equal(after.body.reviewStatus, 'CHANGED_SINCE_REVIEW');
  assert.equal((await summary(p)).body.allergyStatus, 'SEE_DENTIST');
  const nka = await api.call('POST', `/api/v1/patients/${p}/medical-history-reviews`, { token: A.dentist, body: { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: after.body.alertSetHash } });
  assert.equal(nka.status, 409);
  const stale = await api.call('POST', `/api/v1/patients/${p}/medical-history-reviews`, { token: A.dentist, body: { method: 'PAPER_FORM', noKnownAllergies: false, alertSetHash: before.body.alertSetHash } });
  assert.equal(stale.body.error.code, 'MEDICAL_ALERTS_CHANGED');
  assert.equal((await api.call('POST', `/api/v1/patients/${p}/medical-history-reviews`, { token: A.desk, body: { method: 'INTERVIEW', alertSetHash: after.body.alertSetHash } })).status, 403);
});

test('T-MED-7 tenant isolation: other clinic sees 404 for patient and alert ids, never counts', async () => {
  const p = await newPatient('Tenant');
  const d = await declare(p, { code: 'ANTIPLATELET', severity: 'CAUTION' }, A.dentist);
  assert.equal((await summary(p, B.desk)).status, 404);
  assert.equal((await alerts(p, B.dentist)).status, 404);
  assert.equal((await declare(p, { code: 'DIABETES', severity: 'CAUTION' }, B.desk)).status, 404);
  const rev = await api.call('POST', `/api/v1/medical-alerts/${d.body.alert.id}/revisions`, { token: B.dentist, body: { action: 'RESOLVE', reason: 'Fictional attack', expectedRevision: 1 } });
  assert.equal(rev.status, 404);
  assert.equal((await summary(p)).body.activeAlertCount, 1);
});

test('T-MED-8 validation and privacy: unknown code, OTHER without detail, duplicate active code; audit carries no free text', async () => {
  const p = await newPatient('Valid');
  assert.equal((await declare(p, { code: 'MADE_UP', severity: 'CAUTION' })).status, 400);
  assert.equal((await declare(p, { code: 'OTHER', severity: 'CAUTION' })).status, 400);
  assert.equal((await declare(p, { code: 'DIABETES', severity: 'SEVERE' })).status, 400);
  assert.equal((await declare(p, { code: 'OTHER', severity: 'CAUTION', detail: 'Fictional secret detail' })).status, 201);
  assert.equal((await declare(p, { code: 'DIABETES', severity: 'CAUTION' })).status, 201);
  const dup = await declare(p, { code: 'DIABETES', severity: 'CAUTION' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.details, undefined, 'desk conflict reveals no alert ids');
  const c = new PgConnection(parseDatabaseUrl(db.appUrl));
  await c.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [A.clinic.id]);
    const ev = await c.query<{ canonical: string }>("SELECT canonical FROM audit_events WHERE action LIKE 'medical.%'");
    assert.ok(ev.rows.length > 0);
    assert.ok(ev.rows.every(r => !r.canonical.includes('Fictional secret')), 'alert detail never enters the audit chain');
    await c.query('COMMIT');
  } finally { c.end(); }
});

test('T-MED-9 OWNER+DENTIST holds the union of permissions (clinical read/write allowed)', async () => {
  const p = await api.call('POST', '/api/v1/patients', { token: ownerDentist, body: { familyName: 'Fictif', givenName: 'Union', isSynthetic: true } });
  const d = await declare(p.body.patient.id, { code: 'DIABETES', severity: 'CAUTION' }, ownerDentist);
  assert.equal(d.status, 201);
  assert.equal(d.body.alert.source, 'DENTIST_VERIFIED');
  assert.equal((await alerts(p.body.patient.id, ownerDentist)).status, 200);
});
