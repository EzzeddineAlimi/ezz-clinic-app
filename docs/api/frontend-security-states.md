# Security-sensitive states: what the frontend must show as returned and never infer or override

Audience: Astra (frontend). Source of truth: the server. Each rule below points to a recorded fictional example in
[`examples/security-states.json`](examples/security-states.json) (or another example file) and to a test that holds the
server to it. Machine-readable API: [`openapi.json`](openapi.json). Endpoint table: [`endpoints.md`](endpoints.md).

**The general rule.** The frontend displays decisions; it never makes them. Hiding a button is a convenience, not a
control: every rule here is enforced by the server whatever the UI does (T-API-4 checks all 384 role/route pairs).
When the server refuses, show its refusal. Never work around it by changing the request on the user's behalf.

## 1. Session, role and clinic

| State | Server says | Frontend must |
|---|---|---|
| No or expired session | 401 `UNAUTHENTICATED` | go to login; drop all cached patient data |
| Sensitive action after the 5-minute password window | 401 `REAUTH_REQUIRED` | ask for the password (`POST /session/reauth`), then resend **the same request with the same Idempotency-Key** |
| Too many failed logins | 423 `ACCOUNT_LOCKED` | show the message ("try later or ask the clinic owner"); no countdown guessing |
| Role cannot do this | 403 `FORBIDDEN_ROLE` + `details.permission` | show "not available for your role"; never retry; never offer a workaround |
| Another clinic's id, or a record that does not exist | 404 `NOT_FOUND` | the same "not found" for both; never hint that the record exists elsewhere |

- `GET /session` returns `roles`. Use them only to choose which screens to offer.
- A person may hold several roles; the permissions are their union.
- The clinic comes only from the session. Never send a clinic id. Never trust one stored on the device.

## 2. Writes, retries and duplicates

- **Idempotency-Key**: create one per user intent, when the form opens, not per click. Keep it across network retries.
  - A replay returns the stored answer with `"replayed": true`; show it as the same success.
  - `IDEMPOTENCY_KEY_REUSED` (409) means the frontend reused a key for a different request. That is a bug: start a new intent.
  - `IDEMPOTENCY_KEY_REQUIRED` (400): every write needs a key, except document bytes (§6).
- **Confirmations need a human decision.** These come back as 409 with `details.retryWith`:

  | Code | Meaning | Confirmation flag |
  |---|---|---|
  | `CONFLICT` | possible duplicate patient (lists `possibleDuplicates`) | `confirmNotDuplicate` |
  | `CONFLICT` | dentist slot already booked | `allowOverlap` |
  | `POSSIBLE_DUPLICATE_PAYMENT` | same amount and tender moments ago | `confirmDuplicate` |

  Show what the server found and let the user decide. Never resend automatically with the flag set.
- `AMOUNT_EXCEEDS_BALANCE` (409, with `details.balanceMillimes`) is final. The UI cannot override it, and there is no patient credit in v0.2.

## 3. Money and receipts

- Amounts are **integer millimes** (`70000` = 70.000 TND), in both directions.
  - Never send decimals. `12.5` is rejected, never rounded.
  - Format for display only.
- Balances, totals, receipt numbers and "paid/unpaid" come **from the server**: `GET /visits/:id/balance` and the payment response. Never compute a balance to decide whether a payment is allowed.
- Receipt numbers are issued by the server inside the payment transaction. Never pre-number, cache or reuse them.
- The receipt `notice` ("FICTIONAL DATA — NOT A FISCAL DOCUMENT …") must be printed as returned.
- Print documents (`POST /receipts/:id/print`, `lang: fr | ar | both`) come with direction and `<bdi>` isolation. Render them as given, so receipt numbers and amounts are not reordered in Arabic.

## 4. Cash drawer (blind count)

- The person counting the drawer must **never** see the expected figure.
  - The count response (`POST /cash/periods/:id/counts`) deliberately has no expected figure and no difference.
  - Do not fetch or show the review on the counter's screen. The desk gets 403 on the review anyway.
- Only the owner's review (`GET /cash/periods/:id/review`) shows expected vs counted, after a count exists.
- Show its `evidence` and `scope` text verbatim. "Counted by non-receptionist" is a software check, not proof.

