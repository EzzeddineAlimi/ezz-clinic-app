# EZZ Clinic API v1 — contracts (fictional-data build)

Status: generated from the running v0.2 code by Claude Opus 5.5 on 2026-10-28. Route table and error codes are generated from `src/app.ts` / `src/platform/errors.ts`; examples below are **real responses captured from a run** against PostgreSQL 16 (ids are random UUIDs; tokens redacted). Not a production API; Astra builds the UI against these contracts.

## Conventions

- Base path `/api/v1`. JSON only: writes must send `Content-Type: application/json` (else **415**). Max body 64 KiB (**413**).
- Auth: `Authorization: Bearer <token>` from `POST /session/login`. No cookies (no CSRF surface). `Origin` header, if present, must be allow-listed (**403 FORBIDDEN_ORIGIN**); `Host` must be loopback or allow-listed (**421**).
- **Every write needs `Idempotency-Key`** (16–100 chars `[A-Za-z0-9_-]`, generate once per user intent, e.g. when the form opens — not per click). Replay → stored response with `"replayed": true`; same key + different body/actor → **409 IDEMPOTENCY_KEY_REUSED**; a failed (rolled back) attempt can be retried with the same key.
- Money: integers in **millimes** (`amountMillimes: 70000` = 70.000 TND). Non-integers, strings, negatives, zero (unless allowed) and values above 100,000,000 are rejected (**400**), never rounded.
- Identity, role and clinic come only from the session. Body fields such as `role`, `actor`, `confirmedBy`, `evidenceTier: PROVIDER_VERIFIED` are ignored or rejected.
- Error envelope: `{"error":{"code":"STABLE_CODE","message":"neutral text","details":{...}}}`. Messages never contain patient data or SQL. 500 = `INTERNAL` with no detail.
- Cross-clinic ids return **404** (no existence leak). Re-auth routes need `POST /session/reauth` within the last 5 minutes (**401 REAUTH_REQUIRED**). Login itself counts as a fresh re-auth.
- Versioning: additive changes only inside v1; breaking changes → `/api/v2` with a deprecation window.
- Evidence vocabulary in responses: `DESK_CLAIM`, `DESK_RECORD`, `PAPER_SLIP_RECORD`, `OWNER_REVIEWED_STATEMENT`, `PROVIDER_VERIFIED` (unreachable in v0.2), `COUNTED_BY_NON_RECEPTIONIST (software check)`, `COUNT_NOT_INDEPENDENT`.

## Endpoints

