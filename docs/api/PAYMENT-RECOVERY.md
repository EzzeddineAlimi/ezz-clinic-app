# Sprint 4 payment recovery — frontend API handoff

Base: main `8024d54195cf2aa3ac961071f95ee8069c867ac0`. All examples are fictional.
Backend extension only: adopting this flow in checkout is the next frontend slice.
**Do not claim the current legacy frontend is crash-safe until it adopts this protocol.**

## Reused guarantees and scope

Existing billing already commits payment, allocation, gap-free receipt, immutable
snapshot, audit and HTTP idempotency in one PostgreSQL transaction. Its 120-second
similar-payment check is a warning gate, not durable recovery. HTTP keys bind
route, actor, parameters and body; a new login by the same staff can replay a known
key. A lost browser key cannot identify an arbitrary older desk payment.

New append-only intentions/outcomes keep the payment identity on the server.
Every recovery/prepare/record/cancel operation serializes on the same visit row as
billing. One unresolved intention is allowed per visit by this shared lock rule;
even inconsistent multiple pending rows fail closed. No automatic capture, PSP,
physical cash verification, new clinical authorship or permission expansion.

## Permissions and transport

All paths are under `/api/v1`. Bearer authentication required. `payment.read` and
`payment.record` retain OWNER/DENTIST/RECEPTIONIST; ASSISTANT gets403. Foreign-clinic
visits/intents get neutral404. Only OWNER/RECEPTIONIST can use receipt print APIs;
DENTIST continues to get403. Use no-store reads and clear data on401/403 as in the
existing session contract. All writes require the existing `Idempotency-Key`
header. Keys still protect the individual HTTP operation; the **durable intention
ID** additionally protects recording across lost keys or authorized staff changes.

## Flow

1. On opening checkout, reload, reconnect, or relogin, GET
   `/visits/:id/payment-recovery`. Never automatically submit a payment on mount.
   The read waits for in-flight visit transactions, then returns coherent state:

   ```ts
   {
     balance: { visitId, chargedMillimes, paidMillimes, reducedMillimes,
       returnedMillimes, balanceMillimes, careConfirmed },
     recoveryVersion: string, // opaque SHA256 version; never construct it locally
     paymentIds: string[],    // exact ordered list for explicit history acknowledgement
     intentions: Array<{
       id, payload, createdBy, createdAt,
       status: 'PENDING' | 'RECORDED' | 'CANCELLED',
       paymentId: string | null,
       result: { payment, receipt: {id,number,label}, balanceAfterMillimes } | null,
       reason: string | null, resolvedBy: string | null
     }>,
     automaticRetry: false
   }
   ```

2. If PENDING, show its **original immutable** amount, tender and creator. Do not
   prepare another intention. Reconcile whether money was received with the staff
   and patient/history. GET is never proof of a physical transfer.
   RECORDED means the server transaction committed; use its result/receipt IDs.
   CANCELLED means no recording through that intention is allowed. Current balance
   and the receipt's historical balance-after are distinct values.

3. With no PENDING, after the user reviews current payment history, POST
   `/visits/:id/payment-intents` with a new HTTP key:

   ```json
   {
     "amountMillimes": 30000,
     "tender": "CASH",
     "recoveryVersion": "<server version>",
     "acknowledgedPaymentIds": []
   }
   ```

   Amount is a positive bounded integer, never rounded decimal text. Tender has no
   default. Send the exact `paymentIds` list just reviewed, including previous
   partial payments; an empty list after a prior payment is stale and rejected.
   Optional CARD `cardTerminalRef`/`cardLast4` and explicit `confirmDuplicate` use
   existing validators. A duplicate override requires a genuine distinct payment
   and human confirmation; do not set it automatically.
   Returns201 `{intent:{id,status:'PENDING',payload},paymentRecorded:false}`.
   A lost prepare response is recovered by GET; a second prepare with a new key
   receives409 and the existing `intentId`, rather than another reservation.

4. After the user explicitly confirms recording that original intention, POST
   `/payment-intents/:id/record` with `{}` and an HTTP key. No replacement amount,
   tender or actor fields are accepted. First commit returns201 with the ordinary
   `{payment,receipt,balanceAfterMillimes}` shape. A subsequent call with a fresh
   key, new session or another authorized staff member returns200 plus
   `recovered:true` and the **same** payment/receipt. Replaying the original HTTP
   key can instead return its cached201 plus `replayed:true`: both are committed
   outcomes, not a second payment. Actor of the actual first recording remains
   `payment.recordedBy`; preparation and resolution actors are separately audited.

