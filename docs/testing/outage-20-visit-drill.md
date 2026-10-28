# R46 — Outage drill (fictional data, research only)

## Two independent experiments — not equivalent proof
- **PostgreSQL API paper-reconciliation drill:** see \`backend/test/outage-20-visit.test.ts\` once added and confirmed by CI. Tests role separation, 20 visits in a 4-hour window, 16 partial-cash slips, two void slips, one dentist-declared unused slip and P-120 not accounted for. Replay should not create duplicate payments. Existing \`c6-paper-outage.test.ts\` covers real process restart and paper/card evidence limits.
- **Local SQLite candidate:** \`node backend/scripts/sqlite-outbox-drill.mjs\` (Node 22 built-in experimental \`node:sqlite\`). Demonstrates a **local queue only** with 20 fictional visit identities; 19 accounted entries, one missing, one deliberate duplicate and one conflicting amount, persistence after close/reopen. **Does not sync with a server**, prove authentication, detect off-book money, or meet medical privacy requirements.

Fixture values: 16 synthetic cash payments of 20,000..35,000 millimes totaling **440,000 millimes** (440 DT); no live transactions. Two slips void, one unused, one unaccounted. Do not confuse paper-vs-SQLite storage with real-world payment proof.

## Evidence and measurement limitations
- The automated result verifies software behaviors, not physical paper custody or patients' copies.
- Numbered paper takes 1 entry per patient, plus two void explanations, one custodian declaration, and owner review of discrepancies. These are **scripted actions**, not observed staff workload.
- **Actual receptionist seconds/visit and owner minutes/close = NOT MEASURED.** A future permitted field study is needed before choosing either approach.
- SQLite version, local-device encryption, stolen laptop, device-clock drift, multi-device merge, backup key storage and owner checkpoints are unresolved.
- Final offline architecture, staffing actions and clinical release remain founder-gated.

## B13 — conflict-safe re-entry and book-level reconciliation (`backend/test/b13-paper-reconciliation.test.ts`)

The changes below were made server-side on top of this drill. Defects marked RED were reproduced against this PR's head before the fix.

| Test | What |
|---|---|
| T-PAP-1 (RED, CH-030) | A USED slip may carry `patientFileNo`, the file number written on the paper. If it is not the visit's patient, the slip is **REJECTED `PAPER_SLIP_PATIENT_MISMATCH`**: patient B's balance is untouched, and the slip can then be posted to A's visit. |
| T-PAP-2 (RED) | A slip posted **without** a file number appears as review item `NO_PATIENT_REFERENCE` ("check against the patient copy"). |
| T-PAP-3 (RED, CH-029) | `reconciliation.careVsSlips` puts each posted slip next to the care charged on its visit: charged, paid by slip, paid otherwise, balance, and book totals. |
| T-PAP-4 | With `?outageFrom&outageTo` (ISO, at most 7 days), `careWithoutPayment` lists care in the window that has no slip and no payment (`CARE_WITHOUT_SLIP_OR_PAYMENT`). With no window, the section is `null` and nothing is guessed. |
| T-PAP-5 | `DATE_DIFFERS_FROM_VISIT` (the slip date is not the visit's clinic-local day) and `MULTIPLE_SLIPS_ONE_VISIT` (instalments are possible). Both are human checks with neutral wording. |
| T-PAP-6 | Replay compatibility. `patientFileNo` enters the content hash only when present, so the PR #8 replays stay `DUPLICATE_ENTRY`. Adding a file number to an already-posted slip is a `CONFLICT` and never a second payment. |
| T-PAP-7 | The server is killed (SIGKILL) while a 5-slip batch is blocked mid-transaction. No partial batch survives, the replay posts each slip exactly once, and a second replay posts none. This already held on this head; it is a regression guard. |
| T-PAP-8 | Owner exceptions show `PAPER_NO_PATIENT_REFERENCE` and `PAPER_DATE_DIFFERS_FROM_VISIT`. |
| T-PAP-9 (RED) | A slip pointing at another clinic's visit used to fail the **whole batch** (foreign-key 404). It is now rejected on its own, and the other slips of the batch still post. |

Migration `0009_paper_slip_patient_ref.sql` adds one nullable column. It is numbered 0009 so it never collides with 0008 (PR #12).

**Limits**
- Whether the physical slip has a file-number field is **UNVERIFIED**; it is a paper-form design question for GPT and the founder.
- Making `patientFileNo` mandatory is a later decision.
- A slip never written, or an amount different from the patient's copy, remains invisible to the app (C-146 Mode B).
- Paper payments still create no electronic receipt; the numbered slip is the receipt.
