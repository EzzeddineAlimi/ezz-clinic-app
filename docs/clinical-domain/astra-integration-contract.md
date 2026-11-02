# EZZ Clinic — Astra clinical integration contract v0.1 (NONVISUAL)

> **Source reconciliation (2026-11-02):** B07 clinical endpoints are present on merged main; §1 distinguishes their actual route paths from historical proposals. This is documentation of fictional-data code, **not** clinician validation. The previous branch-only status was historical.

**Status: DRAFT / synthetic data only.** Not a clinical, legal, imaging-device or production approval. For future Astra frontend integration; **do not implement UI visuals here**. Extends existing `docs/clinical-domain/clinical-requirements.md` (see it for source citations, evidence tiers and Tunisian unknowns). New TypeScript helpers in `backend/src/contracts/clinical.ts` enforce only limited syntactic constraints; no clinical decision support.

## 1. Current backend contracts vs proposals (source-verified on main `301f8257376259b555481c446c923ce9cbebb12a`)

The earlier v0.2 **PROPOSED ONLY** table was not reconciled after B07 and later clinical work merged. These routes are present in `backend/src/modules/{clinical,medical,documents}.ts` on the cited main commit. They are **implemented fictional-data APIs**, not clinician-approved workflows or production readiness. See [clinical API details](../api/clinical-v1.md) and generated [OpenAPI](../api/openapi.json); never call an old proposed path as though it exists.

| Contract intent | Current implemented route(s) | Remaining boundary |
|---|---|---|
| Dentist encounter and longitudinal clinical read | `GET /api/v1/visits/:id/encounter`; `GET /api/v1/patients/:id/clinical-record` | The old `GET /api/v1/patients/:id/clinical-summary` is **not** a route. Clinical detail requires `clinical.read` (dentist). |
| Patient-declared medical alerts and dentist review | `GET/POST /api/v1/patients/:id/medical-alerts`; `GET /api/v1/patients/:id/medical-alerts/summary`; `POST /api/v1/medical-alerts/:id/revisions`; `POST /api/v1/patients/:id/medical-history-reviews` | The old `POST /api/v1/patients/:id/medical-history-assertions` is **not** a route. Reception sees only the restricted presence summary; a declaration is not a verified medical fact. |
| Current medical-alert acknowledgement | `POST /api/v1/visits/:id/alert-acknowledgements` | The old `POST /api/v1/visits/:id/medical-history-ack` is **not** a route. Dentist must acknowledge the current alert-set hash; stale hash is refused. |
| Findings and anatomical site history | `POST /api/v1/visits/:id/chart-findings`; `POST /api/v1/chart-findings/:id/entered-in-error`; clinical-record read above | The old `GET/POST /api/v1/patients/:id/odontogram-events` is **not** implemented. No complete tooth-state engine or clinically validated odontogram is claimed. |
| Signed notes and append-only corrections | `POST /api/v1/visits/:id/clinical-notes`; `POST /api/v1/clinical-notes/:id/addenda` | Authenticated dentist authorship and immutable correction history remain mandatory. |
| Treatment plans and confirmed care | `GET /api/v1/patients/:id/treatment-plan`; `POST /api/v1/patients/:id/treatment-plan-items`; `POST /api/v1/treatment-plan-items/:id/status`; `POST /api/v1/treatment-plan-items/:id/perform` | The old `POST /api/v1/patients/:id/treatment-plan-versions` is **not** implemented; do not infer immutable presented quote-version/consent behavior from plan items. |
| Document / image attachment lifecycle | `POST /api/v1/patients/:id/documents`; `POST /api/v1/documents/:id/content`; `POST /api/v1/documents/:id/screen`; `GET /api/v1/patients/:id/documents` | The old `POST /api/v1/visits/:id/attachment-metadata` is **not** a route. Existing structural screening is **not** production malware scanning, DICOM validation or diagnostic image approval. |
| Prescription authoring | **No implemented prescription-draft/signature route.** | The proposed `POST /api/v1/visits/:id/prescription-drafts` requires separately approved clinical/legal scope; never auto-sign or infer doses. |
| Clinical timeline | The clinical-record read above exposes recorded clinical information. | The proposed `GET /api/v1/visits/:id/clinical-timeline` is **not** a route; do not claim an independent timeline API. |

**Permissions and safety:** Server derives clinic, acting staff and roles from the authenticated session; cross-clinic records must not leak. An OWNER without the DENTIST role is not a clinical author. A same-clinic covering dentist may act on a colleague's visit while the signed author remains the actual dentist; see [founder authorship policy](../decisions/clinical-authorship.md) and [COVER tests](../testing/ISSUE7-DENTIST-COVER.md). The provisional FDI/surface terminology, imaging, prescription, consent, retention and Tunisian clinical/legal requirements still need qualified review. No new endpoint or clinical policy is authorized by this documentation correction.

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

**Same-clinic dentist cover:** Under the [founder authorship policy](../decisions/clinical-authorship.md), the scheduled dentist is not an exclusive clinical author. Another currently authenticated, authorized dentist in the same clinic may document and confirm care without an administrative reassignment or cover-approval screen. Signed entries and audit events retain the actual acting dentist, never the absent colleague's identity. Existing role, tenant and medical-alert gates still apply; this grants no CNAM eligibility, regulatory or billing authority. The dedicated PostgreSQL/API regression is `backend/test/clinical-dentist-cover.test.ts`; [evidence and remaining gates](../testing/ISSUE7-DENTIST-COVER.md).

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
