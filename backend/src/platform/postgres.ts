/*
 * PostgreSQL access over node-postgres (`pg`, pinned in package.json / package-lock.json with integrity
 * hashes). Replaces the temporary TLS-less wire client of ADR-0004 (issue #4, ENG-01) while keeping the
 * exact API the rest of the code uses (PgConnection, PgPool, PgError, parseDatabaseUrl), so module code,
 * tests and stacked branches need no change.
 *
 * Transport security policy (enforced in parseDatabaseUrl, before any socket is opened):
 *  - remote hosts MUST use TLS with certificate validation: sslmode=verify-full (default) or verify-ca;
 *    disable / allow / prefer / require / no-verify are refused, so there is no silent plaintext or
 *    unverified fallback;
 *  - loopback hosts and Unix sockets (local development, CI service containers) default to disable and may
 *    opt in to any mode; this is the only exemption;
 *  - sslrootcert=<path> pins the CA bundle; otherwise Node's default trust store is used.
 * Behaviour kept from the previous client: values are always sent as parameters (never interpolated);
 * int8 -> number with a safe-integer guard; timestamptz/timestamp -> ISO-8601 string (ms); json/jsonb ->
 * parsed; bool; int2/int4/float -> number; every other type stays text (dates, numerics, arrays).
 * Credentials never appear in thrown messages.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

export type PgValue = string | number | boolean | null | bigint | object | Date | undefined;
export type Row = Record<string, unknown>;
export interface QueryResult<R = Row> { rows: R[]; rowCount: number; command: string }

export class PgError extends Error {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
  constructor(f: { message?: string; code?: string; constraint?: string; detail?: string; table?: string }) {
    super(f.message ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = f.code ?? 'XX000';
    this.constraint = f.constraint;
    this.detail = f.detail;
    this.table = f.table;
  }
}

export class InsecureDatabaseConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'InsecureDatabaseConfigError'; }
}

export type SslMode = 'disable' | 'require' | 'verify-ca' | 'verify-full';

export interface ConnConfig {
  host: string; // hostname, or a directory containing the Unix socket
  port: number;
  user: string;
  password?: string;
  database: string;
  applicationName?: string;
  sslMode: SslMode;
  sslRootCert?: string; // path to a PEM CA bundle
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLocalHost = (host: string) => host.startsWith('/') || LOOPBACK.has(host.toLowerCase());

export function parseDatabaseUrl(url: string): ConnConfig {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('DATABASE_URL is not a valid URL'); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('DATABASE_URL must be postgres://');
  const hostParam = u.searchParams.get('host');
  const host = hostParam ?? (u.hostname || 'localhost');
  const local = isLocalHost(host);
  const requested = (u.searchParams.get('sslmode') ?? (local ? 'disable' : 'verify-full')).toLowerCase();
  const known = ['disable', 'allow', 'prefer', 'require', 'no-verify', 'verify-ca', 'verify-full'];
  if (!known.includes(requested)) throw new InsecureDatabaseConfigError(`Unknown sslmode '${requested}'`);
  if (requested === 'allow' || requested === 'prefer') {
    throw new InsecureDatabaseConfigError(`sslmode=${requested} may silently fall back to plaintext; use verify-full (or disable on a local host)`);
  }
  if (!local && requested !== 'verify-full' && requested !== 'verify-ca') {
    throw new InsecureDatabaseConfigError(`Remote PostgreSQL host requires sslmode=verify-full or verify-ca (got ${requested}); plaintext or unverified TLS is refused`);
  }
  const sslMode: SslMode = requested === 'no-verify' ? 'require' : requested as SslMode;
  const num = (k: string) => { const v = u.searchParams.get(k); return v === null ? undefined : Number(v); };
  return {
    host,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
    applicationName: u.searchParams.get('application_name') ?? 'ezz-clinic-backend',
    sslMode,
    sslRootCert: u.searchParams.get('sslrootcert') ?? undefined,
    statementTimeoutMs: num('statement_timeout'),
    idleInTransactionTimeoutMs: num('idle_in_transaction_session_timeout'),
  };
}

function tlsOptions(cfg: ConnConfig): pg.ClientConfig['ssl'] {
  if (cfg.sslMode === 'disable') return false;
  if (cfg.sslMode === 'require') return { rejectUnauthorized: false }; // loopback only (enforced above)
  const ca = cfg.sslRootCert ? readFileSync(cfg.sslRootCert, 'utf8') : undefined;
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    ...(cfg.sslMode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
  };
}

const OID = { bool: 16, int8: 20, int2: 21, int4: 23, json: 114, jsonb: 3802, timestamp: 1114, timestamptz: 1184, float4: 700, float8: 701 } as const;
const raw = (v: string) => v;
function textParser(oid: number): (v: string) => unknown {
  switch (oid) {
    case OID.bool: return v => v === 't';
    case OID.int2: case OID.int4: case OID.float4: case OID.float8: return v => Number(v);
    case OID.int8: return v => {
      const n = Number(v);
      if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds JS safe integer range`);
      return n;
    };
    case OID.json: case OID.jsonb: return v => JSON.parse(v);
    case OID.timestamptz: case OID.timestamp: return v => {
      let s = v.replace(' ', 'T');
      if (/[+-]\d\d$/.test(s)) s += ':00';
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? v : d.toISOString();
    };
    default: return raw;
  }
}
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => (format === 'binary' ? raw : textParser(oid))) as pg.CustomTypesConfig['getTypeParser'],
};

/** Same serialisation as the previous client: objects/arrays as JSON text, never pg array literals. */
function serializeParam(v: PgValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Non-finite number parameter');
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function clientConfig(cfg: ConnConfig): pg.ClientConfig {
  return {
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    application_name: cfg.applicationName, ssl: tlsOptions(cfg), types,
    ...(cfg.statementTimeoutMs !== undefined ? { statement_timeout: cfg.statementTimeoutMs } : {}),
    ...(cfg.idleInTransactionTimeoutMs !== undefined ? { idle_in_transaction_session_timeout: cfg.idleInTransactionTimeoutMs } : {}),
  };
}

function toPgError(e: unknown): unknown {
  if (e instanceof pg.DatabaseError) return new PgError({ message: e.message, code: e.code, constraint: e.constraint, detail: e.detail, table: e.table });
  return e;
}

function toResult<R>(r: pg.QueryResult): QueryResult<R> {
  return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length, command: r.command ?? '' };
}

