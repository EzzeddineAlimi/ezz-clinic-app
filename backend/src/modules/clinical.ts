/*
 * CLINICAL module: the dentist's encounter workspace and the longitudinal patient record (B07).
 * Owns tables: clinical_notes, chart_findings, treatment_plan_items, plan_item_events.
 * Depends on: audit, patients, care (confirm care for a plan item, care listing), medical (alerts state).
 *
 * Rules (clinical-requirements §2-§4, §12):
 *  - every clinical entry is signed at creation by the authenticated DENTIST session and never edited;
 *    there is no unsigned draft state on the server (a separate signing step would be ceremony);
 *  - corrections are new linked rows: ADDENDUM / LATE_ENTRY (reason) / ENTERED_IN_ERROR (reason, once);
 *    struck entries stay readable to the dentist and are flagged, never deleted;
 *  - the audit chain stores a SHA-256 of each note's content, never the text, and reads re-check it;
 *  - chart findings and plan items are never billable; only performing a plan item creates a care item
 *    (through care.confirmCareItem, so the same duplicate guard, medical-alert gate and audit apply), and
 *    the plan estimate is a quote: the fee is the dentist's confirmed care fee;
 *  - detail is DENTIST-only (clinical.read); receptionist / non-clinician owner get nothing from here.
 * Condition codes, surface rules, phases and late-entry rules are PROVISIONAL (Tunisian dentist review).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { AppError, fail } from '../platform/errors.ts';
import { asBody, str, optStr, oneOf, int, uuid, isoTime, millimes, isUuid } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { readDentalSite } from '../contracts/clinical.ts';
import { appendAudit } from './audit.ts';
import { getPatient, getVisit, getVisitForUpdate } from './patients.ts';
import { confirmCareItem, listCare } from './care.ts';
import { medicalState, readAlertSetHash } from './medical.ts';

const SECTIONS = ['subjective', 'objective', 'assessment', 'plan'] as const;
const AREA_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40];
const CONDITION_CODE = /^[A-Z][A-Z0-9_]{1,40}$/;
const PLAN_TERMINAL = ['DECLINED', 'CANCELLED', 'COMPLETED'];
const PLAN_TRANSITIONS: Record<string, string[]> = { PROPOSED: ['ACCEPTED', 'DECLINED', 'CANCELLED'], ACCEPTED: ['CANCELLED'] };

function writableVisit(v: { status: string }) {
  if (v.status === 'CANCELLED' || v.status === 'NO_SHOW') fail('CONFLICT', `Visit is ${v.status}; clinical entries cannot be added`);
}

// ---------------------------------------------------------------- notes

interface NoteRow {
  id: string; patientId: string; visitId: string; kind: string; parentNoteId: string | null;
  subjective: string | null; objective: string | null; assessment: string | null; plan: string | null;
  effectiveAt: string; reason: string | null; contentSha256: string; signedBy: string; signedByName: string; signedAt: string;
}

function noteHash(n: { kind: string; patientId: string; visitId: string; parentNoteId: string | null; effectiveAt: string; reason: string | null } & Record<typeof SECTIONS[number], string | null>) {
  return sha256(canonicalJson({ v: 1, kind: n.kind, patientId: n.patientId, visitId: n.visitId, parentNoteId: n.parentNoteId,
    subjective: n.subjective, objective: n.objective, assessment: n.assessment, plan: n.plan, effectiveAt: new Date(n.effectiveAt).toISOString(), reason: n.reason }));
}

const NOTE_COLUMNS = `SELECT n.id, n.patient_id AS "patientId", n.visit_id AS "visitId", n.kind, n.parent_note_id AS "parentNoteId",
      n.subjective, n.objective, n.assessment, n.plan, n.effective_at AS "effectiveAt", n.reason, n.content_sha256 AS "contentSha256",
      n.signed_by AS "signedBy", s.display_name AS "signedByName", n.signed_at AS "signedAt"
    FROM clinical_notes n JOIN staff s ON s.clinic_id = n.clinic_id AND s.id = n.signed_by`;
// Two literal statements (not one CASE) so each uses its index: clinical_notes_visit / clinical_notes_patient.
const NOTES_BY: Record<'visit' | 'patient', string> = {
  visit: NOTE_COLUMNS + ' WHERE n.visit_id = $1 ORDER BY n.signed_at, n.id',
  patient: NOTE_COLUMNS + ' WHERE n.patient_id = $1 ORDER BY n.signed_at, n.id',
};
async function loadNotes(tx: Tx, where: 'visit' | 'patient', id: string): Promise<NoteRow[]> {
  return (await tx.query<NoteRow>(NOTES_BY[where], [id])).rows;
}

/** Notes with their addenda / strike status attached, and a re-check of the stored content hash. */
function presentNotes(rows: NoteRow[]) {
  const struck = new Map(rows.filter(r => r.kind === 'ENTERED_IN_ERROR').map(r => [r.parentNoteId!, r]));
  return rows.filter(r => r.kind !== 'ENTERED_IN_ERROR').map(r => {
    const s = struck.get(r.id);
    return {
      ...r,
      integrity: noteHash(r) === r.contentSha256 ? 'OK' : 'CONTENT_HASH_MISMATCH',
      enteredInError: s ? { by: s.signedByName, at: s.signedAt, reason: s.reason } : null,
      addendumIds: rows.filter(a => a.kind === 'ADDENDUM' && a.parentNoteId === r.id).map(a => a.id),
    };
  });
}

