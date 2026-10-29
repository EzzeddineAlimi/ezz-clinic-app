/*
 * CLINIC SETTINGS module (R73-C). Owns: clinic_setting_changes (append-only, RLS, audited).
 * Depends on: audit. Everything that needs the clinic's day or a clinic policy reads it from here.
 *
 * Only policies the code already relied on are configurable; each has a code default and strict validation:
 *   timezone (IANA, must be known to both Node and PostgreSQL), checkpointDueDays (1-31), notArrivedGraceMinutes (5-120),
 *   labUnbilledDays (7-180, R73-E: MF19 lab work without a linked billed care item; default 30 from clinical-requirements §9).
 * Effective value = latest change for the key, else the bootstrap value in clinics.settings (timezone only), else the
 * default. Reads are open to every role (a frontend needs the clinic's day); changes are owner-only with password
 * re-entry, a reason, an audit event, and an explicit confirmation before the timezone of a clinic with visits moves.
 * No hosting, payment-provider, fiscal or clinical policy lives here.
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';

export interface ClinicSettings { timezone: string; checkpointDueDays: number; notArrivedGraceMinutes: number; labUnbilledDays: number }
type Key = keyof ClinicSettings;
const COLUMN: Record<Key, string> = { timezone: 'timezone', checkpointDueDays: 'checkpoint_due_days', notArrivedGraceMinutes: 'not_arrived_grace_minutes', labUnbilledDays: 'lab_unbilled_days' };
const KEY_OF: Record<string, Key> = Object.fromEntries(Object.entries(COLUMN).map(([k, c]) => [c, k as Key]));
export const DEFAULT_SETTINGS: Readonly<ClinicSettings> = Object.freeze({ timezone: 'Africa/Tunis', checkpointDueDays: 7, notArrivedGraceMinutes: 15, labUnbilledDays: 30 });
export const LIMITS = { checkpointDueDays: { min: 1, max: 31 }, notArrivedGraceMinutes: { min: 5, max: 120 }, labUnbilledDays: { min: 7, max: 180 } } as const;

const validIntlZone = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

async function load(tx: Tx, clinicId: string) {
  const rows = (await tx.query<{ key: string; value: unknown; changed_at: string }>(
    'SELECT DISTINCT ON (key) key, value, changed_at FROM clinic_setting_changes WHERE clinic_id = $1 ORDER BY key, changed_at DESC, id DESC', [clinicId])).rows;
  const boot = await tx.one<{ tz: string | null }>("SELECT settings->>'timezone' AS tz FROM clinics WHERE id = $1", [clinicId]);
  const settings: ClinicSettings = { ...DEFAULT_SETTINGS };
  const sources: Record<Key, 'default' | 'bootstrap' | 'changed'> = { timezone: 'default', checkpointDueDays: 'default', notArrivedGraceMinutes: 'default', labUnbilledDays: 'default' };
  if (boot.tz) { settings.timezone = boot.tz; sources.timezone = 'bootstrap'; }
  for (const r of rows) { const k = KEY_OF[r.key]; if (k) { (settings as unknown as Record<string, unknown>)[k] = r.value; sources[k] = 'changed'; } }
  return { settings, sources };
}

/** Effective settings. An invalid stored timezone fails loudly instead of silently using UTC (B12 rule). */
export async function clinicSettings(tx: Tx, clinicId: string): Promise<ClinicSettings> {
  const { settings } = await load(tx, clinicId);
  if (!validIntlZone(settings.timezone)) fail('CONFLICT', `Clinic timezone setting "${settings.timezone}" is not a valid IANA timezone; fix the clinic settings`);
  return settings;
}
export async function clinicTimezone(tx: Tx, clinicId: string): Promise<string> { return (await clinicSettings(tx, clinicId)).timezone; }

