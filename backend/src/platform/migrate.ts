/*
 * Forward-only, checksummed migrations. Each file runs in its own transaction as the schema owner.
 * An already-applied file whose content changed is a hard error (migrations are immutable once shared);
 * fixes go in a NEW numbered file (expand -> migrate -> contract for breaking changes).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PgConnection, parseDatabaseUrl } from './pgwire.ts';
import { sha256 } from './canonical.ts';

export async function migrate(ownerUrl: string, dir: string, log: (s: string) => void = () => {}) {
  const conn = new PgConnection(parseDatabaseUrl(ownerUrl));
  await conn.connect();
  try {
    await conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(dir)).filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const applied = new Map((await conn.query<{ version: string; sha256: string }>('SELECT version, sha256 FROM schema_migrations')).rows.map(r => [r.version, r.sha256]));
    const ran: string[] = [];
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      const sum = sha256(sql);
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