| Method | Path | Permission (roles) | Re-auth | Idempotency-Key |
|---|---|---|:-:|:-:|
| GET | `/api/v1/health` | public | — | — |
| POST | `/api/v1/session/login` | public | — | — |
| GET | `/api/v1/session` | `session.self` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| POST | `/api/v1/session/reauth` | `session.self` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| POST | `/api/v1/session/logout` | `session.self` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| GET | `/api/v1/staff` | `staff.read` (OWNER) | — | — |
| POST | `/api/v1/staff` | `staff.manage` (OWNER) | yes | required |
| POST | `/api/v1/staff/:id/roles` | `staff.manage` (OWNER) | yes | required |
| POST | `/api/v1/staff/:id/deactivate` | `staff.manage` (OWNER) | yes | required |
| POST | `/api/v1/staff/:id/reset-password` | `staff.manage` (OWNER) | yes | required |
| POST | `/api/v1/audit/checkpoints` | `audit.checkpoint` (OWNER) | yes | required |
| POST | `/api/v1/audit/verify` | `audit.verify` (OWNER) | — | — |
| POST | `/api/v1/patients` | `patient.create` (OWNER, DENTIST, RECEPTIONIST) | — | required |
| GET | `/api/v1/patients` | `patient.read` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| GET | `/api/v1/patients/:id` | `patient.read` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| POST | `/api/v1/patients/:id/contact` | `patient.update_contact` (OWNER, DENTIST, RECEPTIONIST) | — | required |
| POST | `/api/v1/visits` | `visit.schedule` (OWNER, DENTIST, RECEPTIONIST) | — | required |
| GET | `/api/v1/visits` | `visit.read` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| GET | `/api/v1/day-board` | `visit.read` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT) | — | — |
| POST | `/api/v1/visits/:id/status` | `visit.desk_status` (OWNER, DENTIST, RECEPTIONIST) | — | required |
| POST | `/api/v1/visits/:id/care` | `care.confirm` (DENTIST) | — | required |
| POST | `/api/v1/care-items/:id/corrections` | `care.correct` (DENTIST) | — | required |
| GET | `/api/v1/visits/:id/care` | `care.read` (OWNER, DENTIST, RECEPTIONIST) | — | — |
| POST | `/api/v1/visits/:id/payments` | `payment.record` (OWNER, DENTIST, RECEPTIONIST) | — | required |
| GET | `/api/v1/visits/:id/balance` | `payment.read` (OWNER, DENTIST, RECEPTIONIST) | — | — |
| GET | `/api/v1/visits/:id/payments` | `payment.read` (OWNER, DENTIST, RECEPTIONIST) | — | — |
| GET | `/api/v1/receipts/:id` | `payment.read` (OWNER, DENTIST, RECEPTIONIST) | — | — |
| POST | `/api/v1/receipts/:id/reprint` | `receipt.reprint` (OWNER, RECEPTIONIST) | — | required |
| POST | `/api/v1/receipts/:id/print` | `receipt.reprint` (OWNER, RECEPTIONIST) | — | required |
| GET | `/api/v1/print/forms/patient-intake` | `patient.create` (OWNER, DENTIST, RECEPTIONIST) | — | — |
| POST | `/api/v1/paper-books/:id/print` | `paper.issue_book` (OWNER) | — | required |
| POST | `/api/v1/visits/:id/adjustments` | `adjustment.discount` (OWNER, DENTIST) | — | required |
| POST | `/api/v1/payments/:id/refund` | `adjustment.refund` (OWNER) | yes | required |
| POST | `/api/v1/payments/:id/void` | `adjustment.void_payment` (OWNER) | yes | required |
| POST | `/api/v1/integrity/check` | `audit.verify` (OWNER) | — | — |
| POST | `/api/v1/cash/periods` | `cash.manage_period` (OWNER) | yes | required |
| GET | `/api/v1/cash/periods/current` | `payment.record` (OWNER, DENTIST, RECEPTIONIST) | — | — |
| POST | `/api/v1/cash/periods/:id/movements` | `cash.manage_period` (OWNER) | yes | required |
| POST | `/api/v1/cash/periods/:id/counts` | `cash.count_submit` (OWNER, DENTIST) | — | required |
| GET | `/api/v1/cash/periods/:id/review` | `cash.review` (OWNER) | — | — |
| POST | `/api/v1/cash/periods/:id/close` | `cash.review` (OWNER) | yes | required |
| POST | `/api/v1/card/settings` | `card.import_statement` (OWNER) | yes | required |
| POST | `/api/v1/card/statement-imports` | `card.import_statement` (OWNER) | yes | required |
| GET | `/api/v1/card/reconciliation` | `card.review` (OWNER) | — | — |
| POST | `/api/v1/card/matches` | `card.review` (OWNER) | yes | required |
| POST | `/api/v1/paper-books` | `paper.issue_book` (OWNER) | yes | required |
| POST | `/api/v1/paper-books/:id/entries` | `paper.enter_slips` (OWNER, DENTIST, RECEPTIONIST) | — | required |
| POST | `/api/v1/paper-books/:id/declare-unused` | `paper.custody` (OWNER, DENTIST) | — | required |
| GET | `/api/v1/paper-books/:id/reconciliation` | `paper.read` (OWNER, DENTIST) | — | — |
| GET | `/api/v1/owner/exceptions` | `exceptions.read` (OWNER) | — | — |
| POST | `/api/v1/owner/exceptions/resolve` | `exceptions.resolve` (OWNER) | — | required |


### Key request bodies (all amounts in millimes)

