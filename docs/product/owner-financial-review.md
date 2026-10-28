# Owner financial review (B11)

`GET /api/v1/owner/financial-review?from=YYYY-MM-DD&to=YYYY-MM-DD` — OWNER only (`finance.review`), read-only.
The window is inclusive, at most 92 days, and defaults to the last 7 days. Dates are **clinic-local calendar days** (`clinics.settings.timezone`, default `Africa/Tunis`; switched from UTC at integration R72, shared helper with B12).

## What it returns

| Section | Content |
|---|---|
| `reductions` | Every DISCOUNT / WRITE_OFF in the window: amount, reason code, `hasNote`, file no., who authorised (role, staff), when. Totals by kind and by reason code. |
| `returns` | Every REFUND / PAYMENT_VOID: same fields, plus tender and the receipt number the return produced. Totals by kind and by tender. |
| `feeCorrections` | Every dentist fee CORRECTION: signed delta, original fee, `hasReason`, dentist, when. Net total. |
| `freeCare` | Care confirmed at a fee of 0. |
| `zeroedVisits` | Visits whose fee was brought to 0 by corrections or reductions **with no payment at all** (CH-028). A visit paid and then refunded or voided is not listed here; it appears under `returns`. |
| `paymentEvidence.byLevel` | Payments recorded in the window, grouped by evidence level, with the recorded total and the active total (minus refunds and voids). |
| `cashPeriods` | Closed periods in the window: accepted count difference, number of count attempts, handover, and whether the counter passed the independence check. Also the open period, if any. |
| `byAuthorizer` | Per staff member: counts and totals of reductions, returns and corrections they authorised. These are counts only, with no ranking or score. |
| `unresolved` | The number and kinds of current integrity findings (`/integrity/check`). |

### Evidence levels (never upgraded by this view)

- `RECORDED_ONLY` — a staff member recorded it; there is no independent evidence yet.
- `CASH_IN_COUNTED_PERIOD` — desk cash inside a drawer period the owner counted and closed. This is drawer-level evidence, not proof of the individual payment. The covering period is resolved by time (`opened_at < recorded_at <= cutoff_at`), as in B10.
- `PAPER_SLIP_RECORD` — re-entered from a numbered paper slip. The slip is the evidence, and a later drawer count does not change this level.
- `CARD_DESK_CLAIM` / `CARD_OWNER_REVIEWED_STATEMENT` — card claims. Neither is verified by the provider, because no provider integration exists.

## Rules

- **No free text leaves this endpoint.** Discount, refund and correction notes appear only as `hasNote` / `hasReason`. Whether the owner may read staff free text is a pending founder decision. The workbench (CH-028) keeps its current rule.
- **Neutral wording.** The view shows amounts, reason codes, who and when. It never uses "suspicious" or any judgement. Integrity findings are described as data-consistency signals, not conclusions about a person.
- **Scope line.** Money that was never recorded cannot appear here (CH-002). The view accuses no one.

## How this differs from `/owner/exceptions`

`/owner/exceptions` (MF17) is an actionable to-do list: one item per open evidence gap, resolved one at a time with a reason.
This review is a ledger of money-reducing decisions over a period, with totals. It has no resolution state and writes nothing.

## Tests

`backend/test/b11-owner-financial-review.test.ts` contains T-OWN-1..8 and T-OWN-2b.

## Known limits

- The `CARD_OWNER_REVIEWED_STATEMENT` level is computed from `card_matches` but has no dedicated test in this PR.
- On this base branch, `unresolved` counts only the integrity checks that exist there. Once B06 (#14) is integrated, value-tamper findings are counted too, with no change needed here.
- Rows are not paginated. A 92-day window at expected single-clinic volume is small, but this has not been load-tested.
