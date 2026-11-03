import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../src/platform/db.ts';
import { REPO_DOCS_DIR } from '../src/platform/paths.ts';
import { normaliser, shapeOf, shapeBreaks, type Step } from './api-workflows.ts';
import { createTestDb, startApi, seedClinic, STANDARD_STAFF, adminConn, type Api, type TestDb } from './helpers.ts';
let db: TestDb; let api: Api; let desk: string; let other: string; let clinicId: string;
const input = (name: string) => ({ name, reason: 'Demande de rendez-vous fictive', callback: '+216 20 000 000', isSynthetic: true });
before(async () => {
  db = await createTestDb(); api = await startApi(db.appUrl);
  clinicId = (await seedClinic(db, 'enquiry-a', [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }])).id;
  await seedClinic(db, 'enquiry-b', STANDARD_STAFF);
  desk = await api.login('enquiry-a', 'desk'); other = await api.login('enquiry-b', 'desk');
});
after(async () => { await api.close(); await db.drop(); });

test('U001 create, recover retry, manual follow-up and stale edit never create a patient', async () => {
  const body = input('Fictional Amel'); const idem = crypto.randomUUID();
  const r = await api.call('POST', '/api/v1/enquiries', { token: desk, body, idem });
  assert.equal(r.status, 201, JSON.stringify(r.body)); const e = r.body.enquiry;
  assert.equal(e.version, 1); assert.equal(e.status, 'OPEN'); assert.equal(e.patientId, undefined);
  const replay = await api.call('POST', '/api/v1/enquiries', { token: desk, body, idem });
  assert.equal(replay.body.replayed, true); assert.deepEqual(replay.body.enquiry, e);
  assert.equal((await api.call('POST', '/api/v1/enquiries', { token: desk, body: { ...body, reason: 'changed' }, idem })).status, 409);
  const update = { ...body, expectedVersion: 1, status: 'CLOSED', callback: null };
  const u = await api.call('POST', `/api/v1/enquiries/${e.id}/update`, { token: desk, body: update });
  assert.equal(u.status, 200); assert.equal(u.body.enquiry.version, 2); assert.equal(u.body.enquiry.callback, null);
  assert.equal((await api.call('POST', `/api/v1/enquiries/${e.id}/update`, { token: desk, body: update })).status, 409);
  assert.equal((await api.call('GET', `/api/v1/enquiries/${e.id}`, { token: desk })).body.enquiry.status, 'CLOSED');
  // A fresh HTTP/DB-pool instance recovers committed outcomes; no in-process enquiry state.
  await api.close(); api = await startApi(db.appUrl);
  assert.deepEqual((await api.call('POST', '/api/v1/enquiries', { token: desk, body, idem })).body.enquiry, e);
  assert.equal((await api.call('GET', `/api/v1/enquiries/${e.id}`, { token: desk })).body.enquiry.version, 2);
  assert.equal((await api.call('GET', '/api/v1/enquiries', { token: desk })).body.enquiries.some((x: { id: string }) => x.id === e.id), false);
  const c = await adminConn(db.name);
  try {
    assert.equal((await c.query<{ n: number }>('SELECT count(*)::int AS n FROM patients')).rows[0]!.n, 0);
    assert.equal((await c.query<{ n: number }>('SELECT count(*)::int AS n FROM patient_file_counters')).rows[0]!.n, 0);
    const events = await c.query<{ action: string; actor_staff_id: string; payload: object }>('SELECT action,actor_staff_id,payload FROM audit_events WHERE entity_id=$1 ORDER BY seq', [e.id]);
    assert.deepEqual(events.rows.map(x => x.action), ['enquiry.created', 'enquiry.updated']);
    assert.ok(events.rows.every(x => x.actor_staff_id === e.createdBy));
    assert.ok(!JSON.stringify(events.rows).includes('Fictional Amel'), 'audit metadata must not duplicate enquiry free text');
  } finally { await c.end(); }
});

