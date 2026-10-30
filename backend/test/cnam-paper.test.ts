import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { createTestDb, startApi, standardFixture, seedClinic, STANDARD_STAFF, confirmCare, newVisit, key, adminConn, spawnServer, killServer, PASSWORD, type Api, type TestDb } from './helpers.ts';
import { normaliser } from './api-workflows.ts';
import { REPO_DOCS_DIR } from '../src/platform/paths.ts';
import { Db } from '../src/platform/db.ts';

let db: TestDb; let api: Api; let f: Awaited<ReturnType<typeof standardFixture>>; let careId: string;
before(async () => {
  db = await createTestDb(); api = await startApi(db.appUrl);
  f = await standardFixture(api, db, 'cnam-fictional', { openCashPeriod: false });
  careId = await confirmCare(api, f.dentist, f.visitId, 120001);
});
after(async () => { await api?.close(); await db?.drop(); });
const body = (id = careId, patientId = f.patientId, dentistId = f.clinic.staff.dentist!) => ({
  patientId, lines: [{ careItemId: id, dentistId, feeMillimes: 120001 }],
  affiliation: { identifier: 'FICTIONAL-CNAM-ONLY', insuredName: 'شخص افتراضي', scheme: 'UNKNOWN', source: 'PATIENT_REPORTED' },
});
async function create(id?: string) {
  const r = await api.call('POST', '/api/v1/cnam/dossiers', { token: f.desk, body: body(id) });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body)); return r.body.dossier;
}
const post = (id: string, action: string, b: unknown, token = f.desk, idem?: string) =>
  api.call('POST', `/api/v1/cnam/dossiers/${id}/${action}`, { token, body: b, ...(idem ? { idem } : {}) });

test('CNAM-1 rejects a forged invoiced fee instead of accepting desk-authored clinical facts', async () => {
  const b = body(); b.lines[0]!.feeMillimes = 120002;
  const r = await api.call('POST', '/api/v1/cnam/dossiers', { token: f.desk, body: b });
  assert.equal(r.status, 400, JSON.stringify(r.body)); assert.equal(r.body.error.code, 'VALIDATION_FAILED');
});

test('CNAM-2 rejects wrong patient, wrong treating dentist, unknown fields and non-integer money', async () => {
  const p = await api.call('POST', '/api/v1/patients', { token: f.desk, body: { familyName: 'Fictional', givenName: 'Other', isSynthetic: true } });
  for (const b of [body(careId, p.body.patient.id), body(careId, f.patientId, f.clinic.staff.owner!),
    { ...body(), signatureImage: 'forbidden' }, { ...body(), lines: [{ ...body().lines[0], feeMillimes: 1.5 }] }]) {
    assert.equal((await api.call('POST', '/api/v1/cnam/dossiers', { token: f.desk, body: b })).status, 400);
  }
});

test('CNAM-3 live auth, role and tenant boundaries include every dossier action and direct RLS', async () => {
  const d = await create();
  const foreign = await seedClinic(db, 'cnam-other', [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }]);
  const foreignDesk = await api.login(foreign.code, 'desk');
  const assistant = await api.login(foreign.code, 'assistant');
  const routes = [
    ['GET', `/api/v1/cnam/dossiers/${d.id}`, {}],
    ['POST', `/api/v1/cnam/dossiers/${d.id}/issue`, { expectedVersion: 1 }],
    ['POST', `/api/v1/cnam/dossiers/${d.id}/copies`, { expectedVersion: 1 }],
    ['POST', `/api/v1/cnam/dossiers/${d.id}/handoff`, { expectedVersion: 1 }],
    ['POST', `/api/v1/cnam/dossiers/${d.id}/reports`, { expectedVersion: 1 }],
  ] as const;
  for (const [method, path, b] of routes) {
    assert.equal((await api.call(method, path, { body: b })).status, 401, path);
    assert.equal((await api.call(method, path, { token: assistant, body: b })).status, 403, path);
    assert.equal((await api.call(method, path, { token: foreignDesk, body: b })).status, 404, path);
  }
  assert.equal((await api.call('POST', '/api/v1/cnam/dossiers', { token: foreignDesk, body: body() })).status, 404);
  const scoped = new Db(db.appUrl);
  try {
    await scoped.tx(foreign.id, async tx => {
      for (const table of ['cnam_dossiers', 'cnam_versions', 'cnam_events', 'cnam_issued_care']) {
        assert.equal((await tx.query(`SELECT * FROM ${table} WHERE clinic_id = $1`, [f.clinic.id])).rowCount, 0);
      }
    });
    await assert.rejects(scoped.tx(foreign.id, tx => tx.query(`INSERT INTO cnam_dossiers(clinic_id,patient_id,creation_hash,created_by)
      VALUES ($1,$2,$3,$4)`, [f.clinic.id, f.patientId, '0'.repeat(64), f.clinic.staff.desk!])), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(scoped.tx(f.clinic.id, tx => tx.query('UPDATE cnam_dossiers SET created_by = $1 WHERE id = $2', [f.clinic.staff.owner!, d.id])), (e: { code?: string }) => e.code === '42501');
  } finally { await scoped.close(); }
});

