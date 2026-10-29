/*
 * R73-F performance and resilience benchmark. FICTIONAL DATA ONLY; creates and drops its own throwaway database.
 *
 *   EZZ_TEST_ADMIN_URL=postgres://postgres:...@localhost:5432/postgres \
 *   BENCH_CLINICS=5 BENCH_PATIENTS=120 BENCH_CONCURRENCY=16 node scripts/bench.ts [--out ../docs/benchmarks/r73-f.json]
 *
 * The API runs as a SEPARATE server process (as in production), so client and server do not share an event loop.
 * Every phase measures latency (p50/p95/p99/max) and throughput, then checks business invariants; any violated
 * invariant is reported (and makes the process exit 1) instead of being averaged away. Phases:
 *   booking (patients + visits), care + payments (receipts), same-visit payment contention, cross-clinic and role
 *   isolation probes, blind cash count racing live payments, reads at size (day board, owner exceptions, integrity),
 *   backup + fresh restore, and SIGKILL of the server in the middle of a payment burst.
 */
import os from 'node:os';
import { writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createTestDb, seedClinic, STANDARD_STAFF, adminConn, spawnServer, killServer, PASSWORD, type TestDb } from '../test/helpers.ts';
import { freePort } from '../test/fresh-pg.ts';
import { createBackup, restoreAndVerify } from '../src/ops/disaster-recovery.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';

const CLINICS = Number(process.env.BENCH_CLINICS ?? 5);
const PATIENTS = Number(process.env.BENCH_PATIENTS ?? 120);
const CONC = Number(process.env.BENCH_CONCURRENCY ?? 16);
const KILL_BURST = Number(process.env.BENCH_KILL_BURST ?? 300);

type Res = { status: number; body: any; ms: number };
const violations: string[] = [];
const check = (ok: boolean, what: string) => { if (!ok) violations.push(what); };

let base = '';
async function call(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'POST') { headers['content-type'] = 'application/json'; headers['idempotency-key'] ??= 'b_' + crypto.randomUUID().replace(/-/g, ''); }
  const t0 = performance.now();
  try {
    const r = await fetch(base + path, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
    const text = await r.text();
    let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body: parsed, ms: performance.now() - t0 };
  } catch (e) { return { status: -1, body: String((e as Error).message), ms: performance.now() - t0 }; }
}

/** Run tasks with bounded concurrency, collecting results in order. */
async function pool<T>(n: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i]!(); } }));
  return out;
}