test('U001 concurrent duplicate create and concurrent revisions fail closed', async () => {
  const body = input('Fictional Race');
  const rs = await Promise.all([1, 2].map(() => api.call('POST', '/api/v1/enquiries', { token: desk, body })));
  assert.deepEqual(rs.map(x => x.status).sort(), [201, 409]);
  const e = rs.find(x => x.status === 201)!.body.enquiry;
  const writes = await Promise.all(['un', 'deux'].map(reason => api.call('POST', `/api/v1/enquiries/${e.id}/update`, { token: desk, body: { ...body, reason, status: 'OPEN', expectedVersion: 1 } })));
  assert.deepEqual(writes.map(x => x.status).sort(), [200, 409]);
  const key = crypto.randomUUID(); const b = input('Fictional Same Key');
  const retries = await Promise.all([1, 2].map(() => api.call('POST', '/api/v1/enquiries', { token: desk, body: b, idem: key })));
  assert.deepEqual(retries.map(x => x.status), [201, 201]); assert.equal(retries[0]!.body.enquiry.id, retries[1]!.body.enquiry.id);
});

test('U001 receptionist-only, tenant isolation, synthetic and field allow-list boundaries', async () => {
  const body = input('Fictional Arabe خيالي');
  const created = await api.call('POST', '/api/v1/enquiries', { token: desk, body }); assert.equal(created.status, 201);
  const id = created.body.enquiry.id;
  for (const username of ['owner', 'dentist', 'assistant']) {
    const token = await api.login('enquiry-a', username);
    for (const [method, path] of [['GET', '/api/v1/enquiries'], ['GET', `/api/v1/enquiries/${id}`], ['POST', '/api/v1/enquiries'], ['POST', `/api/v1/enquiries/${id}/update`]]) {
      assert.equal((await api.call(method!, path!, { token, body })).status, 403);
    }
  }
  assert.equal((await api.call('GET', '/api/v1/enquiries')).status, 401);
  assert.equal((await api.call('GET', `/api/v1/enquiries/${id}`, { token: other })).status, 404);
  assert.equal((await api.call('POST', `/api/v1/enquiries/${id}/update`, { token: other, body: { ...body, status: 'CLOSED', expectedVersion: 1 } })).status, 404);
  assert.equal((await api.call('GET', '/api/v1/enquiries', { token: other })).body.enquiries.length, 0);
  for (const extra of [{ isSynthetic: false }, { patientId: crypto.randomUUID() }, { clinicId }, { triageVerified: true }, { name: ' ' }, { reason: 'x'.repeat(241) }, { callback: 'x'.repeat(41) }]) {
    assert.equal((await api.call('POST', '/api/v1/enquiries', { token: desk, body: { ...body, ...extra } })).status, 400);
  }
});

test('U001 PostgreSQL RLS and schema reject foreign-clinic and non-fictional writes', async () => {
  const r = await api.call('POST', '/api/v1/enquiries', { token: desk, body: input('Fictional DB') });
  assert.equal(r.status, 201); const e = r.body.enquiry;
  const app = new Db(db.appUrl); const c = await adminConn(db.name);
  try {
    const foreign = (await c.query<{ id: string }>('SELECT id FROM clinics WHERE code=$1', ['enquiry-b'])).rows[0]!.id;
    await app.tx(foreign, async tx => {
      assert.equal((await tx.query('SELECT id FROM enquiries WHERE id=$1', [e.id])).rowCount, 0);
      assert.equal((await tx.query('UPDATE enquiries SET status=$2 WHERE id=$1', [e.id, 'CLOSED'])).rowCount, 0);
    });
    await app.tx(null, async tx => { assert.equal((await tx.query('SELECT id FROM enquiries')).rowCount, 0); });
    await assert.rejects(app.tx(clinicId, tx => tx.query(`INSERT INTO enquiries(clinic_id,name,reason,is_synthetic,duplicate_key,created_by,updated_by)
      VALUES ($1,$2,$3,false,$4,$5,$5)`, [clinicId, 'Fictional', 'test', '0'.repeat(64), e.createdBy])), /check constraint/i);
    await assert.rejects(app.tx(clinicId, tx => tx.query('DELETE FROM enquiries WHERE id=$1', [e.id])), /permission denied/i);
    await assert.rejects(app.tx(clinicId, tx => tx.query('UPDATE enquiries SET clinic_id=$2 WHERE id=$1', [e.id, foreign])), /permission denied/i);
  } finally { await c.end(); await app.close(); }
});

