/*
 * CH-032 — one shared site validator for the care route (MODEL_INBOX C-171/C-173 T-CL-SURF-1..5).
 * Before this change POST /visits/:id/care used its own loose regex, so repeated letters, anatomically
 * contradictory letters and surfaces without a tooth were stored, and the duplicate guard compared raw
 * strings (so 'DOM' slipped past an existing 'MOD'). Surface rules are PROVISIONAL (clinical-requirements
 * §1.3) and need a Tunisian dentist's confirmation; these tests pin the current agreed contract only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api; let A: Awaited<ReturnType<typeof standardFixture>>;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); A = await standardFixture(api, db, 'site-val'); });
after(async () => { await api.close(); await db.drop(); });

let slot = 0;
const care = async (site: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const v = extra.visitId as string ?? await newVisit(api, A.desk, A.patientId, `2026-11-02T${String(7 + (slot++ % 12)).padStart(2, '0')}:${String(slot).padStart(2, '0')}:00Z`);
  return { visitId: v, r: await api.call('POST', `/api/v1/visits/${v}/care`, { token: A.dentist, body: { procedureCode: 'RESTO', procedureLabel: 'Fictional restoration', feeMillimes: 50_000, ...site, ...extra, visitId: undefined } }) };
};
const countCare = async (visitId: string) => (await api.call('GET', `/api/v1/visits/${visitId}/care`, { token: A.dentist })).body.items.length;

test('T-CL-SURF-1 repeated surface letters (36 MM) -> 400 VALIDATION_FAILED, nothing stored', async () => {
  const { visitId, r } = await care({ toothFdi: 36, surfaces: 'MM' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  assert.equal(r.body.error.details.field, 'surfaces');
  assert.equal(await countCare(visitId), 0);
});

test('T-CL-SURF-2 anterior letters on a posterior tooth (36 IF) -> 400', async () => {
  const { visitId, r } = await care({ toothFdi: 36, surfaces: 'IF' });
  assert.equal(r.status, 400);
  assert.equal(await countCare(visitId), 0);
});

test('T-CL-SURF-3 surfaces without a tooth (null MOD) -> 400', async () => {
  const { visitId, r } = await care({ toothFdi: null, surfaces: 'MOD' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.details.field, 'surfaces');
  assert.equal(await countCare(visitId), 0);
});

test('T-CL-SURF-4 valid sites are accepted and stored canonically (36 MOD; 36 dom -> MOD; 11 MID; no site)', async () => {
  for (const [site, stored] of [
    [{ toothFdi: 36, surfaces: 'MOD' }, { toothFdi: 36, surfaces: 'MOD' }],
    [{ toothFdi: 36, surfaces: 'dom' }, { toothFdi: 36, surfaces: 'MOD' }],
    [{ toothFdi: 11, surfaces: 'DIM' }, { toothFdi: 11, surfaces: 'MID' }],
    [{ toothFdi: 46 }, { toothFdi: 46, surfaces: null }],
    [{}, { toothFdi: null, surfaces: null }],
  ] as const) {
    const { r } = await care(site);
    assert.equal(r.status, 201, JSON.stringify({ site, body: r.body }));
    assert.deepEqual({ toothFdi: r.body.careItem.toothFdi, surfaces: r.body.careItem.surfaces }, stored);
  }
});

test('T-CL-SURF-5 table of invalid inputs, all rejected by the one shared validator', async () => {
  const bad: Record<string, unknown>[] = [
    { toothFdi: 11, surfaces: 'O' }, { toothFdi: 11, surfaces: 'B' }, { toothFdi: 16, surfaces: 'L' }, { toothFdi: 36, surfaces: 'P' },
    { toothFdi: 36, surfaces: 'MODBLX' }, { toothFdi: 36, surfaces: 'X' }, { toothFdi: 19 }, { toothFdi: 56 }, { toothFdi: '36' },
    { toothFdi: 36.5 }, { toothFdi: 36, surfaces: 7 }, { toothFdi: 36, surfaces: 'M O' },
  ];
  for (const site of bad) {
    const { r } = await care(site);
    assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(site)}, got ${r.status}`);
  }
});

test('T-CL-SURF-6 duplicate guard compares canonical sites: DOM after MOD on the same visit needs confirmRepeat', async () => {
  const { visitId } = await care({ toothFdi: 36, surfaces: 'MOD' });
  const again = await api.call('POST', `/api/v1/visits/${visitId}/care`, { token: A.dentist, body: { procedureCode: 'RESTO', procedureLabel: 'Fictional restoration', feeMillimes: 50_000, toothFdi: 36, surfaces: 'DOM' } });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'CARE_ALREADY_CONFIRMED');
  assert.equal(await countCare(visitId), 1);
});
