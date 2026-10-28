/*
 * Test harness: every test file gets its own throw-away PostgreSQL database (real persistence, real
 * transactions, real RLS and privileges) — not an in-memory fake. Data are SYNTHETIC only.
 *
 * Env: EZZ_TEST_ADMIN_URL (superuser, default postgres://postgres@localhost:5432/postgres?host=/tmp).
 * Roles ezz_owner (schema owner, runs migrations) and ezz_app (API, least privilege) are created if absent.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { PgConnection, parseDatabaseUrl } from '../src/platform/pgwire.ts';
import { migrate } from '../src/platform/migrate.ts';
import { createApp } from '../src/app.ts';
import { hashPassword } from '../src/modules/identity.ts';

export const ADMIN_URL = process.env.EZZ_TEST_ADMIN_URL ?? 'postgres://postgres@localhost:5432/postgres?host=/tmp';
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const PASSWORD = 'fictional-pass-123';
const OWNER_PW = 'fictional-owner-pw';
const APP_PW = 'fictional-app-pw';

export function urlFor(user: string, password: string, database: string): string {
  const u = new URL(ADMIN_URL);
  u.username = user; u.password = password; u.pathname = '/' + database;
  return u.toString();
}

export async function adminConn(database?: string): Promise<PgConnection> {
  const cfg = parseDatabaseUrl(ADMIN_URL);
  const c = new PgConnection(database ? { ...cfg, database } : cfg);
  await c.connect();
  return c;
}

export interface TestDb { name: string; ownerUrl: string; appUrl: string; drop(): Promise<void> }

export async function createTestDb(): Promise<TestDb> {
  const name = 'ezz_test_' + randomBytes(5).toString('hex');
  const a = await adminConn();
  try {
    for (const [role, pw] of [['ezz_owner', OWNER_PW], ['ezz_app', APP_PW]] as const) {
      const exists = await a.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) await a.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    }
    await a.exec(`CREATE DATABASE ${name} OWNER ezz_owner`);
    await a.exec(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO ezz_app`);
  } finally { a.end(); }
  const ownerUrl = urlFor('ezz_owner', OWNER_PW, name);
  const appUrl = urlFor('ezz_app', APP_PW, name);
  await migrate(ownerUrl, MIGRATIONS_DIR);
  return {
    name, ownerUrl, appUrl,
    async drop() {
      const c = await adminConn();
      try { await c.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { c.end(); }
    },
  };
}

export interface SeedStaff { username: string; roles: string[]; displayName?: string }
export interface SeededClinic { id: string; code: string; staff: Record<string, string> }

/** Seed a fictional clinic directly through the owner role (the bootstrap path; no API exists for the first owner). */
export async function seedClinic(db: TestDb, code: string, staff: SeedStaff[]): Promise<SeededClinic> {
  const c = new PgConnection(parseDatabaseUrl(db.ownerUrl));
  await c.connect();
  try {
    const clinic = (await c.query<{ id: string }>('INSERT INTO clinics (code, name) VALUES ($1, $2) RETURNING id', [code, `Fictional Clinic ${code}`])).rows[0]!;
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinic.id]);
    const ids: Record<string, string> = {};
    const hash = await hashPassword(PASSWORD);
    for (const s of staff) {
      const r = (await c.query<{ id: string }>('INSERT INTO staff (clinic_id, username, display_name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id',
        [clinic.id, s.username, s.displayName ?? `Fictional ${s.username}`, hash])).rows[0]!;
      for (const role of s.roles) await c.query('INSERT INTO staff_roles (clinic_id, staff_id, role) VALUES ($1,$2,$3)', [clinic.id, r.id, role]);
      ids[s.username] = r.id;
    }
    await c.query('COMMIT');
    return { id: clinic.id, code, staff: ids };
  } finally { c.end(); }
}

export const STANDARD_STAFF: SeedStaff[] = [
  { username: 'owner', roles: ['OWNER'] },
  { username: 'dentist', roles: ['DENTIST'] },
  { username: 'desk', roles: ['RECEPTIONIST'] },
];

