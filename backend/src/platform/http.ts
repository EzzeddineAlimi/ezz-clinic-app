/*
 * HTTP layer (node:http, no framework). Responsibilities, in order, for every request:
 *  1. Host allow-list (DNS-rebinding guard, CH-019 T-ORG-2) and Origin allow-list (T-ORG-3).
 *  2. JSON-only bodies on writes (415 for text/plain etc., T-ORG-1), 64 KiB body cap. A route that declares
 *     binaryBody instead takes application/octet-stream up to its own cap (patient documents, R73-D).
 *  3. Bearer-token authentication -> server-derived Actor (body-supplied identity is ignored, T-CARE-4).
 *  4. Permission check against the single role matrix (403 + rate-limited denial counter).
 *  5. Optional step-up re-authentication for sensitive routes.
 *  6. One DB transaction per request, scoped to the actor's clinic (RLS), with idempotency in the
 *     same transaction for financial writes.
 *  7. Stable error envelope; no stack traces or patient data in responses or logs.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { AppError } from './errors.ts';
import type { Db, Tx } from './db.ts';
import { PgError } from './postgres.ts';

export type Role = 'OWNER' | 'DENTIST' | 'RECEPTIONIST' | 'ASSISTANT';

export interface Actor {
  staffId: string;
  clinicId: string;
  roles: Role[];
  displayName: string;
  tokenHash: string;
  reauthAt: string | null;
}

export interface Ctx {
  tx: Tx;
  actor: Actor | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  idempotencyKey: string | null;
  requestId: string;
  now: Date;
}

/** A file response (document download): always an attachment, never rendered by the API origin. */
export interface FileBody { bytes: Buffer; contentType: string; filename: string; sha256: string }
export interface Result { status: number; body: unknown; file?: FileBody }

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  /** Permission name from the role matrix; omitted = public (login only). */
  permission?: string;
  /** Require a password re-entry within REAUTH_WINDOW (sensitive owner operations). */
  reauth?: boolean;
  /** Require an Idempotency-Key header; replay returns the stored response. */
  idempotent?: boolean;
  /** false = run WITHOUT the per-request database transaction (ctx.tx is unusable). Only for public probes that must
   *  answer while the database is down (readiness); such a route manages its own connections. */
  transaction?: false;
  /** Accept application/octet-stream (ctx.body is a Buffer) up to maxBytes instead of a JSON body. */
  binaryBody?: { maxBytes: number };
  handler: (ctx: Ctx) => Promise<Result>;
}

export interface SecurityHooks {
  authenticate(db: Db, token: string): Promise<Actor | null>;
  can(actor: Actor, permission: string): boolean;
  recordDenial(db: Db, actor: Actor, permission: string): Promise<void>;
  reauthWindowMs: number;
  idempotency: {
    begin(tx: Tx, actor: Actor, key: string, route: string, body: unknown): Promise<Result | null>;
    complete(tx: Tx, actor: Actor, key: string, result: Result): Promise<void>;
  };
}

export interface AppConfig {
  allowedOrigins: string[];
  extraAllowedHosts: string[];
  log: (line: Record<string, unknown>) => void;
}

const MAX_BODY = 64 * 1024;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

function compile(path: string) {
  const names: string[] = [];
  const re = new RegExp('^' + path.replace(/:[a-zA-Z]+/g, m => { names.push(m.slice(1)); return '([0-9a-zA-Z_-]+)'; }) + '$');
  return { re, names };
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Length': Buffer.byteLength(data).toString(),
    ...extra,
  });
  res.end(data);
}

const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,100}$/;
function sendFile(res: http.ServerResponse, f: FileBody, requestId: string) {
  if (!SAFE_FILENAME.test(f.filename)) throw new AppError('INTERNAL', 'Unsafe download file name');
  res.writeHead(200, {
    'Content-Type': f.contentType,
    'Content-Disposition': `attachment; filename="${f.filename}"`,
    'Content-Length': f.bytes.length.toString(),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'X-Content-Sha256': f.sha256,
    'X-Request-Id': requestId,
  });
  res.end(f.bytes);
}

const errBody = (code: string, message: string, details?: unknown) => ({ error: { code, message, ...(details === undefined ? {} : { details }) } });

async function readRaw(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > max) throw new AppError('PAYLOAD_TOO_LARGE', 'Request body too large', { maxBytes: max });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new AppError('PAYLOAD_TOO_LARGE', 'Request body too large', { maxBytes: max });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = (await readRaw(req, MAX_BODY)).toString('utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new AppError('VALIDATION_FAILED', 'Malformed JSON'); }
}

/** Map database constraint failures to neutral, stable API errors (no SQL text leaked). */
function mapPgError(e: PgError): AppError {
  if (e.code === '23505') return new AppError('CONFLICT', 'Duplicate record', { constraint: e.constraint });
  if (e.code === '23514' || e.code === '22P02' || e.code === '23502' || e.code === '22003' || e.code === '22007' || e.code === '22008')
    return new AppError('VALIDATION_FAILED', 'Value rejected by database constraint', { constraint: e.constraint });
  if (e.code === '23503') return new AppError('NOT_FOUND', 'Referenced record not found in this clinic', { constraint: e.constraint });
  if (e.code === 'EZ001') return new AppError('CONFLICT', 'Operation not allowed on append-only record');
  if (e.code === '42501') return new AppError('FORBIDDEN_ROLE', 'Database privilege denied');
  return new AppError('INTERNAL', 'Internal error');
}

