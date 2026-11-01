/*
 * R73-G: fictional end-to-end workflows used (1) to RECORD the example payloads Astra builds against
 * (docs/api/examples/*.json, `EZZ_RECORD_EXAMPLES=1 node --test test/r73-api-contract.test.ts`) and (2) as a contract
 * test that the live API still answers every recorded step with the same status and a compatible shape.
 * Every value is fictional. Ids, tokens, timestamps and hashes are normalised so the committed examples are stable.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { seedClinic, STANDARD_STAFF, adminConn, type Api, type TestDb } from './helpers.ts';
import { localDate } from '../src/modules/settings.ts';

export type Audience = 'receptionist' | 'dentist' | 'owner' | 'patient-facing' | 'security-states';
export interface Step {
  file: Audience; title: string; role: string; method: 'GET' | 'POST'; route: string; path: string;
  request: unknown; status: number; response: unknown; note?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Stable placeholders: the n-th distinct UUID becomes <id-n>; tokens, instants, hashes become typed markers. */
export function normaliser() {
  const ids = new Map<string, string>();
  const id = (u: string) => { if (!ids.has(u)) ids.set(u, `<id-${ids.size + 1}>`); return ids.get(u)!; };
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      if (key === 'token') return '<token>';
      if (/password/i.test(key)) return '<password>'; // never record credentials, even fictional ones
      if (ISO.test(v)) return '<timestamp>';
      if (HEX64.test(v)) return '<sha256>';
      return v.replace(UUID, id);
    }
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { walk, path: (p: string) => p.replace(UUID, id) };
}

/** Structural shape: what the frontend may rely on (keys and JSON types). Arrays take the shape of their first item. */
export type Shape = string | Shape[] | { [k: string]: Shape };
export function shapeOf(v: unknown): Shape {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shapeOf(x)]));
  return typeof v;
}
/** Every key/type the recorded shape promises must still exist in the live shape (additions are allowed). */
export function shapeBreaks(recorded: Shape, live: Shape, at = '$'): string[] {
  if (recorded === 'null' || live === 'null') return []; // nullable fields may be either
  if (typeof recorded === 'string') return typeof live === 'string' && live === recorded ? [] : [`${at}: was ${recorded}, now ${JSON.stringify(live)}`];
  if (Array.isArray(recorded)) {
    if (!Array.isArray(live)) return [`${at}: was array, now ${JSON.stringify(live)}`];
    return recorded.length && live.length ? shapeBreaks(recorded[0]!, live[0]!, at + '[0]') : [];
  }
  if (typeof live !== 'object' || live === null || Array.isArray(live)) return [`${at}: was object, now ${JSON.stringify(live)}`];
  return Object.entries(recorded).flatMap(([k, s]) => (k in live ? shapeBreaks(s, (live as Record<string, Shape>)[k]!, `${at}.${k}`) : [`${at}.${k}: missing`]));
}

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk('IDAT', deflateSync(Buffer.from([0, 128]))), chunk('IEND', Buffer.alloc(0))]);
}

const ROLE_OF: Record<string, string> = { desk: 'RECEPTIONIST', dentist: 'DENTIST', owner: 'OWNER', assistant: 'ASSISTANT' };

