/*
 * B15 — printable FR/AR receipt and paper workflow contracts. Fictional data only. No fiscal or legal claim:
 * every document keeps the "not a fiscal document / requirements unverified" notice in both languages.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, confirmCare, newVisit, reauth, adminConn, type Api, type TestDb } from './helpers.ts';
import { formatAmount, formatLocal } from '../src/modules/print.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function paid(familyName = 'Fictif') {
  const f = await standardFixture(api, db, `b15-${++n}`);
  const p = await api.call('POST', '/api/v1/patients', { token: f.desk, body: { familyName, givenName: 'Amel', isSynthetic: true, confirmNotDuplicate: true } });
  const v = await newVisit(api, f.desk, p.body.patient.id, '2026-10-28T09:15:00Z');
  await confirmCare(api, f.dentist, v, 100_000);
  const pay = await api.call('POST', `/api/v1/visits/${v}/payments`, { token: f.desk, body: { amountMillimes: 70_000, tender: 'CASH' } });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  return { ...f, v, fileNo: p.body.patient.fileNo as number, payment: pay.body.payment as { id: string }, receipt: pay.body.receipt as { id: string; number: number; label: string } };
}
const print = (token: string, id: string, body: Record<string, unknown> = {}) => api.call('POST', `/api/v1/receipts/${id}/print`, { token, body });
const values = (doc: { sections: Array<{ lines: Array<{ key: string; value: string }> }> }, i = 0) => Object.fromEntries(doc.sections[i]!.lines.map(l => [l.key, l.value]));
async function counter(clinicId: string) {
  const a = await adminConn(db.name);
  try { return (await a.query<{ n: number }>("SELECT next_number AS n FROM receipt_counters WHERE clinic_id = $1 AND series = 'R'", [clinicId] as never[])).rows[0]!.n; } finally { a.end(); }
}

test('T-PRT-1 first print is the ORIGINAL, later prints are COPY 1, COPY 2; no receipt number is consumed; every print is logged', async () => {
  const s = await paid();
  const before = await counter(s.clinic.id);
  const p1 = await print(s.desk, s.receipt.id, { lang: 'fr' });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.copy, false);
  assert.equal(p1.body.document.sections[0].mark, 'ORIGINAL');
  assert.equal(values(p1.body.document).receiptNo, s.receipt.label);
  const p2 = await print(s.desk, s.receipt.id, { lang: 'fr' });
  const p3 = await print(s.owner, s.receipt.id, { lang: 'ar' });
  assert.equal(p2.body.document.sections[0].mark, 'COPIE 1');
  assert.equal(p3.body.document.sections[0].mark, 'نسخة 2');
  assert.equal(values(p3.body.document).receiptNo, s.receipt.label, 'same number on every copy');
  assert.equal(await counter(s.clinic.id), before);
  const a = await adminConn(db.name);
  try {
    const rows = (await a.query<{ is_copy: boolean }>('SELECT is_copy FROM receipt_prints WHERE receipt_id = $1 ORDER BY printed_at', [s.receipt.id] as never[])).rows;
    assert.deepEqual(rows.map(r => r.is_copy), [false, true, true]);
    const ev = (await a.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE action = 'receipt.printed' AND entity_id = $1", [s.receipt.id] as never[])).rows[0]!;
    assert.equal(ev.n, 3);
  } finally { a.end(); }
});

test('T-PRT-2 privacy: the receipt prints patient name and file number only, no internal ids, no staff-only evidence label, no care detail, no reason code', async () => {
  const s = await paid();
  const doc = (await print(s.desk, s.receipt.id, { lang: 'both' })).body.document;
  const raw = JSON.stringify(doc);
  assert.ok(raw.includes(String(s.fileNo)) && raw.includes('Fictif Amel'));
  for (const hidden of [s.v, s.payment.id, 'comptage indépendant', 'بعدّ مستقل', 'CHECKUP', 'Fictional checkup', 'visitId', 'evidence']) assert.ok(!raw.includes(hidden), `printed: ${hidden}`);
  // Refund: reason code and note never printed.
  await reauth(api, s.owner);
  const care = (await api.call('GET', `/api/v1/visits/${s.v}/care`, { token: s.owner })).body;
  const careId = care.items[0].id;
  assert.equal((await api.call('POST', `/api/v1/care-items/${careId}/corrections`, { token: s.dentist, body: { deltaMillimes: -50_000, reason: 'Fictif' } })).status, 201);
  const ref = await api.call('POST', `/api/v1/payments/${s.payment.id}/refund`, { token: s.owner, body: { amountMillimes: 20_000, reasonCode: 'FEE_CORRECTED', reasonNote: 'Note interne fictive' } });
  assert.equal(ref.status, 201, JSON.stringify(ref.body));
  const rdoc = JSON.stringify((await print(s.owner, ref.body.receipt.id, { lang: 'both' })).body.document);
  for (const hidden of ['FEE_CORRECTED', 'Note interne fictive', s.payment.id]) assert.ok(!rdoc.includes(hidden), `printed: ${hidden}`);
});

test('T-PRT-3 French / Arabic RTL / both: direction, titles, amounts, and bidi-isolated numbers in the HTML', async () => {
  const s = await paid();
  const fr = (await print(s.desk, s.receipt.id, { lang: 'fr', format: 'html' })).body;
  assert.equal(fr.document.sections.length, 1);
  assert.equal(fr.document.sections[0].dir, 'ltr');
  assert.equal(fr.document.sections[0].title, 'Reçu de paiement');
  assert.equal(values(fr.document).amount, '70,000 DT');
  assert.equal(values(fr.document).balance, '30,000 DT');
  const ar = (await print(s.desk, s.receipt.id, { lang: 'ar', format: 'html' })).body;
  assert.equal(ar.document.sections[0].dir, 'rtl');
  assert.equal(ar.document.sections[0].title, 'إيصال دفع');
  assert.equal(values(ar.document).amount, '70,000 د.ت');
  assert.match(ar.html, /<html lang="ar" dir="rtl">/);
  assert.ok(ar.html.includes(`<bdi dir="ltr">${s.receipt.label}</bdi>`), 'receipt number isolated from RTL reordering');
  assert.ok(ar.html.includes('<bdi dir="ltr">70,000 د.ت</bdi>'));
  const both = (await print(s.desk, s.receipt.id, { lang: 'both' })).body.document;
  assert.deepEqual(both.sections.map((x: { lang: string; dir: string }) => `${x.lang}:${x.dir}`), ['fr:ltr', 'ar:rtl']);
  assert.equal(values(both, 0).date, '28/10/2026 ' + (values(both, 0).date ?? '').slice(11), 'clinic-local date dd/mm/yyyy');
});

test('T-PRT-4 large print doubles as an accessibility option: 18 pt in the contract and the HTML', async () => {
  const s = await paid();
  const r = (await print(s.desk, s.receipt.id, { lang: 'ar', size: 'large', format: 'html' })).body;
  assert.equal(r.document.size, 'large'); assert.equal(r.document.fontPt, 18);
  assert.match(r.html, /font-size:18pt/);
  assert.equal((await print(s.desk, s.receipt.id, { size: 'huge' })).status, 400);
  assert.equal((await print(s.desk, s.receipt.id, { lang: 'en' })).status, 400);
});

test('T-PRT-5 void documents name the receipt they cancel; refund and void each keep their own number', async () => {
  const s = await paid();
  await reauth(api, s.owner);
  const v = await api.call('POST', `/api/v1/payments/${s.payment.id}/void`, { token: s.owner, body: { reasonCode: 'ENTERED_IN_ERROR' } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.notEqual(v.body.receipt.number, s.receipt.number);
  const doc = (await print(s.owner, v.body.receipt.id, { lang: 'fr' })).body.document;
  assert.equal(doc.documentType, 'RECEIPT_VOID');
  assert.equal(values(doc).voids, s.receipt.label);
  assert.equal(values(doc).receiptNo, v.body.receipt.label);
  assert.equal(doc.sections[0].lines.find((l: { key: string }) => l.key === 'amount').label, 'Montant annulé');
});

test('T-PRT-6 text is HTML-escaped (a name containing markup prints as text)', async () => {
  const s = await paid('<img src=x onerror=alert(1)>');
  const html = (await print(s.desk, s.receipt.id, { format: 'html' })).body.html as string;
  assert.ok(!html.includes('<img'), 'no live markup from data');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('T-PRT-7 every section keeps the fictional / not-a-fiscal-document notice in its language, and a fingerprint matching the stored snapshot hash', async () => {
  const s = await paid();
  const doc = (await print(s.desk, s.receipt.id, { lang: 'both' })).body.document;
  assert.match(doc.sections[0].notice, /PAS UN DOCUMENT FISCAL.*NON VÉRIFIÉES/);
  assert.match(doc.sections[1].notice, /ليست وثيقة جبائية/);
  const stored = (await api.call('GET', `/api/v1/receipts/${s.receipt.id}`, { token: s.desk })).body.receipt.snapshotSha256 as string;
  assert.equal(values(doc).fingerprint, stored.slice(0, 12));
});

test('T-PRT-8 permissions and tenancy: dentist cannot print receipts; another clinic\'s receipt is 404', async () => {
  const s = await paid();
  assert.equal((await print(s.dentist, s.receipt.id)).status, 403);
  const other = await paid();
  assert.equal((await print(other.desk, s.receipt.id)).status, 404);
});

test('T-PRT-9 no-phone intake form: FR/AR contract, no medical questions, and a filled fictional form posts to /patients unchanged', async () => {
  const s = await paid();
  const r = await api.call('GET', '/api/v1/print/forms/patient-intake?lang=both&size=large&format=html', { token: s.desk });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.document.sections.map((x: { dir: string }) => x.dir), ['ltr', 'rtl']);
  assert.equal(r.body.document.fontPt, 18);
  const fields = r.body.form.fields as Array<{ key: string; apiField?: string; required: boolean }>;
  const asked = JSON.stringify(fields).toLowerCase();
  for (const w of ['allerg', 'médic', 'maladie', 'traitement', 'حساسية', 'دواء', 'مرض', 'طبي']) assert.ok(!asked.includes(w), `medical question on intake: ${w}`);
  assert.match(r.body.form.intro.fr, /questions médicales sont posées par le dentiste/, 'the form says where medical questions belong');
  assert.equal(fields.find(f => f.key === 'phone')!.required, false, 'phone is optional');
  // Fill the paper form for an elderly patient without a phone and post it field by field.
  const filled: Record<string, unknown> = { familyName: 'Jlassi', givenName: 'Habiba', nameAr: 'حبيبة الجلاصي', dateOfBirth: '1941-03-02', sex: 'F', contactPreference: 'IN_PERSON', preferredLanguage: 'ar' };
  const body: Record<string, unknown> = { isSynthetic: true };
  for (const f of fields) if (f.apiField && filled[f.key] !== undefined) body[f.apiField] = filled[f.key];
  const created = await api.call('POST', '/api/v1/patients', { token: s.desk, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api.call('GET', '/api/v1/print/forms/patient-intake', { token: s.dentist })).status, 200);
});

test('T-PRT-10 numbered outage slips: owner prints the exact book range, a reprint is marked, desk cannot print, and the slip fields feed the re-entry API', async () => {
  const s = await paid();
  await reauth(api, s.owner);
  const book = await api.call('POST', '/api/v1/paper-books', { token: s.owner, body: { firstNo: 101, lastNo: 103, custodianStaffId: s.clinic.staff.dentist } });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  const id = book.body.book.id as string;
  const p1 = await api.call('POST', `/api/v1/paper-books/${id}/print`, { token: s.owner, body: { lang: 'both', format: 'html' } });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.deepEqual(p1.body.slips.map((d: { reference: string }) => d.reference), ['P-101', 'P-102', 'P-103']);
  assert.equal(p1.body.printNo, 1);
  assert.ok(!JSON.stringify(p1.body.slips).includes('RÉIMPRESSION'));
  assert.equal(values(p1.body.slips[1]).slipNo, 'P-102');
  assert.ok(p1.body.slips[0].sections[0].lines.some((l: { key: string }) => l.key === 'patientFileNo'), 'slip asks for the patient file number (CH-030)');
  assert.equal(p1.body.html.length, 3);
  const p2 = await api.call('POST', `/api/v1/paper-books/${id}/print`, { token: s.owner, body: { lang: 'fr' } });
  assert.equal(p2.body.printNo, 2);
  assert.ok(p2.body.slips[0].sections[0].lines.some((l: { label: string }) => /RÉIMPRESSION n° 2/.test(l.label)));
  assert.equal((await api.call('POST', `/api/v1/paper-books/${id}/print`, { token: s.desk, body: {} })).status, 403);
  // A slip filled from the contract fields re-enters through the existing API.
  const v2 = await newVisit(api, s.desk, s.patientId, '2026-10-28T11:00:00Z');
  await confirmCare(api, s.dentist, v2, 40_000);
  const fields = p1.body.form.fields as Array<{ key: string; apiField?: string }>;
  const filled: Record<string, unknown> = { slipNo: 101, writtenOn: '2026-10-28', patientFileNo: 1, amount: 40_000, tender: 'CASH' };
  const slip: Record<string, unknown> = { kind: 'USED', visitId: v2 };
  for (const f of fields) if (f.apiField && filled[f.key] !== undefined) slip[f.apiField] = filled[f.key];
  const e = await api.call('POST', `/api/v1/paper-books/${id}/entries`, { token: s.desk, body: { slips: [slip] } });
  assert.equal(e.body.results[0].outcome, 'POSTED', JSON.stringify(e.body));
});

test('T-PRT-11 integer-only money and clinic-local time formatting', () => {
  assert.equal(formatAmount(0, 'fr'), '0,000 DT');
  assert.equal(formatAmount(1, 'fr'), '0,001 DT');
  assert.equal(formatAmount(1_234_500, 'fr'), '1 234,500 DT');
  assert.equal(formatAmount(-20_000, 'ar'), '-20,000 د.ت');
  assert.equal(formatAmount(9_007_199_254_740_991, 'fr'), '9 007 199 254 740,991 DT', 'largest safe integer, exact');
  assert.equal(formatLocal('2026-10-28T23:30:00Z', 'Africa/Tunis'), '29/10/2026 00:30');
  assert.equal(formatLocal('2026-10-28T23:30:00Z', 'UTC'), '28/10/2026 23:30');
});

test('T-PRT-12 six concurrent first prints produce exactly one ORIGINAL and copies 1..5', async () => {
  const s = await paid();
  const rs = await Promise.all(Array.from({ length: 6 }, () => print(s.desk, s.receipt.id, { lang: 'fr' })));
  assert.ok(rs.every(r => r.status === 200), JSON.stringify(rs.map(r => r.status)));
  assert.deepEqual(rs.map(r => r.body.copyNo as number).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.equal(rs.filter(r => r.body.copy === false).length, 1);
});
