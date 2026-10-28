/*
 * B14 — disaster-recovery drill on fictional data: encrypted backup, restore onto a FRESH PostgreSQL 16
 * instance (initdb'd for this test, application roles absent), full verification, and the restored API
 * continuing to work (receipt numbering continues, tenants stay isolated). Measured timings are printed.
 * Skips with a reason if PostgreSQL server binaries (initdb/pg_ctl) are not installed on the machine.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, ADMIN_URL, MIGRATIONS_DIR, PASSWORD, type Api, type TestDb } from './helpers.ts';
import { createBackup, restoreAndVerify } from '../src/ops/disaster-recovery.ts';

const PASSPHRASE = 'fictional-owner-backup-passphrase-2026';
const ROLE_PW = { owner: 'fictional-restore-owner-pw', app: 'fictional-restore-app-pw' };

function pgBin(): string | null {
  for (const d of ['/usr/lib/postgresql/16/bin']) if (existsSync(join(d, 'initdb'))) return d;
  const r = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  const d = r.status === 0 ? r.stdout.trim() : '';
  return d && existsSync(join(d, 'initdb')) ? d : null;
}
const BIN = pgBin();
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
/** initdb/pg_ctl refuse to run as root; in that case run them as the postgres OS user. */
function pgCmd(cmd: string, args: string[]) {
  const full = join(BIN!, cmd);
  return asRoot ? execFileSync('runuser', ['-u', 'postgres', '--', full, ...args], { stdio: 'pipe' }) : execFileSync(full, args, { stdio: 'pipe' });
}
async function freePort() {
  return new Promise<number>(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}

let db: TestDb; let api: Api; let work = '';
let fresh: { dir: string; port: number; adminUrl: string } | null = null;
let A: Awaited<ReturnType<typeof standardFixture>>, B: Awaited<ReturnType<typeof standardFixture>>;
const anchors: Record<string, Array<{ seq: number; hash: string }>> = {};

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  work = mkdtempSync(join(tmpdir(), 'ezz-b14-'));
  // Fictional data in two clinics: elderly no-phone patients, cash/card, partial payment, refund, void, count.
  A = await standardFixture(api, db, 'dr-a');
  B = await standardFixture(api, db, 'dr-b');
  for (const [F, n] of [[A, 6], [B, 3]] as const) {
    for (let i = 0; i < n; i++) {
      const v = i === 0 ? F.visitId : await newVisit(api, F.desk, F.patientId, `2026-10-2${i % 9}T09:00:00Z`);
      await confirmCare(api, F.dentist, v, 50_000 + i * 1_000);
      const pay = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: F.desk, body: { amountMillimes: 30_000, tender: i % 2 ? 'CARD' : 'CASH' } });
      assert.equal(pay.status, 201, JSON.stringify(pay.body));
      if (i === 1) {
        await reauth(api, F.owner);
        assert.equal((await api.call('POST', `/api/v1/payments/${pay.body.payment.id}/void`, { token: F.owner, body: { reasonCode: 'ENTERED_IN_ERROR' } })).status, 201);
      }
    }
    await reauth(api, F.owner);
    const cp = await api.call('POST', '/api/v1/audit/checkpoints', { token: F.owner, body: { note: 'Fictional owner paper copy' } });
    anchors[F.clinic.id] = [{ seq: cp.body.checkpoint.seq, hash: cp.body.checkpoint.hash }];
  }
  const elderly = await api.call('POST', '/api/v1/patients', { token: A.desk, body: { familyName: 'Fictif', givenName: 'Mabrouka', isSynthetic: true, contactPreference: 'IN_PERSON', preferredLanguage: 'ar', nameAr: 'مبروكة' } });
  assert.equal(elderly.status, 201);

  if (BIN) {
    const dir = mkdtempSync(join(tmpdir(), 'ezz-fresh-pg-'));
    const pwfile = join(dir, 'pw');
    writeFileSync(pwfile, 'fictional-fresh-superuser-pw\n');
    if (asRoot) { chmodSync(dir, 0o700); chownSync(dir, Number(execFileSync('id', ['-u', 'postgres']).toString()), Number(execFileSync('id', ['-g', 'postgres']).toString())); chownSync(pwfile, Number(execFileSync('id', ['-u', 'postgres']).toString()), 0); }
    const port = await freePort();
    pgCmd('initdb', ['-D', join(dir, 'data'), '-U', 'postgres', '--pwfile', pwfile, '--auth-host=scram-sha-256', '--auth-local=peer', '-E', 'UTF8', '--no-instructions']);
    pgCmd('pg_ctl', ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, '-w', '-l', join(dir, 'log'), 'start']);
    fresh = { dir, port, adminUrl: `postgres://postgres:fictional-fresh-superuser-pw@127.0.0.1:${port}/postgres` };
  }
});
after(async () => {
  await api.close();
  await db.drop();
  if (fresh) { try { pgCmd('pg_ctl', ['-D', join(fresh.dir, 'data'), '-m', 'immediate', 'stop']); } catch { /* already stopped */ } rmSync(fresh.dir, { recursive: true, force: true }); }
  if (work) rmSync(work, { recursive: true, force: true });
});

