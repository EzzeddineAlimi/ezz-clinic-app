/* End-to-end fictional receptionist → dentist → checkout read-model journey.
 * Tests the *actual* API/data returned to future Astra screens, not UI mockups.
 */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDb,startApi,standardFixture,confirmCare,seedClinic,newVisit,reauth,type Api,type TestDb} from './helpers.ts';

let db:TestDb,api:Api,fixture:Awaited<ReturnType<typeof standardFixture>>;
before(async()=>{db=await createTestDb();api=await startApi(db.appUrl);fixture=await standardFixture(api,db,'workbench');});
after(async()=>{await api.close();await db.drop()});
const view=(token:string,id=fixture.visitId)=>api.call('GET','/api/v1/visits/'+id+'/workbench',{token});

test('WORKFLOW: one visit progresses from check-in to dentist care to partial/full cash checkout',async()=>{
 const first=await view(fixture.desk);
 assert.equal(first.status,200,JSON.stringify(first.body));
 assert.equal(first.body.syntheticDataOnly,true);
 assert.equal(first.body.visit.nextAction,'CHECK_IN');
 assert.equal(first.body.visit.patient.fileNo,1);
 assert.equal(first.body.visit.balance.balanceMillimes,0);
 assert.deepEqual(first.body.visit.care,[]);
 assert.deepEqual(first.body.visit.payments,[]);
 assert.equal((await api.call('POST','/api/v1/visits/'+fixture.visitId+'/status',{token:fixture.desk,body:{status:'ARRIVED'}})).status,200);
 assert.equal((await view(fixture.desk)).body.visit.nextAction,'MOVE_TO_CHAIR');
 assert.equal((await api.call('POST','/api/v1/visits/'+fixture.visitId+'/status',{token:fixture.desk,body:{status:'IN_CHAIR'}})).status,200);
 assert.equal((await view(fixture.desk)).body.visit.nextAction,'WAIT_FOR_DENTIST_CONFIRMATION');
 const denied=await api.call('POST','/api/v1/visits/'+fixture.visitId+'/care',{
  token:fixture.desk,body:{procedureCode:'CHECKUP',procedureLabel:'Fictional checkup',feeMillimes:100_000}});
 assert.equal(denied.status,403);
 await confirmCare(api,fixture.dentist,fixture.visitId,100_000);
 const care=(await view(fixture.dentist)).body.visit;
 assert.equal(care.status,'COMPLETED');
 assert.equal(care.care.length,1);
 assert.equal(care.care[0].feeMillimes,100_000);
 assert.equal(care.balance.chargedMillimes,100_000);
 assert.equal(care.balance.balanceMillimes,100_000);
 assert.equal(care.nextAction,'RECORD_OR_FOLLOW_UP_PAYMENT');
 const firstPayment=await api.call('POST','/api/v1/visits/'+fixture.visitId+'/payments',{token:fixture.desk,body:{amountMillimes:70_000,tender:'CASH'}});
 assert.equal(firstPayment.status,201,JSON.stringify(firstPayment.body));
 const partial=(await view(fixture.owner)).body.visit;
 assert.equal(partial.payments.length,1);
 assert.equal(partial.payments[0].amountMillimes,70_000);
 assert.equal(partial.payments[0].receiptLabel,'R-000001');
 assert.equal(partial.payments[0].evidenceStatus,'DESK_CASH__INDEPENDENT_COUNT_REQUIRED');
 assert.equal(partial.balance.balanceMillimes,30_000);
 assert.equal(partial.nextAction,'RECORD_OR_FOLLOW_UP_PAYMENT');
 const last=await api.call('POST','/api/v1/visits/'+fixture.visitId+'/payments',{token:fixture.desk,body:{amountMillimes:30_000,tender:'CASH'}});
 assert.equal(last.status,201);
 const completed=(await view(fixture.desk)).body.visit;
 assert.equal(completed.balance.balanceMillimes,0);
 assert.equal(completed.nextAction,'CHECKOUT_RECORDED__RECONCILIATION_PENDING');
 assert.match((await view(fixture.owner)).body.evidenceNotice,/independent/);
 assert.equal(completed.payments.length,2);
 assert.equal(completed.payments[1].receiptLabel,'R-000002');
});

