/*
 * R73 package D — patient documents and dental imaging attachments. Real PostgreSQL; FICTIONAL bytes only (a 16x16
 * synthetic gradient JPEG carrying made-up GPS coordinates, a 1x1 PNG, hand-written PDFs, a minimal DICOM preamble).
 * Nothing is interpreted: the tests check storage, access, integrity and lifecycle, never image content.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, startApi, standardFixture, reauth, adminConn, newVisit, type Api, type TestDb } from './helpers.ts';
import { detectType, hasGpsMetadata, sha256Hex, stripLocation, structuralCheck, type ContentScreener } from '../src/platform/fileinspect.ts';
import { MemoryBlobStore, MAX_DOCUMENT_BYTES } from '../src/platform/blobstore.ts';
import { createBackup, restoreAndVerify } from '../src/ops/disaster-recovery.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';

// 16x16 synthetic gradient, EXIF: Orientation=6, ImageDescription "EZZ fictional test radiograph", GPS 36°48'N 10°10'E (made up).
const JPEG_WITH_GPS = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QC+RXhpZgAATU0AKgAAAAgAAwEOAAIAAAAeAAAAMgESAAMAAAABAAYAAIglAAQAAAABAAAAUAAAAABFWlogZmljdGlvbmFsIHRlc3QgcmFkaW9ncmFwaAAABAABAAIAAAACTgAAAAACAAUAAAADAAAAhgADAAIAAAACRQAAAAAEAAUAAAADAAAAngAAAAAAAAAkAAAAAQAAADAAAAABAAAAAAAAAAEAAAAKAAAAAQAAAAoAAAABAAAAAAAAAAH/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAAQABABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APH/AIbf8svwr6r+G3/LL8K+VPht/wAsvwr6r+G3/LL8K//Z', 'base64');

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const IHDR = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]); // 1x1, 8-bit greyscale
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = (extra: Buffer[] = []) => Buffer.concat([PNG_SIG, pngChunk('IHDR', IHDR), ...extra, pngChunk('IDAT', deflateSync(Buffer.from([0, 128]))), pngChunk('IEND', Buffer.alloc(0))]);
const PNG_WITH_EXIF = PNG([pngChunk('eXIf', Buffer.from('MM\0*\0\0\0\x08\0\0\0\0\0\0', 'latin1')), pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>fictional</x:xmpmeta>', 'latin1'))]);
const pdf = (body: string) => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R ${body}>> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const PDF_CLEAN = pdf('');
const DICOM = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM', 'latin1'), Buffer.from([0x02, 0x00, 0x10, 0x00]), Buffer.from('UI', 'latin1'), Buffer.from([0x14, 0x00]), Buffer.from('1.2.840.10008.1.2.1\0', 'latin1')]);

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let seq = 0;
async function clinic(a: Api = api, d: TestDb = db) { return standardFixture(a, d, `docs-${++seq}-${Date.now() % 100000}`, { openCashPeriod: false }); }

type Meta = { modality?: string; title?: string; source?: string; teeth?: number[]; contentType: string; bytes: Buffer; visitId?: string };
async function declare(a: Api, token: string, patientId: string, m: Meta, overrides: Record<string, unknown> = {}) {
  return a.call('POST', `/api/v1/patients/${patientId}/documents`, { token, body: {
    modality: m.modality ?? 'INTRAORAL_PERIAPICAL', title: m.title ?? 'Fictional periapical', source: m.source ?? 'IN_CLINIC_SENSOR',
    teeth: m.teeth ?? [36], contentType: m.contentType, sizeBytes: m.bytes.length, sha256: sha256Hex(m.bytes), ...(m.visitId ? { visitId: m.visitId } : {}), ...overrides } });
}
async function upload(a: Api, token: string | null, docId: string, bytes: Buffer, contentType = 'application/octet-stream') {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${a.base}/api/v1/documents/${docId}/content`, { method: 'POST', headers, body: new Uint8Array(bytes) }).catch((e: Error) => ({ status: -1, text: async () => e.message, headers: new Headers() }));
  const text = await res.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body };
}
async function download(a: Api, token: string, docId: string) {
  const res = await fetch(`${a.base}/api/v1/documents/${docId}/content`, { headers: { authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await res.arrayBuffer());
  let body: any = null; if ((res.headers.get('content-type') ?? '').startsWith('application/json')) body = JSON.parse(bytes.toString('utf8'));
  return { status: res.status, headers: res.headers, bytes, body };
}
async function attach(a: Api, token: string, patientId: string, m: Meta) {
  const d = await declare(a, token, patientId, m);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const u = await upload(a, token, d.body.document.id, m.bytes);
  return { id: d.body.document.id as string, upload: u };
}
async function auditActions(clinicId: string, entityId: string) {
  const c = await adminConn(db.name);
  try { return (await c.query<{ action: string; payload: Record<string, unknown> }>('SELECT action, payload FROM audit_events WHERE clinic_id = $1 AND entity_id = $2 ORDER BY seq', [clinicId, entityId] as never[])).rows; } finally { c.end(); }
}

test('T-DOCS-1 dentist attaches a fictional X-ray: declared, verified, GPS removed (orientation kept), ACTIVE, audited download with safe headers', async () => {
  const s = await clinic();
  const d = await declare(api, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: JPEG_WITH_GPS, visitId: s.visitId, teeth: [37, 36] });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.document.status, 'AWAITING_CONTENT');
  assert.deepEqual(d.body.document.teeth, [36, 37], 'teeth are stored sorted');
  assert.equal(d.body.upload.path, `/api/v1/documents/${d.body.document.id}/content`);
  const u = await upload(api, s.dentist, d.body.document.id, JPEG_WITH_GPS);
  assert.equal(u.status, 201, JSON.stringify(u.body));
  assert.equal(u.body.document.status, 'ACTIVE');
  assert.deepEqual(u.body.document.content.locationMetadataRemoved, ['EXIF_GPS']);
  assert.equal(u.body.document.content.receivedSha256, sha256Hex(JPEG_WITH_GPS));
  assert.notEqual(u.body.document.content.sha256, sha256Hex(JPEG_WITH_GPS), 'stored bytes differ: location removed');
  assert.match(u.body.screen.screener, /not a malware scanner/);

  const dl = await download(api, s.dentist, d.body.document.id);
  assert.equal(dl.status, 200);
  assert.equal(detectType(dl.bytes), 'image/jpeg');
  assert.equal(hasGpsMetadata(JPEG_WITH_GPS), true);
  assert.equal(hasGpsMetadata(dl.bytes), false, 'downloaded bytes carry no GPS');
  assert.equal(dl.bytes.length, JPEG_WITH_GPS.length, 'GPS blanked in place: same size, other EXIF (orientation) kept');
  assert.equal(sha256Hex(dl.bytes), u.body.document.content.sha256);
  assert.equal(dl.headers.get('content-type'), 'image/jpeg');
  assert.match(dl.headers.get('content-disposition')!, /^attachment; filename="ezz-document-[0-9a-f]{8}\.jpg"$/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dl.headers.get('cache-control'), 'no-store');
  assert.match(dl.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(dl.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(dl.headers.get('x-content-sha256'), u.body.document.content.sha256);

  const actions = (await auditActions(s.clinic.id, d.body.document.id)).map(r => r.action);
  assert.deepEqual(actions, ['document.created', 'document.content_stored', 'document.screen_passed', 'document.downloaded']);
  const list = await api.call('GET', `/api/v1/patients/${s.patientId}/documents`, { token: s.dentist });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.documents.map((x: { id: string }) => x.id), [d.body.document.id]);
  const one = await api.call('GET', `/api/v1/documents/${d.body.document.id}`, { token: s.dentist });
  assert.deepEqual(one.body.history.map((h: { kind: string }) => h.kind), ['CONTENT_STORED', 'SCREEN_PASSED']);
});

test('T-DOCS-2 authorization: only the dentist uploads, reads and downloads; owner records deletion requests only; anonymous uploads are refused before the body is read', async () => {
  const s = await clinic();
  const { id } = await attach(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
  for (const token of [s.desk, s.owner]) {
    assert.equal((await declare(api, token, s.patientId, { contentType: 'image/png', bytes: PNG() })).status, 403);
    assert.equal((await upload(api, token, id, PNG())).status, 403);
    assert.equal((await api.call('GET', `/api/v1/patients/${s.patientId}/documents`, { token })).status, 403);
    assert.equal((await api.call('GET', `/api/v1/documents/${id}`, { token })).status, 403);
    assert.equal((await download(api, token, id)).status, 403);
    assert.equal((await api.call('POST', `/api/v1/documents/${id}/entered-in-error`, { token, body: { reason: 'fictional' } })).status, 403);
  }
  assert.equal((await api.call('POST', `/api/v1/documents/${id}/deletion-requests`, { token: s.dentist, body: { basis: 'DUPLICATE', reason: 'fictional duplicate' } })).status, 403);
  // Anonymous caller announcing a body far over the cap: 401, not 413 — the size is never even considered before authentication.
  const res = await fetch(`${api.base}/api/v1/documents/${id}/content`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(1024) });
  assert.equal(res.status, 401);
});

test('T-DOCS-3 type and size rules: allow-listed declared types; bytes decide the type; size and SHA-256 must match; caps enforced', async () => {
  const s = await clinic();
  assert.equal((await declare(api, s.dentist, s.patientId, { contentType: 'application/x-msdownload', bytes: Buffer.from('MZ fictional') })).status, 400);
  assert.equal((await declare(api, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: JPEG_WITH_GPS }, { sizeBytes: MAX_DOCUMENT_BYTES + 1 })).status, 400);
  assert.equal((await declare(api, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: JPEG_WITH_GPS, teeth: [19] })).status, 400, 'invalid FDI tooth');
  assert.equal((await declare(api, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: JPEG_WITH_GPS, modality: 'AI_DIAGNOSIS' })).status, 400);

  const exe = Buffer.from('MZ\x90\0fictional executable bytes', 'latin1');
  let d = await declare(api, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: exe });
  let u = await upload(api, s.dentist, d.body.document.id, exe);
  assert.equal(u.status, 415, 'type comes from the bytes, not from the declaration');
  d = await declare(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: JPEG_WITH_GPS });
  u = await upload(api, s.dentist, d.body.document.id, JPEG_WITH_GPS);
  assert.equal(u.status, 400); assert.equal(u.body.error.details.detected, 'image/jpeg');
  d = await declare(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
  u = await upload(api, s.dentist, d.body.document.id, PNG().subarray(0, 20));
  assert.equal(u.status, 400); assert.match(u.body.error.message, /declared/);
  const flipped = PNG(); flipped.writeUInt8(flipped.readUInt8(flipped.length - 20) ^ 0x01, flipped.length - 20);
  u = await upload(api, s.dentist, d.body.document.id, flipped);
  assert.equal(u.status, 400, 'same length, different bytes: SHA-256 mismatch');
  assert.match(u.body.error.message, /SHA-256/);
  assert.equal((await upload(api, s.dentist, d.body.document.id, PNG(), 'application/json')).status, 415);
  const big = await upload(api, s.dentist, d.body.document.id, Buffer.alloc(MAX_DOCUMENT_BYTES + 1));
  assert.equal(big.status, 413);
  // Still AWAITING_CONTENT after every refusal: nothing was stored.
  assert.equal((await api.call('GET', `/api/v1/documents/${d.body.document.id}`, { token: s.dentist })).body.document.status, 'AWAITING_CONTENT');
  assert.equal((await upload(api, s.dentist, d.body.document.id, PNG())).status, 201);
});

test('T-DOCS-4 tenant and patient isolation: other clinic sees nothing; a visit of another patient cannot be attached (API and database)', async () => {
  const a = await clinic(); const b = await clinic();
  const { id } = await attach(api, a.dentist, a.patientId, { contentType: 'image/png', bytes: PNG() });
  assert.equal((await api.call('GET', `/api/v1/documents/${id}`, { token: b.dentist })).status, 404);
  assert.equal((await download(api, b.dentist, id)).status, 404);
  assert.equal((await upload(api, b.dentist, id, PNG())).status, 404);
  assert.equal((await api.call('GET', `/api/v1/patients/${a.patientId}/documents`, { token: b.dentist })).status, 404);
  assert.equal((await api.call('POST', `/api/v1/documents/${id}/entered-in-error`, { token: b.dentist, body: { reason: 'fictional probe' } })).status, 404);
  // Visit of another patient in the same clinic.
  const p2 = await api.call('POST', '/api/v1/patients', { token: a.desk, body: { familyName: 'Fictif', givenName: 'Sami', isSynthetic: true } });
  const v2 = await newVisit(api, a.desk, p2.body.patient.id);
  const bad = await declare(api, a.dentist, a.patientId, { contentType: 'image/png', bytes: PNG(), visitId: v2 });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'visitId');
  // The composite foreign key refuses the same mismatch even for a direct insert by the application role.
  const c = await adminConn(db.name);
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE ezz_app'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [a.clinic.id] as never[]);
    await assert.rejects(c.query(`INSERT INTO patient_documents (clinic_id, patient_id, visit_id, modality, title, source, declared_type, declared_size, declared_sha256, created_by)
      VALUES ($1, $2, $3, 'BITEWING', 'x', 'IN_CLINIC_SENSOR', 'image/png', 1, repeat('a', 64), $4)`, [a.clinic.id, a.patientId, v2, a.clinic.staff.dentist] as never[]), /foreign key/);
  } finally { await c.query('ROLLBACK').catch(() => {}); c.end(); }
});

test('T-DOCS-5 screening: active-content PDFs (also #-escaped) and polyglot JPEGs are REJECTED and never served; clean PDF, PNG metadata and DICOM handled', async () => {
  const s = await clinic();
  for (const [name, bytes] of [['js', pdf('/OpenAction << /S /JavaScript /JS (app.alert(1)) >> ')], ['escaped', pdf('/OpenAction << /S /J#61vaScript >> ')], ['launch', pdf('/OpenAction << /S /Launch /F (calc) >> ')]] as const) {
    const r = await attach(api, s.dentist, s.patientId, { modality: 'DOCUMENT_SCAN', contentType: 'application/pdf', bytes });
    assert.equal(r.upload.status, 201, name);
    assert.equal(r.upload.body.document.status, 'REJECTED', name);
    assert.match(r.upload.body.screen.reason, /active content/, name);
    const dl = await download(api, s.dentist, r.id);
    assert.equal(dl.status, 409, name); assert.equal(dl.body.error.details.status, 'REJECTED');
  }
  const polyglot = Buffer.concat([JPEG_WITH_GPS, Buffer.from('PK\x03\x04 fictional appended archive', 'latin1')]);
  const pg = await attach(api, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: polyglot });
  assert.equal(pg.upload.body.document.status, 'REJECTED');
  const clean = await attach(api, s.dentist, s.patientId, { modality: 'DOCUMENT_SCAN', contentType: 'application/pdf', bytes: PDF_CLEAN });
  assert.equal(clean.upload.body.document.status, 'ACTIVE');
  assert.match((await download(api, s.dentist, clean.id)).headers.get('content-disposition')!, /\.pdf"$/);
  const png = await attach(api, s.dentist, s.patientId, { modality: 'INTRAORAL_PHOTO', contentType: 'image/png', bytes: PNG_WITH_EXIF });
  assert.deepEqual(png.upload.body.document.content.locationMetadataRemoved, ['EXIF', 'XMP']);
  assert.ok(structuralCheck((await download(api, s.dentist, png.id)).bytes, 'image/png').verdict === 'PASS', 'stripped PNG is still well-formed');
  const dcm = await attach(api, s.dentist, s.patientId, { modality: 'CBCT', contentType: 'application/dicom', bytes: DICOM });
  assert.equal(dcm.upload.body.document.status, 'ACTIVE');
  assert.ok((await download(api, s.dentist, dcm.id)).bytes.equals(DICOM), 'DICOM stored byte-for-byte (not parsed)');
});

test('T-DOCS-6 wrong patient: dentist marks ENTERED_IN_ERROR with a reason and re-attaches the same bytes to the right patient; original withdrawn, never deleted', async () => {
  const s = await clinic();
  const p2 = await api.call('POST', '/api/v1/patients', { token: s.desk, body: { familyName: 'Fictif', givenName: 'Ines', isSynthetic: true } });
  const right = p2.body.patient.id as string;
  const { id, upload: u } = await attach(api, s.dentist, s.patientId, { modality: 'BITEWING', contentType: 'image/jpeg', bytes: JPEG_WITH_GPS });
  assert.equal((await api.call('POST', `/api/v1/documents/${id}/entered-in-error`, { token: s.dentist, body: {} })).status, 400, 'reason required');
  const r = await api.call('POST', `/api/v1/documents/${id}/entered-in-error`, { token: s.dentist, body: { reason: 'Attached to the wrong fictional patient', reassignToPatientId: right } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.document.status, 'ENTERED_IN_ERROR');
  assert.equal(r.body.reassigned.patientId, right);
  assert.equal(r.body.reassigned.status, 'ACTIVE');
  assert.equal(r.body.reassigned.reassignedFromId, id);
  assert.equal(r.body.reassigned.content.sha256, u.body.document.content.sha256, 'same stored bytes, no copy');
  assert.equal((await download(api, s.dentist, id)).status, 409, 'the withdrawn attachment is not served from the wrong patient');
  assert.equal((await download(api, s.dentist, r.body.reassigned.id)).status, 200);
  assert.deepEqual((await api.call('GET', `/api/v1/patients/${s.patientId}/documents`, { token: s.dentist })).body.documents, []);
  const withErrors = await api.call('GET', `/api/v1/patients/${s.patientId}/documents?includeEnteredInError=true`, { token: s.dentist });
  assert.equal(withErrors.body.documents[0].status, 'ENTERED_IN_ERROR');
  assert.equal((await api.call('POST', `/api/v1/documents/${id}/entered-in-error`, { token: s.dentist, body: { reason: 'again' } })).status, 409);
  const hist = await api.call('GET', `/api/v1/documents/${id}`, { token: s.dentist });
  assert.equal(hist.body.history.at(-1).reason, 'Attached to the wrong fictional patient');
  assert.deepEqual((await auditActions(s.clinic.id, r.body.reassigned.id)).map(x => x.action), ['document.reassigned', 'document.downloaded']);
});

test('T-DOCS-7 retention: an owner deletion request is recorded and audited but executes nothing; the database refuses deletes and edits', async () => {
  const s = await clinic();
  const { id } = await attach(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
  await reauth(api, s.owner);
  const r = await api.call('POST', `/api/v1/documents/${id}/deletion-requests`, { token: s.owner, body: { basis: 'PATIENT_REQUEST', reason: 'Fictional patient asked for erasure' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.request.executed, false);
  assert.equal(r.body.request.state, 'AWAITING_RETENTION_POLICY');
  assert.match(r.body.note, /No document is deleted/);
  const list = await api.call('GET', '/api/v1/document-deletion-requests', { token: s.owner });
  assert.deepEqual(list.body.requests.map((x: { documentId: string }) => x.documentId), [id]);
  assert.equal((await download(api, s.dentist, id)).status, 200, 'still available: nothing was deleted');
  const c = await adminConn(db.name);
  try {
    for (const sql of ['DELETE FROM patient_documents', 'DELETE FROM document_blobs', 'DELETE FROM patient_document_events', "UPDATE patient_documents SET title = 'x'"]) {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE ezz_app'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [s.clinic.id] as never[]);
      await assert.rejects(c.query(sql), /permission denied/, sql);
      await c.query('ROLLBACK');
    }
    await c.query('BEGIN');
    await assert.rejects(c.query("UPDATE patient_documents SET title = 'x' WHERE id = $1", [id] as never[]), /append-only/i, 'append-only even for the schema owner');
    await c.query('ROLLBACK');
  } finally { c.end(); }
});

test('T-DOCS-8 tampered stored bytes: download refuses (500 CONTENT_INTEGRITY_FAILED) and the owner integrity check reports DOCUMENT_CONTENT_MISMATCH', async () => {
  const s = await clinic();
  const { id, upload: u } = await attach(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
  const before = await api.call('POST', '/api/v1/integrity/check', { token: s.owner, body: {}, idem: false });
  assert.deepEqual(before.body.findings.filter((f: { check: string }) => f.check.startsWith('DOCUMENT')), []);
  const c = await adminConn(db.name);
  const swap = async (bytes: Buffer) => {
    await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
    await c.query("UPDATE document_blobs SET content = $1 WHERE id = (SELECT substr(blob_ref, 4)::uuid FROM patient_document_events WHERE document_id = $2 AND kind = 'CONTENT_STORED')", [bytes, id] as never[]);
    await c.query('COMMIT');
  };
  try {
    const original = PNG();
    const forged = Buffer.from(original); forged.writeUInt8(forged.readUInt8(forged.length - 20) ^ 0x01, forged.length - 20);
    await swap(forged);
    const dl = await download(api, s.dentist, id);
    assert.equal(dl.status, 500); assert.equal(dl.body.error.code, 'CONTENT_INTEGRITY_FAILED');
    const after = await api.call('POST', '/api/v1/integrity/check', { token: s.owner, body: {}, idem: false });
    assert.ok(after.body.findings.some((f: { check: string; refs: { id: string } }) => f.check === 'DOCUMENT_CONTENT_MISMATCH'), JSON.stringify(after.body.findings));
    await swap(original);
    assert.equal(sha256Hex((await download(api, s.dentist, id)).bytes), u.body.document.content.sha256);
  } finally { c.end(); }
});

test('T-DOCS-9 storage is replaceable: the same API runs on an in-memory store (no bytes in PostgreSQL); a corrupted store is detected on read', async () => {
  const store = new MemoryBlobStore();
  const memApi = await startApi(db.appUrl, { documents: { store } });
  try {
    const s = await clinic(memApi);
    const { id, upload: u } = await attach(memApi, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: JPEG_WITH_GPS });
    assert.equal(u.status, 201, JSON.stringify(u.body));
    const dl = await download(memApi, s.dentist, id);
    assert.equal(sha256Hex(dl.bytes), u.body.document.content.sha256);
    const c = await adminConn(db.name);
    try {
      assert.equal((await c.query('SELECT count(*)::int AS n FROM document_blobs WHERE clinic_id = $1', [s.clinic.id] as never[])).rows[0]!.n, 0);
      const ref = (await c.query<{ blob_ref: string; store_kind: string }>("SELECT blob_ref, store_kind FROM patient_document_events WHERE document_id = $1 AND kind = 'CONTENT_STORED'", [id] as never[])).rows[0]!;
      assert.equal(ref.store_kind, 'memory-test-only');
      store.corrupt(ref.blob_ref);
    } finally { c.end(); }
    assert.equal((await download(memApi, s.dentist, id)).status, 500);
  } finally { await memApi.close(); }
});

test('T-DOCS-10 an unavailable screener keeps content in QUARANTINE (not served) until a later screen passes', async () => {
  let available = false;
  const screener: ContentScreener = { name: 'fictional-external-scanner', async screen() { return available ? { verdict: 'PASS', reason: null } : { verdict: 'UNAVAILABLE', reason: 'scanner offline (fictional)' }; } };
  const qApi = await startApi(db.appUrl, { documents: { screener } });
  try {
    const s = await clinic(qApi);
    const { id, upload: u } = await attach(qApi, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
    assert.equal(u.body.document.status, 'QUARANTINE');
    assert.equal((await download(qApi, s.dentist, id)).status, 409);
    available = true;
    const r = await qApi.call('POST', `/api/v1/documents/${id}/screen`, { token: s.dentist });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.document.status, 'ACTIVE');
    assert.equal((await download(qApi, s.dentist, id)).status, 200);
    assert.equal((await qApi.call('POST', `/api/v1/documents/${id}/screen`, { token: s.dentist })).status, 409, 'only QUARANTINE is re-screened');
  } finally { await qApi.close(); }
});

test('T-DOCS-11 concurrent uploads of one document: exactly one stores; the same bytes replay, different bytes are refused', async () => {
  const s = await clinic();
  const d = await declare(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
  const results = await Promise.all(Array.from({ length: 6 }, () => upload(api, s.dentist, d.body.document.id, PNG())));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 200, 200, 200, 201]);
  assert.equal(results.filter(r => r.body.replay).length, 5);
  const c = await adminConn(db.name);
  try { assert.equal((await c.query("SELECT count(*)::int AS n FROM patient_document_events WHERE document_id = $1 AND kind = 'CONTENT_STORED'", [d.body.document.id] as never[])).rows[0]!.n, 1); } finally { c.end(); }
  assert.equal((await upload(api, s.dentist, d.body.document.id, PNG_WITH_EXIF)).status, 409);
});

test('T-DOCS-12 integrity: rows written around the application, or audit/row disagreement, are reported', async () => {
  const s = await clinic();
  const { id } = await attach(api, s.dentist, s.patientId, { contentType: 'image/png', bytes: PNG() });
  const p2 = await api.call('POST', '/api/v1/patients', { token: s.desk, body: { familyName: 'Fictif', givenName: 'Nour', isSynthetic: true } });
  const c = await adminConn(db.name);
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
    await c.query('UPDATE patient_documents SET patient_id = $1 WHERE id = $2', [p2.body.patient.id, id] as never[]);
    await c.query(`INSERT INTO patient_documents (clinic_id, patient_id, modality, title, source, declared_type, declared_size, declared_sha256, created_by)
      VALUES ($1, $2, 'BITEWING', 'Inserted around the app', 'IN_CLINIC_SENSOR', 'image/png', 1, repeat('b', 64), $3)`, [s.clinic.id, s.patientId, s.clinic.staff.dentist] as never[]);
    await c.query('COMMIT');
  } finally { c.end(); }
  const r = await api.call('POST', '/api/v1/integrity/check', { token: s.owner, body: {}, idem: false });
  const checks = r.body.findings.map((f: { check: string }) => f.check);
  assert.ok(checks.includes('DOCUMENT_AUDIT_VALUE_MISMATCH'), JSON.stringify(checks));
  assert.ok(r.body.findings.some((f: { check: string; refs: { table: string } }) => f.check === 'ROW_WITHOUT_AUDIT_EVENT' && f.refs.table === 'patient_documents'));
});

test('T-DOCS-13 backup and fresh restore carry the document bytes: the restored download has the same SHA-256', async () => {
  const ownDb = await createTestDb(); const ownApi = await startApi(ownDb.appUrl);
  const adminUrl = process.env.EZZ_TEST_ADMIN_URL!;
  const work = mkdtempSync(join(tmpdir(), 'ezz-r73-docs-'));
  const target = `ezz_r73_docs_${Date.now()}`;
  try {
    const s = await clinic(ownApi, ownDb);
    const { id, upload: u } = await attach(ownApi, s.dentist, s.patientId, { contentType: 'image/jpeg', bytes: JPEG_WITH_GPS });
    const passphrase = 'fictional-r73-documents-pass';
    const b = await createBackup({ adminUrl, database: ownDb.name, outDir: work, passphrase, name: 'docs' });
    const r = await restoreAndVerify({ passphrase, targetAdminUrl: adminUrl, migrationsDir: MIGRATIONS_DIR, encryptedPath: b.encryptedPath, manifestPath: b.manifestPath, targetDatabase: target,
      rolePasswords: { owner: new URL(ownDb.ownerUrl).password, app: new URL(ownDb.appUrl).password } });
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter(c => !c.ok)));
    const restoredUrl = new URL(ownDb.appUrl); restoredUrl.pathname = '/' + target;
    const rApi = await startApi(restoredUrl.toString());
    try {
      const dentist = await rApi.login(s.clinic.code, 'dentist');
      const dl = await download(rApi, dentist, id);
      assert.equal(dl.status, 200);
      assert.equal(sha256Hex(dl.bytes), u.body.document.content.sha256);
    } finally { await rApi.close(); }
  } finally {
    rmSync(work, { recursive: true, force: true });
    await ownApi.close(); await ownDb.drop();
    const a = await adminConn();
    try { await a.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`); } finally { a.end(); }
  }
});

test('T-DOCS-14 byte inspection units: magic bytes, JPEG/PNG location stripping never mutates its input, unparseable EXIF is dropped', () => {
  assert.equal(detectType(Buffer.from('GIF89a')), null);
  assert.equal(detectType(DICOM), 'application/dicom');
  const copy = Buffer.from(JPEG_WITH_GPS);
  stripLocation(copy, 'image/jpeg');
  assert.ok(copy.equals(JPEG_WITH_GPS), 'input buffer untouched');
  // Corrupt the IFD0 offset inside the EXIF block: the whole block is dropped rather than kept with GPS.
  const broken = Buffer.from(JPEG_WITH_GPS);
  const exif = broken.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6;
  broken.writeUInt32BE(0xfffffff0, exif + 4);
  const r = stripLocation(broken, 'image/jpeg');
  assert.deepEqual(r.removed, ['EXIF_UNPARSEABLE']);
  assert.equal(r.bytes.indexOf(Buffer.from('Exif\0\0', 'latin1')), -1);
  assert.equal(structuralCheck(r.bytes, 'image/jpeg').verdict, 'PASS');
});