test('U001 bounded keyset queue, invalid cursor and closed duplicate handling', async () => {
  await seedClinic(db, 'enquiry-pages', STANDARD_STAFF); const token = await api.login('enquiry-pages', 'desk');
  const ids = new Set<string>();
  for (let i = 0; i < 51; i++) {
    const r = await api.call('POST', '/api/v1/enquiries', { token, body: input(`Fictional Page ${i}`) });
    assert.equal(r.status, 201); ids.add(r.body.enquiry.id);
  }
  const first = await api.call('GET', '/api/v1/enquiries', { token });
  assert.equal(first.body.enquiries.length, 50); assert.ok(first.body.nextBefore);
  const second = await api.call('GET', '/api/v1/enquiries?before=' + first.body.nextBefore, { token });
  assert.equal(second.body.enquiries.length, 1); assert.equal(second.body.nextBefore, null);
  assert.deepEqual(new Set([...first.body.enquiries, ...second.body.enquiries].map((x: { id: string }) => x.id)), ids);
  assert.equal((await api.call('GET', '/api/v1/enquiries?before=', { token })).status, 400);
  assert.equal((await api.call('GET', '/api/v1/enquiries?status=VERIFIED', { token })).status, 400);
  assert.equal((await api.call('POST', '/api/v1/enquiries', { token, body: input('Fictional keyless'), idem: false })).status, 400);
  const e = first.body.enquiries[0]; const replacement = { name: e.name, reason: e.reason, callback: e.callback, isSynthetic: true };
  const key = crypto.randomUUID(); const body = { ...replacement, expectedVersion: 1, status: 'CLOSED' };
  const closed = await api.call('POST', `/api/v1/enquiries/${e.id}/update`, { token, body, idem: key });
  assert.equal(closed.status, 200);
  assert.deepEqual((await api.call('POST', `/api/v1/enquiries/${e.id}/update`, { token, body, idem: key })).body.enquiry, closed.body.enquiry);
  assert.equal((await api.call('POST', '/api/v1/enquiries', { token, body: replacement })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/enquiries/${e.id}/update`, { token, body: { ...replacement, expectedVersion: 2, status: 'OPEN' } })).status, 409);
});

test('U001 generated examples are real-API recorded and retain their response contract', async () => {
  await seedClinic(db, 'enquiry-examples', STANDARD_STAFF);
  const token = await api.login('enquiry-examples', 'desk'); const steps: Step[] = [];
  const call = async (method: 'GET' | 'POST', route: string, path: string, request: object) => {
    const r = await api.call(method, path, { token, body: request });
    steps.push({ file: 'receptionist', title: route, role: 'RECEPTIONIST', method, route, path, request, status: r.status, response: r.body });
    return r;
  };
  const body = { name: 'Fictional Léa خيالي', reason: 'Rappel pour rendez-vous fictif', isSynthetic: true };
  const r = await call('POST', '/api/v1/enquiries', '/api/v1/enquiries', body); assert.equal(r.status, 201);
  const path = `/api/v1/enquiries/${r.body.enquiry.id}`;
  assert.equal((await call('GET', '/api/v1/enquiries', '/api/v1/enquiries?status=OPEN', {})).status, 200);
  assert.equal((await call('GET', '/api/v1/enquiries/:id', path, {})).status, 200);
  assert.equal((await call('POST', '/api/v1/enquiries/:id/update', path + '/update', { ...body, callback: null, expectedVersion: 1, status: 'CLOSED' })).status, 200);
  const n = normaliser(); const normalized = steps.map(s => ({ ...s, path: n.path(s.path), request: n.walk(s.request), response: n.walk(s.response) }));
  const file = join(REPO_DOCS_DIR, 'api', 'examples', 'enquiries.json');
  if (process.env.EZZ_RECORD_EXAMPLES === '1') {
    writeFileSync(file, JSON.stringify({ title: 'U001 fictional receptionist enquiry queue', fictional: true,
      generatedBy: 'EZZ_RECORD_EXAMPLES=1 node --test test/u001-enquiries.test.ts', steps: normalized }, null, 2) + '\n');
  } else {
    const recorded = (JSON.parse(readFileSync(file, 'utf8')) as { steps: Step[] }).steps;
    assert.deepEqual(normalized.map(s => [s.method, s.route, s.status]), recorded.map(s => [s.method, s.route, s.status]));
    recorded.forEach((s, i) => assert.deepEqual(shapeBreaks(shapeOf(s.response), shapeOf(normalized[i]!.response)), []));
  }
});
