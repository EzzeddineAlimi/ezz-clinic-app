# Engineering standards and workflow (Mission G)

Status: proposal by Claude Opus 5.5, 2026-10-28, implemented in `backend/` where marked DONE. Founder/GPT may amend.

## Repository structure

```
/                      v0.1 prototype (unchanged, historical baseline: src/, public/, test/)
backend/               v0.2 API (TypeScript, Node 22, PostgreSQL)
  migrations/          forward-only SQL, NNNN_name.sql (immutable once shared)
  src/platform/        http, db, pgwire, validate, errors, canonical, migrate   (no business logic)
  src/modules/         one file per module; dependency map enforced by test/architecture.test.ts
  test/                one throw-away PostgreSQL database per test file; helpers.ts
  scripts/             migrate, seed-fictional, bootstrap-roles.sql, v0.1 baseline probe, permission-matrix generator
docs/{architecture,database,api,security,testing,clinical-domain,operations,engineering,product,handoff}/
.github/workflows/     demo-checks.yml (v0.1) and backend-ci.yml (v0.2)
```

## Rules

| Area | Standard | Status |
|---|---|---|
| Dependencies | Zero runtime deps today (temporary, ADR-0004); dev deps pinned exactly; `package-lock.json` committed; `npm ci --ignore-scripts` | DONE (lockfile lacks integrity → ENG-02) |
| Node | `.nvmrc` 22.23.4; engines `>=22.18 <23`; production runs compiled `dist/` | DONE |
| TypeScript | `strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (runs under Node type-stripping and tsc), `verbatimModuleSyntax` | DONE |
| CI | read-only `permissions`, SHA-pinned actions, `persist-credentials: false`, no secrets, no `pull_request_target`, no artifact uploads of data, privacy file guard, Postgres service | WRITTEN, NOT RUN (403) |
| Branching | `main` protected by convention (free private plans may lack branch protection — C-143); stacked `opus55/NN-*` branches; draft PRs; merge only after recorded Claude/Muse review + founder OK; never on CI green alone | PROPOSED |
| Commits | one slice per commit/PR; message explains the control and lists test IDs; AI attribution trailer | DONE |
| Errors | modules throw `AppError(code)`; HTTP maps to stable envelope; DB errors mapped without SQL text; 500 = no detail | DONE |
| Money | integer millimes only; ARCH-3 fitness test | DONE |
| SQL | parameters only; ARCH-4 fitness test bans `${}` in SQL strings except whitelisted identifiers | DONE |
| Logging | one JSON line per request; allow-listed fields only (OPS-LOG-1); never bodies/tokens/patient fields | DONE |
| Config/secrets | env vars only; `.env.example`; `.env*` ignored; no secrets in repo or CI | DONE |
| Privacy hygiene | `.gitignore` blocks *.sqlite/*.db/*.dump/*.dcm/*.csv/*.xlsx/*.pdf/backups/exports/scans; synthetic fixtures only under `backend/test/fixtures/synthetic/`; `isSynthetic: true` required by API and DB CHECK; `clinics.is_fictional` CHECK | DONE |
| Tests | layers: unit, API+real DB, restart (SIGKILL), fault injection (test-only trigger), backup/restore, architecture, red-baseline probe; every test name states the expected result; never report a pass that did not run | DONE |
| Docs | ADR per significant decision; generated docs (permission matrix, API tables, schema catalogue) regenerated not hand-edited; labels VERIFIED / ASSUMPTION / UNVERIFIED | DONE |
| Migrations | checksum-enforced runner; expand → migrate → contract | DONE |
| Rollback | app: redeploy previous build (stateless); DB: forward-fix migrations, restore from backup only with anchor check first; feature work behind reversible slices | PROPOSED |

## Reproducible local setup

See `backend/README.md`. Needs Node 22.18+ and a PostgreSQL 16 superuser URL for tests (`EZZ_TEST_ADMIN_URL`). `npm ci && npm run typecheck && npm test` (80 tests, ~22 s on the sprint sandbox).

## Review protocol for AI-written code (proposal)

1. Author model opens a draft PR per slice with test IDs and residual risks.
2. A **different** model reviews the diff file-by-file (Claude ↔ GPT), Muse attacks with new failing tests.
3. New failing tests are committed first (red), then fixes (green).
4. Founder approves merge; nothing auto-merges; production deploy is a separate gate.
