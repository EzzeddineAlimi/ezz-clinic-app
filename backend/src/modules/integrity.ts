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
import { canonicalJson, sha256, sha256OrNull } from '../platform/canonical.ts';
import { verifyChain, type Anchor } from './audit.ts';
import { noteHash } from './clinical.ts';
import { expectedCash } from './cash.ts';

export interface IntegrityFinding { check: string; severity: 'HIGH' | 'MEDIUM'; detail: string; refs?: unknown }

async function tableExists(tx: Tx, name: string) {
  return (await tx.one<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [name])).ok;
}

export async function integrityCheck(tx: Tx, clinicId: string, anchors: Anchor[] = []) {
  const findings: IntegrityFinding[] = [];
  const nums = (await tx.query<{ number: number }>("SELECT number FROM receipts WHERE clinic_id = $1 AND series = 'R' ORDER BY number", [clinicId])).rows.map(r => r.number);
  const missing: number[] = [];
  let expect = 1;
  for (const n of nums) { while (expect < n) missing.push(expect++); expect = n + 1; }
  if (missing.length) findings.push({ check: 'RECEIPT_NUMBER_GAP', severity: 'HIGH', detail: `Receipt numbers missing from the series: ${missing.slice(0, 20).map(n => 'R-' + String(n).padStart(6, '0')).join(', ')}${missing.length > 20 ? '…' : ''}`, refs: { missingCount: missing.length, missing: missing.slice(0, 200) } });
  const counter = await tx.maybeOne<{ next_number: number }>("SELECT next_number FROM receipt_counters WHERE clinic_id = $1 AND series = 'R'", [clinicId]);
  const max = nums.length ? nums[nums.length - 1]! : 0;
  if (counter && counter.next_number !== max + 1) findings.push({ check: 'RECEIPT_COUNTER_DRIFT', severity: 'HIGH', detail: `Counter says next is ${counter.next_number}, highest issued is ${max}` });

  const noReceipt = (await tx.query<{ id: string }>("SELECT p.id FROM payments p LEFT JOIN receipts r ON r.clinic_id = p.clinic_id AND r.payment_id = p.id WHERE p.clinic_id = $1 AND p.source = 'DESK' AND r.id IS NULL", [clinicId])).rows;
  if (noReceipt.length) findings.push({ check: 'PAYMENT_WITHOUT_RECEIPT', severity: 'HIGH', detail: `${noReceipt.length} desk payment(s) have no receipt`, refs: noReceipt.map(r => r.id) });

  const audited: [string, string, string][] = [
    ['payments', 'payment', 'payment.recorded'],
    ['care_items', 'care_item', 'care.%'],
    ['adjustments', 'adjustment', '%'],
  ];
  for (const [table, entity, actionLike] of audited) {
    const rows = (await tx.query<{ id: string }>(`SELECT t.id FROM ${table} t WHERE t.clinic_id = $3 AND NOT EXISTS (
        SELECT 1 FROM audit_events e WHERE e.clinic_id = $3 AND e.entity_type = $1 AND e.entity_id = t.id::text AND e.action LIKE $2)`, [entity, actionLike, clinicId])).rows;
    if (rows.length) findings.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${rows.length} ${table} row(s) have no audit event (written around the application?)`, refs: rows.map(r => r.id) });
  }
  const orphanEvents = (await tx.query<{ entity_id: string }>(`SELECT e.entity_id FROM audit_events e WHERE e.clinic_id = $1 AND e.action = 'payment.recorded'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.clinic_id = $1 AND p.id::text = e.entity_id)`, [clinicId])).rows;
  if (orphanEvents.length) findings.push({ check: 'AUDITED_PAYMENT_MISSING', severity: 'HIGH', detail: `${orphanEvents.length} audited payment(s) no longer exist in the payments table`, refs: orphanEvents.map(r => r.entity_id) });

  if (await tableExists(tx, 'cash_counts')) {
    const noAudit = (await tx.query<{ id: string }>(`SELECT c.id FROM cash_counts c WHERE c.clinic_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.clinic_id = $1 AND e.entity_type = 'cash_count' AND e.entity_id = c.id::text)`, [clinicId])).rows;
    if (noAudit.length) findings.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `${noAudit.length} cash count(s) have no audit event`, refs: noAudit.map(r => r.id) });
  }

  findings.push(...await businessValueFindings(tx, clinicId, await tableExists(tx, 'cash_counts')));
  if (await tableExists(tx, 'clinical_notes')) findings.push(...await clinicalValueFindings(tx, clinicId));
  if (await tableExists(tx, 'clinic_setting_changes')) findings.push(...await settingValueFindings(tx, clinicId));
  if (await tableExists(tx, 'patient_documents')) findings.push(...await documentValueFindings(tx, clinicId));
  if (await tableExists(tx, 'stock_movements')) findings.push(...await labStockFindings(tx, clinicId));

  const chain = await verifyChain(tx, clinicId, anchors);
  for (const f of chain.findings) findings.push({ check: 'AUDIT_' + f.kind, severity: 'HIGH', detail: `seq ${f.seq}: ${f.detail}` });
  // R73-A tripwire: the database's own copies of owner checkpoints must still match the chain. A rewrite that also
  // fixes these copies is NOT caught here; only the owner's outside copy catches that (POST /owner/checkpoints/verify).
  const cps = (await tx.query<{ seq: number; hash: string; chain_hash: string | null }>(
    'SELECT c.seq, c.hash, e.hash AS chain_hash FROM audit_checkpoints c LEFT JOIN audit_events e ON e.clinic_id = c.clinic_id AND e.seq = c.seq WHERE c.clinic_id = $1 ORDER BY c.seq', [clinicId])).rows;
  for (const c of cps.filter(c => c.chain_hash !== c.hash)) {
    findings.push({ check: 'INTERNAL_CHECKPOINT_MISMATCH', severity: 'HIGH', refs: { seq: Number(c.seq), internalCopy: c.chain_hash === null ? 'CHAIN_SHORTER' : 'DIFFERS' },
      detail: `The database's own copy of the owner checkpoint at seq ${c.seq} no longer matches the audit chain (history rewritten or shortened after it). Compare with the owner's outside copy; this does not by itself show who changed it.` });
  }
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

/**
 * R73-H (M-267, CH-033/CH-034): events written before R73-H carry no exact row timestamps; for them a row timestamp
 * is compared with the hashed occurredAt of its audit event within this tolerance. New events carry the exact value.
 */
export const LEGACY_TIME_TOLERANCE_MS = 120_000;

type Ev = { action: string; payload: Record<string, unknown>; actor: string | null; at?: string };
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

export async function businessValueFindings(tx: Tx, clinicId: string, withCash = true): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const evRows = (await tx.query<{ action: string; entity_type: string; entity_id: string; payload: Record<string, unknown>; actor_staff_id: string | null; occurred_at: string }>(
    `SELECT action, entity_type, entity_id, payload, actor_staff_id, occurred_at FROM audit_events WHERE clinic_id = $1 AND action IN
      ('payment.recorded','payment.refunded','payment.voided','adjustment.created','care.confirmed','care.corrected','cash.count_submitted','cash.movement_recorded',
       'cash.period_opened','cash.period_closed')
     ORDER BY seq`, [clinicId])).rows;
  const events = new Map<string, Ev[]>();
  for (const e of evRows) {
    const k = `${e.entity_type}:${e.entity_id}`;
    (events.get(k) ?? events.set(k, []).get(k)!).push({ action: e.action, payload: e.payload, actor: e.actor_staff_id, at: e.occurred_at });
  }
  const one = (entity: string, id: string, actions: string[]) => (events.get(`${entity}:${id}`) ?? []).filter(e => actions.includes(e.action));
  const mismatch = (check: string, table: string, id: string, field: string, recorded: unknown, audited: unknown) =>
    out.push({ check, severity: 'HIGH', detail: `${table} ${id}: ${field} is ${JSON.stringify(recorded)} but the audit event recorded ${JSON.stringify(audited)}. ${NEUTRAL}`, refs: { table, id, field, recorded, audited } });
  const duplicate = (table: string, id: string, count: number) =>
    out.push({ check: 'DUPLICATE_AUDIT_EVENT', severity: 'MEDIUM', detail: `${table} ${id} has ${count} creation events; expected exactly one.`, refs: { table, id, count } });
  const compare = (check: string, table: string, id: string, pairs: Array<[string, unknown, unknown]>) => {
    for (const [field, recorded, audited] of pairs) if (!same(recorded, audited)) mismatch(check, table, id, field, recorded, audited);
  };
  /** Exact when the event anchored the value (R73-H), else within LEGACY_TIME_TOLERANCE_MS of the event's own time. */
  const compareTime = (check: string, table: string, id: string, field: string, recorded: string, e: Ev) => {
    const anchored = e.payload[field];
    if (typeof anchored === 'string') { if (Date.parse(anchored) !== Date.parse(recorded)) mismatch(check, table, id, field, recorded, anchored); return; }
    if (e.at && Math.abs(Date.parse(recorded) - Date.parse(e.at)) > LEGACY_TIME_TOLERANCE_MS) mismatch(check, table, id, field, recorded, `around ${e.at} (event time; pre-R73-H event)`);
  };
  /** A hash is compared only when the event carried it (events before R73-H did not). Free text never appears in findings. */
  const compareHash = (check: string, table: string, id: string, field: string, recordedHash: string | null, e: Ev) => {
    if (field in e.payload && !same(recordedHash, e.payload[field])) out.push({ check, severity: 'HIGH',
      detail: `${table} ${id}: ${field} differs from the value anchored in its audit event (content not shown). ${NEUTRAL}`, refs: { table, id, field } });
  };
  const missingRow = (table: string, id: string, what: string) =>
    out.push({ check: 'AUDITED_ROW_MISSING', severity: 'HIGH', detail: `An audit event records ${what} ${id}, but the row no longer exists. ${NEUTRAL}`, refs: { table, id } });

  // V1 payments (R73-H: recorded_at decides which count window a cash payment falls in, so it is compared too)
  const payments = (await tx.query<{ id: string; amount_millimes: number; tender: string; source: string; visit_id: string; cash_period_id: string | null; recorded_by: string; recorded_at: string }>(
    'SELECT id, amount_millimes, tender, source, visit_id, cash_period_id, recorded_by, recorded_at FROM payments WHERE clinic_id = $1', [clinicId])).rows;
  const auditedPayment = new Map<string, Record<string, unknown>>();
  const paymentVisit = new Map(payments.map(p => [p.id, p.visit_id]));
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
    compareTime('PAYMENT_AUDIT_VALUE_MISMATCH', 'payments', p.id, 'recordedAt', p.recorded_at, ev[0]!);
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

  // V5 adjustments (kind <-> action, amount, references; R73-H: time, refund/void visit, note by hash)
  const adjustments = (await tx.query<{ id: string; kind: string; amount_millimes: number; reason_code: string; reason_note: string | null; visit_id: string; payment_id: string | null; tender: string | null; authorized_by: string; created_at: string }>(
    'SELECT id, kind, amount_millimes, reason_code, reason_note, visit_id, payment_id, tender, authorized_by, created_at FROM adjustments WHERE clinic_id = $1', [clinicId])).rows;
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
    else {
      pairs.push(['paymentId', j.payment_id, a.paymentId]);
      // A refund/void belongs to its payment's visit; compared with the anchored value, or with the payment row before R73-H.
      pairs.push(['visitId', j.visit_id, 'visitId' in a ? a.visitId : (j.payment_id ? paymentVisit.get(j.payment_id) ?? null : null)]);
    }
    if (e.action === 'payment.refunded') pairs.push(['tender', j.tender, a.tender]);
    compare('ADJUSTMENT_AUDIT_VALUE_MISMATCH', 'adjustments', j.id, pairs);
    compareTime('ADJUSTMENT_AUDIT_VALUE_MISMATCH', 'adjustments', j.id, 'createdAt', j.created_at, e);
    compareHash('ADJUSTMENT_AUDIT_VALUE_MISMATCH', 'adjustments', j.id, 'reasonNoteSha256', sha256OrNull(j.reason_note), e);
  }

  // V3/V4 receipts: snapshot integrity, then snapshot and number vs the audited operation; R73-H: the whole snapshot
  // is anchored by its hash in the operation's audit event, so editing ANY field and recomputing the hash is visible.
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
      ...(audited && typeof audited.receiptSha256 === 'string' ? [['snapshotSha256', r.snapshot_sha256, audited.receiptSha256] as [string, unknown, unknown]] : []),
    ]);
  }

  // V6 care fees and corrections (R73-H: correction procedure/site and the care reason by hash)
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
      compareHash('CARE_AUDIT_VALUE_MISMATCH', 'care_items', c.id, 'reasonSha256', sha256OrNull(c.reason), e);
    } else {
      compare('CARE_AUDIT_VALUE_MISMATCH', 'care_items', c.id, [['kind', c.kind, 'CORRECTION'], ['feeMillimes', c.fee_millimes, a.deltaMillimes], ['correctsId', c.corrects_id, a.correctsId], ['reason', c.reason, a.reason],
        ...('procedureCode' in a ? [['procedureCode', c.procedure_code, a.procedureCode], ['toothFdi', c.tooth_fdi, a.toothFdi], ['surfaces', c.surfaces, a.surfaces]] as Array<[string, unknown, unknown]> : [])]);
    }
  }

  // V7 cash: periods, counts and movements vs audit; stored expected cash vs a recomputation from the append-only
  // records at the same cut-off. R73-H (M-267 1, CH-034): every INPUT of that recomputation (period float and start,
  // count time, payment/movement/refund times) is itself compared, so editing inputs and expected together is visible.
  const present = new Set([...adjustments.map(r => `adjustment:${r.id}`), ...care.map(r => `care_item:${r.id}`)]);
  if (withCash) {
    const periods = (await tx.query<{ id: string; period_no: number; opened_at: string; opening_float_millimes: number; opening_basis: string; previous_period_id: string | null; status: string; cutoff_at: string | null; drawer_id: string }>(
      'SELECT id, period_no, opened_at, opening_float_millimes, opening_basis, previous_period_id, status, cutoff_at, drawer_id FROM cash_periods WHERE clinic_id = $1', [clinicId])).rows;
    const periodById = new Map(periods.map(p => [p.id, p]));
    for (const p of periods) {
      present.add(`cash_period:${p.id}`);
      if (p.opening_basis === 'OWNER_DECLARED') {
        const ev = one('cash_period', p.id, ['cash.period_opened']);
        if (!ev.length) { out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `cash_periods ${p.id} has no opening audit event`, refs: { table: 'cash_periods', id: p.id } }); continue; }
        compare('CASH_PERIOD_AUDIT_VALUE_MISMATCH', 'cash_periods', p.id, [['openingFloatMillimes', p.opening_float_millimes, ev[0]!.payload.openingFloatMillimes], ['periodNo', p.period_no, ev[0]!.payload.periodNo]]);
        compareTime('CASH_PERIOD_AUDIT_VALUE_MISMATCH', 'cash_periods', p.id, 'openedAt', p.opened_at, ev[0]!);
      } else {
        // Carry-forward: there is no opening event; the float and start come from the previous period's close event.
        const closed = p.previous_period_id ? one('cash_period', p.previous_period_id, ['cash.period_closed']).find(e => e.payload.nextPeriodId === p.id) : undefined;
        if (!closed) { out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `cash_periods ${p.id} (carried forward) has no matching close event of its previous period`, refs: { table: 'cash_periods', id: p.id } }); continue; }
        compare('CASH_PERIOD_AUDIT_VALUE_MISMATCH', 'cash_periods', p.id, [['openingFloatMillimes', p.opening_float_millimes, closed.payload.nextOpeningFloatMillimes]]);
        if (typeof closed.payload.nextOpenedAt === 'string' && Date.parse(closed.payload.nextOpenedAt) !== Date.parse(p.opened_at))
          mismatch('CASH_PERIOD_AUDIT_VALUE_MISMATCH', 'cash_periods', p.id, 'openedAt', p.opened_at, closed.payload.nextOpenedAt);
      }
    }
    const counts = (await tx.query<{ id: string; period_id: string; attempt_no: number; counted_millimes: number; expected_millimes: number; submitted_at: string; denominations: Record<string, number> | null }>(
      'SELECT id, period_id, attempt_no, counted_millimes, expected_millimes, submitted_at, denominations FROM cash_counts WHERE clinic_id = $1', [clinicId])).rows;
    for (const c of counts) {
      const ev = one('cash_count', c.id, ['cash.count_submitted']);
      if (ev.length) {
        compare('CASH_COUNT_AUDIT_VALUE_MISMATCH', 'cash_counts', c.id, [['countedMillimes', c.counted_millimes, ev[0]!.payload.countedMillimes], ['periodId', c.period_id, ev[0]!.payload.periodId], ['attemptNo', c.attempt_no, ev[0]!.payload.attemptNo]]);
        compareTime('CASH_COUNT_AUDIT_VALUE_MISMATCH', 'cash_counts', c.id, 'submittedAt', c.submitted_at, ev[0]!);
        compareHash('CASH_COUNT_AUDIT_VALUE_MISMATCH', 'cash_counts', c.id, 'denominationsSha256', c.denominations === null ? null : sha256(canonicalJson(c.denominations)), ev[0]!);
      }
      // M-267 6: a deleted period is a finding, never an aborted check.
      const period = periodById.get(c.period_id);
      if (!period) { if (!out.some(f => f.check === 'AUDITED_ROW_MISSING' && (f.refs as { id?: string } | undefined)?.id === c.period_id)) missingRow('cash_periods', c.period_id, 'cash period'); continue; }
      const recomputed = (await expectedCash(tx, period as never, c.submitted_at)).expectedMillimes;
      if (recomputed !== c.expected_millimes) {
        out.push({ check: 'CASH_COUNT_EXPECTED_RECOMPUTE_MISMATCH', severity: 'HIGH',
          detail: `Cash count ${c.id}: the stored expected cash (${c.expected_millimes}) differs from a recomputation from recorded payments, movements and refunds up to the same cut-off (${recomputed}). ${NEUTRAL}`,
          refs: { table: 'cash_counts', id: c.id, storedExpected: c.expected_millimes, recomputedExpected: recomputed } });
      }
      present.add(`cash_count:${c.id}`);
    }
    const moves = (await tx.query<{ id: string; period_id: string; kind: string; amount_millimes: number; voucher_ref: string | null; recorded_at: string }>(
      'SELECT id, period_id, kind, amount_millimes, voucher_ref, recorded_at FROM cash_movements WHERE clinic_id = $1', [clinicId])).rows;
    for (const m of moves) {
      present.add(`cash_movement:${m.id}`);
      const ev = one('cash_movement', m.id, ['cash.movement_recorded']);
      if (!ev.length) continue;
      compare('CASH_MOVEMENT_AUDIT_VALUE_MISMATCH', 'cash_movements', m.id, [['amountMillimes', m.amount_millimes, ev[0]!.payload.amountMillimes], ['kind', m.kind, ev[0]!.payload.kind], ['periodId', m.period_id, ev[0]!.payload.periodId], ['voucherRef', m.voucher_ref, ev[0]!.payload.voucherRef]]);
      compareTime('CASH_MOVEMENT_AUDIT_VALUE_MISMATCH', 'cash_movements', m.id, 'recordedAt', m.recorded_at, ev[0]!);
    }
  }

  // Audited rows that no longer exist (payments keep their original AUDITED_PAYMENT_MISSING check).
  const TABLE: Record<string, string> = { adjustment: 'adjustments', care_item: 'care_items', cash_count: 'cash_counts', cash_movement: 'cash_movements', cash_period: 'cash_periods' };
  for (const k of events.keys()) {
    const [entity, id] = k.split(':') as [string, string];
    if (!TABLE[entity] || (!withCash && entity.startsWith('cash_'))) continue;
    if (!present.has(k) && !out.some(f => f.check === 'AUDITED_ROW_MISSING' && (f.refs as { id?: string } | undefined)?.id === id)) missingRow(TABLE[entity]!, id, entity.replace('_', ' '));
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

/*
 * R73-C: clinic setting changes vs their audit events. A setting decides how days, reminders and flags are computed
 * (e.g. the timezone shifts every day boundary), so a silent edit is reported like any other value mismatch.
 */
export async function settingValueFindings(tx: Tx, clinicId: string): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const ev = new Map((await tx.query<{ entity_id: string; payload: Record<string, unknown>; actor_staff_id: string | null }>(
    "SELECT entity_id, payload, actor_staff_id FROM audit_events WHERE clinic_id = $1 AND action = 'clinic.setting_changed'", [clinicId])).rows.map(e => [e.entity_id, e]));
  const KEY: Record<string, string> = { timezone: 'timezone', checkpoint_due_days: 'checkpointDueDays', not_arrived_grace_minutes: 'notArrivedGraceMinutes', lab_unbilled_days: 'labUnbilledDays' };
  const rows = (await tx.query<{ id: string; key: string; value: unknown; previous: unknown; changed_by: string }>(
    'SELECT id, key, value, previous, changed_by FROM clinic_setting_changes WHERE clinic_id = $1', [clinicId])).rows;
  for (const r of rows) {
    const e = ev.get(r.id);
    if (!e) { out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `clinic_setting_changes ${r.id} has no audit event (written around the application?)`, refs: { table: 'clinic_setting_changes', id: r.id } }); continue; }
    ev.delete(r.id);
    for (const [field, recorded, audited] of [['key', KEY[r.key] ?? r.key, e.payload.key], ['to', r.value, e.payload.to], ['from', r.previous, e.payload.from], ['changedBy', r.changed_by, e.actor_staff_id]] as Array<[string, unknown, unknown]>) {
      if (canonicalJson(recorded ?? null) !== canonicalJson(audited ?? null)) out.push({ check: 'SETTING_AUDIT_VALUE_MISMATCH', severity: 'HIGH',
        detail: `clinic_setting_changes ${r.id}: ${field} is ${JSON.stringify(recorded)} but the audit event recorded ${JSON.stringify(audited)}. ${NEUTRAL}`, refs: { table: 'clinic_setting_changes', id: r.id, field, recorded, audited } });
    }
  }
  for (const id of ev.keys()) out.push({ check: 'AUDITED_ROW_MISSING', severity: 'HIGH', detail: `An audit event records clinic setting change ${id}, but the row no longer exists. ${NEUTRAL}`, refs: { table: 'clinic_setting_changes', id } });
  return out;
}

/**
 * R73-D patient documents: stored bytes still hash to what was recorded (PostgreSQL store), and every document row and
 * stored-content event agrees with its audit event (patient, SHA-256). Bytes in another store are checked on download.
 */
export async function documentValueFindings(tx: Tx, clinicId: string): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const blobs = (await tx.query<{ id: string; recorded: string; actual: string; size_ok: boolean }>(
    `SELECT id, sha256 AS recorded, encode(sha256(content), 'hex') AS actual, octet_length(content) = size_bytes AS size_ok FROM document_blobs WHERE clinic_id = $1`, [clinicId])).rows;
  const blobHash = new Map(blobs.map(b => [b.id, b.recorded]));
  for (const b of blobs) if (b.recorded !== b.actual || !b.size_ok) out.push({ check: 'DOCUMENT_CONTENT_MISMATCH', severity: 'HIGH',
    detail: `Stored document bytes ${b.id} no longer hash to the recorded SHA-256. ${NEUTRAL}`, refs: { table: 'document_blobs', id: b.id } });
  const audit = new Map<string, Record<string, unknown>>();
  for (const e of (await tx.query<{ action: string; entity_id: string; payload: Record<string, unknown> }>(
    "SELECT action, entity_id, payload FROM audit_events WHERE clinic_id = $1 AND action IN ('document.created', 'document.reassigned', 'document.content_stored')", [clinicId])).rows)
    audit.set(e.action + ':' + e.entity_id, e.payload);
  const docs = (await tx.query<{ id: string; patient_id: string; reassigned_from_id: string | null }>('SELECT id, patient_id, reassigned_from_id FROM patient_documents WHERE clinic_id = $1', [clinicId])).rows;
  for (const d of docs) {
    const e = audit.get((d.reassigned_from_id ? 'document.reassigned:' : 'document.created:') + d.id);
    if (!e) { out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `patient_documents ${d.id} has no audit event (written around the application?)`, refs: { table: 'patient_documents', id: d.id } }); continue; }
    if (e.patientId !== d.patient_id) out.push({ check: 'DOCUMENT_AUDIT_VALUE_MISMATCH', severity: 'HIGH',
      detail: `patient_documents ${d.id}: the patient differs from the one recorded in its audit event. ${NEUTRAL}`, refs: { table: 'patient_documents', id: d.id, field: 'patientId' } });
  }
  const stored = (await tx.query<{ document_id: string; blob_ref: string; stored_sha256: string }>(
    "SELECT document_id, blob_ref, stored_sha256 FROM patient_document_events WHERE clinic_id = $1 AND kind = 'CONTENT_STORED'", [clinicId])).rows;
  for (const s of stored) {
    const e = audit.get('document.content_stored:' + s.document_id) ?? audit.get('document.reassigned:' + s.document_id);
    if (!e || e.sha256 !== s.stored_sha256) out.push({ check: 'DOCUMENT_AUDIT_VALUE_MISMATCH', severity: 'HIGH',
      detail: `Document ${s.document_id}: the stored-content SHA-256 differs from the audited one. ${NEUTRAL}`, refs: { table: 'patient_document_events', id: s.document_id, field: 'sha256' } });
    const m = /^pg:(.+)$/.exec(s.blob_ref);
    if (m && blobHash.get(m[1]!) !== s.stored_sha256) out.push({ check: 'DOCUMENT_CONTENT_MISMATCH', severity: 'HIGH',
      detail: `Document ${s.document_id} points to stored bytes that are missing or differ from the recorded SHA-256. ${NEUTRAL}`, refs: { table: 'patient_document_events', id: s.document_id } });
  }
  return out;
}

/**
 * R73-E lab and stock: the stock ledger's stored running totals and per-item sequence are recomputed, and stock
 * movements, lab status events and lab invoices are compared with their audit events.
 */
export async function labStockFindings(tx: Tx, clinicId: string): Promise<IntegrityFinding[]> {
  const out: IntegrityFinding[] = [];
  const moves = (await tx.query<{ id: string; item_id: string; seq: number; kind: string; quantity: number; on_hand_after: number }>(
    'SELECT id, item_id, seq, kind, quantity, on_hand_after FROM stock_movements WHERE clinic_id = $1 ORDER BY item_id, seq', [clinicId])).rows;
  const audits = new Map((await tx.query<{ entity_id: string; payload: Record<string, unknown> }>(
    "SELECT entity_id, payload FROM audit_events WHERE clinic_id = $1 AND action = 'stock.movement'", [clinicId])).rows.map(e => [e.entity_id, e.payload]));
  const running = new Map<string, { total: number; seq: number }>();
  for (const m of moves) {
    const r = running.get(m.item_id) ?? { total: 0, seq: 0 };
    r.total += m.quantity; r.seq += 1;
    if (m.seq !== r.seq || m.on_hand_after !== r.total) out.push({ check: 'STOCK_LEDGER_INCONSISTENT', severity: 'HIGH',
      detail: `Stock movement ${m.id}: recorded on-hand ${m.on_hand_after} (seq ${m.seq}) but recomputation gives ${r.total} (seq ${r.seq}). ${NEUTRAL}`, refs: { table: 'stock_movements', id: m.id } });
    r.total = m.on_hand_after; r.seq = m.seq; // report each break once, not every later row
    running.set(m.item_id, r);
    const e = audits.get(m.id);
    if (!e) out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `stock_movements ${m.id} has no audit event (written around the application?)`, refs: { table: 'stock_movements', id: m.id } });
    else if (e.quantity !== m.quantity || e.kind !== m.kind) out.push({ check: 'STOCK_AUDIT_VALUE_MISMATCH', severity: 'HIGH',
      detail: `Stock movement ${m.id}: ${m.kind} ${m.quantity} differs from its audit event (${String(e.kind)} ${String(e.quantity)}). ${NEUTRAL}`, refs: { table: 'stock_movements', id: m.id } });
  }
  const labAudit = new Set((await tx.query<{ k: string }>(
    "SELECT entity_id::text || ':' || (payload->>'seq') || ':' || (payload->>'to') AS k FROM audit_events WHERE clinic_id = $1 AND action = 'lab.case_status'", [clinicId])).rows.map(r => r.k));
  for (const e of (await tx.query<{ id: string; k: string }>("SELECT id, case_id::text || ':' || seq || ':' || status AS k FROM lab_case_events WHERE clinic_id = $1", [clinicId])).rows)
    if (!labAudit.has(e.k)) out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `lab_case_events ${e.id} has no matching audit event (status or sequence differs, or written around the application)`, refs: { table: 'lab_case_events', id: e.id } });
  const inv = new Map((await tx.query<{ entity_id: string; payload: Record<string, unknown> }>(
    "SELECT entity_id, payload FROM audit_events WHERE clinic_id = $1 AND action = 'lab.invoice_recorded'", [clinicId])).rows.map(e => [e.entity_id, e.payload]));
  for (const i of (await tx.query<{ id: string; amount_millimes: number }>('SELECT id, amount_millimes FROM lab_invoices WHERE clinic_id = $1', [clinicId])).rows) {
    const e = inv.get(i.id);
    if (!e) out.push({ check: 'ROW_WITHOUT_AUDIT_EVENT', severity: 'HIGH', detail: `lab_invoices ${i.id} has no audit event`, refs: { table: 'lab_invoices', id: i.id } });
    else if (e.amountMillimes !== i.amount_millimes) out.push({ check: 'LAB_INVOICE_AUDIT_VALUE_MISMATCH', severity: 'HIGH',
      detail: `Lab invoice ${i.id}: amount ${i.amount_millimes} differs from the audited ${String(e.amountMillimes)}. ${NEUTRAL}`, refs: { table: 'lab_invoices', id: i.id } });
  }
  return out;
}
