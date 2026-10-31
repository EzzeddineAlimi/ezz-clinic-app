/* Issue #7 / founder M-279 F-C: appointments do not confer exclusive clinical authorship.
 * Real API + PostgreSQL/RLS; all patients, staff and care are fictional. No reassignment workflow.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, seedClinic, key, type Api, type TestDb } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';

let db: TestDb; let api: Api;
let clinic: Awaited<ReturnType<typeof seedClinic>>;
let assigned: string; let cover: string; let desk: string; let assistant: string; let foreign: string;

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  clinic = await seedClinic(db, 'fictional-cover', [
    { username: 'assigned', roles: ['DENTIST'] },
    { username: 'cover', roles: ['DENTIST'] },
    { username: 'desk', roles: ['RECEPTIONIST'] },
    { username: 'assistant', roles: ['ASSISTANT'] },
  ]);
  assigned = await api.login(clinic.code, 'assigned');
  cover = await api.login(clinic.code, 'cover');
  desk = await api.login(clinic.code, 'desk');
  assistant = await api.login(clinic.code, 'assistant');
  await seedClinic(db, 'fictional-foreign-cover', [{ username: 'dentist', roles: ['DENTIST'] }]);
  foreign = await api.login('fictional-foreign-cover', 'dentist');
});
after(async () => { await api.close(); await db.drop(); });

let patientNo = 0;
async function visit() {
  const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictif', givenName: `Couverture ${++patientNo}`, isSynthetic: true } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const v = await api.call('POST', '/api/v1/visits', { token: desk, body: {
    patientId: p.body.patient.id, dentistId: clinic.staff.assigned, scheduledAt: '2026-11-05T09:00:00Z', allowOverlap: true,
  } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  return { id: v.body.visit.id as string, patientId: p.body.patient.id as string };
}

async function sql<T>(fn: (c: PgConnection) => Promise<T>) {
  const c = new PgConnection(parseDatabaseUrl(db.appUrl));
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinic.id]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.end(); }
}

test('COVER-1 colleague signs notes, findings and care as self; schedule, immutable originals and retries retain authorship', async () => {
  const v = await visit();
  const noteBody = { assessment: 'Fictional colleague assessment', signedBy: clinic.staff.assigned };
  const idem = key();
  const n = await api.call('POST', `/api/v1/visits/${v.id}/clinical-notes`, { token: cover, body: noteBody, idem });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  assert.equal(n.body.note.signedBy, clinic.staff.cover, 'caller-supplied assigned dentist cannot impersonate the signer');
  const retry = await api.call('POST', `/api/v1/visits/${v.id}/clinical-notes`, { token: cover, body: noteBody, idem });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(retry.body.note, n.body.note, 'uncertain-response retry returns the same signed note');
  const f = await api.call('POST', `/api/v1/visits/${v.id}/chart-findings`, { token: cover, body: {
    kind: 'FINDING', toothFdi: 36, conditionCode: 'CARIES', recordedBy: clinic.staff.assigned,
  } });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  assert.equal(f.body.finding.recordedByName, 'Fictional cover');
  const careBody = { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', feeMillimes: 30_001, confirmedBy: clinic.staff.assigned };
  const careKey = key();
  const care = await api.call('POST', `/api/v1/visits/${v.id}/care`, { token: cover, body: careBody, idem: careKey });
  assert.equal(care.status, 201, JSON.stringify(care.body));
  assert.equal(care.body.careItem.confirmedBy, clinic.staff.cover);
  assert.equal(care.body.careItem.feeMillimes, 30_001);
  const careRetry = await api.call('POST', `/api/v1/visits/${v.id}/care`, { token: cover, body: careBody, idem: careKey });
  assert.equal(careRetry.status, 201);
  assert.equal(careRetry.body.replayed, true);
  assert.deepEqual(careRetry.body.careItem, care.body.careItem);

  // The originally scheduled colleague can append information without changing the covering signer.
  const add = await api.call('POST', `/api/v1/clinical-notes/${n.body.note.id}/addenda`, { token: assigned, body: {
    kind: 'ADDENDUM', plan: 'Fictional colleague follow-up',
  } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const enc = await api.call('GET', `/api/v1/visits/${v.id}/encounter`, { token: assigned });
  assert.equal(enc.status, 200);
  assert.equal(enc.body.visit.dentistId, clinic.staff.assigned, 'clinical cover never silently reassigns the appointment');
  assert.equal(enc.body.notes.find((x: { id: string }) => x.id === n.body.note.id).signedBy, clinic.staff.cover);
  assert.equal(enc.body.notes.find((x: { id: string }) => x.id === add.body.note.id).signedBy, clinic.staff.assigned);
  assert.equal(enc.body.notes.length, 2);
  assert.equal(enc.body.care.length, 1);
  assert.equal(enc.body.findings.length, 1);
  assert.ok(enc.body.notes.every((x: { integrity: string }) => x.integrity === 'OK'));

  const authors = await sql(async c => (await c.query<{ actor: string }>(`
    SELECT signed_by AS actor FROM clinical_notes WHERE id = $1
    UNION ALL SELECT recorded_by FROM chart_findings WHERE id = $2
    UNION ALL SELECT confirmed_by FROM care_items WHERE id = $3`, [n.body.note.id, f.body.finding.id, care.body.careItem.id])).rows);
  assert.deepEqual(authors.map(x => x.actor), [clinic.staff.cover, clinic.staff.cover, clinic.staff.cover]);
  const audit = await sql(async c => (await c.query<{ actor: string; action: string }>(`
    SELECT actor_staff_id AS actor, action FROM audit_events WHERE entity_id IN ($1, $2, $3)
    ORDER BY action`, [n.body.note.id, f.body.finding.id, care.body.careItem.id])).rows);
  assert.deepEqual(audit.map(x => x.action), ['care.confirmed', 'clinical.finding_recorded', 'clinical.note_signed']);
  assert.ok(audit.every(x => x.actor === clinic.staff.cover));
  await assert.rejects(sql(c => c.query('UPDATE clinical_notes SET signed_by = $2 WHERE id = $1', [n.body.note.id, clinic.staff.assigned])), /permission denied|append-only/);
});

test('COVER-2 cover policy gives no receptionist, assistant, anonymous or foreign-clinic clinical rights', async () => {
  const v = await visit();
  const routes: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['GET', `/api/v1/visits/${v.id}/encounter`, undefined],
    ['POST', `/api/v1/visits/${v.id}/clinical-notes`, { assessment: 'Fictional denied note' }],
    ['POST', `/api/v1/visits/${v.id}/chart-findings`, { kind: 'FINDING', toothFdi: 36, conditionCode: 'CARIES' }],
    ['POST', `/api/v1/visits/${v.id}/care`, { procedureCode: 'EXAM', procedureLabel: 'Fictional denied exam', feeMillimes: 30_001 }],
  ];
  for (const [method, path, body] of routes) {
    for (const [token, expected] of [[undefined, 401], [desk, 403], [assistant, 403], [foreign, 404]] as const) {
      const r = await api.call(method, path, { token, body });
      assert.equal(r.status, expected, `${method} ${path}: ${JSON.stringify(r.body)}`);
    }
  }
  const counts = await sql(async c => (await c.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM clinical_notes WHERE visit_id = $1
    UNION ALL SELECT count(*)::int FROM chart_findings WHERE visit_id = $1
    UNION ALL SELECT count(*)::int FROM care_items WHERE visit_id = $1`, [v.id])).rows);
  assert.deepEqual(counts.map(x => x.n), [0, 0, 0], 'denied attempts never create clinical records or care');
});

test('COVER-3 colleague cover preserves the existing current-alert treatment gate', async () => {
  const v = await visit();
  const declared = await api.call('POST', `/api/v1/patients/${v.patientId}/medical-alerts`, { token: desk, body: {
    code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL', detail: 'Fictional declared medication',
  } });
  assert.equal(declared.status, 201);
  const body = { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', feeMillimes: 30_001 };
  const denied = await api.call('POST', `/api/v1/visits/${v.id}/care`, { token: cover, body });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'MEDICAL_ALERTS_NOT_ACKNOWLEDGED');
  const enc = await api.call('GET', `/api/v1/visits/${v.id}/encounter`, { token: cover });
  assert.equal(enc.status, 200);
  assert.equal(enc.body.care.length, 0, 'blocked care did not become billable');
  const allowed = await api.call('POST', `/api/v1/visits/${v.id}/care`, { token: cover, body: { ...body, alertSetHash: enc.body.medical.alertSetHash } });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  assert.equal(allowed.body.careItem.confirmedBy, clinic.staff.cover);
});
