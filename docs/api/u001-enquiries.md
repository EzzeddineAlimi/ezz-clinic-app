# U001 fictional receptionist enquiry queue — backend handoff

Authority: founder's 2026-10-31 explicit backend assignment, R76 U001: **“R logs name, reason, callback; creates patient only on booking.”** Mission Control handoff `H-20261031-GPT-CODEX-U001-AUTH-001`. This slice implements the pre-booking queue only. No patient, visit, file number, financial record, outbound contact, diagnosis or urgency-verification assertion is created. Existing patient/booking APIs remain unchanged; there is no automatic conversion/linking endpoint.

## Server contract

All four routes require an authenticated staff session with `RECEPTIONIST` role (`enquiry.manage`). OWNER/DENTIST/ASSISTANT alone are denied; a multi-role user who also holds RECEPTIONIST receives the permission through the existing role union. Every query/write is transactionally scoped by forced clinic RLS. No clinic/staff identity is accepted from the body.

| Method/path | Input | Success |
|---|---|---|
| POST `/api/v1/enquiries` | `name`, `reason`, optional `callback`, `isSynthetic: true` | 201 `{ enquiry }` |
| GET `/api/v1/enquiries` | optional `status=OPEN\|CLOSED` (default OPEN), `before=<enquiry UUID>` | 200 `{ enquiries, nextBefore }` |
| GET `/api/v1/enquiries/:id` | same-clinic UUID | 200 `{ enquiry }` |
| POST `/api/v1/enquiries/:id/update` | full replacement of name/reason/callback, `isSynthetic: true`, `status`, `expectedVersion` | 200 `{ enquiry }` |

`enquiry`: id, name, reason, nullable callback, status, positive integer version, createdBy/updatedBy staff IDs and createdAt/updatedAt timestamps. There is deliberately no patient ID. `CLOSED` means manually removed from active follow-up; it does **not** attest contact, booking, consent, physical delivery, triage or identity verification. Reopening uses the same update contract. Fields accept French/Arabic Unicode; no automatic messaging or transliteration.

Engineering bounds: trimmed name 1–160 characters, brief administrative reason 1–240, optional callback 1–40 (null/empty clears it); existing validation rejects control characters. These limits are development choices, not verified Tunisian legal/clinical rules. Do not enter diagnoses or sensitive clinical history in this queue. Unknown fields, false/missing synthetic declaration and invalid versions/statuses return the existing 400 envelope. DB CHECK independently requires synthetic=true. API/constraint enforcement cannot prove user-supplied content is actually fictional: staff must use fictional data only.

List returns newest first, maximum 50. If `nextBefore` is non-null pass it as `before` with the same status. Keyset order is `(created_at,id)` descending; later additions appear on refresh. A foreign/missing cursor or record returns 404, never foreign data. Callback and brief reason are receptionist-visible enquiry details; avoid URLs/logs/analytics containing them. No search-by-text query or bulk export is added.

## Retries and concurrency

POSTs require the existing `Idempotency-Key` (16–100 `[A-Za-z0-9_-]` chars). Persist one key and **unchanged body** per intended operation before sending; retry that exact operation on uncertain response. Session-scoped existing middleware stores result and mutation/audit in one transaction, returns `replayed: true` on replay, and rejects changed-body reuse. A replay may contain an older version after subsequent edits: GET the selected enquiry again for its current state. New session/new key does not bypass the open-duplicate check.

An identical OPEN enquiry (NFKC + lower-case + whitespace-normalized name/reason/callback) returns 409 `details.reason=ENQUIRY_DUPLICATE`, with same-clinic `enquiryId` for manual review. No automatic merge or verified identity assertion. Different content can still represent the same caller; this is a bounded heuristic. Closed entries permit a new enquiry. Clinic writer locks serialize duplicate checks and edits; a partial unique index independently protects exact open fingerprints. Stale concurrent update returns 409 `ENQUIRY_VERSION_STALE` with currentVersion; reload before deciding on a new operation/key. Failed operations roll back without audit side effects.

## Storage, audit and safety

Migration `0016_reception_enquiries.sql` adds one table; no patient/visit FK or patient counter write. Content is mutable for receptionist corrections, with optimistic version checks. No delete/truncate grant. Clinic, synthetic flag, creator/time and ID cannot be updated by the app DB role. Attributable immutable audit events record create/update version and changed field names in the same transaction, **without copying name/reason/callback into the broader owner-readable audit stream**. Previous free-text values are not retained as enquiry versions; this is not an immutable clinical/financial ledger. Existing audit/DB-privileged-actor limitations continue to apply.

Recorded real API examples: `docs/api/examples/enquiries.json`; regenerate them with `EZZ_RECORD_EXAMPLES=1 node --test test/u001-enquiries.test.ts` from backend using a fictional test PG16 admin URL, then `npm run gen:openapi`. Generated endpoint/OpenAPI and permission-matrix files come from existing generators, not manual schema edits. Contract regression checks compare fresh real-API response shapes.

## Acceptance and independent review

U001 is **PARTIAL / OPEN** after this backend draft. Receptionist frontend, French/Arabic UI, real human/paper workflow, retention/deletion policy, privacy-law validation and independent Muse review remain undelivered/unaccepted. There is no production storage/consent/clinical/legal approval. Independent Muse + separate founder authorization are required before merging this new privacy workflow; no merge/deploy authority is inferred from CI.

Test/evidence commands and exact head are recorded in the PR and `docs/testing/U001-ENQUIRIES.md`. Backend-only change: screenshots and browser UI tests are not applicable to this draft; no UI success is claimed.
