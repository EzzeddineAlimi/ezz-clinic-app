/*
 * C3 — Card-payment evidence tiers. C-148 T-STMT-1..8 + M-249 added tests (forged slip, inserted duplicate,
 * re-issue/overlap, consumption race / claim order, owner-confirm promotion) + C-138 T-CARD-1/3.
 * GPT_SECURITY_BASELINE T-CARD-1 (v0.1 RED: balance reduced with no proof) and T-STMT-1 (v0.1: 404) must be GREEN.
 * No PSP is integrated; statements are synthetic CSV text.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, confirmCare, adminConn, reauth, type TestDb, type Api } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/pgwire.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

const TODAY = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const HEADER = 'date,amount_tnd,type,terminal_ref,card_last4,description';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

let n = 0;
async function clinic() {
  const F = await standardFixture(api, db, `card-${++n}`);
  await reauth(api, F.owner);
  const s = await api.call('POST', '/api/v1/card/settings', { token: F.owner, body: { accountLast4: '4321', settlementLagDays: 2 } });
  assert.equal(s.status, 200);
  return F;
}
async function cardClaim(F: Awaited<ReturnType<typeof clinic>>, amount: number, extra: Record<string, unknown> = {}) {
  const v = await newVisit(api, F.desk, F.patientId, `2026-11-20T${String(8 + (Math.floor(Math.random() * 9))).padStart(2, '0')}:${String(Math.floor(Math.random() * 59)).padStart(2, '0')}:00Z`);
  await confirmCare(api, F.dentist, v, amount);
  const r = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: F.desk, body: { amountMillimes: amount, tender: 'CARD', confirmDuplicate: true, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.payment.id as string;
}
const importStmt = (F: { owner: string }, body: Record<string, unknown>) => api.call('POST', '/api/v1/card/statement-imports', { token: F.owner, body: { fileName: 'fictional.csv', accountLast4: '4321', periodStart: TODAY, periodEnd: day(3), totalSource: 'NOT_PROVIDED', ...body } });
const recon = (F: { owner: string }, asOf = TODAY) => api.call('GET', `/api/v1/card/reconciliation?asOf=${asOf}`, { token: F.owner });
const claimOf = (r: { body: { claims: { paymentId: string }[] } }, id: string) => r.body.claims.find(c => c.paymentId === id) as any;

test('T-CARD-1 desk card claim with no statement stays DESK_CLAIM; awaiting within lag, overdue after (T-STMT-5)', async () => {
  const F = await clinic();
  const pid = await cardClaim(F, 100_000);
  const r0 = await recon(F);
  assert.equal(claimOf(r0, pid).tier, 'DESK_CLAIM');
  assert.equal(claimOf(r0, pid).status, 'AWAITING_STATEMENT');
  assert.equal(claimOf(r0, pid).exception, false);
  assert.equal(claimOf(await recon(F, day(2)), pid).status, 'AWAITING_STATEMENT', 'day 2 = still within lag');
  const r3 = await recon(F, day(3));
  assert.equal(claimOf(r3, pid).status, 'OVERDUE_NO_STATEMENT_LINE');
  assert.match(claimOf(r3, pid).wording, /not an accusation/);
  // receipt / balance never say "verified"
  const pay = await api.call('GET', `/api/v1/card/reconciliation?asOf=${TODAY}`, { token: F.owner });
  assert.ok(!JSON.stringify(pay.body.claims).includes('"PROVIDER_VERIFIED"'));
});

test('T-STMT-5b 10 claims settled on day 2 produce 0 exceptions (lag noise control)', async () => {
  const F = await clinic();
  const rows: string[] = [];
  for (let i = 0; i < 10; i++) { await cardClaim(F, 11_000 + i); rows.push(`${day(2)},${(11 + i / 1000).toFixed(3)},CARD,T1,,fictional`); }
  const imp = await importStmt(F, { csv: csv(...rows) });
  assert.equal(imp.status, 201);
  const r = await recon(F, day(4));
  assert.equal(r.body.claims.filter((c: any) => c.status === 'CANDIDATE_OWNER_CONFIRMS').length, 10);
  assert.equal(r.body.claims.filter((c: any) => c.status.startsWith('OVERDUE')).length, 0);
});

test('T-STMT-1 edited file (inserted 150,000 line) vs owner-read terminal total 300,000 -> BLOCKED, 0 lines stored', async () => {
  const F = await clinic();
  const body = csv(`${TODAY},150.000,CARD,T1,,a`, `${TODAY},60.000,CARD,T1,,b`, `${TODAY},90.000,CARD,T1,,c`, `${TODAY},150.000,CARD,T1,,inserted`);
  const r = await importStmt(F, { csv: body, totalSource: 'OWNER_READ_TERMINAL', declaredTotalMillimes: 300_000 });
  assert.equal(r.status, 422);
  assert.equal(r.body.import.status, 'BLOCKED_TOTAL_MISMATCH');
  assert.equal(r.body.import.differenceMillimes, 150_000);
  const rec = await recon(F);
  assert.equal(rec.body.statementLines.length, 0);
  // without a typed total the same file imports only as "source not verified" (tier-2 ceiling still applies)
  const r2 = await importStmt(F, { csv: body });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.import.status, 'ACCEPTED_NO_TOTAL');
  assert.match(r2.body.warning, /source not verified/);
});

test('M-249-A total typed from a DESK-HANDLED slip is NOT an independent check (forged slip + forged file never silent)', async () => {
  const F = await clinic();
  await cardClaim(F, 150_000);
  const forged = csv(`${TODAY},150.000,CARD,T1,,forged`);
  const r = await importStmt(F, { csv: forged, totalSource: 'DESK_HANDLED_SLIP', declaredTotalMillimes: 150_000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.import.status, 'ACCEPTED_TOTAL_NOT_INDEPENDENT');
  assert.match(r.body.warning, /NOT an independent check/);
  const rec = await recon(F);
  const cand = rec.body.claims[0].candidates[0];
  assert.match(cand.sourceWarning, /desk-handled slip: not independent/);
  assert.equal(rec.body.claims[0].tier, 'DESK_CLAIM');
});

test('T-STMT-2 replay: same file twice or renamed -> 0 new lines; two genuine identical lines -> 2, never 4', async () => {
  const F = await clinic();
  const body = csv(`${TODAY},150.000,CARD,,,x`, `${TODAY},150.000,CARD,,,y`);
  const r1 = await importStmt(F, { csv: body });
  assert.equal(r1.body.import.linesNew, 2);
  const r2 = await importStmt(F, { csv: body });
  assert.equal(r2.body.import.linesNew, 0);
  const r3 = await importStmt(F, { csv: body.replace('x', 'renamed-desc'), fileName: 'renamed.csv' });
  assert.equal(r3.body.import.linesNew, 0);
  const a = await adminConn(db.name);
  try { assert.equal((await a.query('SELECT 1 FROM statement_lines l JOIN statement_imports i ON i.id = l.import_id JOIN clinics c ON c.id = i.clinic_id WHERE c.code = $1', [`card-${n}`])).rowCount, 2); } finally { a.end(); }
});

test('M-249-B inserted duplicate line + total from a compromised desk slip: imports, but flagged NOT independent and surfaces as an unmatched line', async () => {
  const F = await clinic();
  await cardClaim(F, 150_000);
  const edited = csv(`${TODAY},150.000,CARD,,,genuine`, `${TODAY},150.000,CARD,,,inserted-duplicate`);
  const r = await importStmt(F, { csv: edited, totalSource: 'DESK_HANDLED_SLIP', declaredTotalMillimes: 300_000 });
  assert.equal(r.body.import.status, 'ACCEPTED_TOTAL_NOT_INDEPENDENT');
  const rec = await recon(F);
  assert.equal(rec.body.claims[0].status, 'AMBIGUOUS_REVIEW_NEEDED', 'one claim, two equal lines: owner must choose; nothing silent');
  assert.ok(rec.body.exceptionCount >= 1);
});

test('M-249-C overlapping statements import only the surplus; a re-issued statement lacking earlier lines is BLOCKED; force imports new lines and reports the missing one', async () => {
  const F = await clinic();
  const fileA = csv(`${TODAY},40.000,CARD,T1,,a1`, `${day(1)},50.000,CARD,T1,,a2`);
  assert.equal((await importStmt(F, { csv: fileA, periodStart: TODAY, periodEnd: day(1) })).body.import.linesNew, 2);
  const fileB = csv(`${day(1)},50.000,CARD,T1,,a2`, `${day(2)},60.000,CARD,T1,,b1`); // overlaps day(1)
  const rb = await importStmt(F, { csv: fileB, periodStart: day(1), periodEnd: day(2) });
  assert.equal(rb.body.import.linesNew, 1);
  assert.equal(rb.body.import.linesAlreadyKnown, 1);
  const reissue = csv(`${TODAY},40.000,CARD,T1,,a1`, `${day(1)},55.000,CARD,T1,,altered`); // 50.000 line changed to 55.000
  const rc = await importStmt(F, { csv: reissue, periodStart: TODAY, periodEnd: day(1) });
  assert.equal(rc.status, 409);
  assert.equal(rc.body.import.status, 'BLOCKED_OVERLAP_CONFLICT');
  assert.equal(rc.body.import.missingFromThisFile.length, 1);
  const forced = await importStmt(F, { csv: reissue, periodStart: TODAY, periodEnd: day(1), forceOverlapReason: 'Fictional: bank re-issued statement' });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.import.status, 'ACCEPTED_OVERLAP_FORCED');
  assert.equal(forced.body.import.linesNew, 1, 'only the 55.000 line is new');
  assert.equal(forced.body.import.missingFromThisFile.length, 1, 'the vanished 50.000 line is reported');
});

test('M-249-D reversal lines never satisfy a claim and always need owner review', async () => {
  const F = await clinic();
  const pid = await cardClaim(F, 70_000);
  await importStmt(F, { csv: csv(`${TODAY},70.000,REVERSAL,T1,,rev`) });
  const r = await recon(F);
  assert.equal(claimOf(r, pid).status, 'AWAITING_STATEMENT');
  assert.equal(r.body.statementLines[0].status, 'STATEMENT_REVERSAL_REVIEW');
});

test('T-STMT-3 amount-only match is a CANDIDATE, never "matched"; two claims + one line = BOTH ambiguous, independent of claim order (M-249 consumption race)', async () => {
  const runOrder = async (first: 'A' | 'B') => {
    const F = await clinic();
    const ids: Record<string, string> = {};
    for (const who of first === 'A' ? ['A', 'B'] : ['B', 'A']) ids[who] = await cardClaim(F, 150_000);
    await importStmt(F, { csv: csv(`${TODAY},150.000,CARD,,,only-line`) });
    const r = await recon(F);
    return { F, r, ids, statuses: [claimOf(r, ids.A!).status, claimOf(r, ids.B!).status] };
  };
  const x = await runOrder('A');
  const y = await runOrder('B');
  assert.deepEqual(x.statuses, ['AMBIGUOUS_REVIEW_NEEDED', 'AMBIGUOUS_REVIEW_NEEDED']);
  assert.deepEqual(y.statuses, x.statuses, 'claim order does not change the outcome');
  // owner must acknowledge ambiguity; then the line is consumed exactly once
  const line = claimOf(x.r, x.ids.A!).candidates[0].statementLineId;
  const noAck = await api.call('POST', '/api/v1/card/matches', { token: x.F.owner, body: { paymentId: x.ids.A, statementLineId: line } });
  assert.equal(noAck.status, 409);
  const ok = await api.call('POST', '/api/v1/card/matches', { token: x.F.owner, body: { paymentId: x.ids.A, statementLineId: line, ambiguityAcknowledged: true, note: 'Fictional: checked paper slip' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.match.evidenceTier, 'OWNER_REVIEWED_STATEMENT');
  const twice = await api.call('POST', '/api/v1/card/matches', { token: x.F.owner, body: { paymentId: x.ids.B, statementLineId: line, ambiguityAcknowledged: true } });
  assert.equal(twice.status, 409, 'one line can settle at most one claim');
  const after_ = await recon(x.F, day(3));
  assert.equal(claimOf(after_, x.ids.B!).status, 'OVERDUE_NO_STATEMENT_LINE', 'the other claim stays visible');
});

test('M-249-E owner confirmation can NEVER promote to PROVIDER_VERIFIED (API, DB constraint and privileges)', async () => {
  const F = await clinic();
  const pid = await cardClaim(F, 20_000, { cardTerminalRef: 'T9' });
  await importStmt(F, { csv: csv(`${TODAY},20.000,CARD,T9,,x`) });
  const r = await recon(F);
  assert.equal(claimOf(r, pid).candidates[0].strength, 'AMOUNT_DATE_PLUS_REFERENCE');
  const lineId = claimOf(r, pid).candidates[0].statementLineId;
  const promo = await api.call('POST', '/api/v1/card/matches', { token: F.owner, body: { paymentId: pid, statementLineId: lineId, evidenceTier: 'PROVIDER_VERIFIED' } });
  assert.equal(promo.status, 400);
  const app = new PgConnection(parseDatabaseUrl(db.appUrl)); await app.connect();
  try {
    await app.query('BEGIN'); await app.query("SELECT set_config('app.clinic_id', $1, true)", [F.clinic.id]);
    await assert.rejects(app.query("INSERT INTO provider_settlement_events (clinic_id, provider_name, provider_event_ref, signature_verified, amount_millimes) VALUES ($1,'x','y',true,1)", [F.clinic.id]), /permission denied/);
    await app.query('ROLLBACK');
  } finally { app.end(); }
  const owner = new PgConnection(parseDatabaseUrl(db.ownerUrl)); await owner.connect();
  try {
    await owner.query('BEGIN'); await owner.query("SELECT set_config('app.clinic_id', $1, true)", [F.clinic.id]);
    await assert.rejects(owner.query("INSERT INTO card_matches (clinic_id, payment_id, statement_line_id, evidence_tier, basis, confirmed_by) VALUES ($1,$2,$3,'PROVIDER_VERIFIED','x',$4)", [F.clinic.id, pid, lineId, F.clinic.staff.owner!]), /check constraint/);
    await owner.query('ROLLBACK');
  } finally { owner.end(); }
});

test('T-STMT-4 desk role cannot import (403, nothing stored); owner needs fresh re-auth; import records actor + file hash + line count', async () => {
  const F = await clinic();
  const d = await api.call('POST', '/api/v1/card/statement-imports', { token: F.desk, body: { fileName: 'x.csv', csv: csv(`${TODAY},1.000,CARD,,,x`), accountLast4: '4321', periodStart: TODAY, periodEnd: TODAY, totalSource: 'NOT_PROVIDED' } });
  assert.equal(d.status, 403);
  const a = await adminConn(db.name);
  try {
    await a.query("UPDATE sessions SET reauth_at = now() - interval '6 minutes' WHERE staff_id = $1", [F.clinic.staff.owner!]);
    const stale = await importStmt(F, { csv: csv(`${TODAY},1.000,CARD,,,x`) });
    assert.equal(stale.status, 401);
    await reauth(api, F.owner);
    const ok = await importStmt(F, { csv: csv(`${TODAY},1.000,CARD,,,x`) });
    assert.equal(ok.status, 201);
    const row = (await a.query<{ imported_by: string; file_sha256: string; card_line_count: number }>('SELECT imported_by, file_sha256, card_line_count FROM statement_imports WHERE id = $1', [ok.body.import.id])).rows[0]!;
    assert.equal(row.imported_by, F.clinic.staff.owner);
    assert.match(row.file_sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.card_line_count, 1);
  } finally { a.end(); }
});

test('T-STMT-6 stale import banner when the newest statement is older than 7 days', async () => {
  const F = await clinic();
  await importStmt(F, { csv: csv(`${TODAY},1.000,CARD,,,x`), periodEnd: TODAY });
  assert.equal((await recon(F, day(3))).body.importHealth.banner, null);
  assert.equal((await recon(F, day(10))).body.importHealth.banner, 'Statement import is 10 days behind');
});

test('T-STMT-7 wrong account or out-of-period lines -> REJECTED_SCOPE, 0 lines; non-card lines discarded and never stored', async () => {
  const F = await clinic();
  const wrong = await importStmt(F, { csv: csv(`${TODAY},10.000,CARD,,,x`), accountLast4: '9999' });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.import.status, 'REJECTED_SCOPE');
  const outside = await importStmt(F, { csv: csv(`${day(9)},10.000,CARD,,,x`) });
  assert.equal(outside.body.import.status, 'REJECTED_SCOPE');
  const mixed = await importStmt(F, { csv: csv(`${TODAY},10.000,CARD,,,ok`, `${TODAY},999.000,TRANSFER,,,Salary FICTIONAL NAME`, `${TODAY},5.000,FEE,,,bank fee`) });
  assert.equal(mixed.body.import.linesNew, 1);
  assert.equal(mixed.body.import.discardedNonCard, 2);
  const bad = await importStmt(F, { csv: csv(`${TODAY},10.0001,CARD,,,x`) });
  assert.equal(bad.status, 400, 'over-precise amount rejected, never rounded');
  const inj = await importStmt(F, { csv: csv(`${TODAY},10.000,CARD,T1'; DROP TABLE x;--,,x`) });
  assert.equal(inj.status, 400);
});

test('T-STMT-8 privacy: statement lines store only date, amount, ref, last-4 (no description column exists)', async () => {
  const a = await adminConn(db.name);
  try {
    const cols = (await a.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'statement_lines' ORDER BY column_name")).rows.map(r => r.column_name);
    assert.deepEqual(cols, ['amount_millimes', 'card_last4', 'clinic_id', 'id', 'import_id', 'is_reversal', 'line_key', 'occurrence', 'terminal_ref', 'txn_date']);
  } finally { a.end(); }
});

test('T-CARD-3 pair test: cash relabelled as card -> drawer +100,000 over AND card claim overdue; neither signal alone separates the cases', async () => {
  const F = await clinic();
  await cardClaim(F, 100_000); // desk says card; patient actually paid cash, which is in the drawer
  const v = await newVisit(api, F.desk, F.patientId, '2026-11-21T09:00:00Z');
  await confirmCare(api, F.dentist, v, 50_000);
  await api.call('POST', `/api/v1/visits/${v}/payments`, { token: F.desk, body: { amountMillimes: 50_000, tender: 'CASH' } });
  const cur = await api.call('GET', '/api/v1/cash/periods/current', { token: F.owner });
  await api.call('POST', `/api/v1/cash/periods/${cur.body.period.id}/counts`, { token: F.owner, body: { countedMillimes: 150_000 } });
  const rv = await api.call('GET', `/api/v1/cash/periods/${cur.body.period.id}/review`, { token: F.owner });
  assert.equal(rv.body.attempts[0].differenceMillimes, 100_000);
  const rc = await recon(F, day(3));
  assert.equal(rc.body.claims[0].status, 'OVERDUE_NO_STATEMENT_LINE');
  // If instead the desk POCKETED the cash and claimed card, the drawer matches (difference 0) and ONLY the
  // statement side exposes it: C-138 key observation, CH-007 does not cover CH-013.
});
