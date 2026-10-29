# R74 — full-codebase SOLID audit and architecture hardening

Date: 2026-10-29. Author: Claude (Claude lane). Fictional data only. **This is not an independent approval.** Muse
remains the independent reviewer, and nothing here is production-ready.

## 0. Baseline and scope

| Item | Value |
|---|---|
| `main` | `c89d6e6`: v0.1 prototype import. PR #1 was closed without merging; its content reached `main` directly. |
| Integrated lineage audited | #21 `integration/r72-candidate` @`0a57234`, then the R73 stack #22–#30. The audit baseline is **#30 `r73/i-residuals` @`3d8354d`**. |
| Baseline suite | 312 tests, 311 pass, 0 fail, 1 skip (source and compiled; CI green on Node 22, 24 and 26). |
| Code audited | `backend/src` (37 files, ~7 400 lines), `backend/test` (49 files), `backend/scripts`, `backend/migrations`, `.github/workflows`, the root v0.1 prototype (`src/`, `public/`, `test/`), and `docs/api` (OpenAPI and examples). |
| PRs covered | #1–#30, listed in §6. |
| Not changed | Every existing PR branch, including #21 under review. No rebase, merge, deploy or real data. |

**Authorship.** Every commit is made under the founder's GitHub identity. Lanes are told apart by commit and PR content: the import of the Opus v0.2 backend (#2), the GPT-lane PRs #3, #8, #9 and #10, and the Claude-lane PRs #11–#30. The GPT-lane code still in the lineage:
- `modules/audit.ts`: CH-026 field fidelity.
- `scripts/sqlite-outbox-drill.mjs` and the 20-visit paper drill.
- `contracts/clinical.ts`: FDI, site and surface contracts.
- `modules/workbench.ts`: the visit workbench, later extended by Claude for CH-028 and B10.

Every one of these was audited under the same rules as the rest of the code.

## 1. Method

1. **Read every file.** Each source file was read and scored against SRP, OCP, LSP, ISP, DIP, DRY, KISS and YAGNI.
2. **Automated scans.** Searches covered:
   - duplicated logic: locks, array parsing, hashing, `Intl`, area codes, `to_regclass`;
   - driver leakage into business modules;
   - type escapes: `any`, `as unknown as`;
   - swallowed errors: catch-alls;
   - module edges that are declared but not used.
3. **Regression coverage before each change.** Every refactor shipped with a test, a characterization, or both, and then ran:
   - typecheck;
   - the full suite on source and on compiled output;
   - the API contract tests T-API-1..7, which check status codes and response shapes.
4. **Change only where the gain outweighs the risk.** Where a SOLID refactor would have added indirection for no current benefit, the module is marked **JUSTIFIED EXCEPTION** and the reason is given.

## A. Module verdicts

Verdicts: **PASS** = sound as found. **REFACTORED** = changed in R74 (the PR is given). **JUSTIFIED** = deliberately left as is, with the reason.

### Platform and composition

