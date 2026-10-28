/*
 * Forward-only, checksummed migrations. Each file runs in its own transaction as the schema owner.
 * An already-applied file whose content changed is a hard error (migrations are immutable once shared);
 * fixes go in a NEW numbered file (expand -> migrate -> contract for breaking changes).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PgConnection, parseDatabaseUrl } from './pgwire.ts';
import { sha256 } from './canonical.ts';

export interface MigrationStatus {
  /** True when every file is applied unmodified and the database has nothing this code does not know. */
  current: boolean;
  applied: string[]; pending: string[]; modified: string[];
  /** Applied in the database but absent from this code: the schema is AHEAD of the code (older build, wrong branch). */
  unknownApplied: string[];
}

/** Migration files in order with their checksums. */
export async function migrationFiles(dir: string): Promise<Array<{ version: string; sha256: string; sql: string }>> {
  const files = (await readdir(dir)).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(files.map(async f => { const sql = await readFile(join(dir, f), 'utf8'); return { version: f, sha256: sha256(sql), sql }; }));
}

/** Compare files with the applied set (pure). */
export function compareMigrations(files: Array<{ version: string; sha256: string }>, applied: Map<string, string>): MigrationStatus {
  const known = new Set(files.map(f => f.version));
  const pending = files.filter(f => !applied.has(f.version)).map(f => f.version);
  const modified = files.filter(f => applied.has(f.version) && applied.get(f.version) !== f.sha256).map(f => f.version);
  const unknownApplied = [...applied.keys()].filter(v => !known.has(v)).sort();
  return { current: !pending.length && !modified.length && !unknownApplied.length, applied: [...applied.keys()].sort(), pending, modified, unknownApplied };
}

/** Read-only status for a database (owner URL). Applies nothing. */
export async function migrationStatus(ownerUrl: string, dir: string): Promise<MigrationStatus> {
  const conn = new PgConnection(parseDatabaseUrl(ownerUrl));
  await conn.connect();
  try {
    const exists = (await conn.query<{ ok: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0]!.ok;
    const applied = exists ? new Map((await conn.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations')).rows.map(r => [r.version, r.sha256])) : new Map<string, string>();
    return compareMigrations(await migrationFiles(dir), applied);
  } finally { conn.end(); }
}

export async function migrate(ownerUrl: string, dir: string, log: (s: string) => void = () => {}) {
  const conn = new PgConnection(parseDatabaseUrl(ownerUrl));
  await conn.connect();
  try {
    await conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = await migrationFiles(dir);
    const applied = new Map((await conn.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations')).rows.map(r => [r.version, r.sha256]));
    // R73-B: never run against a schema that is ahead of this code (an older build, or the wrong branch).
    const unknown = compareMigrations(files, applied).unknownApplied;
    if (unknown.length) throw new Error(`Database has applied migration(s) not present in this code: ${unknown.join(', ')}. Deploy the matching code; never downgrade a schema by running older code.`);
    const ran: string[] = [];
    for (const { version: f, sha256: sum, sql } of files) {
      const prior = applied.get(f);
      if (prior) {
        if (prior !== sum) throw new Error(`Migration ${f} was modified after being applied (checksum mismatch)`);
        continue;
      }
      await conn.exec('BEGIN');
      try {
        await conn.exec(sql);
        await conn.query('INSERT INTO schema_migrations (version, sha256) VALUES ($1, $2)', [f, sum]);
        await conn.exec('COMMIT');
      } catch (e) {
        await conn.exec('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      ran.push(f);
      log(`applied ${f}`);
    }
    return ran;
  } finally {
    conn.end();
  }
}
