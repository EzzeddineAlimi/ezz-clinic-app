# EZZ Clinic — COO operating agreement (2026-10-29)

**Status:** founder-directed working protocol, updated 2026-10-30. This is not authority for production deployment or live patient data.

## Accountable leadership

**GPT-6 is the COO, primary software architect, product designer, UX lead and lead implementer.** It owns prioritization, GitHub draft PRs, interface specifications, code integration, CI evidence, architecture, technical decisions and Mission Control status. It chooses the next batch autonomously based on user value, safety, implementation readiness and tests, rather than soliciting a founder decision for every tiny technical choice.

Specialists are independent critics, *not alternate owners of the application*:

| Specialist | Primary job | Expected evidence | Not their job |
| --- | --- | --- | --- |
| Gemini | Concise Tunisian dental workflow/domain/product critique | Conflicting V1 needs, necessary desk/doctor/owner actions, FR/AR/paper/CNAM caveats, citations when applicable | Repeated broad market research or blocking UI implementation |
| Muse (primary) | Adversarial code and safety/financial controls reviewer | Exact source SHA, exploit/failure case, negative regression, PASS/WITH FIXES/BLOCK when warranted | Canva and routine styling decisions |
| **Muse Ons** | **Independent critical UX reviewer of GPT-made designs and implemented screens** | Read actual GitHub/Canva/screens; challenge page IA, click/task friction, usability, RTL/mobile/elderly/paper, confusing unsafe controls, accessibility and test assertions | **Primary Canva or UI design production**; routine backend coding; redoing the primary Muse security audit |
| GPT-6 COO | Own architecture, **UI/UX design and React implementation**, product decisions, source/test integration | Working design system, coherent PR diffs, evidence-backed browser tests, reconciled reviewer objections | Claiming another reviewer approved something they haven't reviewed |

Muse Ons's past **MUSE-UX-B** independent research and two optional Canva proposals are preserved as historical evidence in UX_COUNCIL rows 9–18. Canva and GitHub/Sheet connections are useful *tools*, not automatic tasks. The already delivered two Canva images do not appoint Muse Ons as head designer. Owner and RTL/mobile Canva concepts may be built directly by GPT, without consuming Muse Ons AI credits; any further Muse Ons Canva work is optional and subject to its quota/permission.

## Execution cadence and bulk delivery

### Mandatory open-PR closure gate (2026-10-31)

Before selecting another implementation batch, inventory **every open PR across all pages**, not just recently updated branches, red CI, or the newest model-review rows. **Process the entire integration-root queue oldest-first by PR creation timestamp; blocked roots keep a named owner and evidence while the worker advances to the next oldest actionable item. Do not begin a new PR just because the oldest is blocked.** Group open PRs by their target/head branch dependency chain; name the root, oldest creation time, accountable implementer, review/CI status **at exact head**, integration target and next action. Update the existing Mission Control dashboard and log a changed root status only when it changes. Green CI or a review of a descendant is not proof that the root merged into `main`.

**Hard workflow limits:** no more than **three** open PRs in one dependency chain; a stack root open **24 hours** or an independent PR open **48 hours** requires immediate actionable reconciliation. Once a chain reaches three, the next step is integrating/reviewing its existing work, **not opening a fourth dependent draft**. For a breach, stop *extending that stack*, identify a current-main integration candidate and precise blockers; continue only unrelated authorized work or urgent safety repairs. A critical patient/security concern may require an isolated fix, but never silent bypass of review gates. Closing an unmerged PR is not a substitute for preserving its changes: verify exact SHA ancestry after an approved integration or explicitly document why a discarded draft is obsolete.

`scripts/governance/pr-backlog-check.mjs` independently checks these invariants using the live GitHub open-PR API; `.github/workflows/pr-backlog-watch.yml` runs a **daily read-only check** and a regression test on changed guard code. A failed watch is backlog evidence, **not** permission to automatically merge or delete. The existing hourly Build Council preflight and CI watcher are the faster detection/triage layer; daily GitHub Actions is an independent backstop. Scheduled GitHub Actions can be delayed, and a PR may be blocked for legitimate safety reasons: always report the blocked root with the next reviewer/actor instead of claiming an absolute resolution guarantee.


