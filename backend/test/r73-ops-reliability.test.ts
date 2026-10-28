/*
 * R73 package B — migration verification, startup readiness, failure recovery and diagnostic safety.
 * Fictional throwaway databases only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, startApi, adminConn, type Api, type TestDb } from './helpers.ts';
import { migrate, migrationStatus } from '../src/platform/migrate.ts';
import { MIGRATIONS_DIR, SERVER_ENTRY } from '../src/platform/paths.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

async function ownerExec(name: string, sql: string, params: unknown[] = []) {
  const a = await adminConn(name);
  try { await a.query(sql, params as never[]); } finally { a.end(); }
}

/** Start the real server process and report whether it listened or exited, with its output. */
function runServer(databaseUrl: string, timeoutMs = 15_000): Promise<{ exitCode: number | null; listening: boolean; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, DATABASE_URL: databaseUrl, PORT: '0', LOG_LEVEL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const done = (r: { exitCode: number | null; listening: boolean }) => { clearTimeout(t); child.kill('SIGKILL'); resolve({ ...r, out }); };
    const t = setTimeout(() => done({ exitCode: null, listening: false }), timeoutMs);
    const onData = (d: Buffer) => { out += d.toString(); if (out.includes('"listening"')) done({ exitCode: null, listening: true }); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', code => done({ exitCode: code, listening: false }));
  });
}

test('T-MIG-1 (RED before fix) a database with an applied migration this code does not know is refused, not silently used', async () => {
  const d = await createTestDb();
  try {
    await ownerExec(d.name, "INSERT INTO schema_migrations (version, sha256) VALUES ('0099_from_a_newer_build.sql', repeat('0', 64))");
    await assert.rejects(migrate(d.ownerUrl, MIGRATIONS_DIR), /not present in this code: 0099_from_a_newer_build\.sql/);
  } finally { await d.drop(); }
});

test('T-MIG-2 migrationStatus reports current / pending / modified / unknown without applying anything', async () => {
  const d = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'ezz-mig-'));
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    let st = await migrationStatus(d.ownerUrl, dir);
    assert.equal(st.current, true, JSON.stringify(st));
    writeFileSync(join(dir, '0900_fictional_next.sql'), 'SELECT 1;');
    st = await migrationStatus(d.ownerUrl, dir);
    assert.deepEqual([st.current, st.pending], [false, ['0900_fictional_next.sql']]);
    const a = await adminConn(d.name);
    try { assert.equal((await a.query("SELECT 1 FROM schema_migrations WHERE version = '0900_fictional_next.sql'")).rowCount, 0, 'status never applies'); } finally { a.end(); }
    rmSync(join(dir, '0900_fictional_next.sql'));
    writeFileSync(join(dir, '0001_platform_identity_audit.sql'), '-- edited after release\n', { flag: 'a' });
    st = await migrationStatus(d.ownerUrl, dir);
    assert.deepEqual(st.modified, ['0001_platform_identity_audit.sql']);
    await ownerExec(d.name, "INSERT INTO schema_migrations (version, sha256) VALUES ('0099_from_a_newer_build.sql', repeat('0', 64))");
    st = await migrationStatus(d.ownerUrl, MIGRATIONS_DIR);
    assert.deepEqual(st.unknownApplied, ['0099_from_a_newer_build.sql']);
  } finally { rmSync(dir, { recursive: true, force: true }); await d.drop(); }
});

test('T-MIG-3 a failing migration rolls back completely (no half schema, no record) and the fixed file applies on the next run', async () => {
  const d = await createTestDb();
  const dir = mkdtempSync(join(tmpdir(), 'ezz-mig-'));
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, '0900_fictional_broken.sql'), 'CREATE TABLE fictional_half (id int);\nSELECT 1/0;\n');
    await assert.rejects(migrate(d.ownerUrl, dir), /0900_fictional_broken\.sql failed/);
    const a = await adminConn(d.name);
    try {
      assert.equal((await a.query("SELECT to_regclass('fictional_half') IS NULL AS gone")).rows[0]!.gone, true, 'first statement rolled back');
      assert.equal((await a.query("SELECT 1 FROM schema_migrations WHERE version = '0900_fictional_broken.sql'")).rowCount, 0);
    } finally { a.end(); }
    writeFileSync(join(dir, '0900_fictional_broken.sql'), 'CREATE TABLE fictional_half (id int);\n');
    assert.deepEqual(await migrate(d.ownerUrl, dir), ['0900_fictional_broken.sql']);
  } finally { rmSync(dir, { recursive: true, force: true }); await d.drop(); }
});

