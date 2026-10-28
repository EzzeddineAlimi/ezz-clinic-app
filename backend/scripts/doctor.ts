/* Developer / operator environment check (R73-B). Prints JSON; exit 0 only if every check passes. Never prints URLs,
 * users or passwords. Usage:
 *   EZZ_TEST_ADMIN_URL=postgres://...  [MIGRATION_DATABASE_URL=...] [DATABASE_URL=...] node scripts/doctor.ts
 * Checks: Node major matches backend/.nvmrc (22); PostgreSQL server is 16.x; DATABASE_URL obeys the TLS policy
 * (parse only, no connection); migration ledger is exactly current when MIGRATION_DATABASE_URL is given. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_ROOT, MIGRATIONS_DIR } from '../src/platform/paths.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';
import { migrationStatus } from '../src/platform/migrate.ts';

export interface Check { name: string; ok: boolean; detail: string }

export function checkNode(running: string, wanted: string): Check {
  const major = (v: string) => Number(v.replace(/^v/, '').split('.')[0]);
  return { name: 'NODE_VERSION', ok: major(running) === major(wanted), detail: `running ${running}, .nvmrc wants ${wanted} (same major required)` };
}

export function checkPgVersion(serverVersionNum: number): Check {
  return { name: 'POSTGRESQL_VERSION', ok: serverVersionNum >= 160000 && serverVersionNum < 170000, detail: `server_version_num ${serverVersionNum} (16.x required)` };
}

export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [checkNode(process.version, readFileSync(join(BACKEND_ROOT, '.nvmrc'), 'utf8').trim())];
  const adminUrl = env.EZZ_TEST_ADMIN_URL ?? env.DATABASE_URL;
  if (adminUrl) {
    const c = new PgConnection(parseDatabaseUrl(adminUrl));
    try {
      await c.connect();
      checks.push(checkPgVersion(Number((await c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v)));
    } catch (e) { checks.push({ name: 'POSTGRESQL_REACHABLE', ok: false, detail: `cannot connect (${(e as { code?: string }).code ?? (e as Error).name})` }); } finally { c.end(); }
  } else checks.push({ name: 'POSTGRESQL_VERSION', ok: false, detail: 'set EZZ_TEST_ADMIN_URL (local throwaway cluster) or DATABASE_URL' });
  if (env.DATABASE_URL) {
    try { const cfg = parseDatabaseUrl(env.DATABASE_URL); checks.push({ name: 'DATABASE_URL_TLS_POLICY', ok: true, detail: `sslmode ${cfg.sslMode}${cfg.sslRootCert ? ', CA pinned' : ''}` }); }
    catch (e) { checks.push({ name: 'DATABASE_URL_TLS_POLICY', ok: false, detail: (e as Error).message }); }
  }
  if (env.MIGRATION_DATABASE_URL) {
    try {
      const st = await migrationStatus(env.MIGRATION_DATABASE_URL, MIGRATIONS_DIR);
      checks.push({ name: 'MIGRATIONS_CURRENT', ok: st.current, detail: `${st.applied.length} applied, ${st.pending.length} pending, ${st.modified.length} modified, ${st.unknownApplied.length} unknown` });
    } catch (e) { checks.push({ name: 'MIGRATIONS_CURRENT', ok: false, detail: `cannot read ledger (${(e as { code?: string }).code ?? (e as Error).name})` }); }
  }
  return { ok: checks.every(c => c.ok), checks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runDoctor();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.ok ? 0 : 1);
}