function readSections(b: Record<string, unknown>) {
  const out = {} as Record<typeof SECTIONS[number], string | null>;
  for (const k of SECTIONS) out[k] = optStr(b, k, { max: 4000 });
  return out;
}

async function insertNote(tx: Tx, actor: Parameters<typeof appendAudit>[1], n: { patientId: string; visitId: string; kind: string; parentNoteId: string | null; effectiveAt: string; reason: string | null } & Record<typeof SECTIONS[number], string | null>) {
  const contentSha256 = noteHash(n);
  const r = await tx.one<{ id: string; signed_at: string }>(`INSERT INTO clinical_notes (clinic_id, patient_id, visit_id, kind, parent_note_id, subjective, objective, assessment, plan, effective_at, reason, content_sha256, signed_by, signed_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DENTIST') RETURNING id, signed_at`,
    [actor.clinicId, n.patientId, n.visitId, n.kind, n.parentNoteId, n.subjective, n.objective, n.assessment, n.plan, n.effectiveAt, n.reason, contentSha256, actor.staffId]);
  await appendAudit(tx, actor, n.kind === 'ENTERED_IN_ERROR' ? 'clinical.note_struck' : 'clinical.note_signed', 'clinical_note', r.id, {
    visitId: n.visitId, kind: n.kind, parentNoteId: n.parentNoteId, contentSha256, sections: SECTIONS.filter(k => n[k] !== null), effectiveAt: n.effectiveAt,
  });
  return { id: r.id, signedAt: r.signed_at, contentSha256 };
}

// ---------------------------------------------------------------- findings

interface FindingRow { id: string; visitId: string; kind: string; enteredInErrorOfId: string | null; toothFdi: number | null; areaCode: number | null; surfaces: string | null; conditionCode: string | null; note: string | null; reason: string | null; recordedByName: string; recordedAt: string }

const FINDING_COLUMNS = `SELECT f.id, f.visit_id AS "visitId", f.kind, f.entered_in_error_of_id AS "enteredInErrorOfId", f.tooth_fdi AS "toothFdi",
      f.area_code AS "areaCode", f.surfaces, f.condition_code AS "conditionCode", f.note, f.reason, s.display_name AS "recordedByName", f.recorded_at AS "recordedAt"
    FROM chart_findings f JOIN staff s ON s.clinic_id = f.clinic_id AND s.id = f.recorded_by`;
