# Cash movement retry and duplicate confirmation (fictional-only)

`POST /api/v1/cash/periods/:id/movements` is an OWNER-only, reauthenticated, idempotent write. It records an **owner-entered cash movement**, not proof of physical cash transfer.

- Reuse the **same Idempotency-Key and request body** after an uncertain response. A committed response is replayed without another movement.
- If a **fresh key** submits the same open-period movement kind, integer-millime amount and authenticated staff actor within **120 seconds**, the server returns **409 `CONFLICT`** with `error.details.previousMovementId`, `previousAt` and `retryWith: { confirmDuplicate: true }`. The rejected attempt creates no movement or movement audit event.
- Only after checking that the earlier movement was genuinely distinct may an OWNER explicitly send `confirmDuplicate: true` with a fresh key to record a second matching movement. Different kinds or amounts remain separate. The check serializes owner movements on the cash-period row, including concurrent fresh-key requests.
- Reauthentication, clinic isolation, the existing open-period rule and append-only movement/audit history still apply. This guard is not a substitute for a stable retry key, a future owner movement-history/recovery screen or an independently witnessed cash handover.

The current frontend has no cash-movement submission screen; this is an authenticated API safety control. Neither a successful API response nor a clean count proves physical custody, an off-book event or a bank deposit. Independent financial review and release gates remain open (issue #5).