| Endpoint | Body fields (required **bold**) |
|---|---|
| `POST /session/login` | **clinicCode**, **username**, **password** → `{token, staff{id,displayName,roles}, clinicId, expiresInSeconds}` |
| `POST /patients` | **familyName**, **givenName**, **isSynthetic: true**, nameAr, dateOfBirth (YYYY-MM-DD), sex F/M/X, phone, contactPreference IN_PERSON/BASIC_PHONE_CALL/SMS/NONE, preferredLanguage fr/ar, confirmNotDuplicate |
| `POST /visits` | **patientId**, **scheduledAt** (ISO), durationMin, dentistId, allowOverlap |
| `POST /visits/:id/status` | **status** ARRIVED/IN_CHAIR/NO_SHOW/CANCELLED, reason (required for NO_SHOW/CANCELLED); NO_SHOW is refused before the appointment time (409) |
| `GET /visits`, `GET /day-board` (query) | day (clinic-local YYYY-MM-DD, default today in the clinic timezone); day-board also: scope mine/all (mine = own + unassigned, DENTIST only; default for dentists), dentistId |
| `POST /visits/:id/care` | **procedureCode**, **procedureLabel**, **feeMillimes** (0 allowed with reason), toothFdi (11–48, 51–85), surfaces (MODBLIFP), reason, confirmRepeat |
| `POST /care-items/:id/corrections` | **deltaMillimes** (±, ≠0), **reason** |
| `POST /visits/:id/payments` | **amountMillimes**, **tender** CASH/CARD (no default), cardTerminalRef, cardLast4, confirmDuplicate |
| `POST /visits/:id/adjustments` | **kind** DISCOUNT/WRITE_OFF, **amountMillimes**, **reasonCode** (A-Z_), reasonNote |
| `POST /payments/:id/refund` | **amountMillimes**, **reasonCode**, reasonNote — needs an existing credit |
| `POST /payments/:id/void` | **reasonCode**, reasonNote |
| `POST /receipts/:id/reprint` | — (returns snapshot with `copy: true`, no new number) |
| `POST /cash/periods` | **openingFloatMillimes** (first period only) |
| `POST /cash/periods/:id/movements` | **kind** OWNER_WITHDRAWAL/BANK_DEPOSIT/PETTY_EXPENSE/FLOAT_TOP_UP, **amountMillimes**, **reason**, voucherRef |
| `POST /cash/periods/:id/counts` | **countedMillimes**, denominations {unitMillimes: count} (must add up), recountReason (attempt ≥ 2) |
| `POST /cash/periods/:id/close` | **acceptedCountId** (latest attempt only), **handoverMillimes**, note |
| `POST /card/settings` | **accountLast4**, settlementLagDays, matchWindowDays, importStaleAfterDays |
| `POST /card/statement-imports` | **fileName**, **csv** (header `date,amount_tnd,type,terminal_ref,card_last4[,description]`; type CARD/REVERSAL; others discarded), **accountLast4**, **periodStart**, **periodEnd**, **totalSource** OWNER_READ_TERMINAL/OWNER_READ_BANK_PORTAL/DESK_HANDLED_SLIP/NOT_PROVIDED, declaredTotalMillimes, forceOverlapReason |
| `POST /card/matches` | **paymentId**, **statementLineId**, ambiguityAcknowledged, note |
| `POST /paper-books` | **firstNo**, **lastNo**, **custodianStaffId** (dentist/owner), note |
| `POST /paper-books/:id/entries` | **slips[]**: {**slipNo**, **kind** USED/VOID, amountMillimes, tender, visitId, writtenOn, note} — per-slip outcome POSTED/DUPLICATE_ENTRY/CONFLICT/VOID_RECORDED/REJECTED |
| `POST /paper-books/:id/declare-unused` | **slipNos[]** (custodian or owner) |
| `POST /audit/checkpoints` | note → printable `EZZ-CHECKPOINT …` line to keep outside the system |
| `POST /audit/verify`, `POST /integrity/check` | anchors[] {seq, hash} |
| `POST /owner/exceptions/resolve` | **key**, **reasonCode**, note, asOf |

### Status codes used for business outcomes

`201` created · `200` ok/replay · `400` validation · `401` unauthenticated / re-auth required · `403` role/origin · `404` not found or other clinic · `409` conflict (duplicate care, exceeds balance, possible duplicate, idempotency reuse, closed period, ambiguous match, overlap conflict) · `413` · `415` · `421` · `422` statement scope / total mismatch (the import attempt itself is recorded) · `423` locked · `500` internal.

