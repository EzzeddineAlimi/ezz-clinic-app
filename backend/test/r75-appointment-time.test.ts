/*
 * R75-B — CH-038. An appointment time is an instant; its meaning must not depend on how the server host is configured.
 * JavaScript reads an ISO date-time WITHOUT an offset as the PROCESS's local time, so '2026-10-30T09:00' was stored as
 * 09:00Z on a UTC host, 08:00Z on an Africa/Tunis host and 13:00Z on an America/Toronto host. The published contract
 * (docs/api/openapi.json) already says format: date-time (RFC 3339: offset required); the server now enforces it.
 * Same validator: an impossible calendar date ('2026-02-30') was silently moved to another day. Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, newVisit, type Api, type TestDb } from './helpers.ts';
import { isoTime } from '../src/platform/validate.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
const fixture = () => standardFixture(api, db, `r75b-${++n}`);
/** Runs fn with the API process in another timezone (Node re-reads process.env.TZ at runtime). */
async function inProcessTz<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
}
const book = (f: Awaited<ReturnType<typeof fixture>>, scheduledAt: string) =>
  api.call('POST', '/api/v1/visits', { token: f.desk, body: { patientId: f.patientId, scheduledAt } });

test('T-TZ-APPT-6 (CH-038) a scheduledAt without a UTC offset is refused with 400 whatever the server timezone, and nothing is stored', async () => {
  const f = await fixture();
  for (const tz of ['UTC', 'Africa/Tunis', 'America/Toronto']) {
    for (const s of ['2026-10-30T09:00', '2026-10-30T09:00:00', '2026-10-30T09:00:00.000']) {
      const r = await inProcessTz(tz, () => book(f, s));
      assert.equal(r.status, 400, `${tz} ${s}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'VALIDATION_FAILED');
      assert.equal(r.body.error.details.field, 'scheduledAt');
      assert.match(r.body.error.message, /offset/);
    }
  }
  const list = await api.call('GET', '/api/v1/visits?day=2026-10-30', { token: f.desk });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.visits.length, 0, 'no offset-less visit was stored');
});

test('T-TZ-APPT-6b times WITH an offset are stored as the same instant whatever the server timezone (contract unchanged)', async () => {
  const f = await fixture();
  const cases: Array<[string, string]> = [
    ['2026-10-30T09:00:00+01:00', '2026-10-30T08:00:00.000Z'], ['2026-10-30T08:00:00Z', '2026-10-30T08:00:00.000Z'],
    ['2026-10-30T08:00Z', '2026-10-30T08:00:00.000Z'], ['2026-10-30T08:00:00.5z', '2026-10-30T08:00:00.500Z'],
    ['2026-10-30T03:30:00-04:30', '2026-10-30T08:00:00.000Z'],
  ];
  for (const tz of ['UTC', 'Africa/Tunis', 'America/Toronto']) {
    for (const [input, stored] of cases) {
      const r = await inProcessTz(tz, () => book(f, input));
      assert.equal(r.status, 201, `${tz} ${input}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.visit.scheduledAt, stored, `${tz} ${input}`);
    }
  }
});

test('T-TZ-APPT-6c an impossible calendar date or time is refused instead of being moved to another day', async () => {
  const f = await fixture();
  for (const s of ['2026-02-30T09:00:00Z', '2026-04-31T09:00:00+01:00', '2026-10-30T24:00:00Z', '2026-10-30T09:60:00Z', '2026-10-30T09:00:00+25:00', '2026-10-30T09:00:00Zjunk']) {
    const r = await book(f, s);
    assert.equal(r.status, 400, `${s}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.details.field, 'scheduledAt');
  }
  assert.equal((await book(f, '2028-02-29T09:00:00+01:00')).status, 201, 'a real leap day is accepted');
});

test('T-TZ-APPT-6d the same rule applies to a late clinical entry (effectiveAt), the only other isoTime caller', async () => {
  const f = await fixture();
  const vid = await newVisit(api, f.desk, f.patientId, '2026-10-01T08:00:00Z');
  const note = (effectiveAt: string) => api.call('POST', `/api/v1/visits/${vid}/clinical-notes`, { token: f.dentist, body: { kind: 'LATE_ENTRY', objective: 'Fictional late observation', reason: 'Fictional: power cut', effectiveAt } });
  const bad = await inProcessTz('Africa/Tunis', () => note('2026-10-01T09:00:00'));
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.equal(bad.body.error.details.field, 'effectiveAt');
  const ok = await note('2026-10-01T09:00:00+01:00');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.note.effectiveAt, '2026-10-01T08:00:00.000Z');
});

test('T-TZ-APPT-6e isoTime unit: returns the canonical UTC instant, independent of process.env.TZ', async () => {
  for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    await inProcessTz(tz, async () => {
      assert.equal(isoTime({ t: '2026-10-30T09:00:00+01:00' }, 't'), '2026-10-30T08:00:00.000Z');
      assert.throws(() => isoTime({ t: '2026-10-30T09:00:00' }, 't'), /offset/);
    });
  }
});
