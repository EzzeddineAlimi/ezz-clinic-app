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
import { advisoryLock, type Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, isUuid } from '../platform/validate.ts';
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

/** Local wall-clock minutes, including seconds, from a real instant; one timezone authority for scheduling. */
export function localClockMinutes(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return value('hour') * 60 + value('minute') + value('second') / 60 + at.getUTCMilliseconds() / 60_000;
}

/** A clinic-local calendar day from a query parameter (default: today in that timezone). */
export function clinicDay(query: URLSearchParams, tz: string): string {
  const day = query.get('day') ?? localDate(tz);
  const t = Date.parse(day + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) fail('VALIDATION_FAILED', 'day must be a real date YYYY-MM-DD', { field: 'day' });
  return day;
}

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
      await advisoryLock(tx, 'clinic_settings', actor!.clinicId);
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
        if (k === 'timezone') {
          // The calendar and visit writers use the same lock, so a zone change cannot silently
          // invalidate future bookings under a configured U014 calendar.
          await advisoryLock(tx, 'clinic_calendar', actor!.clinicId);
          const calendar = await loadCalendar(tx, actor!.clinicId);
          const incompatible = await incompatibleFutureVisits(tx, actor!.clinicId, calendar, String(to));
          if (incompatible > 0) fail('CONFLICT', 'Timezone change would put existing future visits outside clinic hours', { reason: 'EXISTING_VISITS', visits: incompatible });
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

/*
 * U014: one append-only clinic calendar snapshot in clinic_setting_changes, key clinic_calendar.
 * Weekly windows are Sunday-first, local HH:mm; closed dates are explicitly entered, never inferred.
 * Null weeklyHours means unconfigured (legacy booking behavior). A configured empty day is closed.
 */
type OpeningWindow = { start: string; end: string };
interface CalendarPolicy { weeklyHours: OpeningWindow[][] | null; closedDays: string[] }
type CalendarSnapshot = CalendarPolicy & { revision: string | null };
const DEFAULT_CALENDAR: CalendarPolicy = { weeklyHours: null, closedDays: [] };
const HHMM = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const END_HHMM = /^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
const clockMinutes = (s: string) => { const [h, m] = s.split(':').map(Number); return h! * 60 + m!; };

async function loadCalendar(tx: Tx, clinicId: string): Promise<CalendarSnapshot> {
  const row = await tx.maybeOne<{ id: string; value: CalendarPolicy }>(
    "SELECT id, value FROM clinic_setting_changes WHERE clinic_id = $1 AND key = 'clinic_calendar' ORDER BY changed_at DESC, id DESC LIMIT 1", [clinicId]);
  const policy = row?.value ?? DEFAULT_CALENDAR;
  return { weeklyHours: policy.weeklyHours, closedDays: policy.closedDays, revision: row?.id ?? null };
}

function validateCalendar(b: Record<string, unknown>): CalendarPolicy {
  if (!Object.hasOwn(b, 'weeklyHours') || !Object.hasOwn(b, 'closedDays')) fail('VALIDATION_FAILED', 'weeklyHours and closedDays are required');
  let weeklyHours: OpeningWindow[][] | null = null;
  if (b.weeklyHours !== null) {
    if (!Array.isArray(b.weeklyHours) || b.weeklyHours.length !== 7) fail('VALIDATION_FAILED', 'weeklyHours must be null or seven Sunday-first day arrays', { field: 'weeklyHours' });
    weeklyHours = (b.weeklyHours as unknown[]).map((rawDay, dayIndex) => {
      if (!Array.isArray(rawDay) || rawDay.length > 4) fail('VALIDATION_FAILED', 'Each day must have zero to four opening windows', { field: 'weeklyHours', dayIndex });
      let previousEnd = 0;
      return (rawDay as unknown[]).map(raw => {
        const w = asBody(raw);
        const start = str(w, 'start', { min: 5, max: 5, pattern: HHMM });
        const end = str(w, 'end', { min: 5, max: 5, pattern: END_HHMM });
        const from = clockMinutes(start), to = clockMinutes(end);
        if (from >= to || from < previousEnd) fail('VALIDATION_FAILED', 'Opening windows must be sorted, non-overlapping, and within one day', { field: 'weeklyHours', dayIndex });
        previousEnd = to;
        return { start, end };
      });
    });
  }
  if (!Array.isArray(b.closedDays) || b.closedDays.length > 366) fail('VALIDATION_FAILED', 'closedDays must be at most 366 manually confirmed dates', { field: 'closedDays' });
  const closedDays = (b.closedDays as unknown[]).map(raw => {
    if (typeof raw !== 'string') fail('VALIDATION_FAILED', 'closedDays entries must be YYYY-MM-DD', { field: 'closedDays' });
    clinicDay(new URLSearchParams({ day: raw as string }), 'UTC');
    return raw as string;
  });
  if (new Set(closedDays).size !== closedDays.length) fail('VALIDATION_FAILED', 'closedDays must not contain duplicate dates', { field: 'closedDays' });
  return { weeklyHours, closedDays: closedDays.sort() };
}

type SlotProblem = 'CLINIC_CLOSED' | 'OUTSIDE_OPENING_HOURS';
function slotProblem(calendar: CalendarPolicy, timezone: string, scheduledAt: string, durationMin: number): SlotProblem | null {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const day = localDate(timezone, start);
  const lastDay = localDate(timezone, new Date(end.getTime() - 1));
  if (calendar.closedDays.includes(day) || calendar.closedDays.includes(lastDay)) return 'CLINIC_CLOSED';
  if (calendar.weeklyHours === null) return null;
  if (lastDay !== day) return 'OUTSIDE_OPENING_HOURS'; // No unreviewed overnight hours.
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  const from = localClockMinutes(timezone, start);
  const to = localDate(timezone, end) === day ? localClockMinutes(timezone, end) : 1440;
  if (to <= from) return 'OUTSIDE_OPENING_HOURS'; // Fail closed across a repeated DST hour.
  return calendar.weeklyHours[weekday]!.some(w => from >= clockMinutes(w.start) && to <= clockMinutes(w.end))
    ? null : 'OUTSIDE_OPENING_HOURS';
}

async function incompatibleFutureVisits(tx: Tx, clinicId: string, calendar: CalendarPolicy, timezone: string): Promise<number> {
  const rows = (await tx.query<{ scheduled_at: string; duration_min: number }>(
    "SELECT scheduled_at, duration_min FROM visits WHERE clinic_id = $1 AND scheduled_at >= now() AND status NOT IN ('CANCELLED','NO_SHOW')", [clinicId])).rows;
  return rows.filter(v => slotProblem(calendar, timezone, v.scheduled_at, v.duration_min) !== null).length;
}

/** Called after clinic_calendar advisoryLock; an overlap override NEVER overrides a closed clinic. */
export async function assertClinicOpen(tx: Tx, clinicId: string, scheduledAt: string, durationMin: number): Promise<void> {
  const calendar = await loadCalendar(tx, clinicId);
  const timezone = await clinicTimezone(tx, clinicId);
  const problem = slotProblem(calendar, timezone, scheduledAt, durationMin);
  if (problem) fail('CONFLICT', problem === 'CLINIC_CLOSED' ? 'The clinic is closed on this date' : 'Appointment is outside configured clinic opening hours',
    { reason: problem });
}

export const calendarRoutes: Route[] = [
  {
    method: 'GET', path: '/api/v1/clinic/schedule', permission: 'visit.read',
    handler: async ({ tx, actor }) => {
      const calendar = await loadCalendar(tx, actor!.clinicId);
      return { status: 200, body: { ...calendar, timezone: await clinicTimezone(tx, actor!.clinicId) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/clinic/schedule', permission: 'visit.schedule', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      if (!Object.hasOwn(b, 'expectedRevision') || (b.expectedRevision !== null &&
          (typeof b.expectedRevision !== 'string' || !isUuid(b.expectedRevision)))) {
        fail('VALIDATION_FAILED', 'expectedRevision must be the revision from GET, or null for the first change', { field: 'expectedRevision' });
      }
      const reason = str(b, 'reason', { min: 3, max: 300 });
      const next = validateCalendar(b);
      await advisoryLock(tx, 'clinic_calendar', actor!.clinicId);
      const current = await loadCalendar(tx, actor!.clinicId);
      if (b.expectedRevision !== current.revision) fail('CONFLICT', 'Clinic calendar was changed by another staff member; refresh before saving',
        { reason: 'STALE_REVISION' });
      const previous: CalendarPolicy = { weeklyHours: current.weeklyHours, closedDays: current.closedDays };
      if (JSON.stringify(previous) === JSON.stringify(next)) {
        return { status: 200, body: { ...current, timezone: await clinicTimezone(tx, actor!.clinicId) } };
      }
      const timezone = await clinicTimezone(tx, actor!.clinicId);
      const incompatible = await incompatibleFutureVisits(tx, actor!.clinicId, next, timezone);
      if (incompatible > 0) fail('CONFLICT', 'Existing future appointments must be rescheduled before closing these hours',
        { reason: 'EXISTING_VISITS', visits: incompatible });
      const row = await tx.one<{ id: string }>(
        "INSERT INTO clinic_setting_changes (clinic_id, key, value, previous, reason, changed_by) VALUES ($1, 'clinic_calendar', $2::jsonb, $3::jsonb, $4, $5) RETURNING id",
        [actor!.clinicId, JSON.stringify(next), JSON.stringify(previous), reason, actor!.staffId]);
      await appendAudit(tx, actor!, 'clinic.setting_changed', 'clinic_setting_change', row.id,
        { key: 'clinic_calendar', from: previous, to: next, hasReason: true });
      return { status: 200, body: { ...next, revision: row.id, timezone } };
    },
  },
];
