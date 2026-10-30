# Frontend performance baseline (fictional clinic only)

## Why this exists

The app has a real-PostgreSQL backend stress/resilience harness at `backend/scripts/bench.ts`, but it did not have a committed browser journey baseline. Optimizing before measuring risks introducing stale clinical/payment data or needless complexity.

The Playwright case in `frontend/e2e/performance.spec.ts` exercises the **built** Vite preview against the existing **disposable fictional API/database**. It measures elapsed time from login click to visible agenda, opening the patient directory, searching, and changing the agenda day. It also records same-origin API resource timing, transfer bytes where the browser exposes them, and *path-only* GET request counts.

## Run

Follow `frontend/README.md` to start the **disposable PostgreSQL 16 development instance** and set `EZZ_TEST_ADMIN_URL`. Then:

```sh
cd frontend
npm run test:e2e -- --grep "measure receptionist journey"
```

The JSON attachment `performance-baseline.json` appears in the Playwright test result. The CI console also emits a single `EZZ_PERFORMANCE_BASELINE` JSON record. The result contains only API route names, HTTP methods, timing and byte counts; it must never include authorization material, query values, patient records or real clinical data.

## Interpretation and follow-up

- **Regression assertions:** one GET for initial day board, one for opening the patient directory, one for an explicit patient search, and one for changing the agenda date. A duplicate request is a test failure.
- **Diagnostics, not pass/fail:** elapsed timings and response transfer sizes. Do not declare performance improvements from one run or enforce CI-dependent milliseconds as a hard budget.
- **Before changing code:** collect repeatable measurements, review the actual resource waterfall, run the existing backend `bench` harness, and inspect slow PostgreSQL queries with `EXPLAIN (ANALYZE, BUFFERS)` on the disposable database. Record the before/after baseline at identical data scale.
- **Only if evidence warrants:** split role-specific bundles, remove redundant requests, tune SQL queries/indexes, or optimize rendering. Maintain the API's `no-store` behavior; no persistent patient/financial caches, prefetch of privileged data, or speculative parallel writes.
- **Safety gates:** session expiry must clear sensitive UI data, 403/404 isolation must remain correct, and checkout/payment recovery/receipt/cash-count behavior must never change as a side effect of this audit. Require real-API tests plus independent safety review before merge.

This PR adds evidence collection and request-count safeguards; it **does not** claim that existing pages are slow or change production behavior. No production deployment is part of this work.
