/*
 * CLINICAL-CARE module (financially relevant part): dentist-confirmed care and fee (MF12 / CH-012).
 * Owns table: care_items. Read by BILLING for balances (read-only dependency).
 *
 * Rules: only an authenticated DENTIST session can confirm or correct care; identity comes from the
 * session (body fields like role/actor are ignored, T-CARE-4); confirmation is immutable; a fee change is
 * a CORRECTION row (delta + reason + link to original); free care is an explicit dentist act with reason;
 * confirming care marks the visit COMPLETED (dentist act). The fee note is dentist-authored
 * (Code de déontologie Art. 31 as read in CH-005; legal interpretation UNVERIFIED).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr, millimes, int, uuid, bool } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';
import { getVisitForUpdate, getVisit } from './patients.ts';

export function validFdi(t: number): boolean {
  const q = Math.floor(t / 10), n = t % 10;
  return (q >= 1 && q <= 4 && n >= 1 && n <= 8) || (q >= 5 && q <= 8 && n >= 1 && n <= 5);
}

export async function visitCareTotal(tx: Tx, visitId: string): Promise<number> {
  const r = await tx.one<{ total: number }>('SELECT coalesce(sum(fee_millimes), 0)::bigint AS total FROM care_items WHERE visit_id = $1', [visitId]);
  return r.total;
}

export async function listCare(tx: Tx, visitId: string) {
  return (await tx.query(`SELECT c.id, c.kind, c.corrects_id AS "correctsId", c.procedure_code AS "procedureCode", c.procedure_label AS "procedureLabel",
      c.tooth_fdi AS "toothFdi", c.surfaces, c.fee_millimes AS "feeMillimes", c.reason, c.confirmed_by AS "confirmedBy", s.display_name AS "confirmedByName",
      c.confirmed_at AS "confirmedAt"
    FROM care_items c JOIN staff s ON s.id = c.confirmed_by WHERE c.visit_id = $1 ORDER BY c.confirmed_at, c.id`, [visitId])).rows;
}

export const careRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/visits/:id/care', permission: 'care.confirm', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const v = await getVisitForUpdate(tx, params.id!);
      if (v.status === 'CANCELLED' || v.status === 'NO_SHOW') fail('CONFLICT', `Visit is ${v.status}; care cannot be confirmed`);
      const procedureCode = str(b, 'procedureCode', { min: 2, max: 32, pattern: /^[A-Z0-9_.-]{2,32}$/ });
      const procedureLabel = str(b, 'procedureLabel', { min: 2, max: 160 });
      const tooth = int(b, 'toothFdi', 11, 85, true);
      if (tooth !== null && !validFdi(tooth)) fail('VALIDATION_FAILED', 'toothFdi is not a valid FDI tooth number', { field: 'toothFdi' });
      const surfaces = optStr(b, 'surfaces', { max: 5, pattern: /^[MODBLIFP]{1,5}$/ });
      const fee = millimes(b, 'feeMillimes', { allowZero: true });
      const reason = optStr(b, 'reason', { max: 300 });
      if (fee === 0 && (!reason || reason.length < 3)) fail('VALIDATION_FAILED', 'Free care (fee 0) requires a reason', { field: 'reason' });
      const dup = await tx.maybeOne(`SELECT id FROM care_items WHERE visit_id = $1 AND kind = 'CARE' AND procedure_code = $2
          AND tooth_fdi IS NOT DISTINCT FROM $3 AND surfaces IS NOT DISTINCT FROM $4 LIMIT 1`, [v.id, procedureCode, tooth, surfaces]);
      if (dup && !bool(b, 'confirmRepeat')) fail('CARE_ALREADY_CONFIRMED', 'This procedure is already confirmed for this visit; use a correction', { existingCareItemId: (dup as { id: string }).id });
      const c = await tx.one<{ id: string; confirmed_at: string }>(`INSERT INTO care_items (clinic_id, visit_id, patient_id, kind, procedure_code, procedure_label, tooth_fdi, surfaces, fee_millimes, reason, confirmed_by, confirmed_by_role)
          VALUES ($1,$2,$3,'CARE',$4,$5,$6,$7,$8,$9,$10,'DENTIST') RETURNING id, confirmed_at`,
        [actor!.clinicId, v.id, v.patient_id, procedureCode, procedureLabel, tooth, surfaces, fee, reason, actor!.staffId]);
      if (v.status !== 'COMPLETED') {
        await tx.query("UPDATE visits SET status = 'COMPLETED', status_changed_at = now(), status_changed_by = $2 WHERE id = $1", [v.id, actor!.staffId]);
      }
      await appendAudit(tx, actor!, 'care.confirmed', 'care_item', c.id, { visitId: v.id, procedureCode, toothFdi: tooth, surfaces, feeMillimes: fee, freeCare: fee === 0 });
      return { status: 201, body: { careItem: { id: c.id, visitId: v.id, kind: 'CARE', procedureCode, procedureLabel, toothFdi: tooth, surfaces, feeMillimes: fee, confirmedBy: actor!.staffId, confirmedAt: c.confirmed_at }, visitTotalMillimes: await visitCareTotal(tx, v.id) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/care-items/:id/corrections', permission: 'care.correct', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      uuid({ id: params.id }, 'id');
      const orig = await tx.maybeOne<{ id: string; visit_id: string; patient_id: string; kind: string; procedure_code: string; procedure_label: string; tooth_fdi: number | null; surfaces: string | null }>(
        'SELECT id, visit_id, patient_id, kind, procedure_code, procedure_label, tooth_fdi, surfaces FROM care_items WHERE id = $1', [params.id!]);
      if (!orig || orig.kind !== 'CARE') fail('NOT_FOUND', 'Original care item not found');
      await getVisitForUpdate(tx, orig!.visit_id);
      const delta = millimes(b, 'deltaMillimes', { allowNegative: true });
      const reason = str(b, 'reason', { min: 3, max: 300 });
      const itemTotal = await tx.one<{ t: number }>('SELECT coalesce(sum(fee_millimes),0)::bigint AS t FROM care_items WHERE id = $1 OR corrects_id = $1', [orig!.id]);
      if (itemTotal.t + delta < 0) fail('VALIDATION_FAILED', 'Correction would make the item fee negative', { currentMillimes: itemTotal.t });
      const c = await tx.one<{ id: string }>(`INSERT INTO care_items (clinic_id, visit_id, patient_id, kind, corrects_id, procedure_code, procedure_label, tooth_fdi, surfaces, fee_millimes, reason, confirmed_by, confirmed_by_role)
          VALUES ($1,$2,$3,'CORRECTION',$4,$5,$6,$7,$8,$9,$10,$11,'DENTIST') RETURNING id`,
        [actor!.clinicId, orig!.visit_id, orig!.patient_id, orig!.id, orig!.procedure_code, orig!.procedure_label, orig!.tooth_fdi, orig!.surfaces, delta, reason, actor!.staffId]);
      await appendAudit(tx, actor!, 'care.corrected', 'care_item', c.id, { correctsId: orig!.id, deltaMillimes: delta, reason });
      return { status: 201, body: { correction: { id: c.id, correctsId: orig!.id, deltaMillimes: delta, reason, itemFeeAfterMillimes: itemTotal.t + delta }, visitTotalMillimes: await visitCareTotal(tx, orig!.visit_id) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/visits/:id/care', permission: 'care.read',
    handler: async ({ tx, params }) => {
      const v = await getVisit(tx, params.id!);
      return { status: 200, body: { visitId: v.id, items: await listCare(tx, v.id), visitTotalMillimes: await visitCareTotal(tx, v.id) } };
    },
  },
];
