/* EZZ Clinic — proposed nonvisual clinical domain helpers for Astra.
 * Not a diagnosis engine; do not infer medical validity or treatment from tooth codes.
 * Clinical and Tunisian legal review required before release. */
export type Dentition = 'PRIMARY'|'MIXED'|'PERMANENT';
export type RecordKind = 'EXISTING'|'FINDING'|'PLANNED'|'COMPLETED';
export type ClinicalSite = {siteKind:'NONE'}|{siteKind:'TOOTH';toothFdi:number}|{siteKind:'AREA';areaCode:number};
export type ClinicalEvent = {
  clinicId:string;patientId:string;visitId:string;authorDentistId:string;
  recordedAt:string;recordKind:RecordKind;site:ClinicalSite;procedureLabel:string;
  correctionOfId?:string;status:'DRAFT'|'SIGNED'|'ENTERED_IN_ERROR';
};
// ISO 3950 FDI two-digit tooth notation (permanent Q1–4, primary Q5–8).
export function isValidFdiTooth(tooth:number):boolean{
 if(!Number.isSafeInteger(tooth))return false;
 const q=Math.floor(tooth/10),p=tooth%10;
 return q>=1&&q<=4?p>=1&&p<=8:q>=5&&q<=8&&p>=1&&p<=5;
}
const AREA_CODES=new Set([0,1,2,3,4,5,6,7,8,9,10,20,30,40]);
export function validateClinicalSite(site:ClinicalSite):boolean{
 if(site.siteKind==='NONE')return Object.keys(site).length===1;
 if(site.siteKind==='TOOTH')return Object.keys(site).length===2&&isValidFdiTooth(site.toothFdi);
 if(site.siteKind==='AREA')return Object.keys(site).length===2&&AREA_CODES.has(site.areaCode);
 return false;
}
export function fdiToUniversalDisplay(tooth:number):number|string{
 if(!isValidFdiTooth(tooth))throw new RangeError('Invalid FDI tooth code');
 const q=Math.floor(tooth/10),p=tooth%10;
 if(q===1)return 9-p;
 if(q===2)return 8+p;
 if(q===3)return 25-p;
 if(q===4)return 24+p;
 const letterIndex=q===5?6-p:q===6?5+p:q===7?16-p:15+p;
 return String.fromCharCode(64+letterIndex);
}
// Surface rules are provisional UX/domain constraints; dentist may override using a
// clinically reviewed future workflow. Do not silently alter or bill surfaces.
const ORDER='MOIDBFLP';
export function canonicalDentalSurfaces(tooth:number,input:string):string{
 if(!isValidFdiTooth(tooth))throw new RangeError('Invalid FDI tooth');
 if(typeof input!=='string')throw new TypeError('Surfaces must be a string');
 const raw=input.trim().toUpperCase(),q=Math.floor(tooth/10),p=tooth%10;
 if(raw.length===0||raw.length>5||![...raw].every(c=>ORDER.includes(c))||new Set(raw).size!==raw.length)
  throw new RangeError('Invalid, repeated or excessive tooth surfaces');
 const anterior=p<=3,maxillary=[1,2,5,6].includes(q);
 if(raw.includes('O')&&anterior)throw new RangeError('Occlusal only for posterior teeth');
 if(raw.includes('I')&&!anterior)throw new RangeError('Incisal only for anterior teeth');
 if(raw.includes('B')&&anterior)throw new RangeError('Facial F, not B, for anterior teeth');
 if(raw.includes('F')&&!anterior)throw new RangeError('Buccal B, not F, for posterior teeth');
 if(raw.includes('L')&&maxillary)throw new RangeError('Palatal P is used for maxillary teeth');
 if(raw.includes('P')&&!maxillary)throw new RangeError('Lingual L is used for mandibular teeth');
 return [...ORDER].filter(c=>raw.includes(c)).join('');
}