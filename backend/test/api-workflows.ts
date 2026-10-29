/*
 * R73-G: fictional end-to-end workflows used (1) to RECORD the example payloads Astra builds against
 * (docs/api/examples/*.json, `EZZ_RECORD_EXAMPLES=1 node --test test/r73-api-contract.test.ts`) and (2) as a contract
 * test that the live API still answers every recorded step with the same status and a compatible shape.
 * Every value is fictional. Ids, tokens, timestamps and hashes are normalised so the committed examples are stable.
 */
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { seedClinic, STANDARD_STAFF, adminConn, type Api, type TestDb } from './helpers.ts';

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
