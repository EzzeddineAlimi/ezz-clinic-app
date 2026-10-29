/*
 * B05 / issue #4 — database transport security and connection-pool safety (node-postgres adapter).
 * TLS: a fake PostgreSQL endpoint that speaks the SSLRequest handshake with openssl-generated fictional
 * certificates proves certificate rejection, hostname checking and no plaintext fallback, in CI too.
 * An optional real-server TLS test runs when EZZ_TEST_TLS_ROOTCERT points at the server's CA (local run).
 * Pool: real PostgreSQL 16, real RLS, two fictional clinics.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, seedClinic, adminConn, ADMIN_URL, type TestDb } from './helpers.ts';
import { parseDatabaseUrl, PgConnection, PgError, InsecureDatabaseConfigError } from '../src/platform/postgres.ts';
import { Db } from '../src/platform/db.ts';

// ---------------------------------------------------------------------------------------- TLS policy

test('T-TLS-POLICY-1 remote hosts default to verify-full; plaintext/unverified modes are refused before connecting', () => {
  assert.equal(parseDatabaseUrl('postgres://u:p@db.fictional.test/x').sslMode, 'verify-full');
  assert.equal(parseDatabaseUrl('postgres://u:p@db.fictional.test/x?sslmode=verify-ca').sslMode, 'verify-ca');
  for (const mode of ['disable', 'require', 'no-verify', 'prefer', 'allow']) {
    assert.throws(() => parseDatabaseUrl(`postgres://u:secret-pw@10.0.0.5:5432/x?sslmode=${mode}`), InsecureDatabaseConfigError, mode);
  }
  assert.throws(() => parseDatabaseUrl('postgres://u:p@db.fictional.test/x?sslmode=bogus'), InsecureDatabaseConfigError);
  try { parseDatabaseUrl('postgres://u:secret-pw@10.0.0.5/x?sslmode=disable'); } catch (e) { assert.ok(!(e as Error).message.includes('secret-pw'), 'no credential in error'); }
});

test('T-TLS-POLICY-2 loopback and Unix sockets are the only exemption (local dev / CI), and may opt in to TLS', () => {
  assert.equal(parseDatabaseUrl('postgres://u:p@localhost/x').sslMode, 'disable');
  assert.equal(parseDatabaseUrl('postgres://u:p@127.0.0.1/x').sslMode, 'disable');
  assert.equal(parseDatabaseUrl('postgres://u:p@[::1]/x').sslMode, 'disable');
  assert.equal(parseDatabaseUrl('postgres://u@x/db?host=/var/run/postgresql').sslMode, 'disable');
  assert.equal(parseDatabaseUrl('postgres://u:p@localhost/x?sslmode=verify-full').sslMode, 'verify-full');
  assert.equal(parseDatabaseUrl('postgres://u:p@localhost/x?sslmode=require').sslMode, 'require');
  assert.throws(() => parseDatabaseUrl('postgres://u:p@localhost/x?sslmode=prefer'), InsecureDatabaseConfigError, 'prefer may silently fall back');
});

// ------------------------------------------------------------------------- fake TLS PostgreSQL endpoint

let certDir = '';
const pem = (f: string) => join(certDir, f);
function openssl(args: string[]) { execFileSync('openssl', args, { stdio: 'pipe' }); }

before(() => {
  certDir = mkdtempSync(join(tmpdir(), 'ezz-b05-certs-'));
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Fictional EZZ Test CA', '-keyout', pem('ca.key'), '-out', pem('ca.pem')]);
  const leaf = (name: string, san: string) => {
    writeFileSync(pem(`${name}.ext`), `subjectAltName=${san}\n`);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', pem(`${name}.key`), '-out', pem(`${name}.csr`)]);
    openssl(['x509', '-req', '-in', pem(`${name}.csr`), '-CA', pem('ca.pem'), '-CAkey', pem('ca.key'), '-CAcreateserial', '-days', '2', '-extfile', pem(`${name}.ext`), '-out', pem(`${name}.pem`)]);
  };
  leaf('good', 'DNS:localhost,IP:127.0.0.1');
  leaf('wrongname', 'DNS:db.other-clinic.test');
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', pem('self.key'), '-out', pem('self.pem')]);
});
after(() => { if (certDir) rmSync(certDir, { recursive: true, force: true }); });

/**
 * Minimal PostgreSQL TLS endpoint: answers SSLRequest with 'S' (or 'N'), upgrades to TLS, records whether a
 * StartupMessage (which carries the user name) ever arrived, then rejects login with a FATAL error.
 */
