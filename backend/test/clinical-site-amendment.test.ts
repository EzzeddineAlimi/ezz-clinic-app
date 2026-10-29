/*
 * SITE AMENDMENT (CH-032 / C-172 / C-173): a dentist corrects the tooth/surfaces of a signed CARE item.
 * The original row is preserved, the amendment links to it, totals/payments/receipts never move, the chain
 * is linear under concurrency, and only an authenticated dentist of the same clinic can do it.
 * All data synthetic. Whether a signed record may be amended this way under Tunisian rules is UNVERIFIED.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, seedClinic, key, type Api, type TestDb } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/postgres.ts';

let db: TestDb; let api: Api;
let A: Awaited<ReturnType<typeof standardFixture>>;
let B: Awaited<ReturnType<typeof standardFixture>>;
let assistant: string;

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  A = await standardFixture(api, db, 'amend-a');
  B = await standardFixture(api, db, 'amend-b');
  await seedClinic(db, 'amend-c', [{ username: 'assistant', roles: ['ASSISTANT'] }]);
  assistant = await api.login('amend-c', 'assistant');
});
after(async () => { await api.close(); await db.drop(); });

let slot = 0;
async function careOn(tooth: number | null, surfaces: string | null, fee = 50_000) {
  const v = await newVisit(api, A.desk, A.patientId, `2026-11-03T${String(7 + (slot % 12)).padStart(2, '0')}:${String(slot++).padStart(2, '0')}:00Z`);
  const r = await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: { procedureCode: 'RESTO', procedureLabel: 'Fictional restoration', feeMillimes: fee, toothFdi: tooth, surfaces } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { visitId: v, careId: r.body.careItem.id as string };
}
const amend = (careId: string, body: Record<string, unknown>, token = A.dentist, idem?: string) =>
  api.call('POST', `/api/v1/care-items/${careId}/site-amendments`, { token, body, idem });
const ownerSql = async <T>(clinicId: string, fn: (c: PgConnection) => Promise<T>, url = db.appUrl) => {
  const c = new PgConnection(parseDatabaseUrl(url));
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.end(); }
};

test('T-CL-AMEND-1 money neutral: total, balance, payments and receipts are identical before and after', async () => {
  const { visitId, careId } = await careOn(36, 'MOD');
  const pay = await api.call('POST', `/api/v1/visits/${visitId}/payments`, { token: A.desk, body: { amountMillimes: 20_000, tender: 'CASH' } });
  assert.equal(pay.status, 201);
  const wb = async () => (await api.call('GET', `/api/v1/visits/${visitId}/workbench`, { token: A.owner })).body.visit;
  const before = await wb();
  const r = await amend(careId, { toothFdi: 46, surfaces: 'MOD', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.visitTotalMillimes, 50_000);
  assert.deepEqual(r.body.siteAmendment.previousSite, { toothFdi: 36, surfaces: 'MOD' });
  assert.deepEqual(r.body.effectiveSite, { toothFdi: 46, surfaces: 'MOD' });
  const after = await wb();
  assert.deepEqual(after.balance, before.balance);
  assert.deepEqual(after.payments, before.payments);
  assert.deepEqual(after.adjustments, before.adjustments);
  assert.equal(after.nextAction, before.nextAction);
  assert.equal(after.provenance.siteAmendmentCount, 1);
});

test('T-CL-AMEND-2 history: original row unchanged, amendment linked, effective site exposed', async () => {
  const { visitId, careId } = await careOn(36, 'MO');
  const r = await amend(careId, { toothFdi: 36, surfaces: 'DO', reasonCode: 'WRONG_SURFACE', reasonNote: 'Fictional: distal not mesial', expectedSupersedesId: null });
  assert.equal(r.status, 201);
  const items = (await api.call('GET', `/api/v1/visits/${visitId}/care`, { token: A.dentist })).body.items;
  assert.equal(items.length, 1, 'an amendment is not a new billable care row');
  const c = items[0];
  assert.deepEqual([c.toothFdi, c.surfaces], [36, 'MO'], 'original site preserved');
  assert.deepEqual([c.effectiveToothFdi, c.effectiveSurfaces], [36, 'OD']);
  assert.equal(c.siteAmended, true);
  assert.equal(c.amendmentCount, 1);
  assert.equal(c.siteAmendments[0].reasonCode, 'WRONG_SURFACE');
  assert.equal(c.siteAmendments[0].amendedByName, 'Fictional dentist');
  assert.deepEqual(c.siteAmendments[0].newSite, { toothFdi: 36, surfaces: 'OD' });
  const desk = (await api.call('GET', `/api/v1/visits/${visitId}/care`, { token: A.desk })).body.items[0];
  assert.equal(desk.siteAmendments[0].hasNote, true);
  assert.equal('reasonNote' in desk.siteAmendments[0], false, 'receptionist does not get the free-text note (T-CL-AMEND-PRIV-1)');
  const wb = (await api.call('GET', `/api/v1/visits/${visitId}/workbench`, { token: A.desk })).body.visit;
  assert.equal(wb.care[0].siteAmended, true);
  assert.deepEqual([wb.care[0].effectiveToothFdi, wb.care[0].effectiveSurfaces], [36, 'OD']);
});

test('T-CL-AMEND-3 chain: stale expectation -> 409 with current head; concurrent amendments -> exactly one wins', async () => {
  const { careId } = await careOn(36, 'O');
  const first = await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null });
  assert.equal(first.status, 201);
  const stale = await amend(careId, { toothFdi: 47, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'SITE_AMENDMENT_STALE');
  assert.equal(stale.body.error.details.currentHeadId, first.body.siteAmendment.id);
  const head = first.body.siteAmendment.id;
  const results = await Promise.all([47, 45, 44, 37].map(t => amend(careId, { toothFdi: t, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: head })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409, 409], JSON.stringify(results.map(r => r.body)));
  const winner = results.find(r => r.status === 201)!;
  assert.equal(winner.body.siteAmendment.supersedesId, head);
  assert.deepEqual(winner.body.siteAmendment.previousSite, { toothFdi: 46, surfaces: 'O' });
  const n = await ownerSql(A.clinic.id, c => c.query('SELECT count(*)::int AS n FROM care_site_amendments WHERE care_item_id = $1', [careId]));
  assert.equal(n.rows[0]!.n, 2);
});

test('T-CL-AMEND-4 no-op and replay: same site -> SITE_UNCHANGED; same Idempotency-Key -> stored response, one row', async () => {
  const { careId } = await careOn(36, 'MOD');
  const same = await amend(careId, { toothFdi: 36, surfaces: 'DOM', reasonCode: 'TRANSCRIPTION', expectedSupersedesId: null });
  assert.equal(same.status, 409);
  assert.equal(same.body.error.code, 'SITE_UNCHANGED', 'DOM is the same canonical site as MOD');
  const k = key();
  const body = { toothFdi: 37, surfaces: 'MOD', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null };
  const one = await amend(careId, body, A.dentist, k);
  const two = await amend(careId, body, A.dentist, k);
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.equal(two.body.replayed, true);
  assert.equal(two.body.siteAmendment.id, one.body.siteAmendment.id);
  const fresh = await amend(careId, body);
  assert.equal(fresh.status, 409, 'new key, same request: stale expectation, never a second row');
});

test('T-CL-AMEND-5 a later fee correction carries the effective site, not the amended-away one', async () => {
  const { visitId, careId } = await careOn(36, 'O');
  assert.equal((await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null })).status, 201);
  const corr = await api.call('POST', `/api/v1/care-items/${careId}/corrections`, { token: A.dentist, body: { deltaMillimes: -10_000, reason: 'Fictional fee lowered' } });
  assert.equal(corr.status, 201);
  assert.equal(corr.body.visitTotalMillimes, 40_000);
  const items = (await api.call('GET', `/api/v1/visits/${visitId}/care`, { token: A.dentist })).body.items;
  const c = items.find((i: { kind: string }) => i.kind === 'CORRECTION');
  assert.deepEqual([c.toothFdi, c.surfaces], [46, 'O']);
  const care = items.find((i: { kind: string }) => i.kind === 'CARE');
  assert.deepEqual([care.effectiveToothFdi, care.effectiveSurfaces], [46, 'O']);
});

test('T-CL-AMEND-6 duplicate guard uses the effective site', async () => {
  const { visitId, careId } = await careOn(36, 'O');
  assert.equal((await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null })).status, 201);
  const body = (tooth: number) => ({ procedureCode: 'RESTO', procedureLabel: 'Fictional restoration', feeMillimes: 50_000, toothFdi: tooth, surfaces: 'O' });
  const dup = await api.call('POST', `/api/v1/visits/${visitId}/care`, { token: A.dentist, body: body(46) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CARE_ALREADY_CONFIRMED');
  const old = await api.call('POST', `/api/v1/visits/${visitId}/care`, { token: A.dentist, body: body(36) });
  assert.equal(old.status, 201, 'the amended-away site is free again');
});

test('T-CL-AMEND-ROLE-1/2 receptionist, owner and assistant cannot amend; body identity and fee fields never apply', async () => {
  const { careId } = await careOn(36, 'O');
  const body = { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null };
  for (const t of [A.desk, A.owner]) {
    const r = await amend(careId, body, t);
    assert.equal(r.status, 403);
  }
  assert.equal((await amend(careId, body, assistant)).status, 403);
  const withFee = await amend(careId, { ...body, feeMillimes: 0 });
  assert.equal(withFee.status, 400);
  const spoof = await amend(careId, { ...body, amendedBy: A.clinic.staff.owner, role: 'OWNER', clinicId: B.clinic.id });
  assert.equal(spoof.status, 201);
  assert.equal(spoof.body.siteAmendment.amendedBy, A.clinic.staff.dentist);
  const audit = await ownerSql(A.clinic.id, c => c.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'care.site_amended' AND entity_id = $1", [careId]));
  assert.equal(audit.rows[0]!.n, 1, 'denied attempts leave no audit event');
});

test('T-CL-AMEND-TENANT-1/2 other clinic, CORRECTION rows and unknown ids -> identical 404', async () => {
  const { careId } = await careOn(36, 'O');
  const body = { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null };
  const foreign = await amend(careId, body, B.dentist);
  const unknown = await amend('00000000-0000-4000-8000-000000000000', body, B.dentist);
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, unknown.body);
  const corr = await api.call('POST', `/api/v1/care-items/${careId}/corrections`, { token: A.dentist, body: { deltaMillimes: 1_000, reason: 'Fictional fee raised' } });
  const onCorrection = await amend(corr.body.correction.id, body);
  assert.equal(onCorrection.status, 404);
  const items = await ownerSql(A.clinic.id, c => c.query('SELECT count(*)::int AS n FROM care_site_amendments WHERE care_item_id = $1', [careId]));
  assert.equal(items.rows[0]!.n, 0);
});

test('T-CL-AMEND-VAL site validation is the same as for confirmation (MM, 36 IF, surfaces without tooth, OTHER without note)', async () => {
  const { careId } = await careOn(36, 'O');
  for (const bad of [{ toothFdi: 36, surfaces: 'MM' }, { toothFdi: 36, surfaces: 'IF' }, { toothFdi: null, surfaces: 'O' }, { toothFdi: 99 }]) {
    const r = await amend(careId, { ...bad, reasonCode: 'WRONG_SURFACE', expectedSupersedesId: null });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'OTHER', expectedSupersedesId: null })).status, 400);
  assert.equal((await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH' })).status, 400, 'expectedSupersedesId must be explicit');
  const noSite = await amend(careId, { toothFdi: null, reasonCode: 'OTHER', reasonNote: 'Fictional: not tooth-specific', expectedSupersedesId: null });
  assert.equal(noSite.status, 201, 'a site can be removed when the procedure was not tooth-specific');
  assert.deepEqual(noSite.body.effectiveSite, { toothFdi: null, surfaces: null });
});

test('T-CL-AMEND-DB-1 the API role cannot rewrite or forge amendment history', async () => {
  const { visitId, careId } = await careOn(36, 'O');
  const r = await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'WRONG_TOOTH', expectedSupersedesId: null });
  const id = r.body.siteAmendment.id as string;
  await assert.rejects(ownerSql(A.clinic.id, c => c.query('UPDATE care_site_amendments SET tooth_fdi = 47 WHERE id = $1', [id])), /permission denied|append-only/);
  await assert.rejects(ownerSql(A.clinic.id, c => c.query('DELETE FROM care_site_amendments WHERE id = $1', [id])), /permission denied|append-only/);
  const ins = (sup: string | null, prevT: number, t: number) => ownerSql(A.clinic.id, c => c.query(`INSERT INTO care_site_amendments (clinic_id, care_item_id, visit_id, patient_id, supersedes_id, previous_tooth_fdi, previous_surfaces, tooth_fdi, surfaces, reason_code, amended_by, amended_by_role)
      VALUES ($1,$2,$3,$4,$5,$6,'O',$7,'O','WRONG_TOOTH',$8,'DENTIST')`, [A.clinic.id, careId, visitId, A.patientId, sup, prevT, t, A.clinic.staff.dentist]));
  await assert.rejects(ins(null, 36, 47), /duplicate key|unique/, 'a second first-amendment (fork) is refused');
  await assert.rejects(ins(id, 36, 47), /previous site does not match/, 'falsified previous site is refused');
  await assert.rejects(ownerSql(A.clinic.id, c => c.query(`INSERT INTO care_site_amendments (clinic_id, care_item_id, visit_id, patient_id, supersedes_id, previous_tooth_fdi, previous_surfaces, tooth_fdi, surfaces, reason_code, amended_by, amended_by_role)
      VALUES ($1,$2,$3,$4,$5,46,'O',47,'MM','WRONG_TOOTH',$6,'DENTIST')`, [A.clinic.id, careId, visitId, A.patientId, id, A.clinic.staff.dentist])), /check constraint/, 'repeated surface letters are refused at DB level');
  await assert.rejects(ownerSql(A.clinic.id, c => c.query(`INSERT INTO care_items (clinic_id, visit_id, patient_id, kind, procedure_code, procedure_label, tooth_fdi, surfaces, fee_millimes, confirmed_by, confirmed_by_role)
      VALUES ($1,$2,$3,'CARE','RESTO','Fictional',NULL,'MOD',1000,$4,'DENTIST')`, [A.clinic.id, visitId, A.patientId, A.clinic.staff.dentist])), /care_items_site_shape/, 'new CARE rows: surfaces need a tooth at DB level too');
});

test('T-CL-AMEND-AUD-1 exactly one audit event; codes and sites only, no free text; chain still verifies', async () => {
  const { careId } = await careOn(36, 'O');
  const r = await amend(careId, { toothFdi: 46, surfaces: 'O', reasonCode: 'OTHER', reasonNote: 'Fictional private clinical wording', expectedSupersedesId: null });
  assert.equal(r.status, 201);
  const ev = await ownerSql(A.clinic.id, c => c.query<{ payload: Record<string, unknown>; canonical: string }>("SELECT payload, canonical FROM audit_events WHERE action = 'care.site_amended' AND entity_id = $1", [careId]));
  assert.equal(ev.rows.length, 1);
  assert.deepEqual(ev.rows[0]!.payload, { amendmentId: r.body.siteAmendment.id, supersedesId: null, previousSite: { toothFdi: 36, surfaces: 'O' }, newSite: { toothFdi: 46, surfaces: 'O' }, reasonCode: 'OTHER', hasNote: true });
  assert.ok(!ev.rows[0]!.canonical.includes('Fictional private'), 'free text never enters the audit chain');
  const { reauth } = await import('./helpers.ts');
  await reauth(api, A.owner);
  const v = await api.call('POST', '/api/v1/audit/verify', { token: A.owner, body: {}, idem: false });
  assert.equal(v.body.ok, true, JSON.stringify(v.body.findings));
  const integ = await api.call('POST', '/api/v1/integrity/check', { token: A.owner, body: {}, idem: false });
  assert.equal(integ.body.ok, true, JSON.stringify(integ.body.findings));
});
