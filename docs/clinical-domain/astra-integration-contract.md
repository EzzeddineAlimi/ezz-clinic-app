# EZZ Clinic — Astra clinical integration contract v0.1 (NONVISUAL)

> **Update (B07, branch `claude/b07-clinical-core`):** several contracts in §1 are now implemented in draft form — medical alerts/history review/acknowledgement, signed clinical notes, chart findings, treatment plan items and the clinical timeline. See [`../api/clinical-v1.md`](../api/clinical-v1.md) and [`b07-clinical-core-status.md`](b07-clinical-core-status.md) for the exact routes and what remains proposed. The rest of this document is unchanged.

**Status: DRAFT / synthetic data only.** Not a clinical, legal, imaging-device or production approval. For future Astra frontend integration; **do not implement UI visuals here**. Extends existing `docs/clinical-domain/clinical-requirements.md` (see it for source citations, evidence tiers and Tunisian unknowns). New TypeScript helpers in `backend/src/contracts/clinical.ts` enforce only limited syntactic constraints; no clinical decision support.

## 1. Current implementation vs proposed endpoints

**Current in v0.2 branch (API behavior requires inspection):** patients, visits, dentist care confirmation, payment, receipt, paper-recovery and owner finance. Do not render hypothetical clinical endpoints as working.

**PROPOSED ONLY, not implemented/approved:**

| Contract | Writer / reader | Behavior; failure states |
|---|---|---|
| GET /api/v1/patients/:id/clinical-summary | dentist read; receptionist minimum-data check-in only | Must show explicit "never reviewed" medical-history state; 403 to unauthorized role; 404 cross-clinic |
| POST /api/v1/patients/:id/medical-history-assertions | patient/desk **draft**; dentist verifies | Immutable review version and original source; not an automatic clinical truth |
| POST /api/v1/visits/:id/medical-history-ack | authenticated dentist | Requires current alert-set version/hash; 409 if alerts changed |
| GET /api/v1/patients/:id/odontogram-events | dentist; receptionist limited viewing if authorized | Four event categories; never conflate past findings with billable work |
| POST /api/v1/patients/:id/odontogram-events | dentist; assistant drafts if policy approved | FDI site, author, source, recorded timestamp; corrections append new events |
| POST /api/v1/visits/:id/clinical-notes | dentist drafts/signs; assistant drafts without signing | Signed notes immutable; late entries/addenda linked with reasons |
| POST /api/v1/patients/:id/treatment-plan-versions | dentist author only | Draft/present/accept/decline/version; plan ≠ billable care |
| POST /api/v1/visits/:id/attachment-metadata | authorized dentist only | Attachment only after separately secured upload, malware scanning and permissions |
| POST /api/v1/visits/:id/prescription-drafts | dentist sign; assistant draft only | No automatic medication dose, no auto-sign or automated treatment |
| GET /api/v1/visits/:id/clinical-timeline | dentist; patient export requires consent+separate policy | Sort by immutable recorded date; distinguish corrected-in-error events |

**Implementation prohibition:** no client-written `clinicId`, actor roles or dentist confirmation; these come from server-authenticated session. New endpoints need a separate permission matrix, migration, audit event catalog, synthetic tests and qualified local clinical/legal validation.

## 2. Canonical nonvisual model

Proposed event envelope (not an existing storage table):

```json
{
  "clinicId": "SERVER_SESSION_ONLY",
  "patientId": "fictional-patient-uuid",
  "visitId": "fictional-visit-uuid",
  "recordKind": "FINDING",
  "site": { "siteKind": "TOOTH", "toothFdi": 36 },
  "surfaces": "MOD",
  "findingText": "Fictional finding; not a diagnosis",
  "source": "DENTIST_VERIFIED",
  "status": "SIGNED",
  "recordedAt": "2026-11-03T09:00:00Z",
  "authorDentistId": "SERVER_SESSION_ONLY"
}
```

