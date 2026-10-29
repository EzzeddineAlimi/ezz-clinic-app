/*
 * PATIENT DOCUMENTS module (R73-D): X-rays, photos, scans and PDFs ATTACHED to a patient (optionally a visit).
 * Owns: patient_documents, patient_document_events, document_deletion_requests (+ bytes through a BlobStore).
 * Depends on: audit, patients. Storage and content screening are injected (platform/blobstore, platform/fileinspect).
 *
 * Nothing here interprets, measures or diagnoses an image. Two-step upload so the bytes never travel in JSON:
 *   1. POST /patients/:id/documents  JSON metadata + declared type, size and SHA-256  -> AWAITING_CONTENT
 *   2. POST /documents/:id/content   application/octet-stream, after authentication   -> QUARANTINE -> ACTIVE | REJECTED
 * Step 2 verifies size and SHA-256 against the declaration, detects the type from magic bytes (it must match),
 * strips location metadata, stores, then screens. Only ACTIVE content can be downloaded; every download is audited and
 * re-verified against the stored SHA-256. A wrong-patient attachment is marked ENTERED_IN_ERROR by a dentist with a
 * reason and, if requested, re-attached to the right patient as a new document pointing to the same stored bytes.
 * Nothing is ever deleted: an owner can only RECORD a deletion request, which waits for an approved retention policy.
 * Access: dentist-only, like the clinical record (assistant and receptionist access are open policy questions).
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr, oneOf, int, isoDate, isUuid, type Body } from '../platform/validate.ts';
import { MAX_DOCUMENT_BYTES, type BlobStore } from '../platform/blobstore.ts';
import { DOCUMENT_TYPES, EXTENSION, detectType, sha256Hex, stripLocation, type ContentScreener, type DocumentType } from '../platform/fileinspect.ts';
import { isValidFdiTooth } from '../contracts/clinical.ts';
import { appendAudit } from './audit.ts';
import { getPatient, getVisit } from './patients.ts';

export const MODALITIES = ['INTRAORAL_PERIAPICAL', 'BITEWING', 'OCCLUSAL', 'PANORAMIC_OPG', 'CEPHALOMETRIC', 'CBCT', 'INTRAORAL_PHOTO', 'EXTRAORAL_PHOTO', 'SCAN_3D', 'DOCUMENT_SCAN'] as const;
export const SOURCES = ['IN_CLINIC_SENSOR', 'EXTERNAL_RADIOLOGY', 'PATIENT_BROUGHT'] as const;
export const DELETION_BASES = ['PATIENT_REQUEST', 'DUPLICATE', 'WRONG_PATIENT_CONFIRMED', 'RETENTION_EXPIRED', 'OTHER'] as const;
const AREA_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40];
const HEX64 = /^[0-9a-f]{64}$/;

export type DocumentStatus = 'AWAITING_CONTENT' | 'QUARANTINE' | 'ACTIVE' | 'REJECTED' | 'ENTERED_IN_ERROR';
export interface DocumentDeps { store: BlobStore; screener: ContentScreener }

interface DocRow {
  id: string; patient_id: string; visit_id: string | null; modality: string; title: string; teeth: number[]; area_code: number | null;
  acquired_on: string | null; source: string; declared_type: DocumentType; declared_size: number; declared_sha256: string;
  reassigned_from_id: string | null; created_by: string; created_at: string;
}
interface EventRow {
  seq: number; kind: string; status_after: DocumentStatus; blob_ref: string | null; store_kind: string | null; detected_type: DocumentType | null;
  received_sha256: string | null; stored_sha256: string | null; stored_size: number | null; metadata_removed: string[] | null;
  screener: string | null; reason: string | null; by_staff_id: string; at: string;
}

const SELECT_DOC = 'SELECT id, patient_id, visit_id, modality, title, teeth, area_code, acquired_on::text AS acquired_on, source, declared_type, declared_size, '
  + 'declared_sha256, reassigned_from_id, created_by, created_at FROM patient_documents';

/** Postgres smallint[] arrives as text '{11,12}' (the driver keeps arrays as text); parse it strictly. */
const parseIntArray = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : String(v ?? '{}').replace(/[{}]/g, '').split(',').filter(Boolean).map(Number));

