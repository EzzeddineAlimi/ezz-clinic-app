/* R46 real-PostgreSQL 20-visit/4-hour numbered paper recovery test.
 * Synthetic only. No inference about actual physical cash, theft or staff time. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDb,startApi,seedClinic,newVisit,confirmCare,reauth,adminConn} from './helpers.ts';
test('R46-PAPER 20 fictional visits: 16 partial cash, 2 void, 1 unused, 1 missing; replay unchanged',async()=>{
 const db=await createTestDb(),api=await startApi(db.appUrl);
 let second:Awaited<ReturnType<typeof startApi>>|undefined;
 try{
  const c=await seedClinic(db,'outage20',[
   {username:'owner',roles:['OWNER']},{username:'dentist',roles:['DENTIST']},{username:'desk',roles:['RECEPTIONIST']}]);
  const owner=await api.login('outage20','owner'),dentist=await api.login('outage20','dentist'),desk=await api.login('outage20','desk');
  const cash=await api.call('POST','/api/v1/cash/periods',{token:owner,body:{openingFloatMillimes:0}});
  assert.equal(cash.status,201,JSON.stringify(cash.body));
  await reauth(api,owner);
  const issue=await api.call('POST','/api/v1/paper-books',{token:owner,body:{firstNo:101,lastNo:120,custodianStaffId:c.staff.dentist,note:'Fictional four-hour recovery'}});
  assert.equal(issue.status,201,JSON.stringify(issue.body));
  const book=issue.body.book.id as string;
  const path='/api/v1/paper-books/'+book+'/entries',unusedPath='/api/v1/paper-books/'+book+'/declare-unused';
  const slips:{slipNo:number;kind:'USED';amountMillimes:number;tender:'CASH';visitId:string;writtenOn:string}[]=[];
  const amounts=Array.from({length:16},(_,i)=>20000+i*1000),sum=amounts.reduce((a,b)=>a+b,0);
  assert.equal(sum,440000);
  for(let i=0;i<20;i++){
   const p=await api.call('POST','/api/v1/patients',{token:desk,body:{familyName:'Fictif'+(i+1),givenName:'Simulation',isSynthetic:true}});
   assert.equal(p.status,201,JSON.stringify(p.body));
   const visit=await newVisit(api,desk,p.body.patient.id,new Date(Date.UTC(2026,10,3,8,12*i)).toISOString());
   await confirmCare(api,dentist,visit,50000+i*1000);
   if(i<16)slips.push({slipNo:101+i,kind:'USED',amountMillimes:amounts[i]!,tender:'CASH',visitId:visit,writtenOn:'2026-11-03'});
  }
  const first=await api.call('POST',path,{token:desk,body:{slips}});
  assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.summary.posted,16);
  const voids=await api.call('POST',path,{token:desk,body:{slips:[
   {slipNo:117,kind:'VOID',note:'Fictional spoiled receipt'},
   {slipNo:118,kind:'VOID',note:'Fictional voided receipt'}]}});
  assert.equal(voids.status,200);
  assert.equal(voids.body.results.filter((r:{outcome:string})=>r.outcome==='VOID_RECORDED').length,2);
  assert.equal((await api.call('POST',unusedPath,{token:desk,body:{slipNos:[119]}})).status,403);
  assert.equal((await api.call('POST',unusedPath,{token:dentist,body:{slipNos:[119]}})).status,200);
  const dup=await api.call('POST',path,{token:desk,body:{slips:[slips[4]!]}});
  assert.equal(dup.body.results[0].outcome,'DUPLICATE_ENTRY');
  const conflicting=await api.call('POST',path,{token:desk,body:{slips:[{...slips[8]!,amountMillimes:slips[8]!.amountMillimes+9000}]}});
  assert.equal(conflicting.body.results[0].outcome,'CONFLICT');
  const rec=await api.call('GET','/api/v1/paper-books/'+book+'/reconciliation',{token:owner});
  assert.equal(rec.status,200);
  assert.equal(rec.body.used.length,16);
  assert.deepEqual(rec.body.void,['P-117','P-118']);
  assert.deepEqual(rec.body.unusedDeclared,['P-119']);
  assert.deepEqual(rec.body.unaccounted,['P-120']);
  assert.equal(rec.body.postedTotalMillimes,sum);
  assert.ok(rec.body.reviewItems.some((r:{kind:string;slip:string})=>r.kind==='DUPLICATE_ENTRY'&&r.slip==='P-105'));
  assert.ok(rec.body.reviewItems.some((r:{kind:string;slip:string})=>r.kind==='CONFLICT'&&r.slip==='P-109'));
  second=await startApi(db.appUrl);
  const token=await second.login('outage20','desk');
  const replay=await second.call('POST',path,{token,body:{slips}});
  assert.deepEqual(replay.body.summary,{posted:0,flagged:16,rejected:0});
  const a=await adminConn(db.name);
  try {
   const row=(await a.query<{n:number;total:number}>("SELECT count(*)::int AS n, coalesce(sum(amount_millimes),0)::bigint AS total FROM payments WHERE source='PAPER_OUTAGE'")).rows[0]!;
   assert.deepEqual(row,{n:16,total:sum});
   const recs=(await a.query<{n:number}>("SELECT count(*)::int AS n FROM receipts r JOIN payments p ON p.id=r.payment_id WHERE p.source='PAPER_OUTAGE'")).rows[0]!;
   assert.equal(recs.n,0);
  }finally{a.end()}
 }finally{if(second)await second.close();await api.close();await db.drop()}
});