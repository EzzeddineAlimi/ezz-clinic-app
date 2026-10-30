# CNAM paper-dossier backend slice — issue #67

Development contract, fictional data only. This is **local administrative preparation data**, not an official bulletin, valid CNAM submission, eligibility check, fiscal invoice or reimbursement calculation. Frontend implementation remains GPT-owned. Source: `backend/src/modules/cnam.ts`, migration `0015_cnam_paper_dossiers.sql`; recorded real-API examples: `docs/api/examples/cnam-paper.json`; generated routes: `openapi.json` and `endpoints.md`.

## Permissions and source of truth

| Action | OWNER | DENTIST | RECEPTIONIST | ASSISTANT |
|---|---|---|---|---|
| Read, prepare, issue local data, request copy, report handoff/outcome | Yes | Yes | Yes | No |
| Append corrected preparation version | No | Own signed acts only | No | No |

These are scoped administrative permissions, subject to independent privacy/security review before merge. They never authorize a clinical signature, change another dentist's care or broaden document/clinical-note permissions. A correction must contain only the authenticated dentist's acts in **both** the old and new version. Multi-practitioner preparation is supported; correction of such a dossier deliberately fails closed pending a separately reviewed coordination policy. A combined OWNER+DENTIST has dentist authority only for their own acts. Roles and clinic come from the session, not request data. Every table has FORCE tenant RLS, composite clinic FKs, append-only triggers and SELECT/INSERT-only application grants.

## Request flow

Every POST requires an `Idempotency-Key` under the existing HTTP contract. Retain the exact key/body for an uncertain retry. Reused keys with changed bodies fail `IDEMPOTENCY_KEY_REUSED`. The existing replay response may add `replayed: true`. Unknown body fields, including signatures/stamps and unverified official flags, are rejected.

1. `POST /api/v1/cnam/dossiers`

   ```json
   {
     "patientId": "<patient UUID>",
     "lines": [{ "careItemId": "<signed CARE UUID>", "dentistId": "<actual author UUID>", "feeMillimes": 120001 }],
     "affiliation": { "identifier": "FICTIONAL-CNAM-ONLY", "insuredName": "شخص افتراضي", "scheme": "UNKNOWN", "source": "PATIENT_REPORTED" }
   }
   ```

   `affiliation` is optional/null; scheme is CNSS/CNRPS/UNKNOWN, source PATIENT_REPORTED/STAFF_REPORTED. These are optional administrative labels, **not official required form fields or eligibility**. Missing unknown identifiers do not block preparation. `officiallyVerified` is always false. No CIN, stamp, signature, form template or document image is stored by this module. Text supports FR/Arabic Unicode; no smartphone is required.

   One to 100 distinct signed CARE references. Inputs must match the current server patient, original confirmed dentist and original fee plus all signed fee corrections exactly. The server derives procedure label/local code, effective FDI tooth/surfaces, amendment/correction IDs, clinic timezone, visit scheduled instant, care confirmation instant and name. A CARE row's `confirmed_at` is a recording/sign-off time; `careRecordedLocalDate` is **not asserted to be an independently verified historical treatment date**. No deadline is calculated from it. Local procedure codes are **not CNAM nomenclature**. Missing FDI is preserved as null, not guessed.

   Result: 201 `{dossier}` in PREPARING; 200 `{dossier,recoveredExisting:true}` for the same creation snapshot with a lost/different key. Patient identity/affiliation is snapshotted, not silently refreshed later. A recovered root may now have a newer version: always inspect `currentVersion` and `state`.

2. `GET /api/v1/cnam/dossiers?patientId=<UUID>` finds up to the 100 newest dossier IDs/current versions/states for that patient. This bounded first slice is not the CNAM backlog/reporting module or a paginated full export. Retain dossier IDs; `GET /api/v1/cnam/dossiers/:id` returns every immutable version and event, including server issue/copy IDs and actor/timestamps, for recovery after reload/login/restart. Future extensive-history pagination is a remaining acceptance gap.

3. `POST /api/v1/cnam/dossiers/:id/issue` with `{ "expectedVersion": 1 }` rechecks the current snapshot against locked care, current patient and payment data. Changed source → 409, requiring a reasoned corrected preparation. It reserves each act to this dossier, appends one issue event and moves to READY_FOR_PAPER_REVIEW. The server number is `CNAM-<dossier UUID>-v<version>`: a **local preparation reference**, not an official BS1 or fiscal number. New-key retries recover the same issue, even after a process crash; they do not silently create another issue. This does **not** assert paper printing, delivery, wet signature/stamp or official acceptance.

4. `POST /api/v1/cnam/dossiers/:id/copies` with `{ "expectedVersion": 1 }` returns `{copy,snapshot}` with COPY, consecutive server `copyNumber`, `snapshotHash`, event ID/actor/time, `printing: "NOT_VERIFIED"`, `paperDelivery: "UNKNOWN"`. A successful request means preparation of copy data only. Same-key replay returns the same copy; a deliberate new-key request records another copy. It cannot change an issued snapshot. Copies are available for the current issued version only; older immutable data remains in GET history, but audited obsolete-version reprinting needs a future explicit policy.

