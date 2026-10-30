/*
 * CNAM manual-office preparation aggregate. Never writes billing, clinical authorship or external payer
 * truth. Existing signed CARE rows supply every act, fee, site and practitioner; corrections append
 * preparation versions, not care. All writers take one clinic lock (bounded first slice) before visit
 * locks/audit, protecting empty aggregates, competing dossiers, version heads and copy numbers.
 */
import { advisoryLock, type Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, bool, int, millimes, oneOf, optStr, str, uuid, type Body } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';
import { getPatient, getVisitForUpdate } from './patients.ts';
import { clinicTimezone, localDate } from './settings.ts';

interface LineInput { careItemId: string; dentistId: string; feeMillimes: number }
interface Affiliation { identifier: string | null; insuredName: string | null; scheme: string; source: string; officiallyVerified: false }
interface CareLine extends LineInput {
  visitId: string; dentistName: string; procedureCode: string; procedureLabel: string;
  toothFdi: number | null; surfaces: string | null; siteAmendmentId: string | null;
  confirmedAt: string; careRecordedLocalDate: string; visitScheduledAt: string; corrections: string[];
}
interface Snapshot {
  patient: { id: string; fileNo: number; familyName: string; givenName: string; nameAr: string | null };
  affiliation: Affiliation | null; lines: CareLine[];
  visits: Array<{ visitId: string; chargedMillimes: number; paidMillimes: number; reducedMillimes: number; returnedMillimes: number; receipts: unknown[] }>;
  timezone: string; warnings: string[]; totalInvoicedMillimes: number;
}
interface Version { version: number; snapshot: Snapshot; snapshotHash: string; correctionReason: string | null; createdBy: string; createdAt: string }
interface Event { id: string; version: number; sequence: number; kind: string; payload: Record<string, unknown>; actorStaffId: string; occurredAt: string }
const estimation = { available: false, label: 'Estimation indisponible', amountMillimes: null, reason: 'CURRENT_PRIMARY_RULES_NOT_VALIDATED' } as const;

