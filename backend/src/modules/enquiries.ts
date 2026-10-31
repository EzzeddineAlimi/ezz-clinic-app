/** Pre-booking manual follow-up only: no patient chart, clinical triage or outbound contact. */
import { advisoryLock, type Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { asBody, int, oneOf, optStr, str, uuid } from '../platform/validate.ts';
import { fail } from '../platform/errors.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';

interface Enquiry {
  id: string; name: string; reason: string; callback: string | null; status: string; version: number;
  createdBy: string; updatedBy: string; createdAt: string; updatedAt: string;
}
function input(body: unknown, update = false) {
  const b = asBody(body);
  const keys = ['name', 'reason', 'callback', 'isSynthetic', ...(update ? ['status', 'expectedVersion'] : [])];
  if (Object.keys(b).some(k => !keys.includes(k))) fail('VALIDATION_FAILED', 'Unknown or unsupported field');
  if (b.isSynthetic !== true) fail('VALIDATION_FAILED', 'isSynthetic must be true: fictional enquiries only');
  const name = str(b, 'name', { max: 160 }), reason = str(b, 'reason', { max: 240 });
  const callback = optStr(b, 'callback', { max: 40 });
  // Exact-content duplicate heuristic, not a claim about verified identity. Keep originals for display.
  const norm = (s: string | null) => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  const duplicateKey = sha256(canonicalJson([norm(name), norm(reason), norm(callback)]));
  return { name, reason, callback, duplicateKey, status: update ? oneOf(b, 'status', ['OPEN', 'CLOSED'])! : 'OPEN',
    expectedVersion: update ? int(b, 'expectedVersion', 1, 2147483646)! : null };
}
async function read(tx: Tx, id: string): Promise<Enquiry> {
  uuid({ id }, 'id');
  const e = await tx.maybeOne<Enquiry>(`SELECT id,name,reason,callback,status,version,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM enquiries WHERE id=$1`, [id]);
  if (!e) fail('NOT_FOUND', 'Enquiry not found');
  return e!;
}
async function checkDuplicate(tx: Tx, key: string, except: string | null) {
  const e = await tx.maybeOne<{ id: string }>(
    'SELECT id FROM enquiries WHERE status=$1 AND duplicate_key=$2 AND ($3::uuid IS NULL OR id<>$3)', ['OPEN', key, except]);
  if (e) fail('CONFLICT', 'An identical open enquiry exists; review it before recording another', { reason: 'ENQUIRY_DUPLICATE', enquiryId: e.id });
}
export const enquiryRoutes: Route[] = [
  { method: 'POST', path: '/api/v1/enquiries', permission: 'enquiry.manage', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = input(body);
      await advisoryLock(tx, 'enquiries', actor!.clinicId);
      await checkDuplicate(tx, b.duplicateKey, null);
      const e = await tx.one<{ id: string }>(`INSERT INTO enquiries(clinic_id,name,reason,callback,is_synthetic,duplicate_key,created_by,updated_by)
        VALUES ($1,$2,$3,$4,true,$5,$6,$6) RETURNING id`, [actor!.clinicId, b.name, b.reason, b.callback, b.duplicateKey, actor!.staffId]);
      await appendAudit(tx, actor!, 'enquiry.created', 'enquiry', e.id, { version: 1 });
      return { status: 201, body: { enquiry: await read(tx, e.id) } };
    } },
  { method: 'GET', path: '/api/v1/enquiries', permission: 'enquiry.manage',
    handler: async ({ tx, query }) => {
      const status = oneOf({ status: query.get('status') ?? 'OPEN' }, 'status', ['OPEN', 'CLOSED']);
      // Keyset pagination avoids silently losing entries on a busy desk; no caller text in URLs.
      const beforeId = query.get('before');
      if (beforeId) await read(tx, beforeId);
      const rows = (await tx.query<Enquiry>(`SELECT id,name,reason,callback,status,version,created_by AS "createdBy",updated_by AS "updatedBy",created_at AS "createdAt",updated_at AS "updatedAt" FROM enquiries WHERE status=$1
        AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM enquiries WHERE id=$2))
        ORDER BY created_at DESC,id DESC LIMIT 51`, [status, beforeId])).rows;
      return { status: 200, body: { enquiries: rows.slice(0, 50), nextBefore: rows.length > 50 ? rows[49]!.id : null } };
    } },
  { method: 'GET', path: '/api/v1/enquiries/:id', permission: 'enquiry.manage',
    handler: async ({ tx, params }) => ({ status: 200, body: { enquiry: await read(tx, params.id!) } }) },
  { method: 'POST', path: '/api/v1/enquiries/:id/update', permission: 'enquiry.manage', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = input(body, true);
      await advisoryLock(tx, 'enquiries', actor!.clinicId);
      const old = await read(tx, params.id!);
      if (old.version !== b.expectedVersion) fail('CONFLICT', 'Reload the enquiry before editing', { reason: 'ENQUIRY_VERSION_STALE', currentVersion: old.version });
      if (b.status === 'OPEN') await checkDuplicate(tx, b.duplicateKey, old.id);
      await tx.query(`UPDATE enquiries SET name=$2,reason=$3,callback=$4,status=$5,duplicate_key=$6,
        version=version+1,updated_by=$7,updated_at=clock_timestamp() WHERE id=$1`,
      [old.id, b.name, b.reason, b.callback, b.status, b.duplicateKey, actor!.staffId]);
      // Attribute mutations without copying caller details into the owner-readable audit stream.
      const changedFields = (['name', 'reason', 'callback', 'status'] as const).filter(k => old[k] !== b[k]);
      await appendAudit(tx, actor!, 'enquiry.updated', 'enquiry', old.id, { version: old.version + 1, changedFields });
      return { status: 200, body: { enquiry: await read(tx, old.id) } };
    } },
];
