/*
 * CLINICAL-CARE module (financially relevant part): dentist-confirmed care and fee (MF12 / CH-012), and
 * dentist-signed site amendments (CH-032 / C-172). Owns tables: care_items, care_site_amendments, view
 * care_effective_sites. Read by BILLING for balances (read-only dependency). Depends on: audit, patients,
 * medical (treatment gate).
 *
 * Rules: only an authenticated DENTIST session can confirm or correct care or amend its site; identity comes
 * from the session (body fields like role/actor are ignored, T-CARE-4); confirmation is immutable; a fee
 * change is a CORRECTION row (delta + reason + link to original); free care is an explicit dentist act with
 * reason; confirming care marks the visit COMPLETED (dentist act). The fee note is dentist-authored
 * (Code de déontologie Art. 31 as read in CH-005; legal interpretation UNVERIFIED).
 * Sites go through ONE validator (contracts/clinical.ts readDentalSite) and are stored canonically.
 * A wrong tooth/surface is fixed by a SITE AMENDMENT: a separate append-only row with no money column, so a
 * clinical correction can never change a fee or balance; fee corrections stay a separate act.
 * If the patient has active medical alerts, care is refused until the dentist has seen the current set.
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { AppError, fail } from '../platform/errors.ts';
import { asBody, str, optStr, millimes, uuid, bool, oneOf, isUuid } from '../platform/validate.ts';
import { readDentalSite, sameSite, type DentalSite } from '../contracts/clinical.ts';
import { appendAudit } from './audit.ts';
import { getVisitForUpdate, getVisit } from './patients.ts';
import { requireAlertsAcknowledged, readAlertSetHash } from './medical.ts';

export function validFdi(t: number): boolean {
  const q = Math.floor(t / 10), n = t % 10;
  return (q >= 1 && q <= 4 && n >= 1 && n <= 8) || (q >= 5 && q <= 8 && n >= 1 && n <= 5);
}

export const SITE_AMENDMENT_REASONS = ['WRONG_TOOTH', 'WRONG_SURFACE', 'WRONG_TOOTH_AND_SURFACE', 'TRANSCRIPTION', 'OTHER'] as const;

export async function visitCareTotal(tx: Tx, visitId: string): Promise<number> {
  const r = await tx.one<{ total: number }>('SELECT coalesce(sum(fee_millimes), 0)::bigint AS total FROM care_items WHERE visit_id = $1', [visitId]);
  return r.total;
}

/**
 * Care rows of a visit. CARE rows carry their effective site (after amendments) next to the original site,
 * plus the amendment history; CORRECTION rows keep the site they were written with.
 */
export async function listCare(tx: Tx, visitId: string) {
  const items = (await tx.query<Record<string, unknown> & { id: string; kind: string }>(`SELECT c.id, c.kind, c.corrects_id AS "correctsId", c.procedure_code AS "procedureCode", c.procedure_label AS "procedureLabel",
      c.tooth_fdi AS "toothFdi", c.surfaces, e.tooth_fdi AS "effectiveToothFdi", e.surfaces AS "effectiveSurfaces",
      coalesce(e.amendment_count, 0) AS "amendmentCount", c.fee_millimes AS "feeMillimes", c.reason, c.confirmed_by AS "confirmedBy",
      s.display_name AS "confirmedByName", c.confirmed_at AS "confirmedAt"
    FROM care_items c JOIN staff s ON s.id = c.confirmed_by LEFT JOIN care_effective_sites e ON e.care_item_id = c.id
    WHERE c.visit_id = $1 ORDER BY c.confirmed_at, c.id`, [visitId])).rows;
  const amendments = await listSiteAmendments(tx, visitId);
  return items.map(i => i.kind === 'CARE'
    ? { ...i, siteAmended: (i.amendmentCount as number) > 0, siteAmendments: amendments.filter(a => a.careItemId === i.id) }
    : { ...i, effectiveToothFdi: undefined, effectiveSurfaces: undefined, amendmentCount: undefined });
}

