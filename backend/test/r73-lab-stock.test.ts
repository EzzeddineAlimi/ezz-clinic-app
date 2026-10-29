/*
 * R73 package E — dental lab cases (MF19 tie-in) and basic stock control. Real PostgreSQL; fictional data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, seedClinic, STANDARD_STAFF, confirmCare, newVisit, adminConn, type Api, type TestDb } from './helpers.ts';

let db: TestDb; let api: Api;
before(async () => { db = await createTestDb(); api = await startApi(db.appUrl); });
after(async () => { await api.close(); await db.drop(); });

let n = 0;
async function clinic() {
  const code = `lab-${++n}-${Date.now() % 100000}`;
  const c = await seedClinic(db, code, [...STANDARD_STAFF, { username: 'assistant', roles: ['ASSISTANT'] }]);
  const [owner, dentist, desk, assistant] = await Promise.all(['owner', 'dentist', 'desk', 'assistant'].map(u => api.login(code, u)));
  const p = await api.call('POST', '/api/v1/patients', { token: desk, body: { familyName: 'Fictif', givenName: 'Lina', isSynthetic: true } });
  const visitId = await newVisit(api, desk!, p.body.patient.id, '2026-10-20T09:00:00Z');
  const sup = await api.call('POST', '/api/v1/lab/suppliers', { token: owner, body: { name: 'Laboratoire Fictif Sfax', contact: 'fictional contact' } });
  assert.equal(sup.status, 201, JSON.stringify(sup.body));
  return { clinic: c, owner: owner!, dentist: dentist!, desk: desk!, assistant: assistant!, patientId: p.body.patient.id as string, visitId, supplierId: sup.body.supplier.id as string };
}
type C = Awaited<ReturnType<typeof clinic>>;
const newCase = (s: C, token: string, extra: Record<string, unknown> = {}) => api.call('POST', `/api/v1/patients/${s.patientId}/lab-cases`, { token, body: {
  supplierId: s.supplierId, caseType: 'CROWN', teeth: [36], material: 'Fictional zirconia', shade: 'VITA classical A2', impression: 'DIGITAL_SCAN',
  instructions: 'Fictional instructions', dueOn: '2026-11-10', visitId: s.visitId, ...extra } });
const status = (token: string, id: string, to: string, reason?: string) => api.call('POST', `/api/v1/lab-cases/${id}/status`, { token, body: { status: to, ...(reason ? { reason } : {}) } });
const plusDays = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
async function exceptions(owner: string, asOf: string) {
  const r = await api.call('GET', `/api/v1/owner/exceptions?asOf=${asOf}`, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.open as Array<{ kind: string; refs?: Record<string, string>; known: string }>;
}

test('T-LAB-1 lifecycle: assistant creates and tracks logistics, try-in round trip, dentist fits; invalid jumps refused; history kept', async () => {
  const s = await clinic();
  const c = await newCase(s, s.assistant);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.labCase.id as string;
  assert.equal(c.body.labCase.status, 'CREATED');
  assert.equal(c.body.labCase.createdRole, 'ASSISTANT');
  assert.equal((await status(s.assistant, id, 'RECEIVED')).status, 409, 'CREATED cannot jump to RECEIVED');
  for (const to of ['SENT', 'TRY_IN_RETURNED', 'RESENT', 'RECEIVED']) assert.equal((await status(s.assistant, id, to)).status, 200, to);
  assert.equal((await status(s.assistant, id, 'FITTED')).status, 403, 'fitting is recorded by a dentist');
  const fit = await status(s.dentist, id, 'FITTED');
  assert.equal(fit.body.labCase.status, 'FITTED');
  assert.deepEqual(fit.body.labCase.allowedNext, []);
  assert.equal((await status(s.dentist, id, 'CANCELLED', 'too late')).status, 409, 'FITTED is final');
  const h = await api.call('GET', `/api/v1/lab-cases/${id}`, { token: s.dentist });
  assert.deepEqual(h.body.history.map((e: { status: string; byRole: string }) => `${e.status}:${e.byRole}`),
    ['SENT:ASSISTANT', 'TRY_IN_RETURNED:ASSISTANT', 'RESENT:ASSISTANT', 'RECEIVED:ASSISTANT', 'FITTED:DENTIST']);
  assert.equal((await status(s.dentist, id, 'SENT')).status, 409);
});

test('T-LAB-2 authorization: desk sees a status board without clinical detail and cannot create or track; owner has no case access', async () => {
  const s = await clinic();
  const id = (await newCase(s, s.dentist)).body.labCase.id as string;
  for (const t of [s.desk, s.owner]) {
    assert.equal((await newCase(s, t)).status, 403);
    assert.equal((await api.call('GET', `/api/v1/lab-cases/${id}`, { token: t })).status, 403);
    assert.equal((await status(t, id, 'SENT')).status, 403);
  }
  const board = await api.call('GET', '/api/v1/lab/board', { token: s.desk });
  assert.equal(board.status, 200);
  assert.equal(board.body.cases.length, 1);
  const raw = JSON.stringify(board.body);
  for (const secret of ['zirconia', 'A2', 'Fictional instructions', '"teeth"']) assert.ok(!raw.includes(secret), `desk board leaks ${secret}`);
  assert.equal(board.body.cases[0].status, 'CREATED');
  assert.equal((await api.call('GET', '/api/v1/lab/board', { token: s.owner })).status, 403);
  assert.equal((await api.call('POST', '/api/v1/lab/invoices', { token: s.dentist, body: {} })).status, 403, 'invoices are owner entries');
});

test('T-LAB-3 cancellation and remake need a dentist and a reason; a remake is a new linked case with the responsible party', async () => {
  const s = await clinic();
  const a = (await newCase(s, s.dentist)).body.labCase.id as string;
  assert.equal((await status(s.dentist, a, 'CANCELLED')).status, 400, 'reason required');
  assert.equal((await status(s.assistant, a, 'CANCELLED', 'Fictional cancellation')).status, 403);
  assert.equal((await status(s.dentist, a, 'CANCELLED', 'Fictional cancellation')).body.labCase.status, 'CANCELLED');
  const b = (await newCase(s, s.dentist)).body.labCase.id as string;
  assert.equal((await api.call('POST', `/api/v1/lab-cases/${b}/remake`, { token: s.dentist, body: { reason: 'Fictional misfit', responsibility: 'LAB' } })).status, 409, 'only RECEIVED work is remade');
  await status(s.dentist, b, 'SENT'); await status(s.dentist, b, 'RECEIVED');
  assert.equal((await api.call('POST', `/api/v1/lab-cases/${b}/remake`, { token: s.assistant, body: { reason: 'Fictional misfit', responsibility: 'LAB' } })).status, 403);
  const r = await api.call('POST', `/api/v1/lab-cases/${b}/remake`, { token: s.dentist, body: { reason: 'Fictional misfit', responsibility: 'LAB', dueOn: '2026-11-20' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.original.status, 'REMAKE_REQUESTED');
  assert.equal(r.body.remake.status, 'CREATED');
  assert.equal(r.body.remake.remakeOfId, b);
  assert.equal(r.body.remake.remakeResponsibility, 'LAB');
  assert.deepEqual(r.body.remake.teeth, [36]);
  assert.deepEqual((await api.call('GET', `/api/v1/lab-cases/${b}`, { token: s.dentist })).body.remakes, [r.body.remake.id]);
});

test('T-LAB-4 MF19: received lab work without a linked billed care item appears after labUnbilledDays; linking the care item clears it', async () => {
  const s = await clinic();
  const id = (await newCase(s, s.dentist)).body.labCase.id as string;
  await status(s.dentist, id, 'SENT'); await status(s.dentist, id, 'RECEIVED');
  const kinds = async (asOf: string) => (await exceptions(s.owner, asOf)).filter(e => e.kind === 'LAB_WORK_NOT_BILLED');
  assert.deepEqual(await kinds(plusDays(10)), [], 'not yet: inside the default 30 days');
  const late = await kinds(plusDays(40));
  assert.equal(late.length, 1);
  assert.equal(late[0]!.refs!.labCaseId, id);
  assert.ok(!late[0]!.known.includes('zirconia'), 'no clinical detail on the owner list');
  // A care item of ANOTHER patient cannot be linked.
  const p2 = await api.call('POST', '/api/v1/patients', { token: s.desk, body: { familyName: 'Fictif', givenName: 'Other', isSynthetic: true } });
  const otherCare = await confirmCare(api, s.dentist, await newVisit(api, s.desk, p2.body.patient.id, '2026-10-21T09:00:00Z'), 50_000, 'CROWN');
  assert.equal((await api.call('POST', `/api/v1/lab-cases/${id}/care-links`, { token: s.dentist, body: { careItemId: otherCare } })).status, 400);
  const care = await confirmCare(api, s.dentist, s.visitId, 450_000, 'CROWN');
  assert.equal((await api.call('POST', `/api/v1/lab-cases/${id}/care-links`, { token: s.assistant, body: { careItemId: care } })).status, 403, 'linking billing is a dentist act');
  assert.equal((await api.call('POST', `/api/v1/lab-cases/${id}/care-links`, { token: s.dentist, body: { careItemId: care } })).status, 201);
  assert.equal((await api.call('POST', `/api/v1/lab-cases/${id}/care-links`, { token: s.dentist, body: { careItemId: care } })).status, 409);
  assert.deepEqual(await kinds(plusDays(40)), []);
  // The threshold is the clinic setting (owner, audited).
  const id2 = (await newCase(s, s.dentist)).body.labCase.id as string;
  await status(s.dentist, id2, 'SENT'); await status(s.dentist, id2, 'RECEIVED');
  const set = await api.call('POST', '/api/v1/clinic/settings', { token: s.owner, body: { changes: { labUnbilledDays: 7 }, reason: 'Fictional stricter follow-up' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await kinds(plusDays(10))).length, 1);
});

test('T-LAB-5 lab invoices: owner-only clinic expense, cases must belong to the supplier, unique per supplier, MF19 invoice item', async () => {
  const s = await clinic();
  const id = (await newCase(s, s.dentist)).body.labCase.id as string;
  const other = await api.call('POST', '/api/v1/lab/suppliers', { token: s.dentist, body: { name: 'Autre Labo Fictif' } });
  const body = { supplierId: s.supplierId, invoiceNumber: 'F-2026-001', invoiceDate: plusDays(-60), amountMillimes: 120_000, caseIds: [id] };
  assert.equal((await api.call('POST', '/api/v1/lab/invoices', { token: s.owner, body: { ...body, supplierId: other.body.supplier.id } })).status, 400, 'case sent to another lab');
  assert.equal((await api.call('POST', '/api/v1/lab/invoices', { token: s.owner, body: { ...body, amountMillimes: 12.5 } })).status, 400, 'integer millimes only');
  const r = await api.call('POST', '/api/v1/lab/invoices', { token: s.owner, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.invoice.kind, 'CLINIC_EXPENSE');
  assert.equal((await api.call('POST', '/api/v1/lab/invoices', { token: s.owner, body })).status, 409, 'same supplier invoice number');
  const items = (await exceptions(s.owner, plusDays(0))).filter(e => e.kind === 'LAB_INVOICE_WITHOUT_BILLED_CARE');
  assert.equal(items.length, 1);
  const c = await adminConn(db.name);
  try { assert.equal((await c.query("SELECT count(*)::int AS n FROM payments WHERE clinic_id = $1", [s.clinic.id] as never[])).rows[0]!.n, 0, 'nothing reaches patient billing'); } finally { c.end(); }
});

test('T-LAB-6 isolation: another clinic cannot see, track, link or invoice a case; a visit of another patient cannot be attached', async () => {
  const a = await clinic(); const b = await clinic();
  const id = (await newCase(a, a.dentist)).body.labCase.id as string;
  assert.equal((await api.call('GET', `/api/v1/lab-cases/${id}`, { token: b.dentist })).status, 404);
  assert.equal((await status(b.dentist, id, 'SENT')).status, 404);
  assert.equal((await api.call('POST', '/api/v1/lab/invoices', { token: b.owner, body: { supplierId: b.supplierId, invoiceNumber: 'X1', invoiceDate: '2026-10-01', amountMillimes: 1000, caseIds: [id] } })).status, 404);
  assert.equal((await newCase(a, a.dentist, { supplierId: b.supplierId })).status, 400, 'supplier of another clinic');
  assert.equal((await api.call('GET', '/api/v1/lab/board', { token: b.desk })).body.cases.length, 0);
  const p2 = await api.call('POST', '/api/v1/patients', { token: a.desk, body: { familyName: 'Fictif', givenName: 'Y', isSynthetic: true } });
  const v2 = await newVisit(api, a.desk, p2.body.patient.id);
  assert.equal((await newCase(a, a.dentist, { visitId: v2 })).status, 400);
});

test('T-LAB-7 concurrency: six parallel status changes on one case record exactly one transition', async () => {
  const s = await clinic();
  const id = (await newCase(s, s.dentist)).body.labCase.id as string;
  const res = await Promise.all(Array.from({ length: 6 }, () => status(s.assistant, id, 'SENT')));
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409, 409, 409, 409, 409]);
});

test('T-STK-1 stock ledger: receipts and usage keep a running on-hand; never below zero; reorder flag; expiring received lots listed', async () => {
  const s = await clinic();
  assert.equal((await api.call('POST', '/api/v1/stock/items', { token: s.dentist, body: { name: 'Gants nitrile (fictifs)', unit: 'box' } })).status, 403);
  const it = await api.call('POST', '/api/v1/stock/items', { token: s.owner, body: { name: 'Gants nitrile (fictifs)', unit: 'box', reorderLevel: 3 } });
  assert.equal(it.status, 201, JSON.stringify(it.body));
  const id = it.body.item.id as string;
  const mv = (token: string, body: Record<string, unknown>) => api.call('POST', `/api/v1/stock/items/${id}/movements`, { token, body });
  assert.equal((await mv(s.assistant, { kind: 'RECEIVED', quantity: 10, lot: 'L-FICT-1', expiresOn: plusDays(20) })).status, 201);
  assert.equal((await mv(s.desk, { kind: 'USED', quantity: 1 })).status, 403, 'receptionist workload unchanged');
  const used = await mv(s.dentist, { kind: 'USED', quantity: 7 });
  assert.equal(used.body.movement.onHandAfter, 3);
  const over = await mv(s.dentist, { kind: 'USED', quantity: 4 });
  assert.equal(over.status, 409); assert.equal(over.body.error.details.onHand, 3);
  assert.equal((await mv(s.dentist, { kind: 'USED', quantity: 0 })).status, 400);
  assert.equal((await mv(s.dentist, { kind: 'ADJUSTED', quantity: 5 })).status, 400, 'adjustments are owner entries on their own route');
  const list = await api.call('GET', '/api/v1/stock/items', { token: s.desk });
  const item = list.body.items.find((x: { id: string }) => x.id === id);
  assert.equal(item.onHand, 3); assert.equal(item.belowReorderLevel, true);
  assert.equal(item.receivedLotsExpiringSoon[0].lot, 'L-FICT-1');
  assert.match(list.body.note, /not tracked/);
});

test('T-STK-2 owner adjustments and discards need a reason; history in sequence; concurrent usage never oversells', async () => {
  const s = await clinic();
  const id = (await api.call('POST', '/api/v1/stock/items', { token: s.owner, body: { name: 'Composite A2 (fictif)', unit: 'syringe' } })).body.item.id as string;
  const adj = (token: string, body: Record<string, unknown>) => api.call('POST', `/api/v1/stock/items/${id}/adjustments`, { token, body });
  assert.equal((await adj(s.dentist, { kind: 'ADJUSTED', quantity: 5, reason: 'count' })).status, 403);
  assert.equal((await adj(s.owner, { kind: 'ADJUSTED', quantity: 5 })).status, 400, 'reason required');
  assert.equal((await adj(s.owner, { kind: 'ADJUSTED', quantity: 5, reason: 'Fictional physical count' })).body.movement.onHandAfter, 5);
  assert.equal((await adj(s.owner, { kind: 'DISCARDED', quantity: 1, reason: 'Fictional expired syringe' })).body.movement.onHandAfter, 4);
  assert.equal((await adj(s.owner, { kind: 'ADJUSTED', quantity: -10, reason: 'Fictional recount' })).status, 409);
  const res = await Promise.all(Array.from({ length: 8 }, () => api.call('POST', `/api/v1/stock/items/${id}/movements`, { token: s.dentist, body: { kind: 'USED', quantity: 1 } })));
  assert.deepEqual(res.map(r => r.status).sort(), [201, 201, 201, 201, 409, 409, 409, 409]);
  const h = await api.call('GET', `/api/v1/stock/items/${id}/movements`, { token: s.desk });
  assert.deepEqual(h.body.movements.map((m: { seq: number }) => m.seq), [6, 5, 4, 3, 2, 1]);
  assert.equal(h.body.movements[0].onHandAfter, 0);
  const integ = await api.call('POST', '/api/v1/integrity/check', { token: s.owner, body: {}, idem: false });
  assert.deepEqual(integ.body.findings.filter((f: { check: string }) => /STOCK|LAB/.test(f.check)), []);
});

test('T-STK-3 integrity: an edited stock row and a lab invoice amount changed outside the app are reported; the ledger is append-only', async () => {
  const s = await clinic();
  const id = (await api.call('POST', '/api/v1/stock/items', { token: s.owner, body: { name: 'Anesthésique (fictif)', unit: 'cartridge' } })).body.item.id as string;
  for (const q of [10, 3]) await api.call('POST', `/api/v1/stock/items/${id}/movements`, { token: s.dentist, body: { kind: q === 10 ? 'RECEIVED' : 'USED', quantity: q } });
  const caseId = (await newCase(s, s.dentist)).body.labCase.id as string;
  const inv = await api.call('POST', '/api/v1/lab/invoices', { token: s.owner, body: { supplierId: s.supplierId, invoiceNumber: 'F-77', invoiceDate: '2026-10-01', amountMillimes: 90_000, caseIds: [caseId] } });
  const c = await adminConn(db.name);
  try {
    await c.query('BEGIN');
    await assert.rejects(c.query("UPDATE stock_movements SET quantity = -1 WHERE item_id = $1 AND kind = 'USED'", [id] as never[]), /append-only/i);
    await c.query('ROLLBACK');
    await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
    await c.query("UPDATE stock_movements SET quantity = -1 WHERE item_id = $1 AND kind = 'USED'", [id] as never[]);
    await c.query('UPDATE lab_invoices SET amount_millimes = 9000 WHERE id = $1', [inv.body.invoice.id] as never[]);
    await c.query('COMMIT');
  } finally { c.end(); }
  const r = await api.call('POST', '/api/v1/integrity/check', { token: s.owner, body: {}, idem: false });
  const checks = r.body.findings.map((f: { check: string }) => f.check);
  for (const k of ['STOCK_LEDGER_INCONSISTENT', 'STOCK_AUDIT_VALUE_MISMATCH', 'LAB_INVOICE_AUDIT_VALUE_MISMATCH']) assert.ok(checks.includes(k), `${k} in ${JSON.stringify(checks)}`);
});
