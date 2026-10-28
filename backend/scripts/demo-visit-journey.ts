/* Local fictional clinic-day walkthrough. NEVER POINT EZZ_TEST_ADMIN_URL AT A REAL DB.
 * Creates then destroys a temporary PostgreSQL database and starts a local HTTP API.
 * No live patients, fiscal receipts, deployment or medical guidance.
 */
import {createTestDb,startApi,standardFixture,confirmCare,type Api,type TestDb} from '../test/helpers.ts';
function row(stage:string,body:any){
 const v=body.visit;
 const b=v.balance;
 return {stage,status:v.status,nextAction:v.nextAction,patientFileNo:v.patient.fileNo,
  dentist:!!v.dentist,careItems:v.care.length,payments:v.payments.length,
  chargedTND:(b.chargedMillimes/1000).toString(),recordedPaidTND:(b.paidMillimes/1000).toString(),
  remainingTND:(b.balanceMillimes/1000).toString(),
  receiptLabels:v.payments.map((p:{receiptLabel:string|null})=>p.receiptLabel),
  reminder:'Recorded cash must still be independently counted.'};
}
let db:TestDb|undefined,api:Api|undefined;
try{
 db=await createTestDb();
 api=await startApi(db.appUrl);
 const f=await standardFixture(api,db,'walkthrough',{openingFloatMillimes:0});
 const trace:any[]=[];
 async function get(stage:string,token:string){
  const r=await api!.call('GET','/api/v1/visits/'+f.visitId+'/workbench',{token});
  if(r.status!==200)throw Error('View '+stage+' failed: '+JSON.stringify(r.body));
  trace.push(row(stage,r.body));
 }
 await get('Scheduled',f.desk);
 await api.call('POST','/api/v1/visits/'+f.visitId+'/status',{token:f.desk,body:{status:'ARRIVED'}});
 await api.call('POST','/api/v1/visits/'+f.visitId+'/status',{token:f.desk,body:{status:'IN_CHAIR'}});
 await get('Receptionist checked in patient',f.desk);
 await confirmCare(api,f.dentist,f.visitId,100000);
 await get('Dentist confirmed 100 DT treatment',f.dentist);
 const paid=await api.call('POST','/api/v1/visits/'+f.visitId+'/payments',{token:f.desk,body:{amountMillimes:70000,tender:'CASH'}});
 if(paid.status!==201)throw Error('Payment failed '+JSON.stringify(paid.body));
 await get('Receptionist recorded 70 DT cash, owner can review 30 DT outstanding',f.owner);
 console.log(JSON.stringify({app:'EZZ Clinic v0.2 fictional only',mode:'local temporary PostgreSQL, no patients or live payments',
  result:trace,notVerified:['physical cash','patient actually paid','independent owner count','production fiscal receipt']},null,2));
}finally{
 if(api)await api.close();
 if(db)await db.drop();
}
