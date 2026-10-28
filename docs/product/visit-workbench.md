# Visit Workbench (synthetic-only) — backend vertical slice

**Draft — not for clinic use.** This is the first *combined read model* for Astra's future visit screen. It does not provide visual UI, new medical records or a production deployment.

## What changed

- `GET /api/v1/visits/:id/workbench` returns the currently recorded appointment, minimal patient identity (name/file number, preferred language, contact preference), assigned dentist, immutable dentist care entries, payment/receipt entries, money balance and a server-derived next action.
- Read-only, with existing `care.read` permission: OWNER, DENTIST, RECEPTIONIST. ASSISTANT lacks this finance-bearing permission.
- One SQL statement projects a coherent financial view, avoids per-field HTTP round trips and does not expand the write-path attack surface.
- Clinic isolation is enforced via the existing PostgreSQL tenant policy and explicit clinic-scoped joins. No cross-clinic records.
- Cash is explicitly marked as recorded, not independently counted; card evidence is either an unverified desk claim or an owner-reviewed imported statement (not provider-verified). A fully recorded balance is **not** presented as independently reconciled. The workbench does not downgrade/override external evidence systems and never asserts cash theft.
- A *runnable fictional clinic-day walkthrough* creates its **own throwaway PostgreSQL database**, exercises real role-authenticated API calls and deletes it. It is for local development only.

## Example state transitions

| Step | Actor | Server action | Workbench nextAction |
|---|---|---|---|
| Appointment created | Receptionist | `POST /visits` | `CHECK_IN` |
| Patient arrived | Receptionist | `POST /visits/:id/status` | `MOVE_TO_CHAIR` |
| Patient in chair | Receptionist | `POST /visits/:id/status` | `WAIT_FOR_DENTIST_CONFIRMATION` |
| Dentist confirms fictional 100 DT treatment | Dentist | `POST /visits/:id/care` | `RECORD_OR_FOLLOW_UP_PAYMENT` |
| Receptionist records 70 DT cash | Receptionist | `POST /visits/:id/payments` | `RECORD_OR_FOLLOW_UP_PAYMENT` (30 DT remains) |
| Receptionist records remaining 30 DT | Receptionist | `POST /visits/:id/payments` | `CHECKOUT_RECORDED__RECONCILIATION_PENDING` |

The 70 DT example records a **claim**, not a real physical cash event. An owner's count and patient receipt independently matter. Never describe a drawer discrepancy as proof of theft.

## Run locally (fictional database only)

```bash
cd backend
npm ci --ignore-scripts
# Set EZZ_TEST_ADMIN_URL to a throwaway, locally controlled PostgreSQL 16 test superuser,
# never to a database with real clinic records.
node scripts/demo-visit-journey.ts
```

The script prints the stages, receipt labels and balances from real API responses. It creates/drops its own test database. CI's core `npm test` also exercises the endpoint with authentication, role-bound care authority, partial payments, tenant isolation and card desk claims.

## Boundaries / future Astra integration

No runtime frontend changes, no external bank verification, no patient portal, no X-rays, no PDF generation, no fiscal receipt certification, no hosting/PSP/Tunisian law decisions. The workbench is an API read model, not a replacement for the owner cash/card review screens.

Astra can use the states for UI flows, but must not treat the GET result as authorization for subsequent POSTs: the backend remains the authority. UI action hints are advisory; replay/conflict/cash-count logic stays server-side.

## Evidence-limited next-action behavior

- `OWNER_REVIEW_CARD_CLAIM` when the recorded balance is zero but a card payment remains a desk claim.
- `CHECKOUT_RECORDED__RECONCILIATION_PENDING` after a fully recorded payment where separate physical/provider verification is still required.
- `VISIT_COMPLETE_NO_PAYMENT_REQUIRED` is reserved for confirmed, explicitly zero-fee care with no payments.
- `RECORD_OR_FOLLOW_UP_PAYMENT` when a positive recorded balance remains; `OWNER_REVIEW_CREDIT` for a negative recorded balance.

The card tier (`DESK_CLAIM` or `OWNER_REVIEWED_STATEMENT`) is read from existing financial evidence, and even an owner-reviewed imported statement is not authenticated provider settlement. The current API is intentionally conservative about payment proof.
