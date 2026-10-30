/* SEC-HTTP: regression tests for API-origin hardening. No PostgreSQL or real patient data required. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type SecurityHooks } from '../src/platform/http.ts';
import type { Db, Tx } from '../src/platform/db.ts';

const security: SecurityHooks = {
  authenticate: async () => null,
  can: () => false,
  recordDenial: async () => {},
  reauthWindowMs: 0,
  idempotency: { begin: async () => null, complete: async () => {} },
};

/* The route deliberately has no permission, like the public login endpoint. */
test('SEC-HTTP-1 rejects JSON-like media types, supports valid JSON parameters, and applies privacy/security headers', async () => {
  const db = {
    tx: async (_clinicId: string | null, fn: (tx: Tx) => Promise<unknown>) => fn({} as Tx),
  } as unknown as Db;
  const logs: Array<Record<string, unknown>> = [];
  const server = createServer(db, [
    { method: 'POST', path: '/api/v1/public-echo', handler: async ({ body }) => ({ status: 200, body }) },
  ], security, { allowedOrigins: [], extraAllowedHosts: [], log: l => { logs.push(l); } });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}/api/v1/public-echo`;
    const request = (contentType: string) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: JSON.stringify({ marker: 'fictional' }),
    });

    for (const badType of [
      'application/jsonp',
      'application/json-seq',
      'application/jsonnotreally',
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=abc',
    ]) {
      const r = await request(badType);
      assert.equal(r.status, 415, badType);
      const body = await r.json() as { error: { code: string } };
      assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE', badType);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.match(r.headers.get('permissions-policy') ?? '', /camera=\(\)/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    for (const validType of ['application/json', 'application/json; charset=UTF-8']) {
      const r = await request(validType);
      assert.equal(r.status, 200, validType);
      assert.deepEqual(await r.json(), { marker: 'fictional' });
      assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.ok(r.headers.get('x-request-id'));
    }
    assert.ok(logs.every(row => !JSON.stringify(row).includes('fictional')), 'request bodies must never appear in operational logs');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
