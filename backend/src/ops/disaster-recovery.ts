/*
 * Disaster recovery (B14): encrypted backup with a verification manifest, and restore-and-verify onto any
 * PostgreSQL 16 instance (including a fresh one where the application roles do not exist yet).
 * FICTIONAL DATA ONLY. Not a hosting decision: where backups live (Tunisian data-location rules, CH-004/006)
 * and how the owner stores the passphrase are open founder/legal questions (ops doc §6).
 *
 * Backup = `pg_dump -Fc` of one database, encrypted with AES-256-GCM under a key derived (scrypt) from an
 * owner-held passphrase, plus a manifest that holds NO patient data: SHA-256 of the plaintext dump, applied
 * migrations, per-clinic counts and money totals, audit-chain heads, RLS/append-only/grant inventories.
 * Restore = decrypt (GCM authenticates every byte), check the SHA-256, bootstrap roles if missing, restore
 * into a NEW empty database (never over an existing one), then verify: migrations current, facts equal the
 * manifest, every clinic's audit chain and integrity check pass (with owner checkpoints if supplied), RLS
 * policies, grants and append-only triggers present, and a tenant-isolation probe through the app role.
 */
import { createReadStream, createWriteStream, statSync, openSync, readSync, closeSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { PgConnection, parseDatabaseUrl, type ConnConfig } from '../platform/postgres.ts';
import { migrate } from '../platform/migrate.ts';
import { Db } from '../platform/db.ts';
import { verifyChain, type Anchor } from '../modules/audit.ts';
import { integrityCheck } from '../modules/integrity.ts';
import { parseCheckpointLine, verifyLines } from '../modules/checkpoints.ts';

const run = promisify(execFile);
const MAGIC = Buffer.from('EZZBKP1\n');
const KDF = { N: 32768, r: 8, p: 1, keyLen: 32 };
const TAG_LEN = 16;

export interface ClinicFacts {
  code: string; patients: number; visits: number; careItems: number; careTotalMillimes: number;
  payments: number; paymentTotalMillimes: number; allocationTotalMillimes: number; adjustments: number; adjustmentTotalMillimes: number;
  receipts: number; maxReceiptNumber: number; receiptCounterNext: number | null; cashCounts: number; auditSeq: number; auditHash: string | null;
}
export interface Manifest {
  format: 'ezz-backup-manifest/1'; createdAt: string; database: string; serverVersion: string;
  dumpSha256: string; dumpBytes: number; encryptedBytes: number;
  migrations: Array<{ version: string; sha256: string }>;
  clinics: Record<string, ClinicFacts>;
  rlsTables: string[]; appendOnlyTables: string[]; appGrants: string[];
  notice: string;
}

function pgArgs(cfg: ConnConfig) { return ['-h', cfg.host, '-p', String(cfg.port), '-U', cfg.user]; }
function pgEnv(cfg: ConnConfig) {
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: cfg.password ?? '' };
  if (cfg.sslMode !== 'disable') { env.PGSSLMODE = cfg.sslMode; if (cfg.sslRootCert) env.PGSSLROOTCERT = cfg.sslRootCert; }
  return env;
}
const withDb = (url: string, database: string) => { const u = new URL(url); u.pathname = '/' + database; return u.toString(); };
async function connect(url: string) { const c = new PgConnection(parseDatabaseUrl(url)); await c.connect(); return c; }
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Facts that must survive a backup/restore unchanged. Read as superuser (RLS does not apply). */
export async function collectFacts(adminDbUrl: string): Promise<Omit<Manifest, 'format' | 'createdAt' | 'database' | 'dumpSha256' | 'dumpBytes' | 'encryptedBytes' | 'notice'>> {
  const c = await connect(adminDbUrl);
  try {
    const version = (await c.query<{ v: string }>('SHOW server_version')).rows[0]!.v;
    const migrations = (await c.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations ORDER BY version')).rows;
    const has = async (t: string) => (await c.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [t])).rows[0]!.ok;
    const cash = await has('cash_counts');
    const rows = (await c.query<Record<string, unknown> & { id: string }>(`SELECT cl.id, cl.code,
        (SELECT count(*) FROM patients x WHERE x.clinic_id = cl.id)::int AS patients,
        (SELECT count(*) FROM visits x WHERE x.clinic_id = cl.id)::int AS visits,
        (SELECT count(*) FROM care_items x WHERE x.clinic_id = cl.id)::int AS "careItems",
        (SELECT coalesce(sum(fee_millimes),0) FROM care_items x WHERE x.clinic_id = cl.id)::bigint AS "careTotalMillimes",
        (SELECT count(*) FROM payments x WHERE x.clinic_id = cl.id)::int AS payments,
        (SELECT coalesce(sum(amount_millimes),0) FROM payments x WHERE x.clinic_id = cl.id)::bigint AS "paymentTotalMillimes",
        (SELECT coalesce(sum(amount_millimes),0) FROM payment_allocations x WHERE x.clinic_id = cl.id)::bigint AS "allocationTotalMillimes",
        (SELECT count(*) FROM adjustments x WHERE x.clinic_id = cl.id)::int AS adjustments,
        (SELECT coalesce(sum(amount_millimes),0) FROM adjustments x WHERE x.clinic_id = cl.id)::bigint AS "adjustmentTotalMillimes",
        (SELECT count(*) FROM receipts x WHERE x.clinic_id = cl.id)::int AS receipts,
        (SELECT coalesce(max(number),0) FROM receipts x WHERE x.clinic_id = cl.id AND series = 'R')::int AS "maxReceiptNumber",
        (SELECT next_number FROM receipt_counters x WHERE x.clinic_id = cl.id AND series = 'R') AS "receiptCounterNext",
        ${cash ? '(SELECT count(*) FROM cash_counts x WHERE x.clinic_id = cl.id)::int' : '0'} AS "cashCounts",
        coalesce((SELECT last_seq FROM audit_heads h WHERE h.clinic_id = cl.id), 0)::bigint AS "auditSeq",
        (SELECT last_hash FROM audit_heads h WHERE h.clinic_id = cl.id) AS "auditHash"
      FROM clinics cl ORDER BY cl.code`)).rows;
    const clinics: Record<string, ClinicFacts> = {};
    for (const { id, ...f } of rows) clinics[id] = f as unknown as ClinicFacts;
    const rlsTables = (await c.query<{ t: string }>(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity ORDER BY 1`)).rows.map(r => r.t);
    const appendOnlyTables = (await c.query<{ t: string }>(`SELECT DISTINCT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
        WHERE g.tgname = 'append_only_row' AND NOT g.tgisinternal ORDER BY 1`)).rows.map(r => r.t);
    const appGrants = (await c.query<{ g: string }>(`SELECT table_name || ':' || privilege_type AS g FROM information_schema.role_table_grants
        WHERE grantee = 'ezz_app' AND table_schema = 'public' ORDER BY 1`)).rows.map(r => r.g);
    return { serverVersion: version, migrations, clinics, rlsTables, appendOnlyTables, appGrants };
  } finally { c.end(); }
}

function deriveKey(passphrase: string, salt: Buffer) {
  if (passphrase.length < 16) throw new Error('Backup passphrase must be at least 16 characters');
  return crypto.scryptSync(passphrase, salt, KDF.keyLen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 128 * KDF.N * KDF.r * 2 });
}
async function sha256File(path: string) {
  const h = crypto.createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/** Stream-encrypt: MAGIC | header JSON line | ciphertext | 16-byte GCM tag. */
async function encryptFile(src: string, dst: string, passphrase: string) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const header = Buffer.from(JSON.stringify({ alg: 'aes-256-gcm', kdf: 'scrypt', ...KDF, salt: salt.toString('base64'), iv: iv.toString('base64') }) + '\n');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([MAGIC, header]));
  const out = createWriteStream(dst);
  out.write(MAGIC); out.write(header);
  await pipeline(createReadStream(src), cipher, out, { end: false });
  await new Promise<void>((res, rej) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? rej(e) : res())));
}

async function decryptFile(src: string, dst: string, passphrase: string) {
  const size = statSync(src).size;
  const fd = openSync(src, 'r');
  let headerBuf: Buffer, tag: Buffer;
  try {
    const head = Buffer.alloc(Math.min(4096, size));
    readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an EZZ encrypted backup');
    const nl = head.indexOf(0x0a, MAGIC.length);
    if (nl < 0) throw new Error('Corrupt backup header');
    headerBuf = head.subarray(MAGIC.length, nl + 1);
    tag = Buffer.alloc(TAG_LEN);
    readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { closeSync(fd); }
  const h = JSON.parse(headerBuf.toString('utf8')) as { salt: string; iv: string; N: number; r: number; p: number };
  if (h.N !== KDF.N || h.r !== KDF.r || h.p !== KDF.p) throw new Error('Unsupported key-derivation parameters');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(h.salt, 'base64')), Buffer.from(h.iv, 'base64'));
  decipher.setAAD(Buffer.concat([MAGIC, headerBuf]));
  decipher.setAuthTag(tag);
  const start = MAGIC.length + headerBuf.length;
  try {
    await pipeline(createReadStream(src, { start, end: size - TAG_LEN - 1 }), decipher, createWriteStream(dst));
  } catch {
    rmSync(dst, { force: true });
    throw new Error('Backup authentication failed: wrong passphrase or the file was modified');
  }
}

export interface BackupResult { encryptedPath: string; manifestPath: string; manifest: Manifest; dumpMs: number }

export async function createBackup(opts: { adminUrl: string; database: string; outDir: string; passphrase: string; name?: string }): Promise<BackupResult> {
  if (!IDENT.test(opts.database)) throw new Error('Invalid database name');
  const cfg = parseDatabaseUrl(opts.adminUrl);
  const work = mkdtempSync(join(tmpdir(), 'ezz-bkp-'));
  const plain = join(work, 'db.dump');
  try {
    const t0 = Date.now();
    await run('pg_dump', [...pgArgs(cfg), '-Fc', '--no-password', '-f', plain, opts.database], { env: pgEnv(cfg) });
    const dumpMs = Date.now() - t0;
    const facts = await collectFacts(withDb(opts.adminUrl, opts.database));
    const name = opts.name ?? `ezz-${opts.database}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const encryptedPath = join(opts.outDir, `${name}.dump.enc`);
    const manifestPath = join(opts.outDir, `${name}.manifest.json`);
    const dumpSha256 = await sha256File(plain);
    await encryptFile(plain, encryptedPath, opts.passphrase);
    const manifest: Manifest = {
      format: 'ezz-backup-manifest/1', createdAt: new Date().toISOString(), database: opts.database,
      dumpSha256, dumpBytes: statSync(plain).size, encryptedBytes: statSync(encryptedPath).size, ...facts,
      notice: 'FICTIONAL DATA ONLY. The manifest holds counts, totals and hashes, no patient data. Keep the passphrase with the owner, away from the backup file.',
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { encryptedPath, manifestPath, manifest, dumpMs };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export interface VerifyCheck { name: string; ok: boolean; detail: string }
export interface RestoreReport { ok: boolean; database: string; checks: VerifyCheck[]; timingsMs: Record<string, number>; restoredBytes: number }

export interface RestoreOptions {
  encryptedPath: string; manifestPath: string; passphrase: string;
  targetAdminUrl: string; targetDatabase: string; migrationsDir: string;
  /** Role passwords to set if the target instance does not have the roles yet (fresh instance). */
  rolePasswords: { owner: string; app: string };
  /** Owner-held checkpoints per clinic id, kept outside the database. */
  anchors?: Record<string, Anchor[]>;
  /** Owner checkpoint lines kept outside (EZZ-CP2 or legacy EZZ-CHECKPOINT), for any clinic in the backup. */
  checkpointLines?: string[];
}

/** Restore into a NEW database and verify it. Throws before restoring if the archive does not authenticate. */
export async function restoreAndVerify(o: RestoreOptions): Promise<RestoreReport> {
  if (!IDENT.test(o.targetDatabase)) throw new Error('Invalid target database name');
  const manifest = JSON.parse(readFileSync(o.manifestPath, 'utf8')) as Manifest;
  const timings: Record<string, number> = {};
  const checks: VerifyCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };
  const cfg = parseDatabaseUrl(o.targetAdminUrl);
  const work = mkdtempSync(join(tmpdir(), 'ezz-rst-'));
  const plain = join(work, 'db.dump');
  try {
    let t = Date.now();
    await decryptFile(o.encryptedPath, plain, o.passphrase);
    const sha = await sha256File(plain);
    timings.decryptMs = Date.now() - t;
    if (sha !== manifest.dumpSha256) throw new Error('Backup content does not match its manifest (SHA-256 differs)');
    add('ARCHIVE_INTEGRITY', true, 'AES-256-GCM authenticated and SHA-256 equals the manifest');

    const admin = await connect(o.targetAdminUrl);
    try {
      if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [o.targetDatabase])).rowCount) {
        throw new Error(`Target database ${o.targetDatabase} already exists; restore only into a new database`);
      }
      const roles = (await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('ezz_owner','ezz_app')")).rows.map(r => r.rolname);
      // Roles are cluster-global and NOT in pg_dump: a fresh instance needs them before the grants can restore.
      for (const [role, pw] of [['ezz_owner', o.rolePasswords.owner], ['ezz_app', o.rolePasswords.app]] as const) {
        if (!roles.includes(role)) {
          const lit = (await admin.query<{ q: string }>('SELECT quote_literal($1) AS q', [pw])).rows[0]!.q;
          await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD ${lit} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
        }
      }
      add('ROLES_PRESENT', true, roles.length === 2 ? 'application roles already existed' : `bootstrapped ${2 - roles.length} missing application role(s)`);
      await admin.exec(`CREATE DATABASE ${o.targetDatabase} OWNER ezz_owner`);
      await admin.exec(`REVOKE ALL ON DATABASE ${o.targetDatabase} FROM PUBLIC; GRANT CONNECT ON DATABASE ${o.targetDatabase} TO ezz_app`);
    } finally { admin.end(); }

    t = Date.now();
    await run('pg_restore', [...pgArgs(cfg), '--no-password', '--exit-on-error', '-d', o.targetDatabase, plain], { env: pgEnv(cfg) });
    timings.restoreMs = Date.now() - t;

    t = Date.now();
    const targetAdminDb = withDb(o.targetAdminUrl, o.targetDatabase);
    const ownerUrl = (() => { const u = new URL(targetAdminDb); u.username = 'ezz_owner'; u.password = o.rolePasswords.owner; return u.toString(); })();
    const appUrl = (() => { const u = new URL(targetAdminDb); u.username = 'ezz_app'; u.password = o.rolePasswords.app; return u.toString(); })();
    const pending = await migrate(ownerUrl, o.migrationsDir);
    add('MIGRATIONS_CURRENT', pending.length === 0, pending.length ? `migrations applied after restore: ${pending.join(', ')}` : 'every migration already applied with matching checksums');

    const facts = await collectFacts(targetAdminDb);
    const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    add('FACTS_MATCH', eq(facts.clinics, manifest.clinics), eq(facts.clinics, manifest.clinics) ? `${Object.keys(facts.clinics).length} clinic(s): counts, money totals, receipt numbering and audit heads identical` : `differs: expected ${JSON.stringify(manifest.clinics)} got ${JSON.stringify(facts.clinics)}`);
    add('MIGRATION_LEDGER_MATCH', eq(facts.migrations, manifest.migrations), 'schema_migrations versions and checksums');
    add('RLS_POLICIES_MATCH', eq(facts.rlsTables, manifest.rlsTables) && facts.rlsTables.length > 0, `${facts.rlsTables.length} tables with forced row-level security`);
    add('APPEND_ONLY_TRIGGERS_MATCH', eq(facts.appendOnlyTables, manifest.appendOnlyTables) && facts.appendOnlyTables.length > 0, `${facts.appendOnlyTables.length} append-only tables`);
    add('APP_GRANTS_MATCH', eq(facts.appGrants, manifest.appGrants) && facts.appGrants.length > 0, `${facts.appGrants.length} table privileges for ezz_app`);

    if (o.checkpointLines?.length) {
      const bad = o.checkpointLines.map((l, i) => ({ i, p: parseCheckpointLine(l) })).filter(x => !x.p.ok);
      add('CHECKPOINT_LINES_READABLE', bad.length === 0, bad.length === 0 ? `${o.checkpointLines.length} line(s) readable`
        : `unreadable line(s): ${bad.map(x => `#${x.i + 1} ${(x.p as { reason: string }).reason}`).join(', ')}`);
    }
    const db = new Db(appUrl, { max: 2 });
    try {
      for (const clinicId of Object.keys(manifest.clinics)) {
        const code = manifest.clinics[clinicId]!.code;
        const anchors = o.anchors?.[clinicId] ?? [];
        const chain = await db.tx(clinicId, tx => verifyChain(tx, clinicId, anchors));
        add(`AUDIT_CHAIN:${code}`, chain.ok, chain.ok ? `${chain.eventCount} events, ${anchors.length} owner checkpoint(s) verified` : JSON.stringify(chain.findings.slice(0, 5)));
        const integ = await db.tx(clinicId, tx => integrityCheck(tx, clinicId, anchors));
        add(`INTEGRITY:${code}`, integ.ok, integ.ok ? `${integ.receiptsIssued} receipts, no findings` : JSON.stringify(integ.findings.slice(0, 5).map(f => f.check)));
        // R73-A: the owner's printed checkpoint lines for this clinic. An older backup restored after a newer
        // checkpoint is reported here (CHAIN_SHORTER), which is exactly the rollback an outside copy exists to catch.
        const mine = (o.checkpointLines ?? []).filter(l => { const p = parseCheckpointLine(l); return p.ok && (p.legacy ? p.clinicId === clinicId : p.fields.clinicCode === code); });
        if (mine.length) {
          const v = await db.tx(clinicId, tx => verifyLines(tx, { id: clinicId, code }, mine));
          add(`CHECKPOINT_LINES:${code}`, v.ok, v.ok ? `${mine.length} owner checkpoint line(s) match the restored history`
            : JSON.stringify(v.results.filter(r => r.verdict !== 'MATCHES').map(r => ({ seq: 'seq' in r ? r.seq : null, verdict: r.verdict }))));
        }
        const seen = await db.tx(clinicId, async tx => (await tx.query<{ clinic_id: string }>('SELECT DISTINCT clinic_id FROM payments UNION SELECT DISTINCT clinic_id FROM patients')).rows.map(r => r.clinic_id));
        add(`TENANT_ISOLATION:${code}`, seen.every(c => c === clinicId), `app role with clinic context sees ${seen.length ? 'only its own clinic' : 'no rows'}`);
      }
      const anon = await db.tx(null, async tx => (await tx.query('SELECT id FROM patients UNION ALL SELECT id FROM payments')).rowCount);
      add('TENANT_ISOLATION:no-context', anon === 0, `app role without clinic context sees ${anon} patient/payment rows`);
      const priv = await db.tx(null, async tx => tx.one<{ upd: boolean; del: boolean }>("SELECT has_table_privilege('payments', 'UPDATE') AS upd, has_table_privilege('audit_events', 'DELETE') AS del"));
      add('APP_ROLE_LEAST_PRIVILEGE', !priv.upd && !priv.del, `ezz_app UPDATE payments=${priv.upd}, DELETE audit_events=${priv.del}`);
    } finally { await db.close(); }
    timings.verifyMs = Date.now() - t;
    return { ok: checks.every(c => c.ok), database: o.targetDatabase, checks, timingsMs: timings, restoredBytes: statSync(plain).size };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
