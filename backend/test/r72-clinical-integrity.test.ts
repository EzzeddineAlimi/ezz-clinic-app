/*
 * R72 / M-264 (5) / M-265 residual — B06 value checks extended to the B07 clinical tables after integration.
 * Same threat model as CH-026/CH-027: a privileged database actor bypasses the append-only triggers and edits a
 * clinical row while the audit chain stays intact. Before this change POST /integrity/check stayed green for every
 * such edit. A finding is a data-consistency signal, never an accusation. Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, reauth, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
/** One fictional clinical visit touching every clinical table. */
async function clinicalDay() {
  const f = await standardFixture(api, db, `r72-cint-${++n}`, { openCashPeriod: false });
  const post = async (path: string, token: string, body: Record<string, unknown>) => {
    const r = await api.call('POST', path, { token, body });
    assert.ok(r.status === 201 || r.status === 200, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const pid = f.patientId, vid = f.visitId;
  const declared = await post(`/api/v1/patients/${pid}/medical-alerts`, f.desk, { code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL' });
  const alertId = declared.alert?.id ?? declared.alertId;
  const ver = await post(`/api/v1/medical-alerts/${alertId}/revisions`, f.dentist, { action: 'VERIFY', expectedRevision: 1 });
  const review = await post(`/api/v1/patients/${pid}/medical-history-reviews`, f.dentist, { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: ver.alertSetHash, visitId: vid });
  const ack = await post(`/api/v1/visits/${vid}/alert-acknowledgements`, f.dentist, { alertSetHash: review.alertSetHash });
  const finding = await post(`/api/v1/visits/${vid}/chart-findings`, f.dentist, { kind: 'FINDING', toothFdi: 36, surfaces: 'MO', conditionCode: 'CARIES', note: 'Fictional finding' });
  const finding2 = await post(`/api/v1/visits/${vid}/chart-findings`, f.dentist, { kind: 'FINDING', toothFdi: 11, conditionCode: 'FRACTURE' });
  await post(`/api/v1/chart-findings/${finding2.finding.id}/entered-in-error`, f.dentist, { reason: 'Fictional: wrong tooth' });
  const note = await post(`/api/v1/visits/${vid}/clinical-notes`, f.dentist, { subjective: 'Fictional: pain', objective: 'Fictional: cavity 36', plan: 'Fictional: restoration' });
  await post(`/api/v1/clinical-notes/${note.note.id}/addenda`, f.dentist, { kind: 'ADDENDUM', plan: 'Fictional: review in 2 weeks' });
  const plan = await post(`/api/v1/patients/${pid}/treatment-plan-items`, f.dentist, { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'MO', phaseNo: 2, estimatedFeeMillimes: 80_000, visitId: vid });
  await post(`/api/v1/treatment-plan-items/${plan.planItem.id}/status`, f.dentist, { status: 'ACCEPTED' });
  const perf = await post(`/api/v1/treatment-plan-items/${plan.planItem.id}/perform`, f.dentist, { visitId: vid, alertSetHash: review.alertSetHash });
  const amend = await post(`/api/v1/care-items/${perf.careItem.id}/site-amendments`, f.dentist, { toothFdi: 36, surfaces: 'DO', reasonCode: 'WRONG_SURFACE', expectedSupersedesId: null });
  return { ...f, alertId, ackId: ack.acknowledgement.id as string, findingId: finding.finding.id as string, noteId: note.note.id as string,
    planItemId: plan.planItem.id as string, careItemId: perf.careItem.id as string, amendmentId: (amend.amendment?.id ?? amend.siteAmendment?.id) as string, reviewId: review.review?.id as string };
}

async function tamper(sql: string, params: unknown[] = []) {
  const a = await adminConn(db.name);
  try { await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica'); await a.query(sql, params as never[]); await a.query('COMMIT'); } finally { a.end(); }
}
async function check(owner: string) {
  await reauth(api, owner);
  const r = await api.call('POST', '/api/v1/integrity/check', { token: owner, body: {}, idem: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { ok: boolean; findings: Array<{ check: string; detail: string; refs?: Record<string, unknown> }> };
}
const has = (r: { findings: Array<{ check: string; refs?: Record<string, unknown> }> }, check: string, table: string, field?: string) =>
  r.findings.some(f => f.check === check && f.refs?.table === table && (field === undefined || f.refs?.field === field));

test('T-CINT-0 a full fictional clinical visit produces no false alarm (every clinical table populated)', async () => {
  const s = await clinicalDay();
  const r = await check(s.owner);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test('T-CINT-1 (RED before fix) note text edited without touching its hash -> CLINICAL_NOTE_CONTENT_HASH_MISMATCH', async () => {
  const s = await clinicalDay();
  await tamper("UPDATE clinical_notes SET objective = 'Fictional: no cavity' WHERE id = $1", [s.noteId]);
  const r = await check(s.owner);
  assert.ok(has(r, 'CLINICAL_NOTE_CONTENT_HASH_MISMATCH', 'clinical_notes'), JSON.stringify(r.findings));
});

test('T-CINT-2 (RED before fix) note text AND hash rewritten consistently -> mismatch with the hash captured in the audit event', async () => {
  const s = await clinicalDay();
  await tamper("UPDATE clinical_notes SET objective = 'Fictional: rewritten', content_sha256 = repeat('a', 64) WHERE id = $1", [s.noteId]);
  const r = await check(s.owner);
  assert.ok(has(r, 'CLINICAL_AUDIT_VALUE_MISMATCH', 'clinical_notes', 'contentSha256'), JSON.stringify(r.findings));
});

test('T-CINT-3 (RED before fix) finding, plan estimate, plan event, alert severity, review, acknowledgement and site amendment edits are each detected', async () => {
  const cases: Array<[string, string, string, (s: Awaited<ReturnType<typeof clinicalDay>>) => [string, unknown[]]]> = [
    ['chart_findings', 'toothFdi', 'finding tooth 36 -> 46', s => ['UPDATE chart_findings SET tooth_fdi = 46 WHERE id = $1', [s.findingId]]],
    ['treatment_plan_items', 'estimatedFeeMillimes', 'estimate 80,000 -> 8,000', s => ['UPDATE treatment_plan_items SET estimated_fee_millimes = 8000 WHERE id = $1', [s.planItemId]]],
    ['plan_item_events', 'status', 'COMPLETED event relabelled DECLINED', s => ["UPDATE plan_item_events SET status = 'DECLINED', care_item_id = NULL, reason = 'Fictional tamper' WHERE plan_item_id = $1 AND status = 'COMPLETED'", [s.planItemId]]],
    ['medical_alerts', 'severity', 'critical anticoagulant alert downgraded', s => ["UPDATE medical_alerts SET severity = 'CAUTION' WHERE chain_id = (SELECT chain_id FROM medical_alerts WHERE id = $1)", [s.alertId]]],
    ['medical_history_reviews', 'noKnownAllergies', 'allergy assertion flipped', s => ['UPDATE medical_history_reviews SET no_known_allergies = NOT no_known_allergies WHERE patient_id = $1', [s.patientId]]],
    ['alert_acknowledgements', 'alertSetHash', 'acknowledged alert set replaced', s => ["UPDATE alert_acknowledgements SET alert_set_sha256 = repeat('b', 64) WHERE id = $1", [s.ackId]]],
    ['care_site_amendments', 'toothFdi', 'amended tooth 36 -> 37', s => ['UPDATE care_site_amendments SET tooth_fdi = 37 WHERE care_item_id = $1', [s.careItemId]]],
  ];
  for (const [table, field, label, sql] of cases) {
    const s = await clinicalDay();
    assert.equal((await check(s.owner)).ok, true, `${label}: clean before tampering`);
    await tamper(...sql(s));
    const r = await check(s.owner);
    assert.ok(has(r, 'CLINICAL_AUDIT_VALUE_MISMATCH', table, field), `${label}: ${JSON.stringify(r.findings)}`);
    assert.match(r.findings.find(f => f.refs?.table === table)!.detail, /does not by itself show who/);
  }
});

test('T-CINT-4 (RED before fix) a deleted finding and a finding inserted around the application are both reported', async () => {
  const s = await clinicalDay();
  await tamper('DELETE FROM chart_findings WHERE id = $1', [s.findingId]);
  await tamper(`INSERT INTO chart_findings (clinic_id, patient_id, visit_id, kind, tooth_fdi, condition_code, recorded_by, recorded_role)
      SELECT clinic_id, patient_id, visit_id, 'FINDING', 21, 'CARIES', recorded_by, 'DENTIST' FROM chart_findings WHERE visit_id = $1 LIMIT 1`, [s.visitId]);
  const r = await check(s.owner);
  assert.ok(r.findings.some(f => f.check === 'AUDITED_ROW_MISSING' && f.refs?.table === 'chart_findings'), JSON.stringify(r.findings));
  assert.ok(r.findings.some(f => f.check === 'ROW_WITHOUT_AUDIT_EVENT' && /chart_findings/.test(f.detail)), JSON.stringify(r.findings));
});