| File | Verdict | Notes |
|---|---|---|
| `platform/http.ts` | PASS, JUSTIFIED | **DIP:** auth, RBAC, denial counting and idempotency are reached only through the `SecurityHooks` interface, so the platform never imports a module.<br>**Why `createServer` stays one function:** it is a short linear security pipeline: host/origin → route → JSON body → auth/RBAC/reauth → binary body only *after* auth → idempotency key → transaction. That order is the invariant. Splitting it into steps would scatter the order across functions without changing behaviour. |
| `platform/db.ts` | REFACTORED (#31, #32, #33) | Now the single owner of `advisoryLock`, `pgTextArray`, `pgIntArray`, `isUniqueViolation` and `tableExists`. Each tenant transaction is scoped with `set_config('app.clinic_id')`. |
| `platform/postgres.ts` | PASS | Adapter over `pg` 8.23.1. Enforces the TLS policy and the pool timeouts. |
| `platform/pgwire.ts` | JUSTIFIED | Compatibility shim for open draft branches that still import it. Nothing on the R74 branches imports it (ARCH-7). Delete it once those branches are integrated. |
| `platform/validate.ts`, `errors.ts`, `canonical.ts` | PASS | Small and pure. `canonical.ts` gained `sha256OrNull` (#31). |
| `platform/blobstore.ts`, `fileinspect.ts` | PASS | Good DIP: the `BlobStore` and `ContentScreener` interfaces are injected through `AppOptions.documents`. |
| `platform/migrate.ts`, `ops/disaster-recovery.ts` | PASS | Their raw-connection `to_regclass` calls are justified: they run before or outside the tenant schema. |
| `platform/readiness.ts`, `paths.ts`, `server.ts` | PASS | |
| `app.ts` | REFACTORED (#32) | A true composition root: it now wires billing→cash explicitly. Before, that hook was registered as a side effect of importing `cash.ts`. |
| `contracts/clinical.ts` (GPT #9) | REFACTORED (#31) | Now owns `AREA_CODES`, `isValidAreaCode`, `readTeethList` and `readAreaCode`. It keeps the GPT-authored compact formatting; reformatting is LOW debt (E-12). |

### Business modules

| File | Verdict | Notes |
|---|---|---|
| `audit.ts` (incl. GPT #3 CH-026) | PASS | Append-only hash chain and anchors. Untouched. |
| `identity.ts` | PASS, JUSTIFIED | Authentication, the permission matrix, sessions and the idempotency store are cohesive here: one security boundary that `SecurityHooks` exposes. Splitting out the ~20-line idempotency store would add a module for no current consumer (YAGNI). E-7 records it. |
| `patients.ts` | REFACTORED (#31) | `getPatient` is now typed (`PatientView`; 5 casts removed). `clinicDay` moved to settings, and the timezone re-export through patients was removed. |
| `workbench.ts` (GPT #10, Claude CH-028/B10) | PASS | Read-only projection in a single consistent SQL snapshot. Compact formatting is LOW debt (E-12). |
| `care.ts` | REFACTORED (#31) | Dead `validFdi` removed; `sha256OrNull` used. |
| `medical.ts` | PASS | It benefits from the typed `getPatient`. |
| `clinical.ts` | REFACTORED (#31) | Uses the shared site readers. |
| `billing.ts` | REFACTORED (#31, #32, #34) | Shared hashing. The cash-period hook **fails closed** (T-WIRE-1, RED first). A catch-all replaced by `maybeOne` (T-ERR-1). The module-level resolver variable is MEDIUM debt (E-5). |
| `cash.ts` | REFACTORED (#32) | No longer imports billing. It provides `openPeriodForCashWrite` for the composition root to wire. |
| `card.ts` | PASS | |
| `paper.ts` | REFACTORED (#31, #32) | Shared lock; uses `isUniqueViolation` instead of the driver's error type. |
| `integrity.ts` | REFACTORED (#33), JUSTIFIED | Optional value checks are now table-driven (OCP). **The checks stay in this one verifier on purpose:** the code that checks a table is kept apart from the code that writes it.<br>The B06 business checks (M-267, CH-033, CH-034) are unchanged. They are under Muse review. |
| `exceptions.ts` | REFACTORED (#33) | Seven named sources in a fixed list (SRP and OCP). Output was proven equivalent by characterization. |
| `review.ts`, `dayboard.ts`, `print.ts` | REFACTORED (#31) | Clinic day and timezone come from settings. The dependency map was tightened. `print.formatLocal` keeps its own `Intl` formatter because it formats for presentation (JUSTIFIED). |
| `checkpoints.ts` | PASS | |
| `settings.ts` | REFACTORED (#31) | Single owner of clinic-day computation (`localDate`, `clinicDay`, `clinicTimezone`). One `as unknown as` remains (LOW, E-13). |
| `documents.ts`, `lab.ts`, `stock.ts` | REFACTORED (#31) | Shared locks, array parsing and site readers. |

### Tests, CI, scripts and legacy

| Area | Verdict | Notes |
|---|---|---|
| Tests (49 files, real PostgreSQL 16) | PASS | ARCH fitness tests grew from 5 to 9 (see B). The suite runs on source and compiled output. |
| CI | PASS | Backend: typecheck, source tests, two demo scripts, build, compiled tests, and forward-compatibility on Node 24 and 26. `demo-checks.yml` covers v0.1. |
| Migrations | PASS | Not modified in R74 (migration integrity preserved). |
| `scripts/` | PASS | `sqlite-outbox-drill.mjs` (GPT #8) is an experiment, not a production path (JUSTIFIED). |
| Root v0.1 prototype (`src/`, `public/`, `test/clinic.test.mjs`) | JUSTIFIED (legacy) | Superseded by `backend/`. Kept because it is `main`'s content; archiving it is the founder's call (E-14). |

## Significant findings (file, location, problem, fix, regression risk)

| # | File and location | Problem | Fix (PR) | Regression risk and proof |
|---|---|---|---|---|
| F-1 | `billing.ts` `cashPeriodFor` and `cash.ts` `setCashPeriodResolver(...)` at import | **Latent fail-open.** A code path that loaded billing without cash recorded CASH movements with `cash_period_id NULL`, outside every blind count. The running API was not affected because `app.ts` imported cash. | Explicit wiring in `buildRoutes`; CASH throws when unwired (#32). | Low. T-WIRE-1 was RED before the fix. T-WIRE-2 proves the wiring. Full suite green. |
| F-2 | 7 inline `pg_advisory_xact_lock(hashtext('<ns>:'…))` calls | Duplicated lock-key format; a typo would silently stop the mutual exclusion. | `advisoryLock(tx, ns, id)` (#31). | Low. T-KERNEL-LOCK-1 proves the identical key, and fails when the separator is changed. |
| F-3 | 3 PostgreSQL array parsers | Duplicates that split quoted elements wrongly. | `pgTextArray` / `pgIntArray`; quoted elements are refused (#31). | Low. No quoted values exist today (T-KERNEL-ARRAY-1). |
| F-4 | 3 private `AREA_CODES` and tooth-list loops (documents, lab, clinical) | Validation duplicated three times. | Shared readers in contracts (#31). | Low. One message wording changed (stated in #31). |
| F-5 | `patients.clinicDay`, `review.windowFrom` | Each built its own `Intl` formatter, despite R73-C making settings the owner of the clinic day. | `settings.localDate` / `clinicDay` (#31). ARCH-6 now enforces this. | Low (T-KERNEL-DAY-1). |
| F-6 | `billing.textSha256`, `integrity.textSha`, care ternary | Three hash-or-null helpers. | `sha256OrNull` (#31). | Low. Equivalence argued in the commit: `optStr` never returns `''`. |
| F-7 | `paper.ts` imports `PgError` | A business module depended on the driver. | `isUniqueViolation` (#32); ARCH-8. | Low (T-WIRE-3). |
| F-8 | `exceptions.computeExceptions` (80 lines) | One function covered every evidence root. | Named sources (#33). | Low. Characterization: 21 lists and 160 items identical. |
| F-9 | `integrity.ts` `if (tableExists) …` chain, plus 3 inline `to_regclass` in exceptions | Extending meant editing the control flow; the existence check was duplicated. | `OPTIONAL_VALUE_CHECKS` and `db.tableExists` (#33). | Low (same characterization, full suite). |
| F-10 | `billing.ts` void path: `.catch(() => ({ number: 0 }))` | A catch-all for an expected "no receipt" case also hid real errors. | `maybeOne(...) ?? { number: 0 }` (#34); ARCH-9 bounds catch-alls. | Low. T-ERR-1 characterizes the paper-payment void. |
| F-11 | ARCH-1 map | Stale edges declared but unused (review, dayboard and print → patients; cash → billing after #32). | ARCH-1 now also fails on unused declared edges (#31). | None; test-only. |
| F-12 | tsconfig | No checks for unused locals or parameters, or for implicit returns. | Enabled (#31). One unused import and two unused test bindings fixed; the calls are kept. | None. |
| F-13 | `getPatient` untyped | Five `as` casts at call sites. | `PatientView` (#31). | None; type-only. |
| F-14 | `care.validFdi` | Dead export. | Removed (#31). | None. |

## B. Architecture improvements now enforced by tests

| Test | Rule |
|---|---|
| **ARCH-1** | The module graph is exact: no hidden edges and no stale declared edges. |
| **ARCH-6** | One owner per shared rule. Advisory locks and PostgreSQL array parsing live only in `db.ts`. ISO 3950 area codes live only in contracts. `Intl.DateTimeFormat` appears only in settings, plus print for presentation. Business modules never call `to_regclass`. |
| **ARCH-7** | Nothing imports the pgwire shim. |
| **ARCH-8** | Business modules reach PostgreSQL only through `db.ts`. |
| **ARCH-9** | Business modules hold no error catch-alls. There is one documented fallback: an invalid stored timezone must not turn a 403 into a 500. |
| Composition root | Owns cross-module wiring. A missing wire fails closed. |

## C. Draft PRs (stacked; each based on the previous one)

| PR | Branch | Head | Content |
|---|---|---|---|
| #31 | `r74/a-dry-kernel`, base #30 | `7daeafc` | DRY kernel, typed patient lookup, stricter compiler, ARCH-6/7, ARCH-1 tightened |
| #32 | `r74/b-explicit-wiring`, base #31 | `f823104` | F-1 fail-closed wiring (RED first), `isUniqueViolation`, ARCH-8 |
| #33 | `r74/c-integrity-owners`, base #32 | `beef168` | Exception sources, table-driven integrity checks, `tableExists` |
| #34 | `r74/d-no-swallowed-errors`, base #33 | see PR | F-10, ARCH-9, this report |

## D. Verification evidence (local, PostgreSQL 16.15, Node 22.22)

| Point | typecheck | `npm test` (tests / pass / fail / skip) | `npm run test:dist` |
|---|---|---|---|
| Baseline #30 `3d8354d` | clean | 312 / 311 / 0 / 1 | 312 / 311 / 0 / 1 |
| #31 `7daeafc` | clean, stricter flags | 319 / 318 / 0 / 1 | 319 / 318 / 0 / 1 |
| #32 `f823104` | clean | 323 / 322 / 0 / 1 | 323 / 322 / 0 / 1 |
| #33 `beef168` | clean | 323 / 322 / 0 / 1 | 323 / 322 / 0 / 1 |
| #34 | clean | 325 / 324 / 0 / 1 | 325 / 324 / 0 / 1 |

The one skip is T-CRASH-1's environment guard: it skips only when the PostgreSQL server binaries are missing. CI results are linked on each PR.

**API contract.** T-API-1..7 pass at every step: the 102 operations have the same statuses and shapes. `docs/api/openapi.json` is unchanged, because routes, permissions and status codes did not change.

## E. Remaining technical debt, ranked

| # | Severity | Item | Recommendation |
|---|---|---|---|
| E-1 | HIGH (open finding) | **M-267, CH-033 and CH-034** (B06 financial integrity), still open and pending Muse review of #29. R74 only renamed one helper inside those checks; it does **not** resolve them. | Muse decision on #29. |
| E-2 | HIGH (scaling) | Benchmark O-2: integrity and exceptions recompute a clinic's whole history on each call. Expect ~1–1.5 s per call after a busy year. | Incremental verification from the last owner checkpoint. Needs a design review because it touches the evidence model. |
| E-3 | MEDIUM | `integrity.businessValueFindings` is ~190 lines and `integrity.ts` is 510. | Split by table group *after* Muse closes M-267, so the code under review does not move while it is reviewed. |
| E-4 | MEDIUM | No i18n layer for API texts. Owner exception wording and validation messages are English strings in code. FR/AR exists only for printed documents and evidence labels. | Before the owner UI ships, add message keys with FR/AR catalogues alongside `code` (clients can already map `code`). |
| E-5 | MEDIUM | The billing→cash resolver is process-global mutable state. It now fails closed and is wired once. | Pass it explicitly if a second consumer appears (YAGNI today). |
| E-6 | MEDIUM | Tender is a hard-coded `'CASH' \| 'CARD'` union spread across billing, cash, card, workbench, print, and a DB CHECK. | When a third tender is actually scoped, introduce `contracts/tender.ts` (labels, evidence tier, drawer impact) plus a migration. |
| E-7 | LOW | The idempotency store lives inside identity. | Move it to its own module when a second transport (queue or offline outbox) needs it. |
| E-8 | LOW | `DENIED_PRIVILEGED_ATTEMPT` items have nondeterministic order: `GROUP BY` with no `ORDER BY`. | Add `ORDER BY staff_id, action`. This is an output change, so it needs a contract note. |
| E-9 | LOW | `pgwire.ts` shim. | Delete it after the open draft branches are integrated. |
| E-10 | LOW | Handlers are transaction scripts (validation, SQL and audit in one place), so tests need PostgreSQL. | Keep (KISS). The real-PG tests are the point. Extract pure validators only where reused. |
| E-11 | LOW | `security_denials` and `exceptions` English wording (owner-facing). | Covered by E-4. |
| E-12 | LOW | Compact formatting in `workbench.ts` and `contracts/clinical.ts` (GPT #9/#10). No formatter configured. | Add a formatter in one dedicated PR *after* integration. A repo-wide reformat now would conflict with 30 open PRs. |
| E-13 | LOW | `settings.ts:35` uses `as unknown as` for settings assembly. | Use a typed key map when settings next change. |
| E-14 | LOW | Root v0.1 prototype and `demo-checks.yml`. | Founder decision: archive or keep as a historical demo. |

## F. Maintainability assessment

- **New clinical modules: good.** The pattern is established and enforced:
  1. Tables owned by one module, with RLS and append-only triggers.
  2. Site validation from `contracts/clinical.ts`.
  3. Audit payload anchors.
  4. One `OPTIONAL_VALUE_CHECKS` row in integrity.
  5. An ARCH-1 map entry.
  6. Permission-matrix rows plus the regenerated doc (ARCH-5).
  7. Regenerated OpenAPI and an example in `test/api-workflows.ts`.

  Lab, stock and documents were added this way in R73, with no changes to the existing modules beyond these hooks.
- **New payment providers: fair.** Evidence tiers (`evidenceFor`, card reconciliation) are a good base. The tender union is spread across modules (E-6), so a new provider touches billing, cash, print and workbench plus a migration. That is acceptable for one provider; centralise it before adding two or more.
- **More clinics: good.** Every table is `clinic_id`-scoped under RLS. Settings, receipt series, timezones and checkpoints are per clinic. Benchmarks covered 10 clinics. Not modelled: one owner across several clinics (an organisation level). Scaling limit: E-2.
- **Multilingual interfaces: fair.** Printed documents are FR/AR with RTL, and the API returns stable error `code`s. Server-side wording for owner exceptions and validation is English-only (E-4). A UI can localise by code today; owner-exception prose needs E-4.
- **Reporting: fair.** The owner review and exceptions are read-only queries on the transactional database. They are correct, but grow with history (E-2). Larger reporting should use read replicas or materialised snapshots anchored to owner checkpoints, never writes into the evidence tables.

## Invariants confirmed unchanged by R74

All of the following are unchanged, checked by the full suite on source and compiled output at each PR:
- RLS clinic isolation and RBAC (permission matrix doc in sync, ARCH-5).
- Dentist authorship and privacy (no new fields exposed).
- Integer millimes (ARCH-3) and payment idempotency.
- Contiguous numbered receipts, and refund/void authorization with reauth.
- The append-only audit hash chain and its payload anchors, and owner checkpoints.
- The blind cash count (B10 locking unchanged) and paper-outage reconciliation.
- FR/AR print contracts and the clinic timezone (still one source, now enforced).
- API status codes and response shapes (T-API-1..7), migration integrity (no migration touched), and backup/restore (B14 tests).
