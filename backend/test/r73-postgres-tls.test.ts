/*
 * R73 package B — REAL PostgreSQL 16 over TLS with a locally generated, fictional test CA (no network, no real
 * certificates). Complements B05's fake-endpoint tests (T-TLS-1..4) and replaces the optional T-TLS-5 with a run that
 * needs no manual setup: a throwaway cluster with ssl=on is started by the test itself.
 * Skips (with the reason) only when the PostgreSQL server binaries or openssl are not installed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { startFreshPg, giveToServer, type FreshPg } from './fresh-pg.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';
import { migrate } from '../src/platform/migrate.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';
import { startApi, seedClinic, STANDARD_STAFF, type TestDb } from './helpers.ts';

const haveOpenssl = spawnSync('openssl', ['version']).status === 0;
let pg: FreshPg | null = null;
let skip: string | false = false;
let pki = '';

function ossl(args: string[], cwd: string) { execFileSync('openssl', args, { cwd, stdio: 'pipe' }); }
/** Fictional CA + server certificates with the given subjectAltName, signed by that CA. */
function makeCerts(dir: string) {
  ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=EZZ Fictional Test CA'], dir);
  ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other-ca.key', '-out', 'other-ca.crt', '-days', '2', '-subj', '/CN=EZZ Unrelated Fictional CA'], dir);
  for (const [name, san] of [['ip', 'IP:127.0.0.1'], ['wronghost', 'DNS:db.fictional.test']] as const) {
    ossl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`], dir);
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
    ossl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '2', '-extfile', `${name}.ext`], dir);
  }
}
async function tryConnect(url: string) {
  const c = new PgConnection(parseDatabaseUrl(url));
  try {
    await c.connect();
    const r = (await c.query<{ ssl: boolean; version: string }>('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]!;
    return { ok: true as const, ...r };
  } catch (e) { return { ok: false as const, error: (e as Error).message }; } finally { c.end(); }
}
async function useCert(name: 'ip' | 'wronghost') {
  const c = new PgConnection(parseDatabaseUrl(pg!.url('postgres', `sslmode=verify-full&sslrootcert=${join(pki, 'ca.crt')}`.replace('verify-full', 'verify-ca'))));
  await c.connect();
  try {
    await c.query(`ALTER SYSTEM SET ssl_cert_file = '${join(pg!.dir, 'data', name + '.crt')}'`);
    await c.query(`ALTER SYSTEM SET ssl_key_file = '${join(pg!.dir, 'data', name + '.key')}'`);
    await c.query('SELECT pg_reload_conf()');
  } finally { c.end(); }
  await new Promise(r => setTimeout(r, 300));
}

before(async () => {
  if (!haveOpenssl) { skip = 'openssl not installed'; return; }
  // Certificate paths go in postgresql.conf (not -c on the command line, which would override ALTER SYSTEM and make the
  // certificate swap in T-TLS-REAL-3 a silent no-op).
  pg = await startFreshPg({ ssl: 'on', ssl_min_protocol_version: 'TLSv1.2' }, dir => {
    pki = join(dir, 'pki');
    execFileSync('mkdir', ['-p', pki]);
    makeCerts(pki);
    for (const f of ['ip.crt', 'ip.key', 'wronghost.crt', 'wronghost.key']) { copyFileSync(join(pki, f), join(dir, 'data', f)); giveToServer(join(dir, 'data', f)); }
    appendFileSync(join(dir, 'data', 'postgresql.conf'), "\nssl_cert_file = 'ip.crt'\nssl_key_file = 'ip.key'\n");
  });
  if (!pg) skip = 'PostgreSQL server binaries (initdb/pg_ctl) not installed';
});
after(() => { pg?.stop(); });

test('T-TLS-REAL-1 verify-full with the pinned test CA: encrypted session to a real PostgreSQL 16 (pg_stat_ssl)', async t => {
  if (skip) return t.skip(skip);
  const r = await tryConnect(pg!.url('postgres', `sslmode=verify-full&sslrootcert=${join(pki, 'ca.crt')}`));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ssl, true);
  assert.match(r.version, /^TLSv1\.[23]$/);
});

test('T-TLS-REAL-2 a server certificate from an unrelated CA is rejected (no connection, no plaintext fallback)', async t => {
  if (skip) return t.skip(skip);
  const r = await tryConnect(pg!.url('postgres', `sslmode=verify-full&sslrootcert=${join(pki, 'other-ca.crt')}`));
  assert.equal(r.ok, false);
  assert.match(r.error, /self.signed|unable to verify|certificate/i);
});

test('T-TLS-REAL-3 a certificate for another host name: verify-full rejects, verify-ca accepts (the documented weakness, M-266 (1))', async t => {
  if (skip) return t.skip(skip);
  await useCert('wronghost');
  try {
    const full = await tryConnect(pg!.url('postgres', `sslmode=verify-full&sslrootcert=${join(pki, 'ca.crt')}`));
    assert.equal(full.ok, false, JSON.stringify(full));
    assert.match(full.error, /altnames|Hostname|IP: 127\.0\.0\.1/i);
    const ca = await tryConnect(pg!.url('postgres', `sslmode=verify-ca&sslrootcert=${join(pki, 'ca.crt')}`));
    assert.ok(ca.ok, JSON.stringify(ca));
    assert.equal(ca.ssl, true);
  } finally { await useCert('ip'); }
});

test('T-TLS-REAL-4 the whole application over verified TLS: migrate as owner, API as app role, login, every API connection encrypted', async t => {
  if (skip) return t.skip(skip);
  const tls = `sslmode=verify-full&sslrootcert=${join(pki, 'ca.crt')}`;
  const admin = new PgConnection(parseDatabaseUrl(pg!.url('postgres', tls)));
  await admin.connect();
  try {
    await admin.exec("CREATE ROLE ezz_owner LOGIN PASSWORD 'fictional-tls-owner-pw'");
    await admin.exec("CREATE ROLE ezz_app LOGIN PASSWORD 'fictional-tls-app-pw'");
    await admin.exec('CREATE DATABASE ezz_tls OWNER ezz_owner');
    await admin.exec('GRANT CONNECT ON DATABASE ezz_tls TO ezz_app');
  } finally { admin.end(); }
  const ownerUrl = `postgres://ezz_owner:fictional-tls-owner-pw@127.0.0.1:${pg!.port}/ezz_tls?${tls}`;
  const appUrl = `postgres://ezz_app:fictional-tls-app-pw@127.0.0.1:${pg!.port}/ezz_tls?${tls}`;
  assert.ok((await migrate(ownerUrl, MIGRATIONS_DIR)).length >= 10);
  const tdb = { name: 'ezz_tls', ownerUrl, appUrl, drop: async () => {} } as TestDb;
  await seedClinic(tdb, 'tls-clinic', STANDARD_STAFF);
  const api = await startApi(appUrl);
  try {
    const owner = await api.login('tls-clinic', 'owner');
    const me = await api.call('GET', '/api/v1/session', { token: owner });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    const ready = await api.call('GET', '/api/v1/health/ready');
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    const s = new PgConnection(parseDatabaseUrl(pg!.url('postgres', tls)));
    await s.connect();
    try {
      const r = (await s.query<{ n: number; plain: number }>("SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT ssl)::int AS plain FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE usename = 'ezz_app'")).rows[0]!;
      assert.ok(r.n >= 1, 'the API holds at least one pooled connection');
      assert.equal(r.plain, 0, 'no plaintext API connection');
    } finally { s.end(); }
  } finally { await api.close(); }
});