5. On timeout, lost response, malformed response or5xx, retain the intention ID
   if available, freeze the form, and read recovery before offering an explicit
   same-intention retry. If memory is lost, recover by visit. **Never generate a
   new payment intention just because a previous HTTP response was uncertain.**
   If the recovery read itself fails/times out, outcome is unknown: stop new writes.

6. If explicitly reconciled as unrecorded/not to be recorded, POST
   `/payment-intents/:id/cancel` with `{reason:"Fictional money not received"}`.
   Reason length3..300, audited by hash; original reason retained in append-only
   outcome. Cancellation is terminal and can never refund/void an actual payment.
   Concurrent cancel/record serialize: one terminal outcome wins. A stale
   intention requires reconciliation/cancellation and a fresh GET/prepare, not
   editing its amount. Cancelling alone does not prove money was not received.

## Receipt history and print semantics

GET `/visits/:id/payments` now adds `receiptId` and `receiptSeries` next to the
existing `receiptNumber` for every payment. Historical paper-outage records with
no server receipt retain nulls; do not allocate a number to fill that gap.
GET `/receipts/:id` returns the existing immutable server snapshot and its hash.
Use its `snapshot.label`; never create client-side receipt IDs/numbers.

POST `/receipts/:id/print` retains its server-generated FR/AR document and original
or copy mark; POST `/receipts/:id/reprint` retains its copy-only snapshot response.
Both now share one receipt advisory lock and count prior copy preparations, so
mixed concurrent calls have unique copy numbers, including reprint-before-original.
Both return `preparationOnly:true` and `paperDelivery:'UNKNOWN'`. Same-key replay
must reuse that preparation, not add another row. A new explicit preparation uses
a new key and consumes a copy preparation record, **never a receipt number**.
Legacy `receipt_prints.printed_at` / `receipt.printed` names mean preparation time
in this protocol; they are not confirmation that paper emerged or was handed over.
Existing historical records/events are not rewritten or relabelled. Browser print
cancellation remains unknown and must not be represented as physical delivery.

## Errors and frontend actions

| Code | Status | Required handling |
|---|---:|---|
| PAYMENT_INTENT_UNRESOLVED |409| GET recovery; never bypass with the legacy payment route. Multiple inconsistent pending rows require review. |
| PAYMENT_RECOVERY_STALE |409| Read current ledger/history. Reconcile/cancel pending intention before creating another. No automatic new-key retry. |
| PAYMENT_INTENT_CANCELLED |409| Stop retries for that intention. Reconcile history before new payment. |
| POSSIBLE_DUPLICATE_PAYMENT |409| Existing explicit second-payment review remains authoritative; cancel/reprepare with reviewed override if appropriate. |
| CARE_NOT_CONFIRMED / AMOUNT_EXCEEDS_BALANCE |409| Respect dentist authorship/server balance; do not adjust fees or overpay. |
| NO_OPEN_CASH_PERIOD |409| Owner-managed drawer gate remains. Pending intention records no money; reconcile before retry/cancel. |
| IDEMPOTENCY_KEY_REUSED |409| Never mutate an HTTP key/body; recover intention state. |
| CONFLICT on cancellation |409| Already recorded: retrieve receipt; cancellation is not refund. |
|401 /403 /404|as returned| Clear inaccessible data; no role workaround or cross-clinic probing. |
|500 / network / invalid response|unknown| Do not infer rollback or payment success; read recovery, fail closed if unavailable. |

Legacy POST `/visits/:id/payments` remains compatible for old clients and now refuses
writes while a durable intention is pending (also protects shared paper-import
payment writers). Without a prepared intention its old same-key/120-second rules
remain: **a new arbitrary legacy key is not a durable payment identity**. Frontend
adoption is a release dependency. Completely unrecorded physical cash, deliberate
new intentions after reviewed history, bank reconciliation and theft detection
limitations remain; software cannot infer physical transfer intent from amounts.

Migration0014 must be applied through the existing migrator before starting this
backend; no old migration is modified. API startup/readiness schema checks remain.
No production settings or permission matrix changes. Independent Muse review,
fiscal/legal/native-language/privacy and deployment gates remain.
