import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, startApi, standardFixture, adminConn, type Api, type TestDb } from './helpers.ts';
let db: TestDb; let api: Api;
before(async()=>{db=await createTestDb();api=await startApi(db.appUrl);});
after(async()=>{await api.close();await db.drop();});

test('U012 two concurrent bookings cannot both silently claim the same dentist interval', async()=>{
 const f=await standardFixture(api,db,'u012-race');
 const gate=await adminConn(db.name),observer=await adminConn(db.name);
 let calls:Promise<{status:number;body:any;headers:Headers}>[]=[];
 try{
  // Block INSERT while permitting the overlap SELECT. This exposes the check/insert race
  // deterministically. A correct resource lock instead parks the second request before SELECT.
  await gate.exec('BEGIN; LOCK TABLE visits IN SHARE MODE');
  const body={patientId:f.patientId,dentistId:f.clinic.staff.dentist,scheduledAt:'2027-01-12T09:00:00Z',durationMin:30};
  calls=Array.from({length:2},()=>api.call('POST','/api/v1/visits',{token:f.desk,body}));
  const deadline=Date.now()+10000;let waiting=0;
  while(Date.now()<deadline){
   const q=await observer.query<{n:number}>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
    AND usename='ezz_app' AND wait_event_type='Lock'
    AND (query LIKE 'INSERT INTO visits%' OR query LIKE 'SELECT pg_advisory_xact_lock%')`);
   waiting=q.rows[0]!.n;if(waiting===2)break;
   await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(waiting,2,'both real requests must reach the database barrier before release');
  await gate.exec('COMMIT');
  const rs=await Promise.all(calls);
  assert.deepEqual(rs.map(r=>r.status).sort(),[201,409],JSON.stringify(rs.map(r=>({status:r.status,body:r.body}))));
  const denied=rs.find(r=>r.status===409)!;assert.equal(denied.body.error.code,'CONFLICT');assert.equal(denied.body.error.details.overlapping.length,1);
  const count=await observer.query<{n:number}>('SELECT count(*)::int AS n FROM visits WHERE clinic_id=$1 AND scheduled_at=$2',[f.clinic.id,body.scheduledAt]);
  assert.equal(count.rows[0]!.n,1);
 }finally{await gate.exec('ROLLBACK');await Promise.allSettled(calls);await gate.end();await observer.end();}
});

test('U012 adjacent slots, explicit overlap override and same-key replay retain their contracts',async()=>{
 const f=await standardFixture(api,db,'u012-boundaries');
 const body={patientId:f.patientId,dentistId:f.clinic.staff.dentist,scheduledAt:'2027-01-12T10:00:00Z',durationMin:30};
 const key=crypto.randomUUID();const r=await api.call('POST','/api/v1/visits',{token:f.desk,body,idem:key});assert.equal(r.status,201);
 const retry=await api.call('POST','/api/v1/visits',{token:f.desk,body,idem:key});assert.equal(retry.body.visit.id,r.body.visit.id);
 assert.equal((await api.call('POST','/api/v1/visits',{token:f.desk,body:{...body,scheduledAt:'2027-01-12T10:30:00Z'}})).status,201);
 const conflict=await api.call('POST','/api/v1/visits',{token:f.desk,body:{...body,scheduledAt:'2027-01-12T10:15:00Z'}});assert.equal(conflict.status,409);
 assert.equal((await api.call('POST','/api/v1/visits',{token:f.desk,body:{...body,allowOverlap:true}})).status,201);
});
test('U012 cross-midnight overlap, cancelled slot release and clinic isolation remain enforced',async()=>{
 const f=await standardFixture(api,db,'u012-midnight'),other=await standardFixture(api,db,'u012-other');
 const body={patientId:f.patientId,dentistId:f.clinic.staff.dentist,scheduledAt:'2027-01-12T23:50:00Z',durationMin:30};
 const first=await api.call('POST','/api/v1/visits',{token:f.desk,body});assert.equal(first.status,201);
 assert.equal((await api.call('POST','/api/v1/visits',{token:f.desk,body:{...body,scheduledAt:'2027-01-13T00:05:00Z'}})).status,409);
 assert.equal((await api.call('POST',`/api/v1/visits/${first.body.visit.id}/status`,{token:f.desk,body:{status:'CANCELLED',reason:'Fictional cancellation'}})).status,200);
 assert.equal((await api.call('POST','/api/v1/visits',{token:f.desk,body})).status,201);
 assert.equal((await api.call('POST','/api/v1/visits',{token:other.desk,body})).status,404);
 assert.equal((await api.call('POST','/api/v1/visits',{token:other.desk,body:{...body,patientId:other.patientId,dentistId:other.clinic.staff.dentist}})).status,201);
});
