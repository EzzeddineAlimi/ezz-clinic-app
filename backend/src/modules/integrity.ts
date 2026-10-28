/*
 * INTEGRITY module (read-only, owner): missing-record and tamper detection across modules (C5).
 * Depends on: audit (chain verification) and reads billing/care tables. Nothing depends on it.
 *
 * Detects: receipt-number gaps or counter drift; payments without a receipt (desk source); receipts whose
 * referenced records are missing; financial rows with no matching audit event (row inserted around the
 * application, e.g. directly in the database); audit chain breaks; owner-checkpoint mismatches.
 * Cannot detect: a payment that was never entered anywhere (CH-002).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { asBody } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { verifyChain, type Anchor } from './audit.ts';
import { noteHash } from './clinical.ts';
import { expectedCash } from './cash.ts';

export interface IntegrityFinding { check: string; severity: 'HIGH' | 'MEDIUM'; detail: string; refs?: unknown }

async function tableExists(tx: Tx, name: string) {
  return (await tx.one<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).ok;
}

export async function integrityCheck(tx: Tx, clinicId: string, anchors: Anchor[] = []) {
  const findings: IntegrityFinding[] = [];
  const nums = (await tx.query<{ number: number }>("SELECT number FROM receipts WHERE series = 'R' ORDER BY number")).rows.map(r => r.number);
  const missing: number[] = [];
  let expect = 1;
  for (const n of nums) { while (expect < n) missing.push(expect++); expect = n + 1; }
  if (missing.length) findings.push({ check: 'RECEIPT_NUMBER_GAP', severity: 'HIGH', detail: `Receipt numbers missing from the series: ${missing.slice(0, 20).map(n => 'R-' + String(n).padStart(6, '0')).join(', ')}${missing.length > 20 ? '…' : ''}`, refs: { missingCount: missing.length, missing: missing.slice(0, 200) } });
  const counter = await tx.maybeOne<{ next_number: number }>("SELECT next_number FROM receipt_counters WHERE series = 'R'");
  const max = nums.length ? nums[nums.length - 1]! : 0;
  if (counter && counter.next_number !== max + 1) findings.push({ check: 'RECEIPT_COUNTER_DRIFT', severity: 'HIGH', detail: `Counter says next is ${counter.next_number}, highest issued is ${max}` });

  const noReceipt = (await tx.query<{ id: string }>("SELECT p.id FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.source = 'DESK' AND r.id IS NULL")).rows;
  if (noReceipt.length) findings.push({ check: 'PAYMENT_WITHOUT_RECEIPT', severity: 'HIGH', detail: `${noReceipt.length} desk payment(s) have no receipt`, refs: noReceipt.map(r => r.id) });

  const audited: [string, string, string][] = [
    ['payments', 'payment', 'payment.recorded'],
    ['care_items', 'care_item', 'care.%'],
    ['adjustments', 'adjustment', '%'],
  ];
  for (const [table, entity, actionLike] of audited) {
    const rows = (await tx.query<{ id: string }>(`SELECT t.id FROM ${table} t WHERE NOT EXISTS (
        SELECT 1 FROM audit_events e WHERE e.entity_type = $1 AND e.entity_id = t.id::text AND e.action LIKE $2)`, [entity, actionLike])).rows;
    if (rows.length) findings.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${rows.length} ${table} row(s) have no audit event (written around the application?)`, refs: rows.map(r => r.id) });
  }
  const orphanEvents = (await tx.query<{ entity_id: string }>(`SELECT e.entity_id FROM audit_events e WHERE e.action = 'payment.recorded'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id::text = e.entity_id)`)).rows;
  if (orphanEvents.length) findings.push({ check: 'AUDITED_PAYMENT_MISSING', severity: 'HIGH', detail: `${orphanEvents.length} audited payment(s) no longer exist in the payments table`, refs: orphanEvents.map(r => r.entity_id) });

  if (await tableExists(tx, 'cash_counts')) {
    const noAudit = (await tx.query<{ id: string }>(`SELECT c.id FROM cash_counts c WHERE NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.entity_type = 'cash_count' AND e.entity_id = c.id::text)`)).rows;
    if (noAudit.length) findings.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${noAudit.length} cash count(s) have no audit event`, refs: noAudit.map(r => r.id) });
  }

  findings.push(...await businessValueFindings(tx, clinicId, await tableExists(tx, 'cash_counts')));
  if (await tableExists(tx, 'clinical_notes')) findings.push(...await clinicalValueFindings(tx, clinicId));

  const chain = await verifyChain(tx, clinicId, anchors);
  for (const f of chain.findings) findings.push({ check: 'AUDIT_' + f.kind, severity: 'HIGH', detail: `seq ${f.seq}: ${f.detail}` });
  return {
    ok: findings.length === 0,
    receiptsIssued: nums.length,
    auditEvents: chain.eventCount,
    auditHead: { seq: chain.lastSeq, hash: chain.lastHash },
    findings,
    scope: 'Checks recorded entries only. A payment never entered anywhere cannot be detected (CH-002). Value checks compare each business row and each clinical row with the values captured in its audit event; an edit that also rewrites the audit chain is only detectable with an owner checkpoint kept outside the database.',
  };
}

export const integrityRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/integrity/check', permission: 'audit.verify',
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const anchors = Array.isArray(b.anchors) ? (b.anchors as Anchor[]).filter(a => a && Number.isSafeInteger(a.seq) && typeof a.hash === 'string' && /^[0-9a-f]{64}$/.test(a.hash)) : [];
      return { status: 200, body: await integrityCheck(tx, actor!.clinicId, anchors) };
    },
  },
];

/*
 * B06 / CH-027: business-row VALUES vs the values captured in their audit events (and a recomputation of the
 * blind count's expected cash). The hash chain proves the audit events were not altered; these checks prove
 * the business rows still say what the events recorded. Only fields that were actually captured are compared
 * (R65: anything never audited is out of scope, not "tampered"). A finding is a data inconsistency, never an
 * accusation: it does not say who changed what, why, or that money was lost.
 */