- Site is **exactly one** of `NONE`, `TOOTH` (FDI code) or `AREA` (area code). Tooth ranges are permanent FDI quadrants 1–4 positions 1–8 and primary quadrants 5–8 positions 1–5.
- Keep `EXISTING`, `FINDING`, `PLANNED`, `COMPLETED` separate. Only completed authenticated care items can create a charge. A past crown or treatment plan must not be billed.
- Missing/unverified/supernumerary/retained primary teeth require explicit clinical status, not assumptions based on age. Do not auto-convert a primary extraction to a permanent present tooth.
- FDI-to-Universal in `clinical.ts` is *optional display conversion*, never the stored ID. No support for invented supernumerary notation.
- `canonicalDentalSurfaces` is a **provisional syntactic check**. FDI/surface mappings require a real Tunisian dentist before clinical release. No treatment recommendations.

## 3. Role and security expectations

| Action | Dentist | Receptionist | Owner without clinical role |
|---|---|---|---|
| Read minimum appointment/contact fields | Yes | Yes | Policy-specific |
| Read detailed medical history | Yes | Check-in questions / drafts only | No by default |
| Confirm completed treatment and fee | Yes, authenticated | Never | Only if also authenticated dentist |
| Record cash/card desk claim | Authorized policy | Yes | Yes |
| Verify owner cash count | Owner/counter only, blind | Never | Authorized owner |
| Draft note, plan, imaging attachment | Yes | Limited assistant draft only if explicitly approved | Not automatically |
| Sign clinical note/prescription | Dentist only | Never | Not automatically |
| Enter historical correction | Dentist new event + reason | No for clinical fields | Not automatically |

Keep permissions enforced on the server and by clinic-scoped DB constraints; hiding buttons is insufficient. Imaging and clinical notes must not appear in raw financial/audit logs or client error payloads.

## 4. Eight workflow contracts for Astra's later UI

1. **Elderly walk-in/no phone:** desk registers fictional patient and schedules visit in French or Arabic, prints paper information; no QR, smartphone, SMS or patient login required.
2. **Appointment arrives:** desk marks arrival, asks if medicine/health history changed and records a *patient-declared* answer; alerts remain unverified until dentist review.
3. **Dentist starts care:** authenticated dentist acknowledges current medical alerts; stale/never-asked state requires explicit acknowledgement and reason, no automatic approval.
4. **Odontogram:** dentist records a finding on FDI 36 surfaces MO and a pre-existing crown on tooth 26; only authenticated completed care becomes billable.
5. **Treatment alternatives:** dentist presents immutable plan v1, patient accepts one alternative using paper witnessed consent where appropriate; a change creates plan v2 and does not silently alter billed care.
6. **Clinical images:** dentist uploads an image/X-ray through an authorized, audited upload channel with validated metadata. Full image bytes are stored outside public logs; viewer cannot assert a diagnosis.
7. **Checkout:** desk records partial cash 70 DT against confirmed 100 DT care; balance remains 30 DT. Paper receipt can be printed; financial evidence tier remains explicit.
8. **Outage and correction:** during connection loss, staff use numbered paper slips; after recovery the system flags duplicate/conflicting/missing numbers. Signed notes/paid care are amended via linked events, never overwritten.

**Error/empty states:** not found, other clinic, role forbidden, history never reviewed, offline pending, conflicting update, uploaded file quarantined, missing paper number, card unverified, no dentist signature. Every state must be understandable in FR/AR and accessible at 200% zoom. Real RTL implementation is Astra's future concern; not coded here.

## 5. Open gates and evidence limits

- **CLINICAL:** oral charts, endodontic levels, allergy/medication flags, prescriptions, radiology rules, consent/minor handling require Tunisian dentist review. This document does not prescribe drugs or interpret X-rays.
- **PRIVACY:** lawful hosting, retention, access, health data transfer/AI usage, backups and patient export in Tunisia remain unverified. Never ship real patient data or images to public GitHub.
- **INTEGRATIONS:** DICOM and imaging import only if vendor permissions, modality and security requirements are independently tested. No live device or insurance integration approved.
- **FRAUD:** enforce server-side dentist authority, owner blind counting and external payment proof; no zero-theft claim. Plans/odontogram do not bypass financial audit.
- **CURRENT DEVELOPMENT:** branch is a domain contract and unit tests only. No new clinical API, image viewer, prescriptions, frontend or migrations were implemented. Do not imply otherwise.

**Handoff checkpoint:** Astra may design against these explicit workflows and error states, but all proposed API endpoints are subject to engineering review and founder V1 scope approval.
