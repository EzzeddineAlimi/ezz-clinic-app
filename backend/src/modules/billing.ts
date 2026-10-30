/*
 * BILLING module: payments, allocations, gap-free receipts, discounts/write-offs, refunds, voids.
 * Owns tables: receipt_counters, payments, payment_allocations, adjustments, receipts, receipt_prints,
 * payment_intents, payment_intent_outcomes, view visit_balances.
 * Depends on: care (read fee totals), patients (visit lock), audit.
 *
 * Rules (C4/C5, CH-015/CH-016, MF16):
 *  - one Idempotency-Key = one payment = one receipt number, even under retries and concurrency;
 *  - payment, allocation, receipt number, receipt snapshot and audit event commit atomically or not at all;
 *  - the visit row is locked FOR UPDATE, so two concurrent payments cannot overpay a balance;
 *  - a card payment is only a DESK CLAIM here; nothing in billing can mark it verified (see card module);
 *  - a near-identical payment (same visit, amount, tender within 2 minutes) needs explicit confirmation;
 *  - discounts/write-offs: dentist or owner only; refunds/voids: owner only, with re-authentication;
 *  - a refund requires an existing credit (so a fee correction or discount by the dentist must come first).
 */
import { advisoryLock, type Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, millimes, oneOf, optStr, str, bool, formatMillimes, isUuid } from '../platform/validate.ts';
import { canonicalJson, sha256, sha256OrNull } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';
import { getVisitForUpdate, getVisit } from './patients.ts';

export const DUPLICATE_WINDOW_SECONDS = 120; // ASSUMPTION (C-139 T-IDEM-3)
const REASON_CODE = /^[A-Z_]{3,40}$/;

export interface Balance { visitId: string; chargedMillimes: number; paidMillimes: number; reducedMillimes: number; returnedMillimes: number; balanceMillimes: number; careConfirmed: boolean }

export async function visitBalance(tx: Tx, visitId: string): Promise<Balance> {
  const b = await tx.one<{ charged_millimes: number; paid_millimes: number; reduced_millimes: number; returned_millimes: number }>(
    'SELECT charged_millimes, paid_millimes, reduced_millimes, returned_millimes FROM visit_balances WHERE visit_id = $1', [visitId]);
  const care = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM care_items WHERE visit_id = $1', [visitId]);
  return {
    visitId,
    chargedMillimes: b.charged_millimes, paidMillimes: b.paid_millimes, reducedMillimes: b.reduced_millimes, returnedMillimes: b.returned_millimes,
    balanceMillimes: b.charged_millimes - b.paid_millimes - b.reduced_millimes + b.returned_millimes,
    careConfirmed: care.n > 0,
  };
}

export const receiptLabel = (series: string, n: number) => `${series}-${String(n).padStart(6, '0')}`;

/** Allocate the next gap-free number in the clinic's series inside the caller's transaction. */
export async function nextReceiptNumber(tx: Tx, clinicId: string, series = 'R'): Promise<number> {
  await tx.query('INSERT INTO receipt_counters (clinic_id, series) VALUES ($1, $2) ON CONFLICT DO NOTHING', [clinicId, series]);
  const c = await tx.one<{ next_number: number }>('SELECT next_number FROM receipt_counters WHERE clinic_id = $1 AND series = $2 FOR UPDATE', [clinicId, series]);
  await tx.query('UPDATE receipt_counters SET next_number = next_number + 1 WHERE clinic_id = $1 AND series = $2', [clinicId, series]);
  return c.next_number;
}

async function receiptContext(tx: Tx, visitId: string) {
  return tx.one<{ clinic_name: string; clinic_code: string; file_no: number; family_name: string; given_name: string; dentist_name: string | null }>(
    `SELECT cl.name AS clinic_name, cl.code AS clinic_code, p.file_no, p.family_name, p.given_name, d.display_name AS dentist_name
       FROM visits v JOIN patients p ON p.id = v.patient_id JOIN clinics cl ON cl.id = v.clinic_id LEFT JOIN staff d ON d.id = v.dentist_id
      WHERE v.id = $1`, [visitId]);
}

