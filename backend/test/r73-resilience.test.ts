/*
 * R73 package F — PostgreSQL itself dies (immediate shutdown = crash, no checkpoint) in the middle of a payment burst.
 * The SAME API process must: answer errors instead of hanging, report not-ready, recover by itself when the database
 * returns (pooled connections broken by the crash are discarded), lose no acknowledged payment, and turn every retry
 * of an unanswered request into exactly one payment. Runs on its own throwaway PostgreSQL 16 cluster (test/fresh-pg.ts).
 * Fictional data only. Skips, with the reason, when the PostgreSQL server binaries are not installed.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFreshPg, pgBin, pgCmd, type FreshPg } from './fresh-pg.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';
import { migrate } from '../src/platform/migrate.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';
import { startApi, seedClinic, STANDARD_STAFF, confirmCare, newVisit, type TestDb, type Api } from './helpers.ts';

let pg: FreshPg | null = null;
before(async () => { pg = await startFreshPg(); });
after(() => { pg?.stop(); });

async function superQuery<R>(sql: string, db = 'ezz_res'): Promise<R[]> {
  const c = new PgConnection(parseDatabaseUrl(pg!.url(db)));
  await c.connect();
  try { return (await c.query(sql)).rows as R[]; } finally { c.end(); }
}
const pgCtl = (args: string[]) => pgCmd(pgBin()!, 'pg_ctl', ['-D', join(pg!.dir, 'data'), ...args]);

test('T-RES-1 PostgreSQL crash mid-burst: errors not hangs, self-recovery without an API restart, nothing acknowledged lost, retries never duplicate', async t => {
  if (!pg) return t.skip('PostgreSQL server binaries (initdb/pg_ctl) not installed');
  const admin = new PgConnection(parseDatabaseUrl(pg.url('postgres')));
  await admin.connect();
  try {
    await admin.exec("CREATE ROLE ezz_owner LOGIN PASSWORD 'fictional-res-owner-pw'");
    await admin.exec("CREATE ROLE ezz_app LOGIN PASSWORD 'fictional-res-app-pw'");
    await admin.exec('CREATE DATABASE ezz_res OWNER ezz_owner');
    await admin.exec('GRANT CONNECT ON DATABASE ezz_res TO ezz_app');
  } finally { admin.end(); }
  const ownerUrl = `postgres://ezz_owner:fictional-res-owner-pw@127.0.0.1:${pg.port}/ezz_res`;
  const appUrl = `postgres://ezz_app:fictional-res-app-pw@127.0.0.1:${pg.port}/ezz_res`;
  await migrate(ownerUrl, MIGRATIONS_DIR);
  await seedClinic({ name: 'ezz_res', ownerUrl, appUrl, drop: async () => {} } as TestDb, 'res-clinic', STANDARD_STAFF);
  const api: Api = await startApi(appUrl);
  try {
    const owner = await api.login('res-clinic', 'owner'); const dentist = await api.login('res-clinic', 'dentist'); const desk = await api.login('res-clinic', 'desk');
    assert.equal((await api.call('POST', '/api/v1/cash/periods', { token: owner, body: { openingFloatMillimes: 0 } })).status, 201);
    const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictif', givenName: 'Crash', isSynthetic: true } });
    const visits: string[] = [];
    for (let i = 0; i < 8; i++) { const v = await newVisit(api, desk, p.body.patient.id, `2026-10-2${i % 8}T08:00:00Z`); await confirmCare(api, dentist, v, 500_000); visits.push(v); }

    const keys = Array.from({ length: 120 }, (_, i) => `res_${i}_${Date.now()}`);
    const pay = (i: number) => api.call('POST', `/api/v1/visits/${visits[i % visits.length]}/payments`, { token: desk, idem: keys[i], body: { amountMillimes: 1_000 + i, tender: 'CASH' } })
      .catch((e: Error) => ({ status: -1, body: e.message, headers: new Headers() }));
    let done = 0;
    const results: Array<{ status: number }> = new Array(keys.length);
    const burst = (async () => { for (let i = 0; i < keys.length; i += 4) await Promise.all([0, 1, 2, 3].map(async j => { if (i + j < keys.length) { results[i + j] = await pay(i + j); done++; } })); })();
    while (done < 40) await new Promise(r => setTimeout(r, 2));
    pgCtl(['-m', 'immediate', 'stop']); // crash: no shutdown checkpoint, WAL recovery on next start
    const t0 = Date.now();
    await burst;
    assert.ok(Date.now() - t0 < 30_000, 'requests during the outage fail fast instead of hanging');
    const acked = keys.filter((_, i) => results[i]!.status === 201);
    const failed = keys.filter((_, i) => results[i]!.status !== 201);
    assert.ok(failed.length > 0, 'the outage was hit mid-burst');
    assert.ok(failed.every(k => [500, 503, -1].includes(results[keys.indexOf(k)]!.status)), `outage answers: ${[...new Set(failed.map(k => results[keys.indexOf(k)]!.status))]}`);
    const down = await api.call('GET', '/api/v1/health/ready');
    assert.equal(down.status, 503, 'readiness reports the outage');

    pgCtl(['-o', `-p ${pg.port} -k ${pg.dir} -c listen_addresses=127.0.0.1`, '-w', '-l', join(pg.dir, 'log'), 'start']);
    let ready = 0;
    for (let i = 0; i < 50 && ready !== 200; i++) { ready = (await api.call('GET', '/api/v1/health/ready')).status; if (ready !== 200) await new Promise(r => setTimeout(r, 200)); }
    assert.equal(ready, 200, 'the same API process recovers without a restart');

    const committed = new Set((await superQuery<{ key: string }>("SELECT key FROM idempotency_records WHERE key LIKE 'res\\_%' AND response_status = 201")).map(r => r.key));
    assert.deepEqual(acked.filter(k => !committed.has(k)), [], 'every acknowledged payment survived the crash');
    for (const k of failed) {
      const r = await api.call('POST', `/api/v1/visits/${visits[keys.indexOf(k) % visits.length]}/payments`, { token: desk, idem: k, body: { amountMillimes: 1_000 + keys.indexOf(k), tender: 'CASH' } });
      assert.ok(r.status === 201 || r.status === 200, `retry of ${k}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const rows = (await superQuery<{ payments: number; receipts: number; mx: number; keys: number }>(
      "SELECT (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM receipts)::int AS receipts, (SELECT max(number) FROM receipts)::int AS mx, (SELECT count(*) FROM idempotency_records WHERE key LIKE 'res\\_%')::int AS keys"))[0]!;
    assert.equal(rows.payments, keys.length, 'exactly one payment per idempotency key after crash + retries');
    assert.deepEqual([rows.receipts, rows.mx], [keys.length, keys.length], 'receipt numbers contiguous after crash recovery');
    const integ = await api.call('POST', '/api/v1/integrity/check', { token: owner, body: {}, idem: false });
    assert.equal(integ.status, 200);
    assert.deepEqual(integ.body.findings, [], 'audit chain and business values intact after WAL recovery');
  } finally { await api.close(); }
});
