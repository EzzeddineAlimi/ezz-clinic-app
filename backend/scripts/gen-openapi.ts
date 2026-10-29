/*
 * R73-G: machine-readable API description generated from the ACTUAL route table (src/app.ts buildRoutes), the role
 * matrix (identity.ts PERMISSIONS), the error codes (platform/errors.ts) and the recorded fictional examples
 * (docs/api/examples/*.json). Request/response schemas are inferred from those recorded examples, so they describe
 * what the API really returned, not what someone believes it returns. Routes without a recorded example get a
 * generic object schema and are marked x-ezz-example: false.
 *
 *   node scripts/gen-openapi.ts            # writes docs/api/openapi.json and docs/api/endpoints.md
 * test/r73-api-contract.test.ts fails when either file drifts from the code.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoutes } from '../src/app.ts';
import { PERMISSIONS } from '../src/modules/identity.ts';
import { ErrorCodes } from '../src/platform/errors.ts';
import { REPO_DOCS_DIR } from '../src/platform/paths.ts';
import type { Route } from '../src/platform/http.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface ExampleStep { file: string; title: string; role: string; method: string; route: string; path: string; request: Json; status: number; response: Json }

export const EXAMPLES_DIR = join(REPO_DOCS_DIR, 'api', 'examples');

export function loadExamples(): ExampleStep[] {
  if (!existsSync(EXAMPLES_DIR)) return [];
  return readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.json')).sort()
    .flatMap(f => (JSON.parse(readFileSync(join(EXAMPLES_DIR, f), 'utf8')) as { steps: ExampleStep[] }).steps);
}

/** JSON Schema inferred from one or more observed values (union of object keys; placeholders become formats). */
function infer(values: Json[]): Record<string, unknown> {
  const present = values.filter(v => v !== undefined);
  const types = new Set(present.map(v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)));
  const nullable = types.delete('null');
  const one = (t: string): Record<string, unknown> => {
    const vs = present.filter(v => v !== null && (Array.isArray(v) ? 'array' : typeof v) === t);
    if (t === 'object') {
      const keys = [...new Set(vs.flatMap(v => Object.keys(v as object)))].sort();
      return { type: 'object', properties: Object.fromEntries(keys.map(k => [k, infer(vs.map(v => (v as Record<string, Json>)[k]!).filter(x => x !== undefined))])) };
    }
    if (t === 'array') { const items = vs.flatMap(v => v as Json[]); return items.length ? { type: 'array', items: infer(items) } : { type: 'array' }; }
    if (t === 'string') {
      const s = vs as string[];
      if (s.every(x => /^<id-\d+>$/.test(x))) return { type: 'string', format: 'uuid' };
      if (s.every(x => x === '<timestamp>')) return { type: 'string', format: 'date-time' };
      if (s.every(x => x === '<sha256>')) return { type: 'string', pattern: '^[0-9a-f]{64}$' };
      if (s.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x))) return { type: 'string', format: 'date' };
      return { type: 'string' };
    }
    if (t === 'number') return { type: (vs as number[]).every(Number.isInteger) ? 'integer' : 'number' };
    return { type: t };
  };
  const list = [...types];
  if (!list.length) return nullable ? { type: 'null' } : {};
  const schemas = list.map(one);
  const base = schemas.length === 1 ? schemas[0]! : { oneOf: schemas };
  return nullable ? (schemas.length === 1 ? { ...base, type: [base.type, 'null'] } : { oneOf: [...schemas, { type: 'null' }] }) : base;
}

