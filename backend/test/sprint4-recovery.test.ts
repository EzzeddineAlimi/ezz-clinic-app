import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDb,startApi,standardFixture,confirmCare,adminConn,seedClinic,spawnServer,killServer,type Api,type TestDb} from './helpers.ts';
let db:TestDb,api:Api,n=0;
before(async()=>{db=await createTestDb();api=await startApi(db.appUrl);});
after(async()=>{await api.close();await db.drop();});
async function fixture(){const f=await standardFixture(api,db,'s4-'+(++n));await confirmCare(api,f.dentist,f.visitId,100000);return f;}
async function state(f:{desk:string;visitId:string}){const r=await api.call('GET',`/api/v1/visits/${f.visitId}/payment-recovery`,{token:f.desk});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
async function prepare(f:{desk:string;visitId:string},extra:Record<string,unknown>={}){
 const s=await state(f);return api.call('POST',`/api/v1/visits/${f.visitId}/payment-intents`,{token:f.desk,body:{amountMillimes:30000,tender:'CASH',recoveryVersion:s.recoveryVersion,acknowledgedPaymentIds:s.paymentIds,...extra}});
}
async function record(f:{desk:string},id:string){return api.call('POST',`/api/v1/payment-intents/${id}/record`,{token:f.desk,body:{}});}
test('S4 durable intent survives lost key, process restart, new login and concurrent new-key retries',async()=>{
 const f=await fixture(),r=await prepare(f);assert.equal(r.status,201,JSON.stringify(r.body));const id=r.body.intent.id;
 assert.equal((await prepare(f)).body.error.code,'PAYMENT_INTENT_UNRESOLVED');
 await api.close();api=await startApi(db.appUrl);f.desk=await api.login(f.clinic.code,'desk');
 assert.equal((await state(f)).intentions[0].id,id);
 const outcomes=await Promise.all(Array.from({length:6},()=>record(f,id)));
 assert.equal(outcomes.filter(r=>r.status===201).length,1);assert.ok(outcomes.every(r=>[200,201].includes(r.status)),JSON.stringify(outcomes));
 const first=outcomes[0]!.body;
 for(const o of outcomes){assert.equal(o.body.payment.id,first.payment.id);assert.equal(o.body.receipt.id,first.receipt.id);}
 const s=await state(f);assert.equal(s.balance.balanceMillimes,70000);assert.equal(s.intentions[0].status,'RECORDED');
 const history=await api.call('GET',`/api/v1/visits/${f.visitId}/payments`,{token:f.desk});assert.equal(history.body.payments.length,1);assert.equal(history.body.payments[0].receiptId,first.receipt.id);assert.equal(history.body.payments[0].receiptSeries,'R');
 const receipt=await api.call('GET',`/api/v1/receipts/${first.receipt.id}`,{token:f.desk});assert.equal(receipt.body.receipt.snapshot.balanceAfterMillimes,70000);
 const later=await record(f,id);assert.equal(later.body.receipt.label,first.receipt.label);
 const cancelled=await api.call('POST',`/api/v1/payment-intents/${id}/cancel`,{token:f.desk,body:{reason:'Not a refund'}});assert.equal(cancelled.status,409);
});
test('S4 concurrent prepares reserve one active intention; legacy new-key payments cannot bypass it',async()=>{
 const f=await fixture();const s=await state(f),body={amountMillimes:30000,tender:'CARD',recoveryVersion:s.recoveryVersion,acknowledgedPaymentIds:[]};
 const rs=await Promise.all(Array.from({length:5},()=>api.call('POST',`/api/v1/visits/${f.visitId}/payment-intents`,{token:f.desk,body})));
 assert.equal(rs.filter(r=>r.status===201).length,1);assert.equal(rs.filter(r=>r.body.error?.code==='PAYMENT_INTENT_UNRESOLVED').length,4);
 const legacy=await api.call('POST',`/api/v1/visits/${f.visitId}/payments`,{token:f.desk,body:{amountMillimes:1,tender:'CARD'}});assert.equal(legacy.body.error.code,'PAYMENT_INTENT_UNRESOLVED');
});
test('S4 stale recovery, changed body, cancellation and ledger changes fail closed',async()=>{
 const f=await fixture();const stale=await prepare(f,{recoveryVersion:'0'.repeat(64)});assert.equal(stale.body.error.code,'PAYMENT_RECOVERY_STALE');
 const r=await prepare(f),id=r.body.intent.id;
 assert.equal((await api.call('POST',`/api/v1/payment-intents/${id}/record`,{token:f.desk,body:{amountMillimes:1}})).status,400);
 const adjust=await api.call('POST',`/api/v1/visits/${f.visitId}/adjustments`,{token:f.dentist,body:{kind:'DISCOUNT',amountMillimes:1,reasonCode:'TEST_REASON'}});assert.equal(adjust.status,201);
 assert.equal((await record(f,id)).body.error.code,'PAYMENT_RECOVERY_STALE');
 const cancel=()=>api.call('POST',`/api/v1/payment-intents/${id}/cancel`,{token:f.desk,body:{reason:'Reconciled; money not recorded'}});
 assert.equal((await cancel()).status,200);assert.equal((await cancel()).status,200);assert.equal((await record(f,id)).body.error.code,'PAYMENT_INTENT_CANCELLED');
 assert.equal((await state(f)).intentions[0].status,'CANCELLED');assert.equal((await prepare(f)).status,201);
});
test('S4 commit failure rolls payment, receipt number, audit and idempotency back; same intention recovers',async()=>{
 const f=await fixture(),r=await prepare(f),id=r.body.intent.id;
 const c=await adminConn(db.name);try{
  const before=await c.query('SELECT count(*)::int AS n FROM audit_events WHERE clinic_id=$1',[f.clinic.id]);
  await c.exec("CREATE FUNCTION s4_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional fault'; END $$; CREATE TRIGGER s4_fault BEFORE INSERT ON payment_intent_outcomes FOR EACH ROW EXECUTE FUNCTION s4_fail()");
  const idem=crypto.randomUUID();
  const retry=()=>api.call('POST',`/api/v1/payment-intents/${id}/record`,{token:f.desk,body:{},idem});
  assert.equal((await retry()).status,500);
  const counts=await c.query('SELECT (SELECT count(*) FROM payments WHERE clinic_id=$1)::int AS p,(SELECT count(*) FROM receipts WHERE clinic_id=$1)::int AS r,(SELECT count(*) FROM audit_events WHERE clinic_id=$1)::int AS a',[f.clinic.id]);
  assert.equal(counts.rows[0]!.p,0);assert.equal(counts.rows[0]!.r,0);assert.equal(counts.rows[0]!.a,before.rows[0]!.n);
  await c.exec('DROP TRIGGER s4_fault ON payment_intent_outcomes; DROP FUNCTION s4_fail()');
  const done=await retry();assert.equal(done.status,201);assert.equal(done.body.receipt.number,1);
 }finally{await c.end();}
});
test('S4 a new partial payment must explicitly acknowledge the previous payment, not blindly repeat',async()=>{
 const f=await fixture(),oldState=await state(f),first=await prepare(f);assert.equal((await record(f,first.body.intent.id)).status,201);
 assert.equal((await prepare(f,{recoveryVersion:oldState.recoveryVersion})).body.error.code,'PAYMENT_RECOVERY_STALE');
 assert.equal((await prepare(f,{acknowledgedPaymentIds:[]})).body.error.code,'PAYMENT_RECOVERY_STALE');
 const next=await prepare(f,{amountMillimes:70000,tender:'CARD'});assert.equal(next.status,201);assert.equal((await record(f,next.body.intent.id)).body.balanceAfterMillimes,0);
});
test('S4 current roles and tenant boundaries protect every recovery/write/cancel route',async()=>{
 const f=await fixture(),r=await prepare(f),id=r.body.intent.id;
 await seedClinic(db,'s4-assistant',[{username:'assistant',roles:['ASSISTANT']}]);const assistant=await api.login('s4-assistant','assistant');const other=await fixture();
 const routes:[string,string,unknown][]=[['GET',`/api/v1/visits/${f.visitId}/payment-recovery`,undefined],['POST',`/api/v1/visits/${f.visitId}/payment-intents`,{amountMillimes:1,tender:'CARD'}],['POST',`/api/v1/payment-intents/${id}/record`,{}],['POST',`/api/v1/payment-intents/${id}/cancel`,{reason:'Forbidden'}]];
 for(const [method,path,body] of routes){assert.equal((await api.call(method,path,{token:assistant,body})).status,403);assert.equal((await api.call(method,path,{token:other.desk,body})).status,404);assert.equal((await api.call(method,path,{body})).status,401);}
 const dentist=await record({desk:f.dentist},id);assert.equal(dentist.status,201);assert.equal(dentist.body.payment.recordedBy,f.clinic.staff.dentist);
 const c=await adminConn(db.name);try{await c.exec(`SET ROLE ezz_app; SET app.clinic_id='${f.clinic.id}'`);await assert.rejects(c.query('UPDATE payment_intents SET payload=payload WHERE id=$1',[id]));await assert.rejects(c.query('DELETE FROM payment_intent_outcomes WHERE intent_id=$1',[id]));}finally{await c.end();}
});
test('S4 mixed /print and /reprint share unique copy sequence; preparations never attest delivery',async()=>{
 const f=await fixture(),p=await api.call('POST',`/api/v1/visits/${f.visitId}/payments`,{token:f.desk,body:{amountMillimes:30000,tender:'CARD'}}),path=`/api/v1/receipts/${p.body.receipt.id}`;
 const first=await api.call('POST',path+'/print',{token:f.desk,body:{}});assert.equal(first.body.copyNo,0);assert.equal(first.body.paperDelivery,'UNKNOWN');
 const rs=await Promise.all(['/reprint','/print','/reprint','/print'].map(s=>api.call('POST',path+s,{token:f.desk,body:{}})));
 assert.deepEqual(rs.map(r=>r.body.copyNo??r.body.receipt.copyNo).sort(),[1,2,3,4]);assert.ok(rs.every(r=>r.body.preparationOnly&&r.body.paperDelivery==='UNKNOWN'));
 const key=crypto.randomUUID();const a=await api.call('POST',path+'/print',{token:f.desk,body:{},idem:key}),b=await api.call('POST',path+'/print',{token:f.desk,body:{},idem:key});assert.equal(a.body.copyNo,b.body.copyNo);
 const unchanged=await api.call('GET',path,{token:f.desk});assert.equal(unchanged.body.receipt.snapshot.label,p.body.receipt.label);
});
test('S4 reprint before any original makes subsequent print a distinct copy',async()=>{
 const f=await fixture(),p=await api.call('POST',`/api/v1/visits/${f.visitId}/payments`,{token:f.desk,body:{amountMillimes:30000,tender:'CARD'}}),path=`/api/v1/receipts/${p.body.receipt.id}`;
 assert.equal((await api.call('POST',path+'/reprint',{token:f.desk,body:{}})).body.receipt.copyNo,1);
 assert.equal((await api.call('POST',path+'/print',{token:f.desk,body:{}})).body.copyNo,2);
});

test('S4 real SIGKILL after commit with discarded response recovers through new process and login',async()=>{
 const f=await fixture(),p=await prepare(f),id=p.body.intent.id,port=Number(new URL(api.base).port);
 await api.close();let child=await spawnServer(db.appUrl,port);
 try{
  const res=await fetch(api.base+`/api/v1/payment-intents/${id}/record`,{method:'POST',headers:{Authorization:'Bearer '+f.desk,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:'{}'});
  assert.equal(res.status,201);await res.body?.cancel(); // Intentionally discard the committed outcome.
  await killServer(child);child=await spawnServer(db.appUrl,port);
  f.desk=await api.login(f.clinic.code,'desk');
  const recovered=await state(f);assert.equal(recovered.intentions[0].status,'RECORDED');
  const replay=await record(f,id);assert.equal(replay.status,200);assert.equal(replay.body.payment.id,recovered.intentions[0].paymentId);
  assert.equal(recovered.paymentIds.length,1);
 }finally{await killServer(child);api=await startApi(db.appUrl);}
});
test('S4 inconsistent multiple pending intentions fail closed instead of choosing one',async()=>{
 const f=await fixture(),p=await prepare(f),id=p.body.intent.id,c=await adminConn(db.name);
 try{await c.query('INSERT INTO payment_intents(clinic_id,visit_id,created_by,ledger_hash,payload) SELECT clinic_id,visit_id,created_by,ledger_hash,payload FROM payment_intents WHERE id=$1',[id]);}finally{await c.end();}
 const r=await api.call('GET',`/api/v1/visits/${f.visitId}/payment-recovery`,{token:f.desk});
 assert.equal(r.status,200);assert.equal(r.body.pendingAnomaly,true);
 assert.equal(r.body.intentions.filter((i:{status:string})=>i.status==='PENDING').length,2);
 assert.equal((await prepare(f)).body.error.code,'PAYMENT_INTENT_UNRESOLVED');
 assert.equal((await record(f,id)).body.error.code,'PAYMENT_INTENT_UNRESOLVED');
});