const NEUTRAL = 'The recorded value differs from the value captured in its audit event when it was entered. This is a data-consistency finding: it does not by itself show who changed it, why, or that money was lost.';

type Ev = { action: string; payload: Record<string, unknown>; actor: string | null };
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

export async function businessValueFindings(tx: Tx, clinicId: string, withCash = true): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const evRows = (await tx.query<{ action: string; entity_type: string; entity_id: string; payload: Record<string, unknown>; actor_staff_id: string | null }>(
    `SELECT action, entity_type, entity_id, payload, actor_staff_id FROM audit_events WHERE clinic_id = $1 AND action IN
      ('payment.recorded','payment.refunded','payment.voided','adjustment.created','care.confirmed','care.corrected','cash.count_submitted','cash.movement_recorded')
     ORDER BY seq`, [clinicId])).rows;
  const events = new Map<string, Ev[]>();
  for (const e of evRows) {
    const k = `${e.entity_type}:${e.entity_id}`;
    (events.get(k) ?? events.set(k, []).get(k)!).push({ action: e.action, payload: e.payload, actor: e.actor_staff_id });
  }
  const one = (entity: string, id: string, actions: string[]) => (events.get(`${entity}:${id}`) ?? []).filter(e => actions.includes(e.action));
  const mismatch = (check: string, table: string, id: string, field: string, recorded: unknown, audited: unknown) =>
    out.push({ check, severity: 'HIGH', detail: `${table} ${id}: ${field} is ${JSON.stringify(recorded)} but the audit event recorded ${JSON.stringify(audited)}. ${NEUTRAL}`, refs: { table, id, field, recorded, audited } });
  const duplicate = (table: string, id: string, count: number) =>
    out.push({ check: 'DUPLICATE_AUDIT_EVENT', severity: 'MEDIUM', detail: `${table} ${id} has ${count} creation events; expected exactly one.`, refs: { table, id, count } });
  const compare = (check: string, table: string, id: string, pairs: Array<[string, unknown, unknown]>) => {
    for (const [field, recorded, audited] of pairs) if (!same(recorded, audited)) mismatch(check, table, id, field, recorded, audited);
  };

  // V1 payments
  const payments = (await tx.query<{ id: string; amount_millimes: number; tender: string; source: string; visit_id: string; cash_period_id: string | null; recorded_by: string }>(
    'SELECT id, amount_millimes, tender, source, visit_id, cash_period_id, recorded_by FROM payments WHERE clinic_id = $1', [clinicId])).rows;
  const auditedPayment = new Map<string, Record<string, unknown>>();
  for (const p of payments) {
    const ev = one('payment', p.id, ['payment.recorded']);
    if (ev.length > 1) duplicate('payments', p.id, ev.length);
    if (!ev.length) continue; // absence is reported by ROW_WITHOUT_AUDIT_EVENT
    const a = ev[0]!.payload;
    auditedPayment.set(p.id, a);
    compare('PAYMENT_AUDIT_VALUE_MISMATCH', 'payments', p.id, [
      ['amountMillimes', p.amount_millimes, a.amountMillimes], ['tender', p.tender, a.tender], ['source', p.source, a.source],
      ['visitId', p.visit_id, a.visitId], ['cashPeriodId', p.cash_period_id, a.cashPeriodId], ['recordedBy', p.recorded_by, ev[0]!.actor],
    ]);
  }

  // V2 allocations: in v0.2 a payment is allocated in full to its own visit (no deposits/credit, R55). If
  // credit or split allocation is ever introduced, this rule must change with it.
  const allocs = (await tx.query<{ payment_id: string; allocated: number; visits: string[]; amount: number; visit_id: string }>(
    `SELECT p.id AS payment_id, coalesce(sum(a.amount_millimes), 0)::bigint AS allocated, coalesce(json_agg(DISTINCT a.visit_id) FILTER (WHERE a.visit_id IS NOT NULL), '[]') AS visits,
            p.amount_millimes AS amount, p.visit_id
       FROM payments p LEFT JOIN payment_allocations a ON a.clinic_id = p.clinic_id AND a.payment_id = p.id
      WHERE p.clinic_id = $1 GROUP BY p.id`, [clinicId])).rows;
  for (const a of allocs) {
    const audited = auditedPayment.get(a.payment_id)?.amountMillimes ?? a.amount;
    if (a.allocated !== audited || a.visits.length !== 1 || a.visits[0] !== a.visit_id) {
      out.push({ check: 'ALLOCATION_MISMATCH', severity: 'HIGH', detail: `Payment ${a.payment_id}: allocated ${a.allocated} millimes to ${a.visits.length} visit(s), the payment amount is ${audited}. Visit balances are computed from allocations. ${NEUTRAL}`,
        refs: { table: 'payment_allocations', paymentId: a.payment_id, allocated: a.allocated, paymentAmount: audited, visits: a.visits } });
    }
  }

  // V5 adjustments (kind <-> action, amount, references)
  const adjustments = (await tx.query<{ id: string; kind: string; amount_millimes: number; reason_code: string; visit_id: string; payment_id: string | null; tender: string | null; authorized_by: string }>(
    'SELECT id, kind, amount_millimes, reason_code, visit_id, payment_id, tender, authorized_by FROM adjustments WHERE clinic_id = $1', [clinicId])).rows;
  const auditedAdjustment = new Map<string, Record<string, unknown>>();
  for (const j of adjustments) {
    const ev = one('adjustment', j.id, ['adjustment.created', 'payment.refunded', 'payment.voided']);
    if (ev.length > 1) duplicate('adjustments', j.id, ev.length);
    if (!ev.length) continue;
    const e = ev[0]!, a = e.payload;
    auditedAdjustment.set(j.id, a);
    const auditedKind = e.action === 'adjustment.created' ? a.kind : e.action === 'payment.refunded' ? 'REFUND' : 'PAYMENT_VOID';
    const pairs: Array<[string, unknown, unknown]> = [['kind', j.kind, auditedKind], ['amountMillimes', j.amount_millimes, a.amountMillimes], ['reasonCode', j.reason_code, a.reasonCode], ['authorizedBy', j.authorized_by, e.actor]];
    if (e.action === 'adjustment.created') pairs.push(['visitId', j.visit_id, a.visitId]);
    else pairs.push(['paymentId', j.payment_id, a.paymentId]);
    if (e.action === 'payment.refunded') pairs.push(['tender', j.tender, a.tender]);
    compare('ADJUSTMENT_AUDIT_VALUE_MISMATCH', 'adjustments', j.id, pairs);
  }

  // V3/V4 receipts: snapshot integrity, then snapshot and number vs the audited operation
  const receipts = (await tx.query<{ id: string; number: number; series: string; kind: string; payment_id: string | null; adjustment_id: string | null; snapshot: Record<string, unknown>; snapshot_sha256: string }>(
    'SELECT id, number, series, kind, payment_id, adjustment_id, snapshot, snapshot_sha256 FROM receipts WHERE clinic_id = $1', [clinicId])).rows;
  for (const r of receipts) {
    if (sha256(canonicalJson(r.snapshot)) !== r.snapshot_sha256) {
      out.push({ check: 'RECEIPT_SNAPSHOT_HASH_MISMATCH', severity: 'HIGH', detail: `Receipt ${r.series}-${r.number}: stored snapshot no longer matches its stored hash. ${NEUTRAL}`, refs: { table: 'receipts', id: r.id } });
    }
    const audited = r.payment_id ? auditedPayment.get(r.payment_id) : r.adjustment_id ? auditedAdjustment.get(r.adjustment_id) : undefined;
    compare('RECEIPT_VALUE_MISMATCH', 'receipts', r.id, [
      ['number', r.number, r.snapshot.number], ['kind', r.kind, r.snapshot.kind], ['series', r.series, r.snapshot.series],
      ...(audited ? [['number', r.number, audited.receiptNumber] as [string, unknown, unknown], ['amountMillimes', r.snapshot.amountMillimes, audited.amountMillimes] as [string, unknown, unknown]] : []),
    ]);
  }

  // V6 care fees and corrections
  const care = (await tx.query<{ id: string; kind: string; visit_id: string; corrects_id: string | null; procedure_code: string; tooth_fdi: number | null; surfaces: string | null; fee_millimes: number; reason: string | null }>(
    'SELECT id, kind, visit_id, corrects_id, procedure_code, tooth_fdi, surfaces, fee_millimes, reason FROM care_items WHERE clinic_id = $1', [clinicId])).rows;
  for (const c of care) {
    const ev = one('care_item', c.id, ['care.confirmed', 'care.corrected']);
    if (ev.length > 1) duplicate('care_items', c.id, ev.length);
    if (!ev.length) continue;
    const e = ev[0]!, a = e.payload;
    if (e.action === 'care.confirmed') {
      compare('CARE_AUDIT_VALUE_MISMATCH', 'care_items', c.id, [['kind', c.kind, 'CARE'], ['feeMillimes', c.fee_millimes, a.feeMillimes], ['visitId', c.visit_id, a.visitId],
        ['procedureCode', c.procedure_code, a.procedureCode], ['toothFdi', c.tooth_fdi, a.toothFdi], ['surfaces', c.surfaces, a.surfaces]]);
    } else {
      compare('CARE_AUDIT_VALUE_MISMATCH', 'care_items', c.id, [['kind', c.kind, 'CORRECTION'], ['feeMillimes', c.fee_millimes, a.deltaMillimes], ['correctsId', c.corrects_id, a.correctsId], ['reason', c.reason, a.reason]]);
    }
  }

  // V7 cash: counted figure and movements vs audit; stored expected cash vs a recomputation from the
  // append-only records at the same cut-off (a lowered "expected" would hide a shortfall).
  if (withCash) {
    const counts = (await tx.query<{ id: string; period_id: string; attempt_no: number; counted_millimes: number; expected_millimes: number; submitted_at: string }>(
      'SELECT id, period_id, attempt_no, counted_millimes, expected_millimes, submitted_at FROM cash_counts WHERE clinic_id = $1', [clinicId])).rows;
    for (const c of counts) {
      const ev = one('cash_count', c.id, ['cash.count_submitted']);
      if (ev.length) compare('CASH_COUNT_AUDIT_VALUE_MISMATCH', 'cash_counts', c.id, [['countedMillimes', c.counted_millimes, ev[0]!.payload.countedMillimes], ['periodId', c.period_id, ev[0]!.payload.periodId], ['attemptNo', c.attempt_no, ev[0]!.payload.attemptNo]]);
      const period = await tx.one<{ id: string; opened_at: string; opening_float_millimes: number; opening_basis: string; period_no: number; status: string; cutoff_at: string | null; drawer_id: string }>(
        'SELECT id, opened_at, opening_float_millimes, opening_basis, period_no, status, cutoff_at, drawer_id FROM cash_periods WHERE clinic_id = $1 AND id = $2', [clinicId, c.period_id]);
      const recomputed = (await expectedCash(tx, period as never, c.submitted_at)).expectedMillimes;
      if (recomputed !== c.expected_millimes) {
        out.push({ check: 'CASH_COUNT_EXPECTED_RECOMPUTE_MISMATCH', severity: 'HIGH',
          detail: `Cash count ${c.id}: the stored expected cash (${c.expected_millimes}) differs from a recomputation from recorded payments, movements and refunds up to the same cut-off (${recomputed}). ${NEUTRAL}`,
          refs: { table: 'cash_counts', id: c.id, storedExpected: c.expected_millimes, recomputedExpected: recomputed } });
      }
    }
    const moves = (await tx.query<{ id: string; period_id: string; kind: string; amount_millimes: number; voucher_ref: string | null }>(
      'SELECT id, period_id, kind, amount_millimes, voucher_ref FROM cash_movements WHERE clinic_id = $1', [clinicId])).rows;
    for (const m of moves) {
      const ev = one('cash_movement', m.id, ['cash.movement_recorded']);
      if (ev.length) compare('CASH_MOVEMENT_AUDIT_VALUE_MISMATCH', 'cash_movements', m.id, [['amountMillimes', m.amount_millimes, ev[0]!.payload.amountMillimes], ['kind', m.kind, ev[0]!.payload.kind], ['periodId', m.period_id, ev[0]!.payload.periodId], ['voucherRef', m.voucher_ref, ev[0]!.payload.voucherRef]]);
    }
  }

  // Audited rows that no longer exist (payments keep their original AUDITED_PAYMENT_MISSING check).
  const present = new Set([...adjustments.map(r => `adjustment:${r.id}`), ...care.map(r => `care_item:${r.id}`)]);
  if (withCash) {
    for (const r of (await tx.query<{ id: string }>('SELECT id FROM cash_counts WHERE clinic_id = $1', [clinicId])).rows) present.add(`cash_count:${r.id}`);
    for (const r of (await tx.query<{ id: string }>('SELECT id FROM cash_movements WHERE clinic_id = $1', [clinicId])).rows) present.add(`cash_movement:${r.id}`);
  }
  const TABLE: Record<string, string> = { adjustment: 'adjustments', care_item: 'care_items', cash_count: 'cash_counts', cash_movement: 'cash_movements' };
  for (const k of events.keys()) {
    const [entity, id] = k.split(':') as [string, string];
    if (!TABLE[entity] || (!withCash && entity.startsWith('cash_'))) continue;
    if (!present.has(k)) out.push({ check: 'AUDITED_ROW_MISSING', severity: 'HIGH', detail: `An audit event records ${entity} ${id}, but the row no longer exists. ${NEUTRAL}`, refs: { table: TABLE[entity], id } });
  }
  return out;
}

