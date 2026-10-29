/*
 * PAPER-OUTAGE module: numbered paper books (custody), slip re-entry after an outage, void/unused declarations,
 * sequence reconciliation. Owns: paper_books, paper_slip_entries. Uses billing.recordPayment (no electronic receipt).
 *
 * C6 / C-146 properties:
 *  - each genuine paper payment posts ONCE (unique effective entry per slip + unique payment per entry);
 *  - re-entering a slip with identical content -> DUPLICATE_ENTRY (kept as evidence, 0 payments, owner review);
 *  - re-entering with different content -> CONFLICT (both kept, neither overwrites, owner review, neutral wording);
 *  - a VOID slip counts 0 and stays in the sequence; a VOID with an amount is rejected;
 *  - unused numbers are declared by the custodian (dentist) or owner, never by the desk;
 *  - any number neither used, void nor declared unused is reported "slip number not accounted for";
 *  - paper slips (P-nnn) never consume electronic receipt numbers (R-nnnnnn).
 * Residual (C-146 Mode B): a slip never written, or a paper amount differing from the patient's copy, is invisible
 * to the app (needs a carbon/duplicate patient copy — ASSUMPTION).
 *
 * B13 additions:
 *  - CH-030: a USED slip may carry the patient file number written on the paper; it must match the visit's patient
 *    (else REJECTED PAPER_SLIP_PATIENT_MISMATCH). Without it the slip is a NO_PATIENT_REFERENCE review item.
 *    The number joins the content hash only when present, so PR #8 replays stay DUPLICATE_ENTRY;
 *  - CH-029: the reconciliation compares every posted slip with the care charged on its visit (careVsSlips) and,
 *    given an outage window (max 7 days), lists care with no slip and no payment at all;
 *  - review items DATE_DIFFERS_FROM_VISIT and MULTIPLE_SLIPS_ONE_VISIT (legitimate cases exist; human check).
 */
