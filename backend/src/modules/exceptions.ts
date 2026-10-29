/*
 * OWNER-EXCEPTIONS module (MF17): one evidence-rated list for the owner, computed on read from every evidence
 * root. Depends on (read-only): cash, card, paper, integrity, audit, settings, lab (MF19). Nothing depends on it.
 * Owns: exception_resolutions (append-only, one resolution per item, reason code required, NO bulk clear).
 *
 * Wording rule: items describe evidence, never a person ("count differs", "desk record only"); every item says
 * what is known, what is not, and the next owner step. "0 exceptions" never means "clean": the scope line says so.
 * Blindness rule: a CASH_COUNT_DUE item carries no expected figure.
 */
import { tableExists, type Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { asBody, str, optStr } from '../platform/validate.ts';
import { appendAudit } from './audit.ts';
import { clinicSettings, clinicTimezone, localDate } from './settings.ts';
import { reconcile } from './card.ts';
import { reconcileBook } from './paper.ts';
import { integrityCheck } from './integrity.ts';
import { labExceptionFacts } from './lab.ts';

export interface OwnerException {
  key: string; kind: string; evidence: 'VERIFIED_BY_OWNER' | 'DESK_RECORD_ONLY' | 'NO_INDEPENDENT_RECORD' | 'SYSTEM_CHECK';
  severity: 'HIGH' | 'MEDIUM' | 'INFO'; wording: string; known: string; unknown: string; nextStep: string; refs?: Record<string, unknown>;
}

/** What every exception source reads: the clinic, the as-of clinic day and its local midnight, and the clinic settings. */
interface ExceptionContext { tx: Tx; clinicId: string; asOf: string; asOfStart: number; settings: Awaited<ReturnType<typeof clinicSettings>> }
type ExceptionSource = (c: ExceptionContext) => Promise<OwnerException[]>;

/** CH-018: visit in the past, no dentist record, not cancelled/no-show; and desk-marked no-show / cancellation (hidden-visit risk, informational). */
const visitExceptions: ExceptionSource = async ({ tx, asOf, settings: { timezone } }) => {
  const out: OwnerException[] = [];
  const unresolved = (await tx.query<{ id: string; scheduled_at: string; file_no: number }>(`SELECT v.id, v.scheduled_at, p.file_no FROM visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.scheduled_at < ($1::date)::timestamp AT TIME ZONE $2 AND v.status NOT IN ('CANCELLED','NO_SHOW') AND NOT EXISTS (SELECT 1 FROM care_items c WHERE c.visit_id = v.id)`, [asOf, timezone])).rows;
  for (const v of unresolved) out.push({ key: `visit:${v.id}:no_dentist_record`, kind: 'VISIT_WITHOUT_DENTIST_RECORD', evidence: 'NO_INDEPENDENT_RECORD', severity: 'MEDIUM',
    wording: 'No dentist record for this past visit (unresolved)', known: `Visit scheduled ${v.scheduled_at} for file no. ${v.file_no}`, unknown: 'Whether care happened or payment was taken',
    nextStep: 'Dentist confirms care, or the visit is cancelled / marked no-show with a reason', refs: { visitId: v.id } });
  const deskMarked = (await tx.query<{ id: string; status: string; status_reason: string | null }>(`SELECT v.id, v.status, v.status_reason FROM visits v
      WHERE v.status IN ('NO_SHOW','CANCELLED') AND v.status_changed_at > ($1::date - 14)::timestamp AT TIME ZONE $2
        AND NOT EXISTS (SELECT 1 FROM staff_roles r WHERE r.staff_id = v.status_changed_by AND r.role IN ('DENTIST','OWNER'))`, [asOf, timezone])).rows;
  for (const v of deskMarked) out.push({ key: `visit:${v.id}:desk_marked_${v.status.toLowerCase()}`, kind: 'DESK_MARKED_' + v.status, evidence: 'DESK_RECORD_ONLY', severity: 'INFO',
    wording: `Visit marked ${v.status === 'NO_SHOW' ? 'no-show' : 'cancelled'} at the desk`, known: `Reason given: ${v.status_reason ?? '—'}`, unknown: 'Whether the patient actually came',
    nextStep: 'Spot-check with the dentist\'s own day list if unexpected', refs: { visitId: v.id } });
  return out;
};

/** Cash periods: count due, latest count differs, recounted. */
const cashExceptions: ExceptionSource = async ({ tx, asOfStart }) => {
  const out: OwnerException[] = [];
  if (!(await tableExists(tx, 'cash_counts'))) return out;
  const open = await tx.maybeOne<{ id: string; opened_at: string; n: number }>("SELECT p.id, p.opened_at, (SELECT count(*)::int FROM cash_counts c WHERE c.period_id = p.id) AS n FROM cash_periods p WHERE p.status = 'OPEN'");
  if (open && open.n === 0 && new Date(open.opened_at).getTime() < asOfStart - 86400_000) {
    out.push({ key: `cash:${open.id}:count_due`, kind: 'CASH_COUNT_DUE', evidence: 'SYSTEM_CHECK', severity: 'MEDIUM', wording: 'Drawer has not been counted for more than a day',
      known: `Period open since ${open.opened_at}`, unknown: 'Drawer content (blind until counted)', nextStep: 'Owner or dentist counts the drawer without looking at records first', refs: { periodId: open.id } });
  }
  const diffs = (await tx.query<{ id: string; period_id: string; attempt_no: number; difference_millimes: number; counter_independent: boolean }>(`SELECT DISTINCT ON (c.period_id) c.id, c.period_id, c.attempt_no, c.difference_millimes, c.counter_independent
      FROM cash_counts c ORDER BY c.period_id, c.attempt_no DESC`)).rows.filter(c => c.difference_millimes !== 0);
  for (const c of diffs) out.push({ key: `cash:${c.id}:count_differs`, kind: 'CASH_COUNT_DIFFERS', evidence: c.counter_independent ? 'VERIFIED_BY_OWNER' : 'DESK_RECORD_ONLY', severity: 'HIGH',
    wording: `Latest count differs from records by ${c.difference_millimes} millimes (review, not an accusation)`, known: `Attempt ${c.attempt_no}; counter ${c.counter_independent ? 'passed' : 'did not pass'} the software independence check`,
    unknown: 'Cause: unrecorded payment, error, float or removal', nextStep: 'Open the period review; compare with paper receipts', refs: { periodId: c.period_id, countId: c.id } });
  const multi = (await tx.query<{ period_id: string; n: number }>('SELECT period_id, count(*)::int AS n FROM cash_counts GROUP BY period_id HAVING count(*) > 1')).rows;
  for (const m of multi) out.push({ key: `cash:${m.period_id}:recounted`, kind: 'CASH_RECOUNTED', evidence: 'SYSTEM_CHECK', severity: 'INFO', wording: `Drawer counted ${m.n} times in one period`,
    known: 'All attempts are kept with reasons', unknown: 'Why the first count differed', nextStep: 'Read the recount reasons in the period review', refs: { periodId: m.period_id } });
  return out;
};

/** Card evidence (only once the owner has configured card reconciliation). */
const cardExceptions: ExceptionSource = async ({ tx, asOf }) => {
  const out: OwnerException[] = [];
  if (!(await tableExists(tx, 'clinic_card_settings')) || !(await tx.maybeOne('SELECT 1 FROM clinic_card_settings'))) return out;
  const r = await reconcile(tx, asOf);
  for (const c of r.claims.filter(c => c.exception)) out.push({ key: `card:${c.paymentId}:${c.status.toLowerCase()}`, kind: 'CARD_' + c.status, evidence: 'DESK_RECORD_ONLY', severity: c.status === 'OVERDUE_NO_STATEMENT_LINE' ? 'HIGH' : 'MEDIUM',
    wording: (c as { wording?: string }).wording ?? c.status, known: `Desk card record ${c.amountMillimes} millimes on ${c.date}`, unknown: 'Whether the money reached the clinic account',
    nextStep: 'Import the latest statement as owner, then confirm or reject the candidate line', refs: { paymentId: c.paymentId } });
  for (const l of r.statementLines) out.push({ key: `card:${l.statementLineId}:${l.status.toLowerCase()}`, kind: 'CARD_' + l.status, evidence: 'NO_INDEPENDENT_RECORD', severity: 'MEDIUM',
    wording: l.wording, known: `${l.amountMillimes} millimes on ${l.date}`, unknown: 'Which visit this money belongs to', nextStep: 'Find the visit / desk record', refs: { statementLineId: l.statementLineId } });
  if (r.importHealth.banner) out.push({ key: `card:import:stale`, kind: 'CARD_IMPORT_STALE', evidence: 'SYSTEM_CHECK', severity: 'MEDIUM', wording: r.importHealth.banner, known: `Imported through ${r.importHealth.statementImportedThrough ?? 'never'}`,
    unknown: 'Card settlements since then', nextStep: 'Owner imports the latest statement' });
  return out;
};

/** Paper books (outage slips not yet accounted for). */
const paperExceptions: ExceptionSource = async ({ tx }) => {
  const out: OwnerException[] = [];
  if (!(await tableExists(tx, 'paper_books'))) return out;
  for (const b of (await tx.query<{ id: string }>('SELECT id FROM paper_books')).rows) {
    const rec = await reconcileBook(tx, b.id);
    for (const i of rec.reviewItems) out.push({ key: `paper:${b.id}:${i.slip.toLowerCase().replace('-', '_')}_${i.kind.toLowerCase()}`, kind: 'PAPER_' + i.kind, evidence: 'NO_INDEPENDENT_RECORD', severity: i.kind === 'CONFLICT' ? 'HIGH' : 'MEDIUM',
      wording: i.wording, known: `Book ${rec.book.range}`, unknown: 'What was written on the paper slip', nextStep: 'Custodian checks the physical book and the patient copy', refs: { bookId: b.id, slip: i.slip } });
  }
  return out;
};

/** Denied privileged attempts (rate-limited counters). */
const securityExceptions: ExceptionSource = async ({ tx, asOf }) => {
  const out: OwnerException[] = [];
  for (const d of (await tx.query<{ staff_id: string; action: string; total: number }>("SELECT staff_id, action, sum(count)::int AS total FROM security_denials WHERE day > $1::date - 7 GROUP BY 1,2", [asOf])).rows) {
    out.push({ key: `security:${d.staff_id}:denied_${d.action.replace('.', '_')}`, kind: 'DENIED_PRIVILEGED_ATTEMPT', evidence: 'SYSTEM_CHECK', severity: 'INFO', wording: `${d.total} denied attempt(s) of "${d.action}" by a staff account in 7 days`,
      known: 'The account lacked the role; nothing was changed', unknown: 'Whether it was a mistake', nextStep: 'Mention it at the next staff check-in if repeated', refs: { staffId: d.staff_id, action: d.action } });
  }
  return out;
};

/** MF19 (R73-E): lab work implies a billable procedure; missing billing is evidence to look at, not a conclusion. */
const labExceptions: ExceptionSource = async ({ tx, asOfStart, settings: { labUnbilledDays } }) => {
  const out: OwnerException[] = [];
  const lab = await labExceptionFacts(tx, new Date(asOfStart).toISOString(), labUnbilledDays);
  for (const w of lab.work) out.push({ key: `lab:${w.id}:not_billed`, kind: 'LAB_WORK_NOT_BILLED', evidence: 'NO_INDEPENDENT_RECORD', severity: 'MEDIUM',
    wording: `Lab work received more than ${labUnbilledDays} days ago has no linked billed care item`,
    known: `${w.case_type} from ${w.supplier} for file no. ${w.file_no}; status ${w.status}; received ${new Date(w.received_at).toISOString()}`,
    unknown: 'Whether it was billed under a care item not linked yet, provided free of charge, or paid outside the system',
    nextStep: 'Dentist links the confirmed care item to the lab case, or the owner resolves with a reason', refs: { labCaseId: w.id } });
  for (const i of lab.invoices) out.push({ key: `lab_invoice:${i.id}:cases_not_billed`, kind: 'LAB_INVOICE_WITHOUT_BILLED_CARE', evidence: 'VERIFIED_BY_OWNER', severity: 'MEDIUM',
    wording: `Lab invoice ${i.invoice_number} covers ${i.unlinked} case(s) with no linked billed care item`,
    known: `Invoice from ${i.supplier} dated ${i.invoice_date}, ${i.amount_millimes} millimes (clinic expense)`,
    unknown: 'Whether the patient care was billed but not linked, or not billed',
    nextStep: 'Dentist links the care items, or the owner resolves with a reason', refs: { labInvoiceId: i.id } });
  return out;
};

/** Integrity findings (recomputation) and owner checkpoint cadence. */
const integrityExceptions: ExceptionSource = async ({ tx, clinicId, asOfStart, settings: { checkpointDueDays } }) => {
  const out: OwnerException[] = [];
  const integ = await integrityCheck(tx, clinicId, []);
  for (const f of integ.findings) out.push({ key: `integrity:${f.check.toLowerCase()}:finding`, kind: 'INTEGRITY_' + f.check, evidence: 'SYSTEM_CHECK', severity: 'HIGH', wording: f.detail, known: 'Detected by recomputation', unknown: 'Who changed the data outside the app', nextStep: 'Stop and compare with the latest owner checkpoint and backup' });
  const cp = await tx.maybeOne<{ at: string }>('SELECT max(created_at) AS at FROM audit_checkpoints');
  if (!cp?.at || new Date(cp.at).getTime() < asOfStart - checkpointDueDays * 86400_000) {
    out.push({ key: 'audit:checkpoint:due', kind: 'AUDIT_CHECKPOINT_DUE', evidence: 'SYSTEM_CHECK', severity: 'MEDIUM', wording: `No owner checkpoint in the last ${checkpointDueDays} days`, known: `Last checkpoint: ${cp?.at ?? 'never'}`,
      unknown: 'Changes since then are tamper-evident only inside the database', nextStep: 'Create a checkpoint and keep the printed line outside the clinic system' });
  }
  return out;
};

/** The owner list, in this order. A new evidence root is one source function and one entry here. */
const SOURCES: ExceptionSource[] = [visitExceptions, cashExceptions, cardExceptions, paperExceptions, securityExceptions, labExceptions, integrityExceptions];

export async function computeExceptions(tx: Tx, clinicId: string, asOf: string): Promise<OwnerException[]> {
  // R73-C: the as-of day is a CLINIC day; asOfStart = local midnight of asOf as an instant.
  const settings = await clinicSettings(tx, clinicId);
  const asOfStart = Date.parse((await tx.one<{ t: string }>('SELECT ($1::date)::timestamp AT TIME ZONE $2 AS t', [asOf, settings.timezone])).t);
  const out: OwnerException[] = [];
  for (const source of SOURCES) out.push(...await source({ tx, clinicId, asOf, asOfStart, settings }));
  return out;
}

export const exceptionRoutes: Route[] = [
  {
    method: 'GET', path: '/api/v1/owner/exceptions', permission: 'exceptions.read',
    handler: async ({ tx, actor, query }) => {
      const asOf = query.get('asOf') ?? localDate(await clinicTimezone(tx, actor!.clinicId));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail('VALIDATION_FAILED', 'asOf must be YYYY-MM-DD');
      const all = await computeExceptions(tx, actor!.clinicId, asOf);
      const resolved = (await tx.query<{ exception_key: string; reason_code: string }>('SELECT exception_key, reason_code FROM exception_resolutions')).rows;
      const done = new Map(resolved.map(r => [r.exception_key, r.reason_code]));
      const openItems = all.filter(e => !done.has(e.key));
      const order = { HIGH: 0, MEDIUM: 1, INFO: 2 } as const;
      openItems.sort((a, b) => order[a.severity] - order[b.severity] || a.key.localeCompare(b.key));
      const byReason: Record<string, number> = {};
      for (const e of all) { const r = done.get(e.key); if (r) byReason[r] = (byReason[r] ?? 0) + 1; }
      return { status: 200, body: { asOf, open: openItems, openCount: openItems.length, resolvedCountByReason: byReason,
        scope: 'Checks recorded entries only; unrecorded visits or payments cannot be assessed. Zero items does not mean nothing is wrong.' } };
    },
  },
  {
    // One item per call, reason code mandatory: there is deliberately no bulk "clear all" endpoint.
    method: 'POST', path: '/api/v1/owner/exceptions/resolve', permission: 'exceptions.resolve', idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const key = str(b, 'key', { max: 200, pattern: /^[a-z_]+:[0-9a-zA-Z_-]+:[a-z_]+$/ });
      const reasonCode = str(b, 'reasonCode', { min: 3, max: 40, pattern: /^[A-Z_]{3,40}$/ });
      const note = optStr(b, 'note', { max: 300 });
      const asOf = typeof b.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.asOf) ? b.asOf : localDate(await clinicTimezone(tx, actor!.clinicId));
      const items = await computeExceptions(tx, actor!.clinicId, asOf);
      if (!items.some(e => e.key === key)) fail('NOT_FOUND', 'No such open exception');
      const r = await tx.one<{ id: string }>('INSERT INTO exception_resolutions (clinic_id, exception_key, reason_code, note, resolved_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [actor!.clinicId, key, reasonCode, note, actor!.staffId]);
      await appendAudit(tx, actor!, 'exception.resolved', 'exception', key, { reasonCode, note });
      return { status: 201, body: { resolution: { id: r.id, key, reasonCode } } };
    },
  },
];
