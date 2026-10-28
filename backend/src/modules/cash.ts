/*
 * CASH module: drawer periods, owner movements, blind independent counts, owner review and close.
 * Owns tables: cash_drawers, cash_periods, cash_movements, cash_counts. Reads payments/adjustments (billing).
 * Registers the billing cash-period resolver so every CASH payment/refund/void is tied to the open period.
 *
 * C2 / CH-007 / CH-014 properties:
 *  - the counter (OWNER or DENTIST; never RECEPTIONIST) never receives expected cash, per-payment cash totals or
 *    a difference before submitting; the submit response contains no figures;
 *  - every attempt is stored; a recount needs a reason; the owner review shows ALL attempts and the first difference;
 *  - the owner review (expected, breakdown, differences) is unavailable until at least one count was submitted,
 *    so an owner who is also the counter cannot anchor on the expected figure;
 *  - opening float, float top-ups, owner withdrawals, bank deposits, petty expenses, cash refunds/voids are explicit;
 *  - closing accepts only the LATEST attempt and carries the counted remainder (minus handover) into the next period;
 *  - "counter_independent" is a SOFTWARE check only (role + did not record cash in the window). Physical
 *    independence (who actually touched the drawer, collusion, timing) cannot be proven by software.
 *  - a difference is never called theft: wording is "count differs, owner review pending".
 */
import type { Tx } from '../platform/db.ts';
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, millimes, oneOf, optStr, str, uuid, isUuid } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';
import { setCashPeriodResolver } from './billing.ts';

const OUTFLOWS = ['OWNER_WITHDRAWAL', 'BANK_DEPOSIT', 'PETTY_EXPENSE'] as const;

async function drawerId(tx: Tx, clinicId: string): Promise<string> {
  await tx.query("INSERT INTO cash_drawers (clinic_id, name) VALUES ($1, 'MAIN') ON CONFLICT DO NOTHING", [clinicId]);
  return (await tx.one<{ id: string }>('SELECT id FROM cash_drawers WHERE clinic_id = $1', [clinicId])).id;
}

/** FOR SHARE on the open period: cash writes serialise against count submission (FOR UPDATE). */
export async function openPeriodForCashWrite(tx: Tx, actor: Actor): Promise<string> {
  const p = await tx.maybeOne<{ id: string }>("SELECT id FROM cash_periods WHERE status = 'OPEN' FOR SHARE");
  if (!p) fail('NO_OPEN_CASH_PERIOD', 'No open cash period: the owner must open the drawer (opening float) before cash can be recorded');
  void actor;
  return p!.id;
}
setCashPeriodResolver(openPeriodForCashWrite);

interface PeriodRow { id: string; period_no: number; opened_at: string; opening_float_millimes: number; opening_basis: string; status: string; cutoff_at: string | null; drawer_id: string }

async function getPeriod(tx: Tx, id: string, lock: '' | 'FOR UPDATE' = ''): Promise<PeriodRow> {
  if (!isUuid(id)) fail('NOT_FOUND', 'Cash period not found');
  const p = await tx.maybeOne<PeriodRow>(`SELECT id, period_no, opened_at, opening_float_millimes, opening_basis, status, cutoff_at, drawer_id FROM cash_periods WHERE id = $1 ${lock}`, [id]);
  if (!p) fail('NOT_FOUND', 'Cash period not found');
  return p!;
}

