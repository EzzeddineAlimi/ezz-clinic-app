/*
 * OWNER CHECKPOINTS module (R73 package A): the owner's routine for independent audit checkpoints.
 * Depends on: audit (chain, createCheckpoint), print (printable FR/AR document). Owns no tables.
 *
 * Why: the audit chain detects edits by recomputation, but a database superuser can rewrite the whole chain
 * consistently (B06 T-INT-LIMIT-1). Only a checkpoint kept OUTSIDE the database closes that gap, so this module
 * makes the outside copy easy to make, hard to mistype and easy to check:
 *  - create: a one-line checkpoint with a transcription check code, plus a printable FR/AR sheet;
 *  - status: age of the last checkpoint, events since, due flag, and whether the database's own copies still
 *    match the chain (a cheap tripwire; the evidence is the outside copy);
 *  - verify: paste or type the kept lines; each line gets one verdict, and a typo is reported as a typo
 *    (CHECKSUM_FAILED), never as tampering.
 * Owner-only; nothing here adds any step for the receptionist.
 * Limits (stated in every response): it proves the recorded history was not rewritten or rolled back after the
 * checkpoint. It cannot show that money or care that was never recorded happened (CH-002).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, optStr } from '../platform/validate.ts';
import { sha256 } from '../platform/canonical.ts';
import { createCheckpoint, verifyChain, CHECKPOINT_DUE_DAYS, type Anchor } from './audit.ts';
import { printOptions, renderHtml, type Lang, type PrintDocument } from './print.ts';

export const LINE_PREFIX = 'EZZ-CP2';
const LEGACY_PREFIX = 'EZZ-CHECKPOINT';
const MAX_LINES = 50;
export const SCOPE = 'A checkpoint proves that the recorded history up to its sequence number was not rewritten, deleted or rolled back afterwards. '
  + 'It cannot show that money or care that was never recorded happened (CH-002).';

export interface CheckpointFields { clinicCode: string; seq: number; hash: string; at: string }

/** 8 hex characters over every field: catches a mistyped digit before it can look like tampering. */
export const checkCode = (f: CheckpointFields) => sha256(`${LINE_PREFIX}|${f.clinicCode}|${f.seq}|${f.hash}|${f.at}`).slice(0, 8);
export const checkpointLine = (f: CheckpointFields) => `${LINE_PREFIX} clinic=${f.clinicCode} seq=${f.seq} hash=${f.hash} at=${f.at} check=${checkCode(f)}`;
/** The hash in groups of 4 for reading aloud or copying by hand. */
export const hashGroups = (hash: string) => hash.match(/.{1,4}/g)!.join(' ');

export type ParsedLine =
  | { ok: true; legacy: false; fields: CheckpointFields }
  | { ok: true; legacy: true; clinicId: string; seq: number; hash: string; at: string }
  | { ok: false; reason: 'MALFORMED' | 'CHECKSUM_FAILED'; detail: string };

/** Parse a kept line. Accepts the current EZZ-CP2 format and the legacy EZZ-CHECKPOINT line (no check code). */
export function parseCheckpointLine(raw: string): ParsedLine {
  const line = raw.trim().replace(/\s+/g, ' ');
  const v2 = /^EZZ-CP2 clinic=([a-z0-9-]{3,40}) seq=(\d{1,15}) hash=([0-9a-fA-F]{64}) at=(\S+) check=([0-9a-fA-F]{8})$/.exec(line);
  if (v2) {
    const fields: CheckpointFields = { clinicCode: v2[1]!, seq: Number(v2[2]), hash: v2[3]!.toLowerCase(), at: v2[4]! };
    if (!Number.isSafeInteger(fields.seq) || fields.seq < 1) return { ok: false, reason: 'MALFORMED', detail: 'seq must be a positive integer' };
    if (checkCode(fields) !== v2[5]!.toLowerCase()) return { ok: false, reason: 'CHECKSUM_FAILED', detail: 'The check code does not match the line: a character was probably copied wrongly. Re-read the original paper; this is not evidence of tampering.' };
    return { ok: true, legacy: false, fields };
  }
  const v1 = /^EZZ-CHECKPOINT ([0-9a-f-]{36}) seq=(\d{1,15}) hash=([0-9a-fA-F]{64}) at=(\S+)$/.exec(line);
  if (v1) return { ok: true, legacy: true, clinicId: v1[1]!, seq: Number(v1[2]), hash: v1[3]!.toLowerCase(), at: v1[4]! };
  if (line.startsWith(LINE_PREFIX) || line.startsWith(LEGACY_PREFIX)) return { ok: false, reason: 'MALFORMED', detail: 'The line is incomplete or has an unexpected field.' };
  return { ok: false, reason: 'MALFORMED', detail: `Not a checkpoint line (expected it to start with ${LINE_PREFIX}).` };
}

