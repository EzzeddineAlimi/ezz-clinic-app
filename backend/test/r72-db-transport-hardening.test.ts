/*
 * R72 / M-266 — B05 objections that need negative tests on the integrated candidate (fictional data only).
 *  (6) a pooled client returned with an open / failed transaction must never be handed to the next caller;
 *  (5) errors on idle pooled clients must be logged (code only, never credentials) instead of swallowed;
 *  (4) API error responses must not carry PostgreSQL detail (values) or table names;
 *  (3) no module may build its own pg client or pool outside the platform layer (also ARCH-6).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, startApi, standardFixture, adminConn, PASSWORD, type Api, type TestDb } from './helpers.ts';
import { PgPool, parseDatabaseUrl } from '../src/platform/postgres.ts';
import { SOURCE_DIR } from '../src/platform/paths.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

test('T-POOL-8 (RED before fix) a client released inside an open transaction is not reused with that transaction', async () => {
  const pool = new PgPool(parseDatabaseUrl(db.appUrl), { max: 1 });
  try {
    const c1 = await pool.acquire();
    await c1.query('BEGIN');
    await c1.query("SELECT set_config('app.clinic_id', '00000000-0000-0000-0000-000000000001', true)");
    pool.release(c1); // a raw caller forgot COMMIT/ROLLBACK
    const c2 = await pool.acquire();
    try {
      assert.equal(c2.poolClient!.getTransactionStatus(), 'I', 'next checkout must start idle, not inside the previous transaction');
      const s = (await c2.query<{ v: string | null }>("SELECT nullif(current_setting('app.clinic_id', true), '') AS v")).rows[0]!;
      assert.equal(s.v, null, 'no clinic context leaks to the next checkout');
    } finally { pool.release(c2); }
    // A failed transaction (status E) is treated the same way.
    const c3 = await pool.acquire();
    await c3.query('BEGIN');
    await c3.query('SELECT 1/0').catch(() => undefined);
    pool.release(c3);
    const c4 = await pool.acquire();
    try { assert.equal(c4.poolClient!.getTransactionStatus(), 'I'); } finally { pool.release(c4); }
  } finally { await pool.end(); }
});

test('T-POOL-9 (RED before fix) an error on an idle pooled client is logged with its code, never with credentials', async () => {
  const lines: Array<Record<string, unknown>> = [];
  const pool = new PgPool(parseDatabaseUrl(db.appUrl), { max: 1, log: l => { lines.push(l); } });
  try {
    const c = await pool.acquire();
    const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    pool.release(c); // now idle in the pool
    const a = await adminConn(db.name);
    try { await a.query('SELECT pg_terminate_backend($1)', [pid] as never[]); } finally { a.end(); }
    for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0]!.event, 'db_idle_client_error');
    assert.equal(lines[0]!.pgcode, '57P01');
    const raw = JSON.stringify(lines);
    assert.ok(!raw.includes(parseDatabaseUrl(db.appUrl).password ?? '\u0000') && !raw.includes('postgres://'), raw);
    // The pool recovers with a fresh connection.
    const c2 = await pool.acquire();
    try { assert.equal((await c2.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one, 1); } finally { pool.release(c2); }
  } finally { await pool.end(); }
});

test('T-ERR-2 constraint failures reach the client as neutral errors: no PostgreSQL detail, no values, no table name, no SQL', async () => {
  const f = await standardFixture(api, db, 'r72-err', { openCashPeriod: false });
  const r = await api.call('POST', '/api/v1/patients', { token: f.desk, body: { familyName: 'Fictif', givenName: 'Old', isSynthetic: true, dateOfBirth: '1899-12-31' } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const raw = JSON.stringify(r.body);
  for (const leak of ['1899-12-31', 'Key (', 'DETAIL', '"detail"', '"table"', 'SELECT', 'INSERT', 'violates']) assert.ok(!raw.includes(leak), `leaked ${leak}: ${raw}`);
  assert.ok(!raw.includes(PASSWORD));
});

test('T-ARCH-6 only the platform layer talks to the pg driver; only Db builds a pool', () => {
  const SRC = SOURCE_DIR;
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && files.push(join(d, e.name)); };
  walk(SRC);
  for (const f of files) {
    const rel = f.slice(SRC.length + 1);
    const text = readFileSync(f, 'utf8');
    if (rel !== 'platform/postgres.ts') assert.ok(!/from 'pg'|require\('pg'\)/.test(text), `${rel} imports pg directly`);
    if (rel !== 'platform/db.ts' && rel !== 'platform/postgres.ts') assert.ok(!/new PgPool\(/.test(text), `${rel} builds its own pool`);
  }
});
