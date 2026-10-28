/* Apply forward-only migrations as the schema owner. Usage: MIGRATION_DATABASE_URL=postgres://ezz_owner:...@host/db node scripts/migrate.ts */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from '../src/platform/migrate.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { process.stderr.write('MIGRATION_DATABASE_URL is required (schema-owner role, never the API role)\n'); process.exit(2); }
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ran = await migrate(url, dir, s => process.stdout.write(s + '\n'));
process.stdout.write(ran.length ? `done: ${ran.length} migration(s) applied\n` : 'up to date\n');
