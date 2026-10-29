# Dental lab cases and basic stock control (R73 package E)

Status: **foundation, fictional data only, not reviewed, not production-ready.** It is bounded on purpose. It never
chooses a material, a shade or a treatment. It never contacts or orders from a supplier. It creates no prescription.

## Lab cases (`modules/lab.ts`, clinical-requirements §9)

```
CREATED → SENT → (TRY_IN_RETURNED ↔ RESENT)* → RECEIVED → FITTED | REMAKE_REQUESTED
CANCELLED from any state before FITTED (dentist, with a reason)
```

| Action | Who | Notes |
|---|---|---|
| Create case | DENTIST, ASSISTANT | supplier, type, FDI teeth / area, material, shade, impression, instructions, due date, optional visit (must belong to the patient) |
| SENT / TRY_IN_RETURNED / RESENT / RECEIVED | DENTIST, ASSISTANT | logistics |
| FITTED, CANCELLED, remake, link a billed care item | DENTIST | a remake is a new case linked to the original, with a reason and the responsible party (LAB / CLINIC / PATIENT) |
| Desk board `GET /lab/board` | DENTIST, ASSISTANT, RECEPTIONIST | open cases: patient, type, lab, status, due date, overdue flag. No teeth, material, shade or instructions |
| Suppliers | read: all roles; create: OWNER, DENTIST | plain list, no integration |
| Lab invoices | OWNER | clinic **expense**. Every listed case must have gone to that supplier. The number is unique per supplier. Never reaches patient billing |

**MF19 (owner exception list):**
- `LAB_WORK_NOT_BILLED`: work received or fitted with no linked confirmed care item more than `labUnbilledDays` clinic days ago. This is a new clinic setting: default 30, range 7–180, owner-only and audited.
- `LAB_INVOICE_WITHOUT_BILLED_CARE`: a lab invoice older than that threshold that covers a case with no linked care item.
- The wording describes evidence (known / unknown / next step). It names no person and shows no clinical detail.

## Stock (`modules/stock.ts`)

- An append-only movement ledger per item. Each row stores its per-item `seq` and the `on_hand_after` running total, written under a per-item lock. Stock can never go below zero; eight parallel "use 1" requests against 4 in stock give exactly 4 successes.
- Movements:
  - `RECEIVED` (optional lot and expiry) and `USED`: owner, dentist, assistant. The receptionist's workload is unchanged.
  - `ADJUSTED` (a signed count correction) and `DISCARDED`: owner, with a reason.
- The item list shows on-hand, a reorder flag, and **received** lots expiring within 30 days. Use per lot is not tracked, and the response says so.

## Integrity

`STOCK_LEDGER_INCONSISTENT` (running totals or sequence recomputed), `STOCK_AUDIT_VALUE_MISMATCH`,
`LAB_INVOICE_AUDIT_VALUE_MISMATCH`, and `ROW_WITHOUT_AUDIT_EVENT` for lab events, stock movements and invoices.

## Tests

T-LAB-1..7 and T-STK-1..3 (`backend/test/r73-lab-stock.test.ts`).

## Not decided here

- Who may receive lab work at the desk: the matrix gives the receptionist view only.
- Lab price lists.
- Supplier payment tracking. Paying lab invoices is outside the software.
- Per-lot consumption, FEFO and controlled substances.
- Stock valuation or cost of goods (fiscal policy).
- Whether the shade system and materials should be coded lists. That is a question for Tunisian dentists (Q in §15).