test('CNAM-4 concurrent same-key and lost-key retries recover one draft and one immutable issue', async () => {
  const k = key();
  const rs = await Promise.all([1, 2].map(() => api.call('POST', '/api/v1/cnam/dossiers', { token: f.desk, body: body(), idem: k })));
  assert.deepEqual(rs[0]!.body.dossier, rs[1]!.body.dossier);
  assert.ok(rs.some(r => r.body.replayed === true));
  const d = await create(); assert.equal(d.id, rs[0]!.body.dossier.id);
  const issued = await Promise.all([1, 2].map(() => post(d.id, 'issue', { expectedVersion: 1 })));
  assert.deepEqual(issued.map(r => r.status), [200, 200]);
  assert.equal(issued[0]!.body.dossier.versions[0].issue.id, issued[1]!.body.dossier.versions[0].issue.id);
  const recovered = await api.call('GET', `/api/v1/cnam/dossiers?patientId=${f.patientId}`, { token: f.desk });
  assert.ok(recovered.body.dossiers.some((x: { id: string }) => x.id === d.id));
  const got = await api.call('GET', `/api/v1/cnam/dossiers/${d.id}`, { token: f.desk });
  assert.equal(got.body.dossier.versions[0].issue.id, issued[0]!.body.dossier.versions[0].issue.id);
});

test('CNAM-5 duplicate act issuance in competing dossiers fails closed under concurrency', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001);
  const a = await create(c);
  const b = await api.call('POST', '/api/v1/cnam/dossiers', { token: f.desk, body: { ...body(c), affiliation: null } });
  assert.equal(b.status, 201);
  const rs = await Promise.all([a.id, b.body.dossier.id].map(id => post(id, 'issue', { expectedVersion: 1 })));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal(rs.find(r => r.status === 409)!.body.error.details.reason, 'CNAM_ACT_ALREADY_ISSUED');
});

test('CNAM-6 reasoned dentist correction appends a version; desk/owner/stale changes cannot overwrite history', async () => {
  const d = await create();
  const b = { ...body(), expectedVersion: 1, reason: 'Fictional affiliation transcription correction' };
  for (const token of [f.desk, f.owner]) assert.equal((await post(d.id, 'corrections', b, token)).status, 403);
  const before = await api.call('GET', `/api/v1/cnam/dossiers/${d.id}`, { token: f.dentist });
  const r = await post(d.id, 'corrections', { ...b, affiliation: null }, f.dentist);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.dossier.currentVersion, 2);
  assert.deepEqual(r.body.dossier.versions[0], before.body.dossier.versions[0]);
  assert.equal((await post(d.id, 'corrections', b, f.dentist)).status, 409);
  assert.equal((await post(d.id, 'issue', { expectedVersion: 1 })).status, 409);
});

test('CNAM-7 care/site changes before issue require a new version, never silently replace a snapshot', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001);
  const d = await create(c);
  const correction = await api.call('POST', `/api/v1/care-items/${c}/corrections`, { token: f.dentist, body: { deltaMillimes: -1, reason: 'Fictional corrected fee' } });
  assert.equal(correction.status, 201);
  const r = await post(d.id, 'issue', { expectedVersion: 1 });
  assert.equal(r.status, 409); assert.equal(r.body.error.details.reason, 'CNAM_CARE_CHANGED');
});