export async function listSiteAmendments(tx: Tx, visitId: string) {
  return (await tx.query<{ careItemId: string } & Record<string, unknown>>(`SELECT a.id, a.care_item_id AS "careItemId", a.supersedes_id AS "supersedesId",
      json_build_object('toothFdi', a.previous_tooth_fdi, 'surfaces', a.previous_surfaces) AS "previousSite",
      json_build_object('toothFdi', a.tooth_fdi, 'surfaces', a.surfaces) AS "newSite",
      a.reason_code AS "reasonCode", a.reason_note AS "reasonNote", a.amended_by AS "amendedBy", s.display_name AS "amendedByName", a.amended_at AS "amendedAt"
    FROM care_site_amendments a JOIN staff s ON s.clinic_id = a.clinic_id AND s.id = a.amended_by
    WHERE a.visit_id = $1 ORDER BY a.amended_at, a.id`, [visitId])).rows;
}

export interface ConfirmCareInput {
  procedureCode: string; procedureLabel: string; site: DentalSite; feeMillimes: number; reason: string | null;
  confirmRepeat: boolean; alertSetHash: string | null; via: 'CARE_CONFIRMATION' | 'PLAN_PERFORM';
}

/**
 * Confirm one CARE item on a visit the caller has ALREADY locked (getVisitForUpdate). Shared by the care
 * route and the treatment-plan "perform" route so both apply the same duplicate guard, alert gate and audit.
 */
export async function confirmCareItem(tx: Tx, actor: Actor, v: { id: string; patient_id: string; status: string }, input: ConfirmCareInput) {
  if (v.status === 'CANCELLED' || v.status === 'NO_SHOW') fail('CONFLICT', `Visit is ${v.status}; care cannot be confirmed`);
  if (input.feeMillimes === 0 && (!input.reason || input.reason.length < 3)) fail('VALIDATION_FAILED', 'Free care (fee 0) requires a reason', { field: 'reason' });
  // Duplicate guard on the EFFECTIVE (amended, canonical) site, so 'DOM' cannot slip past 'MOD' (C-173 T-CL-AMEND-6).
  const dup = await tx.maybeOne<{ id: string }>(`SELECT c.id FROM care_items c JOIN care_effective_sites e ON e.care_item_id = c.id
      WHERE c.visit_id = $1 AND c.procedure_code = $2 AND e.tooth_fdi IS NOT DISTINCT FROM $3 AND e.surfaces IS NOT DISTINCT FROM $4 LIMIT 1`,
    [v.id, input.procedureCode, input.site.toothFdi, input.site.surfaces]);
  if (dup && !input.confirmRepeat) fail('CARE_ALREADY_CONFIRMED', 'This procedure is already confirmed for this visit; use a correction', { existingCareItemId: dup.id });
  await requireAlertsAcknowledged(tx, actor, v, input.alertSetHash, input.via);
  const c = await tx.one<{ id: string; confirmed_at: string }>(`INSERT INTO care_items (clinic_id, visit_id, patient_id, kind, procedure_code, procedure_label, tooth_fdi, surfaces, fee_millimes, reason, confirmed_by, confirmed_by_role)
      VALUES ($1,$2,$3,'CARE',$4,$5,$6,$7,$8,$9,$10,'DENTIST') RETURNING id, confirmed_at`,
    [actor.clinicId, v.id, v.patient_id, input.procedureCode, input.procedureLabel, input.site.toothFdi, input.site.surfaces, input.feeMillimes, input.reason, actor.staffId]);
  if (v.status !== 'COMPLETED') {
    await tx.query("UPDATE visits SET status = 'COMPLETED', status_changed_at = now(), status_changed_by = $2 WHERE id = $1", [v.id, actor.staffId]);
  }
  await appendAudit(tx, actor, 'care.confirmed', 'care_item', c.id, { visitId: v.id, procedureCode: input.procedureCode, toothFdi: input.site.toothFdi, surfaces: input.site.surfaces, feeMillimes: input.feeMillimes, freeCare: input.feeMillimes === 0 });
  return {
    careItem: { id: c.id, visitId: v.id, kind: 'CARE', procedureCode: input.procedureCode, procedureLabel: input.procedureLabel, toothFdi: input.site.toothFdi, surfaces: input.site.surfaces, feeMillimes: input.feeMillimes, confirmedBy: actor.staffId, confirmedAt: c.confirmed_at },
    visitTotalMillimes: await visitCareTotal(tx, v.id),
  };
}