GPT's existing **EZZ Clinic Build Council** automation ID `6ae3f2acf2c48191a54969b305d917f4` is enabled **hourly**, which is the highest supported recurring frequency. It is independent from the active CI watcher. **The paused older research council is not a required dependency and must not be silently reactivated.**

At each scheduled cycle:
1. Read exact current `main`/draft PR status, newest model Sheet findings, `UX_BATCH_COMMAND` and the 22-page `UX_DECISION_LEDGER`. Verify rather than guess.
2. Choose one **substantial vertical batch**: a working receptionist journey / dentist tabs / owner cash UX, a design-token and shell slice, or source-backed critical defect/remediation. Define the acceptance gates up front, keep scoped.
3. Develop independently on a draft branch; use real fictional PostgreSQL API, TypeScript, unit/browser/axe/RTL and screenshots as appropriate. Write full diff and tests to GitHub, let exact-head CI prove or refute readiness.
4. Ask specialists for **one bulk independent review** per meaningful milestone. Cross-critique only high-impact contradictions; no repeating research or consensus ceremonies for straightforward decisions.
5. Record evidence, status, blockers and next batch in model-owned Sheet lane + compact MOBILE_DASHBOARD and read back. Do not change another model's content.
6. Notify the founder when a significant demo/design choice is ready, a material risk needs acceptance, a release/merge authorization is needed under existing project policy, or an external action is actually required. No one-question-per-feature workflow.

### Current bulk delivery order

- B1: receptionist role shell + dayboard + identity, search/booking/arrival + payment/receipt truth states; fix mockup R01 `En soin` showing `Encaisser`, duplicate arrival CTA, preserve server charge gate.
- B2: dentist today + one tabbed encounter with permanently pinned patient identity/true acting dentist; signed note cannot render `Signer` after sign; keep planned/quoted/performed/charged separate.
- B3: owner finance shell + isolated blind count, post-count review/close, staff-entered vs externally reconciled evidence.
- B4: complete French/Arabic RTL, 1440px desktop, 390px mobile, 200% zoom, keyboard, printable paper, visual regression 5+ screens and adverse states; incorporate from B1 forward, do not postpone all accessibility to the end.

**Review gates:** Every role-specific change needs actual component/screenshot test evidence. Muse Ons challenges UX before merging consequential visual changes; Muse challenges clinical/financial/permission risks. Critical findings must be answered with an exact code/test diff or explicit deferral. No aesthetic vote may override server controls.

**Founder boundaries (2026-10-30 standing authorization):** GPT may merge **routine low-risk** approved-scope development PRs only after verifying exact-head and integrated-main applicable CI, complete dependencies, nonbreaking diff and required independent reviews at the relevant head. Use a merge commit with expected head SHA, verify the new main and its post-merge Actions before any further merge. Main protection currently has **zero required CI checks**, so these are manual fail-closed gates. Hold and notify the founder for permission/auth/security, clinical record integrity, payments/refunds/cash, CNAM/legal, destructive migrations, sensitive data/integrations, missing independent review, CI gaps or unexpected drift. Keep separate explicit founder approval for production hosting, real patient data, real payment/receipt issuance, legal/clinical/CNAM acceptance, spending and high-impact merges/releases. Never claim a scheduled run made an external model execute; only a model's separate authorized schedule/connection can do that.

## Shared Sheet protocol

- `UX_COUNCIL`: immutable reviewer history and verified reports.
- `UX_BATCH_COMMAND`: live one-batch/owner/dependency ledger; **use existing IDs, never overwrite previous reviewer messages**.
- `UX_MODEL_REPORTS`: Gemini 20–39; primary Muse 40–59; Muse Ons 60–79; optional Runable 80–99; GPT 100–139. If a lane fills, request a new range; never overwrite.
- `UX_DECISION_LEDGER`: each of 22 screens: show/hide/confirm/error, real implementation, risk, test and decision.
- `MOBILE_DASHBOARD`: latest verified progress, current obstacle, meaningful founder ask only.
- Each worker reads latest command and relevant peer progress, writes exactly what they did, cites SHA/URL, and reads back. No fabricated model collaboration. External worker scheduling/account permissions require account owner's own setup.
