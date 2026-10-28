/*
 * R72 / M-264 / M-265 — clinical author role snapshots must be TRUE, not a constant.
 * Every clinical author row stores its role as the literal 'DENTIST' (and 0008 CHECKs enforce it). Today only
 * DENTIST holds clinical.write / care.confirm / care.amend_site, so the label is accurate. If the permission matrix is
 * ever widened (the ASSISTANT question is a pending policy decision), a non-dentist would write rows that falsely read
 * as dentist-authored. Policy-preserving fix: clinical authoring refuses any actor without the DENTIST role, so the
 * stored snapshot is true by construction. No CHECK is relaxed and no clinical policy changes. Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, seedClinic, STANDARD_STAFF, newVisit, adminConn, type Api, type TestDb } from './helpers.ts';
import { PERMISSIONS } from '../src/modules/identity.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

/** Simulate a future widening of the matrix (in this test process only). */
function widen(perms: string[]) {
  const P = PERMISSIONS as Record<string, readonly string[]>;
  const saved = perms.map(p => [p, P[p]!] as const);
  for (const p of perms) P[p] = [...P[p]!, 'ASSISTANT'];
  return () => { for (const [p, v] of saved) P[p] = v; };
}

test('T-ROLE-1 (RED before fix) with clinical permissions widened to ASSISTANT, an assistant cannot author rows that would read as dentist-authored', async () => {
  const c = await seedClinic(db, 'r72-role', [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }]);
  const desk = await api.login('r72-role', 'desk');
  const dentist = await api.login('r72-role', 'dentist');
  const assistant = await api.login('r72-role', 'assistant');
  const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictif', givenName: 'Role', isSynthetic: true } });
  const pid = p.body.patient.id as string;
  const visit = await newVisit(api, desk, pid, '2026-10-20T09:00:00Z');
  assert.equal((await api.call('POST', `/api/v1/patients/${pid}/medical-alerts`, { token: desk, body: { code: 'ANTICOAGULANT_VKA', severity: 'CRITICAL' } })).status, 201);
  const restore = widen(['clinical.read', 'clinical.write', 'care.confirm', 'care.amend_site']);
  try {
    const hash = (await api.call('GET', `/api/v1/patients/${pid}/medical-alerts`, { token: assistant })).body.alertSetHash as string;
    const attempts = [
      ['clinical-notes', `/api/v1/visits/${visit}/clinical-notes`, { objective: 'Fictional note by a non-dentist' }],
      ['chart-findings', `/api/v1/visits/${visit}/chart-findings`, { kind: 'FINDING', toothFdi: 11, conditionCode: 'FRACTURE' }],
      ['plan-item', `/api/v1/patients/${pid}/treatment-plan-items`, { procedureCode: 'SCALE', procedureLabel: 'Fictional scaling', estimatedFeeMillimes: 30_000 }],
      ['alert-ack', `/api/v1/visits/${visit}/alert-acknowledgements`, { alertSetHash: hash }],
      ['history-review', `/api/v1/patients/${pid}/medical-history-reviews`, { method: 'INTERVIEW', noKnownAllergies: false, alertSetHash: hash }],
      ['care', `/api/v1/visits/${visit}/care`, { procedureCode: 'CHECKUP', procedureLabel: 'Fictional checkup', feeMillimes: 10_000, alertSetHash: hash }],
    ] as const;
    for (const [name, path, body] of attempts) {
      const r = await api.call('POST', path, { token: assistant, body });
      assert.equal(r.status, 403, `${name}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'FORBIDDEN_ROLE', name);
    }
  } finally { restore(); }
  const a = await adminConn(db.name);
  try {
    const sid = c.staff.assistant!;
    const rows = (await a.query<{ n: number }>(`SELECT
        (SELECT count(*) FROM clinical_notes WHERE signed_by = $1) + (SELECT count(*) FROM chart_findings WHERE recorded_by = $1)
      + (SELECT count(*) FROM treatment_plan_items WHERE created_by = $1) + (SELECT count(*) FROM alert_acknowledgements WHERE acknowledged_by = $1)
      + (SELECT count(*) FROM medical_history_reviews WHERE reviewed_by = $1) + (SELECT count(*) FROM care_items WHERE confirmed_by = $1) AS n`, [sid] as never[])).rows[0]!;
    assert.equal(Number(rows.n), 0, 'no row authored by the assistant was written');
  } finally { a.end(); }
  // With the default matrix the dentist path is unchanged.
  const hash = (await api.call('GET', `/api/v1/patients/${pid}/medical-alerts`, { token: dentist })).body.alertSetHash as string;
  assert.equal((await api.call('POST', `/api/v1/visits/${visit}/alert-acknowledgements`, { token: dentist, body: { alertSetHash: hash } })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/visits/${visit}/clinical-notes`, { token: dentist, body: { objective: 'Fictional exam' } })).status, 201);
});