test('CNAM-8 copies have consecutive server markers and do not assert physical printing or delivery', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001);
  const d = await create(c);
  assert.equal((await post(d.id, 'copies', { expectedVersion: 1 })).status, 409);
  assert.equal((await post(d.id, 'handoff', { expectedVersion: 1, handedToPatientReported: true })).status, 409);
  const issued = await post(d.id, 'issue', { expectedVersion: 1 }); assert.equal(issued.status, 200);
  const k = key(); const first = await post(d.id, 'copies', { expectedVersion: 1 }, f.desk, k);
  const replay = await post(d.id, 'copies', { expectedVersion: 1 }, f.desk, k);
  assert.deepEqual(first.body.copy, replay.body.copy); assert.deepEqual(first.body.snapshot, replay.body.snapshot); assert.equal(replay.body.replayed, true);
  const rs = await Promise.all([1, 2].map(() => post(d.id, 'copies', { expectedVersion: 1 })));
  assert.deepEqual(rs.map(r => r.body.copy.copyNumber).sort(), [2, 3]);
  assert.equal(first.body.copy.paperDelivery, 'UNKNOWN'); assert.equal(first.body.copy.printing, 'NOT_VERIFIED');
  assert.equal(first.body.copy.snapshotHash, issued.body.dossier.versions[0].snapshotHash);
});

test('CNAM-9 reports require optional follow-up consent and remain non-official, outside money ledgers', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001); const d = await create(c);
  await post(d.id, 'issue', { expectedVersion: 1 });
  const handed = await post(d.id, 'handoff', { expectedVersion: 1, handedToPatientReported: true });
  assert.equal(handed.status, 200); assert.equal(handed.body.dossier.state, 'HANDED_TO_PATIENT');
  const report = { expectedVersion: 1, status: 'REIMBURSED', source: 'PATIENT_REPORTED', amountMillimes: 12345, consentAcknowledged: true, note: 'Fictional patient report only' };
  assert.equal((await post(d.id, 'reports', { ...report, consentAcknowledged: false })).status, 400);
  assert.equal((await post(d.id, 'reports', { ...report, source: 'OFFICIAL_VERIFIED' })).status, 400);
  const a = await adminConn(db.name);
  const money = async () => (await a.query('SELECT (SELECT count(*) FROM payments) payments, (SELECT count(*) FROM receipts) receipts, (SELECT count(*) FROM adjustments) adjustments, (SELECT count(*) FROM cash_periods) periods')).rows;
  try {
    const before = await money(); const r = await post(d.id, 'reports', report); assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.report.officiallyVerified, false); assert.equal(r.body.report.payee, 'PATIENT');
    assert.deepEqual(await money(), before);
    const got = await api.call('GET', `/api/v1/cnam/dossiers/${d.id}`, { token: f.desk });
    assert.equal(got.body.dossier.estimation.label, 'Estimation indisponible');
    assert.equal(got.body.dossier.estimation.amountMillimes, null);
    assert.ok(got.body.dossier.versions[0].snapshot.warnings.includes('CLINIC_BALANCE_OUTSTANDING'));
    assert.ok((await a.query("SELECT 1 FROM audit_events WHERE action = 'cnam.reported'")).rowCount > 0);
    for (const table of ['cnam_dossiers', 'cnam_versions', 'cnam_events', 'cnam_issued_care']) {
      await assert.rejects(a.query(`DELETE FROM ${table}`), (e: { code?: string }) => e.code === 'EZ001');
    }
  } finally { a.end(); }
});