const FINDINGS_BY: Record<'visit' | 'patient', string> = {
  visit: FINDING_COLUMNS + ' WHERE f.visit_id = $1 ORDER BY f.recorded_at, f.id',
  patient: FINDING_COLUMNS + ' WHERE f.patient_id = $1 ORDER BY f.recorded_at, f.id',
};
async function loadFindings(tx: Tx, where: 'visit' | 'patient', id: string): Promise<FindingRow[]> {
  return (await tx.query<FindingRow>(FINDINGS_BY[where], [id])).rows;
}

function presentFindings(rows: FindingRow[]) {
  const struck = new Map(rows.filter(r => r.kind === 'ENTERED_IN_ERROR').map(r => [r.enteredInErrorOfId!, r]));
  return rows.filter(r => r.kind !== 'ENTERED_IN_ERROR').map(({ enteredInErrorOfId: _, ...r }) => {
    const s = struck.get(r.id);
    return { ...r, enteredInError: s ? { by: s.recordedByName, at: s.recordedAt, reason: s.reason } : null };
  });
}

// ---------------------------------------------------------------- plan

interface PlanRow { id: string; patientId: string; createdInVisitId: string | null; procedureCode: string; procedureLabel: string; toothFdi: number | null; surfaces: string | null; phaseNo: number; estimatedFeeMillimes: number | null; note: string | null; createdByName: string; createdAt: string; status: string; lastSeq: number; careItemId: string | null; events: Array<Record<string, unknown>> }

async function loadPlan(tx: Tx, patientId: string, itemId?: string): Promise<PlanRow[]> {
  return (await tx.query<PlanRow>(`SELECT i.id, i.patient_id AS "patientId", i.created_in_visit_id AS "createdInVisitId", i.procedure_code AS "procedureCode",
      i.procedure_label AS "procedureLabel", i.tooth_fdi AS "toothFdi", i.surfaces, i.phase_no AS "phaseNo", i.estimated_fee_millimes AS "estimatedFeeMillimes",
      i.note, s.display_name AS "createdByName", i.created_at AS "createdAt",
      coalesce(e.items -> -1 ->> 'status', 'PROPOSED') AS status, coalesce((e.items -> -1 ->> 'seq')::int, 0) AS "lastSeq",
      (SELECT x.care_item_id FROM plan_item_events x WHERE x.clinic_id = i.clinic_id AND x.plan_item_id = i.id AND x.status = 'COMPLETED') AS "careItemId",
      coalesce(e.items, '[]'::jsonb) AS events
    FROM treatment_plan_items i JOIN staff s ON s.clinic_id = i.clinic_id AND s.id = i.created_by
    CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('seq', x.seq, 'status', x.status, 'careItemId', x.care_item_id, 'reason', x.reason,
        'byName', b.display_name, 'at', x.at) ORDER BY x.seq) AS items
      FROM plan_item_events x JOIN staff b ON b.clinic_id = x.clinic_id AND b.id = x.by_staff_id
      WHERE x.clinic_id = i.clinic_id AND x.plan_item_id = i.id) e
    WHERE i.patient_id = $1 AND ($2::uuid IS NULL OR i.id = $2::uuid) ORDER BY i.phase_no, i.created_at, i.id`, [patientId, itemId ?? null])).rows;
}

async function planItemById(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Plan item not found');
  const ref = await tx.maybeOne<{ patient_id: string }>('SELECT patient_id FROM treatment_plan_items WHERE id = $1', [id]);
  if (!ref) fail('NOT_FOUND', 'Plan item not found');
  return (await loadPlan(tx, ref!.patient_id, id))[0]!;
}

async function addPlanEvent(tx: Tx, actor: Parameters<typeof appendAudit>[1], item: PlanRow, status: string, careItemId: string | null, reason: string | null) {
  const e = await tx.one<{ id: string }>(`INSERT INTO plan_item_events (clinic_id, plan_item_id, patient_id, seq, status, care_item_id, reason, by_staff_id, by_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DENTIST') RETURNING id`, [actor.clinicId, item.id, item.patientId, item.lastSeq + 1, status, careItemId, reason, actor.staffId]);
  await appendAudit(tx, actor, 'clinical.plan_item_status', 'treatment_plan_item', item.id, { seq: item.lastSeq + 1, from: item.status, to: status, careItemId, hasReason: reason !== null });
  return e.id;
}