import { advisoryLock, type Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { AppError, fail } from '../platform/errors.ts';
import { asBody, int, uuid, isUuid, oneOf, optStr, isoDate, millimes } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';
import { PgError } from '../platform/postgres.ts';
import { recordPayment } from './billing.ts';
import { clinicTimezone } from './settings.ts';

export const slipLabel = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

async function getBook(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Paper book not found');
  const b = await tx.maybeOne<{ id: string; prefix: string; first_no: number; last_no: number; custodian_staff_id: string }>(
    'SELECT id, prefix, first_no, last_no, custodian_staff_id FROM paper_books WHERE id = $1', [id]);
  if (!b) fail('NOT_FOUND', 'Paper book not found');
  return b!;
}

const MAX_OUTAGE_DAYS = 7;
export interface OutageWindow { from: string; to: string }

/** Parse ?outageFrom&outageTo (ISO instants). Both or neither; at most 7 days. */
export function outageWindow(query: URLSearchParams): OutageWindow | null {
  const from = query.get('outageFrom'), to = query.get('outageTo');
  if (from === null && to === null) return null;
  const f = Date.parse(from ?? ''), t = Date.parse(to ?? '');
  if (!from || !to || Number.isNaN(f) || Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(from) || !/^\d{4}-\d{2}-\d{2}T/.test(to)) fail('VALIDATION_FAILED', 'outageFrom and outageTo must both be ISO timestamps', { field: 'outageFrom' });
  if (t <= f) fail('VALIDATION_FAILED', 'outageTo must be after outageFrom', { field: 'outageTo' });
  if (t - f > MAX_OUTAGE_DAYS * 86400_000) fail('VALIDATION_FAILED', `outage window longer than ${MAX_OUTAGE_DAYS} days`, { field: 'outageTo' });
  return { from: new Date(f).toISOString(), to: new Date(t).toISOString() };
}

export async function reconcileBook(tx: Tx, bookId: string, window: OutageWindow | null = null) {
  const book = await getBook(tx, bookId);
  const entries = (await tx.query<{ slip_no: number; entry_kind: string; classification: string; amount_millimes: number; entered_at: string }>(
    'SELECT slip_no, entry_kind, classification, amount_millimes, entered_at FROM paper_slip_entries WHERE book_id = $1 ORDER BY slip_no, entered_at', [book.id])).rows;
  const effective = new Map<number, { kind: string; amount: number }>();
  const dup = new Map<number, number>(), conflict = new Map<number, number>();
  for (const e of entries) {
    if (e.classification === 'DUPLICATE_ENTRY') dup.set(e.slip_no, (dup.get(e.slip_no) ?? 0) + 1);
    else if (e.classification === 'CONFLICT') conflict.set(e.slip_no, (conflict.get(e.slip_no) ?? 0) + 1);
    else effective.set(e.slip_no, { kind: e.entry_kind, amount: e.amount_millimes });
  }
  const L = (n: number) => slipLabel(book.prefix, n);
  const used: string[] = [], voids: string[] = [], unused: string[] = [], unaccounted: string[] = [];
  let posted = 0;
  for (let n = book.first_no; n <= book.last_no; n++) {
    const e = effective.get(n);
    if (!e) unaccounted.push(L(n));
    else if (e.kind === 'USED') { used.push(L(n)); posted += e.amount; }
    else if (e.kind === 'VOID') voids.push(L(n));
    else unused.push(L(n));
  }
  // CH-029: every posted slip next to the care charged on its visit (one statement for the whole book).
  type SlipVisit = { slipNo: number; visitId: string; fileNo: number; slipPatientFileNo: number | null; writtenOn: string | null; visitLocalDate: string;
    paidBySlipMillimes: number; chargedMillimes: number; paidMillimes: number; reducedMillimes: number; returnedMillimes: number };
  const sv = (await tx.query<SlipVisit>(`SELECT e.slip_no AS "slipNo", e.visit_id AS "visitId", p.file_no AS "fileNo", e.patient_file_no AS "slipPatientFileNo",
      e.written_on::text AS "writtenOn", (v.scheduled_at AT TIME ZONE $2)::date::text AS "visitLocalDate",
      e.amount_millimes AS "paidBySlipMillimes", b.charged_millimes AS "chargedMillimes", b.paid_millimes AS "paidMillimes",
      b.reduced_millimes AS "reducedMillimes", b.returned_millimes AS "returnedMillimes"
    FROM paper_slip_entries e JOIN visits v ON v.clinic_id = e.clinic_id AND v.id = e.visit_id JOIN patients p ON p.clinic_id = v.clinic_id AND p.id = v.patient_id
    JOIN visit_balances b ON b.visit_id = v.id
    WHERE e.book_id = $1 AND e.classification = 'POSTED' ORDER BY e.slip_no`, [book.id, await clinicTimezone(tx, tx.clinicId!)])).rows;
  const slipsPerVisit = new Map<string, number[]>();
  for (const r of sv) slipsPerVisit.set(r.visitId, [...(slipsPerVisit.get(r.visitId) ?? []), r.slipNo]);
  const slipRows = sv.map(r => {
    const bySlipsOnVisit = sv.filter(x => x.visitId === r.visitId).reduce((s, x) => s + Number(x.paidBySlipMillimes), 0);
    return { slip: L(r.slipNo), visitId: r.visitId, fileNo: r.fileNo, slipPatientFileNo: r.slipPatientFileNo, writtenOn: r.writtenOn, visitLocalDate: r.visitLocalDate,
      chargedMillimes: Number(r.chargedMillimes), paidBySlipMillimes: Number(r.paidBySlipMillimes), paidOtherwiseMillimes: Number(r.paidMillimes) - bySlipsOnVisit,
      balanceMillimes: Number(r.chargedMillimes) - Number(r.paidMillimes) - Number(r.reducedMillimes) + Number(r.returnedMillimes) };
  });
  const perVisit = new Map(slipRows.map(r => [r.visitId, r]));
  const careVsSlips = {
    slips: slipRows,
    totals: { slips: slipRows.length, visits: perVisit.size, slipTotalMillimes: slipRows.reduce((s, r) => s + r.paidBySlipMillimes, 0),
      chargedMillimes: [...perVisit.values()].reduce((s, r) => s + r.chargedMillimes, 0), paidOtherwiseMillimes: [...perVisit.values()].reduce((s, r) => s + r.paidOtherwiseMillimes, 0),
      balanceMillimes: [...perVisit.values()].reduce((s, r) => s + r.balanceMillimes, 0) },
    wording: 'Slip amounts next to the care charged on the same visit. A partial payment or a later desk payment is normal; the patient copy is the reference.',
  };
  // Care recorded during the outage with no slip and no payment at all (only when the owner gives the window).
  const careWithoutPayment = window ? {
    window,
    visits: (await tx.query<{ visitId: string; fileNo: number; scheduledAt: string; chargedMillimes: number; balanceMillimes: number }>(`SELECT v.id AS "visitId", p.file_no AS "fileNo", v.scheduled_at AS "scheduledAt",
        b.charged_millimes AS "chargedMillimes", (b.charged_millimes - b.paid_millimes - b.reduced_millimes + b.returned_millimes)::bigint AS "balanceMillimes"
      FROM visits v JOIN visit_balances b ON b.visit_id = v.id JOIN patients p ON p.clinic_id = v.clinic_id AND p.id = v.patient_id
      WHERE v.clinic_id = $1 AND v.scheduled_at >= $2::timestamptz AND v.scheduled_at < $3::timestamptz AND b.charged_millimes > 0 AND b.paid_millimes = 0
      ORDER BY v.scheduled_at, v.id`, [tx.clinicId, window.from, window.to])).rows.map(v => ({ ...v, chargedMillimes: Number(v.chargedMillimes), balanceMillimes: Number(v.balanceMillimes) })),
  } : null;
  const reviewItems = [
    ...[...dup.keys()].map(n => ({ slip: L(n), kind: 'DUPLICATE_ENTRY', wording: `Slip ${L(n)} was entered more than once (no extra payment created)` })),
    ...[...conflict.keys()].map(n => ({ slip: L(n), kind: 'CONFLICT', wording: `Two records share slip ${L(n)} — owner review` })),
    ...unaccounted.map(s => ({ slip: s, kind: 'NOT_ACCOUNTED_FOR', wording: `Slip ${s} not accounted for` })),
    ...slipRows.filter(r => r.slipPatientFileNo === null).map(r => ({ slip: r.slip, kind: 'NO_PATIENT_REFERENCE',
      wording: `Slip ${r.slip} was linked to file no. ${r.fileNo} without a file number from the paper — check against the patient copy` })),
    ...slipRows.filter(r => r.writtenOn !== null && r.writtenOn !== r.visitLocalDate).map(r => ({ slip: r.slip, kind: 'DATE_DIFFERS_FROM_VISIT',
      wording: `Slip ${r.slip} is dated ${r.writtenOn}; its visit is on ${r.visitLocalDate}` })),
    ...[...slipsPerVisit.entries()].filter(([, ns]) => ns.length > 1).map(([, ns]) => ({ slip: L(ns[0]!), kind: 'MULTIPLE_SLIPS_ONE_VISIT',
      wording: `Slips ${ns.map(L).join(', ')} are all linked to one visit (instalments are possible) — check the patient copies` })),
    ...(careWithoutPayment?.visits ?? []).map(v => ({ slip: '—', kind: 'CARE_WITHOUT_SLIP_OR_PAYMENT',
      wording: `File no. ${v.fileNo}: care recorded during the outage window with no slip and no payment yet` })),
  ];
  return { book: { id: book.id, range: `${L(book.first_no)}..${L(book.last_no)}`, custodianStaffId: book.custodian_staff_id }, used, void: voids, unusedDeclared: unused, unaccounted, postedTotalMillimes: posted, reviewItems,
    careVsSlips, careWithoutPayment,
    scope: 'Checks entered slips only. A payment never written on a slip cannot be detected. The paper slip and the patient copy remain the reference.' };
}

export const paperRoutes: Route[] = [
  {
    method: 'POST', path: '/api/v1/paper-books', permission: 'paper.issue_book', reauth: true, idempotent: true,
    handler: async ({ tx, actor, body }) => {
      const b = asBody(body);
      const first = int(b, 'firstNo', 1, 99_999)!;
      const last = int(b, 'lastNo', 1, 99_999)!;
      if (last < first || last - first >= 1000) fail('VALIDATION_FAILED', 'Invalid slip range');
      const custodian = uuid(b, 'custodianStaffId');
      const cust = await tx.maybeOne(`SELECT 1 FROM staff s JOIN staff_roles r ON r.staff_id = s.id AND r.role IN ('DENTIST','OWNER') WHERE s.id = $1 AND s.active`, [custodian]);
      if (!cust) fail('VALIDATION_FAILED', 'Custodian must be an active dentist or owner (never the desk)', { field: 'custodianStaffId' });
      await advisoryLock(tx, 'paper_books', actor!.clinicId);
      const overlap = await tx.maybeOne("SELECT id FROM paper_books WHERE prefix = 'P' AND int4range(first_no, last_no, '[]') && int4range($1, $2, '[]')", [first, last]);
      if (overlap) fail('CONFLICT', 'Slip numbers overlap an existing book');
      const book = await tx.one<{ id: string }>("INSERT INTO paper_books (clinic_id, prefix, first_no, last_no, custodian_staff_id, issued_by, note) VALUES ($1,'P',$2,$3,$4,$5,$6) RETURNING id",
        [actor!.clinicId, first, last, custodian, actor!.staffId, optStr(b, 'note', { max: 200 })]);
      await appendAudit(tx, actor!, 'paper.book_issued', 'paper_book', book.id, { firstNo: first, lastNo: last, custodianStaffId: custodian });
      return { status: 201, body: { book: { id: book.id, range: `${slipLabel('P', first)}..${slipLabel('P', last)}`, custodianStaffId: custodian } } };
    },
  },
  {
    // Re-entry after an outage. Each slip is isolated with a SAVEPOINT, so one bad slip never blocks the others.
    method: 'POST', path: '/api/v1/paper-books/:id/entries', permission: 'paper.enter_slips', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const book = await getBook(tx, params.id!);
      if (!Array.isArray(b.slips) || b.slips.length === 0 || b.slips.length > 200) fail('VALIDATION_FAILED', 'slips must be a non-empty array (max 200)');
      const results: Record<string, unknown>[] = [];
      for (const raw of b.slips as unknown[]) {
        const s = asBody(raw);
        const slipNo = int(s, 'slipNo', 1, 99_999)!;
        const label = slipLabel(book.prefix, slipNo);
        if (slipNo < book.first_no || slipNo > book.last_no) { results.push({ slip: label, outcome: 'REJECTED', code: 'PAPER_SLIP_OUT_OF_RANGE' }); continue; }
        const kind = oneOf(s, 'kind', ['USED', 'VOID'] as const)!;
        const note = optStr(s, 'note', { max: 200 });
        let amount = 0, tender: 'CASH' | 'CARD' | null = null, visitId: string | null = null, writtenOn: string | null = null, patientFileNo: number | null = null;
        if (kind === 'VOID') {
          if (s.amountMillimes !== undefined && s.amountMillimes !== 0) { results.push({ slip: label, outcome: 'REJECTED', code: 'PAPER_VOID_WITH_AMOUNT', message: 'A void slip cannot carry an amount' }); continue; }
          if (!note || note.length < 3) { results.push({ slip: label, outcome: 'REJECTED', code: 'VALIDATION_FAILED', message: 'A void slip needs a reason' }); continue; }
        } else {
          amount = millimes(s, 'amountMillimes');
          tender = oneOf(s, 'tender', ['CASH', 'CARD'] as const)!;
          visitId = uuid(s, 'visitId');
          writtenOn = isoDate(s, 'writtenOn', true);
          patientFileNo = int(s, 'patientFileNo', 1, 99_999_999, true) ?? null;
          // Visit of this clinic only (RLS); an unknown visit rejects this slip alone, never the whole batch (B13).
          const owner = await tx.maybeOne<{ file_no: number }>('SELECT p.file_no FROM visits v JOIN patients p ON p.clinic_id = v.clinic_id AND p.id = v.patient_id WHERE v.id = $1', [visitId]);
          if (!owner) { results.push({ slip: label, outcome: 'REJECTED', code: 'NOT_FOUND', message: 'Visit not found in this clinic' }); continue; }
          // CH-030: the file number copied from the paper must belong to the visit's patient.
          if (patientFileNo !== null && owner.file_no !== patientFileNo) {
            results.push({ slip: label, outcome: 'REJECTED', code: 'PAPER_SLIP_PATIENT_MISMATCH', message: `The paper names file no. ${patientFileNo}; this visit belongs to file no. ${owner.file_no}. Find the right visit.` });
            continue;
          }
        }
        const contentHash = sha256(canonicalJson({ slipNo, kind, amount, tender, visitId, writtenOn, ...(patientFileNo !== null ? { patientFileNo } : {}) }));
        const prior = await tx.maybeOne<{ content_hash: string; id: string }>(
          "SELECT content_hash, id FROM paper_slip_entries WHERE book_id = $1 AND slip_no = $2 AND classification IN ('POSTED','VOID_RECORDED','UNUSED_DECLARED')", [book.id, slipNo]);
        if (prior) {
          const cls = prior.content_hash === contentHash ? 'DUPLICATE_ENTRY' : 'CONFLICT';
          const e = await tx.one<{ id: string }>(`INSERT INTO paper_slip_entries (clinic_id, book_id, slip_no, entry_kind, amount_millimes, tender, visit_id, written_on, note, classification, content_hash, entered_by, patient_file_no)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [actor!.clinicId, book.id, slipNo, kind, amount, tender, visitId, writtenOn, note, cls, contentHash, actor!.staffId, patientFileNo]);
          await appendAudit(tx, actor!, 'paper.slip_entry_flagged', 'paper_slip_entry', e.id, { slip: label, classification: cls, effectiveEntryId: prior.id });
          results.push({ slip: label, outcome: cls, paymentsCreated: 0, wording: cls === 'CONFLICT' ? `Two records share slip ${label} — owner review` : `Slip ${label} already entered — no new payment` });
          continue;
        }
        await tx.query('SAVEPOINT slip');
        try {
          const cls = kind === 'VOID' ? 'VOID_RECORDED' : 'POSTED';
          const e = await tx.one<{ id: string }>(`INSERT INTO paper_slip_entries (clinic_id, book_id, slip_no, entry_kind, amount_millimes, tender, visit_id, written_on, note, classification, content_hash, entered_by, patient_file_no)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [actor!.clinicId, book.id, slipNo, kind, amount, tender, visitId, writtenOn, note, cls, contentHash, actor!.staffId, patientFileNo]);
          let paymentId: string | null = null;
          if (kind === 'USED') {
            const r = await recordPayment(tx, actor!, { visitId: visitId!, amountMillimes: amount, tender: tender!, source: 'PAPER_OUTAGE', issueReceipt: false, paperSlipEntryId: e.id });
            paymentId = r.payment.id;
          }
          await appendAudit(tx, actor!, kind === 'VOID' ? 'paper.slip_voided' : 'paper.slip_posted', 'paper_slip_entry', e.id, { slip: label, amountMillimes: amount, tender, visitId, paymentId, patientFileNo });
          await tx.query('RELEASE SAVEPOINT slip');
          results.push({ slip: label, outcome: cls, paymentId, paymentsCreated: paymentId ? 1 : 0 });
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT slip');
          if (err instanceof AppError) results.push({ slip: label, outcome: 'REJECTED', code: err.code, message: err.message });
          else if (err instanceof PgError && err.code === '23505') results.push({ slip: label, outcome: 'REJECTED', code: 'CONFLICT', message: 'Slip entered concurrently by another request; re-submit to classify it' });
          else throw err;
        }
      }
      const summary = { posted: results.filter(r => r.outcome === 'POSTED').length, flagged: results.filter(r => r.outcome === 'DUPLICATE_ENTRY' || r.outcome === 'CONFLICT').length, rejected: results.filter(r => r.outcome === 'REJECTED').length };
      return { status: 200, body: { results, summary, note: 'Paper slips are their own numbered series (P-nnn); no electronic receipt number was used.' } };
    },
  },
  {
    method: 'POST', path: '/api/v1/paper-books/:id/declare-unused', permission: 'paper.custody', idempotent: true,
    handler: async ({ tx, actor, params, body }) => {
      const b = asBody(body);
      const book = await getBook(tx, params.id!);
      if (book.custodian_staff_id !== actor!.staffId && !actor!.roles.includes('OWNER')) fail('FORBIDDEN_ROLE', 'Only the book custodian or the owner can declare unused slips');
      if (!Array.isArray(b.slipNos) || !b.slipNos.length) fail('VALIDATION_FAILED', 'slipNos required');
      const done: string[] = [], skipped: string[] = [];
      for (const raw of b.slipNos as unknown[]) {
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < book.first_no || raw > book.last_no) fail('PAPER_SLIP_OUT_OF_RANGE', `Slip ${String(raw)} is not in this book`);
        const n = raw as number;
        const exists = await tx.maybeOne("SELECT 1 FROM paper_slip_entries WHERE book_id = $1 AND slip_no = $2 AND classification IN ('POSTED','VOID_RECORDED','UNUSED_DECLARED')", [book.id, n]);
        if (exists) { skipped.push(slipLabel(book.prefix, n as number)); continue; }
        const e = await tx.one<{ id: string }>(`INSERT INTO paper_slip_entries (clinic_id, book_id, slip_no, entry_kind, classification, content_hash, entered_by)
            VALUES ($1,$2,$3,'UNUSED','UNUSED_DECLARED',$4,$5) RETURNING id`, [actor!.clinicId, book.id, n, sha256(canonicalJson({ slipNo: n, kind: 'UNUSED' })), actor!.staffId]);
        await appendAudit(tx, actor!, 'paper.slip_declared_unused', 'paper_slip_entry', e.id, { slip: slipLabel(book.prefix, n as number) });
        done.push(slipLabel(book.prefix, n as number));
      }
      return { status: 200, body: { declaredUnused: done, alreadyAccountedFor: skipped } };
    },
  },
  {
    method: 'GET', path: '/api/v1/paper-books/:id/reconciliation', permission: 'paper.read',
    handler: async ({ tx, params, query }) => ({ status: 200, body: await reconcileBook(tx, params.id!, outageWindow(query)) }),
  },
];
