/*
 * PATIENTS & SCHEDULING module: patient register (synthetic only), visits / appointments lifecycle.
 * Owns tables: patient_file_counters, patients, visits.
 *
 * Fraud-relevant rules: contact changes are audited with old+new values (a receptionist cannot silently
 * change a patient's phone, R24 trust boundary); a visit with confirmed care cannot be cancelled or marked
 * no-show; desk-marked NO_SHOW/CANCELLED visits surface to the owner (hidden-visit risk, CH-018);
 * only a DENTIST can mark a visit COMPLETED; NO_SHOW only once the appointment time has passed (B12).
 * Days are CLINIC-LOCAL (clinics.settings.timezone, default Africa/Tunis), never UTC (B12).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr, oneOf, isoTime, isoDate, int, uuid, isUuid } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';

const NAME = { min: 1, max: 80 };
export const DEFAULT_TIMEZONE = 'Africa/Tunis';

/** The clinic's IANA timezone. An invalid setting fails loudly instead of silently using UTC. */
export async function clinicTimezone(tx: Tx, clinicId: string): Promise<string> {
  const c = await tx.one<{ tz: string | null }>("SELECT settings->>'timezone' AS tz FROM clinics WHERE id = $1", [clinicId]);
  const tz = c.tz ?? DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { fail('CONFLICT', `Clinic timezone setting "${tz}" is not a valid IANA timezone; fix the clinic settings`); }
  return tz;
}

/** A clinic-local calendar day from a query parameter (default: today in that timezone). */
export function clinicDay(query: URLSearchParams, tz: string): string {
  const day = query.get('day') ?? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const t = Date.parse(day + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) fail('VALIDATION_FAILED', 'day must be a real date YYYY-MM-DD', { field: 'day' });
  return day;
}
const PHONE = /^\+?[0-9 ]{6,20}$/;

export async function getPatient(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Patient not found');
  const p = await tx.maybeOne(`SELECT id, file_no AS "fileNo", family_name AS "familyName", given_name AS "givenName", name_ar AS "nameAr",
      date_of_birth::text AS "dateOfBirth", sex, phone, contact_preference AS "contactPreference", preferred_language AS "preferredLanguage", created_at AS "createdAt"
    FROM patients WHERE id = $1`, [id]);
  if (!p) fail('NOT_FOUND', 'Patient not found');
  return p!;
}

export async function getVisitForUpdate(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Visit not found');
  const v = await tx.maybeOne<{ id: string; patient_id: string; status: string; dentist_id: string | null; scheduled_at: string }>(
    'SELECT id, patient_id, status, dentist_id, scheduled_at FROM visits WHERE id = $1 FOR UPDATE', [id]);
  if (!v) fail('NOT_FOUND', 'Visit not found');
  return v!;
}

export async function getVisit(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Visit not found');
  const v = await tx.maybeOne<{ id: string; patient_id: string; status: string }>('SELECT id, patient_id, status FROM visits WHERE id = $1', [id]);
  if (!v) fail('NOT_FOUND', 'Visit not found');
  return v!;
}

const DESK_TRANSITIONS: Record<string, string[]> = {
  SCHEDULED: ['ARRIVED', 'NO_SHOW', 'CANCELLED'],
  ARRIVED: ['IN_CHAIR', 'CANCELLED'],
  IN_CHAIR: [],
  COMPLETED: [],
  NO_SHOW: [],
  CANCELLED: [],
};