## Error codes

| Error code | HTTP |
|---|---|
| `VALIDATION_FAILED` | 400 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `PAYLOAD_TOO_LARGE` | 413 |
| `UNAUTHENTICATED` | 401 |
| `REAUTH_REQUIRED` | 401 |
| `ACCOUNT_LOCKED` | 423 |
| `FORBIDDEN_ROLE` | 403 |
| `FORBIDDEN_ORIGIN` | 403 |
| `MISDIRECTED_HOST` | 421 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `CARE_ALREADY_CONFIRMED` | 409 |
| `CARE_NOT_CONFIRMED` | 409 |
| `AMOUNT_EXCEEDS_BALANCE` | 409 |
| `POSSIBLE_DUPLICATE_PAYMENT` | 409 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 |
| `IDEMPOTENCY_KEY_REUSED` | 409 |
| `NO_OPEN_CASH_PERIOD` | 409 |
| `CASH_PERIOD_CLOSED` | 409 |
| `RECOUNT_REASON_REQUIRED` | 400 |
| `COUNTER_NOT_ALLOWED` | 403 |
| `STATEMENT_SCOPE_REJECTED` | 422 |
| `STATEMENT_TOTAL_MISMATCH` | 422 |
| `STATEMENT_OVERLAP_CONFLICT` | 409 |
| `PAPER_SLIP_OUT_OF_RANGE` | 422 |
| `PAPER_VOID_WITH_AMOUNT` | 422 |
| `ALREADY_VOIDED` | 409 |
| `INTERNAL` | 500 |

## Real request/response examples (captured 2026-10-28)

Note: the login example deliberately shows the failure envelope (placeholder password).

### Login

Wrong credentials and unknown clinic both return the same 401. 5 failures in 15 min -> 423 ACCOUNT_LOCKED.

```http
POST /api/v1/session/login
Content-Type: application/json
Idempotency-Key: <16-100 chars>

{
  "clinicCode": "demo-clinic",
  "username": "desk",
  "password": "<password>"
}
```

