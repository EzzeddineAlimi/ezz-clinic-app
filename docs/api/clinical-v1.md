# EZZ Clinic API v1 — dentist clinical core (B07, fictional-data build)

**Status: DRAFT, synthetic data only, not for clinical use.** Implemented on branch `claude/b07-clinical-core` (draft PR, stacked on the CH-028 workbench fix, which is stacked on PR #10). Examples are real responses captured by `backend/scripts/demo-dentist-encounter.ts` against PostgreSQL 16 (ids/hashes shortened). Conventions are those of [`api-v1.md`](api-v1.md): JSON only, Bearer session, **Idempotency-Key on every write**, identity and clinic from the session only, cross-clinic ids → 404, money in integer millimes.

Clinical vocabulary (alert codes, surface letter rules, condition codes, plan phases, review interval) is **PROVISIONAL** and must be confirmed by a practising Tunisian dentist before any clinical use — see [`../clinical-domain/b07-clinical-core-status.md`](../clinical-domain/b07-clinical-core-status.md).

## Endpoints

| Method | Path | Permission (roles) | Idempotency-Key |
|---|---|---|:-:|
| GET | `/api/v1/visits/:id/encounter` | `clinical.read` (DENTIST) | — |
| GET | `/api/v1/patients/:id/clinical-record` | `clinical.read` (DENTIST) | — |
| GET | `/api/v1/patients/:id/treatment-plan` | `clinical.read` (DENTIST) | — |
| GET | `/api/v1/patients/:id/medical-alerts[?history=true]` | `clinical.read` (DENTIST) | — |
| GET | `/api/v1/patients/:id/medical-alerts/summary` | `medical.alert_presence` (DENTIST, RECEPTIONIST, ASSISTANT) | — |
| POST | `/api/v1/patients/:id/medical-alerts` | `medical.declare` (DENTIST, RECEPTIONIST, ASSISTANT) | required |
| POST | `/api/v1/medical-alerts/:id/revisions` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/patients/:id/medical-history-reviews` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/visits/:id/alert-acknowledgements` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/visits/:id/clinical-notes` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/clinical-notes/:id/addenda` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/visits/:id/chart-findings` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/chart-findings/:id/entered-in-error` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/patients/:id/treatment-plan-items` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/treatment-plan-items/:id/status` | `clinical.write` (DENTIST) | required |
| POST | `/api/v1/treatment-plan-items/:id/perform` | `care.confirm` (DENTIST) | required |
| POST | `/api/v1/care-items/:id/site-amendments` | `care.amend_site` (DENTIST) | required |
| POST | `/api/v1/visits/:id/care` *(changed)* | `care.confirm` (DENTIST) | required |

A person holding OWNER+DENTIST gets the union. A non-clinician OWNER and the RECEPTIONIST get **403** on every clinical detail route; the desk gets only the presence summary. ASSISTANT access to clinical detail is a pending policy decision (currently none).

## Request bodies

- **Dental site** (care, amendment, finding, plan item): `toothFdi` integer FDI code (11–48, 51–85) or `null`; `surfaces` string of letters `M O I D B F L P`, any case/order (`"dom"` → stored `"MOD"`), **requires a tooth**, no repeated letter, provisional anatomy rules (O/B posterior only, I/F anterior only, P maxillary, L mandibular). Invalid → `400 VALIDATION_FAILED` with `details.field`.
- **Care** `POST /visits/:id/care`: unchanged fields plus optional `alertSetHash` (64 hex). If the patient has ACTIVE alerts, either the visit already has an acknowledgement for the current set, or `alertSetHash` must equal the current hash (recorded as an implicit acknowledgement). A supplied stale hash is always refused.
- **Declare alert**: `{code, severity: CRITICAL|CAUTION, detail?}`; `code` ∈ `ALLERGY_PENICILLIN, ALLERGY_LATEX, ALLERGY_LOCAL_ANAESTHETIC, ALLERGY_OTHER, ANTICOAGULANT_VKA, ANTICOAGULANT_DOAC, ANTIPLATELET, ANTIRESORPTIVE_OR_ANTIANGIOGENIC, PREGNANCY, DIABETES, CARDIAC_IE_HIGH_RISK, IMMUNOSUPPRESSION, HEAD_NECK_RADIOTHERAPY, BLEEDING_DISORDER, EPILEPSY, OTHER` (`OTHER` needs `detail`). Desk/assistant entries are `PATIENT_DECLARED` and the response is only `{declared, alertId, source, recordedAt, note}`; dentist entries are `DENTIST_VERIFIED` and return the alert.
- **Alert revision**: `{action: VERIFY|UPDATE|RESOLVE|ENTERED_IN_ERROR, expectedRevision, severity?, detail?, reason?}` (`reason` required for RESOLVE / ENTERED_IN_ERROR). Stale `expectedRevision` → `409` with `currentRevision`.
- **History review**: `{method: INTERVIEW|PAPER_FORM, noKnownAllergies: boolean, alertSetHash, visitId?, note?, nextReviewInMonths? (1-24, default 12)}`. `noKnownAllergies: true` is refused while an allergy alert is ACTIVE. With `visitId` and active alerts it also acknowledges them for that visit.
- **Acknowledgement**: `{alertSetHash}`.
- **Note**: `{subjective?, objective?, assessment?, plan?}` (≥1, each ≤4000 chars) for `kind` `NOTE` (default) or `LATE_ENTRY` (+ `effectiveAt` in the past + `reason`). **Addendum**: `{kind: ADDENDUM, <sections>}` or `{kind: ENTERED_IN_ERROR, reason}` (no text; once per note).
- **Finding**: `{kind: EXISTING|FINDING, toothFdi + surfaces? | areaCode (0-10, 20, 30, 40), conditionCode (^[A-Z][A-Z0-9_]{1,40}$), note?}` — exactly one of tooth / area. **Strike**: `{reason}`.
- **Plan item**: `{procedureCode, procedureLabel, <site>, phaseNo? (1-4, default 2), estimatedFeeMillimes?, note?, visitId?}`. **Status**: `{status: ACCEPTED|DECLINED|CANCELLED, reason?}` (reason required except ACCEPTED). **Perform**: `{visitId, feeMillimes? (default = estimate), <site>? (default = planned site), alertSetHash?, reason?, confirmRepeat?}`.
- **Site amendment**: `{toothFdi, surfaces?, reasonCode: WRONG_TOOTH|WRONG_SURFACE|WRONG_TOOTH_AND_SURFACE|TRANSCRIPTION|OTHER, reasonNote? (required for OTHER), expectedSupersedesId: uuid|null}`. Any `feeMillimes`/`deltaMillimes` → 400. Fee-neutral by construction (no money column).

## New error codes (all 409)

`MEDICAL_ALERTS_NOT_ACKNOWLEDGED` (details: `alertSetHash`, counts), `MEDICAL_ALERTS_CHANGED` (details: current `alertSetHash`), `SITE_AMENDMENT_STALE` (details: `currentHeadId`), `SITE_UNCHANGED`, `PLAN_ITEM_CLOSED` (details: `status`). Also `409 CONFLICT` when the desk tries to cancel / no-show a visit the dentist already documented (note or finding).

## Behaviour changes to existing routes

- `POST /visits/:id/care`: shared site validator (CH-032); canonical storage; duplicate guard on the *effective canonical* site (`DOM` after `MOD` now needs `confirmRepeat`); medical-alert gate.
- `POST /care-items/:id/corrections`: the correction row now carries the item's effective (amended) site.
- `GET /visits/:id/care`: CARE rows add `effectiveToothFdi`, `effectiveSurfaces`, `amendmentCount`, `siteAmended`, `siteAmendments[]`. RECEPTIONIST callers get `hasReason`/`hasNote` instead of free-text `reason`/`reasonNote`.
- `GET /visits/:id/workbench`: CARE rows add the same effective-site fields; `provenance.siteAmendmentCount` (CH-028 fields are documented in `docs/product/visit-workbench.md`).
- `POST /visits/:id/status`: NO_SHOW / CANCELLED refused once a signed note or chart finding exists for the visit (CH-018).

## Captured examples

Desk presence summary after declaring an alert (no code, no detail):

```json
{"patientId":"58702f9a…","activeAlertCount":1,"criticalAlertCount":1,"unverifiedAlertCount":1,
 "allergyStatus":"NOT_RECORDED","reviewStatus":"NEVER_REVIEWED",
 "instruction":"Medical alert on file: the dentist must see it before treatment."}
```

Dentist opens the visit — `GET /visits/:id/encounter` (abridged):

```json
{"visit":{"id":"8b5b2af4…","status":"ARRIVED","scheduledAt":"2026-10-28T09:00:00.000Z","dentistName":"Fictional dentist"},
 "patient":{"fileNo":1,"familyName":"Fictif","givenName":"Amel","preferredLanguage":"fr"},
 "medical":{"activeAlerts":[{"id":"784fd4eb…","revision":1,"code":"ANTICOAGULANT_VKA","severity":"CRITICAL",
   "detail":"Fictional: patient says takes a blood thinner","source":"PATIENT_DECLARED","recordedByName":"Fictional desk","recordedRole":"RECEPTIONIST"}],
  "alertSetHash":"9224d1f69a3f…","reviewStatus":"NEVER_REVIEWED","allergyStatus":"NOT_RECORDED","lastReview":null,
  "acknowledgedForVisit":false,"treatmentGate":"SEND_ALERT_SET_HASH_WITH_CARE_OR_ACKNOWLEDGE"},
 "care":[],"notes":[],"findings":[],"planItems":[],"history":{"completedVisitCount":0,"lastCompletedVisitAt":null},"syntheticDataOnly":true}
```

Care before the alerts were seen → `409`:

```json
{"error":{"code":"MEDICAL_ALERTS_NOT_ACKNOWLEDGED","message":"This patient has medical alerts; review them before confirming treatment",
 "details":{"alertSetHash":"9224d1f69a3f…","activeAlertCount":1,"criticalAlertCount":1}}}
```

Perform a planned item (`{"visitId":"8b5b2af4…"}`) → `201`, care item + plan completion in one transaction:

```json
{"careItem":{"id":"c77572a3…","kind":"CARE","procedureCode":"RESTO","toothFdi":36,"surfaces":"MO","feeMillimes":80000,"confirmedBy":"6def3941…"},
 "visitTotalMillimes":80000,
 "planItem":{"id":"10af33c9…","status":"COMPLETED","careItemId":"c77572a3…","estimatedFeeMillimes":80000,
   "events":[{"seq":1,"status":"COMPLETED","careItemId":"c77572a3…","byName":"Fictional dentist"}]},
 "quoteVsCharged":{"estimatedFeeMillimes":80000,"chargedFeeMillimes":80000,"differenceMillimes":0}}
```

Site amendment after a partial payment (`{"toothFdi":36,"surfaces":"DO","reasonCode":"WRONG_SURFACE","expectedSupersedesId":null}`) → `201`; total unchanged:

```json
{"siteAmendment":{"id":"783089d0…","careItemId":"c77572a3…","supersedesId":null,
  "previousSite":{"toothFdi":36,"surfaces":"MO"},"newSite":{"toothFdi":36,"surfaces":"OD"},
  "reasonCode":"WRONG_SURFACE","reasonNote":null,"amendedByName":"Fictional dentist"},
 "effectiveSite":{"toothFdi":36,"surfaces":"OD"},"visitTotalMillimes":80000}
```

The receptionist calling `GET /patients/:id/clinical-record` gets `403 FORBIDDEN_ROLE`.

## Notes for the frontend (Astra)

- Echo `medical.alertSetHash` from the encounter screen in the care / perform request: zero extra taps when the dentist has the alerts on screen, and a `MEDICAL_ALERTS_CHANGED` refresh if the desk added one meanwhile.
- Show the **effective** site everywhere and the original + amendment history on demand; never present an amendment as a new procedure.
- Struck notes/findings stay visible to the dentist with the reason (strike-through), and are excluded from the tooth view.
- All status strings are stable codes; FR/AR labels belong to the frontend glossary (Arabic wording must be reviewed by a native speaker).
