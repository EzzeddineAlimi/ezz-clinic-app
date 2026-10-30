# Independent UX review — Muse Ons / MUSE-UX-B

**Status:** Reviewer report DELIVERED and readback-verified in Mission Control `UX_COUNCIL!A9:H18` (October 29, 2026). **Research is not design approval, clinical validation, or proof of behavior in the merged app.** Only the two fictional desktop Canva concepts exist. This is a GPT synthesis of the reviewer’s findings, not a claim that GPT independently reproduced the review.

**Source boundaries:** Muse Ons read `docs/design/role-workspaces-v1.md` (blob `d9206a33a5e6c76d47e2578d026918d7349033a9`) and `docs/design/reviewer-assignments-v1.md` (blob `9f3047738c0d155a4414e0bad6913f59f37218cb`) directly via GitHub PR #59; read `UX_PAGE_INVENTORY`; did **not** inspect live application, backend contracts, `docs/images/sprint2` / `sprint3b` or issue #58 in full, nor the other reviewers' findings. 1–5 scores reflect this brief, not measured task success or click reduction.

## Verified design artifacts

| Proposed screen | Actual reported Canva link | State |
|---|---|---|
| Receptionist dayboard | https://canva.link/01rs560zl9rvp6u | Editable French desktop visual, fictional-only |
| Dentist clinical workspace | https://canva.link/iswwjg20vcfiofa | Editable French desktop visual, fictional-only |
| Owner cash / financial | **NO DESIGN CREATED** | Canva `quota_exceeded`; written specification exists |
| Arabic RTL and 390px mobile | **NO DESIGNS CREATED** | Written behavior only; no visual acceptance |

Reviewer-reported quota reset: 2026-11-01 00:00 UTC (2026-10-31 20:00 America/Toronto). **Do not retry before reset**. Following reset, author may voluntarily produce missing owner, mobile and RTL examples; do not automatically launch work or claim credits became available.

## Good design proposals — candidate decisions, not implementation authorizations

1. **Reception:** `R01` is home (time/status/verified patient file/dentist/one row action). `R02` search overlay, `R03` minimal register, `R04` booking dialog, `R05` arrive/reschedule/no-show as dayboard actions, `R07` print as contextual action. `R06` safe checkout remains separately gated. Each proposed simplification depends on preserved backend access rules, availability/reschedule lineage and distinct patient identity.
2. **Dentist:** `D01` day overview; `D02–D06` one continuous encounter with **Overview / Chart / Notes / Plan / Performed Care** tabs plus patient file number and signed-in acting dentist permanently visible. `D07` imaging, prescription and e-consent are future/unimplemented unless supported by approved backend and local validation.
3. **Owner:** exceptions-first overview; `O02` blind count **isolated** before any expected amount or difference is revealed; `O03` distinct authenticated review/close; finance reporting and configuration are secondary. Source-quality labels distinguish staff assertions from independently verified external facts.
4. **Cross-role:** Arabic RTL requires true mirrored layout and bidi isolation for FDI tooth numbers, dates and millimes; large printable FR/AR slips and numbered paper outage books; clear uncertain, duplicate, no-permission, printer, offline and ambiguous-person states; distinguish planned/estimated, performed/confirmed, billed and paid.

## Two concrete visual findings in supplied Canva-preview screenshots

**UX-B-CRIT-01 · Receptionist `R01`:** The *En soin* row in the proposal shows the action *Encaisser*. That affordance could be read as permission to collect a bill for care still ongoing. **Fix:** use a neutral `Voir la visite` / `Ouvrir` action or disabled `Encaisser` with `Soin non confirmé par le dentiste` until the server has confirmed charge eligibility, and only then enable checkout. Do not relax the existing backend dentist-only confirmation gate. Add screenshot/browser assertions for `IN_PROGRESS + no confirmed care` and `confirmed performed care + payment-ready`.

**UX-B-CRIT-02 · Dentist `D04`:** The visual simultaneously says *Note SOAP signée* and shows an active `Signer la note` button. **Fix:** use distinct draft vs signed views; a signed note shows `Signée par … à …` and `Ajouter un rectificatif` (only where corresponding backend feature exists), **not another sign action**. In current V1, don't represent unimplemented addendum UX as clickable. Add test for signed-note immutable rendering and a read-only action rail.

**UX-B-UX-03 · Receptionist `R01`:** A row already marked *Arrivé* still shows `Arrivée`, suggesting duplicate check-in. Replace with status-appropriate next action, rather than an idempotency-dependent duplicate button.

All three are **mockup inconsistencies**, not confirmed defects in `main`; annotate visual artifacts and correct before production UI re-skin.

## Remaining gates and reconciliation

- **Independent reviewers not received:** Gemini `GEMINI-UX-A` (clinic workflows), primary Muse `MUSE-UX-A` (adversarial design safety), Runable `RUNABLE-UX-A` (actual React screenshot code/usability). Never mark these complete because Muse Ons delivered.
- Reconcile against approved 61 V1 groups, actual current `main` server contracts and real Playwright screenshots. Do not invent CNAM tariff or clinician approval.
- Deliver 1440px desktop **and** 390px mobile and FR/Arabic RTL variants for S0–S4; at least five screenshot baselines, unhappy-path/axe/keyboard tests and real-PG16 integration. The two desktop French Canva references **do not** meet this acceptance bar.
- UI redesign sequence remains receptionist-first, one working journey at a time, behind draft PR; preserve idempotency, medical authority, actor provenance, tenant isolation and blind cash state separation.
