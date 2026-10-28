/*
 * CARD-EVIDENCE module: owner statement import, replay/overlap/re-issue handling, candidate matching,
 * owner-confirmed links. Owns: clinic_card_settings, provider_settlement_events (read-only), statement_imports,
 * statement_lines, card_matches. Reads payments/adjustments (billing).
 *
 * C3 / CH-013 / C-148 / M-249 properties:
 *  - a desk card entry is a DESK_CLAIM; an owner-confirmed statement link is at most OWNER_REVIEWED_STATEMENT;
 *    PROVIDER_VERIFIED is unreachable (no authenticated provider source; DB check + no insert privilege);
 *  - a plain CSV is never treated as authenticated; its sha256 proves only "this file", not its origin;
 *  - total check: an owner-typed batch total read from the terminal/bank portal blocks edited files with a
 *    different net total; a total from a DESK-HANDLED slip is recorded as NOT independent (never silent);
 *  - replay: line key = date|amount|ref|occurrence; per (date, amount, ref) group only the surplus over already-stored
 *    lines is new, so re-import / renamed file / overlapping statement never double-counts;
 *  - re-issued statement that LACKS previously imported lines for days it covers is BLOCKED (owner may force with a
 *    reason; missing lines are then reported); reversal lines never satisfy a claim and always need review;
 *  - matching is never automatic: amount/date candidates are shown; if one line could belong to two claims, BOTH
 *    claims are AMBIGUOUS (order-independent; no first-wins consumption); one line links to at most one claim;
 *  - lag: within settlement_lag_days a claim is AWAITING_STATEMENT (not an exception); after that OVERDUE;
 *  - stale import banner when the newest imported period is older than import_stale_after_days;
 *  - privacy: only date/amount/ref/last-4 are stored; descriptions and non-card lines are discarded.
 * Residual (not detectable): owner who forges both file and slip total; cash taken while a coincidental genuine card
 * line matches a false claim; a card taken on a personal terminal (MF06 limit).
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, oneOf, isoDate, int, uuid, bool, optStr, parseTndToMillimes } from '../platform/validate.ts';
import { sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';

interface ParsedLine { date: string; amount: number; reversal: boolean; ref: string | null; last4: string | null }

export function parseStatementCsv(csv: string): { lines: ParsedLine[]; discarded: number } {
  const rows = csv.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (!rows.length) fail('VALIDATION_FAILED', 'Empty statement');
  const header = rows[0]!.split(',').map(h => h.trim().toLowerCase());
  const want = ['date', 'amount_tnd', 'type', 'terminal_ref', 'card_last4'];
  if (want.some((h, i) => header[i] !== h)) fail('VALIDATION_FAILED', `Statement header must start with: ${want.join(',')}`);
  const lines: ParsedLine[] = [];
  let discarded = 0;
  rows.slice(1).forEach((raw, i) => {
    const f = raw.split(',');
    const lineNo = i + 2;
    if (f.length < 5) fail('VALIDATION_FAILED', `Line ${lineNo}: expected at least 5 fields`, { line: lineNo });
    const [date, amt, type, ref, last4] = f.map(s => s.trim()) as [string, string, string, string, string];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + 'T00:00:00Z').getTime())) fail('VALIDATION_FAILED', `Line ${lineNo}: bad date`, { line: lineNo });
    const t = type.toUpperCase();
    if (t !== 'CARD' && t !== 'REVERSAL') { discarded++; return; } // non-card lines are never stored (privacy)
    let amount: number;
    try { amount = parseTndToMillimes(amt); } catch { return fail('VALIDATION_FAILED', `Line ${lineNo}: amount must be TND with at most 3 decimals`, { line: lineNo }); }
    if (amount <= 0) fail('VALIDATION_FAILED', `Line ${lineNo}: amount must be positive (use type REVERSAL for reversals)`, { line: lineNo });
    if (ref && !/^[A-Za-z0-9-]{1,40}$/.test(ref)) fail('VALIDATION_FAILED', `Line ${lineNo}: bad terminal_ref`, { line: lineNo });
    if (last4 && !/^[0-9]{4}$/.test(last4)) fail('VALIDATION_FAILED', `Line ${lineNo}: bad card_last4`, { line: lineNo });
    lines.push({ date, amount, reversal: t === 'REVERSAL', ref: ref || null, last4: last4 || null });
  });
  return { lines, discarded };
}

const groupKey = (l: { date: string; amount: number; ref: string | null; reversal: boolean }) => `${l.date}|${l.reversal ? 'R' : 'C'}${l.amount}|${l.ref ?? ''}`;

async function settings(tx: Tx) {
  const s = await tx.maybeOne<{ account_last4: string; settlement_lag_days: number; match_window_days: number; import_stale_after_days: number }>(
    'SELECT account_last4, settlement_lag_days, match_window_days, import_stale_after_days FROM clinic_card_settings');
  if (!s) fail('CONFLICT', 'Card settings not configured: the owner must set the clinic card account (last 4 digits) first');
  return s!;
}

const addDays = (d: string, n: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400_000).toISOString().slice(0, 10);
// UTC-midnight dates differ by exact multiples of 86,400,000 ms, so the division is exact (no rounding needed).
const daysBetween = (a: string, b: string) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400_000;

export async function reconcile(tx: Tx, asOf: string) {
  const s = await settings(tx);
  const claims = (await tx.query<{ id: string; amount_millimes: number; d: string; card_terminal_ref: string | null; card_last4: string | null; visit_id: string }>(
    `SELECT p.id, p.amount_millimes, (p.recorded_at AT TIME ZONE 'UTC')::date::text AS d, p.card_terminal_ref, p.card_last4, p.visit_id
       FROM payments p WHERE p.tender = 'CARD' AND (p.recorded_at AT TIME ZONE 'UTC')::date <= $1::date
        AND NOT EXISTS (SELECT 1 FROM adjustments a WHERE a.payment_id = p.id AND a.kind = 'PAYMENT_VOID')
      ORDER BY p.id`, [asOf])).rows;
  const matches = (await tx.query<{ payment_id: string; statement_line_id: string; evidence_tier: string }>('SELECT payment_id, statement_line_id, evidence_tier FROM card_matches')).rows;
  const matchedClaim = new Map(matches.map(m => [m.payment_id, m]));
  const matchedLine = new Set(matches.map(m => m.statement_line_id));
  const lines = (await tx.query<{ id: string; txn_date: string; amount_millimes: number; is_reversal: boolean; terminal_ref: string | null; card_last4: string | null; status: string }>(
    `SELECT l.id, l.txn_date::text AS txn_date, l.amount_millimes, l.is_reversal, l.terminal_ref, l.card_last4, i.status
       FROM statement_lines l JOIN statement_imports i ON i.id = l.import_id ORDER BY l.id`)).rows;
  const openLines = lines.filter(l => !l.is_reversal && !matchedLine.has(l.id));
  const open = claims.filter(c => !matchedClaim.has(c.id));
  const candidatesOf = new Map<string, typeof openLines>();
  const claimsOfLine = new Map<string, string[]>();
  for (const c of open) {
    const cs = openLines.filter(l => l.amount_millimes === c.amount_millimes && l.txn_date >= c.d && l.txn_date <= addDays(c.d, s.match_window_days));
    candidatesOf.set(c.id, cs);
    for (const l of cs) claimsOfLine.set(l.id, [...(claimsOfLine.get(l.id) ?? []), c.id]);
  }
  const warn = (st: string) => st === 'ACCEPTED_TOTAL_CHECKED' ? null : st === 'ACCEPTED_TOTAL_NOT_INDEPENDENT' ? 'batch total came from a desk-handled slip: not independent' : 'statement imported without an independent total: source not verified';
  const items = claims.map(c => {
    const m = matchedClaim.get(c.id);
    const age = daysBetween(c.d, asOf);
    if (m) return { paymentId: c.id, amountMillimes: c.amount_millimes, date: c.d, tier: m.evidence_tier, status: 'LINKED_BY_OWNER', exception: false, candidates: [] as unknown[] };
    const cs = candidatesOf.get(c.id) ?? [];
    if (!cs.length) {
      const overdue = age > s.settlement_lag_days;
      return { paymentId: c.id, amountMillimes: c.amount_millimes, date: c.d, tier: 'DESK_CLAIM', status: overdue ? 'OVERDUE_NO_STATEMENT_LINE' : 'AWAITING_STATEMENT', exception: overdue, ageDays: age,
        wording: overdue ? 'Desk record only — no statement line found (review, not an accusation)' : 'Awaiting statement', candidates: [] as unknown[] };
    }
    const ambiguous = cs.some(l => (claimsOfLine.get(l.id) ?? []).length > 1) || cs.length > 1;
    return {
      paymentId: c.id, amountMillimes: c.amount_millimes, date: c.d, tier: 'DESK_CLAIM', status: ambiguous ? 'AMBIGUOUS_REVIEW_NEEDED' : 'CANDIDATE_OWNER_CONFIRMS', exception: true, ageDays: age,
      wording: ambiguous ? 'Several records could match the same statement line(s) — owner review needed' : 'Possible statement line — owner confirms',
      candidates: cs.map(l => ({ statementLineId: l.id, date: l.txn_date, amountMillimes: l.amount_millimes,
        strength: (c.card_terminal_ref && c.card_terminal_ref === l.terminal_ref) || (c.card_last4 && c.card_last4 === l.card_last4) ? 'AMOUNT_DATE_PLUS_REFERENCE' : 'AMOUNT_DATE_ONLY',
        competingClaims: (claimsOfLine.get(l.id) ?? []).filter(x => x !== c.id), sourceWarning: warn(l.status) })),
    };
  });
  const lineItems = lines.filter(l => !matchedLine.has(l.id) && (l.is_reversal || !(claimsOfLine.get(l.id) ?? []).length)).map(l => ({
    statementLineId: l.id, date: l.txn_date, amountMillimes: l.amount_millimes,
    status: l.is_reversal ? 'STATEMENT_REVERSAL_REVIEW' : 'STATEMENT_LINE_UNMATCHED',
    wording: l.is_reversal ? 'Reversal on statement — owner review' : 'Money on statement with no matching desk record — owner review',
    sourceWarning: warn(l.status),
  }));
  const last = await tx.maybeOne<{ period_end: string }>("SELECT max(period_end)::text AS period_end FROM statement_imports WHERE status LIKE 'ACCEPTED%'");
  const lag = last?.period_end ? daysBetween(last.period_end, asOf) : null;
  return {
    asOf,
    tiers: { DESK_CLAIM: 'unverified desk record', OWNER_REVIEWED_STATEMENT: 'owner linked an imported statement line; file origin not verified', PROVIDER_VERIFIED: 'UNREACHABLE in v0.2: no authenticated provider source' },
    claims: items, statementLines: lineItems,
    importHealth: { statementImportedThrough: last?.period_end ?? null, daysBehind: lag,
      banner: lag === null ? 'No card statement imported yet' : lag > s.import_stale_after_days ? `Statement import is ${lag} days behind` : null },
    exceptionCount: items.filter(i => i.exception).length + lineItems.length,
    scope: 'Compares desk card records with owner-imported statements. A card taken on a personal terminal, or cash taken while a coincidental line matches, cannot be detected.',
  };
}

export const cardRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/card/settings', permission: 'card.import_statement', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const last4 = str(b, 'accountLast4', { min: 4, max: 4, pattern: /^[0-9]{4}$/ });
      const lag = int(b, 'settlementLagDays', 0, 30, true) ?? 2;
      const win = int(b, 'matchWindowDays', 1, 60, true) ?? 7;
      const stale = int(b, 'importStaleAfterDays', 1, 60, true) ?? 7;
      await tx.query(`INSERT INTO clinic_card_settings (clinic_id, account_last4, settlement_lag_days, match_window_days, import_stale_after_days, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (clinic_id) DO UPDATE SET account_last4 = EXCLUDED.account_last4, settlement_lag_days = EXCLUDED.settlement_lag_days, match_window_days = EXCLUDED.match_window_days,
          import_stale_after_days = EXCLUDED.import_stale_after_days, updated_by = EXCLUDED.updated_by, updated_at = now()`, [actor!.clinicId, last4, lag, win, stale, actor!.staffId]);
      await appendAudit(tx, actor!, 'card.settings_changed', 'clinic', actor!.clinicId, { accountLast4: last4, settlementLagDays: lag, matchWindowDays: win, importStaleAfterDays: stale });
      return { status: 200, body: { settings: { accountLast4: last4, settlementLagDays: lag, matchWindowDays: win, importStaleAfterDays: stale } } };
    },
  },
  {
    method: 'POST', path: '/api/v1/card/statement-imports', permission: 'card.import_statement', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const s = await settings(tx);
      const fileName = str(b, 'fileName', { max: 120 });
      if (typeof b.csv !== 'string' || b.csv.length > 50_000) fail('VALIDATION_FAILED', 'csv text (max 50 KB) is required');
      const csv = b.csv as string;
      const accountLast4 = str(b, 'accountLast4', { min: 4, max: 4, pattern: /^[0-9]{4}$/ });
      const periodStart = isoDate(b, 'periodStart')!;
      const periodEnd = isoDate(b, 'periodEnd')!;
      if (periodEnd < periodStart) fail('VALIDATION_FAILED', 'periodEnd before periodStart');
      const totalSource = oneOf(b, 'totalSource', ['OWNER_READ_TERMINAL', 'OWNER_READ_BANK_PORTAL', 'DESK_HANDLED_SLIP', 'NOT_PROVIDED'] as const)!;
      const declared = totalSource === 'NOT_PROVIDED' ? null : int(b, 'declaredTotalMillimes', -1_000_000_000, 1_000_000_000);
      const forceReason = optStr(b, 'forceOverlapReason', { max: 200 });
      const fileSha = sha256(csv);
      const { lines, discarded } = parseStatementCsv(csv);
      const net = lines.reduce((t, l) => t + (l.reversal ? -l.amount : l.amount), 0);
      const record = async (status: string, detail: Record<string, unknown>, linesNew = 0, known = 0) => {
        const i = await tx.one<{ id: string }>(`INSERT INTO statement_imports (clinic_id, imported_by, file_name, file_sha256, account_last4, period_start, period_end, card_line_count, discarded_non_card,
            file_net_total_millimes, declared_total_millimes, total_source, status, lines_new, lines_already_known, detail, forced_reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
          [actor!.clinicId, actor!.staffId, fileName, fileSha, accountLast4, periodStart, periodEnd, lines.length, discarded, net, declared, totalSource, status, linesNew, known, detail, forceReason]);
        await appendAudit(tx, actor!, 'card.statement_import', 'statement_import', i.id, { status, fileSha256: fileSha, cardLines: lines.length, linesNew, totalSource, declaredTotalMillimes: declared, fileNetTotalMillimes: net });
        return i.id;
      };
      // Scope (T-STMT-7): wrong account or dates outside the declared period -> rejected, nothing stored.
      const outOfPeriod = lines.filter(l => l.date < periodStart || l.date > periodEnd).length;
      if (accountLast4 !== s.account_last4 || outOfPeriod > 0) {
        const id = await record('REJECTED_SCOPE', { reason: accountLast4 !== s.account_last4 ? 'account does not match the clinic card account' : `${outOfPeriod} line(s) outside the declared period` });
        return { status: 422, body: { import: { id, status: 'REJECTED_SCOPE', linesNew: 0 }, error: { code: 'STATEMENT_SCOPE_REJECTED', message: 'Statement does not belong to the configured clinic account or period' } } };
      }
      // Total check (T-STMT-1 + M-249 forged-slip objection).
      if (declared !== null && declared !== net) {
        const id = await record('BLOCKED_TOTAL_MISMATCH', { differenceMillimes: net - declared });
        return { status: 422, body: { import: { id, status: 'BLOCKED_TOTAL_MISMATCH', linesNew: 0, differenceMillimes: net - declared }, error: { code: 'STATEMENT_TOTAL_MISMATCH', message: `File total differs from the batch total by ${net - declared} millimes` } } };
      }
      // Replay / overlap / re-issue (T-STMT-2 + M-249 re-issue objection).
      const existing = (await tx.query<{ txn_date: string; amount_millimes: number; terminal_ref: string | null; is_reversal: boolean; n: number }>(
        `SELECT txn_date::text AS txn_date, amount_millimes, terminal_ref, is_reversal, count(*)::int AS n FROM statement_lines
          WHERE txn_date BETWEEN $1 AND $2 GROUP BY 1,2,3,4`, [periodStart, periodEnd])).rows;
      const have = new Map(existing.map(e => [groupKey({ date: e.txn_date, amount: e.amount_millimes, ref: e.terminal_ref, reversal: e.is_reversal }), e.n]));
      const inFile = new Map<string, ParsedLine[]>();
      for (const l of lines) inFile.set(groupKey(l), [...(inFile.get(groupKey(l)) ?? []), l]);
      const missing: { group: string; previously: number; now: number }[] = [];
      for (const [k, n] of have) { const now = inFile.get(k)?.length ?? 0; if (now < n) missing.push({ group: k, previously: n, now }); }
      if (missing.length && !forceReason) {
        const id = await record('BLOCKED_OVERLAP_CONFLICT', { missing });
        return { status: 409, body: { import: { id, status: 'BLOCKED_OVERLAP_CONFLICT', linesNew: 0, missingFromThisFile: missing }, error: { code: 'STATEMENT_OVERLAP_CONFLICT', message: 'This statement covers days already imported but lacks some previously imported lines (re-issued or edited?). Owner review required; re-submit with forceOverlapReason to import new lines only.' } } };
      }
      const status = missing.length ? 'ACCEPTED_OVERLAP_FORCED'
        : totalSource === 'OWNER_READ_TERMINAL' || totalSource === 'OWNER_READ_BANK_PORTAL' ? 'ACCEPTED_TOTAL_CHECKED'
        : totalSource === 'DESK_HANDLED_SLIP' ? 'ACCEPTED_TOTAL_NOT_INDEPENDENT' : 'ACCEPTED_NO_TOTAL';
      let known = 0;
      const toInsert: (ParsedLine & { occ: number })[] = [];
      for (const [k, group] of inFile) {
        const already = have.get(k) ?? 0;
        known += Math.min(already, group.length);
        group.slice(already).forEach((l, i) => toInsert.push({ ...l, occ: already + i + 1 }));
      }
      const id = await record(status, { missing }, toInsert.length, known);
      for (const l of toInsert) {
        await tx.query(`INSERT INTO statement_lines (clinic_id, import_id, line_key, txn_date, amount_millimes, is_reversal, terminal_ref, card_last4, occurrence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [actor!.clinicId, id, `${groupKey(l)}|${l.occ}`, l.date, l.amount, l.reversal, l.ref, l.last4, l.occ]);
      }
      const warning = status === 'ACCEPTED_TOTAL_CHECKED' ? null : status === 'ACCEPTED_TOTAL_NOT_INDEPENDENT' ? 'Batch total came from a desk-handled slip: NOT an independent check' : status === 'ACCEPTED_NO_TOTAL' ? 'No batch total: source not verified' : 'Imported over a conflicting earlier statement; missing lines need owner review';
      return { status: 201, body: { import: { id, status, fileSha256: fileSha, cardLines: lines.length, linesNew: toInsert.length, linesAlreadyKnown: known, discardedNonCard: discarded, missingFromThisFile: missing }, evidenceTierReachable: 'OWNER_REVIEWED_STATEMENT', warning } };
    },
  },
  {
    method: 'GET', path: '/api/v1/card/reconciliation', permission: 'card.review',
    handler: async ({ tx, query }) => {
      const asOf = query.get('asOf') ?? new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail('VALIDATION_FAILED', 'asOf must be YYYY-MM-DD');
      return { status: 200, body: await reconcile(tx, asOf) };
    },
  },
  {
    method: 'POST', path: '/api/v1/card/matches', permission: 'card.review', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      if (b.evidenceTier !== undefined && b.evidenceTier !== 'OWNER_REVIEWED_STATEMENT') {
        fail('VALIDATION_FAILED', 'PROVIDER_VERIFIED requires an authenticated provider source; none exists in v0.2');
      }
      const paymentId = uuid(b, 'paymentId');
      const lineId = uuid(b, 'statementLineId');
      const note = optStr(b, 'note', { max: 300 });
      const asOf = new Date().toISOString().slice(0, 10);
      const rec = await reconcile(tx, asOf);
      const claim = rec.claims.find(c => c.paymentId === paymentId);
      if (!claim) fail('NOT_FOUND', 'Card claim not found');
      if (claim!.status === 'LINKED_BY_OWNER') fail('CONFLICT', 'Claim already linked');
      const cand = (claim!.candidates as { statementLineId: string; competingClaims: string[]; strength: string }[]).find(c => c.statementLineId === lineId);
      if (!cand) fail('CONFLICT', 'This statement line is not a candidate for this claim (amount/date window) or is already used');
      if (claim!.status === 'AMBIGUOUS_REVIEW_NEEDED' && !bool(b, 'ambiguityAcknowledged')) {
        fail('CONFLICT', 'Ambiguous: other records compete for this line; re-submit with ambiguityAcknowledged after checking the paper slip / patient', { competingClaims: cand!.competingClaims });
      }
      const m = await tx.one<{ id: string }>(`INSERT INTO card_matches (clinic_id, payment_id, statement_line_id, evidence_tier, basis, note, confirmed_by)
          VALUES ($1,$2,$3,'OWNER_REVIEWED_STATEMENT',$4,$5,$6) RETURNING id`, [actor!.clinicId, paymentId, lineId, cand!.strength + (claim!.status === 'AMBIGUOUS_REVIEW_NEEDED' ? '+AMBIGUITY_ACKNOWLEDGED' : ''), note, actor!.staffId]);
      await appendAudit(tx, actor!, 'card.match_confirmed', 'card_match', m.id, { paymentId, statementLineId: lineId, tier: 'OWNER_REVIEWED_STATEMENT', basis: cand!.strength, ambiguous: claim!.status === 'AMBIGUOUS_REVIEW_NEEDED' });
      return { status: 201, body: { match: { id: m.id, paymentId, statementLineId: lineId, evidenceTier: 'OWNER_REVIEWED_STATEMENT', basis: cand!.strength } } };
    },
  },
];
