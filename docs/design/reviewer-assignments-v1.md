# EZZ Clinic — three independent role-UX design reviews

**Assignment status:** prepared by GPT, **NOT sent automatically**. The founder must manually prompt each external model. The user wants current application visuals and what must be included; do **not** ask the models to implement React, merge PRs, alter data or pretend tests ran. Preserve named feedback and source.

**Canonical starting point:** `EzzeddineAlimi/ezz-clinic-app`, main `406c5dd1fd16dd543f2c0b9a3a601af33ae6568b`; UX issue #58; `docs/design/role-workspaces-v1.md` in the draft design branch `gpt/design-a-role-ux-spec`; actual fictional UI screenshots in `docs/images/sprint2/` and `docs/images/sprint3b/`; model-neutral `AGENTS.md`; Mission Control `V1_ACCEPTANCE_CURRENT` 61 groups. The desired concept is A (deep-teal/white clean professional) with distinct receptionist/dentist/owner home surfaces, one app, FR+Arabic RTL. Proposed design is not shipped or domain-approved. Do not infer implemented features from generated AI concept imagery.

## Gemini — workflow completeness & Tunisian practice fit

**Verified previous work:** latest independently Gemini-authored `GEM-CNAM-R78-A` in GEMINI_COUNCIL row 15 (October 29), followed by founder-relayed Round B correction row 16 (not Gemini-authored). Do not re-research CNAM tariffs for this job.

Prompt:

> Gemini, please independently critique the EZZ Clinic proposed **Concept A role-based visuals**, not its already reviewed financial backend. Read the current `main` GitHub frontend and actual screenshots, UX issue #58, `docs/design/role-workspaces-v1.md`, and the 61 approved V1 scope groups. Do not assume generated concept images are real software. Prioritize Tunisia-specific real clinic workflow practicality: one busy receptionist, several dentists with vacation cover, dentists minimizing time on software, elderly/paper/no-phone patients, cash/partial payments, French/Arabic RTL and paper CNAM. Produce a role-by-role list of (a) top ten MUST-HAVE visible actions/data, (b) five MUST-NOT-SHOW or misleading signals, (c) task sequences/clicks for book-arrive-confirm care-collect-payment-print/close day, (d) missing appointment leave/reschedule, guardians/consent, quote and CNAM paper states that must be labeled future/unavailable, (e) 320px/390px/1440px readability, and (f) top five research uncertainties with evidence levels. Separate IMPLEMENTED NOW vs PROPOSED NEXT; do not invent regulatory requirements or approve clinical workflows. Provide concrete component/state suggestions and ranked acceptance tests, plus alternative visual recommendations if Concept A creates usability problems. Post response in `UX_COUNCIL` as Gemini-UX-A when you have access; otherwise send text to founder to relay, and explicitly state when you did not inspect code. No code writes, merges or deployment.

## Muse — adversarial UI safety review

**Verified previous work:** most recent Muse-authored `M-281` in MODEL_INBOX row 293 was a PASS for fictional integration, dated October 29. That does NOT approve a new visual design.

Prompt:

> Muse, review EZZ Clinic **Concept A** as an independent adversarial UX/safety engineer, **without repeating the already passed M-281 repository review**. Source: main at `406c5dd1fd16dd543f2c0b9a3a601af33ae6568b`, `docs/design/role-workspaces-v1.md` on `gpt/design-a-role-ux-spec`, issue #58, actual captures `docs/images/sprint2` and `sprint3b`. Find the ways a beautiful interface could cause wrong-patient care, misleading dentist/owner permissions, unseen medical alerts, false signed-note edits, planned treatment falsely shown as performed, duplicate/uncertain payments, false 'card settled' claims, owner blind count leakage, unsafe cancellation, or misleading cash discrepancy/theft labels. Also assess Arabic RTL, keyboard focus, small screens, accessibility and unattended reception. Return a ranked top-12 risk-state screen list, exact visible copy/actions/gates for each, at least 10 negative browser/screenshot tests, and PASS/WITH FIXES/BLOCK **for the design brief only**. Flag backend authorization boundaries that UI must never imply it overrides. Post to `UX_COUNCIL` as Muse-UX-A or, lacking Sheet/GitHub write access, send founder a clearly attributed report for GPT relay. No code writes, merge, deploy or real data.

## Runable — read-only actual-screen usability audit

**Verified previous work:** `RUNABLE_AUDIT` only rows 2–13, dated October 27, reviewing the **original prototype ZIP** (e.g. `src/clinic.ts`, `public/index.html`), **not** the current React/PostgreSQL frontend. Do not reuse those findings as new screenshots or pretend the current app was visited.

Prompt:

> Runable, independently perform a **read-only UI/UX audit of the CURRENT EZZ Clinic application**, not the old prototype ZIP. Current GitHub `main` is `406c5dd1fd16dd543f2c0b9a3a601af33ae6568b`. Inspect frontend source plus existing actual fictional Playwright screenshot files in `docs/images/sprint2/` and `docs/images/sprint3b/`, design-brief branch `gpt/design-a-role-ux-spec`, and GitHub issue #58. If the private fictional Codespaces preview is not available, state that explicitly and use only available source/screenshot evidence. Compare real screen behavior to Concept A for receptionist, dentist, owner. Audit IA, spacing, hierarchy, labels, form complexity, navigation, error/empty/loading/retry, contrast, keyboard, 390px/320px, Arabic RTL, paper print and truthfulness of financial/clinical states. Give a screenshot-by-screenshot critique with filenames and reproducible issues, a concise prioritized screen inventory, an order for implementing visual tokens/shell without breaking tests, and 8–12 acceptance assertions. Identify exact existing components/selectors when possible. Do not alter repo/Sheet or claim browser access not actually obtained. Send result as Runable-UX-A to founder, or write in `UX_COUNCIL` if genuinely supported. No paid runs or deployments.

## Consolidation protocol for GPT

1. Do not start a new autonomous Gemini/Muse/Runable job or claim anything was sent without founder manual prompt.
2. Receive independent feedback with attribution; check newest individual participation AGAIN before any follow-up prompt.
3. Classify each finding with status `ACCEPT / DEFER / NEEDS CLINICIAN / REJECT`, evidence/source and V1 group ID. Cross-check frontend source and server contract; never implement an unsafe proposed shortcut.
4. Produce one reconciled role/screen/component decision in issue #58 + the `UX_COUNCIL` tab. Only then implement UI design tokens and one vertical receptionist workflow behind a behavior-preserving PR. Use GitHub Actions and real PostgreSQL test gates, and one risk-proportionate security review if authoring/cash semantics change.
