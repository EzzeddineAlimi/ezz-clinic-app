/*
 * AUDIT module: per-clinic hash chain, owner checkpoints (external anchors), verification.
 * Owns tables: audit_heads, audit_events, audit_checkpoints.
 *
 * What this DOES give (CH-017): durable actor-bound events written in the same transaction as the
 * business change; UPDATE/DELETE/TRUNCATE blocked by trigger and by missing privileges for ezz_app;
 * detection of an altered or removed event by recomputation; detection of tail truncation or an
 * old-backup restore WHEN the owner supplies a checkpoint kept outside this database.
 * What it does NOT give (CH-002 / CH-008): any proof that an event that was never entered happened;
 * protection against a database superuser who rewrites the whole chain AND the owner has no outside
 * checkpoint newer than the rewrite. Exposure window = time between owner checkpoints.
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { asBody, optStr } from '../platform/validate.ts';
import { fail } from '../platform/errors.ts';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditActorLike { staffId: string | null; clinicId: string; roles: string[] }

export async function appendAudit(tx: Tx, actor: AuditActorLike | Actor, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
  const clinicId = actor.clinicId;
  await tx.query('INSERT INTO audit_heads (clinic_id) VALUES ($1) ON CONFLICT (clinic_id) DO NOTHING', [clinicId]);
  const head = await tx.one<{ last_seq: number; last_hash: string }>('SELECT last_seq, last_hash FROM audit_heads WHERE clinic_id = $1 FOR UPDATE', [clinicId]);
  const seq = head.last_seq + 1;
  const occurredAt = new Date().toISOString();
  const doc = {
    v: 1, clinicId, seq, occurredAt,
    actorStaffId: actor.staffId, actorRoles: [...actor.roles].sort().join(','),
    action, entityType, entityId, payload, prevHash: head.last_hash,
  };
  const canonical = canonicalJson(doc);
  const hash = sha256(head.last_hash + '\n' + canonical);
  await tx.query(`INSERT INTO audit_events (clinic_id, seq, occurred_at, actor_staff_id, actor_roles, action, entity_type, entity_id, payload, canonical, prev_hash, hash)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [clinicId, seq, occurredAt, actor.staffId, doc.actorRoles, action, entityType, entityId, payload, canonical, head.last_hash, hash]);
  await tx.query('UPDATE audit_heads SET last_seq = $2, last_hash = $3 WHERE clinic_id = $1', [clinicId, seq, hash]);
  return { seq, hash };
}

export interface ChainFinding { kind: 'SEQ_GAP' | 'PREV_HASH_MISMATCH' | 'HASH_MISMATCH' | 'CANONICAL_MISMATCH' | 'HEAD_MISMATCH' | 'ANCHOR_MISSING' | 'ANCHOR_HASH_MISMATCH' | 'SHORTER_THAN_ANCHOR'; seq: number; detail: string }

export interface Anchor { seq: number; hash: string }

/** Recompute the whole chain for the current clinic (RLS-scoped). O(n); fine for one small clinic. */
export async function verifyChain(tx: Tx, clinicId: string, anchors: Anchor[] = []) {
  const findings: ChainFinding[] = [];
  const rows = (await tx.query<{ seq: number; canonical: string; prev_hash: string; hash: string; action: string; entity_id: string; actor_staff_id: string | null }>(
    'SELECT seq, canonical, prev_hash, hash, action, entity_id, actor_staff_id FROM audit_events WHERE clinic_id = $1 ORDER BY seq', [clinicId])).rows;
  let expectedSeq = 1;
  let prev = GENESIS_HASH;
  const bySeq = new Map<number, string>();
  for (const r of rows) {
    if (r.seq !== expectedSeq) findings.push({ kind: 'SEQ_GAP', seq: r.seq, detail: `expected seq ${expectedSeq}` });
    if (r.prev_hash !== prev) findings.push({ kind: 'PREV_HASH_MISMATCH', seq: r.seq, detail: 'prev_hash does not equal hash of previous event' });
    if (sha256(r.prev_hash + '\n' + r.canonical) !== r.hash) findings.push({ kind: 'HASH_MISMATCH', seq: r.seq, detail: 'stored hash does not match content' });
    try {
      const d = JSON.parse(r.canonical) as { seq: number; action: string; entityId: string; actorStaffId: string | null; prevHash: string };
      if (d.seq !== r.seq || d.action !== r.action || d.entityId !== r.entity_id || d.actorStaffId !== r.actor_staff_id || d.prevHash !== r.prev_hash) {
        findings.push({ kind: 'CANONICAL_MISMATCH', seq: r.seq, detail: 'indexed columns differ from hashed content' });
      }
    } catch { findings.push({ kind: 'CANONICAL_MISMATCH', seq: r.seq, detail: 'canonical text is not valid JSON' }); }
    bySeq.set(r.seq, r.hash);
    prev = r.hash;
    expectedSeq = r.seq + 1;
  }
  const lastSeq = rows.length ? rows[rows.length - 1]!.seq : 0;
  const head = await tx.maybeOne<{ last_seq: number; last_hash: string }>('SELECT last_seq, last_hash FROM audit_heads WHERE clinic_id = $1', [clinicId]);
  if (head && (head.last_seq !== lastSeq || (lastSeq > 0 && head.last_hash !== prev))) {
    findings.push({ kind: 'HEAD_MISMATCH', seq: head.last_seq, detail: `head says seq ${head.last_seq}, chain ends at ${lastSeq}` });
  }
  for (const a of anchors) {
    if (a.seq > lastSeq) findings.push({ kind: 'SHORTER_THAN_ANCHOR', seq: a.seq, detail: `chain ends at ${lastSeq}, owner checkpoint is at ${a.seq}` });
    else if (!bySeq.has(a.seq)) findings.push({ kind: 'ANCHOR_MISSING', seq: a.seq, detail: 'checkpoint sequence not present' });
    else if (bySeq.get(a.seq) !== a.hash) findings.push({ kind: 'ANCHOR_HASH_MISMATCH', seq: a.seq, detail: 'event at checkpoint has a different hash' });
  }
  return { ok: findings.length === 0, eventCount: rows.length, lastSeq, lastHash: lastSeq ? prev : GENESIS_HASH, findings };
}

