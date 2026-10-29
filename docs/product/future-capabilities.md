# Future capabilities — prioritised (Mission H, kept short on purpose)

Status: product-architecture assessment by Claude Opus 5.5, 2026-10-28. Not feature approval. Scores are ASSUMPTIONS (1 = low, 5 = high); "dentist effort" is extra effort per day. Market data were not re-researched (R33 catalogue already holds 239 raw ideas).

| Capability | Clinic benefit | Cost/complexity | Regulatory risk | Dentist effort | Architecture prerequisite | Recommendation |
|---|:-:|:-:|:-:|:-:|---|---|
| Clinical module (odontogram, plans, notes, alerts) | 5 | 4 | 3 (health data) | must stay ≈ today | clinical migration per clinical-requirements §16 | **NEXT after financial core hardening** |
| Financial reporting (day/month, tender mix, discounts by reason, aged balances) | 5 | 2 | 2 (fiscal format UNVERIFIED) | 0 | read models over existing facts | **NEXT** |
| Patient credits / deposits (MF10) | 4 | 3 | 2 | 0 | credit ledger + independent source of cash credit | NEXT |
| Recalls & reminders (paper card first, SMS opt-in) | 4 | 2 | 3 (SMS gateway = transfer if foreign) | 0 | recall table; channel adapter | Soon, paper first |
| Lab tracking (MF19) | 3 | 2 | 2 | ~0 | lab_cases + anti-fraud tie (lab work without billed care) | Soon |
| Inventory / materials | 2 | 3 | 1 | 0 | stock ledger | Later (MF20 postponed) |
| Scheduling optimisation | 2 | 3 | 1 | 0 | stable visit data first | Later |
| Multi-dentist / multi-location | 3 | 3 | 2 | 0 | already clinic-scoped; needs per-dentist payee and multi-drawer | Later; schema ready |
| Patient portal (optional) | 2 | 4 | 4 | 0 | patient identity, consent, hosting law | Defer; never mandatory (elderly/no-phone) |
| Business intelligence | 3 | 3 | 2 | 0 | reporting read models | Later |
| AI administrative assistant | 2 | 3 | **5** (Art. 22/50-52/63 transfers) | — | local/Tunisian-hosted model only after counsel | **Blocked by legal questions Q2–Q4** |
| AI clinical-document assistance (draft notes, human sign-off) | 3 | 4 | **5** | − (saves time) | signed-note workflow, addenda | Blocked; human review mandatory |
| PSP / bank integration | 5 (fraud) | 4 | 4 | 0 | provider feed table exists (tier 3) | When a verified Tunisian provider offers authenticated data |
| E-invoicing (if required for fee notes) | — (compliance) | 3 | 5 | 0 | pluggable fee-note renderer | Track 2026 Finance Law Art. 53 dispute |
| Subscription & licensing | business | 2 | 2 | 0 | tenant table + plan flags that **cannot** disable anti-theft controls | Before first paying clinic |

Principles: no feature may add a mandatory patient smartphone step; no feature may let the desk disable or bypass an evidence control; every new money path must produce receipts, audit events and owner-visible exceptions in the same transaction.
