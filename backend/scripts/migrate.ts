/* Apply forward-only migrations as the schema owner.
 * Usage: MIGRATION_DATABASE_URL=postgres://ezz_owner:...@host/db node scripts/migrate.ts [--check]
 * --check (R73-B): apply nothing; print the status as JSON; exit 0 only if the schema is exactly current,
 * 1 if migrations are pending / modified / unknown (schema ahead of this code). Use it in deploy pipelines. */
import { migrate, migrationStatus } from '../src/platform/migrate.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { process.stderr.write('MIGRATION_DATABASE_URL is required (schema-owner role, never the API role)\n'); process.exit(2); }
if (process.argv.includes('--check')) {
  const st = await migrationStatus(url, MIGRATIONS_DIR);
  process.stdout.write(JSON.stringify(st, null, 2) + '\n');
  process.exit(st.current ? 0 : 1);
}
const ran = await migrate(url, MIGRATIONS_DIR, s => process.stdout.write(s + '\n'));
process.stdout.write(ran.length ? `done: ${ran.length} migration(s) applied\n` : 'up to date\n');