export function createServer(db: Db, routes: Route[], sec: SecurityHooks, cfg: AppConfig): http.Server {
  for (const r of routes) {
    // Idempotency replays compare JSON bodies; a binary route must be naturally idempotent (state-guarded) instead.
    if (r.binaryBody && (r.idempotent || r.method !== 'POST' || !r.permission)) throw new Error(`binaryBody route ${r.path} must be an authenticated, non-idempotent POST`);
    if (r.transaction === false && (r.permission || r.idempotent || r.method !== 'GET')) throw new Error(`transaction: false route ${r.path} must be a public GET probe`);
  }
  const compiled = routes.map(r => ({ r, ...compile(r.path) }));
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    let routeLabel = 'unmatched';
    let status = 500;
    try {
      const host = req.headers.host ?? '';
      if (!LOCAL_HOST.test(host) && !cfg.extraAllowedHosts.includes(host)) {
        throw new AppError('MISDIRECTED_HOST', 'Host not allowed');
      }
      const origin = req.headers.origin;
      if (origin !== undefined && !cfg.allowedOrigins.includes(origin)) {
        throw new AppError('FORBIDDEN_ORIGIN', 'Origin not allowed');
      }
      const url = new URL(req.url ?? '/', 'http://local');
      const method = req.method ?? 'GET';
      let match: { r: Route; params: Record<string, string> } | undefined;
      let pathMatched = false;
      for (const c of compiled) {
        const m = c.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (c.r.method !== method) continue;
        match = { r: c.r, params: Object.fromEntries(c.names.map((n, i) => [n, m[i + 1]!])) };
        break;
      }
      if (!match) {
        status = pathMatched ? 405 : 404;
        return send(res, status, errBody(pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', pathMatched ? 'Method not allowed' : 'Not found'));
      }
      const route = match.r;
      routeLabel = `${route.method} ${route.path}`;

      let body: unknown = {};
      if (method === 'POST') {
        const ct = (req.headers['content-type'] ?? '').toLowerCase();
        if (route.binaryBody) {
          if (ct.split(';')[0]!.trim() !== 'application/octet-stream') throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/octet-stream');
          // Read AFTER authentication and the permission check below: large bodies are never buffered for anonymous callers.
        } else {
          if (ct.split(';', 1)[0]!.trim() !== 'application/json') throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
          body = await readBody(req);
        }
      }

      let actor: Actor | null = null;
      if (route.permission) {
        const auth = req.headers.authorization ?? '';
        const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(auth);
        actor = m ? await sec.authenticate(db, m[1]!) : null;
        if (!actor) throw new AppError('UNAUTHENTICATED', 'Valid session required');
        if (!sec.can(actor, route.permission)) {
          await sec.recordDenial(db, actor, route.permission);
          throw new AppError('FORBIDDEN_ROLE', 'Your role cannot perform this action', { permission: route.permission });
        }
        if (route.reauth) {
          const ok = actor.reauthAt !== null && Date.now() - new Date(actor.reauthAt).getTime() <= sec.reauthWindowMs;
          if (!ok) throw new AppError('REAUTH_REQUIRED', 'Re-enter your password to continue');
        }
      }

      if (route.binaryBody) {
        const declared = Number(req.headers['content-length'] ?? NaN);
        if (declared > route.binaryBody.maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'Request body too large', { maxBytes: route.binaryBody.maxBytes });
        body = await readRaw(req, route.binaryBody.maxBytes);
      }

      let idemKey: string | null = null;
      if (route.idempotent) {
        const k = req.headers['idempotency-key'];
        if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(k)) {
          throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (16-100 chars [A-Za-z0-9_-]) is required');
        }
        idemKey = k;
      }

      const noTx = new Proxy({}, { get() { throw new Error(`route ${routeLabel} declared transaction: false but used ctx.tx`); } }) as Tx;
      const result = route.transaction === false
        ? await route.handler({ tx: noTx, actor, params: match!.params, query: url.searchParams, body, idempotencyKey: null, requestId, now: new Date() })
        : await db.tx(actor?.clinicId ?? null, async tx => {
        if (route.idempotent && actor && idemKey) {
          const prior = await sec.idempotency.begin(tx, actor, idemKey, routeLabel, { params: match!.params, body });
          if (prior) return prior;
        }
        const r = await route.handler({ tx, actor, params: match!.params, query: url.searchParams, body, idempotencyKey: idemKey, requestId, now: new Date() });
        if (route.idempotent && actor && idemKey) await sec.idempotency.complete(tx, actor, idemKey, r);
        return r;
      });
      status = result.status;
      if (result.file) return sendFile(res, result.file, requestId);
      return send(res, result.status, result.body, { 'X-Request-Id': requestId });
    } catch (e) {
      let err: AppError;
      if (e instanceof AppError) err = e;
      else if (e instanceof PgError) err = mapPgError(e);
      else err = new AppError('INTERNAL', 'Internal error');
      status = err.status;
      if (err.code === 'INTERNAL') cfg.log({ level: 'error', requestId, route: routeLabel, error: (e as Error).name, pgcode: (e as PgError).code });
      return send(res, err.status, errBody(err.code, err.message, err.details), { 'X-Request-Id': requestId });
    } finally {
      // Operational log: no bodies, no tokens, no patient fields (privacy rule OPS-LOG-1).
      cfg.log({ level: 'info', requestId, route: routeLabel, status, ms: Date.now() - started });
    }
  });
}