test('WORKFLOW privacy: logged-out blocked, other clinic hidden, assistant not granted financial workbench',async()=>{
 const noAuth=await api.call('GET','/api/v1/visits/'+fixture.visitId+'/workbench');
 assert.equal(noAuth.status,401);
 const second=await seedClinic(db,'otherworkbench',[{username:'foreign-dentist',roles:['DENTIST']},{username:'assistant',roles:['ASSISTANT']}]);
 const dentist=await api.login('otherworkbench','foreign-dentist');
 const other=await view(dentist);
 assert.equal(other.status,404,'Cross-clinic financial workbench must not reveal a visit');
 const assistant=await api.login('otherworkbench','assistant');
 const forbidden=await view(assistant);
 assert.equal(forbidden.status,403);
 assert.ok(second.id);
});

test('WORKFLOW: card desk claims stay unverified in the combined visit view',async()=>{
 const visit=await newVisit(api,fixture.desk,fixture.patientId,'2026-10-28T15:00:00Z');
 await confirmCare(api,fixture.dentist,visit,80_000,'EXAM');
 const paid=await api.call('POST','/api/v1/visits/'+visit+'/payments',{token:fixture.desk,body:{amountMillimes:20_000,tender:'CARD'}});
 assert.equal(paid.status,201);
 const b=(await view(fixture.owner,visit)).body.visit;
 assert.equal(b.payments[0].evidenceStatus,'DESK_CLAIM__OWNER_PROOF_SEPARATE');
 assert.equal(b.payments[0].evidenceTier,'DESK_CLAIM');
 assert.equal(b.balance.balanceMillimes,60_000);
 assert.match((await view(fixture.owner,visit)).body.evidenceNotice,/external evidence/);
 const final=await api.call('POST','/api/v1/visits/'+visit+'/payments',{token:fixture.desk,body:{amountMillimes:60_000,tender:'CARD'}});
 assert.equal(final.status,201);
 const claimed=(await view(fixture.owner,visit)).body.visit;
 assert.equal(claimed.balance.balanceMillimes,0);
 assert.equal(claimed.nextAction,'OWNER_REVIEW_CARD_CLAIM');
 assert.ok(claimed.payments.every((p:{evidenceTier:string})=>p.evidenceTier==='DESK_CLAIM'));
});

test('WORKFLOW: owner-reviewed imported statement is NOT provider-verified',async()=>{
 const F=await standardFixture(api,db,'workbench-card-statement');
 await reauth(api,F.owner);
 const settings=await api.call('POST','/api/v1/card/settings',{token:F.owner,body:{accountLast4:'4321',settlementLagDays:2}});
 assert.equal(settings.status,200);
 const visit=await newVisit(api,F.desk,F.patientId,'2026-11-21T09:00:00Z');
 await confirmCare(api,F.dentist,visit,20_000,'EXAM');
 const paid=await api.call('POST','/api/v1/visits/'+visit+'/payments',{
  token:F.desk,body:{amountMillimes:20_000,tender:'CARD',cardTerminalRef:'T9'}});
 assert.equal(paid.status,201);
 const now=new Date().toISOString().slice(0,10);
 const inThreeDays=new Date(Date.now()+3*86400_000).toISOString().slice(0,10);
 const csv=['date,amount_tnd,type,terminal_ref,card_last4,description',
  now+',20.000,CARD,T9,,fictional-reference'].join('\n');
 const imported=await api.call('POST','/api/v1/card/statement-imports',{token:F.owner,body:{
  fileName:'fictional-bank.csv',accountLast4:'4321',periodStart:now,periodEnd:inThreeDays,
  totalSource:'NOT_PROVIDED',csv}});
 assert.equal(imported.status,201,JSON.stringify(imported.body));
 const reconciliation=await api.call('GET','/api/v1/card/reconciliation?asOf='+now,{token:F.owner});
 assert.equal(reconciliation.status,200);
 const claim=reconciliation.body.claims.find((x:{paymentId:string})=>x.paymentId===paid.body.payment.id);
 assert.ok(claim);
 assert.equal(claim.candidates.length,1);
 const matched=await api.call('POST','/api/v1/card/matches',{token:F.owner,body:{
  paymentId:paid.body.payment.id,statementLineId:claim.candidates[0].statementLineId}});
 assert.equal(matched.status,201,JSON.stringify(matched.body));
 const workbench=(await view(F.owner,visit)).body.visit;
 assert.equal(workbench.balance.balanceMillimes,0);
 assert.equal(workbench.payments[0].evidenceTier,'OWNER_REVIEWED_STATEMENT');
 assert.equal(workbench.payments[0].evidenceStatus,'OWNER_REVIEWED_STATEMENT__NOT_PROVIDER_VERIFIED');
 assert.equal(workbench.nextAction,'CHECKOUT_RECORDED__RECONCILIATION_PENDING');
});
