/*
 * R75-A — CH-035 and a sharper legacy gap found while reproducing it. Audit events written before R73-H carry no exact
 * row timestamps, so the integrity check can only compare a row time with its event time (±120 s). Inside that tolerance
 * a privileged edit could move a cash item across a count cut-off (CH-035); a carried-forward period's start was not
 * compared at all. Each test first turns a real history into a pre-R73-H one (anchors removed, chain rehashed: what the
 * old code wrote), then tampers like the other B06 tests. Fictional data only.
 * The check must never call such history verified: a provable edit is HIGH, an unprovable one is INCONCLUSIVE (MEDIUM),
 * and an honest legacy history stays clean.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, adminConn, reauth, type Api, type TestDb } from './helpers.ts';
import { canonicalJson, sha256 } from '../src/platform/canonical.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic() {
  const f = await standardFixture(api, db, `r75a-${++n}`, { openingFloatMillimes: 50_000 });
  const period = (await api.call('GET', '/api/v1/cash/periods/current', { token: f.desk })).body.period as { id: string };
  await confirmCare(api, f.dentist, f.visitId, 100_000);
  return { ...f, periodId: period.id };
}
type F = Awaited<ReturnType<typeof clinic>>;
async function cashPayment(f: F, amountMillimes: number) {
  const r = await api.call('POST', `/api/v1/visits/${f.visitId}/payments`, { token: f.desk, body: { amountMillimes, tender: 'CASH', confirmDuplicate: true } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.payment.id as string;
}
async function count(f: F, periodId: string, counted: number) {
  const r = await api.call('POST', `/api/v1/cash/periods/${periodId}/counts`, { token: f.dentist, body: { countedMillimes: counted } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.count.id as string;
}
async function checks(f: { owner: string }) {
  const r = await api.call('POST', '/api/v1/integrity/check', { token: f.owner, body: {}, idem: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.findings as Array<{ check: string; severity: string; refs?: Record<string, unknown>; detail: string }>;
}
async function admin(sqls: Array<[string, unknown[]]>) {
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    for (const [s, p] of sqls) await a.query(s, p as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
}
/** The R73-H row-time anchors. Removing them and rehashing the chain yields exactly what pre-R73-H code wrote. */
const TIME_ANCHORS = ['recordedAt', 'createdAt', 'submittedAt', 'openedAt', 'nextOpenedAt'];
async function makeLegacy(clinicId: string) {
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    const evs = (await a.query<{ seq: number; canonical: string }>('SELECT seq, canonical FROM audit_events WHERE clinic_id = $1 ORDER BY seq', [clinicId] as never[])).rows;
    let prev = '0'.repeat(64);
    for (const e of evs) {
      const doc = JSON.parse(e.canonical);
      for (const k of TIME_ANCHORS) delete doc.payload[k];
      doc.prevHash = prev;
      const canonical = canonicalJson(doc); const hash = sha256(prev + '\n' + canonical);
      await a.query('UPDATE audit_events SET payload = $3, canonical = $4, prev_hash = $5, hash = $6 WHERE clinic_id = $1 AND seq = $2', [clinicId, e.seq, doc.payload, canonical, prev, hash] as never[]);
      prev = hash;
    }
    await a.query('UPDATE audit_heads SET last_hash = $2 WHERE clinic_id = $1', [clinicId, prev] as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
}
const checksOf = (fs: Array<{ check: string; refs?: Record<string, unknown> }>) => JSON.stringify(fs.map(x => [x.check, x.refs?.table, x.refs?.field]));

test('T-INT-CASH-LEGACY-0 an honest pre-R73-H cash history (payments, movement, refund, close, carry-forward count) stays clean', async () => {
  const f = await clinic();
  const p = await cashPayment(f, 20_000);
  await reauth(api, f.owner);
  const mv = await api.call('POST', `/api/v1/cash/periods/${f.periodId}/movements`, { token: f.owner, body: { kind: 'PETTY_EXPENSE', amountMillimes: 5_000, reason: 'Fictional supplies', voucherRef: 'V-L0' } });
  assert.equal(mv.status, 201, JSON.stringify(mv.body));
  const careId = (await api.call('GET', `/api/v1/visits/${f.visitId}/care`, { token: f.dentist })).body.items[0].id as string;
  assert.equal((await api.call('POST', `/api/v1/care-items/${careId}/corrections`, { token: f.dentist, body: { deltaMillimes: -82_000, reason: 'Fictional fee lowered' } })).status, 201);
  await reauth(api, f.owner);
  assert.equal((await api.call('POST', `/api/v1/payments/${p}/refund`, { token: f.owner, body: { amountMillimes: 2_000, reasonCode: 'FEE_CORRECTED' } })).status, 201);
  const c1 = await count(f, f.periodId, 63_000);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${f.periodId}/close`, { token: f.owner, body: { acceptedCountId: c1, handoverMillimes: 13_000 } })).status, 200);
  const p2 = (await api.call('GET', '/api/v1/cash/periods/current', { token: f.desk })).body.period.id as string;
  await count(f, p2, 50_000);
  await makeLegacy(f.clinic.id);
  assert.deepEqual(await checks(f), []);
});

test('T-INT-CASH-LEGACY-1 (CH-035) pre-R73-H: a cash item moved across a count cut-off inside the ±120 s tolerance is reported as INCONCLUSIVE, not as verified', async () => {
  // (a) the payment moves just past the cut-off; (b) the count's cut-off moves just before the payment.
  for (const variant of ['payment', 'count'] as const) {
    const f = await clinic();
    const p = await cashPayment(f, 20_000);
    const c = await count(f, f.periodId, 70_000);
    await makeLegacy(f.clinic.id);
    await admin([
      variant === 'payment'
        ? ["UPDATE payments SET recorded_at = (SELECT submitted_at FROM cash_counts WHERE id = $2) + interval '1 second' WHERE id = $1", [p, c]]
        : ["UPDATE cash_counts SET submitted_at = (SELECT recorded_at FROM payments WHERE id = $2) - interval '1 millisecond' WHERE id = $1", [c, p]],
      ['UPDATE cash_counts SET expected_millimes = 50000, difference_millimes = 20000 WHERE id = $1', [c]],
    ]);
    const fs = await checks(f);
    const hit = fs.find(x => x.check === 'LEGACY_TIME_UNANCHORED' && x.refs?.table === (variant === 'payment' ? 'payments' : 'cash_counts'));
    assert.ok(hit, `${variant}: ${checksOf(fs)}`);
    assert.equal(hit!.severity, 'MEDIUM');
    assert.equal(hit!.refs?.verdict, 'INCONCLUSIVE');
    assert.match(hit!.detail, /cannot be verified/);
    assert.match(hit!.detail, /not by itself evidence/);
    assert.ok(fs.every(x => x.severity === 'MEDIUM'), `${variant}: nothing is claimed as a proven mismatch: ${checksOf(fs)}`);
    // The owner sees it as unverifiable old history, not as a detected change.
    const ex = await api.call('GET', '/api/v1/owner/exceptions', { token: f.owner });
    assert.equal(ex.status, 200, JSON.stringify(ex.body));
    const item = (ex.body.open as Array<{ kind: string; severity: string; unknown: string }>).find(i => i.kind === 'INTEGRITY_LEGACY_TIME_UNANCHORED');
    assert.ok(item, JSON.stringify(ex.body.open.map((i: { kind: string }) => i.kind)));
    assert.deepEqual([item!.severity, item!.unknown], ['MEDIUM', 'Whether anything was changed']);
  }
});

test('T-INT-CASH-LEGACY-2 pre-R73-H: a carried-forward period start moved past a cash payment (hiding it from every count) is reported', async () => {
  const f = await clinic();
  const c1 = await count(f, f.periodId, 50_000);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${f.periodId}/close`, { token: f.owner, body: { acceptedCountId: c1, handoverMillimes: 0 } })).status, 200);
  const p2 = (await api.call('GET', '/api/v1/cash/periods/current', { token: f.desk })).body.period.id as string;
  const p = await cashPayment(f, 20_000);
  const c2 = await count(f, p2, 70_000);
  await makeLegacy(f.clinic.id);
  // Period 2 now starts after the payment: the payment lies after period 1's cut-off and before period 2's start.
  await admin([
    ["UPDATE cash_periods SET opened_at = (SELECT recorded_at FROM payments WHERE id = $2) + interval '1 millisecond' WHERE id = $1", [p2, p]],
    ['UPDATE cash_counts SET expected_millimes = 50000, difference_millimes = 20000 WHERE id = $1', [c2]],
  ]);
  const fs = await checks(f);
  const hit = fs.find(x => x.check === 'CASH_PERIOD_AUDIT_VALUE_MISMATCH' && x.refs?.field === 'openedAt');
  assert.ok(hit, checksOf(fs));
  assert.equal(hit!.severity, 'HIGH', 'the start of a carried-forward period is exactly known (the accepted count), so this is a proven mismatch');
});
