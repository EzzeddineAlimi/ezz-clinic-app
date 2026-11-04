# EZZ Engineering Graph — isolated coding runner

**Status: draft, fictional-development only.** This is a LangGraph orchestration tool for engineering, not a clinic runtime dependency and not a claim that Muse, Muse Ons, Gemini, ChatGPT schedules or production systems are connected.

## What it does

A real LangGraph StateGraph routes one approved GitHub task through preflight, read-only planning, exactly one of five coding nodes (backend/frontend/database/UX/docs), role-specific local checks, draft PR publication and an **AWAITING_INDEPENDENT_REVIEW** handoff. Coding and planning invoke an already-authenticated **Codex CLI**. No separate paid API key or hosted LangGraph service is used.

The runner does not merge, deploy, run against real patients, certify checks remotely, trigger external reviewers, or accept a V1 feature. A draft PR is not permission to merge. Existing main protection, exact-head CI, founder/clinical/financial/privacy approval and Mission Control remain authoritative. Production release stays forbidden.

## Prerequisites

- A clean local checkout of EzzeddineAlimi/ezz-clinic-app on a dedicated gpt/ branch, with origin pointing to that repository.
- Node 22.18+ (before 23), npm, Git, authenticated GitHub CLI gh and authenticated Codex CLI codex.
- Existing approved development environment for role checks; backend requires PostgreSQL 16 configured with **fictional** test data, frontend E2E requires its existing real fictional-API setup.
- A live, open GitHub issue not already claimed by a different open PR.
- Review and authorize the Codex CLI model usage and subscription quota separately; no new paid API service is configured by this tool.

Install with npm ci after the reviewed lockfile is committed:

    npm --prefix tools/engineering-graph ci --ignore-scripts --no-audit --no-fund

Run tests:

    npm --prefix tools/engineering-graph test

Create a trusted task JSON (not copied blindly from an issue) with this shape:

    {
      "issue": 134,
      "branch": "gpt/langgraph-issue-134",
      "role": "docs",
      "risk": "low",
      "title": "Improve harness documentation for tests",
      "instructions": "Add a synthetic engineering verification example without changing business policy.",
      "allowedPaths": ["docs/harness"]
    }

Then run:

    npm --prefix tools/engineering-graph start -- /absolute/path/to/ezz-clinic-app /absolute/path/to/task.json

The commands launch real, not mocked, Codex execution and will modify the dedicated local checkout, run checks, commit, push and open **one draft PR** if all checks pass. Do not run the example task against an already-owned issue. No automatic retries or force pushes. A failure leaves the branch for evidence-first diagnosis.

## Guardrails and known limitations

- Preflight checks current branch, clean checkout, GitHub origin, live issue and open PR body references. The PR inventory is bounded to 100; when more are open, this cannot establish complete ownership. GitHub issue comments and Sheet rows are not atomic locks, so no claim of globally exclusive dispatch is made.
- The Codex workspace-write sandbox can edit files within the checkout before the post-run path check. Any out-of-scope changes cause a hard stop **before** git add/push; they still require human inspection/remediation locally.
- A successful local check is recorded in the draft PR but still requires independently observed exact-head GitHub CI.
- Reviewer nodes are represented only by a handoff state until each external provider is connected through a genuinely executable adapter with independent credentials and evidence.
- This pilot does not include a persistent checkpoint store, unattended scheduler, concurrent agents, cost metering, autonomously repaired failing tests or automatic merge gate.
- Never put real patient data, financial credentials, secrets, clinic screenshots, or production endpoints into task JSON or Codex prompts. Existing application authentication and cash/clinical rules remain unchanged.

Refer to docs/harness/TASK_CONTRACT.md, docs/harness/PERMISSIONS.md, AGENTS.md and docs/INDEX.md for authoritative policies. Track integration under GitHub issue #134.