type PgClientLike = pg.Client | pg.PoolClient;

export class PgConnection {
  dead = false;
  released = false;
  private client: PgClientLike;
  private owned: boolean;

  constructor(cfgOrClient: ConnConfig | pg.PoolClient) {
    if ('sslMode' in cfgOrClient) {
      this.client = new pg.Client(clientConfig(cfgOrClient));
      this.owned = true;
    } else {
      this.client = cfgOrClient;
      this.owned = false;
    }
    // A client whose server goes away emits 'error'; without a listener Node would crash. For a pool client
    // the listener lives only while it is checked out (detached on release), so reuse never accumulates them.
    this.client.on('error', this.onError);
  }

  private onError = () => { this.dead = true; };

  /** Remove this wrapper's listener before the pool client goes back to the pool. */
  detach() { this.client.removeListener('error', this.onError); }

  async connect(): Promise<void> {
    if (!this.owned) return;
    try { await (this.client as pg.Client).connect(); } catch (e) { this.dead = true; throw toPgError(e); }
  }

  /** Parameterised query (extended protocol). Values are never interpolated into SQL text. */
  async query<R = Row>(sql: string, params: PgValue[] = []): Promise<QueryResult<R>> {
    try {
      return toResult<R>(await this.client.query({ text: sql, values: params.map(serializeParam) }));
    } catch (e) { throw toPgError(e); }
  }

  /** Simple query protocol: multiple statements, no parameters. Use ONLY for trusted migration files. */
  async exec(sql: string): Promise<QueryResult[]> {
    try {
      const r = await this.client.query(sql) as unknown as pg.QueryResult | pg.QueryResult[];
      return (Array.isArray(r) ? r : [r]).map(x => toResult(x));
    } catch (e) { throw toPgError(e); }
  }

  /** Underlying pool client, for PgPool.release only. */
  get poolClient(): pg.PoolClient | null { return this.owned ? null : this.client as pg.PoolClient; }

  end() {
    if (!this.owned || this.dead && this.released) return;
    this.dead = true;
    this.released = true;
    (this.client as pg.Client).end().catch(() => undefined);
  }
}

export interface PoolOptions {
  max?: number; connectionTimeoutMs?: number; idleTimeoutMs?: number;
  /** Receives idle-client errors (code only, never credentials or SQL). */
  log?: (line: Record<string, unknown>) => void;
}

/** Connection pool (pg.Pool). acquire() waits at most connectionTimeoutMs, then fails instead of hanging. */
export class PgPool {
  private pool: pg.Pool;
  constructor(cfg: ConnConfig, opts: number | PoolOptions = 8) {
    const o = typeof opts === 'number' ? { max: opts } : opts;
    this.pool = new pg.Pool({
      ...clientConfig(cfg),
      max: o.max ?? 8,
      connectionTimeoutMillis: o.connectionTimeoutMs ?? 10_000,
      idleTimeoutMillis: o.idleTimeoutMs ?? 30_000,
    });
    // Errors on idle clients (server restart, admin terminate) remove the client; never crash the process.
    // R72 / M-266 (5): log them with the SQLSTATE only, never the message (it may echo connection details).
    const log = o.log;
    this.pool.on('error', e => { log?.({ level: 'warn', event: 'db_idle_client_error', pgcode: (e as { code?: string }).code ?? null }); });
  }

  async acquire(): Promise<PgConnection> {
    try { return new PgConnection(await this.pool.connect()); } catch (e) { throw toPgError(e); }
  }

  /** destroy=true discards the connection (e.g. ROLLBACK failed) instead of returning it to the pool. */
  release(c: PgConnection, destroy = false) {
    const pc = c.poolClient;
    if (!pc || c.released) return; // double release is a no-op
    c.released = true;
    c.detach();
    // R72 / M-266 (6): a client still inside a transaction (status T) or a failed one (E) is never reused, so a raw
    // caller that forgot COMMIT/ROLLBACK cannot hand its transaction or SET LOCAL context to the next checkout.
    const tx = pc.getTransactionStatus();
    const unsafe = tx === 'T' || tx === 'E';
    pc.release(destroy || c.dead || unsafe ? true : undefined); // a broken or mid-transaction client is discarded
  }

  get stats() { return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount }; }

  async end() { await this.pool.end(); }
}
