/*
 * R75-E — an owner resolution must close ONE item, never every future item of the same kind.
 *   T-EXC-KEY-1  Integrity findings were keyed by check name only (integrity:<check>:finding). After the owner resolved a
 *                first CARE_AUDIT_VALUE_MISMATCH, a second, unrelated edit of the same kind never appeared in the open list.
 *   T-EXC-KEY-2  The checkpoint reminder had a constant key (audit:checkpoint:due). Once resolved, the owner was never
 *                reminded again, although the outside checkpoint is the only control against a full chain rewrite (R73-A).
 * Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, adminConn, reauth, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function admin(sqls: Array<[string, unknown[]]>) {
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    for (const [s, p] of sqls) await a.query(s, p as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
}
type Item = { key: string; kind: string; wording: string };
const open = async (owner: string) => {
  const r = await api.call('GET', '/api/v1/owner/exceptions', { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.open as Item[];
};
const resolve = async (owner: string, key: string) => {
  const r = await api.call('POST', '/api/v1/owner/exceptions/resolve', { token: owner, body: { key, reasonCode: 'OWNER_EXPLAINED', note: 'Fictional: explained' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
};

test('T-EXC-KEY-1 resolving one integrity finding does not hide a later, different finding of the same kind', async () => {
  const f = await standardFixture(api, db, `r75e-${++n}`);
  const careA = await confirmCare(api, f.dentist, f.visitId, 40_000);
  await admin([["UPDATE care_items SET procedure_code = 'EXTRACT' WHERE id = $1", [careA]]]);
  const first = (await open(f.owner)).filter(i => i.kind === 'INTEGRITY_CARE_AUDIT_VALUE_MISMATCH');
  assert.equal(first.length, 1, JSON.stringify(first));
  await resolve(f.owner, first[0]!.key);
  assert.equal((await open(f.owner)).filter(i => i.kind === 'INTEGRITY_CARE_AUDIT_VALUE_MISMATCH').length, 0, 'the resolved item leaves the list');

  const v2 = await newVisit(api, f.desk, f.patientId, '2026-10-28T11:00:00Z');
  const careB = await confirmCare(api, f.dentist, v2, 60_000);
  await admin([["UPDATE care_items SET procedure_code = 'IMPLANT' WHERE id = $1", [careB]]]);
  const second = (await open(f.owner)).filter(i => i.kind === 'INTEGRITY_CARE_AUDIT_VALUE_MISMATCH');
  assert.equal(second.length, 1, 'the new, different edit is open: ' + JSON.stringify(second));
  assert.ok(second[0]!.wording.includes(careB), 'it is the second care item');
  assert.notEqual(second[0]!.key, first[0]!.key);
});

test('T-EXC-KEY-2 resolving the checkpoint reminder does not silence it after the next checkpoint goes stale', async () => {
  const f = await standardFixture(api, db, `r75e-${++n}`);
  const due = (await open(f.owner)).find(i => i.kind === 'AUDIT_CHECKPOINT_DUE');
  assert.ok(due, 'no checkpoint yet -> due');
  await resolve(f.owner, due!.key);
  assert.ok(!(await open(f.owner)).some(i => i.kind === 'AUDIT_CHECKPOINT_DUE'));
  await reauth(api, f.owner);
  const cp = await api.call('POST', '/api/v1/audit/checkpoints', { token: f.owner, body: { note: 'Fictional paper copy' } });
  assert.equal(cp.status, 201, JSON.stringify(cp.body));
  await admin([["UPDATE audit_checkpoints SET created_at = created_at - interval '60 days' WHERE clinic_id = $1", [f.clinic.id]]]);
  assert.ok((await open(f.owner)).some(i => i.kind === 'AUDIT_CHECKPOINT_DUE'), 'the checkpoint is stale again: the reminder is back');
});

test('T-EXC-TENANT-1 resolving an identical checkpoint key in clinic A cannot hide clinic B warning', async () => {
  const a = await standardFixture(api, db, `r75e-${++n}`);
  const b = await standardFixture(api, db, `r75e-${++n}`);
  const dueA = (await open(a.owner)).find(i => i.kind === 'AUDIT_CHECKPOINT_DUE');
  const dueB = (await open(b.owner)).find(i => i.kind === 'AUDIT_CHECKPOINT_DUE');
  assert.ok(dueA && dueB, 'both clinics have an independently due checkpoint');
  assert.equal(dueA.key, dueB.key, 'the same exception key must exercise clinic isolation');

  await resolve(a.owner, dueA.key);
  assert.ok(!(await open(a.owner)).some(i => i.key === dueA.key), 'clinic A resolution is applied');
  const other = await api.call('GET', '/api/v1/owner/exceptions', { token: b.owner });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.ok((other.body.open as Item[]).some(i => i.key === dueB.key), 'clinic B must still see its own warning');
  assert.equal(other.body.resolvedCountByReason.OWNER_EXPLAINED ?? 0, 0, 'clinic A reason must not leak to clinic B');
  await resolve(b.owner, dueB.key);
  assert.ok(!(await open(b.owner)).some(i => i.key === dueB.key), 'clinic B can resolve its own warning');
});
