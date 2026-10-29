/*
 * DENTAL LAB module (R73-E, clinical-requirements §9). Owns: lab_suppliers, lab_cases, lab_case_events,
 * lab_case_care_links, lab_invoices, lab_invoice_cases. Depends on: audit, patients, settings (clinic day).
 *
 * Records the dentist's order to a lab and its round trips; it never chooses a material, a shade or a treatment and
 * never contacts a supplier. Lifecycle (current status = latest event; none = CREATED):
 *   CREATED -> SENT -> (TRY_IN_RETURNED <-> RESENT)* -> RECEIVED -> FITTED | REMAKE_REQUESTED;  CANCELLED before FITTED.
 * Logistics steps (SENT, TRY_IN_RETURNED, RESENT, RECEIVED) by dentist or assistant; FITTED, CANCELLED, remake and
 * links to billed care items by the dentist only. A remake is a NEW case pointing to the original, with the reason and
 * the responsible party. Desk staff see a status/date board without clinical detail. Lab invoices are clinic expenses
 * recorded by the owner; they never touch patient billing.
 * MF19: labExceptionFacts lists received/fitted work with no linked billed care item after N clinic days, and lab
 * invoices whose cases have none (the owner exception list words them as evidence, never as accusations).
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr, oneOf, int, isoDate, isUuid, uuid, millimes } from '../platform/validate.ts';
import { isValidFdiTooth } from '../contracts/clinical.ts';
import { appendAudit } from './audit.ts';
import { getPatient, getVisit } from './patients.ts';
import { clinicTimezone, localDate } from './settings.ts';

export const CASE_TYPES = ['CROWN', 'BRIDGE', 'INLAY_ONLAY', 'VENEER', 'PARTIAL_DENTURE', 'COMPLETE_DENTURE', 'NIGHT_GUARD', 'ALIGNER', 'REPAIR', 'OTHER'] as const;
export type LabStatus = 'CREATED' | 'SENT' | 'TRY_IN_RETURNED' | 'RESENT' | 'RECEIVED' | 'FITTED' | 'REMAKE_REQUESTED' | 'CANCELLED';
const TRANSITIONS: Record<LabStatus, LabStatus[]> = {
  CREATED: ['SENT', 'CANCELLED'],
  SENT: ['TRY_IN_RETURNED', 'RECEIVED', 'CANCELLED'],
  TRY_IN_RETURNED: ['RESENT', 'CANCELLED'],
  RESENT: ['TRY_IN_RETURNED', 'RECEIVED', 'CANCELLED'],
  RECEIVED: ['FITTED', 'REMAKE_REQUESTED', 'CANCELLED'],
  FITTED: [], REMAKE_REQUESTED: [], CANCELLED: [],
};
const DENTIST_ONLY: LabStatus[] = ['FITTED', 'REMAKE_REQUESTED', 'CANCELLED'];
const OPEN: LabStatus[] = ['CREATED', 'SENT', 'TRY_IN_RETURNED', 'RESENT', 'RECEIVED'];
const AREA_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40];

const roleOf = (a: Actor): 'DENTIST' | 'ASSISTANT' => (a.roles.includes('DENTIST') ? 'DENTIST' : 'ASSISTANT');
const pgArray = (v: unknown): string[] => String(v ?? '{}').replace(/[{}]/g, '').split(',').filter(Boolean);
const lockCase = (tx: Tx, id: string) => tx.query("SELECT pg_advisory_xact_lock(hashtext('lab_case:' || $1))", [id]);

interface CaseRow {
  id: string; patient_id: string; visit_id: string | null; supplier_id: string; supplier: string; case_type: string; teeth: unknown; area_code: number | null;
  material: string | null; shade: string | null; impression: string; instructions: string | null; due_on: string | null; remake_of_id: string | null;
  remake_responsibility: string | null; created_role: string; created_at: string; status: LabStatus; last_seq: number;
}
const SELECT_CASE = 'SELECT c.id, c.patient_id, c.visit_id, c.supplier_id, s.name AS supplier, c.case_type, c.teeth, c.area_code, c.material, c.shade, c.impression, '
  + 'c.instructions, c.due_on::text AS due_on, c.remake_of_id, c.remake_responsibility, c.created_role, c.created_at, '
  + "coalesce((SELECT e.status FROM lab_case_events e WHERE e.case_id = c.id ORDER BY e.seq DESC LIMIT 1), 'CREATED') AS status, "
  + 'coalesce((SELECT max(e.seq) FROM lab_case_events e WHERE e.case_id = c.id), 0)::int AS last_seq '
  + 'FROM lab_cases c JOIN lab_suppliers s ON s.id = c.supplier_id';

async function loadCase(tx: Tx, id: string): Promise<CaseRow> {
  if (!isUuid(id)) fail('NOT_FOUND', 'Lab case not found');
  const c = await tx.maybeOne<CaseRow>(SELECT_CASE + ' WHERE c.id = $1', [id]);
  if (!c) fail('NOT_FOUND', 'Lab case not found');
  return c!;
}
const view = (c: CaseRow) => ({
  id: c.id, patientId: c.patient_id, visitId: c.visit_id, supplier: { id: c.supplier_id, name: c.supplier }, caseType: c.case_type,
  teeth: pgArray(c.teeth).map(Number), areaCode: c.area_code, material: c.material, shade: c.shade, impression: c.impression, instructions: c.instructions,
  dueOn: c.due_on, status: c.status, remakeOfId: c.remake_of_id, remakeResponsibility: c.remake_responsibility, createdRole: c.created_role,
  createdAt: new Date(c.created_at).toISOString(), allowedNext: TRANSITIONS[c.status].filter(s => s !== 'REMAKE_REQUESTED'),
});

async function supplierExists(tx: Tx, id: string) {
  if (!isUuid(id) || !(await tx.maybeOne('SELECT 1 FROM lab_suppliers WHERE id = $1', [id]))) fail('VALIDATION_FAILED', 'supplierId is not a lab supplier of this clinic', { field: 'supplierId' });
}

function readSite(b: Record<string, unknown>) {
  const raw = b.teeth ?? [];
  if (!Array.isArray(raw) || raw.length > 32 || !raw.every(t => typeof t === 'number' && isValidFdiTooth(t)) || new Set(raw).size !== raw.length)
    fail('VALIDATION_FAILED', 'teeth must be a list of distinct FDI tooth numbers (max 32)', { field: 'teeth' });
  const areaCode = int(b, 'areaCode', 0, 40, true);
  if (areaCode !== null && !AREA_CODES.includes(areaCode)) fail('VALIDATION_FAILED', 'areaCode is not a valid FDI area code', { field: 'areaCode' });
  return { teeth: (raw as number[]).slice().sort((x, y) => x - y), areaCode };
}

async function addStatus(tx: Tx, actor: Actor, c: CaseRow, to: LabStatus, reason: string | null) {
  if (!TRANSITIONS[c.status].includes(to)) fail('CONFLICT', `A ${c.status} lab case cannot become ${to}`, { from: c.status, allowed: TRANSITIONS[c.status] });
  if (DENTIST_ONLY.includes(to) && !actor.roles.includes('DENTIST')) fail('FORBIDDEN_ROLE', `${to} is recorded by a dentist`);
  if ((to === 'CANCELLED' || to === 'REMAKE_REQUESTED') && !reason) fail('VALIDATION_FAILED', `reason is required for ${to}`, { field: 'reason' });
  await tx.query('INSERT INTO lab_case_events (clinic_id, case_id, seq, status, reason, by_staff_id, by_role) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [actor.clinicId, c.id, c.last_seq + 1, to, reason, actor.staffId, roleOf(actor)]);
  await appendAudit(tx, actor, 'lab.case_status', 'lab_case', c.id, { seq: c.last_seq + 1, from: c.status, to, patientId: c.patient_id, hasReason: reason !== null });
}

/** MF19 facts for the owner exception list (no clinical detail: case type, supplier, file number, dates). */
export async function labExceptionFacts(tx: Tx, asOfStartIso: string, unbilledDays: number) {
  const work = (await tx.query<{ id: string; case_type: string; supplier: string; file_no: number; status: string; received_at: string }>(
    `SELECT c.id, c.case_type, s.name AS supplier, p.file_no, cur.status, rec.at AS received_at
       FROM lab_cases c JOIN lab_suppliers s ON s.id = c.supplier_id JOIN patients p ON p.id = c.patient_id
       CROSS JOIN LATERAL (SELECT e.status FROM lab_case_events e WHERE e.case_id = c.id ORDER BY e.seq DESC LIMIT 1) cur
       CROSS JOIN LATERAL (SELECT min(e.at) AS at FROM lab_case_events e WHERE e.case_id = c.id AND e.status = 'RECEIVED') rec
      WHERE cur.status IN ('RECEIVED', 'FITTED') AND rec.at < $1::timestamptz - make_interval(days => $2)
        AND NOT EXISTS (SELECT 1 FROM lab_case_care_links l WHERE l.case_id = c.id)
      ORDER BY rec.at`, [asOfStartIso, unbilledDays])).rows;
  const invoices = (await tx.query<{ id: string; invoice_number: string; supplier: string; amount_millimes: number; invoice_date: string; unlinked: number }>(
    `SELECT i.id, i.invoice_number, s.name AS supplier, i.amount_millimes, i.invoice_date::text AS invoice_date,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lab_case_care_links l WHERE l.case_id = ic.case_id))::int AS unlinked
       FROM lab_invoices i JOIN lab_suppliers s ON s.id = i.supplier_id JOIN lab_invoice_cases ic ON ic.invoice_id = i.id
      WHERE i.invoice_date < ($1::timestamptz - make_interval(days => $2))::date
      GROUP BY i.id, s.name HAVING count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM lab_case_care_links l WHERE l.case_id = ic.case_id)) > 0`,
    [asOfStartIso, unbilledDays])).rows;
  return { work, invoices };
}

