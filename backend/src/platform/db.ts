/*
 * Database access boundary. Module code depends only on `Tx` and `Db`, never on the driver
 * (node-postgres since issue #4; TLS policy in postgres.ts).
 *
 * Transaction contract:
 *  - every request that touches tenant data runs inside ONE transaction;
 *  - `SET LOCAL app.clinic_id` is applied first, so PostgreSQL RLS filters every statement;
 *  - financial writes take explicit row locks (SELECT ... FOR UPDATE) on the aggregate they change
 *    (visit, receipt counter, audit head, cash period) to serialise concurrent requests;
 *  - any thrown error rolls the whole transaction back (payment + receipt + audit + idempotency together).
 */
import { PgPool, PgConnection, PgError, parseDatabaseUrl, type PgValue, type QueryResult, type Row, type PoolOptions } from './postgres.ts';

// API defaults (overridable per URL): a request must not hold a transaction or run a statement forever.
const API_STATEMENT_TIMEOUT_MS = 30_000;
const API_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export interface Tx {
  query<R = Row>(sql: string, params?: PgValue[]): Promise<QueryResult<R>>;
  one<R = Row>(sql: string, params?: PgValue[]): Promise<R>;
  maybeOne<R = Row>(sql: string, params?: PgValue[]): Promise<R | undefined>;
  readonly clinicId: string | null;
}

function wrap(conn: PgConnection, clinicId: string | null): Tx {
  return {
    clinicId,
    query: (sql, params) => conn.query(sql, params ?? []),
    async one(sql, params) {
      const r = await conn.query(sql, params ?? []);
      if (r.rows.length !== 1) throw new Error(`Expected exactly one row, got ${r.rows.length}`);
      return r.rows[0] as never;
    },
    async maybeOne(sql, params) {
      const r = await conn.query(sql, params ?? []);
      if (r.rows.length > 1) throw new Error(`Expected at most one row, got ${r.rows.length}`);
      return r.rows[0] as never;
    },
  };
}

export class Db {
  private pool: PgPool;
  constructor(url: string, opts: number | PoolOptions = 8) {
    const cfg = parseDatabaseUrl(url);
    cfg.statementTimeoutMs ??= API_STATEMENT_TIMEOUT_MS;
    cfg.idleInTransactionTimeoutMs ??= API_IDLE_IN_TRANSACTION_TIMEOUT_MS;
    this.pool = new PgPool(cfg, opts);
  }

  get poolStats() { return this.pool.stats; }

  /** Run fn in a transaction, scoped to a clinic for RLS (clinicId null = pre-auth / global tables only). */
  async tx<T>(clinicId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const conn = await this.pool.acquire();
    let destroy = false;
    try {
      await conn.query('BEGIN');
      if (clinicId) await conn.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
      const result = await fn(wrap(conn, clinicId));
      await conn.query('COMMIT');
      return result;
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { destroy = true; }
      throw e;
    } finally {
      this.pool.release(conn, destroy);
    }
  }

  async close() { await this.pool.end(); }
}

/**
 * Transaction-scoped advisory lock serialising writers of one logical aggregate that has no row the application role may
 * lock (append-only tables have no UPDATE privilege, so no FOR UPDATE). Key = hashtext('<namespace>:<id>'), the exact
 * key the modules used before R74, so locks taken by old and new code paths still exclude each other.
 */
export async function advisoryLock(tx: Tx, namespace: string, id: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))", [namespace, id]);
}

/**
 * The driver returns PostgreSQL arrays (int2[], text[], uuid[] via array_agg) as their text form '{a,b}'. These helpers
 * parse that form for arrays whose elements never need quoting (numbers, UUIDs, fixed tokens), which is every array the
 * schema stores; a quoted element would be a programming error and is refused rather than mis-split.
 */
export function pgTextArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  const s = String(v ?? '{}');
  if (s.includes('"')) throw new Error('pgTextArray: quoted array elements are not supported');
  return s.replace(/[{}]/g, '').split(',').filter(Boolean);
}
export const pgIntArray = (v: unknown): number[] => pgTextArray(v).map(Number);

/** A UNIQUE constraint refused the write (modules use this instead of importing the driver's error type). */
export const isUniqueViolation = (e: unknown): boolean => e instanceof PgError && e.code === '23505';