Response `401`

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Invalid clinic, username or password"
  }
}
```

### Dentist confirms care (CH-012)

Only a DENTIST session may call this; identity comes from the token, never the body.

```http
POST /api/v1/visits/a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5/care
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "procedureCode": "FILLING",
  "procedureLabel": "Composite filling (fictional)",
  "toothFdi": 36,
  "surfaces": "MO",
  "feeMillimes": 100000
}
```

Response `201`

```json
{
  "careItem": {
    "id": "e1074e73-6323-45f6-b9fc-b54d0e99b5f7",
    "visitId": "a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5",
    "kind": "CARE",
    "procedureCode": "FILLING",
    "procedureLabel": "Composite filling (fictional)",
    "toothFdi": 36,
    "surfaces": "MO",
    "feeMillimes": 100000,
    "confirmedBy": "c0f97e61-a7a4-4e2e-866c-2d8f85c791b2",
    "confirmedAt": "2026-10-28T01:11:42.109Z"
  },
  "visitTotalMillimes": 100000
}
```

### Receptionist attempts the same (denied)

Denials increment a per-day counter shown to the owner.

```http
POST /api/v1/visits/a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5/care
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "procedureCode": "FILLING",
  "procedureLabel": "x",
  "feeMillimes": 1
}
```

Response `403`

```json
{
  "error": {
    "code": "FORBIDDEN_ROLE",
    "message": "Your role cannot perform this action",
    "details": {
      "permission": "care.confirm"
    }
  }
}
```

### Partial cash payment (70,000 of 100,000)

Payment, allocation, receipt number, receipt snapshot and audit event commit in one transaction.

```http
POST /api/v1/visits/a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5/payments
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "amountMillimes": 70000,
  "tender": "CASH"
}
```

Response `201`

```json
{
  "payment": {
    "id": "85a32d96-ac73-4738-af5b-24f8f427b941",
    "visitId": "a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5",
    "patientId": "9c0fe63e-7081-45cd-b303-1595b52072cd",
    "amountMillimes": 70000,
    "tender": "CASH",
    "source": "DESK",
    "recordedAt": "2026-10-28T01:11:42.154Z",
    "recordedBy": "f75cbbcf-9b79-417e-b8c0-9c0154ca9bd4",
    "cashPeriodId": "3c933a81-74ee-45cc-a547-98c8df8c47ee",
    "evidence": {
      "tier": "DESK_RECORD",
      "label": {
        "fr": "Espèces — vérifiées seulement par un comptage indépendant",
        "ar": "نقدًا — يُتحقَّق منها فقط بعدّ مستقل"
      },
      "verifiedBy": null
    }
  },
  "receipt": {
    "id": "1a351098-9613-4aa0-b825-b978cd7b0426",
    "number": 1,
    "label": "R-000001"
  },
  "balanceAfterMillimes": 30000
}
```

### Network retry with the SAME Idempotency-Key (replay, no second payment)

```http
POST /api/v1/visits/a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5/payments
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "amountMillimes": 70000,
  "tender": "CASH"
}
```

Response `201`

```json
{
  "payment": {
    "id": "85a32d96-ac73-4738-af5b-24f8f427b941",
    "source": "DESK",
    "tender": "CASH",
    "visitId": "a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5",
    "evidence": {
      "tier": "DESK_RECORD",
      "label": {
        "ar": "نقدًا — يُتحقَّق منها فقط بعدّ مستقل",
        "fr": "Espèces — vérifiées seulement par un comptage indépendant"
      },
      "verifiedBy": null
    },
    "patientId": "9c0fe63e-7081-45cd-b303-1595b52072cd",
    "recordedAt": "2026-10-28T01:11:42.154Z",
    "recordedBy": "f75cbbcf-9b79-417e-b8c0-9c0154ca9bd4",
    "cashPeriodId": "3c933a81-74ee-45cc-a547-98c8df8c47ee",
    "amountMillimes": 70000
  },
  "receipt": {
    "id": "1a351098-9613-4aa0-b825-b978cd7b0426",
    "label": "R-000001",
    "number": 1
  },
  "balanceAfterMillimes": 30000,
  "replayed": true
}
```

### Same key, different body

```http
POST /api/v1/visits/a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5/payments
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "amountMillimes": 30000,
  "tender": "CASH"
}
```

Response `409`

```json
{
  "error": {
    "code": "IDEMPOTENCY_KEY_REUSED",
    "message": "This Idempotency-Key was already used for a different request"
  }
}
```

### Card desk claim

A card entry is only a DESK_CLAIM.

```http
POST /api/v1/visits/a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5/payments
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "amountMillimes": 30000,
  "tender": "CARD",
  "cardTerminalRef": "T1"
}
```

Response `201`

```json
{
  "payment": {
    "id": "1894f031-3525-4960-b948-ab6fca25e037",
    "visitId": "a4883706-e6ce-4a2b-b7a2-5a047fdbd6c5",
    "patientId": "9c0fe63e-7081-45cd-b303-1595b52072cd",
    "amountMillimes": 30000,
    "tender": "CARD",
    "source": "DESK",
    "recordedAt": "2026-10-28T01:11:42.194Z",
    "recordedBy": "f75cbbcf-9b79-417e-b8c0-9c0154ca9bd4",
    "cashPeriodId": null,
    "evidence": {
      "tier": "DESK_CLAIM",
      "label": {
        "fr": "Carte — déclaration accueil uniquement (non vérifiée)",
        "ar": "بطاقة — تسجيل الاستقبال فقط (غير مُتحقَّق منه)"
      },
      "verifiedBy": null
    }
  },
  "receipt": {
    "id": "5f357dea-8c33-46e5-910a-b67db76edf1d",
    "number": 2,
    "label": "R-000002"
  },
  "balanceAfterMillimes": 0
}
```

### Blind count submission (no figures returned)

```http
POST /api/v1/cash/periods/3c933a81-74ee-45cc-a547-98c8df8c47ee/counts
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "countedMillimes": 65000,
  "denominations": {
    "5000": 1,
    "20000": 3
  }
}
```

Response `201`

```json
{
  "count": {
    "id": "c54396b4-9bd5-40df-8870-6d0726b9c25e",
    "periodId": "3c933a81-74ee-45cc-a547-98c8df8c47ee",
    "attemptNo": 1,
    "submittedAt": "2026-10-28T01:11:42.212Z"
  },
  "status": "RECORDED_PENDING_OWNER_REVIEW"
}
```

### Owner review after the count

```http
GET /api/v1/cash/periods/3c933a81-74ee-45cc-a547-98c8df8c47ee/review
Authorization: Bearer <token>

