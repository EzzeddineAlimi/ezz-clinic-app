/*
 * B11 — Owner financial review: every recorded decision that reduced or returned money in a window, with who
 * authorised it, the receipt it produced, and the evidence level of every payment. Read-only, OWNER-only,
 * neutral wording, no free text (only hasNote/hasReason flags). Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

const day = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const review = (token: string, from = day(-1), to = day(1)) => api.call('GET', `/api/v1/owner/financial-review?from=${from}&to=${to}`, { token });

let n = 0;
/** One clinic, one fictional day touching every money-reducing path. */
async function day1() {
  const f = await standardFixture(api, db, `b11-${++n}`);
  await reauth(api, f.owner);
  // Visit A: 100,000 care, 70,000 cash, fee corrected -50,000 (credit 20,000), then a 20,000 refund with a note.
  const careA = await confirmCare(api, f.dentist, f.visitId, 100_000);
  const payA = await api.call('POST', `/api/v1/visits/${f.visitId}/payments`, { token: f.desk, body: { amountMillimes: 70_000, tender: 'CASH' } });
  assert.equal(payA.status, 201, JSON.stringify(payA.body));
  assert.equal((await api.call('POST', `/api/v1/care-items/${careA}/corrections`, { token: f.dentist, body: { deltaMillimes: -50_000, reason: 'Fictif: tarif révisé' } })).status, 201);
  const refund = await api.call('POST', `/api/v1/payments/${payA.body.payment.id}/refund`, { token: f.owner, body: { amountMillimes: 20_000, reasonCode: 'FEE_CORRECTED', reasonNote: 'Note privée fictive — ملاحظة' } });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  // Visit B: 60,000 care, dentist discount 10,000, owner write-off 50,000 => zeroed with no payment.
  const vB = await newVisit(api, f.desk, f.patientId, '2026-10-28T11:00:00Z');
  await confirmCare(api, f.dentist, vB, 60_000, 'XRAY');
  assert.equal((await api.call('POST', `/api/v1/visits/${vB}/adjustments`, { token: f.dentist, body: { kind: 'DISCOUNT', amountMillimes: 10_000, reasonCode: 'LOYALTY' } })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/visits/${vB}/adjustments`, { token: f.owner, body: { kind: 'WRITE_OFF', amountMillimes: 50_000, reasonCode: 'HARDSHIP', reasonNote: 'Texte libre fictif' } })).status, 201);
  // Visit C: 40,000 care paid in cash, then voided.
  const vC = await newVisit(api, f.desk, f.patientId, '2026-10-28T12:00:00Z');
  await confirmCare(api, f.dentist, vC, 40_000, 'SCALE');
  const payC = await api.call('POST', `/api/v1/visits/${vC}/payments`, { token: f.desk, body: { amountMillimes: 40_000, tender: 'CASH' } });
  assert.equal((await api.call('POST', `/api/v1/payments/${payC.body.payment.id}/void`, { token: f.owner, body: { reasonCode: 'ENTERED_IN_ERROR' } })).status, 201);
  // Visit D: 80,000 care corrected by -80,000 (CH-028 zeroing by correction), no payment.
  const vD = await newVisit(api, f.desk, f.patientId, '2026-10-28T13:00:00Z');
  const careD = await confirmCare(api, f.dentist, vD, 80_000, 'EXAM');
  const corr = await api.call('POST', `/api/v1/care-items/${careD}/corrections`, { token: f.dentist, body: { deltaMillimes: -80_000, reason: 'Fictif: acte non réalisé' } });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  // Visit E: free care.
  const vE = await newVisit(api, f.desk, f.patientId, '2026-10-28T14:00:00Z');
  assert.equal((await api.call('POST', `/api/v1/visits/${vE}/care`, { token: f.dentist, body: { procedureCode: 'CHECKUP', procedureLabel: 'Contrôle gratuit', feeMillimes: 0, reason: 'Fictif: suivi' } })).status, 201);
  // Visit F: 30,000 card payment (desk claim only).
  const vF = await newVisit(api, f.desk, f.patientId, '2026-10-28T15:00:00Z');
  await confirmCare(api, f.dentist, vF, 30_000, 'FILL');
  assert.equal((await api.call('POST', `/api/v1/visits/${vF}/payments`, { token: f.desk, body: { amountMillimes: 30_000, tender: 'CARD', cardLast4: '4242' } })).status, 201);
  return { ...f, vB, vC, vD, vE, vF, refundId: refund.body.adjustment?.id as string | undefined };
}

test('T-OWN-1 owner sees discount, write-off, refund (with receipt label), void, correction, free care and zeroed visits with totals; desk and dentist get 403', async () => {
  const s = await day1();
  const r = await review(s.owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.reductions.totalMillimes, 60_000);
  assert.deepEqual(b.reductions.byKind, { DISCOUNT: { count: 1, totalMillimes: 10_000 }, WRITE_OFF: { count: 1, totalMillimes: 50_000 } });
  assert.deepEqual(b.reductions.byReasonCode, { LOYALTY: { count: 1, totalMillimes: 10_000 }, HARDSHIP: { count: 1, totalMillimes: 50_000 } });
  assert.equal(b.returns.totalMillimes, 60_000);
  assert.deepEqual(b.returns.byKind, { REFUND: { count: 1, totalMillimes: 20_000 }, PAYMENT_VOID: { count: 1, totalMillimes: 40_000 } });
  for (const x of b.returns.items) assert.match(x.receiptLabel, /^[A-Z0-9]+-\d{6}$/, 'every return carries its own receipt number');
  assert.equal(b.feeCorrections.count, 2);
  assert.equal(b.feeCorrections.netMillimes, -130_000);
  assert.equal(b.feeCorrections.items.find((c: { visitId: string }) => c.visitId === s.vD).originalFeeMillimes, 80_000);
  assert.equal(b.freeCare.count, 1);
  assert.equal(b.freeCare.items[0].visitId, s.vE);
  assert.deepEqual(b.zeroedVisits.items.map((v: { visitId: string }) => v.visitId).sort(), [s.vB, s.vD].sort(), 'B by reductions, D by correction; A and C (paid) and E (free care) are not "zeroed"');
  const owner = Object.values(b.byAuthorizer).find((a: any) => a.role === 'OWNER') as any;
  assert.equal(owner.returns, 2); assert.equal(owner.returnMillimes, 60_000); assert.equal(owner.reductionMillimes, 50_000);
  const dentist = Object.values(b.byAuthorizer).find((a: any) => a.role === 'DENTIST') as any;
  assert.equal(dentist.reductionMillimes, 10_000); assert.equal(dentist.corrections, 2); assert.equal(dentist.correctionNetMillimes, -130_000);
  assert.equal((await review(s.desk)).status, 403);
  assert.equal((await review(s.dentist)).status, 403);
});

test('T-OWN-2 payment evidence levels: open-period cash is RECORDED_ONLY, counted+closed period cash is CASH_IN_COUNTED_PERIOD, card is CARD_DESK_CLAIM', async () => {
  const s = await day1();
  let ev = (await review(s.owner)).body.paymentEvidence.byLevel;
  assert.deepEqual(ev.RECORDED_ONLY, { count: 2, totalMillimes: 110_000, activeMillimes: 50_000 }, '70k - 20k refund, 40k voided');
  assert.deepEqual(ev.CARD_DESK_CLAIM, { count: 1, totalMillimes: 30_000, activeMillimes: 30_000 });
  assert.equal(ev.CASH_IN_COUNTED_PERIOD, undefined);
  // Count and close the drawer period that covers both cash payments.
  const pid = (await api.call('GET', '/api/v1/cash/periods/current', { token: s.owner })).body.period.id;
  const cnt = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: s.dentist, body: { countedMillimes: 50_000 } });
  assert.equal(cnt.status, 201, JSON.stringify(cnt.body));
  await reauth(api, s.owner);
  const close = await api.call('POST', `/api/v1/cash/periods/${pid}/close`, { token: s.owner, body: { acceptedCountId: cnt.body.count.id, handoverMillimes: 50_000 } });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  ev = (await review(s.owner)).body.paymentEvidence.byLevel;
  assert.deepEqual(ev.CASH_IN_COUNTED_PERIOD, { count: 2, totalMillimes: 110_000, activeMillimes: 50_000 });
  assert.equal(ev.RECORDED_ONLY, undefined);
  assert.match((await review(s.owner)).body.paymentEvidence.levels.CASH_IN_COUNTED_PERIOD, /not proof of this payment/);
});

test('T-OWN-2b a payment re-entered from a numbered paper slip is PAPER_SLIP_RECORD, never upgraded by a later count', async () => {
  const s = await day1();
  const book = await api.call('POST', '/api/v1/paper-books', { token: s.owner, body: { firstNo: 1, lastNo: 5, custodianStaffId: s.clinic.staff.dentist } });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  const v = await newVisit(api, s.desk, s.patientId, '2026-10-28T16:00:00Z');
  await confirmCare(api, s.dentist, v, 25_000, 'PAPER');
  const slips = await api.call('POST', `/api/v1/paper-books/${book.body.book.id}/entries`, { token: s.desk, body: { slips: [{ slipNo: 1, kind: 'USED', amountMillimes: 25_000, tender: 'CASH', visitId: v, writtenOn: day(0) }] } });
  assert.equal(slips.body.summary.posted, 1, JSON.stringify(slips.body));
  const pid = (await api.call('GET', '/api/v1/cash/periods/current', { token: s.owner })).body.period.id;
  const cnt = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: s.dentist, body: { countedMillimes: 75_000 } });
  await reauth(api, s.owner);
  assert.equal((await api.call('POST', `/api/v1/cash/periods/${pid}/close`, { token: s.owner, body: { acceptedCountId: cnt.body.count.id, handoverMillimes: 0 } })).status, 200);
  const ev = (await review(s.owner)).body.paymentEvidence.byLevel;
  assert.deepEqual(ev.PAPER_SLIP_RECORD, { count: 1, totalMillimes: 25_000, activeMillimes: 25_000 });
  assert.equal(ev.CASH_IN_COUNTED_PERIOD.count, 2, 'only the two desk cash payments');
});

test('T-OWN-3 a closed period with a count difference is reported as a number, neutrally', async () => {
  const s = await day1();
  const pid = (await api.call('GET', '/api/v1/cash/periods/current', { token: s.owner })).body.period.id;
  const c1 = await api.call('POST', `/api/v1/cash/periods/${pid}/counts`, { token: s.dentist, body: { countedMillimes: 45_000 } });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  await reauth(api, s.owner);
  const close = await api.call('POST', `/api/v1/cash/periods/${pid}/close`, { token: s.owner, body: { acceptedCountId: c1.body.count.id, handoverMillimes: 45_000, note: 'Écart fictif accepté' } });
  assert.equal(close.status, 200, JSON.stringify(close.body));
  const cp = (await review(s.owner)).body.cashPeriods;
  assert.equal(cp.discrepancies, 1);
  assert.equal(cp.closed[0].differenceMillimes, -5_000);
  assert.equal(cp.closed[0].attempts, 1);
  assert.ok(cp.open, 'the next period is open');
});

test('T-OWN-4 tenant isolation: clinic B owner sees none of clinic A decisions', async () => {
  await day1();
  const other = await standardFixture(api, db, `b11-${++n}`);
  await reauth(api, other.owner);
  const b = (await review(other.owner)).body;
  assert.equal(b.reductions.items.length, 0); assert.equal(b.returns.items.length, 0);
  assert.equal(b.feeCorrections.count, 0); assert.equal(b.freeCare.count, 0); assert.equal(b.zeroedVisits.count, 0);
  assert.deepEqual(b.paymentEvidence.byLevel, {}); assert.deepEqual(b.byAuthorizer, {});
});

test('T-OWN-5 window validation: malformed, impossible, reversed and >92-day windows are rejected; the window filters', async () => {
  const s = await day1();
  for (const [from, to] of [['2026-1-01', '2026-01-02'], ['2026-02-31', '2026-03-01'], ['2026-10-10', '2026-10-01'], ['2026-01-01', '2026-04-03']]) {
    const r = await review(s.owner, from, to);
    assert.equal(r.status, 400, `${from}..${to}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await review(s.owner, '2026-01-01', '2026-04-02')).status, 200, '92 days is allowed');
  const past = (await review(s.owner, day(-30), day(-10))).body;
  assert.equal(past.reductions.items.length + past.returns.items.length + past.feeCorrections.count + past.freeCare.count, 0);
});

