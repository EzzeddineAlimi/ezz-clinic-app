/*
 * Seed ONE fictional clinic with an owner, a dentist and a receptionist (bootstrap path: the first owner cannot be
 * created through the API). Passwords come from the environment, never from the repository.
 * Usage: MIGRATION_DATABASE_URL=... SEED_PASSWORD='at-least-12-chars' node scripts/seed-fictional.ts [clinic-code]
 */
import { PgConnection, parseDatabaseUrl } from '../src/platform/pgwire.ts';
import { hashPassword, validatePasswordPolicy } from '../src/modules/identity.ts';

const url = process.env.MIGRATION_DATABASE_URL;
const pw = process.env.SEED_PASSWORD ?? '';
if (!url) { process.stderr.write('MIGRATION_DATABASE_URL required\n'); process.exit(2); }
try { validatePasswordPolicy(pw); } catch { process.stderr.write('SEED_PASSWORD must be 12-128 characters\n'); process.exit(2); }
const code = process.argv[2] ?? 'demo-fictional';
const c = new PgConnection(parseDatabaseUrl(url));
await c.connect();
try {
  const clinic = (await c.query<{ id: string }>('INSERT INTO clinics (code, name) VALUES ($1, $2) RETURNING id', [code, 'Clinique Fictive (DEMO)'])).rows[0]!;
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinic.id]);
  const hash = await hashPassword(pw);
  for (const [u, name, role] of [['owner', 'Fictional Owner', 'OWNER'], ['dentist', 'Dr Fictional', 'DENTIST'], ['desk', 'Fictional Receptionist', 'RECEPTIONIST']] as const) {
    const s = (await c.query<{ id: string }>('INSERT INTO staff (clinic_id, username, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [clinic.id, u, name, hash])).rows[0]!;
    await c.query('INSERT INTO staff_roles (clinic_id, staff_id, role) VALUES ($1,$2,$3)', [clinic.id, s.id, role]);
  }
  await c.query('COMMIT');
  process.stdout.write(`seeded fictional clinic "${code}" (${clinic.id}) with owner / dentist / desk\n`);
} finally { c.end(); }
