/*
 * IDENTITY module: staff accounts, roles, sessions, the permission matrix, step-up re-auth,
 * login throttling, idempotency records. Owns tables: staff, staff_roles, sessions, login_attempts,
 * security_denials, idempotency_records.
 *
 * Security properties (C1 / CH-012):
 *  - identity is derived ONLY from the server-side session; any role/actor field in a body is ignored;
 *  - one credential per person (no shared desk PIN); deactivation revokes sessions immediately;
 *  - no self-service password recovery: only an OWNER (with re-auth) can reset a staff password, and owner
 *    recovery requires database-owner access via the CLI (receptionist cannot trigger recovery);
 *  - demo passwords are logic-test scaffolding, NOT production identity proof (chairside auth UNVERIFIED).
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Db, Tx } from '../platform/db.ts';
import type { Actor, Role, Route, SecurityHooks, Result } from '../platform/http.ts';
import { AppError, fail } from '../platform/errors.ts';
import { asBody, str, oneOf, uuid } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

export const SESSION_ABSOLUTE_MS = 12 * 3600_000;   // ASSUMPTION: one working day
export const SESSION_IDLE_MS = 30 * 60_000;         // ASSUMPTION: shared-desk risk vs friction
export const REAUTH_WINDOW_MS = 5 * 60_000;         // C-148 T-STMT-4 (ASSUMPTION 5 min)
export const LOCKOUT_FAILS = 5;
export const LOCKOUT_WINDOW_MIN = 15;

export const ROLES: readonly Role[] = ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'];

/**
 * THE permission matrix — single source of truth (docs/security/permission-matrix.md mirrors it and a
 * test asserts they agree). Server-side and per request. Absent permission = denied.
 */