export const labRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/lab/suppliers', permission: 'lab.supplier.manage', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const name = str(b, 'name', { min: 2, max: 120 });
      const contact = optStr(b, 'contact', { max: 200 });
      const r = await tx.one<{ id: string }>('INSERT INTO lab_suppliers (clinic_id, name, contact, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [actor!.clinicId, name, contact, actor!.staffId]);
      await appendAudit(tx, actor!, 'lab.supplier_created', 'lab_supplier', r.id, { name });
      return { status: 201, body: { supplier: { id: r.id, name, contact } } };
    },
  },
  {
    method: 'GET', path: '/api/v1/lab/suppliers', permission: 'lab.supplier.read',
    handler: async ({ tx }) => ({ status: 200, body: { suppliers: (await tx.query('SELECT id, name, contact FROM lab_suppliers ORDER BY lower(name)')).rows } }),
  },
  {
    method: 'POST', path: '/api/v1/patients/:id/lab-cases', permission: 'lab.case.create', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const patient = await getPatient(tx, params.id!) as { id: string };
      const supplierId = uuid(b, 'supplierId');
      await supplierExists(tx, supplierId);
      const caseType = oneOf(b, 'caseType', CASE_TYPES)!;
      const site = readSite(b);
      const impression = oneOf(b, 'impression', ['PHYSICAL', 'DIGITAL_SCAN'] as const)!;
      const visitId = uuid(b, 'visitId', true) || null;
      if (visitId && (await getVisit(tx, visitId)).patient_id !== patient.id) fail('VALIDATION_FAILED', 'visitId belongs to another patient', { field: 'visitId' });
      const r = await tx.one<{ id: string }>(`INSERT INTO lab_cases (clinic_id, patient_id, visit_id, supplier_id, case_type, teeth, area_code, material, shade, impression,
          instructions, due_on, created_by, created_role) VALUES ($1,$2,$3,$4,$5,$6::smallint[],$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [actor!.clinicId, patient.id, visitId, supplierId, caseType, '{' + site.teeth.join(',') + '}', site.areaCode, optStr(b, 'material', { max: 80 }),
          optStr(b, 'shade', { max: 40 }), impression, optStr(b, 'instructions', { max: 1000 }), isoDate(b, 'dueOn', true), actor!.staffId, roleOf(actor!)]);
      await appendAudit(tx, actor!, 'lab.case_created', 'lab_case', r.id, { patientId: patient.id, visitId, supplierId, caseType, teeth: site.teeth, areaCode: site.areaCode });
      return { status: 201, body: { labCase: view(await loadCase(tx, r.id)) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/patients/:id/lab-cases', permission: 'lab.case.read',
    handler: async ({ tx, params }) => {
      const patient = await getPatient(tx, params.id!) as { id: string };
      const rows = (await tx.query<CaseRow>(SELECT_CASE + ' WHERE c.patient_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 200', [patient.id])).rows;
      return { status: 200, body: { patientId: patient.id, labCases: rows.map(view) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/lab-cases/:id', permission: 'lab.case.read',
    handler: async ({ tx, params }) => {
      const c = await loadCase(tx, params.id!);
      const history = (await tx.query<{ seq: number; status: string; reason: string | null; by_role: string; name: string; at: string }>(
        `SELECT e.seq, e.status, e.reason, e.by_role, s.display_name AS name, e.at FROM lab_case_events e JOIN staff s ON s.id = e.by_staff_id
          WHERE e.case_id = $1 ORDER BY e.seq`, [c.id])).rows.map(e => ({ seq: e.seq, status: e.status, reason: e.reason, byRole: e.by_role, by: e.name, at: new Date(e.at).toISOString() }));
      const careLinks = (await tx.query<{ care_item_id: string; procedure_label: string; linked_at: string }>(
        `SELECT l.care_item_id, ci.procedure_label, l.linked_at FROM lab_case_care_links l JOIN care_items ci ON ci.id = l.care_item_id WHERE l.case_id = $1 ORDER BY l.linked_at`, [c.id])).rows
        .map(l => ({ careItemId: l.care_item_id, procedureLabel: l.procedure_label, linkedAt: new Date(l.linked_at).toISOString() }));
      const remakes = (await tx.query<{ id: string }>('SELECT id FROM lab_cases WHERE remake_of_id = $1 ORDER BY created_at', [c.id])).rows.map(r => r.id);
      return { status: 200, body: { labCase: view(c), history, careLinks, remakes } };
    },
  },
  {
    method: 'POST', path: '/api/v1/lab-cases/:id/status', permission: 'lab.case.track', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const to = oneOf(b, 'status', ['SENT', 'TRY_IN_RETURNED', 'RESENT', 'RECEIVED', 'FITTED', 'CANCELLED'] as const)!;
      const reason = optStr(b, 'reason', { max: 300 });
      if (reason !== null && reason.length < 3) fail('VALIDATION_FAILED', 'reason has invalid length', { field: 'reason' });
      await lockCase(tx, params.id!);
      const c = await loadCase(tx, params.id!);
      await addStatus(tx, actor!, c, to, reason);
      return { status: 200, body: { labCase: view(await loadCase(tx, c.id)) } };
    },
  },
  {
    // A remake closes the received case and opens a NEW case for the same patient, linked to the original.
    method: 'POST', path: '/api/v1/lab-cases/:id/remake', permission: 'lab.case.sign', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const reason = str(b, 'reason', { min: 3, max: 300 });
      const responsibility = oneOf(b, 'responsibility', ['LAB', 'CLINIC', 'PATIENT'] as const)!;
      await lockCase(tx, params.id!);
      const c = await loadCase(tx, params.id!);
      const supplierId = uuid(b, 'supplierId', true) || c.supplier_id;
      await supplierExists(tx, supplierId);
      await addStatus(tx, actor!, c, 'REMAKE_REQUESTED', reason);
      const r = await tx.one<{ id: string }>(`INSERT INTO lab_cases (clinic_id, patient_id, visit_id, supplier_id, case_type, teeth, area_code, material, shade, impression,
          instructions, due_on, remake_of_id, remake_responsibility, created_by, created_role)
          SELECT clinic_id, patient_id, visit_id, $2, case_type, teeth, area_code, material, shade, impression, instructions, $3, id, $4, $5, 'DENTIST'
          FROM lab_cases WHERE id = $1 RETURNING id`, [c.id, supplierId, isoDate(b, 'dueOn', true), responsibility, actor!.staffId]);
      await appendAudit(tx, actor!, 'lab.case_created', 'lab_case', r.id, { patientId: c.patient_id, remakeOfId: c.id, responsibility, supplierId });
      return { status: 201, body: { original: view(await loadCase(tx, c.id)), remake: view(await loadCase(tx, r.id)) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/lab-cases/:id/care-links', permission: 'lab.case.sign', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const careItemId = uuid(asBody(body), 'careItemId');
      const c = await loadCase(tx, params.id!);
      const ci = await tx.maybeOne<{ patient_id: string }>('SELECT patient_id FROM care_items WHERE id = $1', [careItemId]);
      if (!ci) fail('NOT_FOUND', 'Care item not found');
      if (ci!.patient_id !== c.patient_id) fail('VALIDATION_FAILED', 'The care item belongs to another patient', { field: 'careItemId' });
      if (await tx.maybeOne('SELECT 1 FROM lab_case_care_links WHERE case_id = $1 AND care_item_id = $2', [c.id, careItemId])) fail('CONFLICT', 'Already linked');
      const r = await tx.one<{ id: string }>('INSERT INTO lab_case_care_links (clinic_id, case_id, care_item_id, linked_by) VALUES ($1,$2,$3,$4) RETURNING id', [actor!.clinicId, c.id, careItemId, actor!.staffId]);
      await appendAudit(tx, actor!, 'lab.care_linked', 'lab_case_care_link', r.id, { caseId: c.id, careItemId, patientId: c.patient_id });
      return { status: 201, body: { link: { id: r.id, caseId: c.id, careItemId } } };
    },
  },
  {
    // Desk board: open cases with logistics only (no teeth, material, shade or instructions).
    method: 'GET', path: '/api/v1/lab/board', permission: 'lab.status.read',
    handler: async ({ tx, actor }) => {
      const rows = (await tx.query<CaseRow & { file_no: number; family_name: string; given_name: string }>(
        'SELECT x.*, p.file_no, p.family_name, p.given_name FROM (' + SELECT_CASE + ') x JOIN patients p ON p.id = x.patient_id WHERE x.status = ANY($1::text[]) ORDER BY x.due_on NULLS LAST, x.created_at',
        ['{' + OPEN.join(',') + '}'])).rows;
      const today = localDate(await clinicTimezone(tx, actor!.clinicId));
      return { status: 200, body: { cases: rows.map(r => ({ id: r.id, patient: { id: r.patient_id, fileNo: r.file_no, name: `${r.family_name} ${r.given_name}` }, caseType: r.case_type,
        supplier: r.supplier, status: r.status, dueOn: r.due_on, overdue: r.due_on !== null && r.due_on < today && r.status !== 'RECEIVED' })) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/lab/invoices', permission: 'lab.invoice.record', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const supplierId = uuid(b, 'supplierId');
      await supplierExists(tx, supplierId);
      const invoiceNumber = str(b, 'invoiceNumber', { max: 60 });
      const invoiceDate = isoDate(b, 'invoiceDate')!;
      const amount = millimes(b, 'amountMillimes');
      const caseIds = b.caseIds;
      if (!Array.isArray(caseIds) || caseIds.length < 1 || caseIds.length > 50 || !caseIds.every(x => typeof x === 'string' && isUuid(x)) || new Set(caseIds).size !== caseIds.length)
        fail('VALIDATION_FAILED', 'caseIds must list 1-50 distinct lab case ids', { field: 'caseIds' });
      const found = (await tx.query<{ id: string; supplier_id: string }>('SELECT id, supplier_id FROM lab_cases WHERE id = ANY($1::uuid[])', ['{' + (caseIds as string[]).join(',') + '}'])).rows;
      if (found.length !== (caseIds as string[]).length) fail('NOT_FOUND', 'A listed lab case was not found in this clinic');
      if (found.some(f => f.supplier_id !== supplierId)) fail('VALIDATION_FAILED', 'Every listed case must have been sent to this supplier', { field: 'caseIds' });
      const r = await tx.one<{ id: string }>('INSERT INTO lab_invoices (clinic_id, supplier_id, invoice_number, invoice_date, amount_millimes, recorded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [actor!.clinicId, supplierId, invoiceNumber, invoiceDate, amount, actor!.staffId]);
      for (const cid of caseIds as string[]) await tx.query('INSERT INTO lab_invoice_cases (clinic_id, invoice_id, case_id) VALUES ($1,$2,$3)', [actor!.clinicId, r.id, cid]);
      await appendAudit(tx, actor!, 'lab.invoice_recorded', 'lab_invoice', r.id, { supplierId, invoiceNumber, invoiceDate, amountMillimes: amount, caseIds: (caseIds as string[]).slice().sort() });
      return { status: 201, body: { invoice: { id: r.id, supplierId, invoiceNumber, invoiceDate, amountMillimes: amount, caseIds, kind: 'CLINIC_EXPENSE' } } };
    },
  },
  {
    method: 'GET', path: '/api/v1/lab/invoices', permission: 'lab.invoice.record',
    handler: async ({ tx }) => {
      const rows = (await tx.query<{ id: string; supplier: string; invoice_number: string; invoice_date: string; amount_millimes: number; case_ids: string }>(
        `SELECT i.id, s.name AS supplier, i.invoice_number, i.invoice_date::text AS invoice_date, i.amount_millimes, array_agg(ic.case_id ORDER BY ic.case_id)::text AS case_ids
           FROM lab_invoices i JOIN lab_suppliers s ON s.id = i.supplier_id JOIN lab_invoice_cases ic ON ic.invoice_id = i.id
          GROUP BY i.id, s.name ORDER BY i.invoice_date DESC, i.id LIMIT 500`)).rows;
      return { status: 200, body: { invoices: rows.map(r => ({ id: r.id, supplier: r.supplier, invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date, amountMillimes: r.amount_millimes, caseIds: pgArray(r.case_ids), kind: 'CLINIC_EXPENSE' })) } };
    },
  },
];