export const careRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/visits/:id/care', permission: 'care.confirm', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const v = await getVisitForUpdate(tx, params.id!);
      const procedureCode = str(b, 'procedureCode', { min: 2, max: 32, pattern: /^[A-Z0-9_.-]{2,32}$/ });
      const procedureLabel = str(b, 'procedureLabel', { min: 2, max: 160 });
      const site = readDentalSite(b);
      const fee = millimes(b, 'feeMillimes', { allowZero: true });
      const reason = optStr(b, 'reason', { max: 300 });
      const r = await confirmCareItem(tx, actor!, v, { procedureCode, procedureLabel, site, feeMillimes: fee, reason, confirmRepeat: bool(b, 'confirmRepeat'), alertSetHash: readAlertSetHash(b), via: 'CARE_CONFIRMATION' });
      return { status: 201, body: r };
    },
  },
  {
    method: 'POST', path: '/api/v1/care-items/:id/corrections', permission: 'care.correct', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      uuid({ id: params.id }, 'id');
      const orig = await tx.maybeOne<{ id: string; visit_id: string; patient_id: string; kind: string; procedure_code: string; procedure_label: string }>(
        'SELECT id, visit_id, patient_id, kind, procedure_code, procedure_label FROM care_items WHERE id = $1', [params.id!]);
      if (!orig || orig.kind !== 'CARE') fail('NOT_FOUND', 'Original care item not found');
      await getVisitForUpdate(tx, orig!.visit_id);
      const delta = millimes(b, 'deltaMillimes', { allowNegative: true });
      const reason = str(b, 'reason', { min: 3, max: 300 });
      const itemTotal = await tx.one<{ t: number }>('SELECT coalesce(sum(fee_millimes),0)::bigint AS t FROM care_items WHERE id = $1 OR corrects_id = $1', [orig!.id]);
      if (itemTotal.t + delta < 0) fail('VALIDATION_FAILED', 'Correction would make the item fee negative', { currentMillimes: itemTotal.t });
      // A fee correction carries the item's EFFECTIVE site, never a site that was already amended away (C-172 §2).
      const site = await tx.one<{ tooth_fdi: number | null; surfaces: string | null }>('SELECT tooth_fdi, surfaces FROM care_effective_sites WHERE care_item_id = $1', [orig!.id]);
      const c = await tx.one<{ id: string }>(`INSERT INTO care_items (clinic_id, visit_id, patient_id, kind, corrects_id, procedure_code, procedure_label, tooth_fdi, surfaces, fee_millimes, reason, confirmed_by, confirmed_by_role)
          VALUES ($1,$2,$3,'CORRECTION',$4,$5,$6,$7,$8,$9,$10,$11,'DENTIST') RETURNING id`,
        [actor!.clinicId, orig!.visit_id, orig!.patient_id, orig!.id, orig!.procedure_code, orig!.procedure_label, site.tooth_fdi, site.surfaces, delta, reason, actor!.staffId]);
      await appendAudit(tx, actor!, 'care.corrected', 'care_item', c.id, { correctsId: orig!.id, deltaMillimes: delta, reason });
      return { status: 201, body: { correction: { id: c.id, correctsId: orig!.id, deltaMillimes: delta, reason, itemFeeAfterMillimes: itemTotal.t + delta }, visitTotalMillimes: await visitCareTotal(tx, orig!.visit_id) } };
    },
  },
  {
    // Dentist-signed correction of a wrongly recorded tooth/surface (CH-032, C-172/C-173). Fee-neutral by
    // construction. expectedSupersedesId = the amendment the dentist saw as current (null if none): a stale
    // view gets 409 SITE_AMENDMENT_STALE instead of silently forking or overwriting the history.
    method: 'POST', path: '/api/v1/care-items/:id/site-amendments', permission: 'care.amend_site', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Care item not found');
      if ('feeMillimes' in b || 'deltaMillimes' in b) fail('VALIDATION_FAILED', 'A site amendment cannot change a fee; use a fee correction', { field: 'feeMillimes' });
      const orig = await tx.maybeOne<{ id: string; visit_id: string; patient_id: string; kind: string }>('SELECT id, visit_id, patient_id, kind FROM care_items WHERE id = $1', [params.id!]);
      if (!orig || orig.kind !== 'CARE') fail('NOT_FOUND', 'Care item not found');
      const v = await getVisitForUpdate(tx, orig!.visit_id);
      if (v.status === 'CANCELLED' || v.status === 'NO_SHOW') fail('CONFLICT', `Visit is ${v.status}`);
      const site = readDentalSite(b);
      const reasonCode = oneOf(b, 'reasonCode', SITE_AMENDMENT_REASONS)!;
      const reasonNote = optStr(b, 'reasonNote', { max: 300 });
      if (reasonCode === 'OTHER' && (!reasonNote || reasonNote.length < 3)) fail('VALIDATION_FAILED', 'reasonNote is required when reasonCode is OTHER', { field: 'reasonNote' });
      if (!('expectedSupersedesId' in b)) fail('VALIDATION_FAILED', 'expectedSupersedesId is required (null when the item was never amended)', { field: 'expectedSupersedesId' });
      const expected = uuid(b, 'expectedSupersedesId', true) || null;
      const cur = await tx.one<{ tooth_fdi: number | null; surfaces: string | null; head_amendment_id: string | null }>(
        'SELECT tooth_fdi, surfaces, head_amendment_id FROM care_effective_sites WHERE care_item_id = $1', [orig!.id]);
      if (cur.head_amendment_id !== expected) throw new AppError('SITE_AMENDMENT_STALE', 'The site was amended since you viewed it; reload the record', { currentHeadId: cur.head_amendment_id });
      const previous: DentalSite = { toothFdi: cur.tooth_fdi, surfaces: cur.surfaces };
      if (sameSite(previous, site)) fail('SITE_UNCHANGED', 'The new site equals the current site');
      const before = await visitCareTotal(tx, v.id);
      const a = await tx.one<{ id: string; amended_at: string }>(`INSERT INTO care_site_amendments (clinic_id, care_item_id, visit_id, patient_id, supersedes_id, previous_tooth_fdi, previous_surfaces, tooth_fdi, surfaces, reason_code, reason_note, amended_by, amended_by_role)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DENTIST') RETURNING id, amended_at`,
        [actor!.clinicId, orig!.id, v.id, v.patient_id, expected, previous.toothFdi, previous.surfaces, site.toothFdi, site.surfaces, reasonCode, reasonNote, actor!.staffId]);
      await appendAudit(tx, actor!, 'care.site_amended', 'care_item', orig!.id, { amendmentId: a.id, supersedesId: expected, previousSite: previous, newSite: site, reasonCode, hasNote: reasonNote !== null });
      const after = await visitCareTotal(tx, v.id);
      if (after !== before) throw new Error('site amendment changed the visit total'); // unreachable: no money column
      return { status: 201, body: {
        siteAmendment: { id: a.id, careItemId: orig!.id, supersedesId: expected, previousSite: previous, newSite: site, reasonCode, reasonNote, amendedBy: actor!.staffId, amendedByName: actor!.displayName, amendedAt: a.amended_at },
        effectiveSite: site, visitTotalMillimes: after,
      } };
    },
  },
  {
    method: 'GET', path: '/api/v1/visits/:id/care', permission: 'care.read',
    handler: async ({ tx, actor, params }) => {
      const v = await getVisit(tx, params.id!);
      const free = actor!.roles.some(r => r === 'DENTIST' || r === 'OWNER');
      const items = (await listCare(tx, v.id)).map(i => free ? i : stripFreeText(i));
      return { status: 200, body: { visitId: v.id, items, visitTotalMillimes: await visitCareTotal(tx, v.id) } };
    },
  },
];

/** Free-text reasons/notes may hold clinical detail: receptionists see codes and that a note exists. */
function stripFreeText(i: Record<string, unknown>) {
  const { reason, siteAmendments, ...rest } = i as { reason?: unknown; siteAmendments?: Array<Record<string, unknown>> };
  return {
    ...rest, hasReason: reason !== null && reason !== undefined,
    ...(siteAmendments ? { siteAmendments: siteAmendments.map(({ reasonNote, ...a }) => ({ ...a, hasNote: reasonNote !== null })) } : {}),
  };
}
