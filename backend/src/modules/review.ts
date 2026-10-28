/*
 * OWNER FINANCIAL REVIEW module (B11): one read-only, owner-only view of every decision that reduced or returned
 * money in a date window, with its provenance, plus how strongly each recorded payment is evidenced.
 * Depends on: integrity (unresolved system findings). Owns no tables; writes nothing.
 *
 * Evidence vocabulary (never upgraded by this view):
 *   RECORDED_ONLY            - a staff member recorded it; nothing independent yet;
 *   CASH_IN_COUNTED_PERIOD   - desk cash inside a drawer period the owner counted and closed (drawer-level,
 *                              not proof of this payment);
 *   PAPER_SLIP_RECORD        - re-entered from a numbered paper slip; the slip is the evidence;
 *   CARD_DESK_CLAIM / CARD_OWNER_REVIEWED_STATEMENT - card claims; neither is provider-verified (none exists).
 * Wording is neutral: amounts, reason codes, who authorised and when. Never "suspicious", never a judgement.
 * Free-text notes are NOT returned (only hasNote): whether the owner may read them is a pending founder decision.
 * Dates are clinic-local calendar days (clinics.settings.timezone via patients.clinicTimezone, shared with B12).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { integrityCheck } from './integrity.ts';
import { clinicTimezone } from './patients.ts';

const MAX_DAYS = 92;
const total = (rows: Array<{ amountMillimes: number }>) => rows.reduce((s, r) => s + r.amountMillimes, 0);
function groupTotals<T extends { amountMillimes: number }>(rows: T[], key: (r: T) => string) {
  const out: Record<string, { count: number; totalMillimes: number }> = {};
  for (const r of rows) { const k = key(r); out[k] ??= { count: 0, totalMillimes: 0 }; out[k].count++; out[k].totalMillimes += r.amountMillimes; }
  return out;
}

function windowFrom(query: URLSearchParams, timezone: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const to = query.get('to') ?? today;
  const from = query.get('from') ?? new Date(Date.parse(to + 'T00:00:00Z') - 6 * 86400_000).toISOString().slice(0, 10);
  for (const [k, v] of [['from', from], ['to', to]] as const) {
    const t = Date.parse(v + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) fail('VALIDATION_FAILED', `${k} must be YYYY-MM-DD`, { field: k });
  }
  const days = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400_000 + 1;
  if (days < 1) fail('VALIDATION_FAILED', 'from must not be after to', { field: 'from' });
  if (days > MAX_DAYS) fail('VALIDATION_FAILED', `window longer than ${MAX_DAYS} days`, { field: 'from' });
  return { from, to, days };
}

export async function financialReview(tx: Tx, clinicId: string, from: string, to: string, timezone: string) {
  const w = [clinicId, from, to, timezone];
  // Window predicate on every query: clinic-local calendar days [$2, $3] inclusive, in timezone $4.
  type Adj = { id: string; kind: string; visitId: string; fileNo: number; amountMillimes: number; reasonCode: string; hasNote: boolean; paymentId: string | null; tender: string | null; receiptLabel: string | null; authorizedRole: string; authorizedById: string; authorizedByName: string; createdAt: string };
  const adjustments = (await tx.query<Adj>(`SELECT a.id, a.kind, a.visit_id AS "visitId", p.file_no AS "fileNo", a.amount_millimes AS "amountMillimes", a.reason_code AS "reasonCode",
      a.reason_note IS NOT NULL AS "hasNote", a.payment_id AS "paymentId", a.tender, CASE WHEN r.id IS NULL THEN NULL ELSE r.series || '-' || lpad(r.number::text, 6, '0') END AS "receiptLabel", a.authorized_role AS "authorizedRole",
      a.authorized_by AS "authorizedById", s.display_name AS "authorizedByName", a.created_at AS "createdAt"
    FROM adjustments a JOIN patients p ON p.clinic_id = a.clinic_id AND p.id = a.patient_id
    JOIN staff s ON s.clinic_id = a.clinic_id AND s.id = a.authorized_by
    LEFT JOIN receipts r ON r.clinic_id = a.clinic_id AND r.adjustment_id = a.id
    WHERE a.clinic_id = $1 AND a.created_at >= $2::date::timestamp AT TIME ZONE $4 AND a.created_at < ($3::date + 1)::timestamp AT TIME ZONE $4 ORDER BY a.created_at, a.id`, w)).rows;
  const reductions = adjustments.filter(a => a.kind === 'DISCOUNT' || a.kind === 'WRITE_OFF').map(({ paymentId: _p, tender: _t, receiptLabel: _r, ...a }) => a);
  const returns = adjustments.filter(a => a.kind === 'REFUND' || a.kind === 'PAYMENT_VOID');

  type Corr = { id: string; correctsId: string; visitId: string; fileNo: number; procedureCode: string; amountMillimes: number; originalFeeMillimes: number; hasReason: boolean; dentistId: string; dentistName: string; confirmedAt: string };
  const corrections = (await tx.query<Corr>(`SELECT c.id, c.corrects_id AS "correctsId", c.visit_id AS "visitId", p.file_no AS "fileNo", c.procedure_code AS "procedureCode",
      c.fee_millimes AS "amountMillimes", o.fee_millimes AS "originalFeeMillimes", c.reason IS NOT NULL AS "hasReason",
      c.confirmed_by AS "dentistId", s.display_name AS "dentistName", c.confirmed_at AS "confirmedAt"
    FROM care_items c JOIN care_items o ON o.clinic_id = c.clinic_id AND o.id = c.corrects_id
    JOIN patients p ON p.clinic_id = c.clinic_id AND p.id = c.patient_id JOIN staff s ON s.clinic_id = c.clinic_id AND s.id = c.confirmed_by
    WHERE c.clinic_id = $1 AND c.kind = 'CORRECTION' AND c.confirmed_at >= $2::date::timestamp AT TIME ZONE $4 AND c.confirmed_at < ($3::date + 1)::timestamp AT TIME ZONE $4 ORDER BY c.confirmed_at, c.id`, w)).rows;
  const freeCare = (await tx.query<{ id: string; visitId: string; fileNo: number; procedureCode: string; dentistName: string; confirmedAt: string }>(`SELECT c.id, c.visit_id AS "visitId", p.file_no AS "fileNo",
      c.procedure_code AS "procedureCode", s.display_name AS "dentistName", c.confirmed_at AS "confirmedAt"
    FROM care_items c JOIN patients p ON p.clinic_id = c.clinic_id AND p.id = c.patient_id JOIN staff s ON s.clinic_id = c.clinic_id AND s.id = c.confirmed_by
    WHERE c.clinic_id = $1 AND c.kind = 'CARE' AND c.fee_millimes = 0 AND c.confirmed_at >= $2::date::timestamp AT TIME ZONE $4 AND c.confirmed_at < ($3::date + 1)::timestamp AT TIME ZONE $4 ORDER BY c.confirmed_at, c.id`, w)).rows;
  // CH-028: visits whose fee was brought to zero by corrections or reductions, with no payment at all.
  const zeroedVisits = (await tx.query<{ visitId: string; fileNo: number; originalChargedMillimes: number; reducedMillimes: number; correctionNetMillimes: number }>(`SELECT v.id AS "visitId", p.file_no AS "fileNo",
      (SELECT coalesce(sum(fee_millimes),0) FROM care_items c WHERE c.clinic_id = v.clinic_id AND c.visit_id = v.id AND c.kind = 'CARE')::bigint AS "originalChargedMillimes",
      b.reduced_millimes AS "reducedMillimes",
      (SELECT coalesce(sum(fee_millimes),0) FROM care_items c WHERE c.clinic_id = v.clinic_id AND c.visit_id = v.id AND c.kind = 'CORRECTION')::bigint AS "correctionNetMillimes"
    FROM visits v JOIN visit_balances b ON b.visit_id = v.id JOIN patients p ON p.clinic_id = v.clinic_id AND p.id = v.patient_id
    WHERE v.clinic_id = $1 AND b.paid_millimes = 0 AND b.charged_millimes - b.reduced_millimes + b.returned_millimes = 0
      AND (b.reduced_millimes > 0 OR EXISTS (SELECT 1 FROM care_items c WHERE c.clinic_id = v.clinic_id AND c.visit_id = v.id AND c.kind = 'CORRECTION'))
      AND EXISTS (SELECT 1 FROM care_items c WHERE c.clinic_id = v.clinic_id AND c.visit_id = v.id AND c.confirmed_at >= $2::date::timestamp AT TIME ZONE $4 AND c.confirmed_at < ($3::date + 1)::timestamp AT TIME ZONE $4)
    ORDER BY v.scheduled_at, v.id`, w)).rows;

  // Evidence level of every payment recorded in the window (active amount = minus refunds/voids).
  const payments = (await tx.query<{ id: string; tender: string; source: string; amountMillimes: number; returnedMillimes: number; evidence: string }>(`SELECT pay.id, pay.tender, pay.source,
      pay.amount_millimes AS "amountMillimes",
      (SELECT coalesce(sum(a.amount_millimes),0) FROM adjustments a WHERE a.clinic_id = pay.clinic_id AND a.payment_id = pay.id)::bigint AS "returnedMillimes",
      CASE WHEN pay.tender = 'CARD' THEN CASE WHEN cm.evidence_tier = 'OWNER_REVIEWED_STATEMENT' THEN 'CARD_OWNER_REVIEWED_STATEMENT' ELSE 'CARD_DESK_CLAIM' END
           WHEN pay.source = 'PAPER_OUTAGE' THEN 'PAPER_SLIP_RECORD'
           WHEN per.status = 'CLOSED' THEN 'CASH_IN_COUNTED_PERIOD' ELSE 'RECORDED_ONLY' END AS evidence
    FROM payments pay
    LEFT JOIN card_matches cm ON cm.clinic_id = pay.clinic_id AND cm.payment_id = pay.id
    LEFT JOIN LATERAL (SELECT cp.status FROM cash_periods cp WHERE pay.tender = 'CASH' AND cp.clinic_id = pay.clinic_id AND cp.opened_at < pay.recorded_at
        AND (cp.cutoff_at IS NULL OR pay.recorded_at <= cp.cutoff_at) ORDER BY cp.period_no DESC LIMIT 1) per ON true
    WHERE pay.clinic_id = $1 AND pay.recorded_at >= $2::date::timestamp AT TIME ZONE $4 AND pay.recorded_at < ($3::date + 1)::timestamp AT TIME ZONE $4`, w)).rows;
  const evidence: Record<string, { count: number; totalMillimes: number; activeMillimes: number }> = {};
  for (const p of payments) {
    const e = (evidence[p.evidence] ??= { count: 0, totalMillimes: 0, activeMillimes: 0 });
    e.count++; e.totalMillimes += p.amountMillimes; e.activeMillimes += p.amountMillimes - p.returnedMillimes;
  }

  const periods = (await tx.query<{ id: string; periodNo: number; closedAt: string; attempts: number; differenceMillimes: number; counterIndependent: boolean; handoverMillimes: number }>(`SELECT cp.id, cp.period_no AS "periodNo", cp.closed_at AS "closedAt",
      (SELECT count(*) FROM cash_counts x WHERE x.clinic_id = cp.clinic_id AND x.period_id = cp.id)::int AS attempts,
      cc.difference_millimes AS "differenceMillimes", cc.counter_independent AS "counterIndependent", cp.handover_millimes AS "handoverMillimes"
    FROM cash_periods cp JOIN cash_counts cc ON cc.clinic_id = cp.clinic_id AND cc.id = cp.accepted_count_id
    WHERE cp.clinic_id = $1 AND cp.status = 'CLOSED' AND cp.closed_at >= $2::date::timestamp AT TIME ZONE $4 AND cp.closed_at < ($3::date + 1)::timestamp AT TIME ZONE $4 ORDER BY cp.period_no`, w)).rows;
  const openPeriod = await tx.maybeOne<{ periodNo: number; openedAt: string; attempts: number }>(`SELECT cp.period_no AS "periodNo", cp.opened_at AS "openedAt",
      (SELECT count(*) FROM cash_counts x WHERE x.clinic_id = cp.clinic_id AND x.period_id = cp.id)::int AS attempts
    FROM cash_periods cp WHERE cp.clinic_id = $1 AND cp.status = 'OPEN'`, [clinicId]);

  // Who authorised money-reducing decisions (counts and totals only; neutral, no ranking or judgement).
  const byAuthorizer: Record<string, { name: string; role: string; reductions: number; reductionMillimes: number; returns: number; returnMillimes: number; corrections: number; correctionNetMillimes: number }> = {};
  const slot = (id: string, name: string, role: string) => (byAuthorizer[id] ??= { name, role, reductions: 0, reductionMillimes: 0, returns: 0, returnMillimes: 0, corrections: 0, correctionNetMillimes: 0 });
  for (const a of reductions) { const s = slot(a.authorizedById, a.authorizedByName, a.authorizedRole); s.reductions++; s.reductionMillimes += a.amountMillimes; }
  for (const a of returns) { const s = slot(a.authorizedById, a.authorizedByName, a.authorizedRole); s.returns++; s.returnMillimes += a.amountMillimes; }
  for (const c of corrections) { const s = slot(c.dentistId, c.dentistName, 'DENTIST'); s.corrections++; s.correctionNetMillimes += c.amountMillimes; }

  const integ = await integrityCheck(tx, clinicId, []);
  return {
    window: { from, to, timezone },
    reductions: { items: reductions, totalMillimes: total(reductions), byKind: groupTotals(reductions, r => r.kind), byReasonCode: groupTotals(reductions, r => r.reasonCode) },
    returns: { items: returns, totalMillimes: total(returns), byKind: groupTotals(returns, r => r.kind), byTender: groupTotals(returns, r => r.tender ?? 'UNKNOWN') },
    feeCorrections: { items: corrections, netMillimes: total(corrections), count: corrections.length },
    freeCare: { items: freeCare, count: freeCare.length },
    zeroedVisits: { items: zeroedVisits, count: zeroedVisits.length, wording: 'Fee brought to zero by a correction or reduction, with no payment. Legitimate cases exist; the owner reviews the reason codes.' },
    paymentEvidence: {
      byLevel: evidence,
      levels: {
        RECORDED_ONLY: 'Recorded by staff; no independent evidence yet.',
        CASH_IN_COUNTED_PERIOD: 'Inside a drawer period the owner counted and closed (drawer-level, not proof of this payment).',
        PAPER_SLIP_RECORD: 'Re-entered from a numbered paper slip; the slip is the evidence.',
        CARD_DESK_CLAIM: 'Card payment as claimed at the desk; owner proof separate.',
        CARD_OWNER_REVIEWED_STATEMENT: 'Matched by the owner to an imported statement line; not provider-verified.',
      },
    },
    cashPeriods: { closed: periods, discrepancies: periods.filter(p => p.differenceMillimes !== 0).length, open: openPeriod ?? null },
    byAuthorizer,
    unresolved: {
      integrityFindings: integ.findings.length,
      checks: [...new Set(integ.findings.map(f => f.check))],
      note: 'System findings are data-consistency signals, not conclusions about any person.',
    },
    scope: 'Recorded decisions and payments only. Money never recorded cannot appear here (CH-002). This view upgrades no evidence and accuses no one.',
  };
}

export const reviewRoutes: Route[] = [
  {
    method: 'GET', path: '/api/v1/owner/financial-review', permission: 'finance.review',
    handler: async ({ tx, actor, query }) => {
      const timezone = await clinicTimezone(tx, actor!.clinicId);
      const { from, to } = windowFrom(query, timezone);
      return { status: 200, body: await financialReview(tx, actor!.clinicId, from, to, timezone) };
    },
  },
];