test('CNAM-10 records actual multi-practitioner/multi-session authors and immutable bilingual preparation contracts', async () => {
  const clinic = await seedClinic(db, 'cnam-multi', [...STANDARD_STAFF, { username: 'dentist2', roles: ['DENTIST'] }]);
  const desk = await api.login(clinic.code, 'desk'), d1 = await api.login(clinic.code, 'dentist'), d2 = await api.login(clinic.code, 'dentist2');
  const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictional', givenName: 'Paper', nameAr: 'مريض افتراضي', isSynthetic: true, preferredLanguage: 'ar' } });
  const lines = [];
  for (const [token, dentistId, date] of [[d1, clinic.staff.dentist!, '2026-10-28T23:30:00Z'], [d2, clinic.staff.dentist2!, '2026-10-29T08:00:00Z']] as const) {
    const v = await newVisit(api, desk, p.body.patient.id, date);
    const c = await api.call('POST', `/api/v1/visits/${v}/care`, { token, body: { procedureCode: 'FICTIONAL', procedureLabel: 'Fictional local act', toothFdi: 36, feeMillimes: 120001 } });
    assert.equal(c.status, 201); lines.push({ careItemId: c.body.careItem.id, dentistId, feeMillimes: 120001 });
  }
  const steps: unknown[] = []; const n = normaliser();
  async function step(method: string, route: string, path: string, request: unknown) {
    const r = await api.call(method, path, { token: desk, body: request });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    steps.push({ file: 'cnam-paper', title: `${method} ${route} (fictional preparation only)`, role: 'RECEPTIONIST', method, route, path: n.path(path), request: n.walk(request), status: r.status, response: n.walk(r.body) });
    return r.body;
  }
  const made = await step('POST', '/api/v1/cnam/dossiers', '/api/v1/cnam/dossiers', { patientId: p.body.patient.id, lines }); const id = made.dossier.id;
  assert.equal(made.dossier.versions[0].snapshot.lines.length, 2);
  assert.deepEqual(made.dossier.versions[0].snapshot.lines.map((l: { dentistId: string }) => l.dentistId).sort(), [clinic.staff.dentist, clinic.staff.dentist2].sort());
  assert.equal(made.dossier.versions[0].snapshot.patient.nameAr, 'مريض افتراضي');
  assert.equal((await post(id, 'corrections', { patientId: p.body.patient.id, lines, expectedVersion: 1, reason: 'Cannot correct another dentist acts' }, d1)).status, 403);
  for (const action of ['issue', 'copies', 'handoff', 'reports']) await step('POST', `/api/v1/cnam/dossiers/:id/${action}`, `/api/v1/cnam/dossiers/${id}/${action}`, {
    expectedVersion: 1, ...(action === 'handoff' ? { handedToPatientReported: true } : {}),
    ...(action === 'reports' ? { status: 'SUBMITTED', source: 'STAFF_REPORTED', consentAcknowledged: true } : {}),
  });
  await step('GET', '/api/v1/cnam/dossiers', `/api/v1/cnam/dossiers?patientId=${p.body.patient.id}`, null);
  await step('GET', '/api/v1/cnam/dossiers/:id', `/api/v1/cnam/dossiers/${id}`, null);
  // Capture the dentist-only route from an actual own-authored single-dentist dossier.
  const own = await create(); const b = { ...body(), expectedVersion: own.currentVersion, reason: 'Fictional administrative correction' };
  const r = await post(own.id, 'corrections', b, f.dentist); assert.equal(r.status, 201);
  steps.push({ file: 'cnam-paper', title: 'Dentist-authored administrative revision', role: 'DENTIST', method: 'POST', route: '/api/v1/cnam/dossiers/:id/corrections', path: n.path(`/api/v1/cnam/dossiers/${own.id}/corrections`), request: n.walk(b), status: r.status, response: n.walk(r.body) });
  if (process.env.EZZ_RECORD_EXAMPLES === '1') writeFileSync(join(REPO_DOCS_DIR, 'api', 'examples', 'cnam-paper.json'), JSON.stringify({ fictional: true, generatedBy: 'EZZ_RECORD_EXAMPLES=1 node --test test/cnam-paper.test.ts', steps }, null, 2) + '\n');
});

test('CNAM-11 actual patient payment/receipt links are read-only and a later payment invalidates an unissued snapshot', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001);
  const d = await create(c);
  const payment = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: f.desk, body: { tender: 'CARD', amountMillimes: 120001 } });
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  assert.equal((await post(d.id, 'issue', { expectedVersion: 1 })).status, 409);
  const corrected = await post(d.id, 'corrections', { ...body(c), expectedVersion: 1, reason: 'Refresh after fictional full payment' }, f.dentist);
  assert.equal(corrected.status, 201);
  const snap = corrected.body.dossier.versions[1].snapshot;
  assert.equal(snap.visits[0].paidMillimes, 120001); assert.equal(snap.visits[0].receipts[0].id, payment.body.receipt.id);
  assert.ok(!snap.warnings.includes('CLINIC_BALANCE_OUTSTANDING'));
  assert.equal((await post(d.id, 'issue', { expectedVersion: 2 })).status, 200);
  const receipt = await api.call('GET', `/api/v1/receipts/${payment.body.receipt.id}`, { token: f.desk });
  assert.equal(receipt.body.receipt.number, payment.body.receipt.number);
});