export type Verdict = 'MATCHES' | 'TAMPERED' | 'CHAIN_SHORTER' | 'WRONG_CLINIC' | 'CHECKSUM_FAILED' | 'MALFORMED';
const WORDING: Record<Verdict, string> = {
  MATCHES: 'The recorded history up to this checkpoint is exactly as it was when the checkpoint was taken.',
  TAMPERED: 'The recorded history up to this checkpoint differs from what was checkpointed: it was changed after the checkpoint. Stop and compare with the latest backup; this does not by itself show who changed it or why.',
  CHAIN_SHORTER: 'The recorded history now ends before this checkpoint: records were removed, or an older backup was restored. Compare with the latest backup.',
  WRONG_CLINIC: 'This checkpoint belongs to another clinic.',
  CHECKSUM_FAILED: 'The line was probably copied with a mistake. Re-read the original; this is not evidence of tampering.',
  MALFORMED: 'This is not a complete checkpoint line.',
};

/** Verify kept lines against the chain of one clinic (RLS-scoped tx). */
export async function verifyLines(tx: Tx, clinic: { id: string; code: string }, lines: string[]) {
  const parsed = lines.map(l => parseCheckpointLine(l));
  const anchors: Anchor[] = [];
  const pre = parsed.map((p, i) => {
    if (!p.ok) return { index: i, verdict: p.reason as Verdict, detail: p.detail };
    const ownClinic = p.legacy ? p.clinicId === clinic.id : p.fields.clinicCode === clinic.code;
    if (!ownClinic) return { index: i, verdict: 'WRONG_CLINIC' as Verdict };
    const a = p.legacy ? { seq: p.seq, hash: p.hash } : { seq: p.fields.seq, hash: p.fields.hash };
    anchors.push(a);
    return { index: i, anchor: a, legacy: p.legacy, at: p.legacy ? p.at : p.fields.at };
  });
  const chain = await verifyChain(tx, clinic.id, anchors);
  const results = pre.map(r => {
    if (!('anchor' in r) || !r.anchor) return { index: r.index, verdict: r.verdict!, wording: WORDING[r.verdict!], ...(r.detail ? { detail: r.detail } : {}) };
    const f = chain.findings.find(x => x.seq === r.anchor!.seq && (x.kind === 'ANCHOR_HASH_MISMATCH' || x.kind === 'SHORTER_THAN_ANCHOR' || x.kind === 'ANCHOR_MISSING'));
    const verdict: Verdict = !f ? 'MATCHES' : f.kind === 'ANCHOR_HASH_MISMATCH' ? 'TAMPERED' : 'CHAIN_SHORTER';
    return { index: r.index, verdict, wording: WORDING[verdict], seq: r.anchor.seq, takenAt: r.at, legacyFormat: r.legacy };
  });
  const otherFindings = chain.findings.filter(f => !['ANCHOR_HASH_MISMATCH', 'SHORTER_THAN_ANCHOR', 'ANCHOR_MISSING'].includes(f.kind));
  const ok = results.every(r => r.verdict === 'MATCHES') && otherFindings.length === 0;
  return { ok, results, chain: { ok: chain.ok, eventCount: chain.eventCount, lastSeq: chain.lastSeq, otherFindings }, scope: SCOPE };
}

/** The database's own checkpoint copies compared with the chain (tripwire only; the evidence is the outside copy). */
export async function internalCheckpointStatus(tx: Tx, clinicId: string) {
  const rows = (await tx.query<{ seq: number; hash: string; created_at: string; created_by: string; matches: boolean | null; chain_has: boolean }>(
    `SELECT c.seq, c.hash, c.created_at, c.created_by, (e.hash = c.hash) AS matches, e.seq IS NOT NULL AS chain_has
       FROM audit_checkpoints c LEFT JOIN audit_events e ON e.clinic_id = c.clinic_id AND e.seq = c.seq
      WHERE c.clinic_id = $1 ORDER BY c.created_at DESC, c.seq DESC`, [clinicId])).rows;
  return rows.map(r => ({ seq: Number(r.seq), at: new Date(r.created_at).toISOString(), createdBy: r.created_by,
    internalCopy: !r.chain_has ? 'CHAIN_SHORTER' : r.matches ? 'MATCHES' : 'DIFFERS' }));
}

