/*
 * R73 package A — owner-controlled independent audit checkpoints: create, keep outside (line + printable sheet),
 * verify from the kept line, detect tampering / removed records / rollback / stale checkpoints / restore of an older
 * backup. Fictional data only. A checkpoint can never reveal money or care that was never recorded (CH-002).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, startApi, standardFixture, confirmCare, reauth, adminConn, type Api, type TestDb } from './helpers.ts';
import { canonicalJson, sha256 } from '../src/platform/canonical.ts';
import { parseCheckpointLine, checkpointLine } from '../src/modules/checkpoints.ts';
import { createBackup, restoreAndVerify } from '../src/ops/disaster-recovery.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic() {
  const f = await standardFixture(api, db, `r73-cp-${++n}`);
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  const pay = await api.call('POST', `/api/v1/visits/${f.visitId}/payments`, { token: f.desk, body: { amountMillimes: 70_000, tender: 'CASH' } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  return { ...f, paymentId: pay.body.payment.id as string };
}
async function checkpoint(owner: string, body: Record<string, unknown> = {}) {
  await reauth(api, owner);
  const r = await api.call('POST', '/api/v1/owner/checkpoints', { token: owner, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const verify = (owner: string, lines: string[]) => api.call('POST', '/api/v1/owner/checkpoints/verify', { token: owner, body: { lines }, idem: false });

/** Superuser rewrites one payment's audit event and every later event with valid hashes (B06 T-INT-LIMIT-1 method). */
async function rewriteChainFrom(clinicId: string, entityId: string, alsoInternalCopies: boolean) {
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    const evs = (await a.query<{ seq: number; canonical: string; entity_id: string; action: string }>('SELECT seq, canonical, entity_id, action FROM audit_events WHERE clinic_id = $1 ORDER BY seq', [clinicId] as never[])).rows;
    const start = Number(evs.find(e => e.action === 'payment.recorded' && e.entity_id === entityId)!.seq);
    let prev = (await a.query<{ hash: string }>('SELECT hash FROM audit_events WHERE clinic_id = $1 AND seq = $2', [clinicId, start - 1] as never[])).rows[0]!.hash;
    for (const e of evs.filter(x => Number(x.seq) >= start)) {
      const doc = JSON.parse(e.canonical);
      if (Number(e.seq) === start) doc.payload = { ...doc.payload, amountMillimes: 7000 };
      doc.prevHash = prev;
      const canonical = canonicalJson(doc); const hash = sha256(prev + '\n' + canonical);
      await a.query('UPDATE audit_events SET payload = $3, canonical = $4, prev_hash = $5, hash = $6 WHERE clinic_id = $1 AND seq = $2', [clinicId, e.seq, doc.payload, canonical, prev, hash] as never[]);
      if (alsoInternalCopies) await a.query('UPDATE audit_checkpoints SET hash = $3 WHERE clinic_id = $1 AND seq = $2', [clinicId, e.seq, hash] as never[]);
      prev = hash;
    }
    await a.query('UPDATE payments SET amount_millimes = 7000 WHERE id = $1', [entityId] as never[]);
    await a.query('UPDATE payment_allocations SET amount_millimes = 7000 WHERE payment_id = $1', [entityId] as never[]);
    await a.query('UPDATE audit_heads SET last_hash = $2 WHERE clinic_id = $1', [clinicId, prev] as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
}

test('T-CP-1 the owner creates a checkpoint: one line with a check code, a printable FR/AR sheet, no patient data; desk and dentist cannot', async () => {
  const s = await clinic();
  const cp = await checkpoint(s.owner, { lang: 'both', size: 'large', format: 'html', note: 'Fictional end of day' });
  assert.match(cp.line, /^EZZ-CP2 clinic=r73-cp-\d+ seq=\d+ hash=[0-9a-f]{64} at=\S+ check=[0-9a-f]{8}$/);
  const p = parseCheckpointLine(cp.line);
  assert.ok(p.ok && !p.legacy && p.fields.seq === cp.checkpoint.seq && p.fields.hash === cp.checkpoint.hash);
  assert.equal(cp.checkpoint.hashGroups.replace(/ /g, ''), cp.checkpoint.hash);
  assert.deepEqual(cp.document.sections.map((x: { dir: string }) => x.dir), ['ltr', 'rtl']);
  assert.equal(cp.document.fontPt, 18);
  assert.ok(cp.html.includes(`<bdi dir="ltr">${cp.line}</bdi>`), 'the full line is printed, bidi-isolated');
  assert.ok(!JSON.stringify(cp).includes('Fictif'), 'no patient data on the checkpoint sheet');
  assert.match(cp.scope, /never recorded/);
  for (const t of [s.desk, s.dentist]) assert.equal((await api.call('POST', '/api/v1/owner/checkpoints', { token: t, body: {} })).status, 403);
  assert.equal((await verify(s.desk, [cp.line])).status, 403);
});

test('T-CP-2 verifying kept lines: match, mistyped line (CHECKSUM_FAILED, never "tampered"), wrong clinic, malformed, legacy line', async () => {
  const s = await clinic();
  const cp = await checkpoint(s.owner);
  const other = await clinic();
  const otherCp = await checkpoint(other.owner);
  const typo = cp.line.replace(/hash=([0-9a-f])/, (_m: string, c: string) => `hash=${c === 'a' ? 'b' : 'a'}`);
  const legacy = await (async () => { await reauth(api, s.owner); return (await api.call('POST', '/api/v1/audit/checkpoints', { token: s.owner, body: {} })).body.printLine as string; })();
  const r = await verify(s.owner, [cp.line, typo, otherCp.line, 'EZZ-CP2 clinic=x', '  ' + legacy + '  ']);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x: { verdict: string }) => x.verdict), ['MATCHES', 'CHECKSUM_FAILED', 'WRONG_CLINIC', 'MALFORMED', 'MATCHES']);
  assert.match(r.body.results[1].wording, /not evidence of tampering/);
  assert.equal(r.body.results[4].legacyFormat, true);
  assert.equal(r.body.ok, false, 'any non-matching line makes the overall result not ok');
  assert.equal((await verify(s.owner, [cp.line])).body.ok, true);
  assert.equal((await verify(s.owner, [])).status, 400);
});