```

Response `200`

```json
{
  "period": {
    "id": "3c933a81-74ee-45cc-a547-98c8df8c47ee",
    "periodNo": 1,
    "status": "OPEN",
    "openedAt": "2026-10-28T01:11:42.001Z"
  },
  "expected": {
    "expectedMillimes": 70000,
    "breakdown": {
      "openingFloatMillimes": 0,
      "openingBasis": "OWNER_DECLARED",
      "cashPaymentsMillimes": 70000,
      "cashPaymentCount": 1,
      "floatTopUpsMillimes": 0,
      "ownerWithdrawalsMillimes": 0,
      "bankDepositsMillimes": 0,
      "pettyExpensesMillimes": 0,
      "cashRefundsMillimes": 0,
      "cashVoidsMillimes": 0
    }
  },
  "attempts": [
    {
      "id": "c54396b4-9bd5-40df-8870-6d0726b9c25e",
      "attemptNo": 1,
      "countedBy": "bc1a3009-f7d8-4e24-bf85-3b63ed660773",
      "countedMillimes": 65000,
      "expectedMillimes": 70000,
      "differenceMillimes": -5000,
      "submittedAt": "2026-10-28T01:11:42.212Z",
      "recountReason": null,
      "counterIndependent": true,
      "independenceNotes": "software check only: physical independence of the count cannot be proven by software",
      "wording": "count differs by -5000 millimes — owner review pending (not an accusation)"
    }
  ],
  "summary": "1 attempt(s); first differed by -5000 millimes; latest differs by -5000 millimes",
  "cashRecordedAfterLatestCount": {
    "count": 0,
    "totalMillimes": 0,
    "note": "belongs to the next period when this one is closed"
  },
  "evidence": "COUNTED_BY_NON_RECEPTIONIST (software check)",
  "scope": "Compares the drawer with RECORDED cash only. Cash never recorded cannot appear here (CH-002)."
}
```

### Owner sets card account

```http
POST /api/v1/card/settings
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "accountLast4": "4321",
  "settlementLagDays": 2
}
```

Response `200`

```json
{
  "settings": {
    "accountLast4": "4321",
    "settlementLagDays": 2,
    "matchWindowDays": 7,
    "importStaleAfterDays": 7
  }
}
```

### Owner imports a statement (total read from terminal)

```http
POST /api/v1/card/statement-imports
Content-Type: application/json
Idempotency-Key: <16-100 chars>
Authorization: Bearer <token>

{
  "fileName": "oct.csv",
  "accountLast4": "4321",
  "periodStart": "2026-10-28",
  "periodEnd": "2026-10-28",
  "totalSource": "OWNER_READ_TERMINAL",
  "declaredTotalMillimes": 30000,
  "csv": "date,amount_tnd,type,terminal_ref,card_last4,description\n2026-10-28,30.000,CARD,T1,,fictional"
}
```

Response `201`

```json
{
  "import": {
    "id": "ec462111-a69d-4646-aff0-da9a354e28ad",
    "status": "ACCEPTED_TOTAL_CHECKED",
    "fileSha256": "6c15c79cb8bff13883d3760dfb2c2d7935f18915ffde0ca9bb8c5ef155a32845",
    "cardLines": 1,
    "linesNew": 1,
    "linesAlreadyKnown": 0,
    "discardedNonCard": 0,
    "missingFromThisFile": []
  },
  "evidenceTierReachable": "OWNER_REVIEWED_STATEMENT",
  "warning": null
}
```

### Card reconciliation

```http
GET /api/v1/card/reconciliation?asOf=2026-10-28
Authorization: Bearer <token>

