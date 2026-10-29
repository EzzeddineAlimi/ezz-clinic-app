import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { adminConn, urlFor } from './helpers.ts';
import { migrate } from '../src/platform/migrate.ts';

test('T-SP1-MIG-1 concurrent runners apply a pending migration exactly once', async () => {
  const name = 'ezz_test_migration_' + randomBytes(5).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'ezz-migration-race-'));
  const admin = await adminConn();
  try {
    await admin.exec(`CREATE DATABASE ${name}`);
    const setup = await adminConn(name);
    try {
      await setup.exec('CREATE TABLE schema_migrations (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    } finally { setup.end(); }
    // Hold both runners after the ledger read, before the same CREATE TABLE.
    writeFileSync(join(dir, '0001_concurrent.sql'), 'SELECT pg_sleep(0.3); CREATE TABLE migration_race_fact (id integer PRIMARY KEY); INSERT INTO migration_race_fact VALUES (1);');
    const url = urlFor('postgres', new URL(process.env.EZZ_TEST_ADMIN_URL!).password, name);
    const results = await Promise.allSettled([migrate(url, dir), migrate(url, dir)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2, JSON.stringify(results.map(r => r.status === 'rejected' ? String(r.reason) : r.value)));
    const applied = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    assert.deepEqual(applied, ['0001_concurrent.sql']);
    const check = await adminConn(name);
    try {
      assert.equal((await check.query<{ n: number }>('SELECT count(*)::int AS n FROM migration_race_fact')).rows[0]!.n, 1);
      assert.equal((await check.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]!.n, 1);
    } finally { check.end(); }
  } finally {
    await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