test('T-CP-3 a superuser rewrites a payment AND the whole audit chain consistently: invisible from inside, caught by the outside line', async () => {
  const s = await clinic();
  const cp = await checkpoint(s.owner);
  await rewriteChainFrom(s.clinic.id, s.paymentId, true); // capable attacker: also rewrites the internal checkpoint copies
  await reauth(api, s.owner);
  const blind = await api.call('POST', '/api/v1/audit/verify', { token: s.owner, body: {}, idem: false });
  assert.equal(blind.body.ok, true, 'documented limit: without an outside copy the rewrite is consistent');
  const r = await verify(s.owner, [cp.line]);
  assert.equal(r.body.results[0].verdict, 'TAMPERED', JSON.stringify(r.body));
  assert.match(r.body.results[0].wording, /does not by itself show who/);
});

test('T-CP-4 (RED before fix) a careless rewrite that leaves the database\'s own checkpoint copies is flagged by the integrity check and status', async () => {
  const s = await clinic();
  await checkpoint(s.owner);
  await rewriteChainFrom(s.clinic.id, s.paymentId, false);
  await reauth(api, s.owner);
  const integ = await api.call('POST', '/api/v1/integrity/check', { token: s.owner, body: {}, idem: false });
  assert.ok(integ.body.findings.some((f: { check: string }) => f.check === 'INTERNAL_CHECKPOINT_MISMATCH'), JSON.stringify(integ.body.findings.map((f: { check: string }) => f.check)));
  const st = await api.call('GET', '/api/v1/owner/checkpoints', { token: s.owner });
  assert.equal(st.body.internalCopies.differing, 1, JSON.stringify(st.body));
});