async function loadDoc(tx: Tx, id: string): Promise<DocRow> {
  if (!isUuid(id)) fail('NOT_FOUND', 'Document not found');
  const d = await tx.maybeOne<DocRow>(SELECT_DOC + ' WHERE id = $1', [id]);
  if (!d) fail('NOT_FOUND', 'Document not found');
  return { ...d!, teeth: parseIntArray(d!.teeth) };
}
async function events(tx: Tx, id: string): Promise<EventRow[]> {
  return (await tx.query<EventRow>(`SELECT seq, kind, status_after, blob_ref, store_kind, detected_type, received_sha256, stored_sha256, stored_size,
      metadata_removed, screener, reason, by_staff_id, at FROM patient_document_events WHERE document_id = $1 ORDER BY seq`, [id])).rows
    .map(e => ({ ...e, metadata_removed: e.metadata_removed === null ? null : String(e.metadata_removed).replace(/[{}]/g, '').split(',').filter(Boolean) }));
}
const statusOf = (ev: EventRow[]): DocumentStatus => ev.at(-1)?.status_after ?? 'AWAITING_CONTENT';
const contentOf = (ev: EventRow[]) => ev.find(e => e.kind === 'CONTENT_STORED') ?? null;

/** One document transition at a time (the app role has no UPDATE, so no row lock; UNIQUE (document_id, seq) is the backstop). */
const lockDoc = (tx: Tx, id: string) => tx.query("SELECT pg_advisory_xact_lock(hashtext('patient_document:' || $1))", [id]);

async function addEvent(tx: Tx, actor: Actor, docId: string, seq: number, e: { kind: string; status: DocumentStatus } & Partial<Record<
  'blobRef' | 'storeKind' | 'detectedType' | 'receivedSha256' | 'storedSha256' | 'screener' | 'reason', string | null>> & { storedSize?: number; metadataRemoved?: string[] }) {
  await tx.query(`INSERT INTO patient_document_events (clinic_id, document_id, seq, kind, status_after, blob_ref, store_kind, detected_type, received_sha256,
      stored_sha256, stored_size, metadata_removed, screener, reason, by_staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13,$14,$15)`,
    [actor.clinicId, docId, seq, e.kind, e.status, e.blobRef ?? null, e.storeKind ?? null, e.detectedType ?? null, e.receivedSha256 ?? null,
      e.storedSha256 ?? null, e.storedSize ?? null, e.metadataRemoved ? '{' + e.metadataRemoved.join(',') + '}' : null, e.screener ?? null, e.reason ?? null, actor.staffId]);
}

function view(d: DocRow, ev: EventRow[]) {
  const c = contentOf(ev);
  const status = statusOf(ev);
  return {
    id: d.id, patientId: d.patient_id, visitId: d.visit_id, modality: d.modality, title: d.title, teeth: d.teeth, areaCode: d.area_code,
    acquiredOn: d.acquired_on, source: d.source, status, reassignedFromId: d.reassigned_from_id, createdAt: new Date(d.created_at).toISOString(),
    declared: { type: d.declared_type, sizeBytes: d.declared_size, sha256: d.declared_sha256 },
    content: c ? { type: c.detected_type, sizeBytes: c.stored_size, sha256: c.stored_sha256, receivedSha256: c.received_sha256, locationMetadataRemoved: c.metadata_removed ?? [] } : null,
    downloadable: status === 'ACTIVE',
  };
}

function readMetadata(b: Body) {
  const modality = oneOf(b, 'modality', MODALITIES)!;
  const title = str(b, 'title', { max: 120 });
  const source = oneOf(b, 'source', SOURCES)!;
  const acquiredOn = isoDate(b, 'acquiredOn', true);
  const rawTeeth = b.teeth ?? [];
  if (!Array.isArray(rawTeeth) || rawTeeth.length > 32 || !rawTeeth.every(t => typeof t === 'number' && isValidFdiTooth(t)) || new Set(rawTeeth).size !== rawTeeth.length)
    fail('VALIDATION_FAILED', 'teeth must be a list of distinct FDI tooth numbers (max 32)', { field: 'teeth' });
  const areaCode = int(b, 'areaCode', 0, 40, true);
  if (areaCode !== null && !AREA_CODES.includes(areaCode)) fail('VALIDATION_FAILED', 'areaCode is not a valid FDI area code', { field: 'areaCode' });
  return { modality, title, source, acquiredOn, teeth: (rawTeeth as number[]).slice().sort((x, y) => x - y), areaCode };
}

