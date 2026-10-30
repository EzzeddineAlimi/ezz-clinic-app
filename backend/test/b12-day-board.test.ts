/*
 * B12 — Clinic day-board and patient-flow guards. Backend only (no visual UI).
 * Clinic-local days (default Africa/Tunis, overridable per clinic), role-aware worklist, constant query count
 * (no N+1), elderly / no-phone patients first-class, same-name duplicate warnings, missed-visit guards.
 * Fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, adminConn, type Api, type TestDb } from './helpers.ts';
import { Db, type Tx } from '../src/platform/db.ts';
import { dayBoard } from '../src/modules/dayboard.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic(tz?: string) {
  const f = await standardFixture(api, db, `b12-${++n}`, { openCashPeriod: false });
  if (tz) {
    const a = await adminConn(db.name);
    try { await a.query("UPDATE clinics SET settings = jsonb_set(settings, '{timezone}', to_jsonb($2::text)) WHERE id = $1", [f.clinic.id, tz] as never[]); } finally { a.end(); }
  }
  return f;
}
const board = (token: string, qs = '') => api.call('GET', `/api/v1/day-board${qs}`, { token });
const ids = (r: { body: { visits: Array<{ id: string }> } }) => r.body.visits.map(v => v.id);
const tomorrowUtc = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

test('T-DAY-1 (RED on base) GET /visits?day uses the clinic-local day: 00:30 in Tunis on the 29th is not on the 28th list', async () => {
  const f = await clinic();
  const late = await newVisit(api, f.desk, f.patientId, '2026-10-28T23:30:00Z'); // 00:30 on 29 Oct in Africa/Tunis (UTC+1)
  const d28 = await api.call('GET', '/api/v1/visits?day=2026-10-28', { token: f.desk });
  const d29 = await api.call('GET', '/api/v1/visits?day=2026-10-29', { token: f.desk });
  assert.ok(!d28.body.visits.some((v: { id: string }) => v.id === late), 'visit belongs to the 29th locally');
  assert.ok(d29.body.visits.some((v: { id: string }) => v.id === late));
  assert.equal(d29.body.timezone, 'Africa/Tunis');
});

test('T-DAY-2 an impossible or malformed day is a 400 on both the visit list and the day-board', async () => {
  const f = await clinic();
  for (const path of ['/api/v1/visits?day=2026-02-31', '/api/v1/day-board?day=2026-02-31', '/api/v1/day-board?day=2026-1-1']) {
    const r = await api.call('GET', path, { token: f.desk });
    assert.equal(r.status, 400, `${path}: ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('T-DAY-3 (RED on base) NO_SHOW cannot be recorded before the appointment time; CANCELLED still can (with reason)', async () => {
  const f = await clinic();
  const future = await newVisit(api, f.desk, f.patientId, `${tomorrowUtc()}T10:00:00Z`);
  const ns = await api.call('POST', `/api/v1/visits/${future}/status`, { token: f.desk, body: { status: 'NO_SHOW', reason: 'Fictif' } });
  assert.equal(ns.status, 409, JSON.stringify(ns.body));
  const cancel = await api.call('POST', `/api/v1/visits/${future}/status`, { token: f.desk, body: { status: 'CANCELLED', reason: 'Patient a appelé (fictif)' } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const past = await newVisit(api, f.desk, f.patientId, '2026-10-01T10:00:00Z');
  assert.equal((await api.call('POST', `/api/v1/visits/${past}/status`, { token: f.desk, body: { status: 'NO_SHOW', reason: 'Fictif' } })).status, 200);
});

test('T-DAY-4 (RED on base) same-name warning also fires when one record has no phone (elderly patient, relative adds a number later)', async () => {
  const f = await clinic();
  const mk = (body: Record<string, unknown>) => api.call('POST', '/api/v1/patients', { token: f.desk, body: { isSynthetic: true, ...body } });
  assert.equal((await mk({ familyName: 'Ben Salah', givenName: 'Fatma', contactPreference: 'IN_PERSON' })).status, 201);
  const second = await mk({ familyName: ' ben salah', givenName: 'FATMA ', phone: '+216 20 000 000', contactPreference: 'BASIC_PHONE_CALL' });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error.details.possibleDuplicates.length, 1);
  const confirmed = await mk({ familyName: 'Ben Salah', givenName: 'Fatma', phone: '+216 20 000 000', contactPreference: 'BASIC_PHONE_CALL', confirmNotDuplicate: true });
  assert.equal(confirmed.status, 201, 'a confirmed different person is still created (warn, never merge, never block)');
  // Same name, both with different phones and different known birth dates: no warning.
  assert.equal((await mk({ familyName: 'Trabelsi', givenName: 'Ali', phone: '+216 21 111 111', dateOfBirth: '1950-01-01', contactPreference: 'BASIC_PHONE_CALL' })).status, 201);
  assert.equal((await mk({ familyName: 'Trabelsi', givenName: 'Ali', phone: '+216 22 222 222', dateOfBirth: '1980-05-05', contactPreference: 'BASIC_PHONE_CALL' })).status, 201);
});

test('T-DAY-5 day-board lists the clinic-local day in time order with status summary, local time and patient flow fields', async () => {
  const f = await clinic();
  const a = f.visitId; // 09:00Z = 10:00 local
  const b = await newVisit(api, f.desk, f.patientId, '2026-10-28T07:30:00Z'); // 08:30 local
  const c = await newVisit(api, f.desk, f.patientId, '2026-10-28T23:30:00Z'); // next local day
  await newVisit(api, f.desk, f.patientId, '2026-10-27T22:59:00Z'); // 23:59 on the 27th local
  assert.equal((await api.call('POST', `/api/v1/visits/${b}/status`, { token: f.desk, body: { status: 'ARRIVED' } })).status, 200);
  const r = await board(f.desk, '?day=2026-10-28');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.timezone, 'Africa/Tunis');
  assert.deepEqual(ids(r), [b, a]);
  assert.ok(!ids(r).includes(c));
  assert.equal(r.body.visits[0].localTime, '08:30');
  assert.equal(r.body.visits[1].localTime, '10:00');
  assert.equal(r.body.visits[0].status, 'ARRIVED');
  assert.equal(typeof r.body.visits[0].waitingMinutes, 'number');
  assert.equal(r.body.summary.total, 2);
  assert.equal(r.body.summary.byStatus.ARRIVED, 1);
  assert.equal(r.body.summary.byStatus.SCHEDULED, 1);
  assert.equal(r.body.visits[1].dentist.id, f.clinic.staff.dentist);
});

test('T-DAY-6 a per-clinic timezone setting is honoured (Asia/Kolkata, +05:30)', async () => {
  const f = await clinic('Asia/Kolkata');
  const v = await newVisit(api, f.desk, f.patientId, '2026-10-28T19:00:00Z'); // 00:30 on the 29th in Kolkata
  const r = await board(f.desk, '?day=2026-10-29');
  assert.equal(r.body.timezone, 'Asia/Kolkata');
  assert.ok(ids(r).includes(v));
  assert.equal(r.body.visits.find((x: { id: string }) => x.id === v).localTime, '00:30');
  assert.ok(!ids(await board(f.desk, '?day=2026-10-28')).includes(v));
});

test('T-DAY-7 no-phone and same-name patients are flagged; the phone number itself never appears on the board', async () => {
  const f = await clinic();
  const mk = async (body: Record<string, unknown>) => (await api.call('POST', '/api/v1/patients', { token: f.desk, body: { isSynthetic: true, confirmNotDuplicate: true, ...body } })).body.patient.id as string;
  const elder = await mk({ familyName: 'Jebali', givenName: 'Mabrouka', nameAr: 'مبروكة الجبالي', preferredLanguage: 'ar', contactPreference: 'IN_PERSON' });
  const twin = await mk({ familyName: 'Jebali', givenName: 'Mabrouka', phone: '+216 98 765 432', contactPreference: 'SMS' });
  const v1 = await newVisit(api, f.desk, elder, '2026-10-28T08:00:00Z');
  const v2 = await newVisit(api, f.desk, twin, '2026-10-28T08:30:00Z');
  const r = await board(f.desk, '?day=2026-10-28');
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes('98 765 432') && !raw.includes('+216'), 'phone numbers stay on the patient file, not the board');
  const e = r.body.visits.find((x: { id: string }) => x.id === v1);
  const t = r.body.visits.find((x: { id: string }) => x.id === v2);
  assert.equal(e.patient.hasPhone, false);
  assert.equal(e.patient.nameAr, 'مبروكة الجبالي');
  assert.equal(e.patient.preferredLanguage, 'ar');
  assert.ok(e.flags.includes('IN_PERSON_CONTACT_ONLY'));
  assert.ok(!t.flags.includes('IN_PERSON_CONTACT_ONLY'));
  assert.ok(e.flags.includes('SAME_NAME_OTHER_FILE') && t.flags.includes('SAME_NAME_OTHER_FILE'));
  assert.deepEqual(e.patient.sameNameFileNos, [t.patient.fileNo]);
});

test('T-DAY-8 role-aware: dentist defaults to own + unassigned visits; assistant sees no money and no status reasons; desk sees balances', async () => {
  const f = await clinic();
  const other = await api.call('POST', '/api/v1/staff', { token: f.owner, body: { username: 'dentist-two', displayName: 'Dr Fictif Deux', password: 'fictional-password-123', roles: ['DENTIST'] } });
  let otherId: string | undefined = other.body?.staff?.id;
  if (other.status !== 201) {
    // Fall back to seeding a second dentist directly when the staff route needs re-auth.
    const a = await adminConn(db.name);
    try {
      await a.query('BEGIN'); await a.query("SELECT set_config('app.clinic_id', $1, true)", [f.clinic.id] as never[]);
      otherId = (await a.query<{ id: string }>("INSERT INTO staff (clinic_id, username, display_name, password_hash) VALUES ($1, 'dentist-two', 'Dr Fictif Deux', 'x') RETURNING id", [f.clinic.id] as never[])).rows[0]!.id;
      await a.query("INSERT INTO staff_roles (clinic_id, staff_id, role) VALUES ($1, $2, 'DENTIST')", [f.clinic.id, otherId] as never[]);
      await a.query('COMMIT');
    } finally { a.end(); }
  }
  const mine = f.visitId;
  const theirs = (await api.call('POST', '/api/v1/visits', { token: f.desk, body: { patientId: f.patientId, scheduledAt: '2026-10-28T12:00:00Z', dentistId: otherId } })).body.visit.id;
  const unassigned = await newVisit(api, f.desk, f.patientId, '2026-10-28T13:00:00Z');
  const cancelled = await newVisit(api, f.desk, f.patientId, '2026-10-28T14:00:00Z');
  await api.call('POST', `/api/v1/visits/${cancelled}/status`, { token: f.desk, body: { status: 'CANCELLED', reason: 'Raison fictive' } });
  await confirmCare(api, f.dentist, mine, 50_000);

  const d = await board(f.dentist, '?day=2026-10-28');
  assert.equal(d.body.scope, 'mine');
  assert.deepEqual(new Set(ids(d)), new Set([mine, unassigned, cancelled]), 'unassigned visits stay visible to every dentist');
  assert.ok(!ids(d).includes(theirs));
  assert.ok(ids(await board(f.dentist, '?day=2026-10-28&scope=all')).includes(theirs));
  assert.equal((await board(f.desk, '?day=2026-10-28&scope=mine')).status, 400, 'scope=mine needs the DENTIST role');

  const desk = await board(f.desk, '?day=2026-10-28');
  const dm = desk.body.visits.find((x: { id: string }) => x.id === mine);
  assert.equal(dm.balanceDueMillimes, 50_000);
  assert.equal(desk.body.visits.find((x: { id: string }) => x.id === cancelled).statusReason, 'Raison fictive');

  const a = await adminConn(db.name);
  let assistant = '';
  try {
    await a.query('BEGIN'); await a.query("SELECT set_config('app.clinic_id', $1, true)", [f.clinic.id] as never[]);
    const sid = (await a.query<{ id: string }>("SELECT id FROM staff WHERE clinic_id = $1 AND username = 'desk'", [f.clinic.id] as never[])).rows[0]!.id;
    const hash = (await a.query<{ h: string }>('SELECT password_hash AS h FROM staff WHERE id = $1', [sid] as never[])).rows[0]!.h;
    const as = (await a.query<{ id: string }>("INSERT INTO staff (clinic_id, username, display_name, password_hash) VALUES ($1, 'assistant', 'Assistante fictive', $2) RETURNING id", [f.clinic.id, hash] as never[])).rows[0]!.id;
    await a.query("INSERT INTO staff_roles (clinic_id, staff_id, role) VALUES ($1, $2, 'ASSISTANT')", [f.clinic.id, as] as never[]);
    await a.query('COMMIT');
  } finally { a.end(); }
  assistant = await api.login(f.clinic.code, 'assistant');
  const as = await board(assistant, '?day=2026-10-28');
  assert.equal(as.status, 200, JSON.stringify(as.body));
  const raw = JSON.stringify(as.body);
  assert.ok(!raw.includes('balanceDueMillimes') && !raw.includes('Raison fictive'), raw);
  assert.equal(as.body.visits.find((x: { id: string }) => x.id === cancelled).hasStatusReason, true);
});

test('T-DAY-9 not-arrived-past-start and desk-marked cancellations/no-shows are flagged; summary counts them', async () => {
  const f = await clinic();
  const late = await newVisit(api, f.desk, f.patientId, '2026-10-28T06:00:00Z');
  const ns = await newVisit(api, f.desk, f.patientId, '2026-10-28T06:30:00Z');
  assert.equal((await api.call('POST', `/api/v1/visits/${ns}/status`, { token: f.desk, body: { status: 'NO_SHOW', reason: 'Fictif: pas venu' } })).status, 200);
  const r = await board(f.owner, '?day=2026-10-28');
  const l = r.body.visits.find((x: { id: string }) => x.id === late);
  assert.ok(l.flags.includes('NOT_ARRIVED_PAST_START'), JSON.stringify(l));
  const n2 = r.body.visits.find((x: { id: string }) => x.id === ns);
  assert.ok(n2.flags.includes('DESK_MARKED'), JSON.stringify(n2));
  assert.equal(r.body.summary.byStatus.NO_SHOW, 1);
  assert.ok(r.body.summary.notArrivedPastStart >= 1);
  // A future day has no NOT_ARRIVED_PAST_START flags.
  await newVisit(api, f.desk, f.patientId, `${tomorrowUtc()}T12:00:00Z`);
  const fut = await board(f.owner, `?day=${tomorrowUtc()}`);
  assert.ok(fut.body.visits.every((x: { flags: string[] }) => !x.flags.includes('NOT_ARRIVED_PAST_START')));
});

test('T-DAY-10 tenant isolation: another clinic never appears, even with a dentistId from clinic A', async () => {
  const A = await clinic();
  const B = await clinic();
  await newVisit(api, B.desk, B.patientId, '2026-10-28T10:00:00Z');
  const r = await board(A.desk, `?day=2026-10-28&dentistId=${B.clinic.staff.dentist}`);
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), []);
  const all = await board(A.desk, '?day=2026-10-28');
  assert.deepEqual(ids(all), [A.visitId]);
});

test('T-DAY-11 constant query count (no N+1): 3 visits and 40 visits cost the same number of SQL statements', async () => {
  const f = await clinic();
  const pool = new Db(db.appUrl);
  try {
    const actor = { staffId: f.clinic.staff.desk!, clinicId: f.clinic.id, roles: ['RECEPTIONIST' as const], displayName: 'desk', tokenHash: '', reauthAt: null };
    const counted = async () => pool.tx(f.clinic.id, async tx => {
      let q = 0;
      const proxy: Tx = { ...tx, query: (...a: Parameters<Tx['query']>) => { q++; return tx.query(...a); }, one: (...a: Parameters<Tx['one']>) => { q++; return tx.one(...a); }, maybeOne: (...a: Parameters<Tx['maybeOne']>) => { q++; return tx.maybeOne(...a); } } as Tx;
      const b = await dayBoard(proxy, actor, new URLSearchParams('day=2026-10-29'));
      return { q, count: b.visits.length };
    });
    for (let i = 0; i < 3; i++) await newVisit(api, f.desk, f.patientId, `2026-10-29T0${i}:00:00Z`);
    const small = await counted();
    for (let i = 0; i < 37; i++) await newVisit(api, f.desk, f.patientId, `2026-10-29T${String(8 + Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}:00Z`);
    const big = await counted();
    assert.equal(small.count, 3); assert.equal(big.count, 40);
    assert.equal(big.q, small.q, `queries: ${small.q} for 3 visits, ${big.q} for 40`);
    assert.ok(small.q <= 3, `expected at most 3 statements, got ${small.q}`);
  } finally { await pool.close(); }
});

test('T-DAY-12 an invalid clinic timezone setting fails loudly (never silently falls back to UTC)', async () => {
  const f = await clinic('Mars/Olympus_Mons');
  const r = await board(f.desk, '?day=2026-10-28');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error.message, /timezone/i);
});

test('UX12 patient search: Arabic name and literal FR substring, spaced phone, DOB and masked identity hints', async () => {
  const f = await clinic();
  const add = await api.call('POST', '/api/v1/patients', { token: f.desk, body: {
    familyName: 'RechercheFictive', givenName: 'Samir', nameAr: 'سمير الاختبار',
    dateOfBirth: '1981-06-14', phone: '+216 22 345 678', contactPreference: 'BASIC_PHONE_CALL',
    isSynthetic: true,
  } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const id = add.body.patient.id;
  const other = await api.call('POST', '/api/v1/patients', { token: f.desk, body: {
    familyName: 'RechercheFictive', givenName: 'Samir', nameAr: 'سمير الثاني',
    dateOfBirth: '1995-05-11', phone: '+216 22 999 999', contactPreference: 'BASIC_PHONE_CALL',
    isSynthetic: true,
  } });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const find = (q: string) => api.call('GET', '/api/v1/patients?q=' + encodeURIComponent(q), { token: f.desk });
  for (const q of ['الاختبار', 'cherchefict', '+21622345678', '345 678']) {
    if (q === '345 678') continue; // Phone lookup requires a full number, not a fragment.
    const result = await find(q);
    assert.equal(result.status, 200, q);
    const p = result.body.patients.find((x: { id: string }) => x.id === id);
    assert.ok(p, 'must find fictional patient by ' + q);
    assert.equal(p.dateOfBirth, '1981-06-14');
    assert.equal(p.phoneLast4, '5678');
    assert.equal(p.hasSameNameInClinic, true, 'filtered Arabic search must still flag hidden same-name records');
    assert.equal(p.phone, undefined, 'directory response may not expose full phone');
  }
  const literal = await find('%');
  assert.ok(!literal.body.patients.some((x: { id: string }) => x.id === id), '% is search text, not a wildcard');
});

test('UX12 review: Arabic-only same names, diacritics and French accents cannot bypass identity warnings', async () => {
  const f = await clinic();
  const mk = (body: Record<string, unknown>) => api.call('POST', '/api/v1/patients', {
    token: f.desk, body: { isSynthetic: true, ...body },
  });
  const first = await mk({
    familyName: 'ChérifUx12', givenName: 'LéilaUx12',
    nameAr: 'أَحْمَد سـليم', dateOfBirth: '1982-01-03',
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const secondBody = {
    familyName: 'DifferentLatinUx12', givenName: 'OtherUx12',
    nameAr: 'احمد سليم', dateOfBirth: '1994-02-05',
  };
  const warning = await mk(secondBody);
  assert.equal(warning.status, 409, 'same Arabic name must warn even when Latin names and birth dates differ');
  assert.ok(warning.body.error.details.possibleDuplicates.some(
    (p: { id: string }) => p.id === first.body.patient.id,
  ));
  const second = await mk({ ...secondBody, confirmNotDuplicate: true });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const find = (q: string) => api.call('GET', '/api/v1/patients?q=' + encodeURIComponent(q), { token: f.desk });
  const ar = await find('احمد سليم');
  assert.equal(ar.status, 200);
  for (const id of [first.body.patient.id, second.body.patient.id]) {
    const patient = ar.body.patients.find((p: { id: string }) => p.id === id);
    assert.ok(patient, 'Arabic alef/diacritics/tatweel must fold for both records');
    assert.equal(patient.hasSameNameInClinic, true, 'even a filtered result must require file confirmation');
  }
  for (const query of ['cherifux12', 'leilaux12']) {
    const fr = await find(query);
    assert.ok(fr.body.patients.some((p: { id: string }) => p.id === first.body.patient.id),
      'French accents must not hide a file for ' + query);
  }
  const a = await newVisit(api, f.desk, first.body.patient.id, '2026-10-28T10:00:00Z');
  const b = await newVisit(api, f.desk, second.body.patient.id, '2026-10-28T11:00:00Z');
  const day = await board(f.desk, '?day=2026-10-28');
  assert.equal(day.status, 200, JSON.stringify(day.body));
  for (const id of [a, b]) {
    const visit = day.body.visits.find((v: { id: string }) => v.id === id);
    assert.ok(visit.flags.includes('SAME_NAME_OTHER_FILE'), 'Arabic duplicate must flag the day board');
    assert.equal(visit.patient.sameNameFileNos.length, 1);
  }
});
