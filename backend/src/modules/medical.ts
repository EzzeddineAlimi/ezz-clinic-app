/*
 * MEDICAL module: medical alerts (allergies, anticoagulants, ...), dated medical-history reviews and the
 * display-before-treatment acknowledgement (clinical-requirements §5). Owns tables: medical_alerts,
 * medical_history_reviews, alert_acknowledgements. Depends on: audit, patients. Used by care (treatment
 * gate) and clinical (encounter / record views).
 *
 * Rules:
 *  - alerts are immutable revision chains; the current state is the highest revision; unverified
 *    (PATIENT_DECLARED) alerts are still shown as alerts, never hidden;
 *  - the desk may DECLARE an alert at intake (and gets back only an id); detail is readable by dentists only;
 *    everyone else sees presence/severity counts (§12 "alert presence");
 *  - the alert-set hash names exactly the alert revisions a dentist was shown; confirming treatment with a
 *    stale hash is refused (MEDICAL_ALERTS_CHANGED), so care is never signed against an outdated list;
 *  - "no known allergies" is an explicit dated dentist assertion, refused while an allergy alert is active;
 *  - free text (detail, reasons, review notes) never goes into the audit payload, only codes and hashes.
 * Alert codes and the 12-month review interval are PROVISIONAL (clinical-requirements §5.1, Q5).
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { AppError, fail } from '../platform/errors.ts';
import { asBody, str, optStr, oneOf, int, uuid, bool, isUuid } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';
import { getPatient, getVisit } from './patients.ts';

export const ALERT_CODES = [
  'ALLERGY_PENICILLIN', 'ALLERGY_LATEX', 'ALLERGY_LOCAL_ANAESTHETIC', 'ALLERGY_OTHER',
  'ANTICOAGULANT_VKA', 'ANTICOAGULANT_DOAC', 'ANTIPLATELET', 'ANTIRESORPTIVE_OR_ANTIANGIOGENIC',
  'PREGNANCY', 'DIABETES', 'CARDIAC_IE_HIGH_RISK', 'IMMUNOSUPPRESSION', 'HEAD_NECK_RADIOTHERAPY',
  'BLEEDING_DISORDER', 'EPILEPSY', 'OTHER',
] as const;
export const REVIEW_INTERVAL_MONTHS = 12; // ASSUMPTION (clinical-requirements §5.2, Q5)

export interface AlertRow {
  id: string; chainId: string; revision: number; code: string; severity: 'CRITICAL' | 'CAUTION';
  detail: string | null; source: 'PATIENT_DECLARED' | 'DENTIST_VERIFIED'; status: 'ACTIVE' | 'RESOLVED' | 'ENTERED_IN_ERROR';
  reason: string | null; recordedBy: string; recordedByName: string; recordedRole: string; recordedAt: string; firstRecordedAt: string;
}

const isAllergy = (code: string) => code.startsWith('ALLERGY_');
const dentistRole = (actor: Actor) => actor.roles.includes('DENTIST');

/** Serialise every medical write for one patient (FOR NO KEY UPDATE: does not block FK inserts). */
async function lockPatient(tx: Tx, patientId: string) {
  if (!isUuid(patientId)) fail('NOT_FOUND', 'Patient not found');
  const p = await tx.maybeOne('SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE', [patientId]);
  if (!p) fail('NOT_FOUND', 'Patient not found');
}

/** Current revision of every alert chain of the patient (all statuses), oldest chain first. */
export async function currentAlerts(tx: Tx, patientId: string): Promise<AlertRow[]> {
  return (await tx.query<AlertRow>(`SELECT * FROM (
      SELECT DISTINCT ON (a.chain_id) a.id, a.chain_id AS "chainId", a.revision, a.code, a.severity, a.detail, a.source, a.status, a.reason,
        a.recorded_by AS "recordedBy", s.display_name AS "recordedByName", a.recorded_role AS "recordedRole", a.recorded_at AS "recordedAt",
        (SELECT f.recorded_at FROM medical_alerts f WHERE f.clinic_id = a.clinic_id AND f.chain_id = a.chain_id AND f.revision = 1) AS "firstRecordedAt"
      FROM medical_alerts a JOIN staff s ON s.clinic_id = a.clinic_id AND s.id = a.recorded_by
      WHERE a.patient_id = $1 ORDER BY a.chain_id, a.revision DESC) cur
    ORDER BY "firstRecordedAt", "chainId"`, [patientId])).rows;
}