/** Store, record and screen verified bytes for a document that is AWAITING_CONTENT. */
async function storeContent(tx: Tx, actor: Actor, deps: DocumentDeps, d: DocRow, received: Buffer) {
  const detected = detectType(received);
  if (!detected) fail('UNSUPPORTED_MEDIA_TYPE', 'Content is not a JPEG, PNG, PDF or DICOM file (checked by its bytes, not its name)');
  if (detected !== d.declared_type) fail('VALIDATION_FAILED', `Content is ${detected} but the document declared ${d.declared_type}`, { field: 'content', detected });
  const receivedSha256 = sha256Hex(received);
  const { bytes, removed } = stripLocation(received, detected!);
  const stored = await deps.store.put(tx, actor.clinicId, bytes);
  await addEvent(tx, actor, d.id, 1, { kind: 'CONTENT_STORED', status: 'QUARANTINE', blobRef: stored.ref, storeKind: deps.store.kind, detectedType: detected,
    receivedSha256, storedSha256: stored.sha256, storedSize: stored.size, metadataRemoved: removed });
  await appendAudit(tx, actor, 'document.content_stored', 'patient_document', d.id,
    { patientId: d.patient_id, type: detected, sizeBytes: stored.size, sha256: stored.sha256, receivedSha256, locationMetadataRemoved: removed, store: deps.store.kind });
  return screen(tx, actor, deps, d, bytes, detected!, 2);
}

async function screen(tx: Tx, actor: Actor, deps: DocumentDeps, d: DocRow, bytes: Buffer, type: DocumentType, seq: number) {
  const r = await deps.screener.screen(bytes, type);
  if (r.verdict === 'UNAVAILABLE') return { status: 'QUARANTINE' as const, screen: { verdict: r.verdict, screener: deps.screener.name, reason: r.reason } };
  const pass = r.verdict === 'PASS';
  await addEvent(tx, actor, d.id, seq, { kind: pass ? 'SCREEN_PASSED' : 'SCREEN_REJECTED', status: pass ? 'ACTIVE' : 'REJECTED', screener: deps.screener.name, reason: r.reason });
  await appendAudit(tx, actor, pass ? 'document.screen_passed' : 'document.screen_rejected', 'patient_document', d.id, { patientId: d.patient_id, screener: deps.screener.name, reason: r.reason });
  return { status: pass ? 'ACTIVE' as const : 'REJECTED' as const, screen: { verdict: r.verdict, screener: deps.screener.name, reason: r.reason } };
}

/** Fetch stored bytes and prove they are the ones recorded; corruption or substitution is never served. */
async function verifiedBytes(tx: Tx, actor: Actor, deps: DocumentDeps, c: EventRow): Promise<Buffer> {
  const bytes = await deps.store.get(tx, actor.clinicId, c.blob_ref!);
  if (!bytes || bytes.length !== c.stored_size || sha256Hex(bytes) !== c.stored_sha256)
    fail('CONTENT_INTEGRITY_FAILED', 'Stored content no longer matches its recorded SHA-256; it is not served. Run the integrity check and inform the owner.');
  return bytes!;
}