test('CNAM-12 failure before issue commit rolls reservation/event/audit/idempotency back and same-key retry succeeds', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001); const d = await create(c);
  const a = await adminConn(db.name); const k = key();
  try {
    await a.exec("CREATE FUNCTION cnam_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional fault'; END $$; CREATE TRIGGER cnam_fault BEFORE INSERT ON cnam_events FOR EACH ROW EXECUTE FUNCTION cnam_fail()");
    assert.equal((await post(d.id, 'issue', { expectedVersion: 1 }, f.desk, k)).status, 500);
    assert.equal((await a.query('SELECT 1 FROM cnam_issued_care WHERE dossier_id = $1', [d.id])).rowCount, 0);
    assert.equal((await a.query('SELECT 1 FROM cnam_events WHERE dossier_id = $1', [d.id])).rowCount, 0);
    assert.equal((await a.query("SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'cnam.issued'", [d.id])).rowCount, 0);
    assert.equal((await a.query('SELECT 1 FROM idempotency_records WHERE key = $1', [k])).rowCount, 0);
  } finally { await a.exec('DROP TRIGGER cnam_fault ON cnam_events; DROP FUNCTION cnam_fail()'); a.end(); }
  assert.equal((await post(d.id, 'issue', { expectedVersion: 1 }, f.desk, k)).status, 200);
});

test('CNAM-13 SIGKILL restart and new login recover committed issue after discarded response without a new issue', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001); const d = await create(c);
  const listener = net.createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  let child: ChildProcess | undefined;
  const call = async (path: string, token?: string, b?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1` + path, { method: b === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key(), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b) });
    assert.ok(res.ok); return res.json() as Promise<any>;
  };
  const login = () => call('/session/login', undefined, { clinicCode: f.clinic.code, username: 'desk', password: PASSWORD });
  try {
    child = await spawnServer(db.appUrl, port); let auth = await login();
    // Deliberately discard the response. Only the durable GET determines the outcome after restart.
    await call(`/cnam/dossiers/${d.id}/issue`, auth.token, { expectedVersion: 1 });
    await killServer(child); child = await spawnServer(db.appUrl, port); auth = await login();
    const recovered = await call(`/cnam/dossiers/${d.id}`, auth.token);
    const retry = await call(`/cnam/dossiers/${d.id}/issue`, auth.token, { expectedVersion: 1 });
    assert.equal(recovered.dossier.versions[0].issue.id, retry.dossier.versions[0].issue.id);
    assert.equal(retry.dossier.versions[0].events.filter((e: { kind: string }) => e.kind === 'ISSUED').length, 1);
  } finally { if (child) await killServer(child); }
});

test('CNAM-14 effective tooth amendment is detected at issue and cannot rewrite an existing preparation version', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001); const d = await create(c);
  const amended = await api.call('POST', `/api/v1/care-items/${c}/site-amendments`, { token: f.dentist,
    body: { expectedSupersedesId: null, toothFdi: 36, reasonCode: 'WRONG_TOOTH' } });
  assert.equal(amended.status, 201, JSON.stringify(amended.body));
  const stale = await post(d.id, 'issue', { expectedVersion: 1 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.details.reason, 'CNAM_CARE_CHANGED');
  const old = await api.call('GET', `/api/v1/cnam/dossiers/${d.id}`, { token: f.desk });
  assert.equal(old.body.dossier.versions[0].snapshot.lines[0].toothFdi, null);
  const revised = await post(d.id, 'corrections', { ...body(c), expectedVersion: 1, reason: 'Refresh after actual dentist site amendment' }, f.dentist);
  assert.equal(revised.status, 201); assert.equal(revised.body.dossier.versions[1].snapshot.lines[0].toothFdi, 36);
  assert.equal(revised.body.dossier.versions[1].snapshot.lines[0].siteAmendmentId, amended.body.siteAmendment.id);
});

test('CNAM-15 database rejects a reasonless corrected version even below HTTP validation', async () => {
  const v = await newVisit(api, f.desk, f.patientId); const c = await confirmCare(api, f.dentist, v, 120001); const d = await create(c);
  const a = await adminConn(db.name);
  try {
    await a.exec('BEGIN');
    await assert.rejects(a.query(`INSERT INTO cnam_versions(clinic_id,dossier_id,version,snapshot,snapshot_hash,correction_reason,created_by)
      SELECT clinic_id,dossier_id,2,snapshot,snapshot_hash,NULL,created_by FROM cnam_versions WHERE dossier_id = $1 AND version = 1`, [d.id]), (e: { code?: string }) => e.code === '23514');
  } finally { await a.exec('ROLLBACK'); a.end(); }
});
