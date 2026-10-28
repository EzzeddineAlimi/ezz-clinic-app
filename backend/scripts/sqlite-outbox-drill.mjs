/* R46: fictional four-hour, 20-visit SQLite offline outbox experiment.
   Not a selected architecture, not a secure cash register, no real patient data. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
const folder=mkdtempSync(join(tmpdir(),'ezz-offline-')),file=join(folder,'queue.sqlite');
const amounts=Array.from({length:16},(_,i)=>20000+i*1000),total=amounts.reduce((a,b)=>a+b,0);
const visits=Array.from({length:20},(_,i)=>({
  visitKey:'V-'+String(i+1).padStart(3,'0'),slip:101+i,
  kind:i<16?'USED':i<18?'VOID':i===18?'UNUSED_DECLARED':'MISSING',
  amount:i<16?amounts[i]:0,
  scheduledAt:new Date(Date.UTC(2026,10,3,8,12*i)).toISOString()
}));
let db;
function open(){
  db=new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY, slip INTEGER NOT NULL UNIQUE, visit_key TEXT NOT NULL, kind TEXT NOT NULL, amount_millimes INTEGER NOT NULL CHECK(amount_millimes>=0), content TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts(attempt_id INTEGER PRIMARY KEY AUTOINCREMENT, slip INTEGER NOT NULL, outcome TEXT NOT NULL, content TEXT NOT NULL)");
}
function enter(e){
  const content=JSON.stringify(e),previous=db.prepare("SELECT content FROM outbox WHERE slip=?").get(e.slip);
  const outcome=previous?(previous.content===content?'DUPLICATE_ENTRY':'CONFLICT'):'STAGED';
  db.exec('BEGIN IMMEDIATE');
  try {
    if(!previous)db.prepare('INSERT INTO outbox(event_id,slip,visit_key,kind,amount_millimes,content) VALUES (?,?,?,?,?,?)')
      .run(e.visitKey+'/'+e.slip,e.slip,e.visitKey,e.kind,e.amount,content);
    db.prepare('INSERT INTO attempts(slip,outcome,content) VALUES (?,?,?)').run(e.slip,outcome,content);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  return outcome;
}
try{
  open();
  const entries=visits.filter(e=>e.kind!=='MISSING');
  assert.equal(entries.length,19);
  assert.equal(entries.filter(e=>enter(e)==='STAGED').length,19);
  assert.equal(enter(entries[4]),'DUPLICATE_ENTRY');
  assert.equal(enter({...entries[8],amount:entries[8].amount+9000}),'CONFLICT');
  db.close(); open(); // True SQLite file close/reopen, not server synchronization
  assert.equal(entries.filter(e=>enter(e)==='DUPLICATE_ENTRY').length,19);
  const sums=db.prepare("SELECT COUNT(*) AS count, SUM(CASE WHEN kind='USED' THEN amount_millimes ELSE 0 END) AS total FROM outbox").get();
  assert.equal(sums.count,19);assert.equal(sums.total,total);
  const missing=visits.filter(e=>!db.prepare("SELECT 1 FROM outbox WHERE slip=?").get(e.slip)).map(e=>'P-'+e.slip);
  assert.deepEqual(missing,['P-120']);
  const counts=db.prepare("SELECT kind,COUNT(*) AS n FROM outbox GROUP BY kind ORDER BY kind").all();
  const attempts=db.prepare("SELECT outcome,COUNT(*) AS n FROM attempts GROUP BY outcome ORDER BY outcome").all();
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE outcome='CONFLICT'").get().n),1);
  console.log(JSON.stringify({
    mode:'EXPERIMENTAL_LOCAL_SQLITE_NOT_APPROVED',visits:20,windowHours:4,
    used:16,void:2,unusedDeclared:1,missing,expectedCashMillimes:total,
    groups:counts.map(x=>({kind:x.kind,count:Number(x.n)})),
    attempts:attempts.map(x=>({outcome:x.outcome,count:Number(x.n)})),
    actualServerSync:'NOT RUN',humanStaffTime:'NOT MEASURED',
    warnings:['local device theft/tampering not addressed','off-book cash invisible','no authenticated reconciliation or TLS integration']
  }));
}finally{try{db?.close()}catch{}rmSync(folder,{recursive:true,force:true})}