/** Expected cash in (opened_at, cutoff]. Single drawer per clinic in v0.2, so time windows identify the drawer. */
export async function expectedCash(tx: Tx, period: PeriodRow, cutoff: string) {
  const r = await tx.one<{ cash_in: number; top_up: number; withdrawals: number; deposits: number; expenses: number; refunds: number; voids: number; n_payments: number }>(`
    SELECT
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM payments WHERE tender = 'CASH' AND recorded_at > $1 AND recorded_at <= $2) AS cash_in,
      (SELECT count(*)::int FROM payments WHERE tender = 'CASH' AND recorded_at > $1 AND recorded_at <= $2) AS n_payments,
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM cash_movements WHERE kind = 'FLOAT_TOP_UP' AND recorded_at > $1 AND recorded_at <= $2) AS top_up,
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM cash_movements WHERE kind = 'OWNER_WITHDRAWAL' AND recorded_at > $1 AND recorded_at <= $2) AS withdrawals,
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM cash_movements WHERE kind = 'BANK_DEPOSIT' AND recorded_at > $1 AND recorded_at <= $2) AS deposits,
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM cash_movements WHERE kind = 'PETTY_EXPENSE' AND recorded_at > $1 AND recorded_at <= $2) AS expenses,
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM adjustments WHERE kind = 'REFUND' AND tender = 'CASH' AND created_at > $1 AND created_at <= $2) AS refunds,
      (SELECT coalesce(sum(amount_millimes),0)::bigint FROM adjustments WHERE kind = 'PAYMENT_VOID' AND tender = 'CASH' AND created_at > $1 AND created_at <= $2) AS voids`,
    [period.opened_at, cutoff]);
  const expected = period.opening_float_millimes + r.cash_in + r.top_up - r.withdrawals - r.deposits - r.expenses - r.refunds - r.voids;
  return {
    expectedMillimes: expected,
    breakdown: {
      openingFloatMillimes: period.opening_float_millimes, openingBasis: period.opening_basis,
      cashPaymentsMillimes: r.cash_in, cashPaymentCount: r.n_payments, floatTopUpsMillimes: r.top_up,
      ownerWithdrawalsMillimes: r.withdrawals, bankDepositsMillimes: r.deposits, pettyExpensesMillimes: r.expenses,
      cashRefundsMillimes: r.refunds, cashVoidsMillimes: r.voids,
    },
  };
}

const blindPeriodView = (p: PeriodRow, attempts: number) => ({
  id: p.id, periodNo: p.period_no, openedAt: p.opened_at, status: p.status, countAttempts: attempts,
  blind: true, note: 'Expected cash is hidden until a count is submitted (blind count).',
});