function checkpointDocument(f: CheckpointFields, o: { lang: string; size: 'normal' | 'large' }): PrintDocument {
  const T: Record<string, Record<Lang, string>> = {
    title: { fr: 'Point de contrôle du registre (propriétaire)', ar: 'نقطة مراقبة السجل (المالك)' },
    clinic: { fr: 'Cabinet', ar: 'العيادة' }, seq: { fr: 'Numéro de séquence', ar: 'رقم التسلسل' },
    at: { fr: 'Pris le (UTC)', ar: 'أُخذ في (التوقيت العالمي)' }, hash: { fr: 'Empreinte', ar: 'البصمة' },
    check: { fr: 'Code de contrôle', ar: 'رمز التحقق' }, line: { fr: 'Ligne complète', ar: 'السطر الكامل' },
    keep: { fr: 'Conservez cette feuille HORS du cabinet et hors du système (coffre, domicile, photo personnelle). C\'est elle qui sert de preuve.', ar: 'احتفظ بهذه الورقة خارج العيادة وخارج النظام (خزنة، منزل، صورة شخصية). هي التي تُعدّ دليلاً.' },
    sign: { fr: 'Signature du propriétaire et date', ar: 'إمضاء المالك والتاريخ' },
    scope: { fr: 'Prouve que l\'historique enregistré jusqu\'à ce point n\'a pas été réécrit, supprimé ni restauré à une version antérieure. Ne peut pas montrer un paiement ou un soin jamais enregistré.', ar: 'يُثبت أن السجل المسجّل حتى هذه النقطة لم يُعَد كتابته أو حذفه أو استرجاعه إلى نسخة أقدم. لا يمكنه إظهار دفعة أو علاج لم يُسجَّل أبداً.' },
  };
  const langs: Lang[] = o.lang === 'both' ? ['fr', 'ar'] : [o.lang as Lang];
  return {
    documentType: 'AUDIT_CHECKPOINT', reference: `${f.clinicCode}#${f.seq}`, size: o.size, fontPt: o.size === 'large' ? 18 : 12,
    sections: langs.map(lang => ({
      lang, dir: lang === 'ar' ? 'rtl' : 'ltr', title: T.title![lang], mark: null, notice: T.scope![lang],
      lines: [
        { key: 'clinic', label: T.clinic![lang], value: f.clinicCode, isolate: true },
        { key: 'seq', label: T.seq![lang], value: String(f.seq), isolate: true, emphasis: true },
        { key: 'at', label: T.at![lang], value: f.at, isolate: true },
        { key: 'hash', label: T.hash![lang], value: hashGroups(f.hash), isolate: true },
        { key: 'check', label: T.check![lang], value: checkCode(f), isolate: true, emphasis: true },
        { key: 'line', label: T.line![lang], value: checkpointLine(f), isolate: true },
        { key: 'keep', label: T.keep![lang], value: '', isolate: false },
        { key: 'signature', label: T.sign![lang], value: '', isolate: false },
      ],
    })),
  };
}

async function clinicOf(tx: Tx, clinicId: string) {
  return tx.one<{ id: string; code: string }>('SELECT id, code FROM clinics WHERE id = $1', [clinicId]);
}

export const checkpointRoutes: Route[] = [
  {
    // Create a checkpoint and hand back everything needed to keep it outside: the line, the check code, a printable sheet.
    method: 'POST', path: '/api/v1/owner/checkpoints', permission: 'audit.checkpoint', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body ?? {});
      const o = printOptions(b);
      const cp = await createCheckpoint(tx, actor!, optStr(b, 'note', { max: 200 }));
      const clinic = await clinicOf(tx, actor!.clinicId);
      const fields: CheckpointFields = { clinicCode: clinic.code, seq: cp.seq, hash: cp.hash, at: cp.createdAt };
      const document = checkpointDocument(fields, o);
      return {
        status: 201,
        body: {
          checkpoint: { clinicCode: clinic.code, seq: cp.seq, hash: cp.hash, at: cp.createdAt, checkCode: checkCode(fields), hashGroups: hashGroups(cp.hash) },
          line: checkpointLine(fields),
          document, ...(o.format === 'html' ? { html: renderHtml(document) } : {}),
          instruction: 'Print or copy this line and keep it outside the clinic system. Only that outside copy is evidence; the copy inside the database is a convenience.',
          scope: SCOPE,
        },
      };
    },
  },
  {
    method: 'GET', path: '/api/v1/owner/checkpoints', permission: 'audit.verify',
    handler: async ({ tx, actor }) => {
      const internal = await internalCheckpointStatus(tx, actor!.clinicId);
      const last = internal[0] ?? null;
      const ageDays = last ? Math.floor((Date.now() - Date.parse(last.at)) / 86400_000) : null;
      // Events recorded after the last checkpoint, not counting the checkpoint bookkeeping events themselves.
      const since = await tx.one<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE clinic_id = $1 AND seq > $2 AND action <> 'audit.checkpoint_created'",
        [actor!.clinicId, last?.seq ?? 0]);
      return {
        status: 200,
        body: {
          due: !last || (ageDays as number) >= CHECKPOINT_DUE_DAYS, dueAfterDays: CHECKPOINT_DUE_DAYS,
          last: last ? { seq: last.seq, at: last.at, ageDays } : null,
          eventsSinceLast: since.n,
          internalCopies: { count: internal.length, differing: internal.filter(c => c.internalCopy !== 'MATCHES').length, items: internal.slice(0, 50) },
          note: 'The copies listed here are stored in the database and could be altered by a database superuser. Verify the copies you keep outside with POST /api/v1/owner/checkpoints/verify.',
          scope: SCOPE,
        },
      };
    },
  },
  {
    method: 'POST', path: '/api/v1/owner/checkpoints/verify', permission: 'audit.verify',
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > MAX_LINES || !b.lines.every(l => typeof l === 'string' && l.length <= 300)) {
        fail('VALIDATION_FAILED', `lines must be 1-${MAX_LINES} strings`, { field: 'lines' });
      }
      return { status: 200, body: await verifyLines(tx, await clinicOf(tx, actor!.clinicId), b.lines as string[]) };
    },
  },
];