test('T-CP-5 removed records: the last events deleted and the head moved back consistently -> CHAIN_SHORTER from the outside line', async () => {
  const s = await clinic();
  const before = await checkpoint(s.owner);
  await confirmCare(api, s.dentist, (await api.call('POST', '/api/v1/visits', { token: s.desk, body: { patientId: s.patientId, scheduledAt: '2026-10-27T10:00:00Z' } })).body.visit.id, 20_000);
  const later = await checkpoint(s.owner);
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    await a.query('DELETE FROM audit_events WHERE clinic_id = $1 AND seq > $2', [s.clinic.id, before.checkpoint.seq] as never[]);
    await a.query('DELETE FROM audit_checkpoints WHERE clinic_id = $1 AND seq > $2', [s.clinic.id, before.checkpoint.seq] as never[]);
    await a.query('UPDATE audit_heads SET last_seq = $2, last_hash = $3 WHERE clinic_id = $1', [s.clinic.id, before.checkpoint.seq, before.checkpoint.hash] as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
  const r = await verify(s.owner, [before.line, later.line]);
  assert.deepEqual(r.body.results.map((x: { verdict: string }) => x.verdict), ['MATCHES', 'CHAIN_SHORTER']);
  assert.match(r.body.results[1].wording, /older backup was restored/);
});

test('T-CP-6 stale checkpoints: never taken -> due; older than 7 days -> due with age; a fresh one clears it; events since are counted', async () => {
  const s = await clinic();
  await reauth(api, s.owner);
  let st = (await api.call('GET', '/api/v1/owner/checkpoints', { token: s.owner })).body;
  assert.equal(st.due, true); assert.equal(st.last, null); assert.ok(st.eventsSinceLast > 0);
  const head = await (async () => { const a = await adminConn(db.name); try { return (await a.query<{ last_seq: number; last_hash: string }>('SELECT last_seq, last_hash FROM audit_heads WHERE clinic_id = $1', [s.clinic.id] as never[])).rows[0]!; } finally { a.end(); } })();
  const a = await adminConn(db.name);
  try { await a.query("INSERT INTO audit_checkpoints (clinic_id, seq, hash, created_by, created_at) VALUES ($1,$2,$3,$4, now() - interval '10 days')", [s.clinic.id, head.last_seq, head.last_hash, s.clinic.staff.owner] as never[]); } finally { a.end(); }
  st = (await api.call('GET', '/api/v1/owner/checkpoints', { token: s.owner })).body;
  assert.equal(st.due, true); assert.ok(st.last.ageDays >= 10, JSON.stringify(st.last));
  await checkpoint(s.owner);
  st = (await api.call('GET', '/api/v1/owner/checkpoints', { token: s.owner })).body;
  assert.equal(st.due, false); assert.equal(st.last.ageDays, 0); assert.equal(st.eventsSinceLast, 0);
  assert.equal(st.internalCopies.differing, 0);
});

test('T-CP-7 restore: an OLDER backup restored after a newer checkpoint is caught from the printed line; the latest backup passes', async () => {
  // Own database: the other tests deliberately tamper with their clinics, which a whole-database restore would include.
  const ownDb = await createTestDb(); const ownApi = await startApi(ownDb.appUrl);
  const outer = { db, api }; db = ownDb; api = ownApi;
  try {
  const s = await clinic();
  const adminUrl = process.env.EZZ_TEST_ADMIN_URL!;
  const work = mkdtempSync(join(tmpdir(), 'ezz-r73-cp-'));
  const targets = [`ezz_r73_cp_old_${Date.now()}`, `ezz_r73_cp_new_${Date.now()}`];
  const base = { passphrase: 'fictional-r73-checkpoint-pass', targetAdminUrl: adminUrl, migrationsDir: MIGRATIONS_DIR,
    rolePasswords: { owner: new URL(db.ownerUrl).password, app: new URL(db.appUrl).password } };
  try {
    const first = await checkpoint(s.owner);
    const oldBackup = await createBackup({ adminUrl, database: db.name, outDir: work, passphrase: base.passphrase, name: 'old' });
    await confirmCare(api, s.dentist, (await api.call('POST', '/api/v1/visits', { token: s.desk, body: { patientId: s.patientId, scheduledAt: '2026-10-27T11:00:00Z' } })).body.visit.id, 15_000);
    const second = await checkpoint(s.owner);
    const newBackup = await createBackup({ adminUrl, database: db.name, outDir: work, passphrase: base.passphrase, name: 'new' });
    const lines = [first.line, second.line, 'EZZ-CP2 clinic=nope'];
    const old = await restoreAndVerify({ ...base, encryptedPath: oldBackup.encryptedPath, manifestPath: oldBackup.manifestPath, targetDatabase: targets[0]!, checkpointLines: lines });
    assert.equal(old.ok, false);
    const code = old.checks.find(c => c.name.startsWith('CHECKPOINT_LINES:') && c.name.endsWith(s.clinic.code))!;
    assert.equal(code.ok, false); assert.match(code.detail, /CHAIN_SHORTER/);
    assert.equal(old.checks.find(c => c.name === 'CHECKPOINT_LINES_READABLE')!.ok, false, 'an unreadable line is reported, not ignored');
    const fresh = await restoreAndVerify({ ...base, encryptedPath: newBackup.encryptedPath, manifestPath: newBackup.manifestPath, targetDatabase: targets[1]!, checkpointLines: [first.line, second.line] });
    assert.equal(fresh.ok, true, JSON.stringify(fresh.checks.filter(c => !c.ok)));
    assert.match(fresh.checks.find(c => c.name === `CHECKPOINT_LINES:${s.clinic.code}`)!.detail, /2 owner checkpoint line\(s\) match/);
  } finally {
    rmSync(work, { recursive: true, force: true });
    const a = await adminConn();
    try { for (const t of targets) await a.query(`DROP DATABASE IF EXISTS ${t} WITH (FORCE)`); } finally { a.end(); }
  }
  } finally { await ownApi.close(); await ownDb.drop(); db = outer.db; api = outer.api; }
});

test('T-CP-8 line format: every field is covered by the check code; tolerant of surrounding spaces and upper-case hex', () => {
  const f = { clinicCode: 'demo-clinic', seq: 42, hash: 'ab'.repeat(32), at: '2026-10-28T21:00:00.000Z' };
  const line = checkpointLine(f);
  assert.ok(parseCheckpointLine(`   ${line}   `).ok, 'surrounding spaces are tolerated');
  for (const [from, to] of [['seq=42', 'seq=43'], ['clinic=demo-clinic', 'clinic=demo-clinix'], ['at=2026-10-28', 'at=2026-10-29']] as const) {
    const p = parseCheckpointLine(line.replace(from, to));
    assert.ok(!p.ok && p.reason === 'CHECKSUM_FAILED', `${from} -> ${to}`);
  }
  const ok = parseCheckpointLine(line.replace(/hash=([0-9a-f]+)/, (_m, h: string) => `hash=${h.toUpperCase()}`));
  assert.ok(ok.ok, 'upper-case hex in the hash is accepted');
});
