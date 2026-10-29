/*
 * R73 package G — API contract tests built from the ACTUAL endpoints.
 *   T-API-1  fictional workflows: every recorded example step (docs/api/examples) still answers with the same status and a
 *            compatible shape (keys/types may be ADDED, never removed or retyped). Re-record with EZZ_RECORD_EXAMPLES=1.
 *   T-API-2  docs/api/openapi.json and endpoints.md are exactly what the generator produces from the code.
 *   T-API-3  every documented route exists: unauthenticated calls get 401 (permissioned) or a non-404 answer (public).
 *   T-API-4  the documented role matrix is what the server enforces: for EVERY permissioned route and EVERY role,
 *            forbidden roles get 403 FORBIDDEN_ROLE naming that permission and allowed roles never do.
 *   T-API-5  OpenAPI sanity: unique operationIds, resolvable $refs, declared path parameters, known permissions.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb, startApi, seedClinic, STANDARD_STAFF, type Api, type TestDb } from './helpers.ts';
import { runWorkflows, normaliser, shapeOf, shapeBreaks, type Step } from './api-workflows.ts';
import { renderOpenApi, renderEndpointTable, EXAMPLES_DIR } from '../scripts/gen-openapi.ts';
import { buildRoutes } from '../src/app.ts';
import { PERMISSIONS } from '../src/modules/identity.ts';
import { REPO_DOCS_DIR } from '../src/platform/paths.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

const FILES = { receptionist: 'Receptionist (desk) workflow', dentist: 'Dentist workflow', owner: 'Owner workflow',
  'patient-facing': 'Patient-facing artefacts (there is no patient login; patients receive printed documents)',
  'security-states': 'Security-sensitive states the frontend must show as returned and never infer or override' } as const;

test('T-API-1 recorded fictional workflow examples: same statuses, compatible shapes', async () => {
  const raw = await runWorkflows(api, db);
  const n = normaliser();
  const steps = raw.map(s => ({ ...s, path: n.path(s.path), request: n.walk(s.request), response: n.walk(s.response) }) as Step);
  if (process.env.EZZ_RECORD_EXAMPLES === '1') {
    mkdirSync(EXAMPLES_DIR, { recursive: true });
    for (const [file, title] of Object.entries(FILES)) {
      const own = steps.filter(s => s.file === file);
      writeFileSync(join(EXAMPLES_DIR, `${file}.json`), JSON.stringify({ title, fictional: true,
        generatedBy: 'EZZ_RECORD_EXAMPLES=1 node --test test/r73-api-contract.test.ts (backend)', placeholders: '<id-n> = a UUID (same n = same entity), <timestamp> = ISO-8601 instant, <sha256> = 64 hex chars, <token> = session token',
        steps: own }, null, 2) + '\n');
    }
    return;
  }
  for (const file of Object.keys(FILES)) {
    const recorded = (JSON.parse(readFileSync(join(EXAMPLES_DIR, `${file}.json`), 'utf8')) as { steps: Step[] }).steps;
    const live = steps.filter(s => s.file === file);
    assert.deepEqual(live.map(s => `${s.method} ${s.route} -> ${s.status}`), recorded.map(s => `${s.method} ${s.route} -> ${s.status}`), `${file}: steps or statuses changed`);
    recorded.forEach((r, i) => {
      const breaks = shapeBreaks(shapeOf(r.response), shapeOf(live[i]!.response));
      assert.deepEqual(breaks, [], `${file} step "${r.title}" (${r.method} ${r.route}): breaking response change`);
    });
  }
});

test('T-API-2 openapi.json and endpoints.md are in sync with the route table, role matrix and examples', () => {
  assert.equal(readFileSync(join(REPO_DOCS_DIR, 'api', 'openapi.json'), 'utf8'), renderOpenApi(), 'run: node scripts/gen-openapi.ts');
  assert.equal(readFileSync(join(REPO_DOCS_DIR, 'api', 'endpoints.md'), 'utf8'), renderEndpointTable(), 'run: node scripts/gen-openapi.ts');
});

const DUMMY = '00000000-0000-4000-8000-000000000000';
const concrete = (path: string) => path.replace(/:([a-zA-Z]+)/g, DUMMY);
async function hit(method: string, path: string, token: string | undefined, binary: boolean) {
  const headers: Record<string, string> = { 'idempotency-key': 'contract_probe_' + Math.random().toString(36).slice(2, 14) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'POST') headers['content-type'] = binary ? 'application/octet-stream' : 'application/json';
  const r = await fetch(api.base + concrete(path), { method, headers, body: method === 'POST' ? (binary ? new Uint8Array([1, 2, 3]) : '{}') : undefined });
  const text = await r.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, body };
}

test('T-API-3 every route in the table is live: 401 without a session for protected routes, never 404/405', async () => {
  for (const r of buildRoutes({} as never)) {
    if (r.path === '/api/v1/session/login') continue; // probing login would count failed attempts
    const res = await hit(r.method, r.path, undefined, !!r.binaryBody);
    if (r.permission) assert.equal(res.status, 401, `${r.method} ${r.path}: ${res.status} ${JSON.stringify(res.body)}`);
    else assert.ok(![404, 405].includes(res.status), `${r.method} ${r.path}: ${res.status}`);
  }
});

test('T-API-4 the role matrix in the docs is what the server enforces, for every protected route and every role', async () => {
  await seedClinic(db, 'matrix-clinic', [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }]);
  const tokens: Record<string, string> = {};
  for (const [u, role] of [['owner', 'OWNER'], ['dentist', 'DENTIST'], ['desk', 'RECEPTIONIST'], ['assistant', 'ASSISTANT']] as const) tokens[role] = await api.login('matrix-clinic', u);
  let checked = 0;
  for (const r of buildRoutes({} as never)) {
    if (!r.permission || r.permission === 'session.self') continue; // session routes: every role, and probing would log out / count failures
    const allowed = PERMISSIONS[r.permission] ?? [];
    for (const role of ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT']) {
      const res = await hit(r.method, r.path, tokens[role], !!r.binaryBody);
      const deniedForPermission: boolean = res.status === 403 && res.body?.error?.code === 'FORBIDDEN_ROLE' && res.body?.error?.details?.permission === r.permission;
      if (allowed.includes(role as never)) assert.ok(!deniedForPermission, `${role} should pass the role gate of ${r.method} ${r.path} (${r.permission})`);
      else assert.ok(deniedForPermission, `${role} must be refused on ${r.method} ${r.path} (${r.permission}); got ${res.status} ${JSON.stringify(res.body)}`);
      checked++;
    }
  }
  assert.ok(checked >= 384, `${checked} role/route pairs checked`);
});

test('T-API-5 OpenAPI sanity: unique operation ids, resolvable refs, declared path params, known permissions', () => {
  const doc = JSON.parse(renderOpenApi());
  const ids = new Set<string>();
  const refs: string[] = [];
  const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === '$ref') refs.push(x as string); else walk(x); } };
  for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
    for (const op of Object.values(ops)) {
      assert.ok(!ids.has(op.operationId), `duplicate operationId ${op.operationId}`); ids.add(op.operationId);
      for (const m of path.matchAll(/\{([a-zA-Z]+)\}/g)) assert.ok((op.parameters ?? []).some((p: any) => p.name === m[1] && p.in === 'path'), `${path}: path param ${m[1]} not declared`);
      if (op['x-ezz-permission']) assert.ok(PERMISSIONS[op['x-ezz-permission']], `${path}: unknown permission`);
      assert.ok(Object.keys(op.responses).length > 0);
    }
  }
  walk(doc);
  for (const ref of refs) {
    const target = ref.replace('#/', '').split('/').reduce((o: any, k) => o?.[k], doc);
    assert.ok(target, `unresolved ${ref}`);
  }
  assert.equal(ids.size, buildRoutes({} as never).length);
});
