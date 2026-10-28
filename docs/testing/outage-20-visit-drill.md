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