export function documentRoutes(deps: DocumentDeps): Route[] {
  return [
    {
      method: 'POST', path: '/api/v1/patients/:id/documents', permission: 'document.upload', idempotent: true,
      handler: async ({ tx, actor, params, body }) => {
        const b = asBody(body);
        const patient = await getPatient(tx, params.id!) as { id: string };
        const m = readMetadata(b);
        const visitId = optStr(b, 'visitId', { max: 36 });
        if (visitId) {
          const v = await getVisit(tx, visitId);
          if (v.patient_id !== patient.id) fail('VALIDATION_FAILED', 'visitId belongs to another patient', { field: 'visitId' });
        }
        const declaredType = oneOf(b, 'contentType', DOCUMENT_TYPES)!;
        const declaredSize = int(b, 'sizeBytes', 1, MAX_DOCUMENT_BYTES)!;
        const declaredSha = str(b, 'sha256', { min: 64, max: 64, pattern: HEX64 });
        const r = await tx.one<{ id: string }>(`INSERT INTO patient_documents (clinic_id, patient_id, visit_id, modality, title, teeth, area_code, acquired_on, source,
            declared_type, declared_size, declared_sha256, created_by) VALUES ($1,$2,$3,$4,$5,$6::smallint[],$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [actor!.clinicId, patient.id, visitId, m.modality, m.title, '{' + m.teeth.join(',') + '}', m.areaCode, m.acquiredOn, m.source, declaredType, declaredSize, declaredSha, actor!.staffId]);
        await appendAudit(tx, actor!, 'document.created', 'patient_document', r.id,
          { patientId: patient.id, visitId, modality: m.modality, teeth: m.teeth, areaCode: m.areaCode, source: m.source, declaredType, declaredSize, declaredSha256: declaredSha });
        const d = await loadDoc(tx, r.id);
        return { status: 201, body: { document: view(d, []), upload: { method: 'POST', path: `/api/v1/documents/${r.id}/content`, contentType: 'application/octet-stream', maxBytes: MAX_DOCUMENT_BYTES } } };
      },
    },
    {
      // Naturally idempotent: a retry with the same bytes after success returns the stored state; different bytes are refused.
      method: 'POST', path: '/api/v1/documents/:id/content', permission: 'document.upload', binaryBody: { maxBytes: MAX_DOCUMENT_BYTES },
      handler: async ({ tx, actor, params, body }) => {
        const bytes = body as Buffer;
        const d = await loadDoc(tx, params.id!);
        await lockDoc(tx, d.id);
        const ev = await events(tx, d.id);
        const prior = contentOf(ev);
        if (prior) {
          if (prior.received_sha256 === sha256Hex(bytes)) return { status: 200, body: { document: view(d, ev), replay: true } };
          fail('CONFLICT', 'This document already has content; upload a new document instead', { status: statusOf(ev) });
        }
        if (statusOf(ev) !== 'AWAITING_CONTENT') fail('CONFLICT', `Document is ${statusOf(ev)}`);
        if (bytes.length !== d.declared_size) fail('VALIDATION_FAILED', `Received ${bytes.length} bytes, the document declared ${d.declared_size}`, { field: 'content' });
        if (sha256Hex(bytes) !== d.declared_sha256) fail('VALIDATION_FAILED', 'Received content does not match the declared SHA-256 (corrupted or substituted in transit)', { field: 'content' });
        const r = await storeContent(tx, actor!, deps, d, bytes);
        return { status: 201, body: { document: view(d, await events(tx, d.id)), screen: r.screen } };
      },
    },
    {
      // Retry screening for content held in QUARANTINE (e.g. the scanner was unavailable at upload time).
      method: 'POST', path: '/api/v1/documents/:id/screen', permission: 'document.upload', idempotent: true,
      handler: async ({ tx, actor, params }) => {
        const d = await loadDoc(tx, params.id!);
        await lockDoc(tx, d.id);
        const ev = await events(tx, d.id);
        if (statusOf(ev) !== 'QUARANTINE') fail('CONFLICT', `Only QUARANTINE documents are screened; this one is ${statusOf(ev)}`);
        const c = contentOf(ev)!;
        const r = await screen(tx, actor!, deps, d, await verifiedBytes(tx, actor!, deps, c), c.detected_type!, ev.length + 1);
        return { status: 200, body: { document: view(d, await events(tx, d.id)), screen: r.screen } };
      },
    },
    {
      method: 'GET', path: '/api/v1/patients/:id/documents', permission: 'document.read',
      handler: async ({ tx, params, query }) => {
        const patient = await getPatient(tx, params.id!) as { id: string };
        const includeErrors = query.get('includeEnteredInError') === 'true';
        const docs = (await tx.query<DocRow>(SELECT_DOC + ' WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 500', [patient.id])).rows;
        const out = [];
        for (const raw of docs) {
          const d = { ...raw, teeth: parseIntArray(raw.teeth) };
          const v = view(d, await events(tx, d.id));
          if (v.status !== 'ENTERED_IN_ERROR' || includeErrors) out.push(v);
        }
        return { status: 200, body: { patientId: patient.id, documents: out } };
      },
    },
    {
      method: 'GET', path: '/api/v1/documents/:id', permission: 'document.read',
      handler: async ({ tx, params }) => {
        const d = await loadDoc(tx, params.id!);
        const ev = await events(tx, d.id);
        const names = new Map((await tx.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM staff WHERE id = ANY($1::uuid[])',
          ['{' + [d.created_by, ...ev.map(e => e.by_staff_id)].join(',') + '}'])).rows.map(r => [r.id, r.name]));
        return { status: 200, body: { document: view(d, ev), uploadedBy: names.get(d.created_by) ?? null,
          history: ev.map(e => ({ seq: e.seq, kind: e.kind, status: e.status_after, screener: e.screener, reason: e.reason, by: names.get(e.by_staff_id) ?? null, at: new Date(e.at).toISOString() })) } };
      },
    },
    {
      // Every successful download is an audit event (who, which document, which bytes). Attachment only, never inline.
      method: 'GET', path: '/api/v1/documents/:id/content', permission: 'document.read',
      handler: async ({ tx, actor, params }) => {
        const d = await loadDoc(tx, params.id!);
        const ev = await events(tx, d.id);
        const status = statusOf(ev);
        if (status !== 'ACTIVE') fail('CONFLICT', `Document content is not available (${status})`, { status });
        const c = contentOf(ev)!;
        const bytes = await verifiedBytes(tx, actor!, deps, c);
        await appendAudit(tx, actor!, 'document.downloaded', 'patient_document', d.id, { patientId: d.patient_id, sha256: c.stored_sha256 });
        return { status: 200, body: null, file: { bytes, contentType: c.detected_type!, filename: `ezz-document-${d.id.slice(0, 8)}.${EXTENSION[c.detected_type!]}`, sha256: c.stored_sha256! } };
      },
    },
    {
      // Wrong patient / wrong visit / unusable: the original stays (append-only) but is withdrawn from the patient's file.
      // With reassignToPatientId the same stored bytes are attached to the right patient as a NEW document (no copy).
      method: 'POST', path: '/api/v1/documents/:id/entered-in-error', permission: 'document.correct', idempotent: true,
      handler: async ({ tx, actor, params, body }) => {
        if (!actor!.roles.includes('DENTIST')) fail('FORBIDDEN_ROLE', 'Only a dentist corrects document attachments');
        const b = asBody(body);
        const reason = str(b, 'reason', { min: 3, max: 300 });
        const d = await loadDoc(tx, params.id!);
        await lockDoc(tx, d.id);
        const ev = await events(tx, d.id);
        const from = statusOf(ev);
        if (from === 'ENTERED_IN_ERROR') fail('CONFLICT', 'Document is already marked entered in error');
        const target = optStr(b, 'reassignToPatientId', { max: 36 });
        if (target && from !== 'ACTIVE') fail('CONFLICT', `Only ACTIVE content can be re-attached; this document is ${from}`);
        await addEvent(tx, actor!, d.id, ev.length + 1, { kind: 'ENTERED_IN_ERROR', status: 'ENTERED_IN_ERROR', reason });
        await appendAudit(tx, actor!, 'document.entered_in_error', 'patient_document', d.id, { patientId: d.patient_id, from, reassignToPatientId: target, hasReason: true });
        let reassigned: ReturnType<typeof view> | null = null;
        if (target) {
          const p = await getPatient(tx, target) as { id: string };
          const visitId = optStr(b, 'visitId', { max: 36 });
          if (p.id === d.patient_id && visitId === d.visit_id) fail('VALIDATION_FAILED', 'Re-attachment must change the patient or the visit', { field: 'reassignToPatientId' });
          if (visitId) { const v = await getVisit(tx, visitId); if (v.patient_id !== p.id) fail('VALIDATION_FAILED', 'visitId belongs to another patient', { field: 'visitId' }); }
          const c = contentOf(ev)!;
          const n = await tx.one<{ id: string }>(`INSERT INTO patient_documents (clinic_id, patient_id, visit_id, modality, title, teeth, area_code, acquired_on, source,
              declared_type, declared_size, declared_sha256, reassigned_from_id, created_by)
              SELECT clinic_id, $2, $3, modality, title, teeth, area_code, acquired_on, source, declared_type, declared_size, declared_sha256, id, $4
              FROM patient_documents WHERE id = $1 RETURNING id`, [d.id, p.id, visitId, actor!.staffId]);
          await addEvent(tx, actor!, n.id, 1, { kind: 'CONTENT_STORED', status: 'QUARANTINE', blobRef: c.blob_ref, storeKind: c.store_kind, detectedType: c.detected_type,
            receivedSha256: c.received_sha256, storedSha256: c.stored_sha256, storedSize: c.stored_size!, metadataRemoved: c.metadata_removed ?? [] });
          await addEvent(tx, actor!, n.id, 2, { kind: 'SCREEN_PASSED', status: 'ACTIVE', screener: `carried over from document ${d.id}`, reason: null });
          await appendAudit(tx, actor!, 'document.reassigned', 'patient_document', n.id, { patientId: p.id, visitId, reassignedFromId: d.id, fromPatientId: d.patient_id, sha256: c.stored_sha256 });
          const nd = await loadDoc(tx, n.id);
          reassigned = view(nd, await events(tx, n.id));
        }
        return { status: 200, body: { document: view(d, await events(tx, d.id)), reassigned } };
      },
    },
    {
      // RECORDS a deletion request. No code path deletes documents: execution waits for an approved retention policy (Q16).
      method: 'POST', path: '/api/v1/documents/:id/deletion-requests', permission: 'document.deletion_request', reauth: true, idempotent: true,
      handler: async ({ tx, actor, params, body }) => {
        const b = asBody(body);
        const basis = oneOf(b, 'basis', DELETION_BASES)!;
        const reason = str(b, 'reason', { min: 3, max: 300 });
        const d = await tx.maybeOne<{ id: string; patient_id: string }>('SELECT id, patient_id FROM patient_documents WHERE id = $1', [isUuid(params.id!) ? params.id! : '00000000-0000-0000-0000-000000000000']);
        if (!d) fail('NOT_FOUND', 'Document not found');
        const r = await tx.one<{ id: string; requested_at: string }>('INSERT INTO document_deletion_requests (clinic_id, document_id, basis, reason, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, requested_at',
          [actor!.clinicId, d!.id, basis, reason, actor!.staffId]);
        await appendAudit(tx, actor!, 'document.deletion_requested', 'document_deletion_request', r.id, { documentId: d!.id, patientId: d!.patient_id, basis, hasReason: true });
        return { status: 201, body: { request: { id: r.id, documentId: d!.id, basis, requestedAt: new Date(r.requested_at).toISOString(), state: 'AWAITING_RETENTION_POLICY', executed: false },
          note: 'Recorded only. No document is deleted by this version: deletion needs an approved retention and deletion policy (legal review, open question Q16).' } };
      },
    },
    {
      method: 'GET', path: '/api/v1/document-deletion-requests', permission: 'document.deletion_request',
      handler: async ({ tx }) => {
        const rows = (await tx.query<{ id: string; document_id: string; basis: string; reason: string; requested_at: string; name: string }>(
          `SELECT r.id, r.document_id, r.basis, r.reason, r.requested_at, s.display_name AS name FROM document_deletion_requests r
             JOIN staff s ON s.clinic_id = r.clinic_id AND s.id = r.requested_by ORDER BY r.requested_at DESC, r.id DESC LIMIT 500`)).rows;
        return { status: 200, body: { requests: rows.map(r => ({ id: r.id, documentId: r.document_id, basis: r.basis, reason: r.reason, requestedBy: r.name,
          requestedAt: new Date(r.requested_at).toISOString(), state: 'AWAITING_RETENTION_POLICY', executed: false })) } };
      },
    },
  ];
}
