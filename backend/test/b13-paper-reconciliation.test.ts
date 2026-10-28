/*
 * B13 — paper-outage re-entry: wrong-visit attribution (CH-030), book-level care vs slips (CH-029), restart-safe
 * idempotent replay. Extends the PR #8 20-visit drill. Fictional data only; findings are review items, never a
 * conclusion about a person. The paper slip and the patient's copy stay the authority (human check).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, adminConn, spawnServer, killServer, PASSWORD, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
type Slip = { slipNo: number; kind: 'USED' | 'VOID'; amountMillimes?: number; tender?: 'CASH'; visitId?: string; writtenOn?: string; patientFileNo?: number; note?: string };
async function outage() {
  const f = await standardFixture(api, db, `b13-${++n}`);
  await reauth(api, f.owner);
  const book = await api.call('POST', '/api/v1/paper-books', { token: f.owner, body: { firstNo: 101, lastNo: 110, custodianStaffId: f.clinic.staff.dentist } });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  const patient = async (familyName: string) => {
    const p = await api.call('POST', '/api/v1/patients', { token: f.desk, body: { familyName, givenName: 'Fictif', isSynthetic: true } });
    return { id: p.body.patient.id as string, fileNo: p.body.patient.fileNo as number };
  };
  const A = await patient('Amri'); const B = await patient('Bouzid');
  const vA = await newVisit(api, f.desk, A.id, '2026-10-20T09:00:00Z'); await confirmCare(api, f.dentist, vA, 70_000);
  const vB = await newVisit(api, f.desk, B.id, '2026-10-20T10:00:00Z'); await confirmCare(api, f.dentist, vB, 70_000);
  const bookId = book.body.book.id as string;
  const enter = (slips: Slip[], token = f.desk, idem?: string) => api.call('POST', `/api/v1/paper-books/${bookId}/entries`, { token, body: { slips }, idem });
  const rec = (qs = '') => api.call('GET', `/api/v1/paper-books/${bookId}/reconciliation${qs}`, { token: f.owner });
  const balance = async (visitId: string) => (await api.call('GET', `/api/v1/visits/${visitId}/balance`, { token: f.desk })).body.balance.balanceMillimes as number;
  return { ...f, bookId, A, B, vA, vB, enter, rec, balance };
}

test('T-PAP-1 (RED on PR #8) CH-030: a slip carrying patient A\'s file number cannot be posted to patient B\'s visit', async () => {
  const s = await outage();
  const wrong = await s.enter([{ slipNo: 105, kind: 'USED', amountMillimes: 70_000, tender: 'CASH', visitId: s.vB, writtenOn: '2026-10-20', patientFileNo: s.A.fileNo }]);
  assert.equal(wrong.status, 200, JSON.stringify(wrong.body));
  assert.equal(wrong.body.results[0].outcome, 'REJECTED', JSON.stringify(wrong.body));
  assert.equal(wrong.body.results[0].code, 'PAPER_SLIP_PATIENT_MISMATCH');
  assert.equal(await s.balance(s.vB), 70_000, 'B still owes: nothing was posted to the wrong visit');
  const right = await s.enter([{ slipNo: 105, kind: 'USED', amountMillimes: 70_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20', patientFileNo: s.A.fileNo }]);
  assert.equal(right.body.results[0].outcome, 'POSTED', JSON.stringify(right.body));
  assert.equal(await s.balance(s.vA), 0);
});

test('T-PAP-2 (RED on PR #8) a slip posted without the patient file number from the paper is listed for a human check against the patient copy', async () => {
  const s = await outage();
  const r = await s.enter([{ slipNo: 101, kind: 'USED', amountMillimes: 30_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20' }]);
  assert.equal(r.body.results[0].outcome, 'POSTED');
  const items = (await s.rec()).body.reviewItems as Array<{ slip: string; kind: string; wording: string }>;
  const it = items.find(i => i.kind === 'NO_PATIENT_REFERENCE');
  assert.ok(it, JSON.stringify(items));
  assert.equal(it!.slip, 'P-101');
  assert.match(it!.wording, /patient copy/i);
});

test('T-PAP-3 (RED on PR #8) CH-029: the book reconciliation compares each slip with the care charged on its visit', async () => {
  const s = await outage();
  // A: 70,000 care, 30,000 on slip 101, 20,000 at the desk after recovery -> 20,000 still due.
  await s.enter([{ slipNo: 101, kind: 'USED', amountMillimes: 30_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20', patientFileNo: s.A.fileNo }]);
  assert.equal((await api.call('POST', `/api/v1/visits/${s.vA}/payments`, { token: s.desk, body: { amountMillimes: 20_000, tender: 'CASH' } })).status, 201);
  // B: 70,000 care, 70,000 on slip 102.
  await s.enter([{ slipNo: 102, kind: 'USED', amountMillimes: 70_000, tender: 'CASH', visitId: s.vB, writtenOn: '2026-10-20', patientFileNo: s.B.fileNo }]);
  const r = (await s.rec()).body;
  assert.ok(r.careVsSlips, JSON.stringify(r));
  const a = r.careVsSlips.slips.find((x: { slip: string }) => x.slip === 'P-101');
  assert.deepEqual({ fileNo: a.fileNo, chargedMillimes: a.chargedMillimes, paidBySlipMillimes: a.paidBySlipMillimes, paidOtherwiseMillimes: a.paidOtherwiseMillimes, balanceMillimes: a.balanceMillimes },
    { fileNo: s.A.fileNo, chargedMillimes: 70_000, paidBySlipMillimes: 30_000, paidOtherwiseMillimes: 20_000, balanceMillimes: 20_000 });
  assert.deepEqual(r.careVsSlips.totals, { slips: 2, visits: 2, slipTotalMillimes: 100_000, chargedMillimes: 140_000, paidOtherwiseMillimes: 20_000, balanceMillimes: 20_000 });
  assert.equal(r.postedTotalMillimes, 100_000, 'existing PR #8 field unchanged');
});

test('T-PAP-4 outage window: care recorded in the window with no slip and no payment is listed; outside or paid visits are not', async () => {
  const s = await outage();
  await s.enter([{ slipNo: 101, kind: 'USED', amountMillimes: 70_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20', patientFileNo: s.A.fileNo }]);
  const outside = await newVisit(api, s.desk, s.patientId, '2026-10-22T09:00:00Z'); await confirmCare(api, s.dentist, outside, 40_000);
  const r = (await s.rec('?outageFrom=2026-10-20T08:00:00Z&outageTo=2026-10-20T12:00:00Z')).body;
  assert.deepEqual(r.careWithoutPayment.visits.map((v: { visitId: string }) => v.visitId), [s.vB], 'B has care in the window and nothing paid; A is covered by P-101');
  assert.equal(r.careWithoutPayment.visits[0].balanceMillimes, 70_000);
  assert.ok(r.reviewItems.some((i: { kind: string }) => i.kind === 'CARE_WITHOUT_SLIP_OR_PAYMENT'));
  assert.equal((await s.rec()).body.careWithoutPayment, null, 'no window given: section absent, never guessed');
  assert.equal((await s.rec('?outageFrom=2026-10-21T00:00:00Z&outageTo=2026-10-20T00:00:00Z')).status, 400);
  assert.equal((await s.rec('?outageFrom=2026-10-01T00:00:00Z&outageTo=2026-10-20T00:00:00Z')).status, 400, 'window longer than 7 days');
  assert.equal((await s.rec('?outageFrom=yesterday&outageTo=2026-10-20T00:00:00Z')).status, 400);
});

test('T-PAP-5 a slip dated on another day than its visit and two slips on one visit are review items (legitimate cases exist; wording neutral)', async () => {
  const s = await outage();
  await s.enter([
    { slipNo: 101, kind: 'USED', amountMillimes: 30_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-21', patientFileNo: s.A.fileNo },
    { slipNo: 102, kind: 'USED', amountMillimes: 40_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20', patientFileNo: s.A.fileNo },
  ]);
  const items = (await s.rec()).body.reviewItems as Array<{ slip: string; kind: string; wording: string }>;
  assert.ok(items.some(i => i.kind === 'DATE_DIFFERS_FROM_VISIT' && i.slip === 'P-101'), JSON.stringify(items));
  assert.ok(!items.some(i => i.kind === 'DATE_DIFFERS_FROM_VISIT' && i.slip === 'P-102'));
  assert.ok(items.some(i => i.kind === 'MULTIPLE_SLIPS_ONE_VISIT'), JSON.stringify(items));
  const raw = JSON.stringify(items).toLowerCase();
  for (const w of ['suspicious', 'fraud', 'theft', 'stole']) assert.ok(!raw.includes(w));
});

test('T-PAP-6 replay compatibility: identical re-entry is DUPLICATE_ENTRY; adding a file number to an already-posted slip is a CONFLICT for the owner, never a second payment', async () => {
  const s = await outage();
  const slip: Slip = { slipNo: 103, kind: 'USED', amountMillimes: 70_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20' };
  assert.equal((await s.enter([slip])).body.results[0].outcome, 'POSTED');
  assert.equal((await s.enter([slip])).body.results[0].outcome, 'DUPLICATE_ENTRY', 'hash unchanged for slips without a file number (PR #8 replays stay duplicates)');
  assert.equal((await s.enter([{ ...slip, patientFileNo: s.A.fileNo }])).body.results[0].outcome, 'CONFLICT');
  const a = await adminConn(db.name);
  try {
    const c = (await a.query<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE clinic_id = $1 AND source = 'PAPER_OUTAGE'", [s.clinic.id] as never[])).rows[0]!;
    assert.equal(c.n, 1);
  } finally { a.end(); }
});

test('T-PAP-7 server killed mid-batch (transaction blocked on slip 3 of 5): nothing is half-posted; replay posts each slip exactly once', async () => {
  const s = await outage();
  const visits: Array<{ v: string; fileNo: number }> = [];
  for (let i = 0; i < 5; i++) {
    const p = await api.call('POST', '/api/v1/patients', { token: s.desk, body: { familyName: `Restart${i}`, givenName: 'Fictif', isSynthetic: true } });
    const v = await newVisit(api, s.desk, p.body.patient.id, `2026-10-20T1${i}:30:00Z`);
    await confirmCare(api, s.dentist, v, 50_000);
    visits.push({ v, fileNo: p.body.patient.fileNo });
  }
  const slips: Slip[] = visits.map((x, i) => ({ slipNo: 104 + i, kind: 'USED', amountMillimes: 25_000, tender: 'CASH', visitId: x.v, writtenOn: '2026-10-20', patientFileNo: x.fileNo }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = await spawnServer(db.appUrl, port);
  const base = `http://127.0.0.1:${port}/api/v1`;
  const login = await fetch(`${base}/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clinicCode: s.clinic.code, username: 'desk', password: PASSWORD }) });
  const deskToken = (await login.json() as { token: string }).token;
  const lock = await adminConn(db.name);
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM visits WHERE id = $1 FOR UPDATE', [visits[2]!.v] as never[]);
    const pending = fetch(`${base}/paper-books/${s.bookId}/entries`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${deskToken}`, 'idempotency-key': 'k_restart_batch_1' }, body: JSON.stringify({ slips }) }).catch(() => 'connection lost');
    // Wait until the request's transaction is blocked on the locked visit (slips 1-2 already inserted inside it).
    for (let i = 0; i < 100; i++) {
      const w = (await lock.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")).rows[0]!;
      if (w.n > 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await killServer(child);
    await lock.query('ROLLBACK');
    assert.equal(await pending, 'connection lost');
  } finally { lock.end(); await killServer(child); }
  // The abandoned backend finishes its statement, cannot reach its client, and rolls back.
  const a = await adminConn(db.name);
  try {
    for (let i = 0; i < 100; i++) {
      const busy = (await a.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND (state LIKE 'idle in transaction%' OR wait_event_type = 'Lock')")).rows[0]!;
      if (busy.n === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const posted = (await a.query<{ n: number }>("SELECT count(*)::int AS n FROM paper_slip_entries WHERE book_id = $1", [s.bookId] as never[])).rows[0]!;
    assert.equal(posted.n, 0, 'no half batch survives the crash');
  } finally { a.end(); }
  const replay = await s.enter(slips);
  assert.deepEqual(replay.body.summary, { posted: 5, flagged: 0, rejected: 0 }, JSON.stringify(replay.body));
  const again = await s.enter(slips);
  assert.deepEqual(again.body.summary, { posted: 0, flagged: 5, rejected: 0 });
  for (const x of visits) assert.equal(await s.balance(x.v), 25_000);
});

test('T-PAP-8 owner exceptions surface the new paper review items with neutral wording', async () => {
  const s = await outage();
  await s.enter([{ slipNo: 101, kind: 'USED', amountMillimes: 30_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-21' }]);
  const ex = await api.call('GET', '/api/v1/owner/exceptions?asOf=2026-10-29', { token: s.owner });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  const kinds = ex.body.open.map((e: { kind: string }) => e.kind);
  assert.ok(kinds.includes('PAPER_NO_PATIENT_REFERENCE'), JSON.stringify(kinds));
  assert.ok(kinds.includes('PAPER_DATE_DIFFERS_FROM_VISIT'), JSON.stringify(kinds));
});

test('T-PAP-9 (RED on PR #8) a slip pointing at another clinic\'s visit is rejected on its own; the other slips of the batch still post', async () => {
  const s = await outage();
  const other = await standardFixture(api, db, `b13-${++n}`);
  await confirmCare(api, other.dentist, other.visitId, 10_000);
  const r = await s.enter([
    { slipNo: 101, kind: 'USED', amountMillimes: 10_000, tender: 'CASH', visitId: other.visitId, writtenOn: '2026-10-28' },
    { slipNo: 102, kind: 'USED', amountMillimes: 70_000, tender: 'CASH', visitId: s.vA, writtenOn: '2026-10-20' },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x: { outcome: string }) => x.outcome), ['REJECTED', 'POSTED']);
  assert.equal(r.body.results[0].code, 'NOT_FOUND');
  const rec = (await s.rec()).body;
  assert.ok(!rec.used.includes('P-101') && rec.used.includes('P-102'));
  assert.equal((await api.call('GET', `/api/v1/visits/${other.visitId}/balance`, { token: other.desk })).body.balance.balanceMillimes, 10_000, 'the other clinic is untouched');
});
