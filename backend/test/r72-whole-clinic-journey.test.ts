/*
 * R72 MISSION 3 — one integrated fictional dental clinic from registration to end-of-day close, a second clinic for
 * isolation, and an encrypted backup restored into a new database. Every step goes through the HTTP API of the
 * INTEGRATED build (all PRs combined). Fictional data only; no payment provider, no patient contact, no real clinic.
 * The test prints an evidence log (JOURNEY lines) of what actually happened, including the cash discrepancy found.
 * Visits are dated YESTERDAY (clinic-local) so the run is independent of the time of day.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, startApi, seedClinic, STANDARD_STAFF, reauth, adminConn, urlFor, type Api, type TestDb } from './helpers.ts';
import { createBackup, restoreAndVerify } from '../src/ops/disaster-recovery.ts';
import { MIGRATIONS_DIR } from '../src/platform/paths.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

const log: Array<Record<string, unknown>> = [];
const step = (name: string, data: Record<string, unknown> = {}) => { log.push({ step: name, ...data }); console.log('JOURNEY ' + JSON.stringify({ step: name, ...data })); };
const TZ = 'Africa/Tunis';
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const DAY = localDate(new Date(Date.now() - 86400_000)); // yesterday, clinic-local
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+01:00`).toISOString(); // Africa/Tunis is UTC+1 (no DST)

test('T-JOURNEY-1 whole fictional clinic day on the integrated build: desk, dentist, owner; second clinic isolated; backup restored', async () => {
  // ---------------------------------------------------------------- setup: two fictional clinics
  const A = await seedClinic(db, 'r72-clinic-a', [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }]);
  await seedClinic(db, 'r72-clinic-b', STANDARD_STAFF);
  const owner = await api.login('r72-clinic-a', 'owner'), dentist = await api.login('r72-clinic-a', 'dentist');
  const desk = await api.login('r72-clinic-a', 'desk'), assistant = await api.login('r72-clinic-a', 'assistant');
  const call = async (method: 'GET' | 'POST', path: string, token: string, body?: Record<string, unknown>, expect?: number) => {
    const r = await api.call(method, path, method === 'POST' ? { token, body: body ?? {} } : { token });
    if (expect !== undefined) assert.equal(r.status, expect, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };
  const deskSeen: unknown[] = []; const assistantSeen: unknown[] = []; // privacy sweep material
  await reauth(api, owner);
  const period = (await call('POST', '/api/v1/cash/periods', owner, { openingFloatMillimes: 20_000 }, 201)).body.period ?? (await call('GET', '/api/v1/cash/periods/current', owner, undefined, 200)).body.period;
  const periodId = period.id as string;
  step('clinic opened', { clinics: 2, day: DAY, openingFloatMillimes: 20_000 });

  // ---------------------------------------------------------------- registration (desk)
  const patient = async (body: Record<string, unknown>) => (await call('POST', '/api/v1/patients', desk, { isSynthetic: true, ...body }, 201)).body.patient as { id: string; fileNo: number };
  const elder = await patient({ familyName: 'Jebali', givenName: 'Mabrouka', nameAr: 'مبروكة الجبالي', preferredLanguage: 'ar', contactPreference: 'IN_PERSON', dateOfBirth: '1944-02-01' });
  const dup = await call('POST', '/api/v1/patients', desk, { isSynthetic: true, familyName: 'Jebali', givenName: 'Mabrouka', phone: '+216 20 111 222', contactPreference: 'BASIC_PHONE_CALL' });
  assert.equal(dup.status, 409, 'same-name warning for the no-phone elderly patient');
  await patient({ familyName: 'Jebali', givenName: 'Mabrouka', phone: '+216 20 111 222', contactPreference: 'BASIC_PHONE_CALL', confirmNotDuplicate: true });
  const p2 = await patient({ familyName: 'Trabelsi', givenName: 'Sami', phone: '+216 22 333 444', contactPreference: 'SMS' });
  const p3 = await patient({ familyName: 'Ayari', givenName: 'Nour' });
  const p4 = await patient({ familyName: 'Gharbi', givenName: 'Hedi' });
  const p5 = await patient({ familyName: 'Mansour', givenName: 'Lina' });
  const p6 = await patient({ familyName: 'Saidi', givenName: 'Karim' });
  step('patients registered', { count: 7, duplicateWarning: dup.body.error.code, elderlyNoPhone: elder.fileNo });

  // ---------------------------------------------------------------- appointments + day-board
  const visit = async (patientId: string, hhmm: string) => (await call('POST', '/api/v1/visits', desk, { patientId, scheduledAt: at(hhmm), dentistId: A.staff.dentist }, 201)).body.visit.id as string;
  const v1 = await visit(elder.id, '08:30'), v2 = await visit(p2.id, '09:00'), v3 = await visit(p3.id, '09:30');
  const v4 = await visit(p4.id, '10:00'), v5 = await visit(p5.id, '10:30'), v6 = await visit(p6.id, '11:00');
  const board = await call('GET', `/api/v1/day-board?day=${DAY}`, desk, undefined, 200);
  deskSeen.push(board.body);
  assert.equal(board.body.timezone, TZ);
  assert.equal(board.body.summary.total, 6);
  const e1 = board.body.visits.find((v: { id: string }) => v.id === v1);
  assert.equal(e1.localTime, '08:30');
  assert.ok(e1.flags.includes('IN_PERSON_CONTACT_ONLY') && e1.flags.includes('SAME_NAME_OTHER_FILE'));
  assert.ok(!JSON.stringify(board.body).includes('20 111 222'), 'no phone numbers on the board');
  step('day-board', { visits: board.body.summary.total, flagsOnElder: e1.flags, timezone: board.body.timezone });

  // ---------------------------------------------------------------- medical alert: desk declares, sees presence only
  await call('POST', `/api/v1/patients/${elder.id}/medical-alerts`, desk, { code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL', detail: 'Fictional: takes warfarin' }, 201);
  const presence = await call('GET', `/api/v1/patients/${elder.id}/medical-alerts/summary`, desk, undefined, 200);
  deskSeen.push(presence.body);
  assert.equal(presence.body.criticalAlertCount, 1);
  await call('GET', `/api/v1/patients/${elder.id}/medical-alerts`, desk, undefined, 403);
  step('medical alert declared by desk', { deskSeesPresenceOnly: true, criticalAlertCount: 1 });

  // ---------------------------------------------------------------- arrival + dentist encounter
  for (const v of [v1, v2, v3, v6]) { await call('POST', `/api/v1/visits/${v}/status`, desk, { status: 'ARRIVED' }, 200); await call('POST', `/api/v1/visits/${v}/status`, desk, { status: 'IN_CHAIR' }, 200); }
  const enc = await call('GET', `/api/v1/visits/${v1}/encounter`, dentist, undefined, 200);
  const alertId = enc.body.medical.activeAlerts[0].id;
  const ver = await call('POST', `/api/v1/medical-alerts/${alertId}/revisions`, dentist, { action: 'VERIFY', expectedRevision: 1 }, 201);
  const review = await call('POST', `/api/v1/patients/${elder.id}/medical-history-reviews`, dentist, { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: ver.body.alertSetHash, visitId: v1 }, 201);
  await call('POST', `/api/v1/visits/${v1}/chart-findings`, dentist, { kind: 'FINDING', toothFdi: 36, surfaces: 'MO', conditionCode: 'CARIES', note: 'Fictional finding note' }, 201);
  await call('POST', `/api/v1/visits/${v1}/clinical-notes`, dentist, { subjective: 'Fictional: pain left', objective: 'Fictional: cavity 36', plan: 'Fictional: composite today' }, 201);
  const plan = await call('POST', `/api/v1/patients/${elder.id}/treatment-plan-items`, dentist, { procedureCode: 'RESTO', procedureLabel: 'Fictional composite', toothFdi: 36, surfaces: 'MO', estimatedFeeMillimes: 80_000, visitId: v1 }, 201);
  await call('POST', `/api/v1/treatment-plan-items/${plan.body.planItem.id}/status`, dentist, { status: 'ACCEPTED' }, 201);
  const perf = await call('POST', `/api/v1/treatment-plan-items/${plan.body.planItem.id}/perform`, dentist, { visitId: v1, alertSetHash: review.body.alertSetHash }, 201);
  const care2 = (await call('POST', `/api/v1/visits/${v2}/care`, dentist, { procedureCode: 'SCALE', procedureLabel: 'Fictional scaling', feeMillimes: 50_000 }, 201)).body.careItem.id as string;
  await call('POST', `/api/v1/visits/${v3}/care`, dentist, { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', feeMillimes: 30_000 }, 201);
  await call('POST', `/api/v1/visits/${v6}/care`, dentist, { procedureCode: 'XRAY', procedureLabel: 'Fictional x-ray', feeMillimes: 40_000 }, 201);
  step('dentist encounter', { alertVerified: true, historyReviewed: true, finding: 1, signedNote: 1, planPerformedFeeMillimes: perf.body.careItem.feeMillimes, otherCare: 3 });

  // Role boundaries with the DEFAULT matrix.
  await call('POST', `/api/v1/visits/${v1}/clinical-notes`, desk, { objective: 'x' }, 403);
  await call('POST', `/api/v1/visits/${v1}/clinical-notes`, assistant, { objective: 'x' }, 403);
  await call('GET', `/api/v1/visits/${v1}/encounter`, owner, undefined, 403);
  const aBoard = await call('GET', `/api/v1/day-board?day=${DAY}`, assistant, undefined, 200);
  assistantSeen.push(aBoard.body);
  assert.ok(!JSON.stringify(aBoard.body).includes('balanceDueMillimes'));
  step('role boundaries', { deskClinicalWrite: 403, assistantClinicalWrite: 403, ownerClinicalRead: 403, assistantBoardHasMoney: false });

  // ---------------------------------------------------------------- checkout: cash, card, discount, correction+refund, void
  const pay = async (v: string, amountMillimes: number, tender: 'CASH' | 'CARD', extra: Record<string, unknown> = {}) => (await call('POST', `/api/v1/visits/${v}/payments`, desk, { amountMillimes, tender, ...extra }, 201)).body;
  const pay1 = await pay(v1, 50_000, 'CASH');
  await call('POST', `/api/v1/visits/${v1}/adjustments`, dentist, { kind: 'DISCOUNT', amountMillimes: 10_000, reasonCode: 'LOYALTY' }, 201);
  const pay2 = await pay(v2, 50_000, 'CARD', { cardLast4: '4242' });
  await call('POST', `/api/v1/care-items/${care2}/corrections`, dentist, { deltaMillimes: -10_000, reason: 'Fictional: shorter session' }, 201);
  await reauth(api, owner);
  const refund = await call('POST', `/api/v1/payments/${pay2.payment.id}/refund`, owner, { amountMillimes: 10_000, reasonCode: 'FEE_CORRECTED' }, 201);
  const pay3 = await pay(v3, 30_000, 'CASH');
  const voided = await call('POST', `/api/v1/payments/${pay3.payment.id}/void`, owner, { reasonCode: 'ENTERED_IN_ERROR' }, 201);
  const labels = [pay1.receipt.label, pay2.receipt.label, refund.body.receipt.label, pay3.receipt.label, voided.body.receipt.label];
  assert.deepEqual(labels, ['R-000001', 'R-000002', 'R-000003', 'R-000004', 'R-000005'], 'gap-free receipt numbering across payment, refund and void');
  step('checkout', { receipts: labels, cashMillimes: 80_000, cardClaimMillimes: 50_000, discountMillimes: 10_000, refundMillimes: 10_000, voidedMillimes: 30_000 });

  // ---------------------------------------------------------------- printable FR/AR receipt
  const print1 = await call('POST', `/api/v1/receipts/${pay1.receipt.id}/print`, desk, { lang: 'both', size: 'large', format: 'html' }, 200);
  const print2 = await call('POST', `/api/v1/receipts/${pay1.receipt.id}/print`, desk, { lang: 'ar' }, 200);
  deskSeen.push(print1.body, print2.body);
  assert.equal(print1.body.document.sections[0].mark, 'ORIGINAL');
  assert.equal(print2.body.document.sections[0].mark, 'نسخة 1');
  assert.ok(print1.body.html.includes('<bdi dir="ltr">R-000001</bdi>'));
  step('receipt printed', { original: 'R-000001', copy: 1, langs: ['fr', 'ar'], largePrintPt: print1.body.document.fontPt });

  // ---------------------------------------------------------------- no-show and cancellation
  await call('POST', `/api/v1/visits/${v4}/status`, desk, { status: 'NO_SHOW', reason: 'Fictional: did not come' }, 200);
  await call('POST', `/api/v1/visits/${v5}/status`, desk, { status: 'CANCELLED', reason: 'Fictional: patient phoned' }, 200);
  const hide = await call('POST', `/api/v1/visits/${v1}/status`, desk, { status: 'CANCELLED', reason: 'Fictional: hide visit' }, 409);
  step('missed visits', { noShow: 1, cancelled: 1, cancelTreatedVisitRefused: hide.body.error.message });

  // ---------------------------------------------------------------- paper outage (v6) and replay
  await reauth(api, owner);
  const book = await call('POST', '/api/v1/paper-books', owner, { firstNo: 201, lastNo: 205, custodianStaffId: A.staff.dentist }, 201);
  const bookId = book.body.book.id as string;
  const slips = await call('POST', `/api/v1/paper-books/${bookId}/print`, owner, { lang: 'both' }, 200);
  assert.equal(slips.body.slips.length, 5);
  const wrong = await call('POST', `/api/v1/paper-books/${bookId}/entries`, desk, { slips: [{ slipNo: 201, kind: 'USED', amountMillimes: 40_000, tender: 'CASH', visitId: v6, writtenOn: DAY, patientFileNo: p2.fileNo }] }, 200);
  assert.equal(wrong.body.results[0].code, 'PAPER_SLIP_PATIENT_MISMATCH');
  const entry = { slipNo: 201, kind: 'USED', amountMillimes: 40_000, tender: 'CASH', visitId: v6, writtenOn: DAY, patientFileNo: p6.fileNo };
  const posted = await call('POST', `/api/v1/paper-books/${bookId}/entries`, desk, { slips: [entry, { slipNo: 202, kind: 'VOID', note: 'Fictional spoiled slip' }] }, 200);
  assert.deepEqual(posted.body.summary, { posted: 1, flagged: 0, rejected: 0 });
  const replay = await call('POST', `/api/v1/paper-books/${bookId}/entries`, desk, { slips: [entry] }, 200);
  assert.equal(replay.body.results[0].outcome, 'DUPLICATE_ENTRY');
  await call('POST', `/api/v1/paper-books/${bookId}/declare-unused`, dentist, { slipNos: [203, 204] }, 200);
  const rec = await call('GET', `/api/v1/paper-books/${bookId}/reconciliation?outageFrom=${at('10:45')}&outageTo=${at('12:00')}`, owner, undefined, 200);
  assert.deepEqual(rec.body.unaccounted, ['P-205']);
  assert.equal(rec.body.careVsSlips.totals.slipTotalMillimes, 40_000);
  step('paper outage', { wrongPatientRejected: true, posted: 1, replay: 'DUPLICATE_ENTRY', void: 1, unused: 2, unaccounted: rec.body.unaccounted, careWithoutPayment: rec.body.careWithoutPayment.visits.length });

  // ---------------------------------------------------------------- blind count, discrepancy, close
  const count = await call('POST', `/api/v1/cash/periods/${periodId}/counts`, dentist, { countedMillimes: 135_000 }, 201);
  deskSeen.push(count.body);
  await call('GET', `/api/v1/cash/periods/${periodId}/review`, desk, undefined, 403);
  const review2 = await call('GET', `/api/v1/cash/periods/${periodId}/review`, owner, undefined, 200);
  const att = review2.body.attempts[0];
  step('blind count', { countedMillimes: att.countedMillimes, expectedMillimes: att.expectedMillimes, differenceMillimes: att.differenceMillimes, wording: att.wording, counterIndependent: att.counterIndependent });
  assert.equal(att.differenceMillimes, att.countedMillimes - att.expectedMillimes);
  await reauth(api, owner);
  await call('POST', `/api/v1/cash/periods/${periodId}/close`, owner, { acceptedCountId: count.body.count.id, handoverMillimes: 100_000, note: 'Fictional: difference to review' }, 200);
  const wb = await call('GET', `/api/v1/visits/${v1}/workbench`, desk, undefined, 200);
  deskSeen.push(wb.body);
  step('period closed', { workbenchNextAction: wb.body.visit.nextAction, cashEvidence: wb.body.visit.payments?.[0]?.evidenceStatus ?? null });

  // ---------------------------------------------------------------- owner review, exceptions, integrity
  const fr = await call('GET', `/api/v1/owner/financial-review?from=${DAY}&to=${localDate(new Date())}`, owner, undefined, 200);
  assert.equal(fr.body.reductions.totalMillimes, 10_000);
  assert.equal(fr.body.returns.totalMillimes, 40_000);
  assert.equal(fr.body.feeCorrections.netMillimes, -10_000);
  assert.equal(fr.body.cashPeriods.discrepancies, att.differenceMillimes === 0 ? 0 : 1);
  const ex = await call('GET', `/api/v1/owner/exceptions?asOf=${localDate(new Date(Date.now() + 86400_000))}`, owner, undefined, 200);
  await reauth(api, owner);
  const integ = await call('POST', '/api/v1/integrity/check', owner, {}, 200);
  const chain = await call('POST', '/api/v1/audit/verify', owner, {}, 200);
  assert.equal(integ.body.ok, true, JSON.stringify(integ.body.findings));
  assert.equal(chain.body.ok, true);
  step('owner review', { evidenceLevels: Object.fromEntries(Object.entries(fr.body.paymentEvidence.byLevel).map(([k, v]) => [k, (v as { count: number }).count])),
    returns: fr.body.returns.items.map((r: { kind: string; receiptLabel: string }) => `${r.kind}:${r.receiptLabel}`), exceptionKinds: [...new Set(ex.body.open.map((e: { kind: string }) => e.kind))],
    integrityOk: integ.body.ok, auditEvents: integ.body.auditEvents });

  // ---------------------------------------------------------------- privacy sweep over everything the desk/assistant saw
  for (const [who, seen] of [['desk', deskSeen], ['assistant', assistantSeen]] as const) {
    const raw = JSON.stringify(seen);
    for (const secret of ['warfarin', 'Fictional finding note', 'cavity 36', 'pain left', 'composite today', 'shorter session']) assert.ok(!raw.includes(secret), `${who} saw clinical free text: ${secret}`);
  }
  const ownerRaw = JSON.stringify(fr.body);
  assert.ok(!ownerRaw.includes('shorter session'), 'owner review carries no free text (flags only)');
  step('privacy sweep', { deskResponsesChecked: deskSeen.length, assistantResponsesChecked: assistantSeen.length, clinicalFreeTextFound: 0 });

  // ---------------------------------------------------------------- clinic B isolation
  const bOwner = await api.login('r72-clinic-b', 'owner'), bDesk = await api.login('r72-clinic-b', 'desk');
  const bp = (await call('POST', '/api/v1/patients', bDesk, { isSynthetic: true, familyName: 'Other', givenName: 'Clinic' }, 201)).body.patient;
  await call('POST', '/api/v1/visits', bDesk, { patientId: bp.id, scheduledAt: at('09:00') }, 201);
  await call('GET', `/api/v1/patients/${elder.id}`, bDesk, undefined, 404);
  await call('POST', `/api/v1/receipts/${pay1.receipt.id}/print`, bDesk, {}, 404);
  await call('GET', `/api/v1/paper-books/${bookId}/reconciliation`, bOwner, undefined, 404); // RLS: invisible, not merely forbidden
  const bBoard = await call('GET', `/api/v1/day-board?day=${DAY}`, bDesk, undefined, 200);
  assert.equal(bBoard.body.summary.total, 1);
  await reauth(api, bOwner);
  const bReview = await call('GET', `/api/v1/owner/financial-review?from=${DAY}&to=${localDate(new Date())}`, bOwner, undefined, 200);
  assert.equal(bReview.body.returns.items.length + bReview.body.reductions.items.length, 0);
  assert.equal((await call('POST', '/api/v1/integrity/check', bOwner, {}, 200)).body.ok, true);
  step('clinic B isolation', { patientOfA: 404, receiptOfA: 404, paperBookOfA: 404, boardTotal: 1, reviewItems: 0 });

  // ---------------------------------------------------------------- encrypted backup -> restore into a NEW database
  const adminUrl = process.env.EZZ_TEST_ADMIN_URL!;
  const work = mkdtempSync(join(tmpdir(), 'ezz-r72-journey-'));
  const target = `ezz_r72_restored_${Date.now()}`;
  try {
    const backup = await createBackup({ adminUrl, database: db.name, outDir: work, passphrase: 'fictional-r72-journey-passphrase', name: 'r72' });
    const report = await restoreAndVerify({ encryptedPath: backup.encryptedPath, manifestPath: backup.manifestPath, passphrase: 'fictional-r72-journey-passphrase',
      targetAdminUrl: adminUrl, targetDatabase: target, migrationsDir: MIGRATIONS_DIR,
      // Same instance: the roles already exist, so pass their (fictional) passwords as used by the test helpers.
      rolePasswords: { owner: new URL(db.ownerUrl).password, app: new URL(db.appUrl).password } });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => !c.ok)));
    // Clinical tables and the paper book are not in the B14 manifest facts: compare them directly.
    const counts = async (name: string) => {
      const a = await adminConn(name);
      try {
        return (await a.query<Record<string, string>>(`SELECT (SELECT count(*) FROM clinical_notes) AS notes, (SELECT count(*) FROM chart_findings) AS findings,
          (SELECT count(*) FROM medical_alerts) AS alerts, (SELECT count(*) FROM plan_item_events) AS plan_events, (SELECT count(*) FROM paper_slip_entries) AS slips,
          (SELECT count(*) FROM receipt_prints) AS prints, (SELECT string_agg(content_sha256, ',' ORDER BY id) FROM clinical_notes) AS note_hashes`)).rows[0]!;
      } finally { a.end(); }
    };
    const [src, dst] = [await counts(db.name), await counts(target)];
    assert.deepEqual(dst, src, 'clinical, paper and print rows restored identically');
    // The restored system answers through the app role.
    const restoredApi = await startApi(urlFor('ezz_app', new URL(db.appUrl).password, target));
    try {
      const o2 = await restoredApi.login('r72-clinic-a', 'owner');
      await reauth(restoredApi, o2);
      const i2 = await restoredApi.call('POST', '/api/v1/integrity/check', { token: o2, body: {}, idem: false });
      assert.equal(i2.body.ok, true, JSON.stringify(i2.body.findings));
    } finally { await restoredApi.close(); }
    step('backup and restore', { checks: report.checks.length, allPassed: report.ok, timingsMs: report.timingsMs, clinicalRowsMatch: true, restoredIntegrityOk: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
    const a = await adminConn();
    try { await a.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`); } finally { a.end(); }
  }
  assert.ok(log.length >= 15);
});
