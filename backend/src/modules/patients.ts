/*
 * PATIENTS & SCHEDULING module: patient register (synthetic only), visits / appointments lifecycle.
 * Owns tables: patient_file_counters, patients, visits.
 *
 * Fraud-relevant rules: contact changes are audited with old+new values (a receptionist cannot silently
 * change a patient's phone, R24 trust boundary); a visit with confirmed care cannot be cancelled or marked
 * no-show; desk-marked NO_SHOW/CANCELLED visits surface to the owner (hidden-visit risk, CH-018);
 * only a DENTIST can mark a visit COMPLETED; NO_SHOW only once the appointment time has passed (B12).
 * Days are CLINIC-LOCAL (clinic setting "timezone", settings module), never UTC (B12, R73-C).
 */
import { advisoryLock, type Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr, oneOf, isoTime, isoDate, int, uuid, isUuid } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';
import { clinicDay, clinicTimezone } from './settings.ts';
import { patientNameKeySql as nameKey } from './patient-name.ts';

const NAME = { min: 1, max: 80 };
const PHONE = /^\+?[0-9 ]{6,20}$/;

/** The patient record as the API returns it (also the shape other modules read for headers). */
export interface PatientView {
  id: string; fileNo: number; familyName: string; givenName: string; nameAr: string | null; dateOfBirth: string | null; sex: string | null;
  phone: string | null; contactPreference: string; preferredLanguage: string; createdAt: string;
}

export async function getPatient(tx: Tx, id: string): Promise<PatientView> {
  if (!isUuid(id)) fail('NOT_FOUND', 'Patient not found');
  const p = await tx.maybeOne<PatientView>(`SELECT id, file_no AS "fileNo", family_name AS "familyName", given_name AS "givenName", name_ar AS "nameAr",
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
      // Duplicate warning (C-135 AC-REG-3; B12): for matching Latin names, known differing phones
      // or birth dates clear a match. Matching Arabic names always warn even when these hints differ:
      // transliterated Latin names may be different. Warn for manual identity review, never merge.
      const dup = await tx.query<{ id: string; file_no: number }>(
        `SELECT id, file_no FROM patients
         WHERE ((${nameKey("family_name")} = ${nameKey("$1::text")}
             AND ${nameKey("given_name")} = ${nameKey("$2::text")}
             AND (phone IS NULL OR $3::text IS NULL OR phone = $3)
             AND (date_of_birth IS NULL OR $4::date IS NULL OR date_of_birth = $4))
           OR ($5::text IS NOT NULL AND btrim($5::text) <> ''
             AND name_ar IS NOT NULL AND btrim(name_ar) <> ''
             AND ${nameKey("name_ar")} = ${nameKey("$5::text")}))
         ORDER BY file_no, id LIMIT 4`,
        [familyName, givenName, phone, dob, nameAr]);
      // Bound the disclosed list to three, but detect an additional match.
      // No manual override is safe when the returned list is incomplete.
      const tooManyPossibleDuplicates = dup.rowCount > 3;
      if (tooManyPossibleDuplicates || (dup.rowCount > 0 && b.confirmNotDuplicate !== true)) {
        fail('CONFLICT', 'A potentially matching patient exists; verify the file before creating a separate patient', {
          possibleDuplicates: dup.rows.slice(0, 3).map(r => ({ id: r.id, fileNo: r.file_no })),
          tooManyPossibleDuplicates,
          ...(tooManyPossibleDuplicates ? {} : { retryWith: { confirmNotDuplicate: true } }),
        });
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
      // Canonical literal substring matching (not LIKE) prevents %/_ wildcard expansion.
      // Keep Arabic name searchable and tolerate spaces/punctuation in a phone search.
      // Only birth year and last four phone digits are returned in bulk; full DOB needs a selected-file GET.
      const rows = (await tx.query(`SELECT id, file_no AS "fileNo", family_name AS "familyName", given_name AS "givenName",
          name_ar AS "nameAr", contact_preference AS "contactPreference",
          to_char(date_of_birth, 'YYYY') AS "birthYear",
          CASE WHEN phone IS NULL THEN NULL
               ELSE right(regexp_replace(phone, '[^0-9]', '', 'g'), 4) END AS "phoneLast4",
          EXISTS (SELECT 1 FROM patients other
                  WHERE other.id <> p.id
                    AND ((${nameKey("other.family_name")} = ${nameKey("p.family_name")}
                       AND ${nameKey("other.given_name")} = ${nameKey("p.given_name")})
                      OR (other.name_ar IS NOT NULL AND btrim(other.name_ar) <> ''
                        AND p.name_ar IS NOT NULL AND btrim(p.name_ar) <> ''
                        AND ${nameKey("other.name_ar")} = ${nameKey("p.name_ar")}))) AS "hasSameNameInClinic"
        FROM patients p
        WHERE $1 = ''
           OR strpos(${nameKey("family_name")}, ${nameKey("$1::text")}) > 0
           OR strpos(${nameKey("given_name")}, ${nameKey("$1::text")}) > 0
           OR strpos(${nameKey("given_name || ' ' || family_name")}, ${nameKey("$1::text")}) > 0
           OR strpos(${nameKey("coalesce(name_ar, '')")}, ${nameKey("$1::text")}) > 0
           OR file_no::text = $1
           OR (length(regexp_replace($1, '[^0-9]', '', 'g')) >= 6
               AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') =
                   regexp_replace($1, '[^0-9]', '', 'g'))
        ORDER BY family_name, given_name, file_no LIMIT 50`, [q])).rows;
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
      const before = await getPatient(tx, params.id!);
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
      // Serialize check + insert for this clinic/dentist, including an empty calendar.
      if (dentistId) await advisoryLock(tx, 'visit_schedule', actor!.clinicId + ':' + dentistId);
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
      if (to === 'NO_SHOW' && new Date(v.scheduled_at).getTime() > Date.now()) fail('CONFLICT', 'A visit cannot be marked no-show before its appointment time; cancel it with a reason instead', { reason: 'NO_SHOW_BEFORE_START' });
      if (to === 'NO_SHOW' || to === 'CANCELLED') {
        const care = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM care_items WHERE visit_id = $1', [v.id]);
        if (care.n > 0) fail('CONFLICT', 'Visit has dentist-confirmed care; it cannot be cancelled or marked no-show', { reason: 'VISIT_HAS_DOCUMENTED_CARE' });
        // CH-018: signed clinical documentation means the patient was seen; the desk cannot erase that visit.
        const doc = await tx.one<{ n: number }>(`SELECT ((SELECT count(*) FROM clinical_notes WHERE visit_id = $1)
            + (SELECT count(*) FROM chart_findings WHERE visit_id = $1))::int AS n`, [v.id]);
        if (doc.n > 0) fail('CONFLICT', 'The dentist has documented this visit; it cannot be cancelled or marked no-show', { reason: 'VISIT_HAS_DOCUMENTED_CARE' });
      }
      await tx.query('UPDATE visits SET status = $2, status_changed_at = now(), status_changed_by = $3, status_reason = $4 WHERE id = $1', [v.id, to, actor!.staffId, reason]);
      await appendAudit(tx, actor!, 'visit.status_changed', 'visit', v.id, { from: v.status, to, reason });
      return { status: 200, body: { visit: { id: v.id, status: to } } };
    },
  },
];