5. `POST /api/v1/cnam/dossiers/:id/handoff` with `{ "expectedVersion": 1, "handedToPatientReported": true }` appends one STAFF_REPORTED, `independentlyVerified:false` handoff; state becomes HANDED_TO_PATIENT. The local version reference also identifies this handoff. New-key retries recover the existing handoff. No report pretends to prove physical delivery or dentist wet signature. The paper workflow still requires actual physical dentist review/signature/stamp under validated official rules.

6. `POST /api/v1/cnam/dossiers/:id/corrections` accepts the create fields plus `expectedVersion` and a 3–300 character `reason`. Patient cannot change. Only the actual signed-care dentist may do this (see policy above). It appends the next PREPARING version, preserving every older snapshot, original date, issue, report and copy. The next version must be separately issued. Acts issued previously remain reserved to the same root even if removed later; no automatic release/duplicate-override policy is invented.

7. Optional `POST /api/v1/cnam/dossiers/:id/reports` after reported handoff:

   ```json
   { "expectedVersion": 1, "status": "REIMBURSED", "source": "PATIENT_REPORTED", "consentAcknowledged": true, "amountMillimes": 12345, "note": "Fictional patient report only" }
   ```

   Status is SUBMITTED/REJECTED/REIMBURSED; source PATIENT_REPORTED/STAFF_REPORTED. Only REIMBURSED accepts an integer amount (zero allowed); other statuses reject an amount. A true consent acknowledgement is a **staff-attested acknowledgement on this report**, not validated legal consent evidence or a reusable authorization to contact the patient. Every report preserves actor/server time/source and `officiallyVerified:false`, `payee:"PATIENT"`. It does not advance the preparation/handoff state or fabricate a CNAM decision. Distinct reports append facts rather than overwrite previous claims. No official external verification grade is accepted. This first slice stores no attachments/deposit proofs or CNAM integrations.

## Financial and concurrency invariants

- All amount fields are safe integer millimes. Fees derive from authenticated CARE and its corrections; this backend has a visit ledger rather than a standalone invoice-line object. No false claim of a complete BS1↔invoice-line integration is made.
- Per-visit charged/paid/reduced/returned sums and server receipt/payment IDs are read-only snapshots. Unpaid balance produces `CLINIC_BALANCE_OUTSTANDING`, not an eligibility/invalid-claim assertion. Payment after PREPARING requires refreshed preparation before issue. A later payment never rewrites already-issued data; the snapshot is historical, not a live balance.
- This module never writes payments, allocations, receipts, counters, adjustments, cash periods or clinical care. Patient reimbursement reports are not revenue, cash, bank settlement, a patient balance reduction or a clinic receivable.
- One transaction-scoped `cnam:<clinic UUID>` advisory lock serializes CNAM writers, then sorted visit locks exclude existing clinical/financial writers before source capture/issue. Unique DB guards protect creation hashes, one issue/handoff per version, event sequence and one dossier reservation per act. Broad per-clinic serialization is intentional for this bounded manual-office slice; measure contention before narrowing it.
- An issue failure rolls reservation/event/audit/idempotency back together. Readback verifies snapshot content hashes; audit records bind snapshot/reason hashes and full report payload hashes without copying identifiers/free-text into the audit payload. Hashes in the same database do not replace owner-held external checkpoints or defeat a privileged DB attacker.

## Frontend error handling

| HTTP/code | Meaning / next step |
|---|---|
| 400 VALIDATION_FAILED | Field/reference/fee mismatch, unsupported body or missing consent/handoff assertion; display validation, do not invent success |
| 401 UNAUTHENTICATED | Login; recover dossier list/detail before creating or issuing again |
| 403 FORBIDDEN_ROLE | Permission denied; never substitute another dentist's identity |
| 404 NOT_FOUND | Patient/care/dossier not visible in this clinic |
| 409 CONFLICT + details.reason=CNAM_VERSION_STALE | Reload dossier; no silent last-write-wins |
| 409 CONFLICT + details.reason=CNAM_CARE_CHANGED | Signed care/patient/payment snapshot changed; actual authorized dentist appends corrected preparation |
| 409 CONFLICT + details.reason=CNAM_ACT_ALREADY_ISSUED | Act reserved elsewhere; reconcile/review, never issue a duplicate using a new key |
| 409 CONFLICT + details.reason=CNAM_NOT_ISSUED | Issue current preparation first |
| 500 CONTENT_INTEGRITY_FAILED / network uncertainty | Fail closed; GET recovery, retain exact key/body; no new issue or claim of printed paper |

Every dossier returns `estimation:{available:false,label:"Estimation indisponible",amountMillimes:null,reason:"CURRENT_PRIMARY_RULES_NOT_VALIDATED"}`. Local fees, reported affiliation and reimbursement reports cannot turn this into a numeric estimate.

## Remaining approval and product boundaries

Issue #67 implements the first scoped backend layer only. R76 CN-01..CN-11 and R78 CN-R01..CN-R46 remain the full product authority; U060/U108 are **not signed off** by this PR. Current official forms/BS1 fields, valid treatment-date rules, official nomenclature/tariffs/eligibility/caps, clinician credential verification, checklist/attachments, deposit-proof provenance, guardian disputes, complete consent/retention/privacy policy, reporting/deadlines, multi-dentist correction policy and bilingual paper rendering remain subsequent acceptance work. V1.1 calibration/direct preprinted alignment and conditional V2 official integration stay outside this slice. Independent Muse privacy/security review and founder merge gate remain mandatory; no production/clinical/legal/CNAM approval is claimed.
