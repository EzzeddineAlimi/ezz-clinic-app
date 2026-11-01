# Matt Pocock skills: line-by-line inventory scan and EZZ Clinic fit

**Review date:** 2026-11-01 · **Upstream:** [mattpocock/skills](https://github.com/mattpocock/skills) at exact [`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d), MIT licensed. **EZZ comparison:** merged `main` at `1e1cb6a2c8cd24d8aeda079bb7dc71de4692e6f8`. Source and current-head claims must be rechecked before later use.

## What was inspected

The upstream Git tree listed **184 tracked files, 282 tree entries**. Every tracked file's text was retrieved at the pinned blob and scanned by line for role, invocation, setup and potentially modifying command patterns. Relevant `SKILL.md` and the project's `README.md`, `SCOPE.md`, `CONTRIBUTING.md`, `CLAUDE.md`, plugin manifest and setup documents were additionally read as complete working guidance. This is an **inventory and compatibility audit**, not proof that upstream skills were executed inside EZZ or that every recipe was tested. The .agents, out-of-scope, changesets, GitHub automation, scripts, licensing, docs, productivity, in-progress, deprecated and misc buckets were included in the inventory. **No upstream installer, shell hook, npm package, marketplace plugin or scheduled task was run or installed.**

## Decision

**Adapt four small practices locally; do not wholesale import the skills suite.** EZZ already has its own `AGENTS.md`, engineering standards, GitHub issue/PR workflow, independent Muse/Muse Ons review, fictional-API testing, protected-main governance and 11-worker operating model. Re-running upstream setup and triage could duplicate labels/branches/tasks, change contributor behavior, or blur clinical/financial acceptance.

| Upstream promoted engineering skill | EZZ decision | Why / where |
| --- | --- | --- |
| `tdd` | **ADAPT** | [EZZ vertical TDD](../../.agents/skills/ezz-vertical-tdd/SKILL.md): public API/PG16/Playwright seam, observed RED → minimal GREEN, exact-head checks |
| `diagnosing-bugs` | **ADAPT** | [EZZ diagnosis](../../.agents/skills/ezz-bug-diagnosis/SKILL.md): user-required theory → direct evidence → surgical fix |
| `code-review` | **ADAPT** | [EZZ two-axis review](../../.agents/skills/ezz-two-axis-review/SKILL.md): standards AND accepted requirement, separately; human/independent gates remain |
| `pr` | **ADAPT** | [EZZ PR evidence](../../.agents/skills/ezz-pr-evidence/SKILL.md): readable summary, before/after test, blast radius, reversibility |
| `domain-modeling` | **ADAPT CONCEPT** | New [root glossary](../../GLOSSARY.md); current domain decisions and code stay authoritative |
| `codebase-design` | **ALREADY COVERED** | [architecture](../architecture/architecture.md), existing modular boundaries, [SOLID audit](../architecture/R74-SOLID-AUDIT.md); no new abstraction mandated |
| `grill-with-docs` | **ON-DEMAND ONLY** | For a *genuinely ambiguous* clinical/fiscal product decision; do not block bounded approved execution with interviews |
| `research` | **ALREADY COVERED** | [docs index](../INDEX.md), cited CNAM source grading and specialist release gates |
| `to-spec` | **ON-DEMAND ONLY** | Existing founder-approved V1 scope / issues take precedence; no invented new spec |
| `to-tickets` | **RESTRICT** | Only after duplicate/open-PR inventory and a real independent slice; no exploding issue/PR stacks |
| `implement` / `implement-spec` | **RESTRICT** | Existing one-owner-per-branch workflow; parallel implementation agents must not bypass independent current-head review or founder gates |
| `triage` | **RESTRICT** | GitHub existing labels/issues and oldest-first rule govern; do not create/rename labels automatically |
| `setup-matt-pocock-skills` | **SKIP INSTALLER** | Already-configured repository; manual curated local docs only, no plugin or global settings changes |
| `ask-matt` | **SKIP** | No need for another orchestration/router layer |
| `improve-codebase-architecture` | **ON-DEMAND AUDIT** | Survey only for a demonstrated recurring coupling issue; do not launch routine redesign |
| `wayfinder` | **SKIP CURRENTLY** | Long-horizon planning already in Mission Control / 61-group acceptance; avoid competing tracker |
| `retro` | **ADOPT AS REVIEW HABIT** | After observed failures, prefer an executable regression or lint rule over another speculative policy |
| `prototype` | **RESTRICT** | Fictional, isolated throwaways only; never confuse a mock with real-API UI proof |
| `wizard` | **NOT NEEDED** | Real-account/production setup is unapproved; no interactive secrets workflow introduced |

### Productivity and experimental buckets

- `grill-me`, `grilling`, `wait-what`, `to-questionnaire`: useful for genuinely unresolved human decisions, but **not default interviews** before already authorized work.
- `handoff`: existing attributed Mission Control/GitHub handoffs already cover continuity; avoid duplicate handoff stores.
- `writing-for-agents`: **ADOPT CONCEPT in `AGENTS.md`**, not as an extra skill. It directly addresses observed obsolete instructions left inside GPT schedules: edit one authoritative instruction in place, preserve lightweight task-trigger pointers, and verify saved readback. Append-only evidence rows remain immutable. See [upstream source](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/writing-for-agents/SKILL.md).
- `teach`: unrelated to the current clinic implementation; no new learning files.
- `in-progress/*` (including `software-factory`, `chief-of-staff`, `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, writing beats/fragments/shape): upstream labels these beta/non-promoted; **do not adopt by default** or spawn parallel task runners. Existing CI and named schedules already exist, but execution and independent reviewer findings still need exact-head evidence; no dependency-cruiser install is justified by a current observed violation.
- `misc/*` and `deprecated/*`: upstream treats misc as frozen; no git-hook, Husky, source-wide formatter or type-assertion migration installed. Respect existing protected GitHub workflow and safety gates.
- Upstream `.github/*`, `scripts/*`, marketplace/Claude plugin files, templates, changelog and package lockfile: **reference-only**, no copying, executing or introducing new workflow triggers.
- Upstream `.out-of-scope/*` and `SCOPE.md`: reinforces only adopting behavior that addresses an *observed* problem, not configuration churn or new duplicate skills.

## Why these changes fit EZZ

| Observed need | Evidence in EZZ | Applied control |
| --- | --- | --- |
| Different interpretations of performed/recorded/verified lead to unsafe product claims | [Visit workbench](../product/visit-workbench.md) and [owner evidence levels](../product/owner-financial-review.md) distinguish desk claims, counted periods and provider settlement | [`GLOSSARY.md`](../../GLOSSARY.md) names these explicitly |
| Too many old PRs and stale reviewer carry-forwards | [PR backlog](https://github.com/EzzeddineAlimi/ezz-clinic-app/pulls) and [issue #95](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/95) | Pin base + exact head and verify the **actual** independent review on each head |
| A test can turn green without proving the underlying real DB/browser behavior | [Testing matrix](../testing/results-matrix.md), [API contract](../api/endpoints.md) | Contract-seam RED/GREEN tests and explicit execution classification |
| Bug fixes risk guessing from logs or CI flakiness | [Backend quality evidence](backend-quality.md) documents a failure with unknown cause that was **not** patched speculatively | Theory → evidence → minimum fix; label unreproduced defects |
| The PR reader needs a quick real-world risk summary | [Engineering standards](standards.md) and [AGENTS](../../AGENTS.md) require source-linked acceptance gates | Standard + spec review and focused merge danger statement |
| Agent prompts had superseded instructions appended without replacing old task lanes | [Mission Control correction incident #95](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/95) | One authoritative prompt edit in place, remove contradictions and verify readback; keep audit records append-only |
| The initial EZZ glossary inverted the count-difference sign | [Actual cash count persistence in backend/src/modules/cash.ts](../../backend/src/modules/cash.ts) (`counted - expected`) | Correct glossary: negative shortage, positive surplus; no database or runtime change |

## Source attribution, compatibility and limits

Adaptations are independently worded, not a verbatim vendor skill bundle. Sources: [TDD](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd/SKILL.md), [diagnosing bugs](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/diagnosing-bugs/SKILL.md), [code review](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/code-review/SKILL.md), [PR](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/pr/SKILL.md), [domain modeling](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/domain-modeling/SKILL.md). Upstream license: [MIT](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/LICENSE).

No external plugin installation means the playbooks are **only guaranteed to influence an agent when it follows `AGENTS.md` and opens the relevant local file**. Actual plugin/skill auto-discovery varies by agent product; this change makes no claim about such registration. No production, clinical validation, payment processing, CNAM approval, migration, auth change, runtime dependency, schedule change, self-merge or release is included.

**Final evidence-definition refinement:** The prior glossary combined an in-database audit event and a separately kept owner checkpoint. [Actual audit.ts](../../backend/src/modules/audit.ts) and [checkpoints.ts](../../backend/src/modules/checkpoints.ts) distinguish them: a database-only checkpoint copy is not independent, whereas the owner-held copy outside the database can reveal later rewriting or rollback of recorded history. These are now two glossary terms; their contents are descriptive, not a new control or V1 acceptance assertion.

**Second-pass correction:** The first docs draft inverted the backend's persisted cash discrepancy sign. The corrected definition follows `cash.ts` at the pinned base; the authoritative documentation index now links the local playbooks and uses `UX_PAGE_INVENTORY` instead of historical `UX_BATCH_COMMAND`. Writing-for-agents is adopted as a concise prompt maintenance rule, not another plugin or worker.

**Verification required for this docs-only PR:** inspect each new path and Markdown link at the exact head, verify no source/test/lockfile/workflow modifications, and wait for independent reviewer and CI outcomes before any merge.