test('T-START-1 (RED before fix) the server refuses to start on a schema that is ahead of the code, and says why', async () => {
  const d = await createTestDb();
  try {
    await ownerExec(d.name, "INSERT INTO schema_migrations (version, sha256) VALUES ('0099_from_a_newer_build.sql', repeat('0', 64))");
    const r = await runServer(d.appUrl);
    assert.equal(r.listening, false, r.out);
    assert.equal(r.exitCode, 3, r.out);
    assert.match(r.out, /migrations/i);
    assert.ok(!r.out.includes(new URL(d.appUrl).password), 'no password in diagnostics');
  } finally { await d.drop(); }
});

test('T-START-2 (RED before fix) a wrong database password stops startup with a safe message (no password, no URL)', async () => {
  const u = new URL(db.appUrl); u.password = 'fictional-wrong-password-xyz';
  const r = await runServer(u.toString());
  assert.equal(r.listening, false, r.out);
  assert.equal(r.exitCode, 3, r.out);
  assert.match(r.out, /database/i);
  assert.ok(!r.out.includes('fictional-wrong-password-xyz') && !r.out.includes('postgres://'), r.out);
});

test('T-START-3 a healthy database starts; GET /api/v1/health/ready reports ready, then not ready (503) when the schema moves ahead', async () => {
  const r = await runServer(db.appUrl);
  assert.equal(r.listening, true, r.out);
  const ok = await api.call('GET', '/api/v1/health/ready');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.checks, { database: 'ok', migrations: 'current' });
  await ownerExec(db.name, "INSERT INTO schema_migrations (version, sha256) VALUES ('0099_from_a_newer_build.sql', repeat('0', 64))");
  try {
    const bad = await api.call('GET', '/api/v1/health/ready');
    assert.equal(bad.status, 503);
    assert.equal(bad.body.checks.migrations, 'ahead_of_code');
    assert.ok(!JSON.stringify(bad.body).includes('0099'), 'no migration names on a public endpoint');
  } finally { await ownerExec(db.name, "DELETE FROM schema_migrations WHERE version = '0099_from_a_newer_build.sql'"); }
});

test('T-MIG-4 scripts/migrate.ts --check exits 0 on a current schema and 1 (with the reason) on a schema ahead of the code', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { SCRIPTS_DIR, RUNNING_COMPILED, BACKEND_ROOT } = await import('../src/platform/paths.ts');
  const script = RUNNING_COMPILED ? join(BACKEND_ROOT, 'dist', 'scripts', 'migrate.js') : join(SCRIPTS_DIR, 'migrate.ts');
  const d = await createTestDb();
  try {
    const okOut = execFileSync(process.execPath, [script, '--check'], { env: { ...process.env, MIGRATION_DATABASE_URL: d.ownerUrl }, encoding: 'utf8' });
    assert.equal(JSON.parse(okOut).current, true);
    await ownerExec(d.name, "INSERT INTO schema_migrations (version, sha256) VALUES ('0099_from_a_newer_build.sql', repeat('0', 64))");
    const bad = spawnSync(process.execPath, [script, '--check'], { env: { ...process.env, MIGRATION_DATABASE_URL: d.ownerUrl }, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.deepEqual(JSON.parse(bad.stdout).unknownApplied, ['0099_from_a_newer_build.sql']);
  } finally { await d.drop(); }
});

test('T-DOC-1 doctor: Node major and PostgreSQL 16 checks, TLS policy of DATABASE_URL, migrations; never prints secrets', async () => {
  const { checkNode, checkPgVersion, runDoctor } = await import('../scripts/doctor.ts');
  assert.equal(checkNode('v22.1.0', '22.23.4').ok, true);
  assert.equal(checkNode('v20.11.0', '22.23.4').ok, false);
  assert.equal(checkPgVersion(160015).ok, true);
  assert.equal(checkPgVersion(150008).ok, false);
  const r = await runDoctor({ EZZ_TEST_ADMIN_URL: process.env.EZZ_TEST_ADMIN_URL, DATABASE_URL: 'postgres://u:fictional-secret-pw@db.fictional.test/x?sslmode=require', MIGRATION_DATABASE_URL: db.ownerUrl });
  const byName = Object.fromEntries(r.checks.map(c => [c.name, c]));
  assert.equal(byName.POSTGRESQL_VERSION!.ok, true);
  assert.equal(byName.DATABASE_URL_TLS_POLICY!.ok, false, 'remote host with sslmode=require is refused by the policy');
  assert.equal(byName.MIGRATIONS_CURRENT!.ok, true, byName.MIGRATIONS_CURRENT!.detail);
  assert.equal(r.ok, false);
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes('fictional-secret-pw') && !raw.includes('postgres://'), raw);
});