## 5. Medical alerts and clinical authorship

- The desk sees only **presence** (`GET /patients/:id/medical-alerts/summary`). Never show codes or detail to the desk or the assistant.
- Before care is confirmed, the dentist must review the **current** alert set.
  - Echo the `alertSetHash` you were shown.
  - `MEDICAL_ALERTS_NOT_ACKNOWLEDGED` or `MEDICAL_ALERTS_CHANGED` (409) means re-display the alerts and ask again.
  - Never cache a hash across screens or patients.
- Clinical records, care confirmation, fees, plan decisions, document corrections and lab fitting are **dentist-authored**.
  - Show the server's `FORBIDDEN_ROLE` to anyone else.
  - Never "pre-fill and submit on behalf of" a dentist.
- Nothing is edited in place:
  - notes get **addenda**;
  - wrong findings and documents become `ENTERED_IN_ERROR` with a reason;
  - fees change by **correction** rows.
  Show history; never hide the original from the dentist.

## 6. Patient documents and images

- Upload in two steps (`examples/dentist.json`):
  1. JSON metadata with the SHA-256 computed in the browser (`crypto.subtle.digest`).
  2. Raw bytes as `application/octet-stream`.
- `status` is authoritative:

  | Status | Frontend must |
  |---|---|
  | `AWAITING_CONTENT` | offer the upload |
  | `QUARANTINE` | say "being checked"; **show nothing** |
  | `REJECTED` | show the server's reason; **show nothing** |
  | `ACTIVE` | the only state that may be displayed |
  | `ENTERED_IN_ERROR` | withdrawn; listed only on request |

- Download with `fetch` (bearer header), then a blob URL. Never point an `<img src>` or link at the API.
  - The server always answers as an attachment with a sandbox CSP.
  - `X-Content-Sha256` is the verified hash.
- No viewer tools that measure or annotate images for clinical use; that needs clinical review.

## 7. Owner evidence screens

- **Exceptions** (`GET /owner/exceptions`) and **integrity findings** (`POST /integrity/check`) use neutral evidence wording: `known`, `unknown`, `nextStep`, `evidence`.
  - Show them as written. Never rephrase them into accusations, and never attach a staff name the server did not give.
- "0 items" is **not** "all clear". Always show the `scope` sentence.
- Owner **checkpoints**: show and print the `line` exactly. The owner keeps it outside the system (paper, phone, email to self). Verification results are `MATCHES`, `TAMPERED`, `CHAIN_SHORTER`, `WRONG_CLINIC`, `CHECKSUM_FAILED` and `MALFORMED`; show them with the server's `scope`.
- Deletion requests for documents return `executed: false`. Never present them as deletions.

## 8. Clinic day, lab and stock

- The **clinic day** comes from the server: `clinicToday`, `localTime`, `day` and `timezone`. Never use the device's timezone or date for clinic dates.
- A timezone change for a clinic with visits returns 409 with `retryWith.confirmTimezoneImpact`. Show the impact; it needs the owner's explicit confirmation.
- Lab cases: offer only the transitions in `allowedNext`. The desk lab board has no clinical detail by design; do not join it with other data to rebuild it.
- Stock on-hand comes from the server. A 409 with `details.onHand` means the stock is not recorded; never show negative stock.

## 9. Errors and availability

- Branch on `error.code`, never on `error.message`. Messages are neutral, translated later, and may change.
- 500 `INTERNAL` has no detail by design.
  - Show a generic error with the `X-Request-Id` header for support.
  - Do not retry non-idempotent screens blindly.
  - Writes with the same Idempotency-Key are safe to retry.
- `GET /health/ready` answers 503 when the database is down or the schema does not match.
  - Show a maintenance state.
  - Requests during an outage fail fast (T-CRASH-1).
- Every response is fictional data in this build (`fictionalDataOnly` on `/health`). Keep the fictional-data banner.

## Patients

There is **no patient login or patient API** in this build. Patients receive printed documents only (`examples/patient-facing.json`):
- the payment receipt (fr/ar/both, normal or large print);
- the blank intake form.

A patient portal would need its own security review: identity proofing, consent, and the Tunisian data-protection rules (INPDP).
