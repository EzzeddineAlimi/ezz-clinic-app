# Owner integrity check — business values vs audit events (B06, CH-027)

**Status: draft (branch `claude/b06-business-value-integrity`, stacked on PR #3). Fictional data only. Not independently reviewed.**

`POST /api/v1/integrity/check` (OWNER, `audit.verify`) now compares every financial business row with the values captured in its audit event at the time it was written, in addition to the existing presence, receipt-gap and hash-chain checks.

| Check | Compares | Detects (privileged out-of-band edit) |
|---|---|---|
| `PAYMENT_AUDIT_VALUE_MISMATCH` | `payments` amount, tender, source, visit, cash period, recorder ↔ `payment.recorded` | amount lowered, cash relabelled as card (CH-013 pattern), payment moved to another visit/period |
| `ALLOCATION_MISMATCH` | sum of `payment_allocations` and its visit ↔ audited payment amount and visit | balance inflated/deflated through allocations (visit balances are computed from allocations) |
| `RECEIPT_SNAPSHOT_HASH_MISMATCH` | `sha256(canonicalJson(snapshot))` ↔ stored `snapshot_sha256` | edited receipt snapshot without hash update |
| `RECEIPT_VALUE_MISMATCH` | receipt number/kind/series ↔ snapshot; number and amount ↔ audited payment/refund/void | edited receipt even when the stored hash was recomputed; swapped receipt numbers |
| `ADJUSTMENT_AUDIT_VALUE_MISMATCH` | kind (from the audited action), amount, reason code, linked payment/visit, tender, authorizer ↔ `adjustment.created` / `payment.refunded` / `payment.voided` | refund relabelled as discount, amounts changed, re-pointed refunds |
| `CARE_AUDIT_VALUE_MISMATCH` | fee, visit, procedure, tooth, surfaces (CARE) / delta, link, reason (CORRECTION) ↔ `care.confirmed` / `care.corrected` | dentist-confirmed fee changed after the fact |
| `CASH_COUNT_AUDIT_VALUE_MISMATCH` | counted figure, period, attempt ↔ `cash.count_submitted` | counted cash rewritten |
| `CASH_COUNT_EXPECTED_RECOMPUTE_MISMATCH` | stored expected cash ↔ recomputation from append-only payments, movements, refunds and voids at the same cut-off | expected figure lowered to hide a shortfall (not audited, so recomputed) |
| `CASH_MOVEMENT_AUDIT_VALUE_MISMATCH` | amount, kind, period, voucher ↔ `cash.movement_recorded` | withdrawal/expense amounts changed |
| `AUDITED_ROW_MISSING` | every audited adjustment, care item, count, movement still exists | deleted rows (payments keep the original `AUDITED_PAYMENT_MISSING`) |
| `DUPLICATE_AUDIT_EVENT` | exactly one creation event per row | duplicated creation events |

## Wording

Every finding says: *"This is a data-consistency finding: it does not by itself show who changed it, why, or that money was lost."* It is a record mismatch, not a cash-loss finding and not an accusation (issue #5 acceptance 2).

## Limits (tested, not hidden)

- **Consistent rewrite of rows AND chain** (T-INT-LIMIT-1): a database superuser who changes a payment, its allocation, its receipt and rewrites the audit events with valid hashes produces a green check. Only an **owner checkpoint kept outside the database** taken after the original entry detects it (`AUDIT_ANCHOR_HASH_MISMATCH`). Exposure window = time since the last owner checkpoint.
- **Never-entered activity** (CH-002): money that was never recorded anywhere leaves no row and no event.
- **Allocation rule** assumes the v0.2 model: one payment fully allocated to its own visit (no deposits/credit). Any future credit or split allocation must change this rule (GPT R55).
- Only fields captured in the audit payload are compared; others are out of scope, not "tampered" (GPT R65). `expected_millimes` of cash counts is the one uncaptured field handled by recomputation.
- Clinical tables added by PR #12 (site amendments, alerts, notes, findings, plans) are **not** covered here; they need a follow-up stacked on PR #12.
- Cost is O(rows) per clinic per run (one read of the relevant audit events plus one read per table; one recomputation per cash count). Fine for one clinic; would need incremental checking at scale (not measured).