export const PERMISSIONS: Record<string, readonly Role[]> = {
  'session.self':            ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'staff.manage':            ['OWNER'],
  'staff.read':              ['OWNER'],
  'patient.create':          ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'patient.read':            ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'patient.update_contact':  ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'visit.schedule':          ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'visit.read':              ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'visit.desk_status':       ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'care.confirm':            ['DENTIST'],
  'care.correct':            ['DENTIST'],
  'care.read':               ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'care.amend_site':         ['DENTIST'],
  // Clinical record (clinical-requirements §12). Detail is dentist-only in this slice; a non-clinician OWNER
  // has no clinical access (holding OWNER+DENTIST gives the union). ASSISTANT access is a pending policy decision.
  'clinical.read':           ['DENTIST'],
  'clinical.write':          ['DENTIST'],
  'medical.declare':         ['DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'medical.alert_presence':  ['DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'payment.record':          ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'payment.read':            ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'receipt.reprint':         ['OWNER', 'RECEPTIONIST'],
  'adjustment.discount':     ['OWNER', 'DENTIST'],
  'adjustment.refund':       ['OWNER'],
  'adjustment.void_payment': ['OWNER'],
  'cash.manage_period':      ['OWNER'],
  'cash.count_submit':       ['OWNER', 'DENTIST'],
  'cash.review':             ['OWNER'],
  'card.import_statement':   ['OWNER'],
  'card.review':             ['OWNER'],
  'paper.issue_book':        ['OWNER'],
  'paper.enter_slips':       ['OWNER', 'DENTIST', 'RECEPTIONIST'],
  'paper.custody':           ['OWNER', 'DENTIST'],
  'paper.read':              ['OWNER', 'DENTIST'],
  // Patient documents / imaging attachments (R73-D): dentist-only like the clinical record. ASSISTANT capture and
  // RECEPTIONIST scanning of administrative paperwork are open policy questions (docs/product/patient-documents.md).
  'document.upload':         ['DENTIST'],
  'document.read':           ['DENTIST'],
  'document.correct':        ['DENTIST'],
  'document.deletion_request': ['OWNER'],
  // Dental lab (R73-E, clinical-requirements §12 matrix): dentist orders/signs, assistant creates and tracks logistics,
  // desk sees a status/date board only, owner records lab invoices (clinic expenses) and sees MF19 exceptions.
  'lab.supplier.read':       ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'lab.supplier.manage':     ['OWNER', 'DENTIST'],
  'lab.case.create':         ['DENTIST', 'ASSISTANT'],
  'lab.case.read':           ['DENTIST', 'ASSISTANT'],
  'lab.case.track':          ['DENTIST', 'ASSISTANT'],
  'lab.case.sign':           ['DENTIST'],
  'lab.status.read':         ['DENTIST', 'ASSISTANT', 'RECEPTIONIST'],
  'lab.invoice.record':      ['OWNER'],
  // Basic stock (R73-E): everyday receipts/usage by clinical staff and owner; corrections and discards by the owner.
  'stock.read':              ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'stock.record':            ['OWNER', 'DENTIST', 'ASSISTANT'],
  'stock.manage':            ['OWNER'],
  'clinic.settings.read':    ['OWNER', 'DENTIST', 'RECEPTIONIST', 'ASSISTANT'],
  'clinic.settings.manage':  ['OWNER'],
  'exceptions.read':         ['OWNER'],
  'finance.review':          ['OWNER'],
  'exceptions.resolve':      ['OWNER'],
  'audit.checkpoint':        ['OWNER'],
  'audit.verify':            ['OWNER'],
};

export function can(actor: Actor, permission: string): boolean {
  const allowed = PERMISSIONS[permission];
  return !!allowed && actor.roles.some(r => allowed.includes(r));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const got = await scrypt(pw, Buffer.from(saltB64, 'base64'), key.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === key.length && crypto.timingSafeEqual(got, key);
}

export function validatePasswordPolicy(pw: string) {
  // NIST SP 800-63B style: length over composition; allow paste/password managers (WCAG 3.3.8).
  if (pw.length < 12 || pw.length > 128) fail('VALIDATION_FAILED', 'Password must be 12-128 characters');
}

const tokenHash = (t: string) => sha256(t);

export async function authenticate(db: Db, token: string): Promise<Actor | null> {
  const th = tokenHash(token);
  return db.tx(null, async tx => {
    const s = await tx.maybeOne<{ clinic_id: string; staff_id: string; expires_at: string; last_seen_at: string; reauth_at: string | null; revoked_at: string | null }>(
      'SELECT clinic_id, staff_id, expires_at, last_seen_at, reauth_at, revoked_at FROM sessions WHERE token_hash = $1', [th]);
    if (!s || s.revoked_at) return null;
    const now = Date.now();
    if (new Date(s.expires_at).getTime() < now || now - new Date(s.last_seen_at).getTime() > SESSION_IDLE_MS) return null;
    await tx.query("SELECT set_config('app.clinic_id', $1, true)", [s.clinic_id]);
    const staff = await tx.maybeOne<{ display_name: string; active: boolean }>('SELECT display_name, active FROM staff WHERE id = $1', [s.staff_id]);
    if (!staff || !staff.active) return null;
    const roles = (await tx.query<{ role: Role }>('SELECT role FROM staff_roles WHERE staff_id = $1 ORDER BY role', [s.staff_id])).rows.map(r => r.role);
    await tx.query('UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1', [th]);
    return { staffId: s.staff_id, clinicId: s.clinic_id, roles, displayName: staff.display_name, tokenHash: th, reauthAt: s.reauth_at };
  });
}

export async function recordDenial(db: Db, actor: Actor, permission: string) {
  await db.tx(actor.clinicId, tx => tx.query(
    `INSERT INTO security_denials (clinic_id, staff_id, action, day) VALUES ($1, $2, $3, current_date)
     ON CONFLICT (clinic_id, staff_id, action, day) DO UPDATE SET count = security_denials.count + 1, last_at = now()`,
    [actor.clinicId, actor.staffId, permission]));
}

export const idempotency: SecurityHooks['idempotency'] = {
  async begin(tx: Tx, actor: Actor, key: string, route: string, body: unknown): Promise<Result | null> {
    const requestHash = sha256(canonicalJson({ route, actor: actor.staffId, body }));
    const ins = await tx.query(
      `INSERT INTO idempotency_records (clinic_id, key, actor_staff_id, route, request_hash) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (clinic_id, key) DO NOTHING RETURNING key`, [actor.clinicId, key, actor.staffId, route, requestHash]);
    if (ins.rowCount === 1) return null;
    const prior = await tx.one<{ request_hash: string; response_status: number | null; response_body: unknown }>(
      'SELECT request_hash, response_status, response_body FROM idempotency_records WHERE clinic_id = $1 AND key = $2', [actor.clinicId, key]);
    if (prior.request_hash !== requestHash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
    }
    if (prior.response_status === null) throw new AppError('CONFLICT', 'Original request still in progress');
    return { status: prior.response_status, body: { ...(prior.response_body as object), replayed: true } };
  },
  async complete(tx: Tx, actor: Actor, key: string, result: Result) {
    await tx.query('UPDATE idempotency_records SET response_status = $3, response_body = $4 WHERE clinic_id = $1 AND key = $2',
      [actor.clinicId, key, result.status, result.body as object]);
  },
};

export const securityHooks = (): SecurityHooks => ({ authenticate, can, recordDenial, reauthWindowMs: REAUTH_WINDOW_MS, idempotency });

async function loadRoles(tx: Tx, staffId: string): Promise<Role[]> {
  return (await tx.query<{ role: Role }>('SELECT role FROM staff_roles WHERE staff_id = $1 ORDER BY role', [staffId])).rows.map(r => r.role);
}

/** Login runs before any session exists; it needs the db, so it is handled specially by the app wiring. */
export async function login(db: Db, rawBody: unknown): Promise<Result> {
  const b = asBody(rawBody);
  const clinicCode = str(b, 'clinicCode', { max: 40, pattern: /^[a-z0-9-]{3,40}$/ });
  const username = str(b, 'username', { max: 40, pattern: /^[a-z0-9._-]{3,40}$/ });
  const password = typeof b.password === 'string' ? b.password : '';
  if (!password || password.length > 128) fail('VALIDATION_FAILED', 'password is required');

  const clinic = await db.tx(null, tx => tx.maybeOne<{ id: string }>('SELECT id FROM clinics WHERE code = $1', [clinicCode]));
  const clinicId = clinic?.id ?? null;
  return db.tx(clinicId, async tx => {
    const fails = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts WHERE clinic_id IS NOT DISTINCT FROM $1 AND username = $2
         AND NOT succeeded AND at > now() - make_interval(mins => $3)`, [clinicId, username, LOCKOUT_WINDOW_MIN]);
    const staff = clinicId ? await tx.maybeOne<{ id: string; password_hash: string; active: boolean; display_name: string }>(
      'SELECT id, password_hash, active, display_name FROM staff WHERE username = $1', [username]) : undefined;
    const ok = await verifyPassword(password, staff?.password_hash ?? DUMMY_HASH);
    if (fails.n >= LOCKOUT_FAILS) {
      await tx.query('INSERT INTO login_attempts (clinic_id, username, succeeded) VALUES ($1, $2, false)', [clinicId, username]);
      return { status: 423, body: { error: { code: 'ACCOUNT_LOCKED', message: 'Too many failed attempts; try later or ask the clinic owner' } } };
    }
    if (!clinicId || !staff || !staff.active || !ok) {
      await tx.query('INSERT INTO login_attempts (clinic_id, username, succeeded) VALUES ($1, $2, false)', [clinicId, username]);
      return { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Invalid clinic, username or password' } } };
    }
    await tx.query('INSERT INTO login_attempts (clinic_id, username, succeeded) VALUES ($1, $2, true)', [clinicId, username]);
    const token = crypto.randomBytes(32).toString('base64url');
    await tx.query(`INSERT INTO sessions (token_hash, clinic_id, staff_id, expires_at, reauth_at)
                    VALUES ($1, $2, $3, now() + make_interval(secs => $4), now())`,
      [tokenHash(token), clinicId, staff.id, SESSION_ABSOLUTE_MS / 1000]);
    const roles = await loadRoles(tx, staff.id);
    const actor: Actor = { staffId: staff.id, clinicId, roles, displayName: staff.display_name, tokenHash: tokenHash(token), reauthAt: null };
    await appendAudit(tx, actor, 'session.login', 'staff', staff.id, {});
    return { status: 200, body: { token, staff: { id: staff.id, displayName: staff.display_name, roles }, clinicId, expiresInSeconds: SESSION_ABSOLUTE_MS / 1000 } };
  });
}

export const identityRoutes: Route[] = [
  {
    method: 'GET', path: '/api/v1/session', permission: 'session.self',
    handler: async ({ actor }) => ({ status: 200, body: { staff: { id: actor!.staffId, displayName: actor!.displayName, roles: actor!.roles }, clinicId: actor!.clinicId } }),
  },
  {
    method: 'POST', path: '/api/v1/session/reauth', permission: 'session.self',
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const pw = typeof b.password === 'string' ? b.password : '';
      const s = await tx.one<{ password_hash: string }>('SELECT password_hash FROM staff WHERE id = $1', [actor!.staffId]);
      if (!(await verifyPassword(pw, s.password_hash))) fail('UNAUTHENTICATED', 'Password incorrect');
      await tx.query('UPDATE sessions SET reauth_at = now() WHERE token_hash = $1', [actor!.tokenHash]);
      return { status: 200, body: { reauthenticated: true, validForSeconds: REAUTH_WINDOW_MS / 1000 } };
    },
  },
  {
    method: 'POST', path: '/api/v1/session/logout', permission: 'session.self',
    handler: async ({ tx, actor }) => {
      await tx.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [actor!.tokenHash]);
      await appendAudit(tx, actor!, 'session.logout', 'staff', actor!.staffId, {});
      return { status: 200, body: { loggedOut: true } };
    },
  },
  {
    method: 'GET', path: '/api/v1/staff', permission: 'staff.read',
    handler: async ({ tx }) => {
      const rows = (await tx.query(`SELECT s.id, s.username, s.display_name, s.active,
          coalesce((SELECT json_agg(r.role ORDER BY r.role) FROM staff_roles r WHERE r.staff_id = s.id), '[]'::json) AS roles
        FROM staff s ORDER BY s.username`)).rows;
      return { status: 200, body: { staff: rows } };
    },
  },
  {
    method: 'POST', path: '/api/v1/staff', permission: 'staff.manage', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const username = str(b, 'username', { max: 40, pattern: /^[a-z0-9._-]{3,40}$/ });
      const displayName = str(b, 'displayName', { min: 2, max: 120 });
      const password = typeof b.password === 'string' ? b.password : '';
      validatePasswordPolicy(password);
      const rolesIn = Array.isArray(b.roles) ? b.roles : [];
      if (!rolesIn.length || rolesIn.some(r => !ROLES.includes(r as Role))) fail('VALIDATION_FAILED', 'roles must be a non-empty subset of ' + ROLES.join(', '));
      const s = await tx.one<{ id: string }>('INSERT INTO staff (clinic_id, username, display_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id',
        [actor!.clinicId, username, displayName, await hashPassword(password)]);
      for (const r of new Set(rolesIn as Role[])) {
        await tx.query('INSERT INTO staff_roles (clinic_id, staff_id, role, granted_by) VALUES ($1, $2, $3, $4)', [actor!.clinicId, s.id, r, actor!.staffId]);
      }
      await appendAudit(tx, actor!, 'staff.created', 'staff', s.id, { username, roles: [...new Set(rolesIn)] });
      return { status: 201, body: { staff: { id: s.id, username, displayName, roles: [...new Set(rolesIn)] } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/staff/:id/roles', permission: 'staff.manage', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const role = oneOf(b, 'role', ROLES)!;
      const op = oneOf(b, 'op', ['GRANT', 'REVOKE'] as const)!;
      const target = await tx.maybeOne<{ id: string }>('SELECT id FROM staff WHERE id = $1', [params.id!]);
      if (!target) fail('NOT_FOUND', 'Staff not found');
      if (op === 'REVOKE' && role === 'OWNER' && params.id === actor!.staffId) fail('CONFLICT', 'An owner cannot remove their own OWNER role');
      if (op === 'GRANT') await tx.query('INSERT INTO staff_roles (clinic_id, staff_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [actor!.clinicId, params.id!, role, actor!.staffId]);
      else await tx.query('DELETE FROM staff_roles WHERE staff_id = $1 AND role = $2', [params.id!, role]);
      await appendAudit(tx, actor!, op === 'GRANT' ? 'staff.role_granted' : 'staff.role_revoked', 'staff', params.id!, { role });
      return { status: 200, body: { staffId: params.id, role, op, roles: await loadRoles(tx, params.id!) } };
    },
  },
  {
    // Employee departure: deactivate + revoke every session in the same transaction.
    method: 'POST', path: '/api/v1/staff/:id/deactivate', permission: 'staff.manage', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const reason = str(b, 'reason', { min: 3, max: 200 });
      if (params.id === actor!.staffId) fail('CONFLICT', 'You cannot deactivate your own account');
      const r = await tx.query('UPDATE staff SET active = false, deactivated_at = now() WHERE id = $1 AND active RETURNING id', [params.id!]);
      if (r.rowCount !== 1) fail('NOT_FOUND', 'Active staff not found');
      const revoked = await tx.query('UPDATE sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [params.id!]);
      await appendAudit(tx, actor!, 'staff.deactivated', 'staff', params.id!, { reason, sessionsRevoked: revoked.rowCount });
      return { status: 200, body: { staffId: params.id, active: false, sessionsRevoked: revoked.rowCount } };
    },
  },
  {
    method: 'POST', path: '/api/v1/staff/:id/reset-password', permission: 'staff.manage', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      uuid({ id: params.id }, 'id');
      const pw = typeof b.newPassword === 'string' ? b.newPassword : '';
      validatePasswordPolicy(pw);
      const r = await tx.query('UPDATE staff SET password_hash = $2 WHERE id = $1 RETURNING id', [params.id!, await hashPassword(pw)]);
      if (r.rowCount !== 1) fail('NOT_FOUND', 'Staff not found');
      const revoked = await tx.query('UPDATE sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [params.id!]);
      await appendAudit(tx, actor!, 'staff.password_reset', 'staff', params.id!, { sessionsRevoked: revoked.rowCount });
      return { status: 200, body: { staffId: params.id, sessionsRevoked: revoked.rowCount } };
    },
  },
];
