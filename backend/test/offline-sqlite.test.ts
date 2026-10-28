/* Offline SQLite candidate smoke: independent of production Postgres/paper module. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { SCRIPTS_DIR } from '../src/platform/paths.ts';
test('R46-SQLITE: 20 visits local outbox survives reopen, detects duplicate/conflict/missing',()=>{
 const script=join(SCRIPTS_DIR,'sqlite-outbox-drill.mjs');
 const raw=execFileSync(process.execPath,[script],{encoding:'utf8',timeout:30000});
 const d=JSON.parse(raw) as {mode:string;visits:number;windowHours:number;expectedCashMillimes:number;missing:string[];attempts:{outcome:string;count:number}[];actualServerSync:string};
 assert.equal(d.mode,'EXPERIMENTAL_LOCAL_SQLITE_NOT_APPROVED');
 assert.equal(d.visits,20);assert.equal(d.windowHours,4);
 assert.equal(d.expectedCashMillimes,440000);assert.deepEqual(d.missing,['P-120']);
 assert.equal(d.attempts.find(x=>x.outcome==='DUPLICATE_ENTRY')?.count,20);
 assert.equal(d.attempts.find(x=>x.outcome==='CONFLICT')?.count,1);
 assert.equal(d.actualServerSync,'NOT RUN');
});