test('T-OWN-6 no free text leaves the endpoint: reason notes and correction reasons appear only as flags', async () => {
  const s = await day1();
  const r = await review(s.owner);
  const raw = JSON.stringify(r.body);
  for (const secret of ['Note privée fictive', 'ملاحظة', 'Texte libre fictif', 'acte non réalisé', 'tarif révisé']) assert.ok(!raw.includes(secret), `free text leaked: ${secret}`);
  assert.ok(!/"reasonNote"|"reason"\s*:/.test(raw));
  const wo = r.body.reductions.items.find((x: { kind: string }) => x.kind === 'WRITE_OFF');
  assert.equal(wo.hasNote, true);
  assert.equal(r.body.reductions.items.find((x: { kind: string }) => x.kind === 'DISCOUNT').hasNote, false);
  assert.ok(r.body.feeCorrections.items.every((c: { hasReason: boolean }) => c.hasReason === true));
});

test('T-OWN-7 wording is neutral: no accusatory vocabulary anywhere in the response', async () => {
  const s = await day1();
  const raw = JSON.stringify((await review(s.owner)).body).toLowerCase();
  for (const w of ['suspicious', 'suspect', 'fraud', 'theft', 'steal', 'stolen', 'vol ', 'سرقة']) assert.ok(!raw.includes(w), `wording contains "${w}"`);
  assert.match(raw, /accuses no one/);
});

