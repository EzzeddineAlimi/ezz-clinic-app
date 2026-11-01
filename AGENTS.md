# EZZ Clinic — shared AI engineering instructions

## Non-negotiable project boundaries
- Development and previews use **fictional data only**. Do not ingest real patient data, process real payments, issue fiscal receipts, or claim production/clinical/legal readiness.
- Do not merge, deploy, alter production configuration, or touch real data without explicit founder authorization. Preserve independent review and existing release gates.
- The current checkout, exact PR head SHA, code, tests, and accepted task scope take precedence over historical handoffs. Read `docs/engineering/standards.md` when engineering policy is relevant.

## Work on the smallest verified scope
- At task start identify the target branch/head, intended behavior, affected files, and acceptance checks. Inspect relevant implementations, dependencies, and current diffs; do not re-read the entire repo or paste large handoffs for every small task. For a requested comprehensive audit or cross-cutting safety change, inspect all relevant code and evidence exhaustively.
- Before editing, state the observable goal, any material assumptions, the simplest in-scope implementation, and pass/fail acceptance criteria. If ambiguity could alter patient identity, care, money, permissions, privacy, or a release gate, document a blocker and stop only that affected slice; for low-risk details, follow existing conventions and report the choice.
- Avoid speculative features, one-use abstractions, unrequested configurability, and defensive code for impossible states. Match nearby code style. Do not mix in unrelated refactors, formatting sweeps, or cleanup of pre-existing dead code; remove only unused code introduced by this change.
- Bug protocol: formulate a causal theory, obtain direct evidence (existing logs or a targeted failing regression test), then make the minimum fix. Where reproducible, record red-before/green-after regression evidence. If the cause is unverified, report the blocker instead of making speculative repairs.
- Keep modular TypeScript boundaries and server-side controls: role/clinic isolation, dentist authority, integer millimes, idempotency, append-only/audited facts, receipt sequence, and physical-cash evidence limitations. Do not weaken safeguards to speed delivery.
- Reuse scripts and CI for repeated deterministic operations. Introduce a new script only when repetition is demonstrated and maintaining it is worthwhile.

## Use AI context deliberately
- Start at `docs/INDEX.md` to locate current domain authorities; read only the relevant source documents and current code. Treat accepted product scope, implemented behavior, and release readiness as different claims. Draft PRs and historical handoffs are not merged functionality.
- When a change affects an accepted workflow, API, permission, schema, UX state, environment, security control or release gate, update the corresponding authoritative document in the same PR; regenerate generated contracts rather than hand-editing them. Record unresolved conflicts, not speculative decisions.
- Reuse stable repository instructions, precise file paths, current API contracts, diff ranges, and evidence links instead of repeatedly pasting the same project history.
- **When changing agent instructions or existing scheduled-task prompts**, replace the superseded rule in the authoritative text, remove contradictory older directions, and read back the saved result. Keep a short conditional pointer in always-loaded instructions; load detailed playbooks only for matching tasks. This does **not** authorize editing append-only audit logs or historical review entries.
- Keep one focused task per session; start a new session for an unrelated task and compact long sessions around the active task. Do not keep stale context just to chase cache hits.
- Use expensive reasoning for difficult architecture/security questions, and cheaper models for bounded routine work **when selected by the operator**. This file cannot switch models or guarantee vendor cache hits.
- Keep independent adversarial review for payment, authorization, privacy, clinical, and release-critical changes. A model must not self-certify its own high-risk work.

## Repository-local engineering skills

Use the smallest relevant repo-local playbook when the task fits. These are **adapted guides**, not new workers, automatic background executions or permission to install an external plugin. Open the linked `SKILL.md` before work; existing repo standards and clinical/financial/privacy/release gates take priority. **If a failure's cause is unproven, start with diagnosis; once the cause and expected contract are established, use vertical TDD.**

| Trigger | Read this playbook |
| --- | --- |
| Bug, flaky test, performance regression or a failure without a proven cause | [Evidence-first diagnosis](.agents/skills/ezz-bug-diagnosis/SKILL.md) |
| Implementing or fixing a behavior with testable contracts | [One vertical red/green slice](.agents/skills/ezz-vertical-tdd/SKILL.md) |
| Reviewing a PR or changed code | [Two-axis standards + requirement review](.agents/skills/ezz-two-axis-review/SKILL.md) |
| Authoring a PR description or merge handoff | [Concise PR evidence](.agents/skills/ezz-pr-evidence/SKILL.md) |

Use [`GLOSSARY.md`](GLOSSARY.md) for the shared meaning of clinical/financial evidence terms. If code, a current authoritative decision, and the glossary disagree, **do not silently rename data or change a business rule**: identify the conflict, report it and update the glossary only when the approved meaning is established. The [upstream skills fit audit](docs/engineering/matt-pocock-skills-fit-2026-11-01.md) records adopted and rejected ideas; it is not a live task queue.

## UI/UX quality contract (all future visual work)
- Read `docs/design/ui-ux-pro-max-ezz-fit-2026-10-30.md` and the relevant current role-workspace spec before changing frontend UI. External UI/UX Pro Max suggestions are advisory; verify them against React/Vite implementation, clinic workflows, current accepted design direction, accessibility and domain safety.
- Resolve verified best-practice conflicts, even when existing draft UI PRs need reconciliation. Fix shared primitives at their source, one focused PR at a time; preserve active ownership, ancestry, actual test evidence and independent review. Do not broadly re-theme, install unreviewed upstream scripts or invent unsupported interactions.
- For each changed journey, record real fictional-API screenshots and tests for the affected French/Arabic RTL, mobile/desktop, keyboard/zoom, error/pending/empty states, permissions and clinical/financial safeguards; use existing Playwright/axe CI. A screenshot or automated scanner alone is not UX sign-off. Never claim tests were run when they were not.

## Verify and hand off
- For applicable backend changes run `npm --prefix backend run typecheck`, `npm --prefix backend test`, and `npm --prefix backend run test:dist` with PostgreSQL 16 and the required test environment.
- Run `npm --prefix backend run lint` and `npm --prefix backend run lint:verify` for the configured authored-backend quality gate; its scope and baseline are in `docs/engineering/backend-quality.md`.
- For applicable frontend changes run `npm --prefix frontend test` and `npm --prefix frontend run build`; run `npm --prefix frontend run test:e2e` against the configured fictional real-API environment when affected. Leave GitHub Actions as the authoritative CI check on the exact PR head.
- Report exact commit/PR SHA, goal and acceptance checks, scope, commands **actually run**, pass/fail/skip, remaining risks, and reviewer action. For intentional refactors, compare pre-change and post-change tests. Never claim unrun tests passed.
- Backend and frontend authored-source lint checks and read-only `format:check` scripts are configured. A passing lint check does **not** prove the formatter baseline is clean or formatter enforcement is enabled. See `docs/engineering/backend-quality.md` and issue #74 for remaining formatter work. Avoid mass reformatting unrelated files.
- Persist durable outcomes and handoffs in GitHub PRs/docs and the approved Mission Control lane—not solely in a local agent workspace. Avoid duplicating old evidence; link it by immutable SHA.