const freshSkip = () => (BIN ? false : 'PostgreSQL server binaries (initdb/pg_ctl) not installed on this machine');
let backup: Awaited<ReturnType<typeof createBackup>>;

test('T-DR-1 encrypted backup: no plaintext dump or clinic names on disk; manifest pins hash, facts and inventories', async () => {
  backup = await createBackup({ adminUrl: ADMIN_URL, database: db.name, outDir: work, passphrase: PASSPHRASE, name: 'drill' });
  const enc = readFileSync(backup.encryptedPath);
  assert.equal(enc.subarray(0, 8).toString(), 'EZZBKP1\n');
  assert.ok(!enc.includes(Buffer.from('PGDMP')), 'not a plaintext pg_dump');
  assert.ok(!enc.includes(Buffer.from('Fictif')) && !enc.includes(Buffer.from('Mabrouka')), 'patient names not readable');
  const m = backup.manifest;
  assert.match(m.dumpSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(m.clinics).length, 2);
  assert.deepEqual({ payments: m.clinics[A.clinic.id]!.payments, receipts: m.clinics[A.clinic.id]!.receipts, maxR: m.clinics[A.clinic.id]!.maxReceiptNumber, next: m.clinics[A.clinic.id]!.receiptCounterNext },
    { payments: 6, receipts: 7, maxR: 7, next: 8 }, 'six payments + one VOID receipt');
  assert.ok(m.rlsTables.includes('payments') && m.appendOnlyTables.includes('audit_events') && m.appGrants.includes('payments:INSERT'));
  assert.ok(!JSON.stringify(m).includes('Fictif'), 'manifest holds no patient data');
  await assert.rejects(createBackup({ adminUrl: ADMIN_URL, database: db.name, outDir: work, passphrase: 'short' }), /at least 16/);
});

test('T-DR-2 tampered archive, wrong passphrase, or manifest mismatch: refused before anything is restored', async () => {
  const target = fresh?.adminUrl ?? ADMIN_URL;
  const base = { manifestPath: backup.manifestPath, passphrase: PASSPHRASE, targetAdminUrl: target, migrationsDir: MIGRATIONS_DIR, rolePasswords: ROLE_PW };
  await assert.rejects(restoreAndVerify({ ...base, encryptedPath: backup.encryptedPath, targetDatabase: 'ezz_dr_wrongpw', passphrase: 'not-the-owner-passphrase-123' }), /authentication failed/);
  const tampered = join(work, 'tampered.dump.enc');
  const bytes = readFileSync(backup.encryptedPath); bytes[bytes.length - 100]! ^= 0x01; writeFileSync(tampered, bytes);
  await assert.rejects(restoreAndVerify({ ...base, encryptedPath: tampered, targetDatabase: 'ezz_dr_tampered' }), /authentication failed/);
  const badManifest = join(work, 'bad.manifest.json');
  writeFileSync(badManifest, JSON.stringify({ ...backup.manifest, dumpSha256: '0'.repeat(64) }));
  await assert.rejects(restoreAndVerify({ ...base, manifestPath: badManifest, encryptedPath: backup.encryptedPath, targetDatabase: 'ezz_dr_badmanifest' }), /does not match its manifest/);
  const { PgConnection, parseDatabaseUrl } = await import('../src/platform/postgres.ts');
  const c = new PgConnection(parseDatabaseUrl(target)); await c.connect();
  try { assert.equal((await c.query("SELECT 1 FROM pg_database WHERE datname LIKE 'ezz_dr_%'")).rowCount, 0, 'no database was created'); } finally { c.end(); }
});

test('T-DR-3 restore onto a FRESH PostgreSQL 16 instance with no application roles: every verification passes', { skip: freshSkip() }, async () => {
  const report = await restoreAndVerify({ encryptedPath: backup.encryptedPath, manifestPath: backup.manifestPath, passphrase: PASSPHRASE,
    targetAdminUrl: fresh!.adminUrl, targetDatabase: 'ezz_restored', migrationsDir: MIGRATIONS_DIR, rolePasswords: ROLE_PW, anchors });
  console.log(JSON.stringify({ drill: 'T-DR-3', timingsMs: report.timingsMs, restoredBytes: report.restoredBytes, checks: report.checks.length }));
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
  const names = report.checks.map(c => c.name);
  for (const n of ['ARCHIVE_INTEGRITY', 'ROLES_PRESENT', 'MIGRATIONS_CURRENT', 'FACTS_MATCH', 'RLS_POLICIES_MATCH', 'APPEND_ONLY_TRIGGERS_MATCH', 'APP_GRANTS_MATCH', 'AUDIT_CHAIN:dr-a', 'INTEGRITY:dr-b', 'TENANT_ISOLATION:no-context', 'APP_ROLE_LEAST_PRIVILEGE']) assert.ok(names.includes(n), n);
  assert.match(report.checks.find(c => c.name === 'ROLES_PRESENT')!.detail, /bootstrapped 2/);
  assert.match(report.checks.find(c => c.name === 'AUDIT_CHAIN:dr-a')!.detail, /1 owner checkpoint/);
});

