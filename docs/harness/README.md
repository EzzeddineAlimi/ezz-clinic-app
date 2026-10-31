# EZZ Clinic — clinic-specific agent harness

**Fictional-data-only engineering.** This draft is not real-patient, fiscal, CNAM, clinical or production approval. Baseline merged main: `406c5dd1` (2026-10-30).

## Four layers — use what exists rather than create another platform

1. **Connectors:** existing GitHub code/CI and Mission Control. No production clinic database, real card-provider, or medical-record connector.
2. **Expert-written evaluations:** `scenarios.json` catalogs **13** real receptionist, dentist, owner and security review tasks. Each has one positive and one negative named existing test. A source reference does not mean the test ran or a human task succeeded.
3. **Authority boundaries:** `PERMISSIONS.md` distinguishes instructions from enforced GitHub/CI rules. Model names are swappable only after validating their actual connected tools and privileges.
4. **Human review:** existing `MOBILE_DASHBOARD` + Mission Control `MODEL_INBOX`, exact PR evidence, independent safety/UX reports and V1 issue #69. No second self-declared release dashboard.

## Run the zero-dependency integrity check

    node --test scripts/harness/check.test.mjs
    node scripts/harness/check.mjs --markdown

This validator checks stable names of positive/negative test declarations and catches stale paths or fabricated catalog status. It does **not** execute PostgreSQL 16 tests, run Playwright, measure clinic staff tasks, evaluate 61 approved V1 items, or grant production clearance. Those proofs require their existing real-API/back-end workflows at **the exact current PR head**, independent review, and the founder's relevant acceptance.

GitHub Action: `.github/workflows/harness-check.yml` executes the two commands on relevant PRs with `permissions: contents: read`. Backend/frontend jobs run on every pull request since merged PR #92 (push paths can still be filtered); this harness job runs only on harness-path changes. Required-check branch enforcement is tracked by issue #68; a green catalog check is not a hard merge gate until enforced.

## Measurement workflow — what needs actual human observation

For each clinic task, write in the existing Mission Control lane: role/clinic, selected fictional test case, expected vs observed screen state, correctness of patient/financial authority, error recovery, task success, number of steps, time or mistakes if actually measured, French/Arabic RTL and 390px/mobile accessibility if applicable, screenshots when genuinely captured, exact source SHA, test run links, independent reviewer verdict and actionable findings. Proposed targets are **hypotheses**, not approved or achieved metrics.

Status progression: **source referenced → exact-head tests executed → human task observed → independent review → relevant founder acceptance**. No step substitutes for physical cash custody or actual provider reconciliation. Never report zero theft as an achievable software guarantee.

Relevant existing lanes: `R76_FEATURE_SCOPE_DECISIONS`, `V1_EVIDENCE_REFRESH_20261030`, `UX_MODEL_REPORTS`, `UX_BATCH_COMMAND`, `MODEL_INBOX`, `MOBILE_DASHBOARD`. All prior records remain authoritative and untouched.

Read `TASK_CONTRACT.md`, `PERMISSIONS.md`, `scenarios.json` and [the Paperclip control-plane fit assessment](PAPERCLIP-FIT-2026-10-30.md). For product/release acceptance see issue #69; for security/production gates see #72; for branch protection see #68.