test('T-OWN-8 unresolved integrity findings are counted (receipt row deleted around the app) without naming a person', async () => {
  const s = await day1();
  assert.equal((await review(s.owner)).body.unresolved.integrityFindings, 0);
  const a = await adminConn(db.name);
  try {
    await a.query('BEGIN'); await a.query('SET LOCAL session_replication_role = replica');
    await a.query("DELETE FROM receipts WHERE clinic_id = $1 AND payment_id = (SELECT id FROM payments WHERE clinic_id = $1 AND tender = 'CARD')", [s.clinic.id] as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
  const u = (await review(s.owner)).body.unresolved;
  assert.ok(u.integrityFindings >= 1, JSON.stringify(u));
  assert.ok(u.checks.includes('PAYMENT_WITHOUT_RECEIPT'), JSON.stringify(u));
  assert.match(u.note, /not conclusions about any person/);
});

test('T-OWN-9 (integration R72) the window uses clinic-local days: a discount made "today" locally is in today\'s local window even when the UTC date differs', async () => {
  // Pick a timezone whose local date differs from the UTC date right now, so a UTC-sliced window would miss it.
  const tz = new Date().getUTCHours() >= 12 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
  const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  assert.notEqual(localToday, new Date().toISOString().slice(0, 10));
  const f = await standardFixture(api, db, `b11-${++n}`);
  const a = await adminConn(db.name);
  try { await a.query("UPDATE clinics SET settings = jsonb_set(settings, '{timezone}', to_jsonb($2::text)) WHERE id = $1", [f.clinic.id, tz] as never[]); } finally { a.end(); }
  await confirmCare(api, f.dentist, f.visitId, 50_000);
  assert.equal((await api.call('POST', `/api/v1/visits/${f.visitId}/adjustments`, { token: f.dentist, body: { kind: 'DISCOUNT', amountMillimes: 5_000, reasonCode: 'LOYALTY' } })).status, 201);
  await reauth(api, f.owner);
  const r = await api.call('GET', `/api/v1/owner/financial-review?from=${localToday}&to=${localToday}`, { token: f.owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.window.timezone, tz);
  assert.equal(r.body.reductions.totalMillimes, 5_000);
  const dflt = await api.call('GET', '/api/v1/owner/financial-review', { token: f.owner });
  assert.equal(dflt.body.window.to, localToday, 'default window ends on the clinic-local today');
});
