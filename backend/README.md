# EZZ Clinic backend v0.2 — FICTIONAL DATA ONLY

**NOT FOR CLINICAL USE. Never enter real patient data.** Financial-integrity backend built during the Claude Opus 5.5 sprint (2026-10-28): authenticated roles, clinic isolation (RLS), dentist-only care/fee confirmation, idempotent payments, gap-free receipts, blind independent cash counts, card evidence tiers, paper outage re-entry, tamper-evident audit chain with owner-held checkpoints, owner exception list. No hosting, PSP, legal or production approval exists.

## Requirements
- Node.js 22.18+ (tested 22.23.4; type-stripping runs `.ts` directly; production should run `npm run build && npm start`)
- PostgreSQL 16 superuser URL **for tests only** (creates/drops throw-away databases)
- No runtime npm dependencies (temporary in-repo PostgreSQL client, **no TLS** — see `docs/architecture/decisions.md` ADR-0004)

## Run the tests
```bash
cd backend
npm ci --ignore-scripts                     # typescript + @types/node (dev only)
export EZZ_TEST_ADMIN_URL='postgres://postgres:<pw>@localhost:5432/postgres'   # or ?host=/tmp for a local socket
npm run typecheck
npm test                                    # 80 tests on real PostgreSQL, ~22 s
node scripts/v01-baseline-probe.mjs ..      # re-runs the v0.1 RED baseline (needs port 4173 free)
```

## Run the API locally (fictional data)
See `docs/database/schema.md` → Setup. Default bind `127.0.0.1:4180`. API contracts: `docs/api/api-v1.md`.

## Layout
`migrations/` SQL (source of truth) · `src/platform/` HTTP, DB, driver, validation · `src/modules/` identity, audit, patients, care, billing, cash, card, paper, integrity, exceptions · `test/` c1..c7 + architecture · `scripts/`.

## What a green test run does NOT mean
It does not prove production security, legal compliance, physical cash-count independence, or detection of payments that were never recorded (CH-002). See `docs/security/security-status.md`.
