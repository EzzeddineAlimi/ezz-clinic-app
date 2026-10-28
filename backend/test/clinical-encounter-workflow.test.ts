/*
 * DENTIST ENCOUNTER VERTICAL SLICE (B07). A fictional elderly patient with no phone is registered at the
 * desk, declares a medical alert at check-in, the dentist opens the visit, reviews the alerts, records a
 * finding and a signed note, plans treatment, performs it (creating the billable care item), the desk takes
 * a partial cash payment, and the longitudinal record shows everything. Then the dentist corrects a wrong
 * surface without touching money. Plus role, tenant, immutability, concurrency and duplicate-submission
 * cases for notes, findings and plan items. All data synthetic; clinical vocabulary PROVISIONAL.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, seedClinic, key, reauth, type Api, type TestDb } from './helpers.ts';
import { PgConnection, parseDatabaseUrl } from '../src/platform/pgwire.ts';

let db: TestDb; let api: Api;
let A: Awaited<ReturnType<typeof standardFixture>>;
let B: Awaited<ReturnType<typeof standardFixture>>;
let assistant: string;

before(async () => {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  A = await standardFixture(api, db, 'enc-a');
  B = await standardFixture(api, db, 'enc-b');
  await seedClinic(db, 'enc-c', [{ username: 'assistant', roles: ['ASSISTANT'] }]);
  assistant = await api.login('enc-c', 'assistant');
});
after(async () => { await api.close(); await db.drop(); });

const post = (path: string, token: string, body: Record<string, unknown>, idem?: string) => api.call('POST', path, { token, body, idem });
const get = (path: string, token: string) => api.call('GET', path, { token });
async function patient(name: string) {
  const p = await post('/api/v1/patients', A.desk, { familyName: 'Fictif', givenName: name, isSynthetic: true, contactPreference: 'IN_PERSON', preferredLanguage: 'ar' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  return p.body.patient.id as string;
}
let slot = 0;
const visitFor = (patientId: string) => newVisit(api, A.desk, patientId, `2026-11-05T${String(7 + (slot % 12)).padStart(2, '0')}:${String(slot++).padStart(2, '0')}:00Z`);
const appSql = async <T>(clinicId: string, fn: (c: PgConnection) => Promise<T>, url = db.appUrl) => {
  const c = new PgConnection(parseDatabaseUrl(url));
  await c.connect();
  try {
    await c.query('BEGIN'); await c.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.end(); }
};

test('T-ENC-1 full fictional encounter: desk intake -> dentist review/finding/note/plan/perform -> checkout -> longitudinal record -> site amendment', async () => {
  // Desk: elderly walk-in, no phone, Arabic preference; declares "takes a blood thinner" at check-in.
  const pid = await patient('Hedi');
  const vid = await visitFor(pid);
  assert.equal((await post(`/api/v1/patients/${pid}/medical-alerts`, A.desk, { code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL', detail: 'Fictional: patient-declared blood thinner' })).status, 201);
  assert.equal((await post(`/api/v1/visits/${vid}/status`, A.desk, { status: 'ARRIVED' })).status, 200);
  assert.equal((await post(`/api/v1/visits/${vid}/status`, A.desk, { status: 'IN_CHAIR' })).status, 200);
  const deskSummary = await get(`/api/v1/patients/${pid}/medical-alerts/summary`, A.desk);
  assert.equal(deskSummary.body.criticalAlertCount, 1);

  // Dentist opens the visit.
  const enc = await get(`/api/v1/visits/${vid}/encounter`, A.dentist);
  assert.equal(enc.status, 200, JSON.stringify(enc.body));
  assert.equal(enc.body.patient.preferredLanguage, 'ar');
  assert.equal(enc.body.medical.activeAlerts.length, 1);
  assert.equal(enc.body.medical.activeAlerts[0].source, 'PATIENT_DECLARED');
  assert.equal(enc.body.medical.reviewStatus, 'NEVER_REVIEWED');
  assert.equal(enc.body.medical.treatmentGate, 'SEND_ALERT_SET_HASH_WITH_CARE_OR_ACKNOWLEDGE');
  const alertId = enc.body.medical.activeAlerts[0].id;

  // Reviews history: verifies the declared alert, then records the dated review for this visit.
  const ver = await post(`/api/v1/medical-alerts/${alertId}/revisions`, A.dentist, { action: 'VERIFY', expectedRevision: 1 });
  assert.equal(ver.status, 201);
  const rev = await post(`/api/v1/patients/${pid}/medical-history-reviews`, A.dentist, { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: ver.body.alertSetHash, visitId: vid });
  assert.equal(rev.status, 201, JSON.stringify(rev.body));
  assert.equal((await get(`/api/v1/visits/${vid}/encounter`, A.dentist)).body.medical.treatmentGate, 'ACKNOWLEDGED');

  // Observation on 36, signed note, plan for 36 and 46.
  const fnd = await post(`/api/v1/visits/${vid}/chart-findings`, A.dentist, { kind: 'FINDING', toothFdi: 36, surfaces: 'om', conditionCode: 'CARIES', note: 'Fictional finding' });
  assert.equal(fnd.status, 201, JSON.stringify(fnd.body));
  assert.equal(fnd.body.finding.surfaces, 'MO');
  const note = await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { subjective: 'Fictional: pain on chewing left side', objective: 'Fictional: cavity 36', plan: 'Fictional: restoration today' });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  assert.match(note.body.note.contentSha256, /^[0-9a-f]{64}$/);
  const p36 = await post(`/api/v1/patients/${pid}/treatment-plan-items`, A.dentist, { procedureCode: 'RESTO', procedureLabel: 'Fictional composite restoration', toothFdi: 36, surfaces: 'MO', phaseNo: 2, estimatedFeeMillimes: 80_000, visitId: vid });
  const p46 = await post(`/api/v1/patients/${pid}/treatment-plan-items`, A.dentist, { procedureCode: 'RESTO', procedureLabel: 'Fictional composite restoration', toothFdi: 46, surfaces: 'O', phaseNo: 3, estimatedFeeMillimes: 60_000 });
  assert.equal(p36.status, 201); assert.equal(p46.status, 201);
  assert.equal(p36.body.planItem.status, 'PROPOSED');
  assert.equal((await post(`/api/v1/treatment-plan-items/${p36.body.planItem.id}/status`, A.dentist, { status: 'ACCEPTED' })).status, 201);

  // Performs the planned 36 restoration: one action, care item + plan completion.
  const perf = await post(`/api/v1/treatment-plan-items/${p36.body.planItem.id}/perform`, A.dentist, { visitId: vid });
  assert.equal(perf.status, 201, JSON.stringify(perf.body));
  assert.equal(perf.body.careItem.feeMillimes, 80_000);
  assert.deepEqual([perf.body.careItem.toothFdi, perf.body.careItem.surfaces], [36, 'MO']);
  assert.equal(perf.body.planItem.status, 'COMPLETED');
  assert.equal(perf.body.planItem.careItemId, perf.body.careItem.id);
  assert.deepEqual(perf.body.quoteVsCharged, { estimatedFeeMillimes: 80_000, chargedFeeMillimes: 80_000, differenceMillimes: 0 });

  // Checkout (existing billing consumes the dentist-authorised care state).
  const pay = await post(`/api/v1/visits/${vid}/payments`, A.desk, { amountMillimes: 50_000, tender: 'CASH' });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const wb = (await get(`/api/v1/visits/${vid}/workbench`, A.desk)).body.visit;
  assert.equal(wb.status, 'COMPLETED');
  assert.equal(wb.balance.balanceMillimes, 30_000);
  assert.equal(wb.nextAction, 'RECORD_OR_FOLLOW_UP_PAYMENT');

  // Encounter after treatment.
  const after1 = (await get(`/api/v1/visits/${vid}/encounter`, A.dentist)).body;
  assert.equal(after1.care.length, 1);
  assert.equal(after1.notes.length, 1);
  assert.equal(after1.notes[0].integrity, 'OK');
  assert.equal(after1.findings.length, 1);
  assert.deepEqual(after1.planItems.map((p: { toothFdi: number; status: string }) => `${p.toothFdi}:${p.status}`).sort(), ['36:COMPLETED', '46:PROPOSED']);

  // Wrong surface discovered: amend MO -> DO, money untouched.
  const am = await post(`/api/v1/care-items/${perf.body.careItem.id}/site-amendments`, A.dentist, { toothFdi: 36, surfaces: 'DO', reasonCode: 'WRONG_SURFACE', expectedSupersedesId: null });
  assert.equal(am.status, 201, JSON.stringify(am.body));
  assert.equal(am.body.visitTotalMillimes, 80_000);
  assert.equal((await get(`/api/v1/visits/${vid}/workbench`, A.desk)).body.visit.balance.balanceMillimes, 30_000);

  // Longitudinal record.
  const rec = await get(`/api/v1/patients/${pid}/clinical-record`, A.dentist);
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.medical.reviews.length, 1);
  assert.equal(rec.body.medical.allergyStatus, 'NO_KNOWN_ALLERGIES');
  assert.equal(rec.body.timeline.length, 1);
  const t = rec.body.timeline[0];
  assert.equal(t.id, vid);
  assert.deepEqual([t.care[0].effectiveToothFdi, t.care[0].effectiveSurfaces, t.care[0].surfaces], [36, 'OD', 'MO'], 'effective site shown next to the preserved original');
  assert.equal(t.notes.length, 1);
  assert.equal(t.findings.length, 1);
  assert.deepEqual(rec.body.teeth['36'].map((e: { type: string }) => e.type).sort(), ['CARE', 'FINDING']);
  assert.deepEqual(rec.body.teeth['46'].map((e: { type: string }) => e.type), ['PLANNED']);
  assert.equal(rec.body.treatmentPlan.length, 2);
});

test('T-ENC-2 roles: receptionist, non-clinician owner and assistant get 403 on every clinical read/write; other clinic gets 404', async () => {
  const pid = await patient('Roles');
  const vid = await visitFor(pid);
  const pi = await post(`/api/v1/patients/${pid}/treatment-plan-items`, A.dentist, { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', estimatedFeeMillimes: 20_000 });
  const n = await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { subjective: 'Fictional' });
  const f = await post(`/api/v1/visits/${vid}/chart-findings`, A.dentist, { kind: 'EXISTING', toothFdi: 16, conditionCode: 'CROWN' });
  const calls: Array<[string, string, Record<string, unknown>?]> = [
    ['GET', `/api/v1/visits/${vid}/encounter`], ['GET', `/api/v1/patients/${pid}/clinical-record`], ['GET', `/api/v1/patients/${pid}/treatment-plan`],
    ['POST', `/api/v1/visits/${vid}/clinical-notes`, { subjective: 'Fictional forged note' }],
    ['POST', `/api/v1/clinical-notes/${n.body.note.id}/addenda`, { kind: 'ENTERED_IN_ERROR', reason: 'Fictional attack' }],
    ['POST', `/api/v1/visits/${vid}/chart-findings`, { kind: 'FINDING', toothFdi: 36, conditionCode: 'CARIES' }],
    ['POST', `/api/v1/chart-findings/${f.body.finding.id}/entered-in-error`, { reason: 'Fictional attack' }],
    ['POST', `/api/v1/patients/${pid}/treatment-plan-items`, { procedureCode: 'EXAM', procedureLabel: 'Fictional exam' }],
    ['POST', `/api/v1/treatment-plan-items/${pi.body.planItem.id}/status`, { status: 'CANCELLED', reason: 'Fictional attack' }],
    ['POST', `/api/v1/treatment-plan-items/${pi.body.planItem.id}/perform`, { visitId: vid }],
  ];
  for (const [m, path, body] of calls) {
    for (const [who, tok] of [['desk', A.desk], ['owner', A.owner], ['assistant', assistant]] as const) {
      const r = await api.call(m, path, { token: tok, body });
      if (who === 'assistant') assert.ok(r.status === 403, `${who} ${m} ${path} -> ${r.status}`);
      else assert.equal(r.status, 403, `${who} ${m} ${path}`);
    }
    const foreign = await api.call(m, path, { token: B.dentist, body });
    assert.equal(foreign.status, 404, `other clinic ${m} ${path} -> ${foreign.status}`);
  }
  const cnt = await appSql(A.clinic.id, async c => ({
    notes: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM clinical_notes WHERE patient_id = $1', [pid])).rows[0]!.n,
    findings: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM chart_findings WHERE patient_id = $1', [pid])).rows[0]!.n,
    events: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM plan_item_events WHERE patient_id = $1', [pid])).rows[0]!.n,
    care: (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM care_items WHERE patient_id = $1', [pid])).rows[0]!.n,
  }));
  assert.deepEqual(cnt, { notes: 1, findings: 1, events: 0, care: 0 }, 'no denied or foreign request wrote anything');
});

test('T-NOTE-1 notes are immutable: addendum, single strike with reason, late entry rules, hash in audit not text, tamper detected on read', async () => {
  const pid = await patient('Notes');
  const vid = await visitFor(pid);
  const n = await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { assessment: 'Fictional private assessment text' });
  const id = n.body.note.id as string;
  const ad = await post(`/api/v1/clinical-notes/${id}/addenda`, A.dentist, { kind: 'ADDENDUM', plan: 'Fictional: review in 2 weeks' });
  assert.equal(ad.status, 201);
  assert.equal((await post(`/api/v1/clinical-notes/${id}/addenda`, A.dentist, { kind: 'ENTERED_IN_ERROR' })).status, 400, 'strike needs a reason');
  assert.equal((await post(`/api/v1/clinical-notes/${id}/addenda`, A.dentist, { kind: 'ENTERED_IN_ERROR', reason: 'Fictional: wrong patient', plan: 'x' })).status, 400, 'strike carries no new text');
  const strike = await post(`/api/v1/clinical-notes/${id}/addenda`, A.dentist, { kind: 'ENTERED_IN_ERROR', reason: 'Fictional: wrong patient' });
  assert.equal(strike.status, 201);
  assert.equal((await post(`/api/v1/clinical-notes/${id}/addenda`, A.dentist, { kind: 'ENTERED_IN_ERROR', reason: 'Fictional: again' })).status, 409);
  assert.equal((await post(`/api/v1/clinical-notes/${id}/addenda`, A.dentist, { kind: 'ADDENDUM', plan: 'Fictional late add' })).status, 409);
  assert.equal((await post(`/api/v1/clinical-notes/${strike.body.note.id}/addenda`, A.dentist, { kind: 'ADDENDUM', plan: 'x' })).status, 404, 'a strike row is not a note');
  const enc = (await get(`/api/v1/visits/${vid}/encounter`, A.dentist)).body;
  const shown = enc.notes.find((x: { id: string }) => x.id === id);
  assert.equal(shown.assessment, 'Fictional private assessment text', 'struck note stays readable');
  assert.equal(shown.enteredInError.reason, 'Fictional: wrong patient');
  assert.deepEqual(shown.addendumIds, [ad.body.note.id]);
  // Late entry
  assert.equal((await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { kind: 'LATE_ENTRY', subjective: 'x', effectiveAt: '2026-10-01T09:00:00Z' })).status, 400, 'late entry needs a reason');
  assert.equal((await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { kind: 'LATE_ENTRY', subjective: 'x', reason: 'Fictional: forgot', effectiveAt: '2099-01-01T09:00:00Z' })).status, 400, 'late entry must be in the past');
  assert.equal((await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { subjective: 'x', effectiveAt: '2026-10-01T09:00:00Z' })).status, 400, 'a normal note cannot be back-dated');
  const late = await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { kind: 'LATE_ENTRY', objective: 'Fictional late obs', reason: 'Fictional: power cut', effectiveAt: '2026-10-01T09:00:00Z' });
  assert.equal(late.status, 201, JSON.stringify(late.body));
  assert.equal((await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, {})).status, 400, 'empty note rejected');
  // Audit holds the hash, never the text.
  const ev = await appSql(A.clinic.id, c => c.query<{ canonical: string; payload: { contentSha256: string } }>("SELECT canonical, payload FROM audit_events WHERE entity_id = $1 AND action = 'clinical.note_signed'", [id]));
  assert.equal(ev.rows[0]!.payload.contentSha256, n.body.note.contentSha256);
  assert.ok(!ev.rows[0]!.canonical.includes('Fictional private'), 'note text never enters the audit chain');
  // App role cannot edit; a superuser edit around the app is detected on read.
  await assert.rejects(appSql(A.clinic.id, c => c.query("UPDATE clinical_notes SET assessment = 'changed' WHERE id = $1", [id])), /permission denied|append-only/);
  const su = new PgConnection(parseDatabaseUrl(db.ownerUrl.replace(/ezz_owner:[^@]+@/, `${new URL(process.env.EZZ_TEST_ADMIN_URL ?? 'postgres://postgres@localhost').username}:${new URL(process.env.EZZ_TEST_ADMIN_URL ?? 'postgres://postgres@localhost').password}@`)));
  await su.connect();
  try {
    await su.query('BEGIN');
    await su.query('SET LOCAL session_replication_role = replica'); // superuser bypass of the append-only trigger
    await su.query("UPDATE clinical_notes SET assessment = 'Fictional tampered text' WHERE id = $1", [id]);
    await su.query('COMMIT');
  } finally { su.end(); }
  const tampered = (await get(`/api/v1/visits/${vid}/encounter`, A.dentist)).body.notes.find((x: { id: string }) => x.id === id);
  assert.equal(tampered.integrity, 'CONTENT_HASH_MISMATCH');
});

test('T-NOTE-2 duplicate submission: the same Idempotency-Key stores one note; cancelled visit refuses notes', async () => {
  const pid = await patient('Dupes');
  const vid = await visitFor(pid);
  const k = key();
  const one = await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { subjective: 'Fictional once' }, k);
  const two = await post(`/api/v1/visits/${vid}/clinical-notes`, A.dentist, { subjective: 'Fictional once' }, k);
  assert.equal(one.status, 201); assert.equal(two.body.replayed, true);
  assert.equal(two.body.note.id, one.body.note.id);
  const n = await appSql(A.clinic.id, c => c.query<{ n: number }>('SELECT count(*)::int AS n FROM clinical_notes WHERE visit_id = $1', [vid]));
  assert.equal(n.rows[0]!.n, 1);
  const cv = await visitFor(pid);
  assert.equal((await post(`/api/v1/visits/${cv}/status`, A.desk, { status: 'CANCELLED', reason: 'Fictional cancel' })).status, 200);
  assert.equal((await post(`/api/v1/visits/${cv}/clinical-notes`, A.dentist, { subjective: 'x' })).status, 409);
});

test('T-PLAN-1 plan status machine and concurrent perform on two visits: exactly one care item, no orphan charge', async () => {
  const pid = await patient('Plan');
  const mk = async (est: number | null = 40_000) => (await post(`/api/v1/patients/${pid}/treatment-plan-items`, A.dentist, { procedureCode: 'SCALE', procedureLabel: 'Fictional scaling', estimatedFeeMillimes: est })).body.planItem.id as string;
  const a = await mk();
  assert.equal((await post(`/api/v1/treatment-plan-items/${a}/status`, A.dentist, { status: 'DECLINED' })).status, 400, 'decline needs a reason');
  assert.equal((await post(`/api/v1/treatment-plan-items/${a}/status`, A.dentist, { status: 'DECLINED', reason: 'Fictional: patient prefers later' })).status, 201);
  const reopen = await post(`/api/v1/treatment-plan-items/${a}/status`, A.dentist, { status: 'ACCEPTED' });
  assert.equal(reopen.status, 409); assert.equal(reopen.body.error.code, 'PLAN_ITEM_CLOSED');
  const v0 = await visitFor(pid);
  assert.equal((await post(`/api/v1/treatment-plan-items/${a}/perform`, A.dentist, { visitId: v0 })).status, 409, 'declined item cannot be performed');

  const c = await mk();
  const [v1, v2] = [await visitFor(pid), await visitFor(pid)];
  const rs = await Promise.all([v1, v2].map(v => post(`/api/v1/treatment-plan-items/${c}/perform`, A.dentist, { visitId: v })));
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 409], JSON.stringify(rs.map(r => r.body)));
  const care = await appSql(A.clinic.id, q => q.query<{ visit_id: string }>("SELECT visit_id FROM care_items WHERE patient_id = $1 AND procedure_code = 'SCALE'", [pid]));
  assert.equal(care.rows.length, 1, 'the losing perform rolled back its care item');
  const plan = (await get(`/api/v1/patients/${pid}/treatment-plan`, A.dentist)).body.items.find((i: { id: string }) => i.id === c);
  assert.equal(plan.status, 'COMPLETED');
  assert.equal(plan.events.length, 1);
});

test('T-PLAN-2 perform rules: other patient visit, fee override vs quote, missing estimate, alert gate keeps the plan open', async () => {
  const pid = await patient('PlanRules');
  const other = await patient('Other');
  const item = (await post(`/api/v1/patients/${pid}/treatment-plan-items`, A.dentist, { procedureCode: 'EXTRACT', procedureLabel: 'Fictional extraction', toothFdi: 48, estimatedFeeMillimes: 70_000 })).body.planItem.id;
  const ov = await visitFor(other);
  assert.equal((await post(`/api/v1/treatment-plan-items/${item}/perform`, A.dentist, { visitId: ov })).status, 400);
  const v = await visitFor(pid);
  await post(`/api/v1/patients/${pid}/medical-alerts`, A.desk, { code: 'ANTIPLATELET', severity: 'CAUTION' });
  const gated = await post(`/api/v1/treatment-plan-items/${item}/perform`, A.dentist, { visitId: v, feeMillimes: 90_000 });
  assert.equal(gated.status, 409); assert.equal(gated.body.error.code, 'MEDICAL_ALERTS_NOT_ACKNOWLEDGED');
  assert.equal((await get(`/api/v1/patients/${pid}/treatment-plan`, A.dentist)).body.items[0].status, 'PROPOSED', 'gate failure leaves the plan open');
  const orphan = await appSql(A.clinic.id, c => c.query<{ n: number }>('SELECT count(*)::int AS n FROM care_items WHERE visit_id = $1', [v]));
  assert.equal(orphan.rows[0]!.n, 0, 'gate failure leaves no care item (single transaction, M-262 partial-failure question)');
  const hash = (await get(`/api/v1/visits/${v}/encounter`, A.dentist)).body.medical.alertSetHash;
  const ok = await post(`/api/v1/treatment-plan-items/${item}/perform`, A.dentist, { visitId: v, feeMillimes: 90_000, alertSetHash: hash });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.quoteVsCharged, { estimatedFeeMillimes: 70_000, chargedFeeMillimes: 90_000, differenceMillimes: 20_000 });
  // M-262: a second, sequential perform of a COMPLETED item is refused and charges nothing.
  const v2 = await visitFor(pid);
  const again = await post(`/api/v1/treatment-plan-items/${item}/perform`, A.dentist, { visitId: v2, alertSetHash: hash });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'PLAN_ITEM_CLOSED');
  assert.equal(again.body.error.details.careItemId, ok.body.careItem.id);
  const second = await appSql(A.clinic.id, c => c.query<{ n: number }>('SELECT count(*)::int AS n FROM care_items WHERE visit_id = $1', [v2]));
  assert.equal(second.rows[0]!.n, 0);
  const noEst = (await post(`/api/v1/patients/${pid}/treatment-plan-items`, A.dentist, { procedureCode: 'EXAM', procedureLabel: 'Fictional exam' })).body.planItem.id;
  assert.equal((await post(`/api/v1/treatment-plan-items/${noEst}/perform`, A.dentist, { visitId: v })).status, 400);
  assert.equal((await post(`/api/v1/treatment-plan-items/${noEst}/perform`, A.desk, { visitId: v, feeMillimes: 1 })).status, 403);
});

test('T-FIND-1 chart findings: exactly one site, provisional rules enforced, strike once, struck excluded from the tooth view', async () => {
  const pid = await patient('Findings');
  const vid = await visitFor(pid);
  const f = (b: Record<string, unknown>) => post(`/api/v1/visits/${vid}/chart-findings`, A.dentist, { kind: 'FINDING', conditionCode: 'CARIES', ...b });
  assert.equal((await f({ toothFdi: 36, areaCode: 30 })).status, 400);
  assert.equal((await f({})).status, 400);
  assert.equal((await f({ areaCode: 25 })).status, 400);
  assert.equal((await f({ toothFdi: 36, surfaces: 'IF' })).status, 400);
  assert.equal((await f({ toothFdi: 36, conditionCode: 'bad code' })).status, 400);
  assert.equal((await f({ areaCode: 30, conditionCode: 'GINGIVITIS' })).status, 201);
  const ok = await f({ toothFdi: 26 });
  assert.equal(ok.status, 201);
  const s = await post(`/api/v1/chart-findings/${ok.body.finding.id}/entered-in-error`, A.dentist, { reason: 'Fictional: wrong tooth' });
  assert.equal(s.status, 201);
  assert.equal((await post(`/api/v1/chart-findings/${ok.body.finding.id}/entered-in-error`, A.dentist, { reason: 'Fictional: again' })).status, 409);
  const rec = (await get(`/api/v1/patients/${pid}/clinical-record`, A.dentist)).body;
  assert.equal(rec.teeth['26'], undefined, 'struck finding is not on the tooth view');
  const shown = rec.timeline[0].findings.find((x: { id: string }) => x.id === ok.body.finding.id);
  assert.equal(shown.enteredInError.reason, 'Fictional: wrong tooth', 'but stays visible in history');
});

test('T-ENC-3 audit chain and integrity check stay green after a full clinical day', async () => {
  await reauth(api, A.owner);
  const v = await api.call('POST', '/api/v1/audit/verify', { token: A.owner, body: {}, idem: false });
  assert.equal(v.body.ok, true, JSON.stringify(v.body.findings));
  const integ = await api.call('POST', '/api/v1/integrity/check', { token: A.owner, body: {}, idem: false });
  assert.equal(integ.body.ok, true, JSON.stringify(integ.body.findings));
});

test('T-ENC-4 (CH-018) the desk cannot mark a visit NO_SHOW/CANCELLED once the dentist documented it (note or finding)', async () => {
  const pid = await patient('Documented');
  const withNote = await visitFor(pid);
  await post(`/api/v1/visits/${withNote}/status`, A.desk, { status: 'ARRIVED' });
  assert.equal((await post(`/api/v1/visits/${withNote}/clinical-notes`, A.dentist, { objective: 'Fictional exam done' })).status, 201);
  const c1 = await post(`/api/v1/visits/${withNote}/status`, A.desk, { status: 'CANCELLED', reason: 'Fictional: patient left' });
  assert.equal(c1.status, 409, JSON.stringify(c1.body));
  const withFinding = await visitFor(pid);
  assert.equal((await post(`/api/v1/visits/${withFinding}/chart-findings`, A.dentist, { kind: 'FINDING', toothFdi: 11, conditionCode: 'FRACTURE' })).status, 201);
  const c2 = await post(`/api/v1/visits/${withFinding}/status`, A.desk, { status: 'NO_SHOW', reason: 'Fictional: never came' });
  assert.equal(c2.status, 409, JSON.stringify(c2.body));
  const plain = await visitFor(pid);
  assert.equal((await post(`/api/v1/visits/${plain}/status`, A.desk, { status: 'NO_SHOW', reason: 'Fictional: never came' })).status, 200);
});