test('T-DR-4 the restored system works: staff log in, receipt numbering continues without a gap, tenants stay isolated', { skip: freshSkip() }, async () => {
  const appUrl = (() => { const u = new URL(fresh!.adminUrl); u.username = 'ezz_app'; u.password = ROLE_PW.app; u.pathname = '/ezz_restored'; return u.toString(); })();
  const api2 = await startApi(appUrl);
  try {
    const owner = await api2.login('dr-a', 'owner', PASSWORD);
    const desk = await api2.login('dr-a', 'desk', PASSWORD);
    const dentist = await api2.login('dr-a', 'dentist', PASSWORD);
    const v = await newVisit(api2, desk, A.patientId, '2026-10-30T09:00:00Z');
    await confirmCare(api2, dentist, v, 20_000);
    const pay = await api2.call('POST', `/api/v1/visits/${v}/payments`, { token: desk, body: { amountMillimes: 20_000, tender: 'CASH' } });
    assert.equal(pay.status, 201, JSON.stringify(pay.body));
    assert.equal(pay.body.receipt.label, 'R-000008', 'continues after the last restored receipt R-000007');
    const bDesk = await api2.login('dr-b', 'desk', PASSWORD);
    assert.equal((await api2.call('GET', `/api/v1/visits/${v}/balance`, { token: bDesk })).status, 404, 'clinic B cannot see clinic A after restore');
    await reauth(api2, owner);
    const integ = await api2.call('POST', '/api/v1/integrity/check', { token: owner, body: { anchors: anchors[A.clinic.id] }, idem: false });
    assert.equal(integ.body.ok, true, JSON.stringify(integ.body.findings));
  } finally { await api2.close(); }
});

test('T-DR-5 restoring an OLDER backup after newer activity is caught by the newer owner checkpoint; existing target is never overwritten', { skip: freshSkip() }, async () => {
  // Newer reality on the source after the backup: one more payment and a newer owner checkpoint.
  const v = await newVisit(api, A.desk, A.patientId, '2026-10-31T09:00:00Z');
  await confirmCare(api, A.dentist, v, 15_000);
  await api.call('POST', `/api/v1/visits/${v}/payments`, { token: A.desk, body: { amountMillimes: 15_000, tender: 'CASH' } });
  await reauth(api, A.owner);
  const cp = await api.call('POST', '/api/v1/audit/checkpoints', { token: A.owner, body: {} });
  const newer = { ...anchors, [A.clinic.id]: [{ seq: cp.body.checkpoint.seq, hash: cp.body.checkpoint.hash }] };
  const report = await restoreAndVerify({ encryptedPath: backup.encryptedPath, manifestPath: backup.manifestPath, passphrase: PASSPHRASE,
    targetAdminUrl: fresh!.adminUrl, targetDatabase: 'ezz_restored_old', migrationsDir: MIGRATIONS_DIR, rolePasswords: ROLE_PW, anchors: newer });
  assert.equal(report.ok, false);
  const chain = report.checks.find(c => c.name === 'AUDIT_CHAIN:dr-a')!;
  assert.equal(chain.ok, false);
  assert.match(chain.detail, /SHORTER_THAN_ANCHOR/);
  assert.match(report.checks.find(c => c.name === 'ROLES_PRESENT')!.detail, /already existed/);
  await assert.rejects(restoreAndVerify({ encryptedPath: backup.encryptedPath, manifestPath: backup.manifestPath, passphrase: PASSPHRASE,
    targetAdminUrl: fresh!.adminUrl, targetDatabase: 'ezz_restored', migrationsDir: MIGRATIONS_DIR, rolePasswords: ROLE_PW }), /already exists/);
});

test('T-DR-6 CLI round trip: scripts/backup.ts then scripts/restore-verify.ts exit 0 with a passing report', { skip: freshSkip() }, async () => {
  const env = { ...process.env, EZZ_ADMIN_URL: ADMIN_URL, EZZ_BACKUP_PASSPHRASE: PASSPHRASE };
  const out = JSON.parse(execFileSync(process.execPath, ['scripts/backup.ts', db.name, work], { env, encoding: 'utf8' }));
  assert.equal(out.clinics, 2);
  const anchorFile = join(work, 'anchors.json');
  writeFileSync(anchorFile, JSON.stringify({}));
  const r = spawnSync(process.execPath, ['scripts/restore-verify.ts', out.encrypted, out.manifest, 'ezz_restored_cli', anchorFile],
    { env: { ...env, EZZ_ADMIN_URL: fresh!.adminUrl, EZZ_OWNER_PW: ROLE_PW.owner, EZZ_APP_PW: ROLE_PW.app }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});