// ---------------------------------------------------------------- patient-level care (timeline)

async function patientCare(tx: Tx, patientId: string) {
  return (await tx.query<{ visitId: string; kind: string } & Record<string, unknown>>(`SELECT c.id, c.visit_id AS "visitId", c.kind, c.corrects_id AS "correctsId", c.procedure_code AS "procedureCode",
      c.procedure_label AS "procedureLabel", c.tooth_fdi AS "toothFdi", c.surfaces, e.tooth_fdi AS "effectiveToothFdi", e.surfaces AS "effectiveSurfaces",
      coalesce(e.amendment_count, 0) AS "amendmentCount", c.fee_millimes AS "feeMillimes", c.reason, s.display_name AS "confirmedByName", c.confirmed_at AS "confirmedAt"
    FROM care_items c JOIN staff s ON s.clinic_id = c.clinic_id AND s.id = c.confirmed_by LEFT JOIN care_effective_sites e ON e.care_item_id = c.id
    WHERE c.patient_id = $1 ORDER BY c.confirmed_at, c.id`, [patientId])).rows;
}

async function patientHeader(tx: Tx, patientId: string) {
  const p = await getPatient(tx, patientId) as Record<string, unknown>;
  return { id: p.id, fileNo: p.fileNo, familyName: p.familyName, givenName: p.givenName, nameAr: p.nameAr, dateOfBirth: p.dateOfBirth, sex: p.sex, preferredLanguage: p.preferredLanguage };
}

function medicalBlock(m: Awaited<ReturnType<typeof medicalState>>) {
  return { activeAlerts: m.active, alertSetHash: m.alertSetHash, reviewStatus: m.reviewStatus, allergyStatus: m.allergyStatus, lastReview: m.lastReview };
}