async function fakeServer(mode: { cert?: string; refuseSsl?: boolean }) {
  const seen = { plaintextStartup: false, tlsStartup: false, handshakes: 0 };
  const server = net.createServer(sock => {
    sock.once('data', (first: Buffer) => {
      const isSslRequest = first.length >= 8 && first.readInt32BE(4) === 80877103;
      if (!isSslRequest) { seen.plaintextStartup = true; sock.destroy(); return; }
      if (mode.refuseSsl) {
        sock.write('N');
        sock.once('data', () => { seen.plaintextStartup = true; sock.destroy(); });
        return;
      }
      sock.write('S');
      const t = new tls.TLSSocket(sock, { isServer: true, key: readFileSync(pem(`${mode.cert}.key`)), cert: readFileSync(pem(`${mode.cert}.pem`)) });
      t.on('secure', () => { seen.handshakes++; });
      t.on('error', () => undefined);
      t.once('data', () => {
        seen.tlsStartup = true;
        const fields = Buffer.from('SFATAL\0C28000\0Mfictional endpoint rejects login\0\0');
        const head = Buffer.alloc(5); head.write('E'); head.writeInt32BE(fields.length + 4, 1);
        t.end(Buffer.concat([head, fields]));
      });
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { seen, port, close: () => new Promise<void>(r => server.close(() => r())) };
}

async function tryConnect(url: string): Promise<Error> {
  const c = new PgConnection(parseDatabaseUrl(url));
  try { await c.connect(); c.end(); return new Error('connected unexpectedly'); } catch (e) { return e as Error; }
}

test('T-TLS-1 untrusted (self-signed) server certificate is rejected; the startup message (user name) is never sent', async () => {
  const s = await fakeServer({ cert: 'self' });
  try {
    const err = await tryConnect(`postgres://fictional_user:fictional-secret@localhost:${s.port}/db?sslmode=verify-full`);
    assert.match(String((err as NodeJS.ErrnoException).code ?? err.message), /SELF_SIGNED|UNABLE_TO_VERIFY|self[- ]signed/i, err.message);
    assert.equal(s.seen.tlsStartup, false);
    assert.equal(s.seen.plaintextStartup, false);
    assert.ok(!err.message.includes('fictional-secret'));
  } finally { await s.close(); }
});

test('T-TLS-2 certificate signed by the pinned CA with the right name: TLS completes, then the server answers', async () => {
  const s = await fakeServer({ cert: 'good' });
  try {
    const err = await tryConnect(`postgres://fictional_user:pw@localhost:${s.port}/db?sslmode=verify-full&sslrootcert=${encodeURIComponent(pem('ca.pem'))}`);
    assert.ok(err instanceof PgError, `expected the fake server's FATAL after a completed handshake, got ${err.message}`);
    assert.equal((err as PgError).code, '28000');
    assert.equal(s.seen.handshakes, 1);
    assert.equal(s.seen.tlsStartup, true, 'startup message travelled inside TLS');
  } finally { await s.close(); }
});

test('T-TLS-3 trusted CA but wrong host name: verify-full rejects; verify-ca (explicit) accepts', async () => {
  const s = await fakeServer({ cert: 'wrongname' });
  try {
    const ca = encodeURIComponent(pem('ca.pem'));
    const full = await tryConnect(`postgres://u:pw@localhost:${s.port}/db?sslmode=verify-full&sslrootcert=${ca}`);
    assert.match(String((full as NodeJS.ErrnoException).code ?? full.message), /ALTNAME|does not match|Hostname/i, full.message);
    assert.equal(s.seen.tlsStartup, false);
    const caOnly = await tryConnect(`postgres://u:pw@localhost:${s.port}/db?sslmode=verify-ca&sslrootcert=${ca}`);
    assert.ok(caOnly instanceof PgError, caOnly.message);
  } finally { await s.close(); }
});

test('T-TLS-4 server that refuses TLS: no plaintext fallback under verify-full', async () => {
  const s = await fakeServer({ refuseSsl: true });
  try {
    const err = await tryConnect(`postgres://u:pw@localhost:${s.port}/db?sslmode=verify-full`);
    assert.match(err.message, /does not support SSL/i);
    assert.equal(s.seen.plaintextStartup, false);
  } finally { await s.close(); }
});

test('T-TLS-5 (local evidence, optional) real PostgreSQL over verified TLS: pg_stat_ssl reports an encrypted session', { skip: !process.env.EZZ_TEST_TLS_ROOTCERT && 'EZZ_TEST_TLS_ROOTCERT not set (CI service container runs without TLS)' }, async () => {
  const u = new URL(ADMIN_URL);
  u.searchParams.set('sslmode', 'verify-full');
  // Pinning a CA that did not sign the server certificate must fail, whatever the process trust store holds.
  u.searchParams.set('sslrootcert', pem('ca.pem'));
  const wrongCa = await tryConnect(u.toString());
  assert.match(String((wrongCa as NodeJS.ErrnoException).code ?? wrongCa.message), /SELF_SIGNED|UNABLE_TO_VERIFY|self[- ]signed|unable to get/i, wrongCa.message);
  u.searchParams.set('sslrootcert', process.env.EZZ_TEST_TLS_ROOTCERT!);
  const c = new PgConnection(parseDatabaseUrl(u.toString()));
  await c.connect();
  try {
    const r = await c.query<{ ssl: boolean; version: string }>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
    assert.equal(r.rows[0]!.ssl, true);
    assert.match(r.rows[0]!.version, /^TLSv1\.[23]$/);
  } finally { c.end(); }
});

// ---------------------------------------------------------------------------------- pool and tenancy

let db: TestDb;
let clinicA = '', clinicB = '';
before(async () => {
  db = await createTestDb();
  clinicA = (await seedClinic(db, 'pool-a', [{ username: 'owner-a', roles: ['OWNER'] }, { username: 'desk-a', roles: ['RECEPTIONIST'] }])).id;
  clinicB = (await seedClinic(db, 'pool-b', [{ username: 'owner-b', roles: ['OWNER'] }])).id;
});
after(async () => { await db.drop(); });

const withParam = (url: string, k: string, v: string) => { const u = new URL(url); u.searchParams.set(k, v); return u.toString(); };

test('T-POOL-1 40 concurrent requests for two clinics over 3 connections: every request sees only its own clinic', async () => {
  const d = new Db(db.appUrl, { max: 3 });
  try {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => {
      const clinic = i % 2 ? clinicA : clinicB;
      return d.tx(clinic, async tx => {
        const setting = (await tx.one<{ c: string }>("SELECT current_setting('app.clinic_id', true) AS c")).c;
        const staff = (await tx.query<{ clinic_id: string }>('SELECT clinic_id FROM staff')).rows;
        return { clinic, setting, staffClinics: [...new Set(staff.map(s => s.clinic_id))] };
      });
    }));
    for (const r of results) {
      assert.equal(r.setting, r.clinic);
      assert.deepEqual(r.staffClinics, [r.clinic]);
    }
    assert.ok(d.poolStats.total <= 3);
  } finally { await d.close(); }
});

test('T-POOL-2 the clinic context never survives on a reused connection', async () => {
  const d = new Db(db.appUrl, { max: 1 });
  try {
    const pidA = await d.tx(clinicA, async tx => (await tx.one<{ p: number }>('SELECT pg_backend_pid() AS p')).p);
    const after = await d.tx(null, async tx => ({
      pid: (await tx.one<{ p: number }>('SELECT pg_backend_pid() AS p')).p,
      setting: (await tx.one<{ c: string | null }>("SELECT current_setting('app.clinic_id', true) AS c")).c,
      staff: (await tx.query('SELECT id FROM staff')).rowCount,
    }));
    assert.equal(after.pid, pidA, 'same physical connection reused');
    assert.ok(after.setting === null || after.setting === '', `leaked setting ${after.setting}`);
    assert.equal(after.staff, 0, 'RLS returns nothing without clinic context');
  } finally { await d.close(); }
});

test('T-POOL-3 a failing request rolls back fully and the connection returns healthy', async () => {
  const d = new Db(db.appUrl, { max: 1 });
  try {
    await assert.rejects(d.tx(clinicA, async tx => {
      await tx.query('INSERT INTO patient_file_counters (clinic_id, next_no) VALUES ($1, 500) ON CONFLICT (clinic_id) DO UPDATE SET next_no = 500', [clinicA]);
      throw new Error('fictional failure after write');
    }), /fictional failure/);
    const n = await d.tx(clinicA, async tx => (await tx.maybeOne<{ next_no: number }>('SELECT next_no FROM patient_file_counters WHERE clinic_id = $1', [clinicA]))?.next_no ?? null);
    assert.notEqual(n, 500, 'write was rolled back');
    assert.deepEqual(d.poolStats, { total: 1, idle: 1, waiting: 0 });
    // SQL error mid-transaction (aborted transaction state) also rolls back and frees the connection.
    await assert.rejects(d.tx(clinicA, async tx => { await tx.query('SELECT 1/0'); }), (e: unknown) => e instanceof PgError && e.code === '22012');
    assert.equal(await d.tx(clinicA, async tx => (await tx.one<{ x: number }>('SELECT 1 AS x')).x), 1);
  } finally { await d.close(); }
});

test('T-POOL-4 server-side kill of a connection mid-transaction: request fails, broken connection is discarded, pool recovers', async () => {
  const d = new Db(db.appUrl, { max: 2 });
  const admin = await adminConn();
  try {
    await assert.rejects(d.tx(clinicA, async tx => {
      const pid = (await tx.one<{ p: number }>('SELECT pg_backend_pid() AS p')).p;
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await tx.query('SELECT 1');
    }));
    const ok = await Promise.all([1, 2, 3].map(() => d.tx(clinicB, async tx => (await tx.one<{ c: string }>("SELECT current_setting('app.clinic_id', true) AS c")).c)));
    assert.deepEqual(ok, [clinicB, clinicB, clinicB]);
    assert.ok(d.poolStats.total <= 2);
  } finally { admin.end(); await d.close(); }
});

test('T-POOL-5 pool exhaustion fails fast with an error instead of hanging forever', async () => {
  const d = new Db(db.appUrl, { max: 1, connectionTimeoutMs: 300 });
  let release!: () => void;
  const held = d.tx(clinicA, () => new Promise<void>(r => { release = r; }));
  try {
    await new Promise(r => setTimeout(r, 50));
    const t0 = Date.now();
    await assert.rejects(d.tx(clinicA, async () => 1), /timeout/i);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    release(); await held;
    assert.equal(await d.tx(clinicA, async () => 'free again'), 'free again');
    await d.close();
  }
});

test('T-POOL-6 server-side limits: a stalled transaction is ended by idle_in_transaction_session_timeout; a runaway statement by statement_timeout', async () => {
  const stalled = new Db(withParam(db.appUrl, 'idle_in_transaction_session_timeout', '200'), { max: 1 });
  try {
    await assert.rejects(stalled.tx(clinicA, async tx => {
      await tx.query('SELECT 1');
      await new Promise(r => setTimeout(r, 700));
      await tx.query('SELECT 1');
    }));
    assert.equal(await stalled.tx(clinicA, async tx => (await tx.one<{ x: number }>('SELECT 2 AS x')).x), 2, 'pool recovered');
  } finally { await stalled.close(); }
  const slow = new Db(withParam(db.appUrl, 'statement_timeout', '200'), { max: 1 });
  try {
    await assert.rejects(slow.tx(clinicA, async tx => { await tx.query('SELECT pg_sleep(2)'); }), (e: unknown) => e instanceof PgError && e.code === '57014');
  } finally { await slow.close(); }
  const defaults = new Db(db.appUrl, { max: 1 });
  try {
    const t = await defaults.tx(clinicA, async tx => tx.one<{ s: string; i: string }>("SELECT current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i"));
    assert.deepEqual(t, { s: '30s', i: '1min' }, 'API defaults applied');
  } finally { await defaults.close(); }
});

test('T-SECRET-1 a wrong database password produces an auth error that does not echo the password', async () => {
  const u = new URL(db.appUrl);
  u.password = 'fictional-wrong-password-xyz';
  const err = await tryConnect(u.toString());
  assert.ok(err instanceof PgError, err.message);
  assert.equal((err as PgError).code, '28P01');
  assert.ok(!err.message.includes('fictional-wrong-password-xyz'));
});

test('T-TYPES-1 type mapping kept from the previous client: int8 number, ISO timestamps, json parsed, other types text', async () => {
  const d = new Db(db.appUrl, { max: 1 });
  try {
    const r = await d.tx(null, async tx => tx.one<Record<string, unknown>>(`SELECT 9007199254740991::bigint AS big, '2026-10-28 10:00:00.123+01'::timestamptz AS ts,
        '{"a":[1,2]}'::jsonb AS j, true AS b, 1.5::float8 AS f, '2026-10-28'::date AS d, 12.345::numeric AS n, ARRAY['x','y'] AS arr`));
    assert.deepEqual(r, { big: 9007199254740991, ts: '2026-10-28T09:00:00.123Z', j: { a: [1, 2] }, b: true, f: 1.5, d: '2026-10-28', n: '12.345', arr: '{x,y}' });
    await assert.rejects(d.tx(null, async tx => tx.query('SELECT 9007199254740993::bigint AS x')), /safe integer/);
    const echo = await d.tx(null, async tx => tx.one<{ j: unknown; a: unknown }>('SELECT $1::jsonb AS j, $2::jsonb AS a', [{ k: 'v' }, [1, 2]]));
    assert.deepEqual(echo, { j: { k: 'v' }, a: [1, 2] }, 'objects and arrays are sent as JSON, not pg array literals');
  } finally { await d.close(); }
});

test('T-POOL-7 checking a pooled connection out and back in many times does not accumulate event listeners', async () => {
  const { PgPool } = await import('../src/platform/postgres.ts');
  const pool = new PgPool(parseDatabaseUrl(db.appUrl), { max: 1 });
  try {
    const counts: number[] = [];
    for (let i = 0; i < 25; i++) {
      const c = await pool.acquire();
      await c.query('SELECT 1');
      counts.push(c.poolClient!.listenerCount('error'));
      pool.release(c);
    }
    assert.equal(new Set(counts).size, 1, `error listeners grew across checkouts: ${counts.join(',')}`);
  } finally { await pool.end(); }
});
