# Engineering standards and workflow (Mission G)

Original 2026-10-28 engineering proposal; factual implementation entries reconciled against merged main `406c5dd1` on 2026-10-30. Production readiness is **not** approved. See [`docs/INDEX.md`](../INDEX.md) for current authority and draft/merged distinction.

## Repository structure

```
/                      v0.1 prototype (unchanged, historical baseline: src/, public/, test/)
backend/               v0.2 API (TypeScript, Node 22, PostgreSQL)
  migrations/          forward-only SQL, NNNN_name.sql (immutable once shared)
  src/platform/        http, db, postgres, validate, errors, canonical, migrate   (no business logic)
  src/modules/         one file per module; dependency map enforced by test/architecture.test.ts
  test/                one throw-away PostgreSQL database per test file; helpers.ts
  scripts/             migrate, seed-fictional, bootstrap-roles.sql, v0.1 baseline probe, permission-matrix generator
docs/{architecture,database,api,security,testing,clinical-domain,operations,engineering,product,handoff}/
.github/workflows/     demo-checks.yml, backend-ci.yml and frontend-ci.yml (scope-filtered CI)
```

## Rules

| Area | Standard | Status |
|---|---|---|
| Dependencies | Backend uses pinned `pg` runtime dependency; frontend uses pinned React/ReactDOM/Zod. Commit lockfiles with integrity metadata; use `npm ci --ignore-scripts`. | PRESENT on main; dependency security audit remains active draft PR #71 |
| Node | `.nvmrc` 22.23.4; engines `>=22.18 <23`; production runs compiled `dist/` | DONE |
| TypeScript | `strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (runs under Node type-stripping and tsc), `verbatimModuleSyntax` | DONE |
| CI | Scope-filtered GitHub Actions: backend PostgreSQL/timezone/compiled tests, frontend real-API Playwright, and fictional prototype; read-only permissions and pinned actions. | Runs observed green on main `406c5dd1` where triggered; **docs-only PRs may have no required job**; #68 remains open |
| Branching | `main` reports `protected: true`, but required-check enforcement and admin bypass need verification (#68). Isolated draft PRs and exact-head independent reviews; do not merge on CI green alone or without founder authorization. | PARTIAL — protection details cannot be independently read through current integration |
| Commits | one slice per commit/PR; message explains the control and lists test IDs; AI attribution trailer | DONE |
| Errors | modules throw `AppError(code)`; HTTP maps to stable envelope; DB errors mapped without SQL text; 500 = no detail | DONE |
| Money | integer millimes only; ARCH-3 fitness test | DONE |
| SQL | parameters only; ARCH-4 fitness test bans `${}` in SQL strings except whitelisted identifiers | DONE |
| Logging | one JSON line per request; allow-listed fields only (OPS-LOG-1); never bodies/tokens/patient fields | DONE |
| Config/secrets | env vars only; `.env.example`; `.env*` ignored; no secrets in repo or CI | DONE |
| Privacy hygiene | `.gitignore` blocks *.sqlite/*.db/*.dump/*.dcm/*.csv/*.xlsx/*.pdf/backups/exports/scans; synthetic fixtures only under `backend/test/fixtures/synthetic/`; `isSynthetic: true` required by API and DB CHECK; `clinics.is_fictional` CHECK | DONE |
| Tests | layers: unit, API+real DB, restart (SIGKILL), fault injection (test-only trigger), backup/restore, architecture, red-baseline probe; every test name states the expected result; never report a pass that did not run | DONE |
| Docs | ADR per significant decision; generated permission/API/schema material regenerated, never hand-edited. Use `docs/INDEX.md` for authorities; refresh impacted docs in the implementing PR, distinguish MAIN / DRAFT / HISTORICAL / GATED. | PROCESS RULE — verify each PR |
| Migrations | checksum-enforced runner; expand → migrate → contract | DONE |
| Rollback | app: redeploy previous build (stateless); DB: forward-fix migrations, restore from backup only with anchor check first; feature work behind reversible slices | PROPOSED |

## Reproducible local setup

See `backend/README.md` and `docs/engineering/dev-environment.md`. Supported development runtime: Node 22 (`>=22.18 <23`) and PostgreSQL 16. `EZZ_TEST_ADMIN_URL` must reference a **disposable fictional-data test database**. Run source and compiled tests; historical "80 tests" counts do not represent the current suite.

## Review protocol for AI-written code (proposal)

1. Author model opens a draft PR per slice with test IDs and residual risks.
2. An independent reviewer examines the exact-head diff and relevant negative tests; primary Muse handles adversarial safety review, and Muse Ons is an independently prompted UX critic. Do not assume external reviewers run automatically.
3. New failing tests are committed first (red), then fixes (green).
4. Founder approves merge; nothing auto-merges; production deploy is a separate gate.