/** Hash of the ACTIVE alert revisions (ids pin the exact revision, so any change gives a new hash). */
export function alertSetHash(active: AlertRow[]): string {
  return sha256(canonicalJson(active.map(a => ({ id: a.id, code: a.code, severity: a.severity, source: a.source })).sort((x, y) => x.id.localeCompare(y.id))));
}

export interface MedicalState {
  active: AlertRow[]; all: AlertRow[]; alertSetHash: string;
  lastReview: { id: string; reviewedAt: string; reviewedByName: string; method: string; noKnownAllergies: boolean; nextReviewDue: string; alertSetHash: string } | null;
  reviewStatus: 'NEVER_REVIEWED' | 'CURRENT' | 'OVERDUE' | 'CHANGED_SINCE_REVIEW';
  allergyStatus: 'NOT_RECORDED' | 'NO_KNOWN_ALLERGIES' | 'ALLERGIES_RECORDED';
}

export async function medicalState(tx: Tx, patientId: string, today = new Date()): Promise<MedicalState> {
  const all = await currentAlerts(tx, patientId);
  const active = all.filter(a => a.status === 'ACTIVE');
  const hash = alertSetHash(active);
  const last = await tx.maybeOne<{ id: string; reviewed_at: string; display_name: string; method: string; no_known_allergies: boolean; next_review_due: string; alert_set_sha256: string }>(
    `SELECT r.id, r.reviewed_at, s.display_name, r.method, r.no_known_allergies, r.next_review_due::text AS next_review_due, r.alert_set_sha256
       FROM medical_history_reviews r JOIN staff s ON s.clinic_id = r.clinic_id AND s.id = r.reviewed_by
      WHERE r.patient_id = $1 ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1`, [patientId]);
  const reviewStatus = !last ? 'NEVER_REVIEWED'
    : last.next_review_due < today.toISOString().slice(0, 10) ? 'OVERDUE'
    : last.alert_set_sha256 !== hash ? 'CHANGED_SINCE_REVIEW' : 'CURRENT';
  const allergyStatus = active.some(a => isAllergy(a.code)) ? 'ALLERGIES_RECORDED'
    : last?.no_known_allergies ? 'NO_KNOWN_ALLERGIES' : 'NOT_RECORDED';
  return {
    active, all, alertSetHash: hash, reviewStatus, allergyStatus,
    lastReview: last ? { id: last.id, reviewedAt: last.reviewed_at, reviewedByName: last.display_name, method: last.method, noKnownAllergies: last.no_known_allergies, nextReviewDue: last.next_review_due, alertSetHash: last.alert_set_sha256 } : null,
  };
}

/** Desk-safe summary: presence and severity only, no codes or detail (clinical-requirements §12). */
export function alertPresence(m: MedicalState) {
  return {
    activeAlertCount: m.active.length,
    criticalAlertCount: m.active.filter(a => a.severity === 'CRITICAL').length,
    unverifiedAlertCount: m.active.filter(a => a.source === 'PATIENT_DECLARED').length,
    allergyStatus: m.allergyStatus === 'ALLERGIES_RECORDED' ? 'SEE_DENTIST' : m.allergyStatus,
    reviewStatus: m.reviewStatus,
    instruction: m.active.length ? 'Medical alert on file: the dentist must see it before treatment.' : null,
  };
}

/**
 * Treatment gate used by care confirmation and plan performance (§5.3). If the patient has ACTIVE alerts,
 * the dentist must have acknowledged the CURRENT set for this visit, or send the hash they were shown
 * (recorded here as an implicit acknowledgement). A supplied hash that is stale is always refused.
 */