export async function issueReceipt(tx: Tx, actor: Actor, kind: 'PAYMENT' | 'REFUND' | 'VOID', ref: { paymentId?: string; adjustmentId?: string },
  visitId: string, content: Record<string, unknown>) {
  const number = await nextReceiptNumber(tx, actor.clinicId);
  const ctx = await receiptContext(tx, visitId);
  const snapshot = {
    notice: 'FICTIONAL DATA — NOT A FISCAL DOCUMENT. Tunisian fee-note / receipt legal requirements UNVERIFIED.',
    series: 'R', number, label: receiptLabel('R', number), kind,
    clinic: { name: ctx.clinic_name, code: ctx.clinic_code },
    payee: ctx.dentist_name ?? ctx.clinic_name,
    patient: { fileNo: ctx.file_no, name: `${ctx.family_name} ${ctx.given_name}` },
    issuedAt: new Date().toISOString(),
    issuedBy: actor.displayName,
    ...content,
  };
  const r = await tx.one<{ id: string }>(`INSERT INTO receipts (clinic_id, series, number, kind, payment_id, adjustment_id, issued_by, snapshot, snapshot_sha256)
      VALUES ($1, 'R', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [actor.clinicId, number, kind, ref.paymentId ?? null, ref.adjustmentId ?? null, actor.staffId, snapshot, sha256(canonicalJson(snapshot))]);
  return { id: r.id, number, label: receiptLabel('R', number), snapshot, sha256: sha256(canonicalJson(snapshot)) };
}

/** R73-H: free text is anchored in audit payloads by hash only (no free-text disclosure decision is made here). */

export function evidenceFor(tender: 'CASH' | 'CARD', source: 'DESK' | 'PAPER_OUTAGE') {
  if (tender === 'CARD') return { tier: 'DESK_CLAIM', label: { fr: 'Carte — déclaration accueil uniquement (non vérifiée)', ar: 'بطاقة — تسجيل الاستقبال فقط (غير مُتحقَّق منه)' }, verifiedBy: null };
  return { tier: source === 'PAPER_OUTAGE' ? 'PAPER_SLIP_RECORD' : 'DESK_RECORD', label: { fr: 'Espèces — vérifiées seulement par un comptage indépendant', ar: 'نقدًا — يُتحقَّق منها فقط بعدّ مستقل' }, verifiedBy: null };
}

/**
 * The open cash period for a CASH movement, or throws. Provided by the cash module and wired by the composition root
 * (app.ts buildRoutes); billing cannot import cash (cash depends on billing). Unwired, CASH fails closed: recording
 * cash outside every drawer count is worse than refusing it (R74 T-WIRE-1).
 */
export type CashPeriodResolver = (tx: Tx, actor: Actor) => Promise<string>;
let cashPeriodResolver: CashPeriodResolver | null = null;
/** Wires the resolver once per process. Re-wiring the same function is harmless; a different one is refused (R75-D). */
export function setCashPeriodResolver(r: CashPeriodResolver) {
  if (cashPeriodResolver && cashPeriodResolver !== r) throw new Error('cash-period resolver is already wired to a different function');
  cashPeriodResolver = r;
}
/** Back to unwired, i.e. CASH fails closed again. Safe direction only; used by tests so they do not depend on import order. */
export function resetCashPeriodResolver() { cashPeriodResolver = null; }
export async function cashPeriodFor(tx: Tx, actor: Actor, tender: string): Promise<string | null> {
  if (tender !== 'CASH') return null;
  if (!cashPeriodResolver) throw new Error('cash-period resolver is not wired: build the app with buildRoutes()');
  return cashPeriodResolver(tx, actor);
}

export interface RecordPaymentInput {
  visitId: string; amountMillimes: number; tender: 'CASH' | 'CARD'; source: 'DESK' | 'PAPER_OUTAGE';
  cardTerminalRef?: string | null; cardLast4?: string | null; confirmDuplicate?: boolean; issueReceipt: boolean;
  paperSlipEntryId?: string | null;
  paymentIntentId?: string;
}

/** Shared by the desk route and the paper-outage import. Caller supplies the transaction. */
export async function recordPayment(tx: Tx, actor: Actor, input: RecordPaymentInput) {
  const v = await getVisitForUpdate(tx, input.visitId);
  const pending = await unresolvedIntent(tx, v.id);
  if (pending && pending.id !== input.paymentIntentId) fail('PAYMENT_INTENT_UNRESOLVED', 'Recover the existing intention before another payment', { intentId: pending.id });
  const bal = await visitBalance(tx, v.id);
  if (!bal.careConfirmed) fail('CARE_NOT_CONFIRMED', 'No dentist-confirmed care for this visit yet; payment cannot be applied');
  if (input.amountMillimes > bal.balanceMillimes) {
    fail('AMOUNT_EXCEEDS_BALANCE', 'Payment exceeds the open balance', { balanceMillimes: bal.balanceMillimes, note: 'Patient credit/deposits are not supported in v0.2 (MF10 later)' });
  }
  if (input.source === 'DESK' && !input.confirmDuplicate) {
    const dup = await tx.maybeOne<{ id: string; recorded_at: string }>(`SELECT id, recorded_at FROM payments WHERE visit_id = $1 AND amount_millimes = $2 AND tender = $3
        AND recorded_at > now() - make_interval(secs => $4) ORDER BY recorded_at DESC LIMIT 1`, [v.id, input.amountMillimes, input.tender, DUPLICATE_WINDOW_SECONDS]);
    if (dup) fail('POSSIBLE_DUPLICATE_PAYMENT', 'An identical payment was recorded moments ago; confirm this is a second payment', { previousPaymentId: dup.id, previousAt: dup.recorded_at, retryWith: { confirmDuplicate: true } });
  }
  const cashPeriodId = await cashPeriodFor(tx, actor, input.tender);
  // recorded_at uses clock_timestamp() AFTER the cash-period share lock, so count cut-offs order correctly.
  const p = await tx.one<{ id: string; recorded_at: string }>(`INSERT INTO payments (clinic_id, patient_id, visit_id, amount_millimes, tender, source, card_terminal_ref, card_last4, cash_period_id, recorded_by, recorded_at${input.paperSlipEntryId ? ', paper_slip_entry_id' : ''})
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, clock_timestamp()${input.paperSlipEntryId ? ', $11' : ''}) RETURNING id, recorded_at`,
    [actor.clinicId, v.patient_id, v.id, input.amountMillimes, input.tender, input.source, input.cardTerminalRef ?? null, input.cardLast4 ?? null, cashPeriodId, actor.staffId, ...(input.paperSlipEntryId ? [input.paperSlipEntryId] : [])]);
  await tx.query('INSERT INTO payment_allocations (clinic_id, payment_id, visit_id, amount_millimes) VALUES ($1,$2,$3,$4)', [actor.clinicId, p.id, v.id, input.amountMillimes]);
  const after = bal.balanceMillimes - input.amountMillimes;
  const evidence = evidenceFor(input.tender, input.source);
  let receipt: { id: string; number: number; label: string; snapshot: unknown; sha256: string } | null = null;
  if (input.issueReceipt) {
    receipt = await issueReceipt(tx, actor, 'PAYMENT', { paymentId: p.id }, v.id, {
      amountMillimes: input.amountMillimes, amountText: formatMillimes(input.amountMillimes), tender: input.tender,
      evidence: evidence.label, chargedMillimes: bal.chargedMillimes, balanceAfterMillimes: after, balanceAfterText: formatMillimes(after), visitId: v.id,
    });
  }
  await appendAudit(tx, actor, 'payment.recorded', 'payment', p.id, {
    visitId: v.id, amountMillimes: input.amountMillimes, tender: input.tender, source: input.source, receiptNumber: receipt?.number ?? null, cashPeriodId, balanceAfterMillimes: after,
    recordedAt: p.recorded_at, receiptSha256: receipt?.sha256 ?? null, // R73-H: anchors the cash-window timestamp and the full receipt snapshot
  });
  return {
    payment: { id: p.id, visitId: v.id, patientId: v.patient_id, amountMillimes: input.amountMillimes, tender: input.tender, source: input.source, recordedAt: p.recorded_at, recordedBy: actor.staffId, cashPeriodId, evidence },
    receipt: receipt ? { id: receipt.id, number: receipt.number, label: receipt.label } : null,
    balanceAfterMillimes: after,
  };
}

async function loadPaymentForUpdate(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Payment not found');
  const p = await tx.maybeOne<{ id: string; visit_id: string; patient_id: string; amount_millimes: number; tender: 'CASH' | 'CARD' }>(
    'SELECT id, visit_id, patient_id, amount_millimes, tender FROM payments WHERE id = $1', [id]);
  if (!p) fail('NOT_FOUND', 'Payment not found');
  await getVisitForUpdate(tx, p!.visit_id);
  return p!;
}

async function returnedOnPayment(tx: Tx, paymentId: string) {
  return tx.one<{ refunded: number; voided: number }>(`SELECT coalesce(sum(amount_millimes) FILTER (WHERE kind = 'REFUND'), 0)::bigint AS refunded,
      coalesce(sum(amount_millimes) FILTER (WHERE kind = 'PAYMENT_VOID'), 0)::bigint AS voided FROM adjustments WHERE payment_id = $1`, [paymentId]);
}

const primaryRole = (actor: Actor, allowed: string[]) => (allowed.find(r => actor.roles.includes(r as never)) ?? actor.roles[0]) as 'OWNER' | 'DENTIST';

interface StoredIntent { id: string; visit_id: string; payload: Record<string, unknown>; ledger_hash: string }
async function unresolvedIntent(tx: Tx, visitId: string) {
  const rows = (await tx.query<{ id: string }>(`SELECT i.id FROM payment_intents i
    WHERE i.visit_id=$1 AND NOT EXISTS (SELECT 1 FROM payment_intent_outcomes o WHERE o.intent_id=i.id)`, [visitId])).rows;
  if (rows.length > 1) fail('PAYMENT_INTENT_UNRESOLVED', 'Multiple unresolved intentions require review');
  return rows[0];
}
async function recoveryState(tx: Tx, visitId: string) {
  const balance = await visitBalance(tx, visitId);
  const ledger = await tx.one<{ care: string[]; payments: string[]; adjustments: string[] }>(`SELECT
    (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM care_items WHERE visit_id=$1) AS care,
    (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM payments WHERE visit_id=$1) AS payments,
    (SELECT coalesce(jsonb_agg(id ORDER BY id),'[]') FROM adjustments WHERE visit_id=$1) AS adjustments`, [visitId]);
  return { balance, recoveryVersion: sha256(canonicalJson({ balance, ledger })), paymentIds: ledger.payments };
}
function deskPayload(body: unknown) {
  const b = asBody(body);
  const amountMillimes = millimes(b, 'amountMillimes');
  const tender = oneOf(b, 'tender', ['CASH','CARD'] as const)!;
  const cardTerminalRef = tender === 'CARD' ? optStr(b, 'cardTerminalRef', { max:40, pattern:/^[A-Za-z0-9-]{1,40}$/ }) : null;
  const cardLast4 = tender === 'CARD' ? optStr(b, 'cardLast4', { max:4, pattern:/^[0-9]{4}$/ }) : null;
  return { amountMillimes, tender, cardTerminalRef, cardLast4, confirmDuplicate:bool(b,'confirmDuplicate') };
}
async function lockedIntent(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND','Payment intention not found');
  const i = await tx.maybeOne<StoredIntent>('SELECT id,visit_id,payload,ledger_hash FROM payment_intents WHERE id=$1',[id]);
  if (!i) fail('NOT_FOUND','Payment intention not found');
  await getVisitForUpdate(tx,i!.visit_id);
  return i!;
}
const recoveryRoutes: Route[] = [
  { method:'GET', path:'/api/v1/visits/:id/payment-recovery', permission:'payment.read', handler:async({tx,params})=>{
    // Same aggregate lock as every billing writer: coherent reads, waits for uncertain commits.
    const v=await getVisitForUpdate(tx,params.id!);
    await unresolvedIntent(tx,v.id);
    const state=await recoveryState(tx,v.id);
    const intentions=(await tx.query(`SELECT i.id,i.payload,i.created_by AS "createdBy",i.created_at AS "createdAt",
      coalesce(o.status,'PENDING') AS status,o.payment_id AS "paymentId",o.result,o.reason,o.resolved_by AS "resolvedBy"
      FROM payment_intents i LEFT JOIN payment_intent_outcomes o ON o.intent_id=i.id
      WHERE i.visit_id=$1 ORDER BY i.created_at,i.id`,[v.id])).rows;
    return {status:200,body:{...state,intentions,automaticRetry:false}};
  }},
  { method:'POST', path:'/api/v1/visits/:id/payment-intents', permission:'payment.record', idempotent:true, handler:async({tx,actor,params,body})=>{
    const b=asBody(body),payload=deskPayload(b),v=await getVisitForUpdate(tx,params.id!);
    const pending=await unresolvedIntent(tx,v.id);
    if(pending) fail('PAYMENT_INTENT_UNRESOLVED','Recover the existing intention before another payment',{intentId:pending.id});
    const state=await recoveryState(tx,v.id);
    if (b.recoveryVersion!==state.recoveryVersion || !Array.isArray(b.acknowledgedPaymentIds)
      || canonicalJson(b.acknowledgedPaymentIds)!==canonicalJson(state.paymentIds))
      fail('PAYMENT_RECOVERY_STALE','Read and acknowledge the current recovery state before preparing a payment');
    if(!state.balance.careConfirmed) fail('CARE_NOT_CONFIRMED','Dentist confirmation required');
    if(payload.amountMillimes>state.balance.balanceMillimes) fail('AMOUNT_EXCEEDS_BALANCE','Payment exceeds balance');
    const i=await tx.one<{id:string}>(`INSERT INTO payment_intents(clinic_id,visit_id,created_by,ledger_hash,payload)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[actor!.clinicId,v.id,actor!.staffId,state.recoveryVersion,payload]);
    await appendAudit(tx,actor!,'payment.intent_prepared','payment_intent',i.id,{visitId:v.id,ledgerHash:state.recoveryVersion,payloadSha256:sha256(canonicalJson(payload))});
    return {status:201,body:{intent:{id:i.id,status:'PENDING',payload},paymentRecorded:false}};
  }},
  { method:'POST', path:'/api/v1/payment-intents/:id/record', permission:'payment.record', idempotent:true, handler:async({tx,actor,params,body})=>{
    if(Object.keys(asBody(body)).length) fail('VALIDATION_FAILED','Record accepts an empty object; the stored intention is immutable');
    const i=await lockedIntent(tx,params.id!);
    const prior=await tx.maybeOne<{status:string;result:Record<string,unknown>}>('SELECT status,result FROM payment_intent_outcomes WHERE intent_id=$1',[i.id]);
    if(prior?.status==='CANCELLED') fail('PAYMENT_INTENT_CANCELLED','This intention was cancelled; reconcile before another payment');
    if(prior) return {status:200,body:{...prior.result,recovered:true}};
    const state=await recoveryState(tx,i.visit_id);
    if(state.recoveryVersion!==i.ledger_hash) fail('PAYMENT_RECOVERY_STALE','Ledger changed; reconcile and cancel this intention before a new payment');
    const result=await recordPayment(tx,actor!,{...deskPayload(i.payload),visitId:i.visit_id,source:'DESK',issueReceipt:true,paymentIntentId:i.id});
    await tx.query(`INSERT INTO payment_intent_outcomes(intent_id,clinic_id,status,payment_id,result,resolved_by)
      VALUES($1,$2,'RECORDED',$3,$4,$5)`,[i.id,actor!.clinicId,result.payment.id,result,actor!.staffId]);
    await appendAudit(tx,actor!,'payment.intent_recorded','payment_intent',i.id,{paymentId:result.payment.id,receiptId:result.receipt!.id});
    return {status:201,body:result};
  }},
  { method:'POST', path:'/api/v1/payment-intents/:id/cancel', permission:'payment.record', idempotent:true, handler:async({tx,actor,params,body})=>{
    const reason=str(asBody(body),'reason',{min:3,max:300}),i=await lockedIntent(tx,params.id!);
    const prior=await tx.maybeOne<{status:string}>('SELECT status FROM payment_intent_outcomes WHERE intent_id=$1',[i.id]);
    if(prior?.status==='RECORDED') fail('CONFLICT','Payment already recorded; cancellation cannot refund or void it');
    if(prior) return {status:200,body:{status:'CANCELLED',recovered:true}};
    await tx.query(`INSERT INTO payment_intent_outcomes(intent_id,clinic_id,status,reason,resolved_by)
      VALUES($1,$2,'CANCELLED',$3,$4)`,[i.id,actor!.clinicId,reason,actor!.staffId]);
    await appendAudit(tx,actor!,'payment.intent_cancelled','payment_intent',i.id,{reasonSha256:sha256(reason)});
    return {status:200,body:{status:'CANCELLED',paymentRecorded:false}};
  }}
];

