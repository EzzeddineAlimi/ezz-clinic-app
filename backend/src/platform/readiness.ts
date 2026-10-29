/*
 * Readiness (R73-B): is this process safe to serve? The database must answer and its schema must be exactly what
 * this code expects (no pending, modified or unknown migrations). Used at startup (fail fast) and by the public
 * GET /api/v1/health/ready. Results carry states only, never migration names, URLs or credentials.
 */
import type { Db } from './db.ts';
import { compareMigrations, migrationFiles } from './migrate.ts';
import { MIGRATIONS_DIR } from './paths.ts';

export type MigrationState = 'current' | 'pending' | 'modified' | 'ahead_of_code' | 'unverifiable';
export interface Readiness { ready: boolean; checks: { database: 'ok' | 'unreachable'; migrations: MigrationState }; reason?: string }

let cachedFiles: Awaited<ReturnType<typeof migrationFiles>> | null = null;

export async function readiness(db: Db, dir = MIGRATIONS_DIR): Promise<Readiness> {
  cachedFiles ??= await migrationFiles(dir);
  let rows: Array<{ version: string; sha256: string }>;
  try {
    rows = await db.tx(null, async tx => (await tx.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations')).rows);
  } catch (e) {
    const code = (e as { code?: string }).code;
    // 42P01 / 42501: reachable, but the ledger is missing or not readable (schema older than 0010).
    if (code === '42P01' || code === '42501') return { ready: false, checks: { database: 'ok', migrations: 'unverifiable' }, reason: 'migration ledger not readable by the API role (apply pending migrations)' };
    return { ready: false, checks: { database: 'unreachable', migrations: 'unverifiable' }, reason: `database not reachable (${code ?? (e as Error).name})` };
  }
  const st = compareMigrations(cachedFiles, new Map(rows.map(r => [r.version, r.sha256])));
  const migrations: MigrationState = st.unknownApplied.length ? 'ahead_of_code' : st.modified.length ? 'modified' : st.pending.length ? 'pending' : 'current';
  return { ready: migrations === 'current', checks: { database: 'ok', migrations },
    ...(migrations === 'current' ? {} : { reason: `migrations ${migrations}: ${st.unknownApplied.length} unknown, ${st.modified.length} modified, ${st.pending.length} pending` }) };
}