/** Run the fictional clinic day and return every step (raw, not yet normalised). */
export async function runWorkflows(api: Api, db: TestDb): Promise<Step[]> {
  const steps: Step[] = [];
  const code = 'astra-demo';
  const clinic = await seedClinic(db, code, [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }]);
  const loginRes: Record<string, unknown> = {};
  const tokens: Record<string, string> = {};
  const call = async (file: Audience, title: string, role: string, method: 'GET' | 'POST', route: string, path: string, body?: unknown, opts: { idem?: string | false; headers?: Record<string, string>; note?: string } = {}) => {
    const r = await api.call(method, path, { token: tokens[role], body, idem: opts.idem, headers: opts.headers });
    if (process.env.EZZ_DEBUG_WORKFLOWS) process.stderr.write(`${r.status} ${method} ${path} ${JSON.stringify(r.body).slice(0, 300)}\n`);
    steps.push({ file, title, role: ROLE_OF[role] ?? role, method, route, path, request: method === 'POST' ? (body ?? {}) : null, status: r.status, response: r.body, ...(opts.note ? { note: opts.note } : {}) });
    return r;
  };
  for (const role of ['desk', 'dentist', 'owner', 'assistant']) {
    const r = await api.call('POST', '/api/v1/session/login', { body: { clinicCode: code, username: role, password: 'fictional-pass-123' }, idem: false });
    tokens[role] = r.body.token; loginRes[role] = r.body;
  }
  steps.push({ file: 'receptionist', title: 'Log in (every role uses the same call)', role: 'RECEPTIONIST', method: 'POST', route: '/api/v1/session/login', path: '/api/v1/session/login',
    request: { clinicCode: code, username: 'desk', password: '<password>' }, status: 200, response: loginRes.desk });
  await call('receptionist', 'Who am I (roles decide which screens to show; the server still enforces every call)', 'desk', 'GET', '/api/v1/session', '/api/v1/session');
  await call('receptionist', 'Clinic settings (timezone = the clinic day)', 'desk', 'GET', '/api/v1/clinic/settings', '/api/v1/clinic/settings');

  // Owner opens the drawer before the day starts.
  const period = await call('owner', 'Open the cash period (password re-entry window applies)', 'owner', 'POST', '/api/v1/cash/periods', '/api/v1/cash/periods', { openingFloatMillimes: 20_000 });
  const periodId = period.body.period.id as string;

  const p = await call('receptionist', 'Register a new (fictional) patient', 'desk', 'POST', '/api/v1/patients', '/api/v1/patients',
    { familyName: 'Ben Fictif', givenName: 'Amel', phone: '+216 20 000 001', contactPreference: 'BASIC_PHONE_CALL', isSynthetic: true });
  const patientId = p.body.patient.id as string;
  await call('security-states', 'Possible duplicate patient: the desk must look and confirm, never auto-merge', 'desk', 'POST', '/api/v1/patients', '/api/v1/patients',
    { familyName: 'Ben Fictif', givenName: 'Amel', phone: '+216 20 000 001', isSynthetic: true });
  await call('receptionist', 'Search patients', 'desk', 'GET', '/api/v1/patients', '/api/v1/patients?q=Ben%20Fictif');
  const v = await call('receptionist', 'Book a visit with the dentist', 'desk', 'POST', '/api/v1/visits', '/api/v1/visits', { patientId, scheduledAt: '2026-10-28T08:00:00Z', dentistId: clinic.staff.dentist });
  const visitId = v.body.visit.id as string;
  await call('security-states', 'Double booking the same dentist slot is refused', 'desk', 'POST', '/api/v1/visits', '/api/v1/visits', { patientId, scheduledAt: '2026-10-28T08:10:00Z', dentistId: clinic.staff.dentist });
  await call('receptionist', 'Day board for the clinic day', 'desk', 'GET', '/api/v1/day-board', '/api/v1/day-board?day=2026-10-28');
  const declared = await call('receptionist', 'Declare a patient-reported medical alert at intake', 'desk', 'POST', '/api/v1/patients/:id/medical-alerts', `/api/v1/patients/${patientId}/medical-alerts`,
    { code: 'ALLERGY_PENICILLIN', severity: 'CRITICAL', detail: 'Fictional: rash with penicillin' });
  await call('receptionist', 'Alert PRESENCE only (desk never sees medical detail)', 'desk', 'GET', '/api/v1/patients/:id/medical-alerts/summary', `/api/v1/patients/${patientId}/medical-alerts/summary`);
  await call('security-states', 'Desk asking for medical detail is refused', 'desk', 'GET', '/api/v1/patients/:id/medical-alerts', `/api/v1/patients/${patientId}/medical-alerts`);
  await call('receptionist', 'Patient arrived', 'desk', 'POST', '/api/v1/visits/:id/status', `/api/v1/visits/${visitId}/status`, { status: 'ARRIVED' });
  await call('receptionist', 'Patient in the chair', 'desk', 'POST', '/api/v1/visits/:id/status', `/api/v1/visits/${visitId}/status`, { status: 'IN_CHAIR' });

  // Dentist.
  const enc = await call('dentist', 'Open the encounter (identity, alerts with their hash, visit record, open plan)', 'dentist', 'GET', '/api/v1/visits/:id/encounter', `/api/v1/visits/${visitId}/encounter`);
  const alertId = declared.body.alertId as string;
  void enc;
  await call('security-states', 'Care cannot be confirmed before the dentist acknowledges the CURRENT alert set', 'dentist', 'POST', '/api/v1/visits/:id/care', `/api/v1/visits/${visitId}/care`,
    { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'MO', feeMillimes: 80_000 });
  const ver = await call('dentist', 'Verify the patient-declared alert', 'dentist', 'POST', '/api/v1/medical-alerts/:id/revisions', `/api/v1/medical-alerts/${alertId}/revisions`, { action: 'VERIFY', expectedRevision: 1 });
  const review = await call('dentist', 'Medical history review (echo the alertSetHash you were shown)', 'dentist', 'POST', '/api/v1/patients/:id/medical-history-reviews', `/api/v1/patients/${patientId}/medical-history-reviews`,
    { method: 'INTERVIEW', noKnownAllergies: false, alertSetHash: ver.body.alertSetHash, visitId });
  await call('dentist', 'Chart a finding (FDI tooth + surfaces)', 'dentist', 'POST', '/api/v1/visits/:id/chart-findings', `/api/v1/visits/${visitId}/chart-findings`,
    { kind: 'FINDING', toothFdi: 36, surfaces: 'MO', conditionCode: 'CARIES', note: 'Fictional finding note' });
  await call('dentist', 'Clinical note (SOAP)', 'dentist', 'POST', '/api/v1/visits/:id/clinical-notes', `/api/v1/visits/${visitId}/clinical-notes`,
    { subjective: 'Fictional: pain left side', objective: 'Fictional: cavity on 36', plan: 'Fictional: composite today' });
  const care = await call('dentist', 'Confirm billable care (only a dentist; the fee is the dentist\'s decision)', 'dentist', 'POST', '/api/v1/visits/:id/care', `/api/v1/visits/${visitId}/care`,
    { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'MO', feeMillimes: 80_000, alertSetHash: review.body.alertSetHash });
  await call('dentist', 'Visit care list', 'dentist', 'GET', '/api/v1/visits/:id/care', `/api/v1/visits/${visitId}/care`);
  const sup = await call('dentist', 'Add a lab supplier', 'dentist', 'POST', '/api/v1/lab/suppliers', '/api/v1/lab/suppliers', { name: 'Laboratoire Fictif Tunis' });
  const lab = await call('dentist', 'Order lab work', 'dentist', 'POST', '/api/v1/patients/:id/lab-cases', `/api/v1/patients/${patientId}/lab-cases`,
    { supplierId: sup.body.supplier.id, caseType: 'CROWN', teeth: [36], material: 'Fictional zirconia', shade: 'VITA classical A2', impression: 'DIGITAL_SCAN', dueOn: '2026-11-10', visitId });
  await call('dentist', 'Link the billed care item to the lab case (MF19)', 'dentist', 'POST', '/api/v1/lab-cases/:id/care-links', `/api/v1/lab-cases/${lab.body.labCase.id}/care-links`, { careItemId: care.body.careItem.id });
  const bytes = png();
  const doc = await call('dentist', 'Attach an image: step 1, declare metadata + SHA-256', 'dentist', 'POST', '/api/v1/patients/:id/documents', `/api/v1/patients/${patientId}/documents`,
    { modality: 'INTRAORAL_PHOTO', title: 'Fictional photo', source: 'IN_CLINIC_SENSOR', teeth: [36], contentType: 'image/png', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), visitId });
  const up = await fetch(`${api.base}/api/v1/documents/${doc.body.document.id}/content`, { method: 'POST', headers: { authorization: `Bearer ${tokens.dentist}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  steps.push({ file: 'dentist', title: 'Attach an image: step 2, raw bytes (application/octet-stream, no Idempotency-Key)', role: 'DENTIST', method: 'POST', route: '/api/v1/documents/:id/content',
    path: `/api/v1/documents/${doc.body.document.id}/content`, request: `<${bytes.length} bytes of image/png>`, status: up.status, response: await up.json() });
  await call('security-states', 'Assistant asking for the encounter is refused: clinical detail is dentist-only in this slice', 'assistant', 'GET', '/api/v1/visits/:id/encounter', `/api/v1/visits/${visitId}/encounter`);

  // Desk takes payment.
  await call('receptionist', 'Balance due (after the dentist confirmed care)', 'desk', 'GET', '/api/v1/visits/:id/balance', `/api/v1/visits/${visitId}/balance`);
  const pay = await call('receptionist', 'Record a cash payment: the receipt number comes from the server', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 30_000, tender: 'CASH' });
  await call('security-states', 'Same amount again moments later: the desk must confirm it is a second payment', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 30_000, tender: 'CASH' });
  await call('security-states', 'More than the balance is refused (no overpayment)', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 60_000, tender: 'CASH', confirmDuplicate: true });
  const idemKey = 'astra_example_key_0001';
  await call('security-states', 'Retry with the SAME Idempotency-Key replays the stored answer (no second payment)', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 30_000, tender: 'CARD' }, { idem: idemKey });
  await call('security-states', '(replay of the request above)', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 30_000, tender: 'CARD' }, { idem: idemKey });
  await call('security-states', 'Same key with a different body is refused', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 29_000, tender: 'CARD' }, { idem: idemKey });
  await call('security-states', 'A write without an Idempotency-Key is refused', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 1_000, tender: 'CASH' }, { idem: false });
  await call('security-states', 'Money is integer millimes only: 12.5 is rejected, never rounded', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 12.5, tender: 'CASH' });
  await call('patient-facing', 'Print the receipt the patient receives (French + Arabic)', 'desk', 'POST', '/api/v1/receipts/:id/print', `/api/v1/receipts/${pay.body.receipt.id}/print`, { lang: 'both' });
  await call('patient-facing', 'Blank patient intake form (paper, for outages or the waiting room)', 'desk', 'GET', '/api/v1/print/forms/patient-intake', '/api/v1/print/forms/patient-intake?lang=both');
  await call('receptionist', 'Lab board (status and dates only)', 'desk', 'GET', '/api/v1/lab/board', '/api/v1/lab/board');
  await call('security-states', 'Desk cannot see the cash review (blind count rule)', 'desk', 'GET', '/api/v1/cash/periods/:id/review', `/api/v1/cash/periods/${periodId}/review`);

  // Owner.
  await call('owner', 'Blind count by a non-receptionist (no expected figure is ever returned to the counter)', 'dentist', 'POST', '/api/v1/cash/periods/:id/counts', `/api/v1/cash/periods/${periodId}/counts`, { countedMillimes: 50_000 });
  await call('owner', 'Owner cash review (expected vs counted, after the count exists)', 'owner', 'GET', '/api/v1/cash/periods/:id/review', `/api/v1/cash/periods/${periodId}/review`);
  await call('owner', 'Owner exception list (evidence wording; zero items does not mean nothing is wrong)', 'owner', 'GET', '/api/v1/owner/exceptions', '/api/v1/owner/exceptions?asOf=2026-10-28');
  await call('owner', 'Financial review for a period', 'owner', 'GET', '/api/v1/owner/financial-review', '/api/v1/owner/financial-review?from=2026-10-28&to=2026-10-28');
  await call('owner', 'Integrity check (recomputes hash chain and audited values)', 'owner', 'POST', '/api/v1/integrity/check', '/api/v1/integrity/check', {}, { idem: false });
  await call('owner', 'Create an owner checkpoint to print or store outside the system', 'owner', 'POST', '/api/v1/owner/checkpoints', '/api/v1/owner/checkpoints', { note: 'Fictional weekly checkpoint' });
  await call('owner', 'Checkpoint status (is one due?)', 'owner', 'GET', '/api/v1/owner/checkpoints', '/api/v1/owner/checkpoints');
  // Re-auth: age the session's password entry, then show the refusal and the recovery.
  const a = await adminConn(db.name);
  try { await a.query("UPDATE sessions SET reauth_at = now() - interval '1 hour' WHERE staff_id = $1", [clinic.staff.owner] as never[]); } finally { a.end(); }
  await call('security-states', 'Sensitive owner action after the re-auth window: refused', 'owner', 'POST', '/api/v1/clinic/settings', '/api/v1/clinic/settings', { changes: { checkpointDueDays: 14 }, reason: 'Fictional: fortnightly checkpoints' });
  await call('security-states', 'Re-enter the password', 'owner', 'POST', '/api/v1/session/reauth', '/api/v1/session/reauth', { password: 'fictional-pass-123' }, { idem: false });
  await call('owner', 'Change a clinic setting (reason required, audited)', 'owner', 'POST', '/api/v1/clinic/settings', '/api/v1/clinic/settings', { changes: { checkpointDueDays: 14 }, reason: 'Fictional: fortnightly checkpoints' });
  await call('security-states', 'Owner without a clinical role cannot open the encounter', 'owner', 'GET', '/api/v1/visits/:id/encounter', `/api/v1/visits/${visitId}/encounter`);
  return steps;
}

/* ------------------------------------------------------------------------------------------------------------------
 * R73-I: the remaining operations, so every route Astra may call has at least one recorded fictional example.
 * Each step is a normal, successful use unless its title says otherwise.
 * ---------------------------------------------------------------------------------------------------------------- */
export type MoreAudience = 'owner-admin' | 'desk-extras' | 'clinical-extras' | 'money-and-cash' | 'paper-and-card' | 'documents-lab-stock';

export async function runMoreWorkflows(api: Api, db: TestDb): Promise<Array<Omit<Step, 'file'> & { file: MoreAudience }>> {
  type S = Omit<Step, 'file'> & { file: MoreAudience };
  const steps: S[] = [];
  const code = 'astra-demo-2';
  const clinic = await seedClinic(db, code, [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }, { username: 'temp', roles: ['RECEPTIONIST'] }]);
  const tokens: Record<string, string> = {};
  for (const u of ['desk', 'dentist', 'owner', 'assistant']) tokens[u] = (await api.call('POST', '/api/v1/session/login', { body: { clinicCode: code, username: u, password: 'fictional-pass-123' }, idem: false })).body.token;
  const call = async (file: MoreAudience, title: string, role: string, method: 'GET' | 'POST', route: string, path: string, body?: unknown, opts: { idem?: string | false } = {}) => {
    const r = await api.call(method, path, { token: tokens[role], body, idem: opts.idem });
    if (process.env.EZZ_DEBUG_WORKFLOWS) process.stderr.write(`${r.status} ${method} ${path} ${JSON.stringify(r.body).slice(0, 200)}\n`);
    steps.push({ file, title, role: ROLE_OF[role] ?? role, method, route, path, request: method === 'POST' ? (body ?? {}) : null, status: r.status, response: r.body });
    return r;
  };
  // A statement's date follows the clinic's Tunis business day, not UTC midnight.
  const today = localDate('Africa/Tunis');

  // ---- owner administration
  steps.push({ file: 'owner-admin', title: 'Liveness (public)', role: 'PUBLIC', method: 'GET', route: '/api/v1/health', path: '/api/v1/health', request: null, status: 200, response: (await api.call('GET', '/api/v1/health')).body });
  const ready = await api.call('GET', '/api/v1/health/ready');
  steps.push({ file: 'owner-admin', title: 'Readiness (public): 200 ready, 503 when the database or schema is not right', role: 'PUBLIC', method: 'GET', route: '/api/v1/health/ready', path: '/api/v1/health/ready', request: null, status: ready.status, response: ready.body });
  await call('owner-admin', 'Staff list', 'owner', 'GET', '/api/v1/staff', '/api/v1/staff');
  const staff = await call('owner-admin', 'Create a staff account (password re-entry window applies)', 'owner', 'POST', '/api/v1/staff', '/api/v1/staff',
    { username: 'dentist-two', displayName: 'Dr Fictif Deux', password: 'fictional-password-456', roles: ['DENTIST'] });
  await call('owner-admin', 'Grant a role', 'owner', 'POST', '/api/v1/staff/:id/roles', `/api/v1/staff/${staff.body.staff?.id ?? clinic.staff.temp}/roles`, { role: 'ASSISTANT', op: 'GRANT' });
  await call('owner-admin', 'Reset a staff password (owner only; no self-service recovery)', 'owner', 'POST', '/api/v1/staff/:id/reset-password', `/api/v1/staff/${clinic.staff.temp}/reset-password`, { newPassword: 'fictional-reset-pw-789' });
  await call('owner-admin', 'Deactivate a staff account (sessions revoked)', 'owner', 'POST', '/api/v1/staff/:id/deactivate', `/api/v1/staff/${clinic.staff.temp}/deactivate`, { reason: 'Fictional departure' });
  await call('owner-admin', 'Change a clinic setting', 'owner', 'POST', '/api/v1/clinic/settings', '/api/v1/clinic/settings', { changes: { notArrivedGraceMinutes: 20 }, reason: 'Fictional: busier waiting room' });
  await call('owner-admin', 'Clinic settings history', 'owner', 'GET', '/api/v1/clinic/settings/history', '/api/v1/clinic/settings/history');
  await call('owner-admin', 'Verify the audit chain', 'owner', 'POST', '/api/v1/audit/verify', '/api/v1/audit/verify', {}, { idem: false });
  await call('owner-admin', 'Legacy checkpoint endpoint (kept; prefer /owner/checkpoints)', 'owner', 'POST', '/api/v1/audit/checkpoints', '/api/v1/audit/checkpoints', { note: 'Fictional legacy checkpoint' });
  const cp = await call('owner-admin', 'Owner checkpoint (the line to keep outside the system)', 'owner', 'POST', '/api/v1/owner/checkpoints', '/api/v1/owner/checkpoints', { note: 'Fictional weekly checkpoint' });
  await call('owner-admin', 'Verify kept checkpoint lines (one good, one with a typo)', 'owner', 'POST', '/api/v1/owner/checkpoints/verify', '/api/v1/owner/checkpoints/verify',
    { lines: [cp.body.line, String(cp.body.line).replace(/seq=(\d+)/, (_m: string, n: string) => `seq=${Number(n) + 1}`)] }, { idem: false });

  // ---- desk extras
  const p = await call('desk-extras', 'Register a patient without a phone (in-person contact)', 'desk', 'POST', '/api/v1/patients', '/api/v1/patients', { familyName: 'Ben Fictif', givenName: 'Hedi', contactPreference: 'IN_PERSON', isSynthetic: true });
  const patientId = p.body.patient.id as string;
  await call('desk-extras', 'Patient record (identity and contact only)', 'desk', 'GET', '/api/v1/patients/:id', `/api/v1/patients/${patientId}`);
  await call('desk-extras', 'Change contact details (reason required, audited)', 'desk', 'POST', '/api/v1/patients/:id/contact', `/api/v1/patients/${patientId}/contact`, { phone: '+216 20 000 002', contactPreference: 'BASIC_PHONE_CALL', reason: 'Fictional: new phone' });
  const v = await call('desk-extras', 'Book a visit', 'desk', 'POST', '/api/v1/visits', '/api/v1/visits', { patientId, scheduledAt: '2026-10-28T09:00:00Z', dentistId: clinic.staff.dentist });
  const visitId = v.body.visit.id as string;
  await call('desk-extras', 'Visits of a clinic day', 'desk', 'GET', '/api/v1/visits', '/api/v1/visits?day=2026-10-28');
  await api.call('POST', '/api/v1/visits', { token: tokens.desk, body: { patientId, scheduledAt: '2026-10-20T09:00:00Z' } }); // past visit, no dentist record -> owner exception
  await call('desk-extras', 'Current cash period (blind: no expected figure)', 'desk', 'GET', '/api/v1/cash/periods/current', '/api/v1/cash/periods/current');
  const period = await call('money-and-cash', 'Open the cash period', 'owner', 'POST', '/api/v1/cash/periods', '/api/v1/cash/periods', { openingFloatMillimes: 20_000 });
  const periodId = period.body.period.id as string;

  // ---- clinical extras (dentist)
  await call('clinical-extras', 'Treatment plan item (proposed)', 'dentist', 'POST', '/api/v1/patients/:id/treatment-plan-items', `/api/v1/patients/${patientId}/treatment-plan-items`,
    { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'MO', estimatedFeeMillimes: 80_000, visitId });
  const plan2 = await call('clinical-extras', 'A second plan item', 'dentist', 'POST', '/api/v1/patients/:id/treatment-plan-items', `/api/v1/patients/${patientId}/treatment-plan-items`,
    { procedureCode: 'SCALE', procedureLabel: 'Fictional scaling', estimatedFeeMillimes: 50_000, visitId });
  const planItems = (await api.call('GET', `/api/v1/patients/${patientId}/treatment-plan`, { token: tokens.dentist })).body;
  const firstPlanId = (planItems.items ?? planItems.planItems ?? [])[0]?.id ?? plan2.body.planItem?.id;
  await call('clinical-extras', 'Patient accepts the plan item (recorded by the dentist)', 'dentist', 'POST', '/api/v1/treatment-plan-items/:id/status', `/api/v1/treatment-plan-items/${plan2.body.planItem.id}/status`, { status: 'ACCEPTED' });
  await call('clinical-extras', 'Treatment plan', 'dentist', 'GET', '/api/v1/patients/:id/treatment-plan', `/api/v1/patients/${patientId}/treatment-plan`);
  const enc = (await api.call('GET', `/api/v1/visits/${visitId}/encounter`, { token: tokens.dentist })).body;
  await call('clinical-extras', 'Acknowledge the current alert set for this visit', 'dentist', 'POST', '/api/v1/visits/:id/alert-acknowledgements', `/api/v1/visits/${visitId}/alert-acknowledgements`, { alertSetHash: enc.medical?.alertSetHash });
  const perf = await call('clinical-extras', 'Perform an accepted plan item (creates the billable care item)', 'dentist', 'POST', '/api/v1/treatment-plan-items/:id/perform', `/api/v1/treatment-plan-items/${plan2.body.planItem.id}/perform`, { visitId, alertSetHash: enc.medical?.alertSetHash });
  const careId = perf.body.careItem?.id as string;
  await call('clinical-extras', 'Correct the recorded site (fee-neutral, dentist-signed)', 'dentist', 'POST', '/api/v1/care-items/:id/site-amendments', `/api/v1/care-items/${careId}/site-amendments`,
    { toothFdi: 46, reasonCode: 'TRANSCRIPTION', expectedSupersedesId: null });
  const note = await call('clinical-extras', 'Clinical note', 'dentist', 'POST', '/api/v1/visits/:id/clinical-notes', `/api/v1/visits/${visitId}/clinical-notes`, { objective: 'Fictional: plaque', plan: 'Fictional: scaling done' });
  await call('clinical-extras', 'Addendum to a signed note (the original is never edited)', 'dentist', 'POST', '/api/v1/clinical-notes/:id/addenda', `/api/v1/clinical-notes/${note.body.note.id}/addenda`, { kind: 'ADDENDUM', plan: 'Fictional: review in 2 weeks' });
  const fnd = await call('clinical-extras', 'Chart finding', 'dentist', 'POST', '/api/v1/visits/:id/chart-findings', `/api/v1/visits/${visitId}/chart-findings`, { kind: 'FINDING', toothFdi: 21, conditionCode: 'CARIES' });
  await call('clinical-extras', 'Mark a finding entered in error (reason required; stays in history)', 'dentist', 'POST', '/api/v1/chart-findings/:id/entered-in-error', `/api/v1/chart-findings/${fnd.body.finding.id}/entered-in-error`, { reason: 'Fictional: wrong tooth' });
  await call('clinical-extras', 'Clinical record of the patient', 'dentist', 'GET', '/api/v1/patients/:id/clinical-record', `/api/v1/patients/${patientId}/clinical-record`);
  void firstPlanId;

  // ---- money and cash
  await call('money-and-cash', 'Visit workbench (desk view of care, money and evidence)', 'desk', 'GET', '/api/v1/visits/:id/workbench', `/api/v1/visits/${visitId}/workbench`);
  await call('money-and-cash', 'Discount decided by the dentist', 'dentist', 'POST', '/api/v1/visits/:id/adjustments', `/api/v1/visits/${visitId}/adjustments`, { kind: 'DISCOUNT', amountMillimes: 5_000, reasonCode: 'LOYALTY' });
  const pay1 = await call('money-and-cash', 'Cash payment', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 30_000, tender: 'CASH' });
  const pay2 = await call('money-and-cash', 'Card payment (desk claim until a statement matches it)', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`, { amountMillimes: 15_000, tender: 'CARD' });
  await call('money-and-cash', 'Payments of a visit', 'desk', 'GET', '/api/v1/visits/:id/payments', `/api/v1/visits/${visitId}/payments`);
  await call('money-and-cash', 'Receipt (stored snapshot)', 'desk', 'GET', '/api/v1/receipts/:id', `/api/v1/receipts/${pay1.body.receipt.id}`);
  await call('money-and-cash', 'Reprint: always marked COPY', 'desk', 'POST', '/api/v1/receipts/:id/reprint', `/api/v1/receipts/${pay1.body.receipt.id}/reprint`, {});
  await call('money-and-cash', 'Dentist lowers the fee (correction row; creates patient credit)', 'dentist', 'POST', '/api/v1/care-items/:id/corrections', `/api/v1/care-items/${careId}/corrections`, { deltaMillimes: -10_000, reason: 'Fictional: shorter session' });
  await call('money-and-cash', 'Owner refunds the credit (refund receipt)', 'owner', 'POST', '/api/v1/payments/:id/refund', `/api/v1/payments/${pay1.body.payment.id}/refund`, { amountMillimes: 10_000, reasonCode: 'FEE_CORRECTED' });
  await call('money-and-cash', 'Owner voids a mistaken payment (void receipt)', 'owner', 'POST', '/api/v1/payments/:id/void', `/api/v1/payments/${pay2.body.payment.id}/void`, { reasonCode: 'ENTERED_IN_ERROR' });
  await call('money-and-cash', 'Owner records a petty expense from the drawer', 'owner', 'POST', '/api/v1/cash/periods/:id/movements', `/api/v1/cash/periods/${periodId}/movements`, { kind: 'PETTY_EXPENSE', amountMillimes: 2_000, reason: 'Fictional: cleaning supplies', voucherRef: 'V-001' });
  const cnt = await call('money-and-cash', 'Blind count by the dentist', 'dentist', 'POST', '/api/v1/cash/periods/:id/counts', `/api/v1/cash/periods/${periodId}/counts`, { countedMillimes: 38_000, denominations: { '20000': 1, '10000': 1, '5000': 1, '1000': 3 } });
  await call('money-and-cash', 'Owner closes the period (handover; the rest carries forward)', 'owner', 'POST', '/api/v1/cash/periods/:id/close', `/api/v1/cash/periods/${periodId}/close`, { acceptedCountId: cnt.body.count.id, handoverMillimes: 18_000, note: 'Fictional: to bank' });
  const ex = (await api.call('GET', '/api/v1/owner/exceptions', { token: tokens.owner })).body;
  const item = (ex.open as Array<{ key: string }>)[0];
  if (item) await call('money-and-cash', 'Resolve one exception (one item, reason code; no bulk clear)', 'owner', 'POST', '/api/v1/owner/exceptions/resolve', '/api/v1/owner/exceptions/resolve', { key: item.key, reasonCode: 'OWNER_REVIEWED', note: 'Fictional: checked' });

  // ---- paper outage and card statements
  await call('paper-and-card', 'Card settings (account last 4, settlement lag)', 'owner', 'POST', '/api/v1/card/settings', '/api/v1/card/settings', { accountLast4: '4321', settlementLagDays: 2 });
  const v2 = await call('paper-and-card', 'Another visit', 'desk', 'POST', '/api/v1/visits', '/api/v1/visits', { patientId, scheduledAt: '2026-10-28T10:00:00Z' });
  await api.call('POST', `/api/v1/visits/${v2.body.visit.id}/care`, { token: tokens.dentist, body: { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', feeMillimes: 40_000 } });
  const cardPay = await call('paper-and-card', 'Card payment to be matched', 'desk', 'POST', '/api/v1/visits/:id/payments', `/api/v1/visits/${v2.body.visit.id}/payments`, { amountMillimes: 40_000, tender: 'CARD' });
  const imp = await call('paper-and-card', 'Import a (fictional) bank statement CSV', 'owner', 'POST', '/api/v1/card/statement-imports', '/api/v1/card/statement-imports',
    { fileName: 'fictional-statement.csv', csv: `date,amount_tnd,type,terminal_ref,card_last4,description\n${today},40.000,CARD,,,Fictional card sale`, accountLast4: '4321', periodStart: today, periodEnd: today, totalSource: 'NOT_PROVIDED' });
  const rec = await call('paper-and-card', 'Card reconciliation (claims vs statement lines)', 'owner', 'GET', '/api/v1/card/reconciliation', '/api/v1/card/reconciliation');
  const line = rec.body.claims?.[0]?.candidates?.[0]?.statementLineId as string | undefined;
  void imp;
  if (line) await call('paper-and-card', 'Owner matches a card payment to a statement line', 'owner', 'POST', '/api/v1/card/matches', '/api/v1/card/matches',
    { paymentId: cardPay.body.payment.id, statementLineId: line, ambiguityAcknowledged: true, note: 'Fictional: checked the slip' });
  const book = await call('paper-and-card', 'Issue a numbered paper slip book for outages', 'owner', 'POST', '/api/v1/paper-books', '/api/v1/paper-books', { firstNo: 301, lastNo: 305, custodianStaffId: clinic.staff.dentist });
  const bookId = book.body.book?.id ?? book.body.paperBook?.id;
  await call('paper-and-card', 'Print the paper slips (FR/AR)', 'owner', 'POST', '/api/v1/paper-books/:id/print', `/api/v1/paper-books/${bookId}/print`, { lang: 'both' });
  const v3 = await api.call('POST', '/api/v1/visits', { token: tokens.desk, body: { patientId, scheduledAt: '2026-10-28T11:00:00Z' } });
  await api.call('POST', `/api/v1/visits/${v3.body.visit.id}/care`, { token: tokens.dentist, body: { procedureCode: 'XRAY', procedureLabel: 'Fictional x-ray', feeMillimes: 25_000 } });
  await call('paper-and-card', 'Enter slips written during an outage', 'desk', 'POST', '/api/v1/paper-books/:id/entries', `/api/v1/paper-books/${bookId}/entries`,
    { slips: [{ slipNo: 301, kind: 'USED', amountMillimes: 25_000, tender: 'CASH', visitId: v3.body.visit.id, writtenOn: '2026-10-28', patientFileNo: p.body.patient.fileNo }, { slipNo: 302, kind: 'VOID', note: 'Fictional spoiled slip' }] });
  await call('paper-and-card', 'Custodian declares unused slips', 'dentist', 'POST', '/api/v1/paper-books/:id/declare-unused', `/api/v1/paper-books/${bookId}/declare-unused`, { slipNos: [303, 304] });
  await call('paper-and-card', 'Paper book reconciliation (unaccounted slips, care without slips)', 'owner', 'GET', '/api/v1/paper-books/:id/reconciliation', `/api/v1/paper-books/${bookId}/reconciliation`);

  // ---- documents, lab, stock
  const bytes = png();
  const doc = await api.call('POST', `/api/v1/patients/${patientId}/documents`, { token: tokens.dentist, body: { modality: 'PANORAMIC_OPG', title: 'Fictional OPG', source: 'EXTERNAL_RADIOLOGY', contentType: 'image/png', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
  await fetch(`${api.base}/api/v1/documents/${doc.body.document.id}/content`, { method: 'POST', headers: { authorization: `Bearer ${tokens.dentist}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  const docId = doc.body.document.id as string;
  await call('documents-lab-stock', 'Documents of a patient', 'dentist', 'GET', '/api/v1/patients/:id/documents', `/api/v1/patients/${patientId}/documents`);
  await call('documents-lab-stock', 'Document metadata and history', 'dentist', 'GET', '/api/v1/documents/:id', `/api/v1/documents/${docId}`);
  const dl = await fetch(`${api.base}/api/v1/documents/${docId}/content`, { headers: { authorization: `Bearer ${tokens.dentist}` } });
  steps.push({ file: 'documents-lab-stock', title: 'Download (binary attachment; headers shown instead of bytes)', role: 'DENTIST', method: 'GET', route: '/api/v1/documents/:id/content', path: `/api/v1/documents/${docId}/content`, request: null, status: dl.status,
    response: { headers: Object.fromEntries(['content-type', 'content-disposition', 'x-content-sha256', 'content-security-policy', 'cache-control'].map(h => [h, dl.headers.get(h)])), bytes: `<${(await dl.arrayBuffer()).byteLength} bytes>` } });
  await call('documents-lab-stock', 'Re-screen: only QUARANTINE content (here ACTIVE, so refused)', 'dentist', 'POST', '/api/v1/documents/:id/screen', `/api/v1/documents/${docId}/screen`, {});
  await reauthOwner(api, tokens.owner!);
  await call('documents-lab-stock', 'Owner records a deletion request (nothing is deleted)', 'owner', 'POST', '/api/v1/documents/:id/deletion-requests', `/api/v1/documents/${docId}/deletion-requests`, { basis: 'PATIENT_REQUEST', reason: 'Fictional erasure request' });
  await call('documents-lab-stock', 'Deletion requests waiting for a retention policy', 'owner', 'GET', '/api/v1/document-deletion-requests', '/api/v1/document-deletion-requests');
  await call('documents-lab-stock', 'Dentist marks a document entered in error', 'dentist', 'POST', '/api/v1/documents/:id/entered-in-error', `/api/v1/documents/${docId}/entered-in-error`, { reason: 'Fictional: wrong patient, re-attached elsewhere' });
  const sup = await call('documents-lab-stock', 'Lab suppliers', 'desk', 'GET', '/api/v1/lab/suppliers', '/api/v1/lab/suppliers');
  void sup;
  const s2 = await api.call('POST', '/api/v1/lab/suppliers', { token: tokens.owner, body: { name: 'Laboratoire Fictif Sousse' } });
  const lab = await api.call('POST', `/api/v1/patients/${patientId}/lab-cases`, { token: tokens.assistant, body: { supplierId: s2.body.supplier.id, caseType: 'CROWN', teeth: [46], impression: 'PHYSICAL' } });
  const labId = lab.body.labCase.id as string;
  await call('documents-lab-stock', 'Assistant records that the case was sent', 'assistant', 'POST', '/api/v1/lab-cases/:id/status', `/api/v1/lab-cases/${labId}/status`, { status: 'SENT' });
  await call('documents-lab-stock', 'Received back from the lab', 'assistant', 'POST', '/api/v1/lab-cases/:id/status', `/api/v1/lab-cases/${labId}/status`, { status: 'RECEIVED' });
  await call('documents-lab-stock', 'Dentist requests a remake (new linked case)', 'dentist', 'POST', '/api/v1/lab-cases/:id/remake', `/api/v1/lab-cases/${labId}/remake`, { reason: 'Fictional: shade mismatch', responsibility: 'LAB' });
  await call('documents-lab-stock', 'Lab cases of a patient', 'dentist', 'GET', '/api/v1/patients/:id/lab-cases', `/api/v1/patients/${patientId}/lab-cases`);
  await call('documents-lab-stock', 'Lab case with history', 'dentist', 'GET', '/api/v1/lab-cases/:id', `/api/v1/lab-cases/${labId}`);
  await call('documents-lab-stock', 'Owner records the lab invoice (clinic expense)', 'owner', 'POST', '/api/v1/lab/invoices', '/api/v1/lab/invoices', { supplierId: s2.body.supplier.id, invoiceNumber: 'FF-001', invoiceDate: today, amountMillimes: 120_000, caseIds: [labId] });
  await call('documents-lab-stock', 'Lab invoices', 'owner', 'GET', '/api/v1/lab/invoices', '/api/v1/lab/invoices');
  const item2 = await call('documents-lab-stock', 'Create a stock item', 'owner', 'POST', '/api/v1/stock/items', '/api/v1/stock/items', { name: 'Gants nitrile (fictifs)', unit: 'box', reorderLevel: 2 });
  const sid = item2.body.item.id as string;
  await call('documents-lab-stock', 'Goods received (lot and expiry optional)', 'assistant', 'POST', '/api/v1/stock/items/:id/movements', `/api/v1/stock/items/${sid}/movements`, { kind: 'RECEIVED', quantity: 10, lot: 'L-FICT-9', expiresOn: '2027-03-31' });
  await call('documents-lab-stock', 'Goods used', 'dentist', 'POST', '/api/v1/stock/items/:id/movements', `/api/v1/stock/items/${sid}/movements`, { kind: 'USED', quantity: 3 });
  await call('documents-lab-stock', 'Owner count correction (reason required)', 'owner', 'POST', '/api/v1/stock/items/:id/adjustments', `/api/v1/stock/items/${sid}/adjustments`, { kind: 'ADJUSTED', quantity: -1, reason: 'Fictional physical count' });
  await call('documents-lab-stock', 'Stock list (on hand, reorder flag, expiring received lots)', 'desk', 'GET', '/api/v1/stock/items', '/api/v1/stock/items');
  await call('documents-lab-stock', 'Movements of an item', 'desk', 'GET', '/api/v1/stock/items/:id/movements', `/api/v1/stock/items/${sid}/movements`);

  // ---- last: logging out ends the session
  await call('owner-admin', 'Log out (the token stops working)', 'assistant', 'POST', '/api/v1/session/logout', '/api/v1/session/logout', {}, { idem: false });
  void db;
  // Sprint4 recovery examples are captured from real authorized API operations, not handwritten schemas.
  const rp=await api.call('POST','/api/v1/patients',{token:tokens.desk,body:{familyName:'Recovery',givenName:'Fictional',isSynthetic:true}});
  const rv=await api.call('POST','/api/v1/visits',{token:tokens.desk,body:{patientId:rp.body.patient.id,scheduledAt:'2026-10-28T18:00:00Z'}});
  const recoveryVisit=rv.body.visit.id as string;
  await api.call('POST',`/api/v1/visits/${recoveryVisit}/care`,{token:tokens.dentist,body:{procedureCode:'TEST',procedureLabel:'Fictional care',feeMillimes:100000}});
  const rs=await call('money-and-cash','Recover durable payment state after reload','desk','GET','/api/v1/visits/:id/payment-recovery',`/api/v1/visits/${recoveryVisit}/payment-recovery`);
  const ri=await call('money-and-cash','Prepare durable intention without recording money','desk','POST','/api/v1/visits/:id/payment-intents',`/api/v1/visits/${recoveryVisit}/payment-intents`,{amountMillimes:30000,tender:'CARD',recoveryVersion:rs.body.recoveryVersion,acknowledgedPaymentIds:rs.body.paymentIds});
  await call('money-and-cash','Explicitly record immutable intention','desk','POST','/api/v1/payment-intents/:id/record',`/api/v1/payment-intents/${ri.body.intent.id}/record`,{});
  const ns=await api.call('GET',`/api/v1/visits/${recoveryVisit}/payment-recovery`,{token:tokens.desk});
  const ni=await api.call('POST',`/api/v1/visits/${recoveryVisit}/payment-intents`,{token:tokens.desk,body:{amountMillimes:70000,tender:'CARD',recoveryVersion:ns.body.recoveryVersion,acknowledgedPaymentIds:ns.body.paymentIds}});
  await call('money-and-cash','Cancel unrecorded intention after explicit reconciliation (not a refund)','desk','POST','/api/v1/payment-intents/:id/cancel',`/api/v1/payment-intents/${ni.body.intent.id}/cancel`,{reason:'Fictional money not received'});
  // U014: two real fictional API operations are part of the generated contract, not handwritten-only schemas.
  await call('desk-extras', 'Read manually configured clinic hours and closures', 'desk',
    'GET', '/api/v1/clinic/schedule', '/api/v1/clinic/schedule');
  await api.call('POST', '/api/v1/session/reauth', { token: tokens.desk, body: { password: 'fictional-pass-123' }, idem: false });
  await call('desk-extras', 'Record a fictional confirmed closure day', 'desk',
    'POST', '/api/v1/clinic/schedule', '/api/v1/clinic/schedule',
    { expectedRevision: null, weeklyHours: null, closedDays: ['2027-12-25'], reason: 'Fictional confirmed closure' });
  return steps;
}

async function reauthOwner(api: Api, token: string) {
  await api.call('POST', '/api/v1/session/reauth', { token, body: { password: 'fictional-pass-123' }, idem: false });
}
