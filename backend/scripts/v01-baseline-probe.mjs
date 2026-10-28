#!/usr/bin/env node
/*
 * Re-runs GPT_SECURITY_BASELINE negative checks against the UNCHANGED v0.1 prototype (repo root src/server.mjs)
 * to record the "red" side of red -> green. Fictional data only; loopback only; v0.1 source is not modified.
 * Usage (from backend/):  node scripts/v01-baseline-probe.mjs [path-to-v0.1-root]   -> prints JSON results.
 * Requires port 4173 free (v0.1 hard-codes it).
 */
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] ?? '..');
const base = 'http://127.0.0.1:4173';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start() {
  const child = spawn(process.execPath, [join(root, 'src', 'server.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/state')).ok) return child; } catch { /* starting */ } await sleep(100); }
  child.kill('SIGKILL'); throw new Error('v0.1 server did not start');
}
const stop = c => new Promise(r => { c.once('exit', r); c.kill('SIGKILL'); });
const post = async (action, body, type = 'application/json') => { const r = await fetch(`${base}/api/${action}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const state = async () => (await fetch(base + '/api/state')).json();

const results = [];
const rec = (id, check, observed, red) => results.push({ id, check, observedOnV01: observed, result: red ? 'RED (expected on v0.1)' : 'NOT RED' });

let srv = await start();
try {
  const s0 = await state();
  const appt = s0.appointments[0].id;
  const care = await post('care', { appointmentId: appt, treatment: 'Fictional', feeMillimes: 200000 });
  rec('T-CARE-1', 'POST /api/care with no login', `HTTP ${care.status}; confirmed=${care.body?.result?.confirmed}`, care.status === 200);
  const card = await post('payment', { appointmentId: appt, amountMillimes: 100000, method: 'card' });
  rec('T-CARD-1', 'card payment with no bank proof', `HTTP ${card.status}; open balance after = ${card.body?.state?.openBalances?.[0]?.balanceMillimes}`, card.status === 200);
  const p1 = await post('payment', { appointmentId: appt, amountMillimes: 50000, method: 'cash' });
  const p2 = await post('payment', { appointmentId: appt, amountMillimes: 50000, method: 'cash' });
  rec('T-IDEM-1', 'identical 50,000 cash POST twice', `HTTP ${p1.status}/${p2.status}; receipts #${p1.body?.result?.receiptNo} and #${p2.body?.result?.receiptNo}`, p1.status === 200 && p2.status === 200);
  const c1 = await post('count', { countedMillimes: 0 });
  const c2 = await post('count', { countedMillimes: 100000 });
  const leaked = JSON.stringify(await state()).includes('"expectedMillimes":100000');
  rec('T-CASH-1/3', 'two anonymous counts; expected visible in /api/state', `HTTP ${c1.status}/${c2.status}; expected leaked=${leaked}`, c1.status === 200 && c2.status === 200 && leaked);
  const plain = await post('patient', { name: 'FICTIONAL', phone: '' }, 'text/plain');
  rec('T-ORG-1 (CH-019)', 'text/plain POST accepted', `HTTP ${plain.status}`, plain.status === 200);
  const paper = await post('paper-import', {});
  rec('T-PAPER-1', 'paper import endpoint', `HTTP ${paper.status}`, paper.status === 404);
  const stmt = await post('statement-import', {});
  rec('T-STMT-1', 'statement import endpoint', `HTTP ${stmt.status}`, stmt.status === 404);
  const eventsBefore = (await state()).events.length;
  await stop(srv); srv = await start();
  const s1 = await state();
  rec('T-EVT-3', 'events across a real process restart', `${eventsBefore} events before -> ${s1.events.length} after`, s1.events.length < eventsBefore);
  const a2 = s1.appointments[0].id;
  await post('care', { appointmentId: a2, treatment: 'Fictional', feeMillimes: 10000 });
  const r1 = await post('payment', { appointmentId: a2, amountMillimes: 1000, method: 'cash' });
  rec('T-RECEIPT', 'receipt number after restart', `receipt #${r1.body?.result?.receiptNo}`, r1.body?.result?.receiptNo === 1);
} finally { await stop(srv); }

process.stdout.write(JSON.stringify({ probe: 'v0.1 baseline (GPT_SECURITY_BASELINE re-run)', node: process.version, at: new Date().toISOString(), results }, null, 2) + '\n');
