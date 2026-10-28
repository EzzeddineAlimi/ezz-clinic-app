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
 */
import type { Tx } from '../platform/db.ts';
import type { Route } from '../platform/http.ts';
import { AppError, fail } from '../platform/errors.ts';
import { asBody, int, uuid, isUuid, oneOf, optStr, isoDate, millimes } from '../platform/validate.ts';
import { canonicalJson, sha256 } from '../platform/canonical.ts';
import { appendAudit } from './audit.ts';
import { PgError } from '../platform/pgwire.ts';
import { recordPayment } from './billing.ts';

export const slipLabel = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

async function getBook(tx: Tx, id: string) {
  if (!isUuid(id)) fail('NOT_FOUND', 'Paper book not found');
  const b = await tx.maybeOne<{ id: string; prefix: string; first_no: number; last_no: number; custodian_staff_id: string }>(
    'SELECT id, prefix, first_no, last_no, custodian_staff_id FROM paper_books WHERE id = $1', [id]);
  if (!b) fail('NOT_FOUND', 'Paper book not found');
  return b!;
}

export async function reconcileBook(tx: Tx, bookId: string) {
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
  const reviewItems = [
    ...[...dup.keys()].map(n => ({ slip: L(n), kind: 'DUPLICATE_ENTRY', wording: `Slip ${L(n)} was entered more than once (no extra payment created)` })),
    ...[...conflict.keys()].map(n => ({ slip: L(n), kind: 'CONFLICT', wording: `Two records share slip ${L(n)} — owner review` })),
    ...unaccounted.map(s => ({ slip: s, kind: 'NOT_ACCOUNTED_FOR', wording: `Slip ${s} not accounted for` })),
  ];
  return { book: { id: book.id, range: `${L(book.first_no)}..${L(book.last_no)}`, custodianStaffId: book.custodian_staff_id }, used, void: voids, unusedDeclared: unused, unaccounted, postedTotalMillimes: posted, reviewItems,
    scope: 'Checks entered slips only. A payment never written on a slip cannot be detected.' };
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
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('paper_books:' || $1))", [actor!.clinicId]);
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
        let amount = 0, tender: 'CASH' | 'CARD' | null = null, visitId: string | null = null, writtenOn: string | null = null;
        if (kind === 'VOID') {
          if (s.amountMillimes !== undefined && s.amountMillimes !== 0) { results.push({ slip: label, outcome: 'REJECTED', code: 'PAPER_VOID_WITH_AMOUNT', message: 'A void slip cannot carry an amount' }); continue; }
          if (!note || note.length < 3) { results.push({ slip: label, outcome: 'REJECTED', code: 'VALIDATION_FAILED', message: 'A void slip needs a reason' }); continue; }
        } else {
          amount = millimes(s, 'amountMillimes');
          tender = oneOf(s, 'tender', ['CASH', 'CARD'] as const)!;
          visitId = uuid(s, 'visitId');
          writtenOn = isoDate(s, 'writtenOn', true);
        }
        const contentHash = sha256(canonicalJson({ slipNo, kind, amount, tender, visitId, writtenOn }));
        const prior = await tx.maybeOne<{ content_hash: string; id: string }>(
          "SELECT content_hash, id FROM paper_slip_entries WHERE book_id = $1 AND slip_no = $2 AND classification IN ('POSTED','VOID_RECORDED','UNUSED_DECLARED')", [book.id, slipNo]);
        if (prior) {
          const cls = prior.content_hash === contentHash ? 'DUPLICATE_ENTRY' : 'CONFLICT';
          const e = await tx.one<{ id: string }>(`INSERT INTO paper_slip_entries (clinic_id, book_id, slip_no, entry_kind, amount_millimes, tender, visit_id, written_on, note, classification, content_hash, entered_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [actor!.clinicId, book.id, slipNo, kind, amount, tender, visitId, writtenOn, note, cls, contentHash, actor!.staffId]);
          await appendAudit(tx, actor!, 'paper.slip_entry_flagged', 'paper_slip_entry', e.id, { slip: label, classification: cls, effectiveEntryId: prior.id });
          results.push({ slip: label, outcome: cls, paymentsCreated: 0, wording: cls === 'CONFLICT' ? `Two records share slip ${label} — owner review` : `Slip ${label} already entered — no new payment` });
          continue;
        }
        await tx.query('SAVEPOINT slip');
        try {
          const cls = kind === 'VOID' ? 'VOID_RECORDED' : 'POSTED';
          const e = await tx.one<{ id: string }>(`INSERT INTO paper_slip_entries (clinic_id, book_id, slip_no, entry_kind, amount_millimes, tender, visit_id, written_on, note, classification, content_hash, entered_by)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [actor!.clinicId, book.id, slipNo, kind, amount, tender, visitId, writtenOn, note, cls, contentHash, actor!.staffId]);
          let paymentId: string | null = null;
          if (kind === 'USED') {
            const r = await recordPayment(tx, actor!, { visitId: visitId!, amountMillimes: amount, tender: tender!, source: 'PAPER_OUTAGE', issueReceipt: false, paperSlipEntryId: e.id });
            paymentId = r.payment.id;
          }
          await appendAudit(tx, actor!, kind === 'VOID' ? 'paper.slip_voided' : 'paper.slip_posted', 'paper_slip_entry', e.id, { slip: label, amountMillimes: amount, tender, visitId, paymentId });
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
    handler: async ({ tx, params }) => ({ status: 200, body: await reconcileBook(tx, params.id!) }),
  },
];
