/*
 * DAY-BOARD module (B12): the clinic's working list for one clinic-local day. Read-only; owns no tables.
 * Depends on: settings (clinic timezone / day), identity (role checks for field visibility).
 *
 * Shape rules:
 *  - one statement for the whole day whatever the number of visits (no N+1), plus one for the clinic timezone;
 *  - a DENTIST sees their own and unassigned visits by default (scope=mine); scope=all shows everyone's;
 *  - phone numbers never appear on the board (hasPhone only); elderly / no-phone patients are flagged so the desk
 *    knows the only channel is in person; same-name patients carry the other file numbers so the right file is opened;
 *  - balances only for roles that may read payments; desk-written status reasons only for roles that may set them.
 * Wording is operational, never a judgement about a person.
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { isUuid } from '../platform/validate.ts';
import { can } from './identity.ts';
import { clinicDay, clinicSettings } from './settings.ts';


type Row = {
  id: string; scheduledAt: string; localTime: string; durationMin: number; status: string; statusChangedAt: string; waitingMinutes: number | null;
  statusReason: string | null; deskMarked: boolean; notArrived: boolean; overlap: boolean;
  patientId: string; fileNo: number; familyName: string; givenName: string; nameAr: string | null; preferredLanguage: string; contactPreference: string; hasPhone: boolean;
  sameNameFileNos: number[] | null; dentistId: string | null; dentistName: string | null; careItemCount: number; balanceDueMillimes: number;
};

export async function dayBoard(tx: Tx, actor: Actor, query: URLSearchParams) {
  const { timezone, notArrivedGraceMinutes } = await clinicSettings(tx, actor.clinicId);
  const day = clinicDay(query, timezone);
  const isDentist = actor.roles.includes('DENTIST');
  const scope = query.get('scope') ?? (isDentist ? 'mine' : 'all');
  if (scope !== 'mine' && scope !== 'all') fail('VALIDATION_FAILED', 'scope must be mine or all', { field: 'scope' });
  if (scope === 'mine' && !isDentist) fail('VALIDATION_FAILED', 'scope=mine is for dentists', { field: 'scope' });
  const dentistId = query.get('dentistId');
  if (dentistId !== null && !isUuid(dentistId)) fail('VALIDATION_FAILED', 'dentistId must be a UUID', { field: 'dentistId' });

  const rows = (await tx.query<Row>(`SELECT v.id, v.scheduled_at AS "scheduledAt", to_char(v.scheduled_at AT TIME ZONE $4, 'HH24:MI') AS "localTime",
      v.duration_min AS "durationMin", v.status, v.status_changed_at AS "statusChangedAt",
      CASE WHEN v.status IN ('ARRIVED','IN_CHAIR') THEN floor(extract(epoch FROM now() - v.status_changed_at) / 60)::int END AS "waitingMinutes",
      v.status_reason AS "statusReason",
      (v.status IN ('NO_SHOW','CANCELLED') AND NOT EXISTS (SELECT 1 FROM staff_roles r WHERE r.clinic_id = v.clinic_id AND r.staff_id = v.status_changed_by AND r.role IN ('DENTIST','OWNER'))) AS "deskMarked",
      (v.status = 'SCHEDULED' AND now() > v.scheduled_at + make_interval(mins => $7)) AS "notArrived",
      (v.dentist_id IS NOT NULL AND v.status NOT IN ('CANCELLED','NO_SHOW') AND EXISTS (SELECT 1 FROM visits o WHERE o.clinic_id = v.clinic_id AND o.id <> v.id
        AND o.dentist_id = v.dentist_id AND o.status NOT IN ('CANCELLED','NO_SHOW')
        AND tstzrange(o.scheduled_at, o.scheduled_at + make_interval(mins => o.duration_min)) && tstzrange(v.scheduled_at, v.scheduled_at + make_interval(mins => v.duration_min)))) AS overlap,
      p.id AS "patientId", p.file_no AS "fileNo", p.family_name AS "familyName", p.given_name AS "givenName", p.name_ar AS "nameAr",
      p.preferred_language AS "preferredLanguage", p.contact_preference AS "contactPreference", p.phone IS NOT NULL AS "hasPhone",
      sn.file_nos AS "sameNameFileNos", d.id AS "dentistId", d.display_name AS "dentistName",
      (SELECT count(*)::int FROM care_items c WHERE c.clinic_id = v.clinic_id AND c.visit_id = v.id) AS "careItemCount",
      (b.charged_millimes - b.paid_millimes - b.reduced_millimes + b.returned_millimes)::bigint AS "balanceDueMillimes"
    FROM visits v
    JOIN patients p ON p.clinic_id = v.clinic_id AND p.id = v.patient_id
    LEFT JOIN staff d ON d.clinic_id = v.clinic_id AND d.id = v.dentist_id
    LEFT JOIN visit_balances b ON b.visit_id = v.id
    LEFT JOIN LATERAL (SELECT jsonb_agg(o.file_no ORDER BY o.file_no) AS file_nos FROM patients o WHERE o.clinic_id = p.clinic_id AND o.id <> p.id
        AND lower(o.family_name) = lower(p.family_name) AND lower(o.given_name) = lower(p.given_name)) sn ON true
    WHERE v.clinic_id = $1 AND v.scheduled_at >= $2::date::timestamp AT TIME ZONE $4 AND v.scheduled_at < ($2::date + 1)::timestamp AT TIME ZONE $4
      AND ($3::uuid IS NULL OR v.dentist_id = $3::uuid)
      AND (NOT $5::boolean OR v.dentist_id = $6::uuid OR v.dentist_id IS NULL)
    ORDER BY v.scheduled_at, v.id`, [actor.clinicId, day, dentistId, timezone, scope === 'mine', actor.staffId, notArrivedGraceMinutes])).rows;

  const seesMoney = can(actor, 'payment.read');
  const seesReasons = can(actor, 'visit.desk_status');
  const byStatus: Record<string, number> = {};
  const visits = rows.map(r => {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const flags: string[] = [];
    if (!r.hasPhone || r.contactPreference === 'IN_PERSON' || r.contactPreference === 'NONE') flags.push('IN_PERSON_CONTACT_ONLY');
    if (r.sameNameFileNos?.length) flags.push('SAME_NAME_OTHER_FILE');
    if (r.notArrived) flags.push('NOT_ARRIVED_PAST_START');
    if (r.deskMarked) flags.push('DESK_MARKED');
    if (r.overlap) flags.push('OVERLAPS_SAME_DENTIST');
    return {
      id: r.id, scheduledAt: r.scheduledAt, localTime: r.localTime, durationMin: r.durationMin, status: r.status, statusChangedAt: r.statusChangedAt,
      waitingMinutes: r.waitingMinutes,
      patient: { id: r.patientId, fileNo: r.fileNo, familyName: r.familyName, givenName: r.givenName, nameAr: r.nameAr, preferredLanguage: r.preferredLanguage,
        contactPreference: r.contactPreference, hasPhone: r.hasPhone, sameNameFileNos: r.sameNameFileNos ?? [] },
      dentist: r.dentistId ? { id: r.dentistId, name: r.dentistName } : null,
      careItemCount: r.careItemCount,
      hasStatusReason: r.statusReason !== null,
      ...(seesReasons ? { statusReason: r.statusReason } : {}),
      ...(seesMoney ? { balanceDueMillimes: Number(r.balanceDueMillimes) } : {}),
      flags,
    };
  });
  return {
    day, timezone, scope, dentistId,
    summary: { total: visits.length, byStatus, notArrivedPastStart: visits.filter(v => v.flags.includes('NOT_ARRIVED_PAST_START')).length },
    visits,
  };
}

export const dayBoardRoutes: Route[] = [
  {
    method: 'GET', path: '/api/v1/day-board', permission: 'visit.read',
    handler: async ({ tx, actor, query }) => ({ status: 200, body: await dayBoard(tx, actor!, query) }),
  },
];
