/*
 * VISIT WORKBENCH: a read-only, tenant-scoped projection for the desk, dentist and owner.
 * Consistent single-statement financial snapshot. No direct writes or clinical claims.
 * CH-028: every balance reduction (correction, discount/write-off, refund, void) is listed with its
 * reason code so a zeroed visit never looks like explicitly free care. Free-text reasons/notes are
 * returned only to DENTIST/OWNER callers; other care.read roles see that a reason exists.
 */
import type { Actor, Route } from '../platform/http.ts';
import { fail } from '../platform/errors.ts';
import { isUuid } from '../platform/validate.ts';

type VisitStatus='SCHEDULED'|'ARRIVED'|'IN_CHAIR'|'COMPLETED'|'NO_SHOW'|'CANCELLED';
interface CaseRow {
  id:string; status:VisitStatus; scheduledAt:string; durationMin:number;
  patientId:string; fileNo:number; familyName:string; givenName:string;
  preferredLanguage:string; contactPreference:string;
  dentistId:string|null; dentistName:string|null;
  care:Array<Record<string,unknown>>; payments:Array<Record<string,unknown>>;
  adjustments:Array<Record<string,unknown>>;
  chargedMillimes:number; paidMillimes:number; reducedMillimes:number;
  returnedMillimes:number; careCount:number;
  correctionCount:number; correctionNetMillimes:number; freeCareCount:number;
}
interface Provenance { correctionCount:number; correctionNetMillimes:number; adjustmentCount:number;
  reducedMillimes:number; returnedMillimes:number; freeCareCount:number }
