/*
 * C6 — Paper outage recovery. C-146 drill fixture: book P-001..P-020, slips P-001..P-012 used =
 * 60,000 / 45,000 / 120,000 / 30,000 / 80,000 / 25,000 / 150,000 / 40,000 / 90,000 / 35,000 / 70,000 / 55,000 = 800,000.
 * GPT_SECURITY_BASELINE T-PAPER-1 (v0.1: 404 not implemented) must be GREEN. Mode B residuals are documented, not tested.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, adminConn, reauth, spawnServer, killServer, PASSWORD, key, type TestDb, type Api } from './helpers.ts';

const AMOUNTS = [60_000, 45_000, 120_000, 30_000, 80_000, 25_000, 150_000, 40_000, 90_000, 35_000, 70_000, 55_000];
let db: TestDb; let api: Api; let F: Awaited<ReturnType<typeof standardFixture>>;
let bookId = ''; const visitBySlip: Record<number, string> = {};

before(async () => {
  db = await createTestDb(); api = await startApi(db.appUrl);
  F = await standardFixture(api, db, 'paper-a');
  await reauth(api, F.owner);
  const book = await api.call('POST', '/api/v1/paper-books', { token: F.owner, body: { firstNo: 1, lastNo: 20, custodianStaffId: F.clinic.staff.dentist, note: 'Fictional outage book' } });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  assert.equal(book.body.book.range, 'P-001..P-020');
  bookId = book.body.book.id;
  for (let i = 0; i < 12; i++) {
    const v = await newVisit(api, F.desk, F.patientId, `2026-10-29T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00Z`);
    await confirmCare(api, F.dentist, v, AMOUNTS[i]!); // dentist re-enters care from his own paper notes
    visitBySlip[i + 1] = v;
  }
});
after(async () => { await api.close(); await db.drop(); });

const slip = (n: number, amount = AMOUNTS[n - 1]!, tender = 'CASH') => ({ slipNo: n, kind: 'USED', amountMillimes: amount, tender, visitId: visitBySlip[n], writtenOn: '2026-10-29' });
const enter = (slips: unknown[], token = F.desk, idem?: string) => api.call('POST', `/api/v1/paper-books/${bookId}/entries`, { token, body: { slips }, idem });
async function db1<T>(sql: string, p: unknown[] = []): Promise<T[]> { const a = await adminConn(db.name); try { return (await a.query(sql, p as never[])).rows as T[]; } finally { a.end(); } }

test('T-PAPER-1 import 12 slips once -> exactly 12 payments totalling 800,000; electronic R sequence unchanged', async () => {
  const rBefore = (await db1<{ m: number }>("SELECT coalesce(max(number),0)::int AS m FROM receipts"))[0]!.m;
  const r = await enter(Array.from({ length: 12 }, (_, i) => slip(i + 1)));
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.posted, 12);
  const pays = await db1<{ n: number; total: number }>("SELECT count(*)::int AS n, coalesce(sum(amount_millimes),0)::bigint AS total FROM payments WHERE source = 'PAPER_OUTAGE'");
  assert.deepEqual(pays[0], { n: 12, total: 800_000 });
  assert.equal((await db1<{ m: number }>("SELECT coalesce(max(number),0)::int AS m FROM receipts"))[0]!.m, rBefore, 'no R-number consumed');
  assert.match(r.body.note, /no electronic receipt number/);
});

test('T-PAPER-2 re-entering P-007 (same content, new request) -> 0 payments, total stays 800,000, 1 owner-review item', async () => {
  const r = await enter([slip(7)]);
  assert.equal(r.body.results[0].outcome, 'DUPLICATE_ENTRY');
  assert.equal(r.body.results[0].paymentsCreated, 0);
  const t = await db1<{ total: number }>("SELECT sum(amount_millimes)::bigint AS total FROM payments WHERE source = 'PAPER_OUTAGE'");
  assert.equal(t[0]!.total, 800_000);
  const rec = await api.call('GET', `/api/v1/paper-books/${bookId}/reconciliation`, { token: F.owner });
  assert.equal(rec.body.reviewItems.filter((i: any) => i.slip === 'P-007' && i.kind === 'DUPLICATE_ENTRY').length, 1);
});

test('T-PAPER-3 conflict: P-007 re-keyed at 90,000 (was 150,000) -> both kept, neither overwrites, neutral wording', async () => {
  const r = await enter([slip(7, 90_000)]);
  assert.equal(r.body.results[0].outcome, 'CONFLICT');
  assert.equal(r.body.results[0].wording, 'Two records share slip P-007 — owner review');
  const rows = await db1<{ classification: string; amount_millimes: number }>("SELECT classification, amount_millimes FROM paper_slip_entries WHERE slip_no = 7 ORDER BY entered_at");
  assert.deepEqual(rows.map(r => r.classification), ['POSTED', 'DUPLICATE_ENTRY', 'CONFLICT']);
  assert.equal(rows[0]!.amount_millimes, 150_000, 'original effective entry untouched');
  const t = await db1<{ total: number }>("SELECT sum(amount_millimes)::bigint AS total FROM payments WHERE source = 'PAPER_OUTAGE'");
  assert.equal(t[0]!.total, 800_000);
});

test('T-PAPER-5 void: recorded with reason, counts 0, stays in sequence; void with an amount is rejected', async () => {
  const bad = await enter([{ slipNo: 13, kind: 'VOID', amountMillimes: 5_000, note: 'Fictional spoiled slip' }]);
  assert.equal(bad.body.results[0].outcome, 'REJECTED');
  assert.equal(bad.body.results[0].code, 'PAPER_VOID_WITH_AMOUNT');
  const noReason = await enter([{ slipNo: 13, kind: 'VOID' }]);
  assert.equal(noReason.body.results[0].outcome, 'REJECTED');
  const ok = await enter([{ slipNo: 13, kind: 'VOID', note: 'Fictional spoiled slip' }]);
  assert.equal(ok.body.results[0].outcome, 'VOID_RECORDED');
  assert.equal(ok.body.results[0].paymentsCreated, 0);
});

test('T-PAPER-4 sequence check: custodian declares P-014..P-020 unused except P-016 -> exactly 1 "not accounted for"', async () => {
  const desk = await api.call('POST', `/api/v1/paper-books/${bookId}/declare-unused`, { token: F.desk, body: { slipNos: [14] } });
  assert.equal(desk.status, 403, 'the desk cannot declare slips unused');
  const r = await api.call('POST', `/api/v1/paper-books/${bookId}/declare-unused`, { token: F.dentist, body: { slipNos: [14, 15, 17, 18, 19, 20] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.declaredUnused.length, 6);
  const rec = await api.call('GET', `/api/v1/paper-books/${bookId}/reconciliation`, { token: F.owner });
  assert.deepEqual(rec.body.unaccounted, ['P-016']);
  assert.equal(rec.body.reviewItems.filter((i: any) => i.kind === 'NOT_ACCOUNTED_FOR').length, 1);
  assert.equal(rec.body.reviewItems.find((i: any) => i.kind === 'NOT_ACCOUNTED_FOR').wording, 'Slip P-016 not accounted for');
  assert.equal(rec.body.used.length, 12);
  assert.deepEqual(rec.body.void, ['P-013']);
  assert.equal(rec.body.unusedDeclared.length, 6);
  assert.equal(rec.body.postedTotalMillimes, 800_000);
});

test('T-PAPER-7 out-of-range slip, unknown visit, and amount above balance are rejected per slip without blocking the batch', async () => {
  const v = await newVisit(api, F.desk, F.patientId, '2026-10-30T09:00:00Z');
  await confirmCare(api, F.dentist, v, 10_000);
  const r = await enter([
    { slipNo: 99, kind: 'USED', amountMillimes: 1_000, tender: 'CASH', visitId: v },
    { slipNo: 16, kind: 'USED', amountMillimes: 20_000, tender: 'CASH', visitId: v },          // exceeds 10,000 balance
    { slipNo: 16, kind: 'USED', amountMillimes: 10_000, tender: 'CARD', visitId: v },          // valid
  ]);
  assert.deepEqual(r.body.results.map((x: any) => x.outcome), ['REJECTED', 'REJECTED', 'POSTED']);
  assert.equal(r.body.results[0].code, 'PAPER_SLIP_OUT_OF_RANGE');
  assert.equal(r.body.results[1].code, 'AMOUNT_EXCEEDS_BALANCE');
  const rec = await api.call('GET', `/api/v1/paper-books/${bookId}/reconciliation`, { token: F.owner });
  assert.deepEqual(rec.body.unaccounted, []);
});

test('T-PAPER-8 paper and electronic identifiers stay distinct; paper card slip is still only a DESK_CLAIM', async () => {
  const rows = await db1<{ source: string; tender: string; has_receipt: boolean }>(`SELECT p.source, p.tender, (r.id IS NOT NULL) AS has_receipt FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.source = 'PAPER_OUTAGE'`);
  assert.ok(rows.every(r => !r.has_receipt), 'paper payments carry the P-slip, not an R receipt');
  const integ = await api.call('POST', '/api/v1/integrity/check', { token: F.owner, body: {} });
  assert.ok(!integ.body.findings.some((f: any) => f.check === 'PAYMENT_WITHOUT_RECEIPT'), JSON.stringify(integ.body.findings));
});

test('T-PAPER-6 persistence: after a REAL process restart, re-importing the whole drill again creates 0 payments', async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = await spawnServer(db.appUrl, port);
  try {
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clinicCode: 'paper-a', username: 'desk', password: PASSWORD }) });
    const token = ((await login.json()) as { token: string }).token;
    await killServer(child);
    const child2 = await spawnServer(db.appUrl, port);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/paper-books/${bookId}/entries`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key() }, body: JSON.stringify({ slips: Array.from({ length: 12 }, (_, i) => slip(i + 1)) }) });
      const body = await r.json() as { summary: { posted: number; flagged: number } };
      assert.equal(body.summary.posted, 0);
      assert.equal(body.summary.flagged, 12);
      const t = await db1<{ n: number; total: number }>("SELECT count(*)::int AS n, sum(amount_millimes)::bigint AS total FROM payments WHERE source = 'PAPER_OUTAGE'");
      assert.deepEqual(t[0], { n: 13, total: 810_000 }, '12 drill slips + P-016 from T-PAPER-7');
    } finally { await killServer(child2); }
  } finally { await killServer(child); }
});

test('T-PAPER-9 book issuance: owner only, custodian must not be the desk, ranges cannot overlap', async () => {
  assert.equal((await api.call('POST', '/api/v1/paper-books', { token: F.desk, body: { firstNo: 21, lastNo: 40, custodianStaffId: F.clinic.staff.desk } })).status, 403);
  const deskCustodian = await api.call('POST', '/api/v1/paper-books', { token: F.owner, body: { firstNo: 21, lastNo: 40, custodianStaffId: F.clinic.staff.desk } });
  assert.equal(deskCustodian.status, 400);
  const overlap = await api.call('POST', '/api/v1/paper-books', { token: F.owner, body: { firstNo: 15, lastNo: 30, custodianStaffId: F.clinic.staff.dentist } });
  assert.equal(overlap.status, 409);
});
