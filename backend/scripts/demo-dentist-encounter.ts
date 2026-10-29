/* Local fictional dentist-encounter walkthrough (B07). NEVER POINT EZZ_TEST_ADMIN_URL AT A REAL DB.
 * Creates then destroys a temporary PostgreSQL database and drives the real HTTP API with real sessions:
 * desk intake with a declared alert -> dentist encounter -> review -> finding -> signed note -> plan ->
 * perform -> partial cash checkout -> site amendment -> longitudinal record. Prints each request and the
 * response (ids shortened, tokens never printed) for docs/api/clinical-v1.md. No medical guidance.
 */
import { createTestDb, startApi, standardFixture, type Api, type TestDb } from '../test/helpers.ts';

const short = (v: unknown): unknown => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(v) ? v.slice(0, 8) + '…'
  : typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v.slice(0, 12) + '…'
  : Array.isArray(v) ? v.map(short) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, short(x)])) : v;

let db: TestDb | undefined, api: Api | undefined;
try {
  db = await createTestDb();
  api = await startApi(db.appUrl);
  const f = await standardFixture(api, db, 'encounter-demo');
  const out: unknown[] = [];
  const call = async (who: string, token: string, method: string, path: string, body?: Record<string, unknown>) => {
    const r = await api!.call(method, path, { token, body });
    out.push({ who, request: `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, m => m.slice(0, 8) + '…')}`, body: short(body), status: r.status, response: short(r.body) });
    return r;
  };
  const pid = f.patientId, vid = f.visitId;
  await call('desk', f.desk, 'POST', `/api/v1/patients/${pid}/medical-alerts`, { code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL', detail: 'Fictional: patient says takes a blood thinner' });
  await call('desk', f.desk, 'GET', `/api/v1/patients/${pid}/medical-alerts/summary`);
  await call('desk', f.desk, 'POST', `/api/v1/visits/${vid}/status`, { status: 'ARRIVED' });
  const enc = await call('dentist', f.dentist, 'GET', `/api/v1/visits/${vid}/encounter`);
  const alertId = enc.body.medical.activeAlerts[0].id;
  const blocked = await call('dentist', f.dentist, 'POST', `/api/v1/visits/${vid}/care`, { procedureCode: 'EXAM', procedureLabel: 'Fictional exam', feeMillimes: 20000 });
  if (blocked.status !== 409) throw new Error('expected the alert gate');
  const ver = await call('dentist', f.dentist, 'POST', `/api/v1/medical-alerts/${alertId}/revisions`, { action: 'VERIFY', expectedRevision: 1 });
  await call('dentist', f.dentist, 'POST', `/api/v1/patients/${pid}/medical-history-reviews`, { method: 'INTERVIEW', noKnownAllergies: true, alertSetHash: ver.body.alertSetHash, visitId: vid });
  await call('dentist', f.dentist, 'POST', `/api/v1/visits/${vid}/chart-findings`, { kind: 'FINDING', toothFdi: 36, surfaces: 'mo', conditionCode: 'CARIES' });
  await call('dentist', f.dentist, 'POST', `/api/v1/visits/${vid}/clinical-notes`, { subjective: 'Fictional: pain when chewing', objective: 'Fictional: cavity on 36', plan: 'Fictional: restoration today' });
  const plan = await call('dentist', f.dentist, 'POST', `/api/v1/patients/${pid}/treatment-plan-items`, { procedureCode: 'RESTO', procedureLabel: 'Fictional composite restoration', toothFdi: 36, surfaces: 'MO', estimatedFeeMillimes: 80000, visitId: vid });
  const perf = await call('dentist', f.dentist, 'POST', `/api/v1/treatment-plan-items/${plan.body.planItem.id}/perform`, { visitId: vid });
  await call('desk', f.desk, 'POST', `/api/v1/visits/${vid}/payments`, { amountMillimes: 50000, tender: 'CASH' });
  await call('dentist', f.dentist, 'POST', `/api/v1/care-items/${perf.body.careItem.id}/site-amendments`, { toothFdi: 36, surfaces: 'DO', reasonCode: 'WRONG_SURFACE', expectedSupersedesId: null });
  await call('desk', f.desk, 'GET', `/api/v1/visits/${vid}/workbench`);
  await call('desk', f.desk, 'GET', `/api/v1/patients/${pid}/clinical-record`);
  await call('dentist', f.dentist, 'GET', `/api/v1/patients/${pid}/clinical-record`);
  console.log(JSON.stringify({ app: 'EZZ Clinic v0.2 fictional only', mode: 'local temporary PostgreSQL, synthetic patient, no clinical use', steps: out }, null, 2));
} finally {
  if (api) await api.close();
  if (db) await db.drop();
}
