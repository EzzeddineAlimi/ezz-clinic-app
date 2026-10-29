/*
 * R73-I — residual defects from the R72/R73 handoffs, each reproduced before its fix. Fictional data only.
 *   T-DENY-DAY-1  security_denials.day used the database session's current_date (UTC on most servers), not the clinic
 *                 day, so the owner's 7-day "denied attempts" window was off by a day for denials near local midnight.
 *   T-MED-FLOOD-1 R72 D-6 / Muse M-264 (2): a desk account could declare unlimited OTHER / ALLERGY_OTHER alerts.
 *                 Every declaration changes the alert-set hash the dentist must acknowledge before confirming care,
 *                 so a flood stalls the visit. Unverified desk declarations are now bounded per patient and an
 *                 identical repeat is refused; the dentist is never limited.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, adminConn, reauth, type Api, type TestDb } from './helpers.ts';
import { localDate } from '../src/modules/settings.ts';
import { MAX_UNVERIFIED_DECLARED_ALERTS } from '../src/modules/medical.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });
let n = 0;

test('T-DENY-DAY-1 a denied attempt is counted on the CLINIC day, not the database server day', async () => {
  const f = await standardFixture(api, db, `res-deny-${++n}`, { openCashPeriod: false });
  // Pick a timezone whose date differs from the UTC date right now (+14 h or -11 h always covers one of them).
  const utcDay = new Date().toISOString().slice(0, 10);
  const tz = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find(z => localDate(z) !== utcDay)!;
  await reauth(api, f.owner);
  const set = await api.call('POST', '/api/v1/clinic/settings', { token: f.owner, body: { changes: { timezone: tz }, reason: 'Fictional far-away clinic', confirmTimezoneImpact: true } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await api.call('GET', '/api/v1/owner/exceptions', { token: f.desk })).status, 403);
  const a = await adminConn(db.name);
  try {
    const row = (await a.query<{ day: string }>('SELECT day::text AS day FROM security_denials WHERE clinic_id = $1', [f.clinic.id] as never[])).rows[0]!;
    assert.equal(row.day, localDate(tz), `stored ${row.day}; clinic day in ${tz} is ${localDate(tz)}; UTC day is ${utcDay}`);
  } finally { a.end(); }
});

test('T-MED-FLOOD-1 unverified desk declarations are bounded per patient; identical repeats refused; the dentist is never limited', async () => {
  const f = await standardFixture(api, db, `res-flood-${++n}`, { openCashPeriod: false });
  const declare = (token: string, code: string, detail: string) => api.call('POST', `/api/v1/patients/${f.patientId}/medical-alerts`, { token, body: { code, severity: 'CAUTION', detail } });
  for (let i = 0; i < MAX_UNVERIFIED_DECLARED_ALERTS; i++) assert.equal((await declare(f.desk, i % 2 ? 'OTHER' : 'ALLERGY_OTHER', `Fictional declaration ${i}`)).status, 201, `declaration ${i}`);
  const over = await declare(f.desk, 'OTHER', 'Fictional declaration beyond the bound');
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.equal(over.body.error.details.limit, MAX_UNVERIFIED_DECLARED_ALERTS);
  assert.ok(!JSON.stringify(over.body).includes('Fictional declaration 0'), 'the refusal does not echo other declarations to the desk');
  assert.equal((await declare(f.dentist, 'OTHER', 'Fictional dentist-recorded condition')).status, 201, 'the dentist is never limited');
  // Identical repeat (same code and same detail, case/space-insensitive) is refused even below the bound.
  const g = await standardFixture(api, db, `res-flood-${++n}`, { openCashPeriod: false });
  const d2 = (detail: string) => api.call('POST', `/api/v1/patients/${g.patientId}/medical-alerts`, { token: g.desk, body: { code: 'OTHER', severity: 'CAUTION', detail } });
  assert.equal((await d2('Fictional: asthma inhaler')).status, 201);
  assert.equal((await d2('  fictional:  ASTHMA inhaler ')).status, 409);
});