```

Response `200`

```json
{
  "asOf": "2026-10-28",
  "tiers": {
    "DESK_CLAIM": "unverified desk record",
    "OWNER_REVIEWED_STATEMENT": "owner linked an imported statement line; file origin not verified",
    "PROVIDER_VERIFIED": "UNREACHABLE in v0.2: no authenticated provider source"
  },
  "claims": [
    {
      "paymentId": "1894f031-3525-4960-b948-ab6fca25e037",
      "amountMillimes": 30000,
      "date": "2026-10-28",
      "tier": "DESK_CLAIM",
      "status": "CANDIDATE_OWNER_CONFIRMS",
      "exception": true,
      "ageDays": 0,
      "wording": "Possible statement line — owner confirms",
      "candidates": [
        {
          "statementLineId": "3a21b245-23dc-4ea8-b896-7a313e90ede2",
          "date": "2026-10-28",
          "amountMillimes": 30000,
          "strength": "AMOUNT_DATE_PLUS_REFERENCE",
          "competingClaims": [],
          "sourceWarning": null
        }
      ]
    }
  ],
  "statementLines": [],
  "importHealth": {
    "statementImportedThrough": "2026-10-28",
    "daysBehind": 0,
    "banner": null
  },
  "exceptionCount": 1,
  "scope": "Compares desk card records with owner-imported statements. A card taken on a personal terminal, or cash taken while a coincidental line matches, cannot be detected."
}
```

### Owner exception list

```http
GET /api/v1/owner/exceptions?asOf=2026-10-28
Authorization: Bearer <token>

```

Response `200`

```json
{
  "asOf": "2026-10-28",
  "open": [
    {
      "key": "cash:c54396b4-9bd5-40df-8870-6d0726b9c25e:count_differs",
      "kind": "CASH_COUNT_DIFFERS",
      "evidence": "VERIFIED_BY_OWNER",
      "severity": "HIGH",
      "wording": "Latest count differs from records by -5000 millimes (review, not an accusation)",
      "known": "Attempt 1; counter passed the software independence check",
      "unknown": "Cause: unrecorded payment, error, float or removal",
      "nextStep": "Open the period review; compare with paper receipts",
      "refs": {
        "periodId": "3c933a81-74ee-45cc-a547-98c8df8c47ee",
        "countId": "c54396b4-9bd5-40df-8870-6d0726b9c25e"
      }
    },
    {
      "key": "audit:checkpoint:due",
      "kind": "AUDIT_CHECKPOINT_DUE",
      "evidence": "SYSTEM_CHECK",
      "severity": "MEDIUM",
      "wording": "No owner checkpoint in the last 7 days",
      "known": "Last checkpoint: never",
      "unknown": "Changes since then are tamper-evident only inside the database",
      "nextStep": "Create a checkpoint and keep the printed line outside the clinic system"
    },
    {
      "key": "card:1894f031-3525-4960-b948-ab6fca25e037:candidate_owner_confirms",
      "kind": "CARD_CANDIDATE_OWNER_CONFIRMS",
      "evidence": "DESK_RECORD_ONLY",
      "severity": "MEDIUM",
      "wording": "Possible statement line — owner confirms",
      "known": "Desk card record 30000 millimes on 2026-10-28",
      "unknown": "Whether the money reached the clinic account",
      "nextStep": "Import the latest statement as owner, then confirm or reject the candidate line",
      "refs": {
        "paymentId": "1894f031-3525-4960-b948-ab6fca25e037"
      }
    },
    {
      "key": "security:f75cbbcf-9b79-417e-b8c0-9c0154ca9bd4:denied_care_confirm",
      "kind": "DENIED_PRIVILEGED_ATTEMPT",
      "evidence": "SYSTEM_CHECK",
      "severity": "INFO",
      "wording": "1 denied attempt(s) of \"care.confirm\" by a staff account in 7 days",
      "known": "The account lacked the role; nothing was changed",
      "unknown": "Whether it was a mistake",
      "nextStep": "Mention it at the next staff check-in if repeated",
      "refs": {
        "staffId": "f75cbbcf-9b79-417e-b8c0-9c0154ca9bd4",
        "action": "care.confirm"
      }
    }
  ],
  "openCount": 4,
  "resolvedCountByReason": {},
  "scope": "Checks recorded entries only; unrecorded visits or payments cannot be assessed. Zero items does not mean nothing is wrong."
}
```