export const billingRoutes: Route[] = [
  ...recoveryRoutes,
  {
    method: 'POST', path: '/api/v1/visits/:id/payments', permission: 'payment.record', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const r = await recordPayment(tx, actor!, { ...deskPayload(body), visitId: params.id!, source: 'DESK', issueReceipt: true });
      return { status: 201, body: r };
    },
  },
  {
    method: 'GET', path: '/api/v1/visits/:id/balance', permission: 'payment.read',
    handler: async ({ tx, params }) => {
      const v = await getVisit(tx, params.id!);
      return { status: 200, body: { balance: await visitBalance(tx, v.id) } };
    },
  },
  {
    method: 'GET', path: '/api/v1/visits/:id/payments', permission: 'payment.read',
    handler: async ({ tx, params }) => {
      const v = await getVisit(tx, params.id!);
      const rows = (await tx.query(`SELECT p.id, p.amount_millimes AS "amountMillimes", p.tender, p.source, p.recorded_at AS "recordedAt", p.recorded_by AS "recordedBy",
          r.number AS "receiptNumber", r.id AS "receiptId", r.series AS "receiptSeries", (SELECT coalesce(sum(a.amount_millimes),0)::bigint FROM adjustments a WHERE a.payment_id = p.id) AS "returnedMillimes"
        FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.visit_id = $1 ORDER BY p.recorded_at`, [v.id])).rows;
      return { status: 200, body: { visitId: v.id, payments: rows } };
    },
  },
  {
    method: 'GET', path: '/api/v1/receipts/:id', permission: 'payment.read',
    handler: async ({ tx, params }) => {
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Receipt not found');
      const r = await tx.maybeOne('SELECT id, series, number, kind, issued_at AS "issuedAt", snapshot, snapshot_sha256 AS "snapshotSha256" FROM receipts WHERE id = $1', [params.id!]);
      if (!r) fail('NOT_FOUND', 'Receipt not found');
      return { status: 200, body: { receipt: r } };
    },
  },
  {
    // Reprint never creates a new number; it is marked COPY and logged (C-139 T-REC-3).
    method: 'POST', path: '/api/v1/receipts/:id/reprint', permission: 'receipt.reprint', idempotent: true,
    handler: async ({ tx, actor, params }) => {
      if (!isUuid(params.id!)) fail('NOT_FOUND', 'Receipt not found');
      const r = await tx.maybeOne<{ id: string; number: number; snapshot: Record<string, unknown> }>('SELECT id, number, snapshot FROM receipts WHERE id = $1', [params.id!]);
      if (!r) fail('NOT_FOUND', 'Receipt not found');
      await advisoryLock(tx, 'receipt_print', r!.id);
      const prints = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM receipt_prints WHERE receipt_id = $1 AND is_copy', [r!.id]);
      await tx.query('INSERT INTO receipt_prints (clinic_id, receipt_id, printed_by, is_copy) VALUES ($1,$2,$3,true)', [actor!.clinicId, r!.id, actor!.staffId]);
      await appendAudit(tx, actor!, 'receipt.reprinted', 'receipt', r!.id, { number: r!.number, copyNo: prints.n + 1 });
      return { status: 200, body: { preparationOnly: true, paperDelivery: 'UNKNOWN', receipt: { ...r!.snapshot, copy: true, copyMark: 'COPIE / نسخة', copyNo: prints.n + 1 } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/visits/:id/adjustments', permission: 'adjustment.discount', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const kind = oneOf(b, 'kind', ['DISCOUNT', 'WRITE_OFF'] as const)!;
      const amount = millimes(b, 'amountMillimes');
      const reasonCode = str(b, 'reasonCode', { min: 3, max: 40, pattern: REASON_CODE });
      const reasonNote = optStr(b, 'reasonNote', { max: 300 });
      const v = await getVisitForUpdate(tx, params.id!);
      const bal = await visitBalance(tx, v.id);
      if (amount > bal.balanceMillimes) fail('AMOUNT_EXCEEDS_BALANCE', 'Adjustment exceeds the open balance', { balanceMillimes: bal.balanceMillimes });
      const role = primaryRole(actor!, ['DENTIST', 'OWNER']);
      const a = await tx.one<{ id: string; created_at: string }>(`INSERT INTO adjustments (clinic_id, visit_id, patient_id, kind, amount_millimes, reason_code, reason_note, authorized_by, authorized_role)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`, [actor!.clinicId, v.id, v.patient_id, kind, amount, reasonCode, reasonNote, actor!.staffId, role]);
      await appendAudit(tx, actor!, 'adjustment.created', 'adjustment', a.id, { visitId: v.id, kind, amountMillimes: amount, reasonCode, authorizedRole: role, createdAt: a.created_at, reasonNoteSha256: sha256OrNull(reasonNote) });
      return { status: 201, body: { adjustment: { id: a.id, kind, amountMillimes: amount, reasonCode, authorizedBy: actor!.staffId, authorizedRole: role }, balance: await visitBalance(tx, v.id) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/payments/:id/refund', permission: 'adjustment.refund', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const amount = millimes(b, 'amountMillimes');
      const reasonCode = str(b, 'reasonCode', { min: 3, max: 40, pattern: REASON_CODE });
      const reasonNote = optStr(b, 'reasonNote', { max: 300 });
      const p = await loadPaymentForUpdate(tx, params.id!);
      const done = await returnedOnPayment(tx, p.id);
      if (done.voided > 0) fail('ALREADY_VOIDED', 'Payment is voided');
      if (done.refunded + amount > p.amount_millimes) fail('AMOUNT_EXCEEDS_BALANCE', 'Refund exceeds the payment amount', { refundableMillimes: p.amount_millimes - done.refunded });
      const bal = await visitBalance(tx, p.visit_id);
      if (bal.balanceMillimes + amount > 0) fail('CONFLICT', 'No patient credit to refund: the dentist must first correct the fee or approve a discount', { balanceMillimes: bal.balanceMillimes });
      const cashPeriodId = await cashPeriodFor(tx, actor!, p.tender);
      const a = await tx.one<{ id: string; created_at: string }>(`INSERT INTO adjustments (clinic_id, visit_id, patient_id, kind, amount_millimes, reason_code, reason_note, payment_id, tender, cash_period_id, authorized_by, authorized_role, created_at)
          VALUES ($1,$2,$3,'REFUND',$4,$5,$6,$7,$8,$9,$10,'OWNER', clock_timestamp()) RETURNING id, created_at`, [actor!.clinicId, p.visit_id, p.patient_id, amount, reasonCode, reasonNote, p.id, p.tender, cashPeriodId, actor!.staffId]);
      const receipt = await issueReceipt(tx, actor!, 'REFUND', { adjustmentId: a.id }, p.visit_id, { amountMillimes: amount, amountText: formatMillimes(amount), tender: p.tender, originalPaymentId: p.id, reasonCode });
      await appendAudit(tx, actor!, 'payment.refunded', 'adjustment', a.id, { paymentId: p.id, amountMillimes: amount, tender: p.tender, reasonCode, receiptNumber: receipt.number, cashPeriodId,
        visitId: p.visit_id, createdAt: a.created_at, receiptSha256: receipt.sha256, reasonNoteSha256: sha256OrNull(reasonNote) });
      return { status: 201, body: { refund: { id: a.id, paymentId: p.id, amountMillimes: amount, tender: p.tender }, receipt: { id: receipt.id, number: receipt.number, label: receipt.label }, balance: await visitBalance(tx, p.visit_id) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/payments/:id/void', permission: 'adjustment.void_payment', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const reasonCode = str(b, 'reasonCode', { min: 3, max: 40, pattern: REASON_CODE });
      const reasonNote = optStr(b, 'reasonNote', { max: 300 });
      const p = await loadPaymentForUpdate(tx, params.id!);
      const done = await returnedOnPayment(tx, p.id);
      if (done.voided > 0) fail('ALREADY_VOIDED', 'Payment is already voided');
      if (done.refunded > 0) fail('CONFLICT', 'Payment has refunds; it cannot also be voided');
      const cashPeriodId = await cashPeriodFor(tx, actor!, p.tender);
      const a = await tx.one<{ id: string; created_at: string }>(`INSERT INTO adjustments (clinic_id, visit_id, patient_id, kind, amount_millimes, reason_code, reason_note, payment_id, tender, cash_period_id, authorized_by, authorized_role, created_at)
          VALUES ($1,$2,$3,'PAYMENT_VOID',$4,$5,$6,$7,$8,$9,$10,'OWNER', clock_timestamp()) RETURNING id, created_at`, [actor!.clinicId, p.visit_id, p.patient_id, p.amount_millimes, reasonCode, reasonNote, p.id, p.tender, cashPeriodId, actor!.staffId]);
      // A paper-outage payment has no desk receipt: the VOID receipt then refers to none (null), as before R74.
      const orig = (await tx.maybeOne<{ number: number }>('SELECT number FROM receipts WHERE payment_id = $1', [p.id])) ?? { number: 0 };
      const receipt = await issueReceipt(tx, actor!, 'VOID', { adjustmentId: a.id }, p.visit_id, { voidsReceiptNumber: orig.number || null, amountMillimes: p.amount_millimes, tender: p.tender, reasonCode });
      await appendAudit(tx, actor!, 'payment.voided', 'adjustment', a.id, { paymentId: p.id, amountMillimes: p.amount_millimes, reasonCode, receiptNumber: receipt.number, voidsReceiptNumber: orig.number || null,
        visitId: p.visit_id, createdAt: a.created_at, receiptSha256: receipt.sha256, reasonNoteSha256: sha256OrNull(reasonNote) });
      return { status: 201, body: { void: { id: a.id, paymentId: p.id, amountMillimes: p.amount_millimes }, receipt: { id: receipt.id, number: receipt.number, label: receipt.label }, balance: await visitBalance(tx, p.visit_id) } };
    },
  },
];