function stats(name: string, rs: Res[], wallMs: number, expect: (r: Res) => boolean = r => r.status >= 200 && r.status < 300) {
  const ms = rs.map(r => r.ms).sort((a, b) => a - b);
  const q = (p: number) => ms.length ? Number(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!.toFixed(1)) : null;
  const bad = rs.filter(r => !expect(r));
  if (bad.length) violations.push(`${name}: ${bad.length} unexpected response(s), e.g. ${bad[0]!.status} ${JSON.stringify(bad[0]!.body).slice(0, 160)}`);
  return { name, requests: rs.length, unexpected: bad.length, wallMs: Math.round(wallMs), throughputPerSec: Number((rs.length / (wallMs / 1000)).toFixed(1)), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> { const t0 = performance.now(); const r = await fn(); return [r, performance.now() - t0]; }

async function sql<R = Record<string, unknown>>(db: TestDb, text: string, params: unknown[] = []): Promise<R[]> {
  const c = await adminConn(db.name);
  try { return (await c.query(text, params as never[])).rows as R[]; } finally { c.end(); }
}

/** Invariants that must hold after any amount of concurrency, per clinic. */
async function financialInvariants(db: TestDb, label: string) {
  const gaps = await sql<{ clinic_id: string; n: number; mx: number; distinct_n: number }>(db,
    "SELECT clinic_id, count(*)::int AS n, max(number)::int AS mx, count(DISTINCT number)::int AS distinct_n FROM receipts WHERE series = 'R' GROUP BY clinic_id");
  for (const g of gaps) check(g.n === g.mx && g.n === g.distinct_n, `${label}: receipt series of clinic ${g.clinic_id} not contiguous/unique (count ${g.n}, max ${g.mx}, distinct ${g.distinct_n})`);
  const counters = await sql<{ clinic_id: string; ok: boolean }>(db,
    "SELECT c.clinic_id, c.next_number = coalesce((SELECT max(number) FROM receipts r WHERE r.clinic_id = c.clinic_id AND r.series = 'R'), 0) + 1 AS ok FROM receipt_counters c WHERE c.series = 'R'");
  for (const c of counters) check(c.ok, `${label}: receipt counter drift in clinic ${c.clinic_id}`);
  const unreceipted = await sql<{ n: number }>(db, "SELECT count(*)::int AS n FROM payments p WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.payment_id = p.id)");
  check(unreceipted[0]!.n === 0, `${label}: ${unreceipted[0]!.n} payment(s) without a receipt`);
  const alloc = await sql<{ n: number }>(db, 'SELECT count(*)::int AS n FROM payments p WHERE p.amount_millimes <> (SELECT coalesce(sum(a.amount_millimes),0) FROM payment_allocations a WHERE a.payment_id = p.id)');
  check(alloc[0]!.n === 0, `${label}: ${alloc[0]!.n} payment(s) whose allocations do not add up`);
  const over = await sql<{ n: number }>(db, `SELECT count(*)::int AS n FROM visits v
      WHERE (SELECT coalesce(sum(a.amount_millimes),0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.visit_id = v.id)
          > (SELECT coalesce(sum(c.fee_millimes),0) FROM care_items c WHERE c.visit_id = v.id) + (SELECT coalesce(sum(-d.amount_millimes),0) FROM adjustments d WHERE d.visit_id = v.id AND d.amount_millimes < 0 AND d.kind = 'REFUND')`);
  check(over[0]!.n === 0, `${label}: ${over[0]!.n} visit(s) paid above their confirmed fees`);
  return { receiptSeries: gaps.length, unreceipted: unreceipted[0]!.n };
}

async function main() {
  const env = {
    date: new Date().toISOString(), host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryGiB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.type()} ${os.release()}` },
    node: process.version, params: { clinics: CLINICS, patientsPerClinic: PATIENTS, visitsPerPatient: 2, clientConcurrency: CONC, serverPoolMax: 8, killBurst: KILL_BURST },
  };
  const db = await createTestDb();
  const pg = (await sql<{ v: string; sb: string; mc: string }>(db, "SELECT version() AS v, current_setting('shared_buffers') AS sb, current_setting('max_connections') AS mc"))[0]!;
  Object.assign(env, { postgres: { version: pg.v.split(' on ')[0], sharedBuffers: pg.sb, maxConnections: pg.mc, sameHost: true } });
  const report: Record<string, unknown> = { env, phases: [] as unknown[], checks: {} as Record<string, unknown> };
  const phases = report.phases as unknown[];
  let server: ChildProcess | null = null;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  try {
    server = await spawnServer(db.appUrl, port);
    // ---- seed clinics (bootstrap path) and sessions
    const clinics = [] as Array<{ id: string; code: string; dentistId: string; owner: string; dentist: string; desk: string; patients: string[]; visits: string[]; periodId?: string }>;
    for (let i = 0; i < CLINICS; i++) {
      const code = `bench-${i + 1}`;
      const c = await seedClinic(db, code, STANDARD_STAFF);
      const login = async (u: string) => (await call('POST', '/api/v1/session/login', undefined, { clinicCode: code, username: u, password: PASSWORD })).body.token as string;
      clinics.push({ id: c.id, code, dentistId: c.staff.dentist!, owner: await login('owner'), dentist: await login('dentist'), desk: await login('desk'), patients: [], visits: [] });
    }
    for (const c of clinics) {
      const r = await call('POST', '/api/v1/cash/periods', c.owner, { openingFloatMillimes: 20_000 });
      check(r.status === 201, `cash period open failed: ${r.status}`); c.periodId = r.body.period.id;
    }

    // ---- phase 1: booking
    let rs: Res[]; let wall: number;
    [rs, wall] = await timed(() => pool(CONC, clinics.flatMap(c => Array.from({ length: PATIENTS }, (_, k) => async () => {
      const r = await call('POST', '/api/v1/patients', c.desk, { familyName: `Fictif${k}`, givenName: `Bench${c.code}${k}`, isSynthetic: true, confirmNotDuplicate: true });
      if (r.status === 201) c.patients.push(r.body.patient.id); return r;
    }))));
    phases.push(stats('patients.create', rs, wall));
    [rs, wall] = await timed(() => pool(CONC, clinics.flatMap(c => c.patients.flatMap((p, k) => [0, 1].map(j => async () => {
      const slot = k * 2 + j; // unique 30-minute slot per visit and dentist: 18 slots a day from 08:00 local (07:00Z)
      const at = new Date(Date.UTC(2026, 6, 1) + Math.floor(slot / 18) * 86400_000 + (7 * 60 + (slot % 18) * 30) * 60_000).toISOString();
      const r = await call('POST', '/api/v1/visits', c.desk, { patientId: p, scheduledAt: at, dentistId: c.dentistId });
      if (r.status === 201) c.visits.push(r.body.visit.id); return r;
    })))));
    phases.push(stats('visits.schedule', rs, wall));

    // ---- phase 2: dentist-confirmed care then two desk payments per visit (cash/card mix)
    const fee = (i: number) => 20_000 + (i % 7) * 5_000;
    [rs, wall] = await timed(() => pool(CONC, clinics.flatMap(c => c.visits.map((v, i) => () => call('POST', `/api/v1/visits/${v}/care`, c.dentist, { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: fee(i) })))));
    phases.push(stats('care.confirm', rs, wall));
    [rs, wall] = await timed(() => pool(CONC, clinics.flatMap(c => c.visits.flatMap((v, i) => [0, 1].map(j => () =>
      call('POST', `/api/v1/visits/${v}/payments`, c.desk, { amountMillimes: j === 0 ? (fee(i) / 5) * 2 : (fee(i) / 5) * 3, tender: (i + j) % 3 === 0 ? 'CARD' : 'CASH' }))))));
    phases.push(stats('payments.record (with receipt)', rs, wall));
    (report.checks as Record<string, unknown>).afterPayments = await financialInvariants(db, 'after payments');

    // ---- phase 3: contention: 20 concurrent payments of 10 TND on one 50 TND visit (exactly 5 may succeed). The desk
    // confirms duplicates here, so the overpayment guard (not the duplicate guard) is what is exercised.
    const c0 = clinics[0]!;
    const pc = await call('POST', '/api/v1/patients', c0.desk, { familyName: 'Fictif', givenName: 'Contention', isSynthetic: true, confirmNotDuplicate: true });
    const cv = await call('POST', '/api/v1/visits', c0.desk, { patientId: pc.body.patient.id, scheduledAt: '2026-10-27T08:00:00Z' });
    await call('POST', `/api/v1/visits/${cv.body.visit.id}/care`, c0.dentist, { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: 50_000 });
    [rs, wall] = await timed(() => Promise.all(Array.from({ length: 20 }, () => call('POST', `/api/v1/visits/${cv.body.visit.id}/payments`, c0.desk, { amountMillimes: 10_000, tender: 'CASH', confirmDuplicate: true }))));
    phases.push(stats('payments.same-visit contention (20 x 10 TND on 50 TND)', rs, wall, r => r.status === 201 || r.status === 409));
    check(rs.filter(r => r.status === 201).length === 5, `contention: ${rs.filter(r => r.status === 201).length} payments accepted, expected exactly 5`);
    // Idempotent retry storm: the same key 10 times concurrently = one payment, one receipt.
    const key = 'b_retry_' + Date.now();
    const pc2 = await call('POST', '/api/v1/patients', c0.desk, { familyName: 'Fictif', givenName: 'Retry', isSynthetic: true, confirmNotDuplicate: true });
    const rv = await call('POST', '/api/v1/visits', c0.desk, { patientId: pc2.body.patient.id, scheduledAt: '2026-10-27T08:30:00Z' });
    await call('POST', `/api/v1/visits/${rv.body.visit.id}/care`, c0.dentist, { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: 30_000 });
    [rs, wall] = await timed(() => Promise.all(Array.from({ length: 10 }, () => call('POST', `/api/v1/visits/${rv.body.visit.id}/payments`, c0.desk, { amountMillimes: 30_000, tender: 'CASH' }, { 'idempotency-key': key }))));
    const receiptsSeen = new Set(rs.filter(r => r.status === 201 || r.status === 200).map(r => r.body.receipt?.number));
    phases.push(stats('payments.idempotent retry storm (10 x same key)', rs, wall, r => r.status === 201 || r.status === 200 || r.status === 409));
    const retryRows = await sql<{ n: number }>(db, 'SELECT count(*)::int AS n FROM payments WHERE visit_id = $1', [rv.body.visit.id]);
    check(retryRows[0]!.n === 1 && receiptsSeen.size <= 1, `retry storm: ${retryRows[0]!.n} payments, ${receiptsSeen.size} receipt numbers (expected 1/1)`);
    (report.checks as Record<string, unknown>).contention = { accepted: 5, retryStormPayments: retryRows[0]!.n };

    // ---- phase 4: isolation probes under load: every cross-clinic read must be 404, every desk->owner call 403
    const probes: Array<() => Promise<Res>> = [];
    for (let i = 0; i < 400; i++) {
      const a = clinics[i % CLINICS]!, b = clinics[(i + 1) % CLINICS]!;
      const pid = b.patients[i % b.patients.length]!, vid = b.visits[i % b.visits.length]!;
      probes.push(() => call('GET', `/api/v1/patients/${pid}`, a.desk), () => call('GET', `/api/v1/visits/${vid}/balance`, a.desk), () => call('GET', '/api/v1/owner/exceptions', a.desk));
    }
    [rs, wall] = await timed(() => pool(CONC, probes));
    phases.push(stats('isolation probes (cross-clinic reads, desk->owner)', rs, wall, r => r.status === 404 || r.status === 403));
    (report.checks as Record<string, unknown>).isolationLeaks = rs.filter(r => r.status === 200).length;
    check(rs.filter(r => r.status === 200).length === 0, 'isolation: a cross-clinic or cross-role request returned 200');

    // ---- phase 5: blind cash count submitted while cash payments are still arriving. Invariants: the expected figure stored
    // at count time equals the owner review's recomputation for that cut, and expected-at-cut + cash recorded after the
    // cut = the final recorded drawer (no payment on both sides of the cut, none on neither).
    const c1 = clinics[1 % CLINICS]!;
    const raceVisits = c1.visits.slice(0, 120);
    const extraCare = await pool(CONC, raceVisits.map(v => () => call('POST', `/api/v1/visits/${v}/care`, c1.dentist, { procedureCode: 'XRAY', procedureLabel: 'Fictional radiograph', feeMillimes: 15_001 })));
    check(extraCare.every(r => r.status === 201), 'cash race: extra care failed');
    const drawer = async () => Number((await sql<{ s: number }>(db, "SELECT (SELECT opening_float_millimes FROM cash_periods WHERE id = $1) + coalesce((SELECT sum(amount_millimes) FROM payments WHERE clinic_id = $2 AND tender = 'CASH'), 0)::bigint AS s", [c1.periodId, c1.id]))[0]!.s);
    let raceDone = 0;
    const raceStart = performance.now();
    const racing = pool(4, raceVisits.map(v => async () => { const r = await call('POST', `/api/v1/visits/${v}/payments`, c1.desk, { amountMillimes: 15_001, tender: 'CASH' }); raceDone++; return r; }));
    while (raceDone < raceVisits.length / 3) await new Promise(r => setTimeout(r, 2));
    const counted = await drawer(); // simulated physical count: the recorded drawer just before submitting
    const doneAtCount = raceDone;
    const count = await call('POST', `/api/v1/cash/periods/${c1.periodId}/counts`, c1.dentist, { countedMillimes: counted });
    const raceDoneAtCountReturn = raceDone;
    const raceRes = await racing;
    phases.push(stats('payments racing a blind cash count', raceRes, performance.now() - raceStart));
    const review = await call('GET', `/api/v1/cash/periods/${c1.periodId}/review`, c1.owner);
    const stored = await sql<{ expected_millimes: number; difference_millimes: number }>(db, 'SELECT expected_millimes, difference_millimes FROM cash_counts WHERE period_id = $1 ORDER BY attempt_no DESC LIMIT 1', [c1.periodId]);
    const finalDrawer = await drawer();
    const afterCut = review.body?.cashRecordedAfterLatestCount?.totalMillimes ?? null;
    (report.checks as Record<string, unknown>).cashRace = { racePayments: raceVisits.length, completedWhenCounted: doneAtCount, completedWhenCountReturned: raceDoneAtCountReturn, countLatencyMs: Math.round(count.ms), raceWallMs: Math.round(performance.now() - raceStart), countStatus: count.status, countedMillimes: counted,
      storedExpectedAtCut: stored[0]?.expected_millimes, reviewRecomputedExpected: review.body?.expected?.expectedMillimes ?? null, recordedAfterCutMillimes: afterCut, finalDrawerMillimes: finalDrawer,
      simulationSkewMillimes: stored[0] ? counted - stored[0].expected_millimes : null };
    check(review.status === 200 && stored[0]?.expected_millimes === review.body?.expected?.expectedMillimes,
      `cash race: expected stored at count time (${stored[0]?.expected_millimes}) differs from the owner review recomputation (${review.body?.expected?.expectedMillimes})`);
    check(stored[0] !== undefined && afterCut !== null && stored[0].expected_millimes + afterCut === finalDrawer,
      `cash race: expected-at-cut ${stored[0]?.expected_millimes} + recorded-after-cut ${afterCut} != final drawer ${finalDrawer}`);

    // ---- phase 6: reads and checks at size
    const reads: Array<[string, (c: typeof clinics[number]) => Promise<Res>]> = [
      ['day-board', c => call('GET', '/api/v1/day-board?date=2026-10-05', c.desk)],
      ['patients.search', c => call('GET', '/api/v1/patients?q=Fictif1', c.desk)],
      ['owner.exceptions', c => call('GET', '/api/v1/owner/exceptions', c.owner)],
      ['integrity.check (full recomputation)', c => call('POST', '/api/v1/integrity/check', c.owner, {})],
    ];
    for (const [name, fn] of reads) {
      // Sequential first (one request at a time: the latency one user sees), then 4 at a time (several clinics at once).
      [rs, wall] = await timed(() => pool(1, clinics.map(c => () => fn(c))));
      phases.push(stats(name + ' [sequential]', rs, wall));
      [rs, wall] = await timed(() => pool(4, clinics.flatMap(c => [() => fn(c), () => fn(c)])));
      phases.push(stats(name + ' [4 concurrent]', rs, wall));
    }
    const integ = await pool(CLINICS, clinics.map(c => () => call('POST', '/api/v1/integrity/check', c.owner, {})));
    const findings = integ.flatMap(r => (r.body.findings ?? []) as Array<{ check: string }>);
    (report.checks as Record<string, unknown>).integrityFindings = findings.map(f => f.check);
    check(findings.length === 0, `integrity after load: ${findings.map(f => f.check).join(', ')}`);

    // ---- phase 7: SIGKILL in the middle of a payment burst; restart; nothing acknowledged may be lost
    const c2 = clinics[2 % CLINICS]!;
    const burstVisits: string[] = [];
    for (let i = 0; i < Math.ceil(KILL_BURST / 4); i++) {
      const v = await call('POST', '/api/v1/visits', c2.desk, { patientId: c2.patients[i % c2.patients.length], scheduledAt: '2026-10-26T10:00:00Z' });
      await call('POST', `/api/v1/visits/${v.body.visit.id}/care`, c2.dentist, { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: 40_000 });
      burstVisits.push(v.body.visit.id);
    }
    const before = (await sql<{ n: number }>(db, 'SELECT count(*)::int AS n FROM payments WHERE clinic_id = $1', [c2.id]))[0]!.n;
    const keys = Array.from({ length: KILL_BURST }, (_, i) => `b_kill_${i}_${Date.now()}`);
    let done = 0;
    const burst = pool(CONC, keys.map((k, i) => async () => { const r = await call('POST', `/api/v1/visits/${burstVisits[i % burstVisits.length]}/payments`, c2.desk, { amountMillimes: 10_000, tender: 'CASH', confirmDuplicate: true }, { 'idempotency-key': k }); done++; return { k, r }; }));
    while (done < KILL_BURST / 2) await new Promise(r => setTimeout(r, 5));
    const killedAt = done;
    await killServer(server); server = null;
    const results = await burst;
    const acked = results.filter(x => x.r.status === 201);
    const lost = results.filter(x => x.r.status === -1).length;
    server = await spawnServer(db.appUrl, port);
    const persisted = new Set((await sql<{ key: string }>(db, 'SELECT key FROM idempotency_records WHERE clinic_id = $1', [c2.id])).map(r => r.key));
    const missing = acked.filter(x => !persisted.has(x.k)).length;
    const after = (await sql<{ n: number }>(db, 'SELECT count(*)::int AS n FROM payments WHERE clinic_id = $1', [c2.id]))[0]!.n;
    // Retrying every request whose answer was lost must never create a second payment for an already-committed key.
    const retried = await pool(CONC, results.filter(x => x.r.status !== 201 && x.r.status !== 409).map(x => () => call('POST', `/api/v1/visits/${burstVisits[keys.indexOf(x.k) % burstVisits.length]}/payments`, c2.desk, { amountMillimes: 10_000, tender: 'CASH', confirmDuplicate: true }, { 'idempotency-key': x.k })));
    const final = (await sql<{ n: number }>(db, 'SELECT count(*)::int AS n FROM payments WHERE clinic_id = $1', [c2.id]))[0]!.n;
    const distinctKeys = (await sql<{ n: number }>(db, "SELECT count(*)::int AS n FROM idempotency_records WHERE clinic_id = $1 AND key LIKE 'b\\_kill\\_%' AND response_status = 201", [c2.id]))[0]!.n;
    (report.checks as Record<string, unknown>).kill = { burst: KILL_BURST, completedBeforeKill: killedAt, acknowledged201: acked.length, connectionErrors: lost, acknowledgedButMissing: missing,
      paymentsCommittedByBurst: after - before, retriedAfterRestart: retried.length, retryStatuses: [...new Set(retried.map(r => r.status))], paymentsAfterRetry: final - before, distinctKeysCommitted: distinctKeys };
    check(missing === 0, `kill: ${missing} acknowledged payment(s) missing after restart`);
    check(final - before === distinctKeys, `kill: ${final - before} payments for ${distinctKeys} committed idempotency keys (duplicate after retry?)`);
    (report.checks as Record<string, unknown>).afterKill = await financialInvariants(db, 'after kill + retry');
    const integ2 = await pool(CLINICS, clinics.map(c => () => call('POST', '/api/v1/integrity/check', c.owner, {})));
    const f2 = integ2.flatMap(r => (r.body.findings ?? []) as Array<{ check: string }>);
    check(f2.length === 0, `integrity after kill: ${f2.map(f => f.check).join(', ')}`);

    // ---- phase 8: backup + fresh restore of the loaded database
    const work = mkdtempSync(join(tmpdir(), 'ezz-bench-'));
    const target = `ezz_bench_restore_${Date.now()}`;
    try {
      const passphrase = 'fictional-bench-backup-passphrase';
      const [b, tb] = await timed(() => createBackup({ adminUrl: process.env.EZZ_TEST_ADMIN_URL!, database: db.name, outDir: work, passphrase, name: 'bench' }));
      const [r, tr] = await timed(() => restoreAndVerify({ passphrase, targetAdminUrl: process.env.EZZ_TEST_ADMIN_URL!, migrationsDir: MIGRATIONS_DIR, encryptedPath: b.encryptedPath, manifestPath: b.manifestPath,
        targetDatabase: target, rolePasswords: { owner: new URL(db.ownerUrl).password, app: new URL(db.appUrl).password } }));
      (report.checks as Record<string, unknown>).backup = { backupMs: Math.round(tb), encryptedBytes: statSync(b.encryptedPath).size, restoreAndVerifyMs: Math.round(tr), ok: r.ok, failed: r.checks.filter(c => !c.ok).map(c => c.name) };
      check(r.ok, `restore drill failed: ${r.checks.filter(c => !c.ok).map(c => c.name).join(', ')}`);
    } finally {
      rmSync(work, { recursive: true, force: true });
      const a = await adminConn(); try { await a.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`); } finally { a.end(); }
    }
    const sizes = (await sql<Record<string, number>>(db, `SELECT (SELECT count(*) FROM clinics)::int AS clinics, (SELECT count(*) FROM patients)::int AS patients, (SELECT count(*) FROM visits)::int AS visits,
        (SELECT count(*) FROM care_items)::int AS care_items, (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM receipts)::int AS receipts, (SELECT count(*) FROM audit_events)::int AS audit_events`))[0]!;
    (report.checks as Record<string, unknown>).datasetRows = sizes; // exact counts (pg_stat n_live_tup is only an estimate)
    (report.checks as Record<string, unknown>).receiptsByKind = Object.fromEntries((await sql<{ kind: string; n: number }>(db, 'SELECT kind, count(*)::int AS n FROM receipts GROUP BY kind ORDER BY kind')).map(r => [r.kind, r.n]));
    (report.checks as Record<string, unknown>).databaseBytes = (await sql<{ b: number }>(db, 'SELECT pg_database_size(current_database())::bigint AS b'))[0]!.b;
  } finally {
    if (server) await killServer(server);
    if (process.env.BENCH_KEEP_DB === '1') process.stderr.write(`kept database ${db.name}\n`); else await db.drop();
  }
  report.violations = violations;
  const out = JSON.stringify(report, null, 2);
  const i = process.argv.indexOf('--out');
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, out + '\n');
  process.stdout.write(out + '\n');
  process.exit(violations.length ? 1 : 0);
}

await main();
