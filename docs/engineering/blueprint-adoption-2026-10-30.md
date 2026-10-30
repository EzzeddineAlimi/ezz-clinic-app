# Blueprint adoption assessment — EZZ Clinic

**Read-only evidence baseline:** 2026-10-30 merged `main` `406c5dd1fd16dd543f2c0b9a3a601af33ae6568b`, the full Google Doc [The Vibe Coding Blueprint](https://docs.google.com/document/d/14GR5EhXGuyX7xRea52ZP3h5vQEP2Egcwvx_SusGWkCc/edit), active Mission Control scope/acceptance, current repository files, and open PRs/issues. This is a **documentation workflow assessment**, not a complete source-code penetration audit, execution test or product acceptance.

## Decision

Adopt the guide's **context → accepted contract → focused plan → smallest change → test and independent review → update the authoritative document** workflow. Do **not** copy the guide's generic 17 templates into the repo: EZZ has real domain documents, generated API contracts, ADRs, safety tests and founder-approved scope. Duplicating them would create contradictions.

## All 17 subjects, mapped to concrete authority

| Guide topic | Current grounded evidence | Improvement / owner / gate |
| --- | --- | --- |
| PRD | Founder `R76_FEATURE_SCOPE_DECISIONS`, `docs/product/`, clinical requirements | Keep one navigable scope map; `#69` acceptance separate from scope |
| DESIGN_SYSTEM | Design draft `#59`; UX batch and decision ledger | Independent FR/AR/390px review, merge only with founder authorization; GPT UX |
| UX_FLOWS | Role-workspaces proposal and frontend security-state map | Explicit successful/error/blocked/offline/retry flows; UX-12 then UX-13/14 |
| ARCHITECTURE | `docs/architecture/architecture.md`, ADRs, SOLID audit | Preserve modular TS/PostgreSQL; reconcile historical statements |
| DATABASE | Full migration source; `schema.md` is only a historical 0001–0007 catalogue | Keep migrations immutable; regenerate the complete schema from current disposable PG16 before relying on it |
| API | Generated `docs/api/openapi.json`, `endpoints.md`, actual tests | Regenerate, validate consumer contracts; no hand-maintained duplicate |
| SECURITY | `docs/security/security-status.md`, `#71` draft and `#72` | Exact-head independent audit and **real production gates** |
| CODE_STYLE | `docs/engineering/standards.md` | Fix obsolete runtime/CI/branch/reviewer text in this PR |
| TESTING | `docs/testing/`, PG16 source/dist + Playwright Actions | Require exact-head evidence/negative paths; `#69` 61 groups open |
| AGENTS | Root `AGENTS.md` | Route to index and enforce documentation triggers without broad rereads |
| ENVIRONMENT | `backend/.env.example` and dev-environment docs | Production env schema, secure secret lifecycle gated by `#72` |
| DECISIONS | ADRs and founder Sheet decision ledger | Preserve dissent/date/SHA, one decision authority per domain |
| ROADMAP | Mission Control `UX_BATCH_COMMAND`, CODEX lane, PRs | Cross-reference active owner and open issues, don't parallel duplicate |
| ERROR_HANDLING | `api/frontend-security-states.md`, payment recovery | Validate 401/403/404/409/429, pending and unknown outcomes in real browser tests |
| OBSERVABILITY | Existing request/security logs and owner audit | Operational alerts, thresholds, retention and response testing: `#72` |
| DEPLOYMENT | Operational/restore research, fictional preview `#44` | Real HTTPS, security sign-off, release/rollback/smoke/restore gate; not approved |
| CHANGELOG | GitHub PRs, test artifacts and Mission Control | Release summaries once a version is explicitly approved; no fake release entries |

## Ranked execution without duplicate ownership

1. **P0 before real clinical operation (OPEN):** do not treat software green as deployment clearance; `#72` HTTPS/HSTS and secure reverse proxy, MFA and owner recovery, brute-force/rate protection, malware scanning/quarantine, encryption/key custody, independent penetration testing, backups and restore drill, alerts and local legal/clinical/fiscal/CNAM approval. `#68` branch required CI enforcement and link-sharing safety.
2. **P1 correctness and clinical workflows (ACTIVE):** GPT UX-12 `#60→#62→#64→#65→#66→#70`; independent Muse and Muse Ons review. Dentist and owner workspaces after. Codex `#67` CNAM paper-first; preserve multiple individually named dentists/receptionists, dentist authorship, no hidden clinical authority for desk.
3. **P1 testable acceptance (OPEN):** `#69` maps all 61 approved groups to current-main actual tests and remaining clinical/privacy/UX gates. No completed-count inflation from historical tests or open PRs.
4. **P1 incremental security hardening (ACTIVE):** `#71` new HTTP, strict date, secret-history tripwire and dependency audit is draft; **not** completed or merged. Independent review and exact-head CI before requesting founder merge approval.
5. **P2 developer ergonomics (THIS DRAFT):** docs index, corrected README/standards/AGENTS, minimal PR template. Avoid extra packages, database changes, unnecessary architecture changes or an invented second project-management system.

## Independent final recheck criteria

- Confirm current `main` and PR-head SHAs before making any adoption-status claim.
- Inspect each drafted file against the original content; no production, permissions, API, financial, clinical, security or database source changes in this PR.
- Verify every linked in-repo document exists on merged main, and mark unmerged references as drafts.
- Verify GitHub main branch protection **details** separately: `protected: true` is not evidence that required checks/admin restrictions are enforced; connector currently cannot read the protection details.
- Verify Mission Control `anyone reader` link access is still an accepted **reviewer-dependency risk**: do not revoke blindly or store real patient/secret data.
- Never represent an implementation proposal as a test execution, merge, deployment, or clinical/legal/production clearance.

## What remains unverified

A production hosting architecture, live security operations, independent physical cash counts, actual payment-provider settlement, live malware scanning and legal/current-CNAM compliance remain unverified. A full independent penetration test has not been executed. This assessment alone authorizes **no** production action.
