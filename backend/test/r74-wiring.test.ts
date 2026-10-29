/*
 * R74 package B — dependencies are wired explicitly in the composition root, and a missing wire fails closed.
 *   T-WIRE-1  Before R74 the cash module registered billing's cash-period resolver as a side effect of being imported.
 *             Any code path that loaded billing without cash (a script, a worker, a future second entry point)
 *             recorded CASH payments, refunds and voids with cash_period_id NULL: money outside every drawer count.
 *             Now an unwired resolver refuses CASH instead; CARD needs no period and is unaffected.
 *   T-WIRE-2  buildRoutes() wires billing to the cash module's resolver (no import side effect is needed).
 *   T-WIRE-3  isUniqueViolation (platform/db.ts) recognises exactly the driver's 23505, so paper.ts no longer imports the driver.
 * This file imports billing.ts first and app.ts only inside T-WIRE-2, so T-WIRE-1 really runs without the cash module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashPeriodFor } from '../src/modules/billing.ts';
import type { Actor } from '../src/platform/http.ts';
import { AppError } from '../src/platform/errors.ts';
import { isUniqueViolation, type Tx } from '../src/platform/db.ts';
import { PgError } from '../src/platform/postgres.ts';

const actor = { staffId: '00000000-0000-4000-8000-000000000001', clinicId: '00000000-0000-4000-8000-000000000002', roles: ['RECEPTIONIST'], displayName: 'Fictional desk' } as Actor;
const noOpenPeriodTx = { maybeOne: async () => undefined } as unknown as Tx;

test('T-WIRE-1 billing without the cash module refuses CASH instead of recording it outside any cash period', async () => {
  assert.equal(await cashPeriodFor(noOpenPeriodTx, actor, 'CARD'), null, 'card needs no cash period');
  await assert.rejects(cashPeriodFor(noOpenPeriodTx, actor, 'CASH'), /cash-period resolver is not wired/);
});

test('T-WIRE-2 the composition root wires billing to the cash module', async () => {
  const { buildRoutes } = await import('../src/app.ts');
  const { Db } = await import('../src/platform/db.ts');
  const db = new Db('postgres://fictional:fictional@127.0.0.1:1/never-connected', 1); // routes only; no query is sent
  try {
    buildRoutes(db);
    await assert.rejects(cashPeriodFor(noOpenPeriodTx, actor, 'CASH'), (e: unknown) => e instanceof AppError && e.code === 'NO_OPEN_CASH_PERIOD');
  } finally { await db.close(); }
});

test('T-WIRE-3 isUniqueViolation matches only a PostgreSQL unique violation', () => {
  assert.equal(isUniqueViolation(new PgError({ code: '23505' })), true);
  assert.equal(isUniqueViolation(new PgError({ code: '23503' })), false);
  assert.equal(isUniqueViolation(Object.assign(new Error('x'), { code: '23505' })), false);
  assert.equal(isUniqueViolation(null), false);
});

// R75-D (Muse M-269 #32 residual a): the resolver is process-global. Once wired it must not be silently replaced, and
// returning to "unwired" (fail closed) must be possible without relying on import order.
test('T-WIRE-4 a second, different cash-period resolver is refused; re-wiring the same one is harmless', async () => {
  const { buildRoutes } = await import('../src/app.ts');
  const { Db } = await import('../src/platform/db.ts');
  const billing = await import('../src/modules/billing.ts');
  const db = new Db('postgres://fictional:fictional@127.0.0.1:1/never-connected', 1);
  try {
    buildRoutes(db);
    buildRoutes(db); // a second app in the same process wires the same resolver
    const stub = async () => '00000000-0000-4000-8000-0000000000ff';
    assert.throws(() => billing.setCashPeriodResolver(stub), /already wired/);
    await assert.rejects(cashPeriodFor(noOpenPeriodTx, actor, 'CASH'), (e: unknown) => e instanceof AppError && e.code === 'NO_OPEN_CASH_PERIOD', 'still the cash module resolver');
  } finally { await db.close(); }
});

test('T-WIRE-5 resetting the resolver returns to fail-closed even after the app was built in this process', async () => {
  const billing = await import('../src/modules/billing.ts');
  billing.resetCashPeriodResolver();
  await assert.rejects(cashPeriodFor(noOpenPeriodTx, actor, 'CASH'), /cash-period resolver is not wired/);
  assert.equal(await cashPeriodFor(noOpenPeriodTx, actor, 'CARD'), null);
});
