# Printable FR/AR documents and paper workflow contracts (B15)

These are backend **contracts** plus a plain printable HTML sample. The visual design belongs to Astra (B09).

**This is not a fiscal document.** Mandatory Tunisian receipt and fee-note fields, the amount convention and the Arabic wording are **UNVERIFIED**. A Tunisian professional and a native reviewer must validate them before any clinical rollout. Every document carries the fictional / not-fiscal notice in each language it prints.

## Options (all routes)
- `lang`: `fr`, `ar` or `both` (default `both`). Arabic sections are `dir="rtl"`.
- `size`: `normal` (12 pt) or `large` (18 pt), for elderly patients.
- `format`: `json` (contract only) or `html` (contract plus a printable HTML sample).

## Receipts — `POST /api/v1/receipts/:id/print` (`receipt.reprint`)
- The **first print is the ORIGINAL** and every later print is **COPY n**. A print never creates a new receipt number. Each print adds a `receipt_prints` row and an audit event `receipt.printed`.
- Concurrent first prints yield exactly one ORIGINAL (advisory lock, T-PRT-12). The existing `/reprint` route is unchanged.
- **Printed fields (whitelist):** receipt number, clinic-local date, clinic, payee, patient name, file number, amount, tender, fees and remaining balance (payments only), the voided receipt number (voids), issued by, and a **fingerprint** (first 12 hex characters of the stored snapshot SHA-256). The fingerprint lets the owner match a patient's paper copy to the system record.
- **Never printed:** internal IDs, the staff-only evidence label ("cash verified only by an independent count"), refund and void reason codes or notes, and any care or clinical detail.
- Amounts are formatted from integer millimes: `1 234,500 DT` / `1 234,500 د.ت` (comma decimal and 3 digits are an ASSUMED Tunisian convention).
- In the HTML, numbers, receipt labels and amounts are wrapped in `<bdi dir="ltr">` so right-to-left text never reorders them. All data is HTML-escaped.

## Blank forms
- `GET /api/v1/print/forms/patient-intake` (`patient.create`) is the **no-phone patient intake form**. Its field keys map one-to-one to `POST /api/v1/patients`. The phone is optional and in-person contact is the first choice. There are **no medical questions**: the form says these are asked by the dentist. T-PRT-9 posts a filled fictional form unchanged.
- `POST /api/v1/paper-books/:id/print` (`paper.issue_book`, owner) prints the **numbered outage slips** for exactly the book's range, each with a patient copy and a clinic stub. Every print is audited (`paper.book_printed`). A second print is marked "RÉIMPRESSION n° 2 — détruire les exemplaires précédents non utilisés".
- The slip asks for the **patient file number** (CH-030). On this base the re-entry API ignores that field; PR #19 (B13) validates it. Field keys map to `POST /paper-books/:id/entries`.

## Tests
`backend/test/b15-printable-contracts.test.ts` contains T-PRT-1..12.

## Not covered
- Amounts in words.
- Printer drivers and thermal widths.
- QR codes.
- A clinic logo or fiscal identifiers (matricule fiscal).
- Dentist permission to print (currently OWNER and RECEPTIONIST, per the existing `receipt.reprint`).
- Sharing the clinic-timezone helper with B12 (#18) at integration.