function only(b: Body, keys: string[]) {
  if (Object.keys(b).some(k => !keys.includes(k))) fail('VALIDATION_FAILED', 'Unknown or unsupported field');
}
function linesInput(b: Body): LineInput[] {
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > 100) fail('VALIDATION_FAILED', 'lines must contain 1 to 100 signed care references');
  const lines = (b.lines as unknown[]).map(raw => {
    const l = asBody(raw); only(l, ['careItemId', 'dentistId', 'feeMillimes']);
    return { careItemId: uuid(l, 'careItemId'), dentistId: uuid(l, 'dentistId'), feeMillimes: millimes(l, 'feeMillimes', { allowZero: true }) };
  }).sort((a, b) => a.careItemId.localeCompare(b.careItemId));
  if (new Set(lines.map(l => l.careItemId)).size !== lines.length) fail('VALIDATION_FAILED', 'Duplicate care reference');
  return lines;
}
function affiliationInput(b: Body): Affiliation | null {
  if (b.affiliation == null) return null;
  const a = asBody(b.affiliation); only(a, ['identifier', 'insuredName', 'scheme', 'source']);
  return { identifier: optStr(a, 'identifier', { max: 80 }), insuredName: optStr(a, 'insuredName', { max: 160 }),
    scheme: oneOf(a, 'scheme', ['CNSS', 'CNRPS', 'UNKNOWN'])!, source: oneOf(a, 'source', ['PATIENT_REPORTED', 'STAFF_REPORTED'])!, officiallyVerified: false };
}
async function snapshot(tx: Tx, patientId: string, inputs: LineInput[], affiliation: Affiliation | null, checkingIssuedSource = false): Promise<Snapshot> {
  const p = await getPatient(tx, patientId);
  const timezone = await clinicTimezone(tx, tx.clinicId!);
  // Stable visit order is shared with clinical/financial writers. Existing writers lock visits before
  // changing signed fee/site history, so issue checks cannot race a correction of linked care.
  const refs = await tx.query<{ visit_id: string }>('SELECT DISTINCT visit_id FROM care_items WHERE id = ANY($1::uuid[]) ORDER BY visit_id', ['{' + inputs.map(l => l.careItemId).join(',') + '}']);
  for (const v of refs.rows) await getVisitForUpdate(tx, v.visit_id);
  const lines: CareLine[] = [];
  for (const l of inputs) {
    const c = await tx.maybeOne<{ patient_id: string; confirmed_by: string; visit_id: string; confirmed_at: string; scheduled_at: string; procedure_code: string; procedure_label: string;
      tooth_fdi: number | null; surfaces: string | null; head_amendment_id: string | null; dentist_name: string; fee: number; corrections: string[] }>(
      `SELECT c.patient_id,c.confirmed_by,c.visit_id,c.confirmed_at,v.scheduled_at,c.procedure_code,c.procedure_label,
        e.tooth_fdi,e.surfaces,e.head_amendment_id,s.display_name AS dentist_name,
        (c.fee_millimes + coalesce((SELECT sum(fee_millimes) FROM care_items WHERE corrects_id = c.id),0))::bigint AS fee,
        coalesce((SELECT json_agg(id ORDER BY id) FROM care_items WHERE corrects_id = c.id),'[]'::json) AS corrections
       FROM care_items c JOIN staff s ON s.clinic_id = c.clinic_id AND s.id = c.confirmed_by
       JOIN visits v ON v.clinic_id = c.clinic_id AND v.id = c.visit_id
       JOIN care_effective_sites e ON e.care_item_id = c.id
       WHERE c.id = $1 AND c.kind = 'CARE' AND c.confirmed_by_role = 'DENTIST'`, [l.careItemId]);
    if (!c) fail('NOT_FOUND', 'Signed care not found in this clinic');
    if (c!.patient_id !== patientId || c!.confirmed_by !== l.dentistId || Number(c!.fee) !== l.feeMillimes) {
      if (checkingIssuedSource) fail('CONFLICT', 'Signed care changed; prepare a corrected version', { reason: 'CNAM_CARE_CHANGED' });
      fail('VALIDATION_FAILED', 'Care patient, actual dentist or invoiced fee does not match');
    }
    lines.push({ ...l, visitId: c!.visit_id, dentistName: c!.dentist_name, procedureCode: c!.procedure_code,
      procedureLabel: c!.procedure_label, toothFdi: c!.tooth_fdi, surfaces: c!.surfaces, siteAmendmentId: c!.head_amendment_id,
      confirmedAt: c!.confirmed_at, careRecordedLocalDate: localDate(timezone, new Date(c!.confirmed_at)), visitScheduledAt: c!.scheduled_at, corrections: c!.corrections });
  }
  const visits: Snapshot['visits'] = [];
  for (const visitId of [...new Set(lines.map(l => l.visitId))].sort()) {
    const v = await tx.one<{ charged_millimes: number; paid_millimes: number; reduced_millimes: number; returned_millimes: number }>('SELECT * FROM visit_balances WHERE visit_id = $1', [visitId]);
    const receipts = (await tx.query(`SELECT r.id,r.number,p.id AS "paymentId",p.amount_millimes AS "amountMillimes"
      FROM payments p JOIN receipts r ON r.clinic_id = p.clinic_id AND r.payment_id = p.id
      WHERE p.visit_id = $1 ORDER BY r.number,r.id`, [visitId])).rows;
    visits.push({ visitId, chargedMillimes: Number(v.charged_millimes), paidMillimes: Number(v.paid_millimes),
      reducedMillimes: Number(v.reduced_millimes), returnedMillimes: Number(v.returned_millimes), receipts });
  }
  const warnings = ['OFFICIAL_FORM_NOT_VALIDATED', 'WET_DENTIST_SIGNATURE_AND_STAMP_REQUIRED', 'CODES_ARE_LOCAL_NOT_VERIFIED_CNAM_CODES', 'ELIGIBILITY_AND_DEADLINE_UNVERIFIED'];
  if (visits.some(v => v.chargedMillimes - v.reducedMillimes - v.paidMillimes + v.returnedMillimes > 0)) warnings.push('CLINIC_BALANCE_OUTSTANDING');
  return { patient: { id: p.id, fileNo: p.fileNo, familyName: p.familyName, givenName: p.givenName, nameAr: p.nameAr }, affiliation, lines, visits, timezone, warnings,
    totalInvoicedMillimes: lines.reduce((sum, l) => sum + l.feeMillimes, 0) };
}
async function readDossier(tx: Tx, id: string) {
  uuid({ id }, 'id');
  const d = await tx.maybeOne<{ id: string; patientId: string; createdBy: string; createdAt: string }>(
    'SELECT id,patient_id AS "patientId",created_by AS "createdBy",created_at AS "createdAt" FROM cnam_dossiers WHERE id = $1', [id]);
  if (!d) fail('NOT_FOUND', 'CNAM dossier not found');
  const versions = (await tx.query<Version>(`SELECT version,snapshot,snapshot_hash AS "snapshotHash",correction_reason AS "correctionReason",
    created_by AS "createdBy",created_at AS "createdAt" FROM cnam_versions WHERE dossier_id = $1 ORDER BY version`, [id])).rows;
  const events = (await tx.query<Event>(`SELECT id,version,sequence,kind,payload,actor_staff_id AS "actorStaffId",occurred_at AS "occurredAt"
    FROM cnam_events WHERE dossier_id = $1 ORDER BY version,sequence`, [id])).rows;
  for (const v of versions) if (sha256(canonicalJson(v.snapshot)) !== v.snapshotHash) fail('CONTENT_INTEGRITY_FAILED', 'CNAM snapshot integrity check failed');
  const currentVersion = versions.at(-1)!.version;
  const current = events.filter(e => e.version === currentVersion);
  const state = current.some(e => e.kind === 'HANDOFF_REPORTED') ? 'HANDED_TO_PATIENT' : current.some(e => e.kind === 'ISSUED') ? 'READY_FOR_PAPER_REVIEW' : 'PREPARING';
  return { ...d!, currentVersion, state, documentKind: 'LOCAL_PREPARATION_DATA', officialForm: false, estimation,
    versions: versions.map(v => ({ ...v, issue: events.find(e => e.version === v.version && e.kind === 'ISSUED') ?? null,
      events: events.filter(e => e.version === v.version) })) };
}
async function current(tx: Tx, id: string, b: Body) {
  await advisoryLock(tx, 'cnam', tx.clinicId!);
  const d = await readDossier(tx, id);
  if (int(b, 'expectedVersion', 1, 1000000) !== d.currentVersion) fail('CONFLICT', 'Reload the current CNAM dossier version', { reason: 'CNAM_VERSION_STALE', currentVersion: d.currentVersion });
  return d;
}
async function event(tx: Tx, actor: Actor, id: string, version: number, kind: string, payload: Record<string, unknown>) {
  const seq = await tx.one<{ next: number }>('SELECT coalesce(max(sequence),0) + 1 AS next FROM cnam_events WHERE dossier_id = $1 AND version = $2', [id, version]);
  return tx.one<Event>(`INSERT INTO cnam_events(clinic_id,dossier_id,version,sequence,kind,payload,actor_staff_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,version,sequence,kind,payload,actor_staff_id AS "actorStaffId",occurred_at AS "occurredAt"`,
  [actor.clinicId, id, version, seq.next, kind, JSON.stringify(payload), actor.staffId]);
}
async function version(tx: Tx, actor: Actor, id: string, n: number, s: Snapshot, reason: string | null) {
  const hash = sha256(canonicalJson(s));
  await tx.query(`INSERT INTO cnam_versions(clinic_id,dossier_id,version,snapshot,snapshot_hash,correction_reason,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actor.clinicId, id, n, JSON.stringify(s), hash, reason, actor.staffId]);
  await appendAudit(tx, actor, n === 1 ? 'cnam.prepared' : 'cnam.corrected', 'cnam_dossier', id, { version: n, snapshotHash: hash, reasonHash: reason ? sha256(reason) : null });
}
function issued(d: Awaited<ReturnType<typeof readDossier>>) {
  const v = d.versions.at(-1)!;
  if (!v.issue) fail('CONFLICT', 'Issue the preparation version before handoff or copies', { reason: 'CNAM_NOT_ISSUED' });
  return v;
}

export const cnamRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/cnam/dossiers', permission: 'cnam.prepare', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body); only(b, ['patientId', 'lines', 'affiliation']);
      await advisoryLock(tx, 'cnam', actor!.clinicId);
      const s = await snapshot(tx, uuid(b, 'patientId'), linesInput(b), affiliationInput(b));
      const hash = sha256(canonicalJson(s));
      const prior = await tx.maybeOne<{ id: string }>('SELECT id FROM cnam_dossiers WHERE patient_id = $1 AND creation_hash = $2', [s.patient.id, hash]);
      if (prior) return { status: 200, body: { dossier: await readDossier(tx, prior.id), recoveredExisting: true } };
      const d = await tx.one<{ id: string }>(`INSERT INTO cnam_dossiers(clinic_id,patient_id,creation_hash,created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [actor!.clinicId, s.patient.id, hash, actor!.staffId]);
      await version(tx, actor!, d.id, 1, s, null);
      return { status: 201, body: { dossier: await readDossier(tx, d.id) } };
    } },
  { method: 'GET', path: '/api/v1/cnam/dossiers', permission: 'cnam.read',
    handler: async ({ tx, query }) => {
      const patientId = uuid({ patientId: query.get('patientId') }, 'patientId'); await getPatient(tx, patientId);
      const ds = (await tx.query<{ id: string }>('SELECT id FROM cnam_dossiers WHERE patient_id = $1 ORDER BY created_at DESC,id LIMIT 100', [patientId])).rows;
      const dossiers = [];
      for (const d of ds) { const v = await readDossier(tx, d.id); dossiers.push({ id: d.id, currentVersion: v.currentVersion, state: v.state, createdAt: v.createdAt }); }
      return { status: 200, body: { dossiers, limit: 100, estimation } };
    } },
  { method: 'GET', path: '/api/v1/cnam/dossiers/:id', permission: 'cnam.read',
    handler: async ({ tx, params }) => ({ status: 200, body: { dossier: await readDossier(tx, params.id!) } }) },
  { method: 'POST', path: '/api/v1/cnam/dossiers/:id/corrections', permission: 'cnam.correct', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body); only(b, ['patientId', 'lines', 'affiliation', 'expectedVersion', 'reason']);
      const d = await current(tx, params.id!, b);
      const reason = str(b, 'reason', { min: 3, max: 300 });
      if (uuid(b, 'patientId') !== d.patientId) fail('VALIDATION_FAILED', 'A correction cannot change the dossier patient');
      const s = await snapshot(tx, d.patientId, linesInput(b), affiliationInput(b));
      // Conservative first-slice correction policy: a dentist can revise only preparation that refers
      // entirely to their own signed acts; multi-practitioner corrections await a reviewed policy.
      if ([...d.versions.at(-1)!.snapshot.lines, ...s.lines].some(l => l.dentistId !== actor!.staffId)) fail('FORBIDDEN_ROLE', 'Correction requires the actual treating dentist for every linked act');
      await version(tx, actor!, d.id, d.currentVersion + 1, s, reason);
      return { status: 201, body: { dossier: await readDossier(tx, d.id) } };
    } },
  { method: 'POST', path: '/api/v1/cnam/dossiers/:id/issue', permission: 'cnam.prepare', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body); only(b, ['expectedVersion']); const d = await current(tx, params.id!, b);
      const v = d.versions.at(-1)!;
      if (v.issue) return { status: 200, body: { dossier: d, recoveredExisting: true } };
      const s = await snapshot(tx, d.patientId, v.snapshot.lines, v.snapshot.affiliation, true);
      if (sha256(canonicalJson(s)) !== v.snapshotHash) fail('CONFLICT', 'Source care, patient or payment data changed; prepare a corrected version', { reason: 'CNAM_CARE_CHANGED' });
      for (const l of s.lines) {
        const prior = await tx.maybeOne<{ dossier_id: string }>('SELECT dossier_id FROM cnam_issued_care WHERE care_item_id = $1', [l.careItemId]);
        if (prior && prior.dossier_id !== d.id) fail('CONFLICT', 'Signed care is already reserved to another dossier; review required', { reason: 'CNAM_ACT_ALREADY_ISSUED' });
        if (!prior) await tx.query('INSERT INTO cnam_issued_care(clinic_id,care_item_id,dossier_id) VALUES ($1,$2,$3)', [actor!.clinicId, l.careItemId, d.id]);
      }
      const number = 'CNAM-' + d.id + '-v' + d.currentVersion;
      const e = await event(tx, actor!, d.id, d.currentVersion, 'ISSUED', { number, snapshotHash: v.snapshotHash, officialForm: false, printing: 'NOT_VERIFIED', paperDelivery: 'UNKNOWN' });
      await appendAudit(tx, actor!, 'cnam.issued', 'cnam_dossier', d.id, { eventId: e.id, version: d.currentVersion, snapshotHash: v.snapshotHash });
      return { status: 200, body: { dossier: await readDossier(tx, d.id) } };
    } },
  { method: 'POST', path: '/api/v1/cnam/dossiers/:id/copies', permission: 'cnam.prepare', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body); only(b, ['expectedVersion']); const d = await current(tx, params.id!, b); const v = issued(d);
      const copyNumber = v.events.filter(e => e.kind === 'COPY_PREPARED').length + 1;
      const e = await event(tx, actor!, d.id, d.currentVersion, 'COPY_PREPARED', { copyNumber, label: 'COPY', snapshotHash: v.snapshotHash, printing: 'NOT_VERIFIED', paperDelivery: 'UNKNOWN' });
      await appendAudit(tx, actor!, 'cnam.copy_prepared', 'cnam_dossier', d.id, { eventId: e.id, version: d.currentVersion, copyNumber, snapshotHash: v.snapshotHash });
      return { status: 200, body: { copy: { ...e.payload, id: e.id, actorStaffId: e.actorStaffId, occurredAt: e.occurredAt }, snapshot: v.snapshot } };
    } },
  { method: 'POST', path: '/api/v1/cnam/dossiers/:id/handoff', permission: 'cnam.prepare', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body); only(b, ['expectedVersion', 'handedToPatientReported']); const d = await current(tx, params.id!, b); const v = issued(d);
      if (!bool(b, 'handedToPatientReported')) fail('VALIDATION_FAILED', 'An explicit staff report of patient handoff is required');
      if (!v.events.some(e => e.kind === 'HANDOFF_REPORTED')) {
        const e = await event(tx, actor!, d.id, d.currentVersion, 'HANDOFF_REPORTED', { source: 'STAFF_REPORTED', independentlyVerified: false, number: v.issue!.payload.number });
        await appendAudit(tx, actor!, 'cnam.handoff_reported', 'cnam_dossier', d.id, { eventId: e.id, version: d.currentVersion });
      }
      return { status: 200, body: { dossier: await readDossier(tx, d.id) } };
    } },
  { method: 'POST', path: '/api/v1/cnam/dossiers/:id/reports', permission: 'cnam.prepare', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body); only(b, ['expectedVersion', 'status', 'source', 'consentAcknowledged', 'amountMillimes', 'note']);
      const d = await current(tx, params.id!, b); issued(d);
      if (d.state !== 'HANDED_TO_PATIENT') fail('CONFLICT', 'Record the reported handoff before optional follow-up');
      if (!bool(b, 'consentAcknowledged')) fail('VALIDATION_FAILED', 'Optional follow-up requires recorded consent acknowledgement');
      const status = oneOf(b, 'status', ['SUBMITTED', 'REJECTED', 'REIMBURSED'])!;
      if (status !== 'REIMBURSED' && b.amountMillimes !== undefined) fail('VALIDATION_FAILED', 'Only a reimbursement report may carry an amount');
      const payload = { status, source: oneOf(b, 'source', ['PATIENT_REPORTED', 'STAFF_REPORTED'])!, consentAcknowledged: true,
        amountMillimes: status === 'REIMBURSED' ? millimes(b, 'amountMillimes', { allowZero: true }) : null,
        note: optStr(b, 'note', { max: 300 }), officiallyVerified: false, payee: 'PATIENT' };
      const e = await event(tx, actor!, d.id, d.currentVersion, 'OUTCOME_REPORTED', payload);
      await appendAudit(tx, actor!, 'cnam.reported', 'cnam_dossier', d.id, { eventId: e.id, version: d.currentVersion, status, source: payload.source, payloadHash: sha256(canonicalJson(payload)) });
      return { status: 201, body: { report: { ...payload, id: e.id, actorStaffId: e.actorStaffId, occurredAt: e.occurredAt } } };
    } },
];