export async function requireAlertsAcknowledged(tx: Tx, actor: Actor, visit: { id: string; patient_id: string }, suppliedHash: string | null, via: 'CARE_CONFIRMATION' | 'PLAN_PERFORM') {
  const m = await medicalState(tx, visit.patient_id);
  if (suppliedHash !== null && suppliedHash !== m.alertSetHash) {
    throw new AppError('MEDICAL_ALERTS_CHANGED', 'The medical alerts changed since you viewed them; review them again', { alertSetHash: m.alertSetHash, activeAlertCount: m.active.length });
  }
  if (m.active.length === 0) return;
  if (suppliedHash !== null) {
    await insertAck(tx, actor, visit, m, via);
    return;
  }
  const ack = await tx.maybeOne('SELECT id FROM alert_acknowledgements WHERE visit_id = $1 AND alert_set_sha256 = $2 LIMIT 1', [visit.id, m.alertSetHash]);
  if (!ack) throw new AppError('MEDICAL_ALERTS_NOT_ACKNOWLEDGED', 'This patient has medical alerts; review them before confirming treatment', { alertSetHash: m.alertSetHash, activeAlertCount: m.active.length, criticalAlertCount: m.active.filter(a => a.severity === 'CRITICAL').length });
}

async function insertAck(tx: Tx, actor: Actor, visit: { id: string; patient_id: string }, m: MedicalState, via: 'EXPLICIT' | 'CARE_CONFIRMATION' | 'PLAN_PERFORM') {
  const a = await tx.one<{ id: string; acknowledged_at: string }>(`INSERT INTO alert_acknowledgements (clinic_id, visit_id, patient_id, alert_set_sha256, active_alert_count, via, acknowledged_by, acknowledged_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'DENTIST') RETURNING id, acknowledged_at`, [actor.clinicId, visit.id, visit.patient_id, m.alertSetHash, m.active.length, via, actor.staffId]);
  await appendAudit(tx, actor, 'medical.alerts_acknowledged', 'visit', visit.id, { acknowledgementId: a.id, alertSetHash: m.alertSetHash, activeAlertCount: m.active.length, via });
  return a;
}

const hashParam = (b: Record<string, unknown>, key = 'alertSetHash'): string | null => {
  const v = b[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) fail('VALIDATION_FAILED', `${key} must be a 64-character hex hash`, { field: key });
  return v as string;
};
export { hashParam as readAlertSetHash };

