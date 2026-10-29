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

## R73-H hardening: Muse M-267 objections 1–7 and CH-034 (draft, not yet independently reviewed)

| M-267 / CH | Gap | Now | RED test |
|---|---|---|---|
| (1) | Expected-cash recompute **inputs** were uncompared: period float and start, count time | Period float and start are compared with `cash.period_opened` (first period), or with the previous period's `cash.period_closed` (`nextOpeningFloatMillimes`, `nextOpenedAt`) for carry-forward periods. Count `submittedAt` is anchored in the event. | T-INT-CASH-A, T-INT-CASH-B |
| CH-034 | Moving a payment, movement or refund across the count cut-off (plus a matching edit of the expected figure) stayed green | `recordedAt` / `createdAt` are anchored in each event and compared exactly | T-INT-CASH-C, T-INT-CASH-D |
| (2) | Receipt snapshot fields other than number, kind and amount were uncompared | The full snapshot hash is anchored in the payment, refund or void event (`receiptSha256`); editing any field and recomputing the stored hash is reported | T-INT-RCPT-1 |
| (3) | Correction procedure and site, and the care reason, were uncompared | Correction events carry procedure, tooth and surfaces; the care reason is compared **by hash** (`reasonSha256`) | T-INT-CORR-1 |
| (4) | Refund/void visit and the adjustment note were uncompared | Visit compared (with the anchored value, or with the payment's visit for older events); note compared **by hash only**, so no note text appears in findings and no owner free-text decision is made | T-INT-ADJ-1 |
| (5) | `difference_millimes` and `denominations` were uncompared | `difference_millimes` is already fixed by the database CHECK `difference = counted - expected`, which a superuser cannot bypass; the test asserts the refusal. Denominations are compared by hash, which catches a sum-preserving rewrite. | T-INT-CASH-F |
| (6) | A deleted cash period aborted the whole check (500) | It now produces an `AUDITED_ROW_MISSING` finding (`cash_periods`); the recomputation is skipped only for that count | T-INT-CASH-E |
| (7) | Main checks relied on row-level security alone | Explicit `clinic_id` filters in `integrityCheck` and in `expectedCash`. Run without RLS, the old code **crashed** on another clinic's receipt counter. | T-INT-SCOPE-1 |

Events written **before** R73-H carry no anchored timestamps. For those, a row timestamp is compared with the event's own hashed `occurredAt` within ±120 s (`LEGACY_TIME_TOLERANCE_MS`). Hash anchors are compared only when present. The clean-day test T-INT-CASH-0 (payments, movement, refund, count with denominations, close, carry-forward count) reports nothing.

Unchanged limits:
- A rewrite of rows **and** a consistently re-hashed chain, including the new anchors, is caught only with an outside owner checkpoint (T-INT-LIMIT-1 now also rewrites `receiptSha256`, to model that attacker honestly).
- Money never recorded anywhere stays invisible (CH-002).