/** YYYY-MM-DD of an instant in a timezone (the clinic day). */
export const localDate = (timezone: string, at: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

async function validate(tx: Tx, key: Key, raw: unknown): Promise<string | number> {
  if (key === 'timezone') {
    if (typeof raw !== 'string' || raw.length > 64 || !validIntlZone(raw)) fail('VALIDATION_FAILED', 'timezone must be an IANA name such as Africa/Tunis', { field: 'timezone' });
    const pg = await tx.one<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS ok', [raw as string]);
    if (!pg.ok) fail('VALIDATION_FAILED', 'timezone is not known to the database', { field: 'timezone' });
    return raw as string;
  }
  const { min, max } = LIMITS[key];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) fail('VALIDATION_FAILED', `${key} must be an integer in [${min}, ${max}]`, { field: key });
  return raw as number;
}

export const settingsRoutes: Route[] = [
  {
    method: 'GET', path: '/api/v1/clinic/settings', permission: 'clinic.settings.read',
    handler: async ({ tx, actor }) => {
      const { settings, sources } = await load(tx, actor!.clinicId);
      return { status: 200, body: { settings, sources, defaults: DEFAULT_SETTINGS, limits: LIMITS, clinicToday: validIntlZone(settings.timezone) ? localDate(settings.timezone) : null } };
    },
  },
  {
    method: 'POST', path: '/api/v1/clinic/settings', permission: 'clinic.settings.manage', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const changes = asBody(b.changes ?? {});
      const keys = Object.keys(changes);
      if (!keys.length) fail('VALIDATION_FAILED', 'changes must name at least one setting', { field: 'changes' });
      for (const k of keys) if (!(k in COLUMN)) fail('VALIDATION_FAILED', `Unknown setting ${k}; configurable: ${Object.keys(COLUMN).join(', ')}`, { field: k });
      const reason = str(b, 'reason', { min: 3, max: 300 });
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('clinic_settings:' || $1))", [actor!.clinicId]);
      const { settings: current } = await load(tx, actor!.clinicId);
      const applied: Array<{ key: Key; from: unknown; to: unknown }> = [];
      for (const k of keys as Key[]) {
        const to = await validate(tx, k, changes[k]);
        const from = current[k];
        if (from === to) continue;
        if (k === 'timezone' && b.confirmTimezoneImpact !== true) {
          const v = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM visits WHERE clinic_id = $1', [actor!.clinicId]);
          if (v.n > 0) fail('CONFLICT', `This clinic has ${v.n} visits: day lists, receipts and reports will show their dates in ${to} from now on. Confirm with confirmTimezoneImpact: true.`, { visits: v.n, retryWith: { confirmTimezoneImpact: true } });
        }
        const row = await tx.one<{ id: string }>('INSERT INTO clinic_setting_changes (clinic_id, key, value, previous, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [actor!.clinicId, COLUMN[k], JSON.stringify(to), JSON.stringify(from), reason, actor!.staffId]);
        await appendAudit(tx, actor!, 'clinic.setting_changed', 'clinic_setting_change', row.id, { key: k, from, to, hasReason: true });
        applied.push({ key: k, from, to });
      }
      const after = await load(tx, actor!.clinicId);
      return { status: 200, body: { applied, settings: after.settings, sources: after.sources } };
    },
  },
  {
    method: 'GET', path: '/api/v1/clinic/settings/history', permission: 'clinic.settings.manage',
    handler: async ({ tx, actor }) => {
      const rows = (await tx.query<{ id: string; key: string; value: unknown; previous: unknown; reason: string; changed_at: string; name: string }>(
        `SELECT c.id, c.key, c.value, c.previous, c.reason, c.changed_at, s.display_name AS name FROM clinic_setting_changes c
           JOIN staff s ON s.clinic_id = c.clinic_id AND s.id = c.changed_by WHERE c.clinic_id = $1 ORDER BY c.changed_at DESC, c.id DESC LIMIT 200`, [actor!.clinicId])).rows;
      return { status: 200, body: { changes: rows.map(r => ({ id: r.id, key: KEY_OF[r.key] ?? r.key, from: r.previous, to: r.value, reason: r.reason, changedBy: r.name, changedAt: new Date(r.changed_at).toISOString() })) } };
    },
  },
];