export const auditRoutes: Route[] = [
  {
    // Owner checkpoint: the response is meant to be printed / copied OUT of the system (independent anchor).
    method: 'POST', path: '/api/v1/audit/checkpoints', permission: 'audit.checkpoint', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const note = optStr(asBody(body), 'note', { max: 200 });
      const head = await tx.maybeOne<{ last_seq: number; last_hash: string }>('SELECT last_seq, last_hash FROM audit_heads WHERE clinic_id = $1', [actor!.clinicId]);
      if (!head || head.last_seq === 0) fail('CONFLICT', 'Nothing to checkpoint yet');
      await tx.query('INSERT INTO audit_checkpoints (clinic_id, seq, hash, created_by, note) VALUES ($1,$2,$3,$4,$5)', [actor!.clinicId, head!.last_seq, head!.last_hash, actor!.staffId, note]);
      const cp = { clinicId: actor!.clinicId, seq: head!.last_seq, hash: head!.last_hash, createdAt: new Date().toISOString() };
      await appendAudit(tx, actor!, 'audit.checkpoint_created', 'audit_checkpoint', String(head!.last_seq), { hash: head!.last_hash });
      return {
        status: 201,
        body: {
          checkpoint: cp,
          printLine: `EZZ-CHECKPOINT ${cp.clinicId} seq=${cp.seq} hash=${cp.hash} at=${cp.createdAt}`,
          instruction: 'Keep this line outside the clinic system (paper, personal email or phone). It is the independent evidence.',
        },
      };
    },
  },
  {
    method: 'POST', path: '/api/v1/audit/verify', permission: 'audit.verify',
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const anchors: Anchor[] = Array.isArray(b.anchors) ? (b.anchors as unknown[]).map(a => {
        const o = asBody(a);
        if (typeof o.seq !== 'number' || !Number.isSafeInteger(o.seq) || o.seq < 1 || typeof o.hash !== 'string' || !/^[0-9a-f]{64}$/.test(o.hash)) fail('VALIDATION_FAILED', 'anchor must be {seq, hash}');
        return { seq: o.seq as number, hash: o.hash as string };
      }) : [];
      const result = await verifyChain(tx, actor!.clinicId, anchors);
      return { status: 200, body: { ...result, anchorsChecked: anchors.length, scope: 'Checks recorded entries only; events never entered cannot be detected (CH-002).' } };
    },
  },
];