export const clinicalRoutes: Route[] = [
  {
    // The dentist opens a visit: identity, medical alerts (with the hash to echo when confirming care),
    // this visit's care/notes/findings, and the patient's open plan items. One read, no side effects.
    method: 'GET', path: '/api/v1/visits/:id/encounter', permission: 'clinical.read',
    handler: async ({ tx, params }) => {
      const v = await getVisit(tx, params.id!);
      const visit = await tx.one<Record<string, unknown>>(`SELECT v.id, v.status, v.scheduled_at AS "scheduledAt", v.duration_min AS "durationMin",
          v.dentist_id AS "dentistId", d.display_name AS "dentistName"
        FROM visits v LEFT JOIN staff d ON d.clinic_id = v.clinic_id AND d.id = v.dentist_id WHERE v.id = $1`, [v.id]);
      const m = await medicalState(tx, v.patient_id);
      const ack = m.active.length ? await tx.maybeOne('SELECT id FROM alert_acknowledgements WHERE visit_id = $1 AND alert_set_sha256 = $2 LIMIT 1', [v.id, m.alertSetHash]) : null;
      const plan = await loadPlan(tx, v.patient_id);
      const care = await listCare(tx, v.id);
      const careHere = new Set(care.map(c => c.id));
      const prior = await tx.one<{ n: number; last: string | null }>(`SELECT count(*)::int AS n, max(scheduled_at) AS last FROM visits
          WHERE patient_id = $1 AND id <> $2 AND status = 'COMPLETED'`, [v.patient_id, v.id]);
      return { status: 200, body: {
        visit, patient: await patientHeader(tx, v.patient_id),
        medical: { ...medicalBlock(m), acknowledgedForVisit: m.active.length === 0 || !!ack, treatmentGate: m.active.length === 0 ? 'NO_ACTIVE_ALERTS' : ack ? 'ACKNOWLEDGED' : 'SEND_ALERT_SET_HASH_WITH_CARE_OR_ACKNOWLEDGE' },
        care,
        notes: presentNotes(await loadNotes(tx, 'visit', v.id)),
        findings: presentFindings(await loadFindings(tx, 'visit', v.id)),
        // Open items of the patient, plus items completed by care confirmed in THIS visit.
        planItems: plan.filter(p => !PLAN_TERMINAL.includes(p.status) || (p.careItemId !== null && careHere.has(p.careItemId))),
        history: { completedVisitCount: prior.n, lastCompletedVisitAt: prior.last },
        syntheticDataOnly: true,
      } };
    },
  },
  {
    // Longitudinal record: medical state and reviews, plan, per-tooth history and the visit timeline.
    method: 'GET', path: '/api/v1/patients/:id/clinical-record', permission: 'clinical.read',
    handler: async ({ tx, params }) => {
      const patient = await patientHeader(tx, params.id!);
      const pid = patient.id as string;
      const m = await medicalState(tx, pid);
      const reviews = (await tx.query(`SELECT r.id, r.visit_id AS "visitId", r.method, r.no_known_allergies AS "noKnownAllergies", r.next_review_due::text AS "nextReviewDue",
          r.note, s.display_name AS "reviewedByName", r.reviewed_at AS "reviewedAt"
        FROM medical_history_reviews r JOIN staff s ON s.clinic_id = r.clinic_id AND s.id = r.reviewed_by WHERE r.patient_id = $1 ORDER BY r.reviewed_at DESC`, [pid])).rows;
      const visits = (await tx.query<{ id: string }>(`SELECT v.id, v.status, v.scheduled_at AS "scheduledAt", d.display_name AS "dentistName"
        FROM visits v LEFT JOIN staff d ON d.clinic_id = v.clinic_id AND d.id = v.dentist_id
        WHERE v.patient_id = $1 ORDER BY v.scheduled_at DESC, v.id LIMIT 200`, [pid])).rows;
      const care = await patientCare(tx, pid);
      const notes = presentNotes(await loadNotes(tx, 'patient', pid));
      const findings = presentFindings(await loadFindings(tx, 'patient', pid));
      const plan = await loadPlan(tx, pid);
      // Per-tooth projection for a future odontogram: completed care (effective site) + live findings.
      const teeth: Record<string, Array<Record<string, unknown>>> = {};
      const push = (t: unknown, e: Record<string, unknown>) => { if (typeof t === 'number') (teeth[String(t)] ??= []).push(e); };
      for (const c of care) if (c.kind === 'CARE') push(c.effectiveToothFdi, { type: 'CARE', careItemId: c.id, visitId: c.visitId, procedureCode: c.procedureCode, procedureLabel: c.procedureLabel, surfaces: c.effectiveSurfaces, siteAmended: (c.amendmentCount as number) > 0, at: c.confirmedAt });
      for (const f of findings) if (!f.enteredInError) push(f.toothFdi, { type: f.kind, findingId: f.id, visitId: f.visitId, conditionCode: f.conditionCode, surfaces: f.surfaces, at: f.recordedAt });
      for (const p of plan) if (!PLAN_TERMINAL.includes(p.status)) push(p.toothFdi, { type: 'PLANNED', planItemId: p.id, procedureCode: p.procedureCode, surfaces: p.surfaces, status: p.status, at: p.createdAt });
      return { status: 200, body: {
        patient,
        medical: { ...medicalBlock(m), alerts: m.all, reviews },
        treatmentPlan: plan,
        teeth,
        timeline: visits.map(v => ({
          ...v,
          care: care.filter(c => c.visitId === v.id).map(({ visitId: _, ...c }) => c),
          notes: notes.filter(n => n.visitId === v.id),
          findings: findings.filter(f => f.visitId === v.id),
        })),
        syntheticDataOnly: true,
      } };
    },
  },
  {
    method: 'POST', path: '/api/v1/visits/:id/clinical-notes', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body, now }) => {
      const b = asBody(body);
      const v = await getVisit(tx, params.id!);
      writableVisit(v);
      const kind = oneOf(b, 'kind', ['NOTE', 'LATE_ENTRY'] as const, true) ?? 'NOTE';
      const sections = readSections(b);
      if (SECTIONS.every(k => sections[k] === null)) fail('VALIDATION_FAILED', 'At least one of subjective, objective, assessment, plan is required');
      let effectiveAt = now.toISOString();
      let reason: string | null = null;
      if (kind === 'LATE_ENTRY') {
        effectiveAt = isoTime(b, 'effectiveAt');
        reason = str(b, 'reason', { min: 3, max: 300 });
        if (new Date(effectiveAt).getTime() >= now.getTime()) fail('VALIDATION_FAILED', 'effectiveAt of a late entry must be in the past', { field: 'effectiveAt' });
      } else if (b.effectiveAt !== undefined) fail('VALIDATION_FAILED', 'effectiveAt is only accepted for LATE_ENTRY', { field: 'effectiveAt' });
      const n = await insertNote(tx, actor!, { patientId: v.patient_id, visitId: v.id, kind, parentNoteId: null, effectiveAt, reason, ...sections });
      return { status: 201, body: { note: { id: n.id, visitId: v.id, kind, ...sections, effectiveAt, reason, contentSha256: n.contentSha256, signedBy: actor!.staffId, signedByName: actor!.displayName, signedAt: n.signedAt } } };
    },
  },
  {
    // ADDENDUM (new information) or ENTERED_IN_ERROR (strike, reason, once) on a signed note.
    method: 'POST', path: '/api/v1/clinical-notes/:id/addenda', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body, now }) => {
      const b = asBody(body);
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Note not found');
      const parent = await tx.maybeOne<{ id: string; patient_id: string; visit_id: string; kind: string }>('SELECT id, patient_id, visit_id, kind FROM clinical_notes WHERE id = $1', [params.id!]);
      if (!parent || parent.kind === 'ENTERED_IN_ERROR') fail('NOT_FOUND', 'Note not found');
      const kind = oneOf(b, 'kind', ['ADDENDUM', 'ENTERED_IN_ERROR'] as const)!;
      const struck = await tx.maybeOne("SELECT id FROM clinical_notes WHERE parent_note_id = $1 AND kind = 'ENTERED_IN_ERROR'", [parent!.id]);
      if (struck) fail('CONFLICT', 'This note is marked entered-in-error');
      const sections = kind === 'ADDENDUM' ? readSections(b) : { subjective: null, objective: null, assessment: null, plan: null };
      if (kind === 'ADDENDUM' && SECTIONS.every(k => sections[k] === null)) fail('VALIDATION_FAILED', 'An addendum needs at least one section');
      if (kind === 'ENTERED_IN_ERROR' && SECTIONS.some(k => b[k] !== undefined)) fail('VALIDATION_FAILED', 'Entered-in-error carries a reason only, no new text');
      const reason = kind === 'ENTERED_IN_ERROR' ? str(b, 'reason', { min: 3, max: 300 }) : optStr(b, 'reason', { max: 300 });
      const n = await insertNote(tx, actor!, { patientId: parent!.patient_id, visitId: parent!.visit_id, kind, parentNoteId: parent!.id, effectiveAt: now.toISOString(), reason, ...sections });
      return { status: 201, body: { note: { id: n.id, kind, parentNoteId: parent!.id, visitId: parent!.visit_id, ...sections, reason, contentSha256: n.contentSha256, signedByName: actor!.displayName, signedAt: n.signedAt } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/visits/:id/chart-findings', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const v = await getVisit(tx, params.id!);
      writableVisit(v);
      const kind = oneOf(b, 'kind', ['EXISTING', 'FINDING'] as const)!;
      const site = readDentalSite(b);
      const areaCode = int(b, 'areaCode', 0, 40, true);
      if (areaCode !== null && !AREA_CODES.includes(areaCode)) fail('VALIDATION_FAILED', 'areaCode is not an ISO 3950 area code', { field: 'areaCode' });
      if ((site.toothFdi === null) === (areaCode === null)) fail('VALIDATION_FAILED', 'Give exactly one of toothFdi or areaCode', { field: 'toothFdi' });
      const conditionCode = str(b, 'conditionCode', { min: 2, max: 41, pattern: CONDITION_CODE });
      const note = optStr(b, 'note', { max: 500 });
      const f = await tx.one<{ id: string; recorded_at: string }>(`INSERT INTO chart_findings (clinic_id, patient_id, visit_id, kind, tooth_fdi, area_code, surfaces, condition_code, note, recorded_by, recorded_role)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DENTIST') RETURNING id, recorded_at`,
        [actor!.clinicId, v.patient_id, v.id, kind, site.toothFdi, areaCode, site.surfaces, conditionCode, note, actor!.staffId]);
      await appendAudit(tx, actor!, 'clinical.finding_recorded', 'chart_finding', f.id, { visitId: v.id, kind, toothFdi: site.toothFdi, areaCode, surfaces: site.surfaces, conditionCode, hasNote: note !== null });
      return { status: 201, body: { finding: { id: f.id, visitId: v.id, kind, toothFdi: site.toothFdi, areaCode, surfaces: site.surfaces, conditionCode, note, recordedByName: actor!.displayName, recordedAt: f.recorded_at } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/chart-findings/:id/entered-in-error', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Finding not found');
      const f = await tx.maybeOne<{ id: string; patient_id: string; visit_id: string; kind: string }>('SELECT id, patient_id, visit_id, kind FROM chart_findings WHERE id = $1', [params.id!]);
      if (!f || f.kind === 'ENTERED_IN_ERROR') fail('NOT_FOUND', 'Finding not found');
      const reason = str(b, 'reason', { min: 3, max: 300 });
      if (await tx.maybeOne("SELECT id FROM chart_findings WHERE entered_in_error_of_id = $1", [f!.id])) fail('CONFLICT', 'This finding is already marked entered-in-error');
      const r = await tx.one<{ id: string }>(`INSERT INTO chart_findings (clinic_id, patient_id, visit_id, kind, entered_in_error_of_id, reason, recorded_by, recorded_role)
          VALUES ($1,$2,$3,'ENTERED_IN_ERROR',$4,$5,$6,'DENTIST') RETURNING id`, [actor!.clinicId, f!.patient_id, f!.visit_id, f!.id, reason, actor!.staffId]);
      await appendAudit(tx, actor!, 'clinical.finding_struck', 'chart_finding', f!.id, { strikeId: r.id });
      return { status: 201, body: { struck: { id: r.id, findingId: f!.id, reason } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/patients/:id/treatment-plan-items', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const patient = await patientHeader(tx, params.id!);
      const procedureCode = str(b, 'procedureCode', { min: 2, max: 32, pattern: /^[A-Z0-9_.-]{2,32}$/ });
      const procedureLabel = str(b, 'procedureLabel', { min: 2, max: 160 });
      const site = readDentalSite(b);
      const phaseNo = int(b, 'phaseNo', 1, 4, true) ?? 2;
      const estimate = b.estimatedFeeMillimes === undefined || b.estimatedFeeMillimes === null ? null : millimes(b, 'estimatedFeeMillimes', { allowZero: true });
      const note = optStr(b, 'note', { max: 500 });
      const visitId = uuid(b, 'visitId', true) || null;
      if (visitId) {
        const v = await getVisit(tx, visitId);
        if (v.patient_id !== patient.id) fail('VALIDATION_FAILED', 'visitId belongs to another patient', { field: 'visitId' });
      }
      const i = await tx.one<{ id: string }>(`INSERT INTO treatment_plan_items (clinic_id, patient_id, created_in_visit_id, procedure_code, procedure_label, tooth_fdi, surfaces, phase_no, estimated_fee_millimes, note, created_by, created_role)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DENTIST') RETURNING id`,
        [actor!.clinicId, patient.id as string, visitId, procedureCode, procedureLabel, site.toothFdi, site.surfaces, phaseNo, estimate, note, actor!.staffId]);
      await appendAudit(tx, actor!, 'clinical.plan_item_created', 'treatment_plan_item', i.id, { patientId: patient.id, visitId, procedureCode, toothFdi: site.toothFdi, surfaces: site.surfaces, phaseNo, estimatedFeeMillimes: estimate });
      return { status: 201, body: { planItem: await planItemById(tx, i.id) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/treatment-plan-items/:id/status', permission: 'clinical.write', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const item = await planItemById(tx, params.id!);
      const to = oneOf(b, 'status', ['ACCEPTED', 'DECLINED', 'CANCELLED'] as const)!;
      const reason = to === 'ACCEPTED' ? optStr(b, 'reason', { max: 300 }) : str(b, 'reason', { min: 3, max: 300 });
      if (!(PLAN_TRANSITIONS[item.status] ?? []).includes(to)) throw new AppError('PLAN_ITEM_CLOSED', `Plan item is ${item.status}; cannot change to ${to}`, { status: item.status });
      await addPlanEvent(tx, actor!, item, to, null, reason);
      return { status: 201, body: { planItem: await planItemById(tx, item.id) } };
    },
  },
  {
    // Perform a planned treatment in a visit: one dentist action creates the CARE item (fee defaults to the
    // dentist's own estimate) and closes the plan item, atomically. Same gate and guard as POST /visits/:id/care.
    method: 'POST', path: '/api/v1/treatment-plan-items/:id/perform', permission: 'care.confirm', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const item = await planItemById(tx, params.id!);
      if (PLAN_TERMINAL.includes(item.status)) throw new AppError('PLAN_ITEM_CLOSED', `Plan item is ${item.status}`, { status: item.status, careItemId: item.careItemId });
      const v = await getVisitForUpdate(tx, uuid(b, 'visitId'));
      if (v.patient_id !== item.patientId) fail('VALIDATION_FAILED', 'The visit belongs to another patient', { field: 'visitId' });
      const site = 'toothFdi' in b || 'surfaces' in b ? readDentalSite(b) : { toothFdi: item.toothFdi, surfaces: item.surfaces };
      let fee: number;
      if (b.feeMillimes !== undefined) fee = millimes(b, 'feeMillimes', { allowZero: true });
      else if (item.estimatedFeeMillimes !== null) fee = item.estimatedFeeMillimes;
      else fail('VALIDATION_FAILED', 'feeMillimes is required: the plan item has no estimate', { field: 'feeMillimes' });
      const reason = optStr(b, 'reason', { max: 300 });
      const r = await confirmCareItem(tx, actor!, v, { procedureCode: item.procedureCode, procedureLabel: item.procedureLabel, site, feeMillimes: fee!, reason, confirmRepeat: b.confirmRepeat === true, alertSetHash: readAlertSetHash(b), via: 'PLAN_PERFORM' });
      await addPlanEvent(tx, actor!, item, 'COMPLETED', r.careItem.id, null);
      return { status: 201, body: {
        ...r, planItem: await planItemById(tx, item.id),
        quoteVsCharged: { estimatedFeeMillimes: item.estimatedFeeMillimes, chargedFeeMillimes: fee!, differenceMillimes: item.estimatedFeeMillimes === null ? null : fee! - item.estimatedFeeMillimes },
      } };
    },
  },
  {
    method: 'GET', path: '/api/v1/patients/:id/treatment-plan', permission: 'clinical.read',
    handler: async ({ tx, params }) => {
      const patient = await patientHeader(tx, params.id!);
      return { status: 200, body: { patientId: patient.id, items: await loadPlan(tx, patient.id as string) } };
    },
  },
];