export const patientRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/patients', permission: 'patient.create', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const familyName = str(b, 'familyName', NAME);
      const givenName = str(b, 'givenName', NAME);
      const nameAr = optStr(b, 'nameAr', { max: 160 });
      const dob = isoDate(b, 'dateOfBirth', true);
      const sex = oneOf(b, 'sex', ['F', 'M', 'X'] as const, true);
      const phone = optStr(b, 'phone', { max: 20, pattern: PHONE });
      const contactPreference = oneOf(b, 'contactPreference', ['IN_PERSON', 'BASIC_PHONE_CALL', 'SMS', 'NONE'] as const, true) ?? 'IN_PERSON';
      const lang = oneOf(b, 'preferredLanguage', ['fr', 'ar'] as const, true) ?? 'fr';
      if ((contactPreference === 'SMS' || contactPreference === 'BASIC_PHONE_CALL') && !phone) fail('VALIDATION_FAILED', 'phone required for the chosen contact preference', { field: 'phone' });
      if (b.isSynthetic !== true) fail('VALIDATION_FAILED', 'isSynthetic must be true: this build accepts FICTIONAL patients only', { field: 'isSynthetic' });
      await tx.query('INSERT INTO patient_file_counters (clinic_id) VALUES ($1) ON CONFLICT DO NOTHING', [actor!.clinicId]);
      const c = await tx.one<{ next_no: number }>('SELECT next_no FROM patient_file_counters WHERE clinic_id = $1 FOR UPDATE', [actor!.clinicId]);
      await tx.query('UPDATE patient_file_counters SET next_no = next_no + 1 WHERE clinic_id = $1', [actor!.clinicId]);
      // Duplicate warning (C-135 AC-REG-3; B12): same normalised name, unless both phones are known and differ, or both
      // birth dates are known and differ. A missing phone never clears the warning (elderly / no-phone patients). Warn, never merge.
      const dup = await tx.query<{ id: string; file_no: number }>(
        `SELECT id, file_no FROM patients WHERE lower(family_name) = lower($1) AND lower(given_name) = lower($2)
           AND (phone IS NULL OR $3::text IS NULL OR phone = $3) AND (date_of_birth IS NULL OR $4::date IS NULL OR date_of_birth = $4) LIMIT 3`,
        [familyName, givenName, phone, dob]);
      if (dup.rowCount > 0 && b.confirmNotDuplicate !== true) {
        fail('CONFLICT', 'A patient with the same name and phone exists; confirm it is a different person', { possibleDuplicates: dup.rows.map(r => ({ id: r.id, fileNo: r.file_no })), retryWith: { confirmNotDuplicate: true } });
      }
      const p = await tx.one<{ id: string }>(`INSERT INTO patients (clinic_id, file_no, family_name, given_name, name_ar, date_of_birth, sex, phone, contact_preference, preferred_language, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [actor!.clinicId, c.next_no, familyName, givenName, nameAr, dob, sex, phone, contactPreference, lang, actor!.staffId]);
      await appendAudit(tx, actor!, 'patient.created', 'patient', p.id, { fileNo: c.next_no });
      return { status: 201, body: { patient: await getPatient(tx, p.id) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/patients', permission: 'patient.read',
    handler: async ({ tx, query }) => {
      const q = (query.get('q') ?? '').trim().slice(0, 80);
      const rows = (await tx.query(`SELECT id, file_no AS "fileNo", family_name AS "familyName", given_name AS "givenName", name_ar AS "nameAr", contact_preference AS "contactPreference"
        FROM patients WHERE $1 = '' OR lower(family_name) LIKE lower($1) || '%' OR lower(given_name) LIKE lower($1) || '%' OR file_no::text = $1 OR phone = $1
        ORDER BY family_name, given_name LIMIT 50`, [q])).rows;
      return { status: 200, body: { patients: rows } };
    },
  },
  {
    method: 'GET', path: '/api/v1/patients/:id', permission: 'patient.read',
    handler: async ({ tx, params }) => ({ status: 200, body: { patient: await getPatient(tx, params.id!) } }),
  },
  {
    method: 'POST', path: '/api/v1/patients/:id/contact', permission: 'patient.update_contact', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const before = await getPatient(tx, params.id!) as Record<string, unknown>;
      const phone = optStr(b, 'phone', { max: 20, pattern: PHONE });
      const pref = oneOf(b, 'contactPreference', ['IN_PERSON', 'BASIC_PHONE_CALL', 'SMS', 'NONE'] as const)!;
      const reason = str(b, 'reason', { min: 3, max: 200 });
      await tx.query('UPDATE patients SET phone = $2, contact_preference = $3 WHERE id = $1', [params.id!, phone, pref]);
      await appendAudit(tx, actor!, 'patient.contact_changed', 'patient', params.id!, {
        before: { phone: before.phone ?? null, contactPreference: before.contactPreference }, after: { phone, contactPreference: pref }, reason,
      });
      return { status: 200, body: { patient: await getPatient(tx, params.id!) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/visits', permission: 'visit.schedule', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const patientId = uuid(b, 'patientId');
      await getPatient(tx, patientId);
      const scheduledAt = isoTime(b, 'scheduledAt');
      const duration = int(b, 'durationMin', 5, 480, true) ?? 30;
      const dentistId = uuid(b, 'dentistId', true) || null;
      if (dentistId) {
        const d = await tx.maybeOne(`SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id = s.id AND r.role = 'DENTIST' WHERE s.id = $1 AND s.active`, [dentistId]);
        if (!d) fail('VALIDATION_FAILED', 'dentistId is not an active dentist of this clinic', { field: 'dentistId' });
      }
      // Overlap warning for the same dentist (C-135 AC-APP-3), never silent.
      const overlap = dentistId ? await tx.query(`SELECT id FROM visits WHERE dentist_id = $1 AND status NOT IN ('CANCELLED','NO_SHOW')
          AND tstzrange(scheduled_at, scheduled_at + make_interval(mins => duration_min)) && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3))`, [dentistId, scheduledAt, duration]) : { rowCount: 0, rows: [] };
      if (overlap.rowCount > 0 && b.allowOverlap !== true) fail('CONFLICT', 'The dentist already has a visit in this slot', { overlapping: overlap.rows, retryWith: { allowOverlap: true } });
      const v = await tx.one<{ id: string }>(`INSERT INTO visits (clinic_id, patient_id, dentist_id, scheduled_at, duration_min, created_by, status_changed_by)
        VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`, [actor!.clinicId, patientId, dentistId, scheduledAt, duration, actor!.staffId]);
      await appendAudit(tx, actor!, 'visit.scheduled', 'visit', v.id, { patientId, scheduledAt, dentistId, durationMin: duration });
      return { status: 201, body: { visit: { id: v.id, patientId, scheduledAt, dentistId, durationMin: duration, status: 'SCHEDULED' } } };
    },
  },
  {
    method: 'GET', path: '/api/v1/visits', permission: 'visit.read',
    handler: async ({ tx, actor, query }) => {
      const timezone = await clinicTimezone(tx, actor!.clinicId);
      const day = clinicDay(query, timezone);
      const rows = (await tx.query(`SELECT v.id, v.patient_id AS "patientId", p.file_no AS "fileNo", p.family_name AS "familyName", p.given_name AS "givenName",
          v.dentist_id AS "dentistId", v.scheduled_at AS "scheduledAt", v.duration_min AS "durationMin", v.status,
          (SELECT count(*)::int FROM care_items c WHERE c.visit_id = v.id) AS "careItemCount"
        FROM visits v JOIN patients p ON p.id = v.patient_id
        WHERE v.scheduled_at >= $1::date::timestamp AT TIME ZONE $2 AND v.scheduled_at < ($1::date + 1)::timestamp AT TIME ZONE $2
        ORDER BY v.scheduled_at`, [day, timezone])).rows;
      return { status: 200, body: { day, timezone, visits: rows } };
    },
  },
  {
    method: 'POST', path: '/api/v1/visits/:id/status', permission: 'visit.desk_status', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const to = oneOf(b, 'status', ['ARRIVED', 'IN_CHAIR', 'NO_SHOW', 'CANCELLED'] as const)!;
      const reason = (to === 'NO_SHOW' || to === 'CANCELLED') ? str(b, 'reason', { min: 3, max: 200 }) : optStr(b, 'reason', { max: 200 });
      const v = await getVisitForUpdate(tx, params.id!);
      if (!DESK_TRANSITIONS[v.status]!.includes(to)) fail('CONFLICT', `Cannot change visit from ${v.status} to ${to}`);
      // A no-show is a fact about a time that has passed; recording it in advance would hide a visit (CH-018).
      if (to === 'NO_SHOW' && new Date(v.scheduled_at).getTime() > Date.now()) fail('CONFLICT', 'A visit cannot be marked no-show before its appointment time; cancel it with a reason instead');
      if (to === 'NO_SHOW' || to === 'CANCELLED') {
        const care = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM care_items WHERE visit_id = $1', [v.id]);
        if (care.n > 0) fail('CONFLICT', 'Visit has dentist-confirmed care; it cannot be cancelled or marked no-show');
      }
      await tx.query('UPDATE visits SET status = $2, status_changed_at = now(), status_changed_by = $3, status_reason = $4 WHERE id = $1', [v.id, to, actor!.staffId, reason]);
      await appendAudit(tx, actor!, 'visit.status_changed', 'visit', v.id, { from: v.status, to, reason });
      return { status: 200, body: { visit: { id: v.id, status: to } } };
    },
  },
];