const seesFreeText=(actor:Actor)=>actor.roles.some(r=>r==='DENTIST'||r==='OWNER');
const isOwner=(actor:Actor)=>actor.roles.includes('OWNER');
function next(status:VisitStatus, careCount:number, balance:number, payments:Array<Record<string,unknown>>, charged:number, prov:Provenance):string {
  // CH-031: no API route can cancel a visit holding care or payments; if one does (privileged edit), say so.
  if(status==='CANCELLED'||status==='NO_SHOW') return careCount>0||payments.length>0?'OWNER_REVIEW_CLOSED_VISIT_WITH_RECORDS':'CLOSED_WITHOUT_CARE';
  if(careCount===0) {
    if(status==='SCHEDULED')return 'CHECK_IN';
    if(status==='ARRIVED')return 'MOVE_TO_CHAIR';
    return 'WAIT_FOR_DENTIST_CONFIRMATION';
  }
  if(balance>0)return 'RECORD_OR_FOLLOW_UP_PAYMENT';
  if(balance<0)return 'OWNER_REVIEW_CREDIT';
  if(payments.some(p=>p.tender==='CARD' && p.evidenceTier==='DESK_CLAIM'))return 'OWNER_REVIEW_CARD_CLAIM';
  if(payments.length===0) {
    // CH-028: only explicitly free care (fee 0 + reason, never reduced afterwards) needs no payment.
    if(charged===0&&prov.correctionCount===0&&prov.adjustmentCount===0)return 'VISIT_COMPLETE_NO_PAYMENT_REQUIRED';
    return 'OWNER_REVIEW_ZEROED_BALANCE';
  }
  // B10: every remaining payment is desk cash inside a drawer period the owner counted and closed. This says the
  // PERIOD was counted, not that each payment is verified (a count is drawer-level evidence).
  const active=payments.filter(p=>p.status!=='VOIDED'&&p.status!=='FULLY_REFUNDED');
  if(active.length>0&&active.every(p=>p.evidenceStatus==='DESK_CASH__DRAWER_PERIOD_COUNTED'))return 'CHECKOUT_RECORDED__CASH_PERIOD_COUNTED';
  // Recording a payment is not independent proof of physical cash/provider settlement.
  return 'CHECKOUT_RECORDED__RECONCILIATION_PENDING';
}
export const workbenchRoutes:Route[]=[{
  method:'GET',path:'/api/v1/visits/:id/workbench',
  // care.read is narrower than visit.read: assistants cannot access financial details.
  permission:'care.read',
  handler:async({tx,actor,params})=>{
    if(!isUuid(params.id!))fail('NOT_FOUND','Visit not found');
    const row=await tx.maybeOne<CaseRow>(`
SELECT v.id,v.status,v.scheduled_at AS "scheduledAt",v.duration_min AS "durationMin",
  p.id AS "patientId",p.file_no AS "fileNo",
  p.family_name AS "familyName",p.given_name AS "givenName",
  p.preferred_language AS "preferredLanguage",p.contact_preference AS "contactPreference",
  v.dentist_id AS "dentistId",d.display_name AS "dentistName",
  c.items AS care,c.item_count AS "careCount",q.items AS payments,j.items AS adjustments,
  c.correction_count AS "correctionCount",c.correction_net AS "correctionNetMillimes",c.free_care_count AS "freeCareCount",
  b.charged_millimes AS "chargedMillimes",b.paid_millimes AS "paidMillimes",
  b.reduced_millimes AS "reducedMillimes",b.returned_millimes AS "returnedMillimes"
FROM visits v
JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id
JOIN visit_balances b ON b.visit_id=v.id
LEFT JOIN staff d ON d.clinic_id=v.clinic_id AND d.id=v.dentist_id
CROSS JOIN LATERAL (
  SELECT count(*)::int AS item_count,
    count(*) FILTER(WHERE i.kind='CORRECTION')::int AS correction_count,
    coalesce(sum(i.fee_millimes) FILTER(WHERE i.kind='CORRECTION'),0)::bigint AS correction_net,
    count(*) FILTER(WHERE i.kind='CARE' AND i.fee_millimes=0)::int AS free_care_count,
    coalesce(jsonb_agg(jsonb_build_object(
      'id',i.id,'kind',i.kind,'correctsId',i.corrects_id,'procedureCode',i.procedure_code,'procedureLabel',i.procedure_label,
      'toothFdi',i.tooth_fdi,'surfaces',i.surfaces,'feeMillimes',i.fee_millimes,
      'hasReason',i.reason IS NOT NULL,'confirmedAt',i.confirmed_at,'confirmedByName',s.display_name
    )||CASE WHEN $3::boolean THEN jsonb_build_object('reason',i.reason) ELSE '{}'::jsonb END
    ORDER BY i.confirmed_at,i.id) FILTER(WHERE i.id IS NOT NULL),'[]'::jsonb) AS items
  FROM care_items i LEFT JOIN staff s ON s.clinic_id=i.clinic_id AND s.id=i.confirmed_by
  WHERE i.clinic_id=v.clinic_id AND i.visit_id=v.id
) c
CROSS JOIN LATERAL (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',pay.id,'amountMillimes',pay.amount_millimes,
    'tender',pay.tender,'source',pay.source,'recordedAt',pay.recorded_at,
    'receiptId',rc.id,'receiptLabel',CASE WHEN rc.id IS NULL THEN NULL
      ELSE rc.series||'-'||lpad(rc.number::text,6,'0') END,
    'evidenceTier',CASE WHEN pay.tender='CARD' THEN coalesce(cm.evidence_tier,'DESK_CLAIM') ELSE NULL END,
    'evidenceStatus',CASE
      WHEN pay.tender='CARD' AND cm.evidence_tier='OWNER_REVIEWED_STATEMENT'
        THEN 'OWNER_REVIEWED_STATEMENT__NOT_PROVIDER_VERIFIED'
      WHEN pay.tender='CARD' THEN 'DESK_CLAIM__OWNER_PROOF_SEPARATE'
      WHEN pay.source='PAPER_OUTAGE' THEN 'PAPER_ENTRY__PHYSICAL_EVIDENCE_REQUIRED'
      WHEN per.status='CLOSED' THEN 'DESK_CASH__DRAWER_PERIOD_COUNTED'
      ELSE 'DESK_CASH__INDEPENDENT_COUNT_REQUIRED' END,
    'cashPeriod',CASE WHEN pay.tender<>'CASH' OR per.period_no IS NULL THEN NULL
      ELSE jsonb_build_object('periodNo',per.period_no,'status',CASE WHEN per.status='CLOSED' THEN 'COUNTED_AND_CLOSED' ELSE 'OPEN' END)
        ||CASE WHEN $4::boolean AND per.status='CLOSED' THEN jsonb_build_object('periodDifferenceMillimes',per.difference_millimes,'countIndependent',per.counter_independent) ELSE '{}'::jsonb END END,
    'returnedMillimes',coalesce(adj.amount,0),
    'status',CASE WHEN adj.voided THEN 'VOIDED' WHEN adj.amount>=pay.amount_millimes THEN 'FULLY_REFUNDED'
      WHEN adj.amount>0 THEN 'PARTLY_RETURNED' ELSE 'ACTIVE' END
  ) ORDER BY pay.recorded_at,pay.id) FILTER(WHERE pay.id IS NOT NULL),'[]'::jsonb) AS items
  FROM payments pay
  LEFT JOIN receipts rc ON rc.clinic_id=pay.clinic_id AND rc.payment_id=pay.id
  LEFT JOIN card_matches cm ON cm.clinic_id=pay.clinic_id AND cm.payment_id=pay.id
  -- The drawer period that covered this cash payment BY TIME (same window rule as expected cash): a payment
  -- recorded after the accepted count belongs to the next period even if its cash_period_id is the old one.
  LEFT JOIN LATERAL (
    SELECT cp.period_no,cp.status,cc.difference_millimes,cc.counter_independent
    FROM cash_periods cp LEFT JOIN cash_counts cc ON cc.clinic_id=cp.clinic_id AND cc.id=cp.accepted_count_id
    WHERE pay.tender='CASH' AND cp.clinic_id=pay.clinic_id AND cp.opened_at<pay.recorded_at
      AND (cp.cutoff_at IS NULL OR pay.recorded_at<=cp.cutoff_at)
    ORDER BY cp.period_no DESC LIMIT 1
  ) per ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(a.amount_millimes),0)::bigint AS amount,bool_or(a.kind='PAYMENT_VOID') AS voided
    FROM adjustments a WHERE a.clinic_id=pay.clinic_id AND a.payment_id=pay.id
      AND a.kind IN ('REFUND','PAYMENT_VOID')
  ) adj ON true
  WHERE pay.clinic_id=v.clinic_id AND pay.visit_id=v.id
) q
CROSS JOIN LATERAL (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',a.id,'kind',a.kind,'amountMillimes',a.amount_millimes,'reasonCode',a.reason_code,
    'paymentId',a.payment_id,'tender',a.tender,'authorizedRole',a.authorized_role,
    'authorizedByName',st.display_name,'createdAt',a.created_at,
    'receiptLabel',CASE WHEN ar.id IS NULL THEN NULL ELSE ar.series||'-'||lpad(ar.number::text,6,'0') END
  )||CASE WHEN $3::boolean THEN jsonb_build_object('reasonNote',a.reason_note) ELSE '{}'::jsonb END
  ORDER BY a.created_at,a.id) FILTER(WHERE a.id IS NOT NULL),'[]'::jsonb) AS items
  FROM adjustments a
  LEFT JOIN staff st ON st.clinic_id=a.clinic_id AND st.id=a.authorized_by
  LEFT JOIN receipts ar ON ar.clinic_id=a.clinic_id AND ar.adjustment_id=a.id
  WHERE a.clinic_id=v.clinic_id AND a.visit_id=v.id
) j
WHERE v.id=$1 AND v.clinic_id=$2
`,[params.id!,tx.clinicId,seesFreeText(actor!),isOwner(actor!)]);
    if(!row)fail('NOT_FOUND','Visit not found');
    // The current error helper does not carry a TypeScript never return annotation.
    const record = row!;
    const balance=record.chargedMillimes-record.paidMillimes-record.reducedMillimes+record.returnedMillimes;
    const provenance:Provenance={correctionCount:record.correctionCount,correctionNetMillimes:record.correctionNetMillimes,
      adjustmentCount:record.adjustments.filter(a=>a.kind==='DISCOUNT'||a.kind==='WRITE_OFF').length,
      reducedMillimes:record.reducedMillimes,returnedMillimes:record.returnedMillimes,freeCareCount:record.freeCareCount};
    return {status:200,body:{
      visit:{
        id:record.id,status:record.status,scheduledAt:record.scheduledAt,durationMin:record.durationMin,
        patient:{id:record.patientId,fileNo:record.fileNo,familyName:record.familyName,
          givenName:record.givenName,preferredLanguage:record.preferredLanguage,
          contactPreference:record.contactPreference},
        dentist:record.dentistId?{id:record.dentistId,name:record.dentistName}:null,
        care:record.care,payments:record.payments,adjustments:record.adjustments,provenance,
        balance:{chargedMillimes:record.chargedMillimes,paidMillimes:record.paidMillimes,
          reducedMillimes:record.reducedMillimes,returnedMillimes:record.returnedMillimes,
          balanceMillimes:balance,careConfirmed:record.careCount>0},
        nextAction:next(record.status,record.careCount,balance,record.payments,record.chargedMillimes,provenance)
      },
      evidenceNotice:'Cash requires independent counting; cards need separately reviewed external evidence. Recorded amounts are claims.',
      syntheticDataOnly:true
    }};
  }
}];