export const cashRoutes: Route[] = [
  {
    // First period only (later periods open automatically when the owner closes the previous one).
    method: 'POST', path: '/api/v1/cash/periods', permission: 'cash.manage_period', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const float = millimes(b, 'openingFloatMillimes', { allowZero: true });
      const d = await drawerId(tx, actor!.clinicId);
      const any = await tx.maybeOne('SELECT id FROM cash_periods WHERE drawer_id = $1 LIMIT 1', [d]);
      if (any) fail('CONFLICT', 'A cash period already exists; periods open automatically when the owner closes the previous one');
      const p = await tx.one<{ id: string; opened_at: string }>(`INSERT INTO cash_periods (clinic_id, drawer_id, period_no, opened_at, opened_by, opening_float_millimes, opening_basis)
          VALUES ($1, $2, 1, clock_timestamp(), $3, $4, 'OWNER_DECLARED') RETURNING id, opened_at`, [actor!.clinicId, d, actor!.staffId, float]);
      await appendAudit(tx, actor!, 'cash.period_opened', 'cash_period', p.id, { periodNo: 1, openingFloatMillimes: float, basis: 'OWNER_DECLARED' });
      return { status: 201, body: { period: { id: p.id, periodNo: 1, openedAt: p.opened_at, status: 'OPEN' } } };
    },
  },
  {
    // Blind view for everyone who can count or record: no figures at all.
    method: 'GET', path: '/api/v1/cash/periods/current', permission: 'payment.record',
    handler: async ({ tx }) => {
      const p = await tx.maybeOne<PeriodRow>("SELECT id, period_no, opened_at, opening_float_millimes, opening_basis, status, cutoff_at, drawer_id FROM cash_periods WHERE status = 'OPEN'");
      if (!p) return { status: 200, body: { period: null } };
      const n = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM cash_counts WHERE period_id = $1', [p.id]);
      return { status: 200, body: { period: blindPeriodView(p, n.n) } };
    },
  },
  {
    method: 'POST', path: '/api/v1/cash/periods/:id/movements', permission: 'cash.manage_period', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const kind = oneOf(b, 'kind', ['OWNER_WITHDRAWAL', 'BANK_DEPOSIT', 'PETTY_EXPENSE', 'FLOAT_TOP_UP'] as const)!;
      const amount = millimes(b, 'amountMillimes');
      const reason = str(b, 'reason', { min: 3, max: 200 });
      const voucherRef = optStr(b, 'voucherRef', { max: 40, pattern: /^[A-Za-z0-9/_-]{1,40}$/ });
      const openId = await openPeriodForCashWrite(tx, actor!);
      if (openId !== params.id) fail('CASH_PERIOD_CLOSED', 'Movements can only be recorded in the open period');
      const m = await tx.one<{ id: string; recorded_at: string }>(`INSERT INTO cash_movements (clinic_id, period_id, kind, amount_millimes, reason, voucher_ref, authorized_by, recorded_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7, clock_timestamp()) RETURNING id, recorded_at`, [actor!.clinicId, openId, kind, amount, reason, voucherRef, actor!.staffId]);
      await appendAudit(tx, actor!, 'cash.movement_recorded', 'cash_movement', m.id, { periodId: openId, kind, amountMillimes: amount, voucherRef, outflow: (OUTFLOWS as readonly string[]).includes(kind) });
      return { status: 201, body: { movement: { id: m.id, kind, amountMillimes: amount, recordedAt: m.recorded_at } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/cash/periods/:id/counts', permission: 'cash.count_submit', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const counted = millimes(b, 'countedMillimes', { allowZero: true, max: 1_000_000_000 });
      const recountReason = optStr(b, 'recountReason', { max: 200 });
      let denominations: Record<string, number> | null = null;
      if (b.denominations !== undefined) {
        const d = asBody(b.denominations);
        denominations = {};
        let sum = 0;
        for (const [k, v] of Object.entries(d)) {
          if (!/^\d{1,6}$/.test(k) || typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100000) fail('VALIDATION_FAILED', 'denominations must map unit value in millimes -> count');
          denominations[k] = v as number; sum += Number(k) * (v as number);
        }
        if (sum !== counted) fail('VALIDATION_FAILED', 'denominations do not add up to countedMillimes', { denominationTotalMillimes: sum });
      }
      const p = await getPeriod(tx, params.id!, 'FOR UPDATE');
      if (p.status !== 'OPEN') fail('CASH_PERIOD_CLOSED', 'This cash period is closed; count the current period');
      const prior = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM cash_counts WHERE period_id = $1', [p.id]);
      const attempt = prior.n + 1;
      if (attempt > 1 && (!recountReason || recountReason.length < 3)) fail('RECOUNT_REASON_REQUIRED', 'A recount needs a reason; the earlier attempt stays on record');
      const now = (await tx.one<{ t: string }>('SELECT clock_timestamp() AS t')).t;
      const exp = await expectedCash(tx, p, now);
      const recordedCash = await tx.one<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE tender = 'CASH' AND recorded_by = $1 AND recorded_at > $2 AND recorded_at <= $3", [actor!.staffId, p.opened_at, now]);
      const notes: string[] = [];
      if (actor!.roles.includes('RECEPTIONIST')) notes.push('counter also holds the RECEPTIONIST role');
      if (recordedCash.n > 0) notes.push(`counter recorded ${recordedCash.n} cash payment(s) in this period`);
      const independent = notes.length === 0;
      notes.push('software check only: physical independence of the count cannot be proven by software');
      const c = await tx.one<{ id: string }>(`INSERT INTO cash_counts (clinic_id, period_id, attempt_no, counted_by, counted_by_roles, counted_millimes, denominations, recount_reason, submitted_at, expected_millimes, difference_millimes, counter_independent, independence_notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [actor!.clinicId, p.id, attempt, actor!.staffId, [...actor!.roles].sort().join(','), counted, denominations, recountReason, now, exp.expectedMillimes, counted - exp.expectedMillimes, independent, notes.join('; ')]);
      // The audit payload is owner-visible evidence; it holds the counted figure but not the expected one.
      await appendAudit(tx, actor!, 'cash.count_submitted', 'cash_count', c.id, { periodId: p.id, attemptNo: attempt, countedMillimes: counted, recountReason, counterIndependent: independent });
      // BLIND: no expected, no difference, no breakdown in this response (T-CASH-1 / T-CASH-2).
      return { status: 201, body: { count: { id: c.id, periodId: p.id, attemptNo: attempt, submittedAt: now }, status: 'RECORDED_PENDING_OWNER_REVIEW' } };
    },
  },
  {
    method: 'GET', path: '/api/v1/cash/periods/:id/review', permission: 'cash.review',
    handler: async ({ tx, params }) => {
      const p = await getPeriod(tx, params.id!);
      const counts = (await tx.query<{ id: string; attempt_no: number; counted_by: string; counted_millimes: number; expected_millimes: number; difference_millimes: number; submitted_at: string; recount_reason: string | null; counter_independent: boolean; independence_notes: string }>(
        'SELECT id, attempt_no, counted_by, counted_millimes, expected_millimes, difference_millimes, submitted_at, recount_reason, counter_independent, independence_notes FROM cash_counts WHERE period_id = $1 ORDER BY attempt_no', [p.id])).rows;
      if (!counts.length) fail('CONFLICT', 'Submit a blind count first; expected cash is revealed only after a count exists');
      const latest = counts[counts.length - 1]!;
      const exp = await expectedCash(tx, p, latest.submitted_at); // recomputed: authoritative for the latest cut
      const first = counts[0]!;
      const late = await tx.one<{ n: number; total: number }>("SELECT count(*)::int AS n, coalesce(sum(amount_millimes),0)::bigint AS total FROM payments WHERE tender = 'CASH' AND recorded_at > $1", [latest.submitted_at]);
      const label = (d: number) => d === 0 ? 'count matches records' : `count differs by ${d} millimes — owner review pending (not an accusation)`;
      return {
        status: 200,
        body: {
          period: { id: p.id, periodNo: p.period_no, status: p.status, openedAt: p.opened_at },
          expected: exp,
          attempts: counts.map(c => ({ id: c.id, attemptNo: c.attempt_no, countedBy: c.counted_by, countedMillimes: c.counted_millimes, expectedMillimes: c.expected_millimes, differenceMillimes: c.difference_millimes, submittedAt: c.submitted_at, recountReason: c.recount_reason, counterIndependent: c.counter_independent, independenceNotes: c.independence_notes, wording: label(c.difference_millimes) })),
          summary: `${counts.length} attempt(s); first differed by ${first.difference_millimes} millimes; latest differs by ${latest.difference_millimes} millimes`,
          cashRecordedAfterLatestCount: { count: late.n, totalMillimes: late.total, note: 'belongs to the next period when this one is closed' },
          evidence: latest.counter_independent ? 'COUNTED_BY_NON_RECEPTIONIST (software check)' : 'COUNT_NOT_INDEPENDENT',
          scope: 'Compares the drawer with RECORDED cash only. Cash never recorded cannot appear here (CH-002).',
        },
      };
    },
  },
  {
    method: 'POST', path: '/api/v1/cash/periods/:id/close', permission: 'cash.review', reauth: true, idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const acceptedCountId = uuid(b, 'acceptedCountId');
      const handover = millimes(b, 'handoverMillimes', { allowZero: true, max: 1_000_000_000 });
      const note = optStr(b, 'note', { max: 300 });
      const p = await getPeriod(tx, params.id!, 'FOR UPDATE');
      if (p.status !== 'OPEN') fail('CASH_PERIOD_CLOSED', 'Period already closed');
      const latest = await tx.maybeOne<{ id: string; counted_millimes: number; submitted_at: string; difference_millimes: number }>('SELECT id, counted_millimes, submitted_at, difference_millimes FROM cash_counts WHERE period_id = $1 ORDER BY attempt_no DESC LIMIT 1', [p.id]);
      if (!latest) fail('CONFLICT', 'No count submitted for this period');
      if (latest!.id !== acceptedCountId) fail('CONFLICT', 'Only the latest count attempt can be accepted; earlier attempts stay on record');
      if (handover > latest!.counted_millimes) fail('VALIDATION_FAILED', 'Handover cannot exceed the counted amount');
      await tx.query(`UPDATE cash_periods SET status = 'CLOSED', cutoff_at = $2, closed_at = clock_timestamp(), closed_by = $3, accepted_count_id = $4, handover_millimes = $5, close_note = $6 WHERE id = $1`,
        [p.id, latest!.submitted_at, actor!.staffId, latest!.id, handover, note]);
      const next = await tx.one<{ id: string }>(`INSERT INTO cash_periods (clinic_id, drawer_id, period_no, opened_at, opened_by, opening_float_millimes, opening_basis, previous_period_id)
          VALUES ($1,$2,$3,$4,$5,$6,'COUNTED_CARRY_FORWARD',$7) RETURNING id`,
        [actor!.clinicId, p.drawer_id, p.period_no + 1, latest!.submitted_at, actor!.staffId, latest!.counted_millimes - handover, p.id]);
      await appendAudit(tx, actor!, 'cash.period_closed', 'cash_period', p.id, { acceptedCountId: latest!.id, differenceMillimes: latest!.difference_millimes, handoverMillimes: handover, nextPeriodId: next.id, nextOpeningFloatMillimes: latest!.counted_millimes - handover });
      return { status: 200, body: { closed: { id: p.id, cutoffAt: latest!.submitted_at, differenceMillimes: latest!.difference_millimes, handoverMillimes: handover }, nextPeriod: { id: next.id, periodNo: p.period_no + 1, openingFloatMillimes: latest!.counted_millimes - handover, openingBasis: 'COUNTED_CARRY_FORWARD' } } };
    },
  },
];