/*
 * R72 / M-264 (5): the same comparison for the B07 clinical tables. Only fields captured in the audit payload are
 * compared (R65), plus a recomputation of each signed note's content hash. Wording stays neutral.
 */
export async function clinicalValueFindings(tx: Tx, clinicId: string): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const evRows = (await tx.query<{ action: string; entity_id: string; payload: Record<string, unknown>; actor_staff_id: string | null }>(
    `SELECT action, entity_id, payload, actor_staff_id FROM audit_events WHERE clinic_id = $1 AND action IN
      ('clinical.note_signed','clinical.note_struck','clinical.finding_recorded','clinical.finding_struck','clinical.plan_item_created',
       'clinical.plan_item_status','medical.alert_recorded','medical.alert_revised','medical.history_reviewed','medical.alerts_acknowledged','care.site_amended')
     ORDER BY seq`, [clinicId])).rows;
  // Key every event by the clinical row it created.
  const byRow = new Map<string, Ev[]>();
  const key = (table: string, id: unknown) => `${table}:${String(id)}`;
  const add = (k: string, e: typeof evRows[number]) => (byRow.get(k) ?? byRow.set(k, []).get(k)!).push({ action: e.action, payload: e.payload, actor: e.actor_staff_id });
  for (const e of evRows) {
    const p = e.payload;
    switch (e.action) {
      case 'clinical.note_signed': case 'clinical.note_struck': add(key('clinical_notes', e.entity_id), e); break;
      case 'clinical.finding_recorded': add(key('chart_findings', e.entity_id), e); break;
      case 'clinical.finding_struck': add(key('chart_findings', p.strikeId), e); break;
      case 'clinical.plan_item_created': add(key('treatment_plan_items', e.entity_id), e); break;
      case 'clinical.plan_item_status': add(key('plan_item_events', `${e.entity_id}#${String(p.seq)}`), e); break;
      case 'medical.alert_recorded': case 'medical.alert_revised': add(key('medical_alerts', e.entity_id), e); break;
      case 'medical.history_reviewed': add(key('medical_history_reviews', e.entity_id), e); break;
      case 'medical.alerts_acknowledged': add(key('alert_acknowledgements', p.acknowledgementId), e); break;
      case 'care.site_amended': add(key('care_site_amendments', p.amendmentId), e); break;
    }
  }
  const seen = new Set<string>();
  const iso = (v: unknown) => v === null || v === undefined ? null : new Date(String(v)).toISOString();
  const check = (table: string, id: string, rowKey: string, pairs: (ev: Ev) => Array<[string, unknown, unknown]>) => {
    seen.add(rowKey);
    const ev = byRow.get(rowKey) ?? [];
    if (!ev.length) { out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${table} ${id} has no audit event (written around the application?)`, refs: { table, id } }); return; }
    if (ev.length > 1) out.push({ check: 'DUPLICATE_AUDIT_EVENT', severity: 'MEDIUM', detail: `${table} ${id} has ${ev.length} creation events; expected exactly one.`, refs: { table, id, count: ev.length } });
    for (const [field, recorded, audited] of pairs(ev[0]!)) {
      if (!same(recorded, audited)) out.push({ check: 'CLINICAL_AUDIT_VALUE_MISMATCH', severity: 'HIGH',
        detail: `${table} ${id}: ${field} is ${JSON.stringify(recorded)} but the audit event recorded ${JSON.stringify(audited)}. ${NEUTRAL}`, refs: { table, id, field, recorded, audited } });
    }
  };
  const site = (v: unknown) => (v ?? {}) as { toothFdi?: unknown; surfaces?: unknown };

  type Note = { id: string; patient_id: string; visit_id: string; kind: string; parent_note_id: string | null; subjective: string | null; objective: string | null;
    assessment: string | null; plan: string | null; effective_at: string; reason: string | null; content_sha256: string; signed_by: string };
  for (const r of (await tx.query<Note>(`SELECT id, patient_id, visit_id, kind, parent_note_id, subjective, objective, assessment, plan, effective_at, reason, content_sha256, signed_by
      FROM clinical_notes WHERE clinic_id = $1`, [clinicId])).rows) {
    const recomputed = noteHash({ kind: r.kind, patientId: r.patient_id, visitId: r.visit_id, parentNoteId: r.parent_note_id, effectiveAt: r.effective_at, reason: r.reason,
      subjective: r.subjective, objective: r.objective, assessment: r.assessment, plan: r.plan });
    if (recomputed !== r.content_sha256) out.push({ check: 'CLINICAL_NOTE_CONTENT_HASH_MISMATCH', severity: 'HIGH',
      detail: `clinical_notes ${r.id}: the signed content no longer matches its stored content hash. ${NEUTRAL}`, refs: { table: 'clinical_notes', id: r.id } });
    check('clinical_notes', r.id, key('clinical_notes', r.id), e => [['contentSha256', r.content_sha256, e.payload.contentSha256], ['kind', r.kind, e.payload.kind],
      ['visitId', r.visit_id, e.payload.visitId], ['parentNoteId', r.parent_note_id, e.payload.parentNoteId], ['effectiveAt', iso(r.effective_at), iso(e.payload.effectiveAt)], ['signedBy', r.signed_by, e.actor]]);
  }
  type Finding = { id: string; visit_id: string; kind: string; entered_in_error_of_id: string | null; tooth_fdi: number | null; area_code: number | null; surfaces: string | null; condition_code: string | null; note: string | null; recorded_by: string };
  for (const r of (await tx.query<Finding>('SELECT id, visit_id, kind, entered_in_error_of_id, tooth_fdi, area_code, surfaces, condition_code, note, recorded_by FROM chart_findings WHERE clinic_id = $1', [clinicId])).rows) {
    if (r.kind === 'ENTERED_IN_ERROR') {
      check('chart_findings', r.id, key('chart_findings', r.id), () => []);
      continue;
    }
    check('chart_findings', r.id, key('chart_findings', r.id), e => [['visitId', r.visit_id, e.payload.visitId], ['kind', r.kind, e.payload.kind], ['toothFdi', r.tooth_fdi, e.payload.toothFdi],
      ['areaCode', r.area_code, e.payload.areaCode], ['surfaces', r.surfaces, e.payload.surfaces], ['conditionCode', r.condition_code, e.payload.conditionCode],
      ['hasNote', r.note !== null, e.payload.hasNote], ['recordedBy', r.recorded_by, e.actor]]);
  }
  type Plan = { id: string; patient_id: string; created_in_visit_id: string | null; procedure_code: string; tooth_fdi: number | null; surfaces: string | null; phase_no: number; estimated_fee_millimes: number | null; created_by: string };
  for (const r of (await tx.query<Plan>('SELECT id, patient_id, created_in_visit_id, procedure_code, tooth_fdi, surfaces, phase_no, estimated_fee_millimes, created_by FROM treatment_plan_items WHERE clinic_id = $1', [clinicId])).rows) {
    check('treatment_plan_items', r.id, key('treatment_plan_items', r.id), e => [['patientId', r.patient_id, e.payload.patientId], ['visitId', r.created_in_visit_id, e.payload.visitId],
      ['procedureCode', r.procedure_code, e.payload.procedureCode], ['toothFdi', r.tooth_fdi, e.payload.toothFdi], ['surfaces', r.surfaces, e.payload.surfaces], ['phaseNo', r.phase_no, e.payload.phaseNo],
      ['estimatedFeeMillimes', r.estimated_fee_millimes, e.payload.estimatedFeeMillimes], ['createdBy', r.created_by, e.actor]]);
  }
  type PlanEvent = { id: string; plan_item_id: string; seq: number; status: string; care_item_id: string | null; by_staff_id: string };
  for (const r of (await tx.query<PlanEvent>('SELECT id, plan_item_id, seq, status, care_item_id, by_staff_id FROM plan_item_events WHERE clinic_id = $1', [clinicId])).rows) {
    check('plan_item_events', r.id, key('plan_item_events', `${r.plan_item_id}#${r.seq}`), e => [['status', r.status, e.payload.to], ['careItemId', r.care_item_id, e.payload.careItemId], ['byStaffId', r.by_staff_id, e.actor]]);
  }
  type Alert = { id: string; patient_id: string; chain_id: string; revision: number; code: string; severity: string; source: string; status: string; recorded_by: string };
  for (const r of (await tx.query<Alert>('SELECT id, patient_id, chain_id, revision, code, severity, source, status, recorded_by FROM medical_alerts WHERE clinic_id = $1', [clinicId])).rows) {
    check('medical_alerts', r.id, key('medical_alerts', r.id), e => [['patientId', r.patient_id, e.payload.patientId], ['chainId', r.chain_id, e.payload.chainId], ['revision', r.revision, e.payload.revision],
      ['severity', r.severity, e.payload.severity], ['recordedBy', r.recorded_by, e.actor],
      ...(e.action === 'medical.alert_recorded' ? [['code', r.code, e.payload.code], ['source', r.source, e.payload.source]] as Array<[string, unknown, unknown]> : [['status', r.status, e.payload.status]] as Array<[string, unknown, unknown]>)]);
  }
  type Review = { id: string; patient_id: string; visit_id: string | null; method: string; no_known_allergies: boolean; alert_set_sha256: string; next_review_due: string; note: string | null; reviewed_by: string };
  for (const r of (await tx.query<Review>('SELECT id, patient_id, visit_id, method, no_known_allergies, alert_set_sha256, next_review_due::text AS next_review_due, note, reviewed_by FROM medical_history_reviews WHERE clinic_id = $1', [clinicId])).rows) {
    check('medical_history_reviews', r.id, key('medical_history_reviews', r.id), e => [['patientId', r.patient_id, e.payload.patientId], ['visitId', r.visit_id, e.payload.visitId], ['method', r.method, e.payload.method],
      ['noKnownAllergies', r.no_known_allergies, e.payload.noKnownAllergies], ['alertSetHash', r.alert_set_sha256, e.payload.alertSetHash], ['nextReviewDue', r.next_review_due, e.payload.nextReviewDue],
      ['hasNote', r.note !== null, e.payload.hasNote], ['reviewedBy', r.reviewed_by, e.actor]]);
  }
  type Ack = { id: string; visit_id: string; alert_set_sha256: string; active_alert_count: number; via: string; acknowledged_by: string };
  const ackEntity = new Map(evRows.filter(e => e.action === 'medical.alerts_acknowledged').map(e => [String(e.payload.acknowledgementId), e.entity_id]));
  for (const r of (await tx.query<Ack>('SELECT id, visit_id, alert_set_sha256, active_alert_count, via, acknowledged_by FROM alert_acknowledgements WHERE clinic_id = $1', [clinicId])).rows) {
    check('alert_acknowledgements', r.id, key('alert_acknowledgements', r.id), e => [['visitId', r.visit_id, ackEntity.get(r.id)], ['alertSetHash', r.alert_set_sha256, e.payload.alertSetHash],
      ['activeAlertCount', r.active_alert_count, e.payload.activeAlertCount], ['via', r.via, e.payload.via], ['acknowledgedBy', r.acknowledged_by, e.actor]]);
  }
  type Amend = { id: string; care_item_id: string; supersedes_id: string | null; previous_tooth_fdi: number | null; previous_surfaces: string | null; tooth_fdi: number | null; surfaces: string | null; reason_code: string; reason_note: string | null; amended_by: string };
  const amendEntity = new Map(evRows.filter(e => e.action === 'care.site_amended').map(e => [String(e.payload.amendmentId), e.entity_id]));
  for (const r of (await tx.query<Amend>('SELECT id, care_item_id, supersedes_id, previous_tooth_fdi, previous_surfaces, tooth_fdi, surfaces, reason_code, reason_note, amended_by FROM care_site_amendments WHERE clinic_id = $1', [clinicId])).rows) {
    check('care_site_amendments', r.id, key('care_site_amendments', r.id), e => [['careItemId', r.care_item_id, amendEntity.get(r.id)], ['supersedesId', r.supersedes_id, e.payload.supersedesId],
      ['previousToothFdi', r.previous_tooth_fdi, site(e.payload.previousSite).toothFdi], ['previousSurfaces', r.previous_surfaces, site(e.payload.previousSite).surfaces],
      ['toothFdi', r.tooth_fdi, site(e.payload.newSite).toothFdi], ['surfaces', r.surfaces, site(e.payload.newSite).surfaces], ['reasonCode', r.reason_code, e.payload.reasonCode],
      ['hasNote', r.reason_note !== null, e.payload.hasNote], ['amendedBy', r.amended_by, e.actor]]);
  }
  for (const k of byRow.keys()) {
    if (seen.has(k)) continue;
    const [table, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
    out.push({ check: 'AUDITED_ROW_MISSING', severity: 'HIGH', detail: `An audit event records ${table} ${id}, but the row no longer exists. ${NEUTRAL}`, refs: { table, id } });
  }
  return out;
}
