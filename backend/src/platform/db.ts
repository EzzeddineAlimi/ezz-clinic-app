/*
 * Database access boundary. Module code depends only on `Tx` and `Db`, never on the driver,
 * so the in-repo wire client can be swapped for node-postgres (`pg`) later (ENG-01).
 *
 * Transaction contract:
 *  - every request that touches tenant data runs inside ONE transaction;
 *  - `SET LOCAL app.clinic_id` is applied first, so PostgreSQL RLS filters every statement;
 *  - financial writes take explicit row locks (SELECT ... FOR UPDATE) on the aggregate they change
 *    (visit, receipt counter, audit head, cash period) to serialise concurrent requests;
 *  - any thrown error rolls the whole transaction back (payment + receipt + audit + idempotency together).
 */
import { PgPool, PgConnection, parseDatabaseUrl, type PgValue, type QueryResult, type Row } from './pgwire.ts';

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
  constructor(url: string, max = 8) {
    this.pool = new PgPool(parseDatabaseUrl(url), max);
  }

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
