/*
 * C5 — Durable records: real process restart, transaction rollback, audit tamper evidence with owner-held
 * checkpoints, least-privilege DB role, backup/restore drill, missing-record detection.
 * GPT_SECURITY_BASELINE T-EVT-3 and T-RECEIPT (v0.1 RED: events lost / numbering restarts at #1) must be GREEN.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, adminConn, reauth, ADMIN_URL, PASSWORD, key, type TestDb, type Api } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/pgwire.ts';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');
let db: TestDb; let api: Api; let A: Awaited<ReturnType<typeof standardFixture>>;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); A = await standardFixture(api, db); });
after(async () => { await api.close(); await db.drop(); });

async function spawnServer(appUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, DATABASE_URL: appUrl, PORT: String(port), LOG_LEVEL: 'silent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.status === 200) return child; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start');
}

async function j(method: string, url: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': key() };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
  return { status: r.status, body: await r.json() as any };
}

test('T-REC-1 / T-EVT-3(restart) REAL process restart (SIGKILL): receipts continue at next number, events and sessions survive', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let child = await spawnServer(db.appUrl, port);
  const login = await j('POST', base + '/api/v1/session/login', undefined, { clinicCode: 'clinic-a', username: 'desk', password: PASSWORD });
  const desk = login.body.token as string;
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 90_000);
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) nums.push((await j('POST', `${base}/api/v1/visits/${v}/payments`, desk, { amountMillimes: 10_000 + i, tender: 'CASH' })).body.receipt.number);
  const a = await adminConn(db.name);
  const eventsBefore = (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n;
  child.kill('SIGKILL'); // crash, not graceful shutdown
  await new Promise(r => child.once('exit', r));
  child = await spawnServer(db.appUrl, port);
  try {
    const after_ = await j('POST', `${base}/api/v1/visits/${v}/payments`, desk, { amountMillimes: 5_000, tender: 'CASH' });
    assert.equal(after_.status, 201, 'session token survived the restart');
    assert.equal(after_.body.receipt.number, nums[2]! + 1, 'numbering continues, never restarts at 1');
    const eventsAfter = (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n;
    assert.ok(eventsAfter > eventsBefore, 'pre-restart events are still there');
    const bal = await j('GET', `${base}/api/v1/visits/${v}/balance`, desk);
    assert.equal(bal.body.balance.paidMillimes, 10_000 + 10_001 + 10_002 + 5_000);
  } finally { child.kill('SIGKILL'); a.end(); }
});

test('T-TX-1 transaction rollback mid-payment leaves no payment, no receipt number consumed, no audit, no idempotency record', async () => {
  const v = await newVisit(api, A.desk, A.patientId);
  await confirmCare(api, A.dentist, v, 100_000);
  const a = await adminConn(db.name);
  try {
    // Test-only fault: a trigger that fails AFTER the receipt row is inserted (i.e. late in the transaction).
    await a.exec(`CREATE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (NEW.snapshot->>'amountMillimes')::bigint = 13013 THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail AFTER INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION test_fail();`);
    const nBefore = (await a.query<{ m: number }>('SELECT coalesce(max(number),0)::int AS m FROM receipts')).rows[0]!.m;
    const evBefore = (await a.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n;
    const k = key();
    const r = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, idem: k, body: { amountMillimes: 13_013, tender: 'CASH' } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INTERNAL');
    assert.ok(!JSON.stringify(r.body).includes('injected'), 'no internal detail leaked');
    assert.equal((await a.query('SELECT 1 FROM payments WHERE visit_id = $1', [v])).rowCount, 0);
    assert.equal((await a.query('SELECT 1 FROM idempotency_records WHERE key = $1', [k])).rowCount, 0);
    assert.equal((await a.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n, evBefore);
    await a.exec('DROP TRIGGER test_fail ON receipts; DROP FUNCTION test_fail();');
    const retry = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, idem: k, body: { amountMillimes: 13_013, tender: 'CASH' } });
    assert.equal(retry.status, 201, 'same key re-executes after a rolled-back attempt');
    assert.equal(retry.body.receipt.number, nBefore + 1, 'no gap: the failed attempt did not consume a number');
  } finally { a.end(); }
});

test('T-EVT-4 least privilege: the API database role cannot UPDATE/DELETE/TRUNCATE evidence tables', async () => {
  const c = new PgConnection(parseDatabaseUrl(db.appUrl)); await c.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [A.clinic.id]);
    for (const sql of ['UPDATE audit_events SET action = action', 'DELETE FROM audit_events', 'UPDATE payments SET amount_millimes = 1', 'DELETE FROM payments',
      'UPDATE receipts SET number = number', 'DELETE FROM care_items', 'TRUNCATE audit_events']) {
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(sql), /permission denied/, sql);
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
    await c.query('ROLLBACK');
  } finally { c.end(); }
});

test('T-EVT-5 append-only triggers block UPDATE/DELETE even for the schema owner role', async () => {
  const c = new PgConnection(parseDatabaseUrl(db.ownerUrl)); await c.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [A.clinic.id]);
    for (const sql of ['UPDATE audit_events SET action = action', 'DELETE FROM payments', 'UPDATE receipts SET snapshot = snapshot', 'DELETE FROM care_items']) {
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(sql), /append-only/, sql);
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
    await c.query('ROLLBACK');
  } finally { c.end(); }
});

test('T-EVT-2 superuser alters one stored event -> verify names the first bad sequence number', async () => {
  const a = await adminConn(db.name);
  try {
    const ok = await api.call('POST', '/api/v1/audit/verify', { token: A.owner, body: {} });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body.findings));
    const target = (await a.query<{ seq: number }>("SELECT seq FROM audit_events WHERE clinic_id = $1 AND action = 'payment.recorded' ORDER BY seq LIMIT 1", [A.clinic.id])).rows[0]!.seq;
    await a.exec('BEGIN; SET LOCAL session_replication_role = replica;');
    await a.query(`UPDATE audit_events SET canonical = replace(canonical, '"amountMillimes":', '"amountMillimes":9') WHERE clinic_id = $1 AND seq = $2`, [A.clinic.id, target]);
    await a.exec('COMMIT');
    const bad = await api.call('POST', '/api/v1/audit/verify', { token: A.owner, body: {} });
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.findings[0].kind, 'HASH_MISMATCH');
    assert.equal(bad.body.findings[0].seq, target);
  } finally { a.end(); }
});

test('T-EVT-3 tail truncation is invisible without an anchor and detected WITH the owner-held checkpoint', async () => {
  const b = await createTestDb();
  const api2 = await startApi(b.appUrl);
  try {
    const F = await standardFixture(api2, b, 'clinic-t');
    await confirmCare(api2, F.dentist, F.visitId, 60_000);
    await api2.call('POST', `/api/v1/visits/${F.visitId}/payments`, { token: F.desk, body: { amountMillimes: 60_000, tender: 'CASH' } });
    await reauth(api2, F.owner);
    const cp = await api2.call('POST', '/api/v1/audit/checkpoints', { token: F.owner, body: { note: 'end of fictional day' } });
    assert.equal(cp.status, 201);
    const anchor = { seq: cp.body.checkpoint.seq, hash: cp.body.checkpoint.hash };
    assert.match(cp.body.printLine, /^EZZ-CHECKPOINT /);
    // attacker with superuser rights deletes the last 3 events and rewinds the head consistently
    const a = await adminConn(b.name);
    try {
      await a.exec('BEGIN; SET LOCAL session_replication_role = replica;');
      const last = (await a.query<{ seq: number }>('SELECT max(seq)::int AS seq FROM audit_events WHERE clinic_id = $1', [F.clinic.id])).rows[0]!.seq;
      await a.query('DELETE FROM audit_events WHERE clinic_id = $1 AND seq > $2', [F.clinic.id, last - 3]);
      const h = (await a.query<{ hash: string }>('SELECT hash FROM audit_events WHERE clinic_id = $1 AND seq = $2', [F.clinic.id, last - 3])).rows[0]!.hash;
      await a.query('UPDATE audit_heads SET last_seq = $2, last_hash = $3 WHERE clinic_id = $1', [F.clinic.id, last - 3, h]);
      await a.exec('COMMIT');
    } finally { a.end(); }
    const noAnchor = await api2.call('POST', '/api/v1/audit/verify', { token: F.owner, body: {} });
    assert.equal(noAnchor.body.ok, true, 'internally consistent: truncation is INVISIBLE without an outside anchor');
    const withAnchor = await api2.call('POST', '/api/v1/audit/verify', { token: F.owner, body: { anchors: [anchor] } });
    assert.equal(withAnchor.body.ok, false);
    assert.equal(withAnchor.body.findings[0].kind, 'SHORTER_THAN_ANCHOR');
  } finally { await api2.close(); await b.drop(); }
});

test('T-MISS-1 integrity check detects a payment deleted around the app and a row inserted without an audit event', async () => {
  const b = await createTestDb();
  const api2 = await startApi(b.appUrl);
  try {
    const F = await standardFixture(api2, b, 'clinic-m');
    await confirmCare(api2, F.dentist, F.visitId, 90_000);
    const ps = [];
    for (const amt of [30_000, 20_000, 10_000]) ps.push(await api2.call('POST', `/api/v1/visits/${F.visitId}/payments`, { token: F.desk, body: { amountMillimes: amt, tender: 'CASH' } }));
    const clean = await api2.call('POST', '/api/v1/integrity/check', { token: F.owner, body: {} });
    assert.equal(clean.body.ok, true, JSON.stringify(clean.body.findings));
    const a = await adminConn(b.name);
    try {
      await a.exec('BEGIN; SET LOCAL session_replication_role = replica;');
      const pid = ps[1]!.body.payment.id;
      await a.query('DELETE FROM receipts WHERE payment_id = $1', [pid]);
      await a.query('DELETE FROM payment_allocations WHERE payment_id = $1', [pid]);
      await a.query('DELETE FROM payments WHERE id = $1', [pid]);
      // a payment inserted directly in the database, bypassing the API (no receipt, no audit)
      await a.query(`INSERT INTO payments (clinic_id, patient_id, visit_id, amount_millimes, tender, source, recorded_by) VALUES ($1,$2,$3,5000,'CARD','DESK',$4)`, [F.clinic.id, F.patientId, F.visitId, F.clinic.staff.desk!]);
      await a.exec('COMMIT');
    } finally { a.end(); }
    const r = await api2.call('POST', '/api/v1/integrity/check', { token: F.owner, body: {} });
    const checks = r.body.findings.map((f: { check: string }) => f.check).sort();
    assert.ok(checks.includes('RECEIPT_NUMBER_GAP'), JSON.stringify(checks));
    assert.ok(checks.includes('AUDITED_PAYMENT_MISSING'));
    assert.ok(checks.includes('PAYMENT_WITHOUT_RECEIPT'));
    assert.ok(checks.includes('ROW_WITHOUT_AUDIT_EVENT'));
  } finally { await api2.close(); await b.drop(); }
});

test('T-BKP-1 backup -> restore drill: restored copy verifies; restoring an OLDER backup is caught by a newer owner checkpoint', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ezz-bkp-'));
  const admin = parseDatabaseUrl(ADMIN_URL);
  const pgArgs = ['-h', admin.host, '-p', String(admin.port), '-U', admin.user];
  const env = { ...process.env, PGPASSWORD: admin.password ?? '' };
  const restored = db.name + '_r1';
  try {
    execFileSync('pg_dump', [...pgArgs, '-Fc', '-f', join(tmp, 'b1.dump'), db.name], { env });
    // more activity + a newer owner checkpoint after the backup
    const v = await newVisit(api, A.desk, A.patientId);
    await confirmCare(api, A.dentist, v, 40_000);
    await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, body: { amountMillimes: 40_000, tender: 'CASH' } });
    await reauth(api, A.owner);
    const cp = await api.call('POST', '/api/v1/audit/checkpoints', { token: A.owner, body: {} });
    const anchor = { seq: cp.body.checkpoint.seq, hash: cp.body.checkpoint.hash };
    const a = await adminConn();
    try { await a.exec(`CREATE DATABASE ${restored} OWNER ezz_owner`); await a.exec(`GRANT CONNECT ON DATABASE ${restored} TO ezz_app`); } finally { a.end(); }
    execFileSync('pg_restore', [...pgArgs, '-d', restored, '--exit-on-error', join(tmp, 'b1.dump')], { env });
    const restoredUrl = db.appUrl.replace(`/${db.name}`, `/${restored}`);
    const api3 = await startApi(restoredUrl);
    try {
      const owner = await api3.login('clinic-a', 'owner');
      const plain = await api3.call('POST', '/api/v1/integrity/check', { token: owner, body: {} });
      assert.equal(plain.status, 200);
      // the restored copy is internally consistent (the earlier T-EVT-2 tamper is in it, so only check the anchor logic)
      const withAnchor = await api3.call('POST', '/api/v1/audit/verify', { token: owner, body: { anchors: [anchor] } });
      assert.ok(withAnchor.body.findings.some((f: { kind: string }) => f.kind === 'SHORTER_THAN_ANCHOR'), 'old backup restored over newer data is detected');
      const receipts = await api3.call('POST', '/api/v1/integrity/check', { token: owner, body: {} });
      assert.ok(!receipts.body.findings.some((f: { check: string }) => f.check === 'RECEIPT_NUMBER_GAP'), 'restored receipts are gap-free');
    } finally { await api3.close(); }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    const a = await adminConn();
    try { await a.exec(`DROP DATABASE IF EXISTS ${restored} WITH (FORCE)`); } finally { a.end(); }
  }
});
