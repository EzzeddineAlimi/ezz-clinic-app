/*
 * VISIT WORKBENCH: a read-only, tenant-scoped projection for the desk, dentist and owner.
 * Consistent single-statement financial snapshot. No direct writes or clinical claims.
 */
import type { Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { isUuid } from '../platform/validate.ts';

type VisitStatus='SCHEDULED'|'ARRIVED'|'IN_CHAIR'|'COMPLETED'|'NO_SHOW'|'CANCELLED';
interface CaseRow {
  id:string; status:VisitStatus; scheduledAt:string; durationMin:number;
  patientId:string; fileNo:number; familyName:string; givenName:string;
  preferredLanguage:string; contactPreference:string;
  dentistId:string|null; dentistName:string|null;
  care:Array<Record<string,unknown>>; payments:Array<Record<string,unknown>>;
  chargedMillimes:number; paidMillimes:number; reducedMillimes:number;
  returnedMillimes:number; careCount:number;
}
function next(status:VisitStatus, careCount:number, balance:number):string {
  if(status==='CANCELLED'||status==='NO_SHOW') return 'CLOSED_WITHOUT_CARE';
  if(careCount===0) {
    if(status==='SCHEDULED')return 'CHECK_IN';
    if(status==='ARRIVED')return 'MOVE_TO_CHAIR';
    return 'WAIT_FOR_DENTIST_CONFIRMATION';
  }
  if(balance>0)return 'RECORD_OR_FOLLOW_UP_PAYMENT';
  if(balance<0)return 'OWNER_REVIEW_CREDIT';
  return 'VISIT_COMPLETE';
}
export const workbenchRoutes:Route[]=[{
  method:'GET',path:'/api/v1/visits/:id/workbench',
  // care.read is narrower than visit.read: assistants cannot access financial details.
  permission:'care.read',
  handler:async({tx,params})=>{
    if(!isUuid(params.id!))fail('NOT_FOUND','Visit not found');
    const row=await tx.maybeOne<CaseRow>(`
SELECT v.id,v.status,v.scheduled_at AS "scheduledAt",v.duration_min AS "durationMin",
  p.id AS "patientId",p.file_no AS "fileNo",
  p.family_name AS "familyName",p.given_name AS "givenName",
  p.preferred_language AS "preferredLanguage",p.contact_preference AS "contactPreference",
  v.dentist_id AS "dentistId",d.display_name AS "dentistName",
  c.items AS care,c.item_count AS "careCount",q.items AS payments,
  b.charged_millimes AS "chargedMillimes",b.paid_millimes AS "paidMillimes",
  b.reduced_millimes AS "reducedMillimes",b.returned_millimes AS "returnedMillimes"
FROM visits v
JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
JOIN visit_balances b ON b.visit_id=v.id
LEFT JOIN staff d ON d.clinic_id=v.clinic_id AND d.id=v.dentist_id
CROSS JOIN LATERAL (
  SELECT count(*)::int AS item_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',i.id,'kind',i.kind,'procedureCode',i.procedure_code,'procedureLabel',i.procedure_label,
      'toothFdi',i.tooth_fdi,'surfaces',i.surfaces,'feeMillimes',i.fee_millimes,
      'confirmedAt',i.confirmed_at,'confirmedByName',s.display_name
    ) ORDER BY i.confirmed_at,i.id) FILTER(WHERE i.id IS NOT NULL),'[]'::jsonb) AS items
  FROM care_items i LEFT JOIN staff s ON s.clinic_id=i.clinic_id AND s.id=i.confirmed_by
  WHERE i.clinic_id=v.clinic_id AND i.visit_id=v.id
) c
CROSS JOIN LATERAL (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',pay.id,'amountMillimes',pay.amount_millimes,
    'tender',pay.tender,'source',pay.source,'recordedAt',pay.recorded_at,
    'receiptId',rc.id,'receiptLabel',CASE WHEN rc.id IS NULL THEN NULL
      ELSE rc.series||'-'||lpad(rc.number::text,6,'0') END,
    'evidenceStatus',CASE WHEN pay.tender='CARD' THEN 'DESK_CLAIM__OWNER_PROOF_SEPARATE'
      WHEN pay.source='PAPER_OUTAGE' THEN 'PAPER_ENTRY__PHYSICAL_EVIDENCE_REQUIRED'
      ELSE 'DESK_CASH__INDEPENDENT_COUNT_REQUIRED' END,
    'returnedMillimes',coalesce(adj.amount,0)
  ) ORDER BY pay.recorded_at,pay.id) FILTER(WHERE pay.id IS NOT NULL),'[]'::jsonb) AS items
  FROM payments pay
  LEFT JOIN receipts rc ON rc.clinic_id=pay.clinic_id AND rc.payment_id=pay.id
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(a.amount_millimes),0)::bigint AS amount
    FROM adjustments a WHERE a.clinic_id=pay.clinic_id AND a.payment_id=pay.id
      AND a.kind IN ('REFUND','PAYMENT_VOID')
  ) adj ON true
  WHERE pay.clinic_id=v.clinic_id AND pay.visit_id=v.id
) q
WHERE v.id=$1 AND v.clinic_id=$2
`,[params.id!,tx.clinicId]);
    if(!row)fail('NOT_FOUND','Visit not found');
    // The current error helper does not carry a TypeScript never return annotation.
    const record = row!;
    const balance=record.chargedMillimes-record.paidMillimes-record.reducedMillimes+record.returnedMillimes;
    return {status:200,body:{
      visit:{
        id:record.id,status:record.status,scheduledAt:record.scheduledAt,durationMin:record.durationMin,
        patient:{id:record.patientId,fileNo:record.fileNo,familyName:record.familyName,
          givenName:record.givenName,preferredLanguage:record.preferredLanguage,
          contactPreference:record.contactPreference},
        dentist:record.dentistId?{id:record.dentistId,name:record.dentistName}:null,
        care:record.care,payments:record.payments,
        balance:{chargedMillimes:record.chargedMillimes,paidMillimes:record.paidMillimes,
          reducedMillimes:record.reducedMillimes,returnedMillimes:record.returnedMillimes,
          balanceMillimes:balance,careConfirmed:record.careCount>0},
        nextAction:next(record.status,record.careCount,balance)
      },
      evidenceNotice:'Cash requires independent counting; cards need separately reviewed external evidence. Recorded amounts are claims.',
      syntheticDataOnly:true
    }};
  }
}];