export const medicalRoutes: Route[] = [
  {
    // Desk-safe presence summary (no codes, no detail) for check-in and the receptionist screen.
    method: 'GET', path: '/api/v1/patients/:id/medical-alerts/summary', permission: 'medical.alert_presence',
    handler: async ({ tx, params }) => {
      const p = await getPatient(tx, params.id!) as { id: string };
      return { status: 200, body: { patientId: p.id, ...alertPresence(await medicalState(tx, p.id)) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/patients/:id/medical-alerts', permission: 'clinical.read',
    handler: async ({ tx, params, query }) => {
      const p = await getPatient(tx, params.id!) as { id: string };
      const m = await medicalState(tx, p.id);
      const history = query.get('history') === 'true'
        ? (await tx.query(`SELECT a.id, a.chain_id AS "chainId", a.revision, a.code, a.severity, a.detail, a.source, a.status, a.reason,
              a.recorded_role AS "recordedRole", s.display_name AS "recordedByName", a.recorded_at AS "recordedAt"
            FROM medical_alerts a JOIN staff s ON s.clinic_id = a.clinic_id AND s.id = a.recorded_by
            WHERE a.patient_id = $1 ORDER BY a.chain_id, a.revision`, [p.id])).rows
        : undefined;
      return { status: 200, body: { patientId: p.id, alerts: m.all, alertSetHash: m.alertSetHash, reviewStatus: m.reviewStatus, allergyStatus: m.allergyStatus, lastReview: m.lastReview, history } };
    },
  },
  {
    // Declare (desk / assistant: PATIENT_DECLARED) or record (dentist: DENTIST_VERIFIED) a new alert.
    method: 'POST', path: '/api/v1/patients/:id/medical-alerts', permission: 'medical.declare', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const code = oneOf(b, 'code', ALERT_CODES)!;
      const severity = oneOf(b, 'severity', ['CRITICAL', 'CAUTION'] as const)!;
      const detail = optStr(b, 'detail', { max: 300 });
      if (code === 'OTHER' && !detail) fail('VALIDATION_FAILED', 'detail is required for code OTHER', { field: 'detail' });
      await lockPatient(tx, params.id!);
      const dentist = dentistRole(actor!);
      const role = dentist ? 'DENTIST' : actor!.roles.includes('RECEPTIONIST') ? 'RECEPTIONIST' : 'ASSISTANT';
      const source = dentist ? 'DENTIST_VERIFIED' : 'PATIENT_DECLARED';
      const dup = (await currentAlerts(tx, params.id!)).find(a => a.status === 'ACTIVE' && a.code === code && code !== 'OTHER' && code !== 'ALLERGY_OTHER');
      if (dup) fail('CONFLICT', 'An active alert with this code already exists; revise it instead', dentist ? { existingAlertId: dup.id, chainId: dup.chainId } : undefined);
      const chainId = randomUUID();
      const a = await tx.one<{ id: string; recorded_at: string }>(`INSERT INTO medical_alerts (clinic_id, patient_id, chain_id, revision, code, severity, detail, source, status, recorded_by, recorded_role)
          VALUES ($1,$2,$3,1,$4,$5,$6,$7,'ACTIVE',$8,$9) RETURNING id, recorded_at`, [actor!.clinicId, params.id!, chainId, code, severity, detail, source, actor!.staffId, role]);
      await appendAudit(tx, actor!, 'medical.alert_recorded', 'medical_alert', a.id, { patientId: params.id, chainId, revision: 1, code, severity, source, hasDetail: detail !== null });
      // Non-dentists get an acknowledgement only: they cannot read the patient's other alerts back.
      if (!dentist) return { status: 201, body: { declared: true, alertId: a.id, source, recordedAt: a.recorded_at, note: 'Shown to the dentist as declared, not verified.' } };
      const m = await medicalState(tx, params.id!);
      return { status: 201, body: { alert: m.all.find(x => x.id === a.id), alertSetHash: m.alertSetHash } };
    },
  },
  {
    // Dentist revision of an alert chain: VERIFY (declared -> verified), UPDATE (severity/detail), RESOLVE,
    // ENTERED_IN_ERROR. expectedRevision gives optimistic concurrency: two dentists cannot fork a chain.
    method: 'POST', path: '/api/v1/medical-alerts/:id/revisions', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Alert not found');
      const action = oneOf(b, 'action', ['VERIFY', 'UPDATE', 'RESOLVE', 'ENTERED_IN_ERROR'] as const)!;
      const expectedRevision = int(b, 'expectedRevision', 1, 1000)!;
      const ref = await tx.maybeOne<{ patient_id: string; chain_id: string }>('SELECT patient_id, chain_id FROM medical_alerts WHERE id = $1', [params.id!]);
      if (!ref) fail('NOT_FOUND', 'Alert not found');
      await lockPatient(tx, ref!.patient_id);
      const cur = (await currentAlerts(tx, ref!.patient_id)).find(a => a.chainId === ref!.chain_id)!;
      if (cur.revision !== expectedRevision) fail('CONFLICT', 'The alert was changed by someone else; reload it', { currentRevision: cur.revision, currentId: cur.id });
      if (cur.status !== 'ACTIVE') fail('CONFLICT', `Alert is ${cur.status}; record a new alert instead`);
      const reason = action === 'RESOLVE' || action === 'ENTERED_IN_ERROR' ? str(b, 'reason', { min: 3, max: 300 }) : optStr(b, 'reason', { max: 300 });
      const severity = action === 'UPDATE' ? (oneOf(b, 'severity', ['CRITICAL', 'CAUTION'] as const, true) ?? cur.severity) : cur.severity;
      const detail = action === 'UPDATE' && 'detail' in b ? optStr(b, 'detail', { max: 300 }) : cur.detail;
      if (cur.code === 'OTHER' && !detail) fail('VALIDATION_FAILED', 'detail is required for code OTHER', { field: 'detail' });
      if (action === 'UPDATE' && severity === cur.severity && detail === cur.detail) fail('CONFLICT', 'Nothing to change');
      const status = action === 'RESOLVE' ? 'RESOLVED' : action === 'ENTERED_IN_ERROR' ? 'ENTERED_IN_ERROR' : 'ACTIVE';
      const a = await tx.one<{ id: string }>(`INSERT INTO medical_alerts (clinic_id, patient_id, chain_id, revision, code, severity, detail, source, status, reason, recorded_by, recorded_role)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'DENTIST_VERIFIED',$8,$9,$10,'DENTIST') RETURNING id`,
        [actor!.clinicId, ref!.patient_id, cur.chainId, cur.revision + 1, cur.code, severity, detail, status, reason, actor!.staffId]);
      await appendAudit(tx, actor!, 'medical.alert_revised', 'medical_alert', a.id, { patientId: ref!.patient_id, chainId: cur.chainId, revision: cur.revision + 1, supersedesId: cur.id, action, status, severity, hasReason: reason !== null });
      const m = await medicalState(tx, ref!.patient_id);
      return { status: 201, body: { alert: m.all.find(x => x.id === a.id), alertSetHash: m.alertSetHash } };
    },
  },
  {
    // Dated medical-history review (§5.2). alertSetHash proves which alert set the dentist reviewed.
    method: 'POST', path: '/api/v1/patients/:id/medical-history-reviews', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const method = oneOf(b, 'method', ['INTERVIEW', 'PAPER_FORM'] as const)!;
      const noKnownAllergies = bool(b, 'noKnownAllergies');
      const supplied = hashParam(b);
      if (supplied === null) fail('VALIDATION_FAILED', 'alertSetHash is required (the alert set you reviewed)', { field: 'alertSetHash' });
      const visitId = uuid(b, 'visitId', true) || null;
      const note = optStr(b, 'note', { max: 500 });
      const months = int(b, 'nextReviewInMonths', 1, 24, true) ?? REVIEW_INTERVAL_MONTHS;
      await lockPatient(tx, params.id!);
      if (visitId) {
        const v = await getVisit(tx, visitId);
        if (v.patient_id !== params.id) fail('VALIDATION_FAILED', 'visitId belongs to another patient', { field: 'visitId' });
      }
      const m = await medicalState(tx, params.id!);
      if (supplied !== m.alertSetHash) throw new AppError('MEDICAL_ALERTS_CHANGED', 'The medical alerts changed since you viewed them; review them again', { alertSetHash: m.alertSetHash });
      if (noKnownAllergies && m.active.some(a => isAllergy(a.code))) fail('CONFLICT', 'An allergy alert is active; resolve it or mark it entered-in-error before asserting no known allergies');
      const r = await tx.one<{ id: string; reviewed_at: string; next_review_due: string }>(`INSERT INTO medical_history_reviews (clinic_id, patient_id, visit_id, method, no_known_allergies, alert_set_sha256, next_review_due, note, reviewed_by, reviewed_role)
          VALUES ($1,$2,$3,$4,$5,$6, (current_date + make_interval(months => $7))::date, $8, $9, 'DENTIST') RETURNING id, reviewed_at, next_review_due::text AS next_review_due`,
        [actor!.clinicId, params.id!, visitId, method, noKnownAllergies, m.alertSetHash, months, note, actor!.staffId]);
      await appendAudit(tx, actor!, 'medical.history_reviewed', 'medical_history_review', r.id, { patientId: params.id, visitId, method, noKnownAllergies, alertSetHash: m.alertSetHash, nextReviewDue: r.next_review_due, hasNote: note !== null });
      if (visitId && m.active.length) await insertAck(tx, actor!, { id: visitId, patient_id: params.id! }, m, 'EXPLICIT');
      const after = await medicalState(tx, params.id!);
      return { status: 201, body: { review: after.lastReview, reviewStatus: after.reviewStatus, allergyStatus: after.allergyStatus, alertSetHash: after.alertSetHash } };
    },
  },
  {
    // Explicit display-before-treatment acknowledgement for a visit (one action, §5.3).
    method: 'POST', path: '/api/v1/visits/:id/alert-acknowledgements', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const supplied = hashParam(b);
      if (supplied === null) fail('VALIDATION_FAILED', 'alertSetHash is required', { field: 'alertSetHash' });
      const v = await getVisit(tx, params.id!);
      await lockPatient(tx, v.patient_id);
      const m = await medicalState(tx, v.patient_id);
      if (supplied !== m.alertSetHash) throw new AppError('MEDICAL_ALERTS_CHANGED', 'The medical alerts changed since you viewed them; review them again', { alertSetHash: m.alertSetHash });
      const a = await insertAck(tx, actor!, v, m, 'EXPLICIT');
      return { status: 201, body: { acknowledgement: { id: a.id, visitId: v.id, alertSetHash: m.alertSetHash, activeAlertCount: m.active.length, acknowledgedAt: a.acknowledged_at } } };
    },
  },
];
