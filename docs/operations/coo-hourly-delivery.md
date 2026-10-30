# EZZ Clinic — COO operating agreement (2026-10-29)

**Status:** founder-directed working protocol. This is a draft-branch operating plan, not authority for production deployment or live patient data.

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

**Founder boundaries:** GPT can autonomously research, design, code, open/update draft PRs, run checks, post Sheet/doc handoffs and resolve routine engineering details. Keep separate explicit founder approval for production hosting, real patient data, real payment/receipt issuance, legal/clinical/CNAM acceptance, spending and high-impact merges/releases. Never claim a scheduled run made an external model execute; only a model's separate authorized schedule/connection can do that.

## Shared Sheet protocol

- `UX_COUNCIL`: immutable reviewer history and verified reports.
- `UX_BATCH_COMMAND`: live one-batch/owner/dependency ledger; **use existing IDs, never overwrite previous reviewer messages**.
- `UX_MODEL_REPORTS`: Gemini 20–39; primary Muse 40–59; Muse Ons 60–79; optional Runable 80–99; GPT 100–139. If a lane fills, request a new range; never overwrite.
- `UX_DECISION_LEDGER`: each of 22 screens: show/hide/confirm/error, real implementation, risk, test and decision.
- `MOBILE_DASHBOARD`: latest verified progress, current obstacle, meaningful founder ask only.
- Each worker reads latest command and relevant peer progress, writes exactly what they did, cites SHA/URL, and reads back. No fabricated model collaboration. External worker scheduling/account permissions require account owner's own setup.