export interface Api {
  base: string;
  call(method: string, path: string, opts?: { token?: string; body?: unknown; idem?: string | false; headers?: Record<string, string>; rawBody?: string }): Promise<{ status: number; body: any; headers: Headers }>;
  login(clinicCode: string, username: string, password?: string): Promise<string>;
  close(): Promise<void>;
}

export const key = () => 'k_' + randomBytes(12).toString('hex');

export async function startApi(appUrl: string): Promise<Api> {
  const logs: unknown[] = [];
  const { server } = createApp({ databaseUrl: appUrl, log: l => { logs.push(l); } });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const api: Api = {
    base,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (method === 'POST' && !('content-type' in headers)) headers['content-type'] = 'application/json';
      if (method === 'POST' && opts.idem !== false) headers['idempotency-key'] = opts.idem ?? key();
      const res = await fetch(base + path, { method, headers, body: method === 'POST' ? (opts.rawBody ?? JSON.stringify(opts.body ?? {})) : undefined });
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      return { status: res.status, body, headers: res.headers };
    },
    async login(clinicCode, username, password = PASSWORD) {
      const r = await api.call('POST', '/api/v1/session/login', { body: { clinicCode, username, password }, idem: false });
      if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.token as string;
    },
    close: () => new Promise<void>(res => { server.closeAllConnections?.(); server.close(() => res()); }),
  };
  (api as unknown as { logs: unknown[] }).logs = logs;
  return api;
}

/** Common fixture: clinic with owner/dentist/desk sessions, one synthetic patient and one visit. */
export async function standardFixture(api: Api, db: TestDb, code = 'clinic-a', opts: { openCashPeriod?: boolean; openingFloatMillimes?: number } = {}) {
  const clinic = await seedClinic(db, code, STANDARD_STAFF);
  const owner = await api.login(code, 'owner');
  const dentist = await api.login(code, 'dentist');
  const desk = await api.login(code, 'desk');
  if (opts.openCashPeriod !== false) {
    const cp = await api.call('POST', '/api/v1/cash/periods', { token: owner, body: { openingFloatMillimes: opts.openingFloatMillimes ?? 0 } });
    if (cp.status !== 201 && cp.status !== 404) throw new Error('cash period fixture failed ' + JSON.stringify(cp.body));
  }
  const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictif', givenName: 'Amel', isSynthetic: true } });
  if (p.status !== 201) throw new Error('patient fixture failed ' + JSON.stringify(p.body));
  const v = await api.call('POST', '/api/v1/visits', { token: desk, body: { patientId: p.body.patient.id, scheduledAt: '2026-10-28T09:00:00Z', dentistId: clinic.staff.dentist } });
  if (v.status !== 201) throw new Error('visit fixture failed ' + JSON.stringify(v.body));
  return { clinic, owner, dentist, desk, patientId: p.body.patient.id as string, visitId: v.body.visit.id as string };
}

export async function newVisit(api: Api, desk: string, patientId: string, at = '2026-10-28T10:00:00Z') {
  const v = await api.call('POST', '/api/v1/visits', { token: desk, body: { patientId, scheduledAt: at } });
  if (v.status !== 201) throw new Error('visit failed ' + JSON.stringify(v.body));
  return v.body.visit.id as string;
}

export async function confirmCare(api: Api, dentist: string, visitId: string, feeMillimes: number, procedureCode = 'CHECKUP') {
  const r = await api.call('POST', `/api/v1/visits/${visitId}/care`, { token: dentist, body: { procedureCode, procedureLabel: 'Fictional checkup', feeMillimes } });
  if (r.status !== 201) throw new Error('care failed ' + JSON.stringify(r.body));
  return r.body.careItem.id as string;
}

export async function reauth(api: Api, token: string) {
  const r = await api.call('POST', '/api/v1/session/reauth', { token, body: { password: PASSWORD }, idem: false });
  if (r.status !== 200) throw new Error('reauth failed');
}

export const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts');

/** Start the real server as a separate OS process (for crash/restart persistence tests). */
export async function spawnServer(appUrl: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [SERVER_ENTRY], { env: { ...process.env, DATABASE_URL: appUrl, PORT: String(port), LOG_LEVEL: 'silent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.status === 200) return child; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('server did not start');
}

export async function killServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise(r => child.once('exit', r));
}