const opId = (r: Route) => (r.method.toLowerCase() + r.path.replace('/api/v1', '').replace(/:([a-zA-Z]+)/g, 'By_$1').replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')));
const oaPath = (p: string) => p.replace(/:([a-zA-Z]+)/g, '{$1}');
const tag = (p: string) => p.split('/')[3] ?? 'root';
const ERROR_STATUSES = (r: Route) => {
  const s = new Set<number>([400, 404, 409]);
  if (r.permission) { s.add(401); s.add(403); }
  if (r.method === 'POST') { s.add(413); s.add(415); }
  return [...s].sort();
};

export function renderOpenApi(): string {
  const routes = buildRoutes({} as never);
  const examples = loadExamples();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const ex = examples.filter(e => e.method === r.method && e.route === r.path);
    const params: unknown[] = [...r.path.matchAll(/:([a-zA-Z]+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }));
    const queryNames = [...new Set(ex.flatMap(e => [...new URL(e.path, 'http://x').searchParams.keys()]))].sort();
    for (const q of queryNames) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' }, 'x-ezz-observed-in-examples': true });
    if (r.idempotent) params.push({ $ref: '#/components/parameters/IdempotencyKey' });
    const responses: Record<string, unknown> = {};
    for (const status of [...new Set(ex.map(e => e.status))].sort()) {
      const sample = ex.filter(e => e.status === status);
      const isError = status >= 400;
      responses[String(status)] = { description: sample.map(s => s.title).filter((t, i, a) => a.indexOf(t) === i).join(' / '),
        content: { 'application/json': { schema: isError ? { $ref: '#/components/schemas/Error' } : infer(sample.map(s => s.response)), example: sample[0]!.response } } };
    }
    if (r.path.endsWith('/documents/:id/content') && r.method === 'GET') responses['200'] = { description: 'The document bytes as an attachment (verified SHA-256 in X-Content-Sha256)', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    if (!Object.keys(responses).some(k => k.startsWith('2'))) responses[r.method === 'POST' ? '200' : '200'] = { description: 'Success (no recorded example yet)', content: { 'application/json': { schema: { type: 'object' } } } };
    for (const s of ERROR_STATUSES(r)) responses[String(s)] ??= { $ref: '#/components/responses/Error' };
    if (r.path === '/api/v1/health/ready') responses['503'] = { description: 'Not ready: database unreachable or schema not exactly what this code expects', content: { 'application/json': { schema: { type: 'object' } } } };
    const okReq = ex.filter(e => e.status < 400 && e.request !== null && typeof e.request === 'object');
    const op: Record<string, unknown> = {
      operationId: opId(r), tags: [tag(r.path)], summary: ex[0]?.title ?? `${r.method} ${r.path}`,
      ...(params.length ? { parameters: params } : {}),
      ...(r.method === 'POST' ? { requestBody: r.binaryBody
        ? { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary', maxLength: r.binaryBody.maxBytes } } } }
        : { required: false, content: { 'application/json': { schema: okReq.length ? infer(okReq.map(e => e.request)) : { type: 'object' }, ...(okReq[0] ? { example: okReq[0].request } : {}) } } } } : {}),
      responses,
      security: r.permission ? [{ bearer: [] }] : [],
      'x-ezz-permission': r.permission ?? null,
      'x-ezz-roles': r.permission ? [...(PERMISSIONS[r.permission] ?? [])] : 'PUBLIC',
      'x-ezz-reauth': !!r.reauth,
      'x-ezz-idempotency-key': r.idempotent ? 'required' : 'none',
      'x-ezz-example': ex.length > 0,
    };
    (paths[oaPath(r.path)] ??= {})[r.method.toLowerCase()] = op;
  }
  const doc = {
    openapi: '3.1.0',
    info: { title: 'EZZ Clinic API (fictional-data build)', version: '0.2.0-r73',
      description: 'Generated from the code by backend/scripts/gen-openapi.ts. FICTIONAL DATA ONLY; not a production API. Schemas are inferred from recorded fictional examples (docs/api/examples). Money is integer millimes. Read docs/api/frontend-security-states.md before building screens.' },
    servers: [{ url: 'http://127.0.0.1:4180', description: 'local development (loopback only)' }],
    tags: [...new Set(routes.map(r => tag(r.path)))].sort().map(name => ({ name })),
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Token from POST /api/v1/session/login; sessions expire on idle. Role and clinic come only from the session.' } },
      parameters: { IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' },
        description: 'One key per user intent (create it when the form opens, not per click). A replay returns the stored response; the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED.' } },
      schemas: { Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: {
        code: { type: 'string', enum: Object.keys(ErrorCodes).sort() }, message: { type: 'string', description: 'Neutral text, never patient data; do not parse it' }, details: { type: 'object' } } } } } },
      responses: { Error: { description: 'Stable error envelope; see x-ezz-error-codes for code -> HTTP status', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
    'x-ezz-error-codes': Object.fromEntries(Object.entries(ErrorCodes).sort(([a], [b]) => a.localeCompare(b))),
    'x-ezz-roles': ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

export function renderEndpointTable(): string {
  const routes = buildRoutes({} as never);
  const examples = loadExamples();
  const lines = [
    '# EZZ Clinic API — endpoint table (generated)', '',
    'Generated by `backend/scripts/gen-openapi.ts` from the route table; `test/r73-api-contract.test.ts` fails if it drifts. Machine-readable: [`openapi.json`](openapi.json). Fictional data only.', '',
    `${routes.length} routes. Example = a recorded fictional request/response exists in [examples/](examples/).`, '',
    '| Method | Path | Permission | Roles | Re-auth | Idempotency-Key | Example |', '|---|---|---|---|:-:|:-:|:-:|',
  ];
  for (const r of routes) {
    const ex = examples.some(e => e.method === r.method && e.route === r.path);
    lines.push(`| ${r.method} | \`${r.path}\` | ${r.permission ? `\`${r.permission}\`` : 'public'} | ${r.permission ? (PERMISSIONS[r.permission] ?? []).join(', ') : '—'} | ${r.reauth ? 'yes' : '—'} | ${r.idempotent ? 'required' : r.binaryBody ? 'no (state-guarded)' : '—'} | ${ex ? 'yes' : '—'} |`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1]?.endsWith('gen-openapi.ts') || process.argv[1]?.endsWith('gen-openapi.js')) {
  writeFileSync(join(REPO_DOCS_DIR, 'api', 'openapi.json'), renderOpenApi());
  writeFileSync(join(REPO_DOCS_DIR, 'api', 'endpoints.md'), renderEndpointTable());
  process.stdout.write('wrote docs/api/openapi.json and docs/api/endpoints.md\n');
}
