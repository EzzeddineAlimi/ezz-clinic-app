# U001 backend enquiry queue — executed evidence

Base: `1e1cb6a2c8cd24d8aeda079bb7dc71de4692e6f8`. Claim: [U001-20261031-BACKEND-001](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/61#issuecomment-6549811526), native run **NOT_EXPOSED**, **COST_UNKNOWN**. Branch `codex/u001-enquiry-queue`; exact final head and CI are in the PR (avoid a self-referential commit SHA in this file). New isolated worktree; no other branch edited, merged, rebased or deleted. Claim ref was initially created at the detached verification head dccc32c, then ordinarily fast-forwarded to verified base 1e1cb6a before any edits. No existing remote ref was overwritten.

Scope and frontend/backend API contract: [U001 handoff](../api/u001-enquiries.md). Backend-only; screenshots/browser UI testing not applicable. Founder explicitly authorized this draft, not independent review or merge. GPT's PR44/107 untouched. U012 unchanged/integrated, existing PR63 superseded; no duplicate U012 work.

## Actual local execution

Environment: Node **22.22.0** (repository supported range >=22.18 <23; CI uses repository .nvmrc), PostgreSQL **16.15**, real disposable databases, existing ezz_owner/ezz_app roles, fictional data only. PostgreSQL server/client tools available under `/workspace/pg16/bin`. No mock API success.

| Command / check | Actual outcome |
|---|---|
| Before implementation: `node --test backend/test/u001-enquiries.test.ts` | RED: 3 tests, 0 pass, 3 fail, endpoints returned404 (expected201). Evidence below. |
| Focused final source, UTC | 6/6 pass, 0 fail/skip; recorded real API examples |
| Focused source with `TZ=Africa/Tunis` | 6/6 pass, 0 fail/skip |
| Focused source with `TZ=America/Toronto` | 6/6 pass, 0 fail/skip |
| `npm --prefix backend run typecheck` | PASS strict TypeScript |
| `npm --prefix backend run lint` | PASS112 authored files |
| `npm --prefix backend run lint:verify` | Intentional debugger RED/fixture exclusion verified; cleanup GREEN |
| `TZ=UTC npm --prefix backend test` with corrected tools PATH | **386 tests, 385pass, 0fail, 1optional TLS skip** |
| `TZ=UTC npm --prefix backend run test:dist` with corrected tools PATH | **386 tests, 385pass, 0fail, 1optional TLS skip**; build PASS |
| `git diff --check` | PASS |

Full source/compiled include existing financial/clinical, migration concurrency, RLS, restore/recovery, real TLS and U012 tests. Only optional **T-TLS-5** skipped because EZZ_TEST_TLS_ROOTCERT not supplied. Four self-provisioned real-TLS tests, fresh-instance restore, crash-recovery and U001 tests passed with the corrected tools PATH; this is local developer evidence, not production readiness. Full local timezone matrices were NOT rerun: focused new tests ran in three zones; exact-head CI matrix must be checked separately.

Reproduce (use an isolated fictional PG16 superuser endpoint):

```sh
export PATH="/workspace/pg16/bin:/workspace/npm-cache/_npx/6d82ddbdd7da268b/node_modules/node/bin:$PATH"
# Set EZZ_TEST_ADMIN_URL to your disposable fictional PostgreSQL 16 admin database.
npm --prefix backend ci --ignore-scripts
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix backend run lint:verify
TZ=UTC npm --prefix backend test
TZ=UTC npm --prefix backend run test:dist
TZ=Africa/Tunis node --test backend/test/u001-enquiries.test.ts
TZ=America/Toronto node --test backend/test/u001-enquiries.test.ts
# Generators used; do not edit generated contracts by hand:
EZZ_RECORD_EXAMPLES=1 node --test backend/test/u001-enquiries.test.ts
node backend/scripts/gen-openapi.ts
node backend/scripts/gen-permission-matrix.ts > docs/security/permission-matrix.md
```

Six U001 tests cover: creation without patient/file-counter allocation; exact-body retry and changed-body key conflict; recovery through fresh API/DB-pool instance and stale updates; parallel distinct-key duplicates/same-key retries/optimistic updates; receptionist-only including OWNER/DENTIST/ASSISTANT/anonymous denial; tenant API and direct app-role RLS isolation, synthetic DB CHECK and forbidden DELETE/clinic updates; validation allow-list (no supplied patient/clinic/triage assertion); 51-entry paging, invalid cursors/status, closed/new/reopen collision; immutable attributable audit metadata without copying enquiry text; recorded examples/contracts.

## Failures investigated and corrections

- The initial managed-environment shell attempt returned “No usable execution environment”; a subsequent actual shell succeeded after startup. No missing approval was inferred.
- First post-implementation focused run: 2/3pass. The test incorrectly expected the whole replay envelope unchanged; existing idempotency middleware adds `replayed:true`. Assert the enquiry snapshot and replay marker; no middleware change.
- Typecheck caught the example recorder using `Step.file='enquiries'`, outside the existing Audience union. Used its existing `receptionist` category and typed GET/POST argument, without broadening contracts or unsafe casts.
- First full source run omitted PG tools from PATH: **385 tests, 369pass, 6fail, 10skip**. T-DR-1, T-BKP-1, T-JOURNEY-1, T-CP-7 and T-DOCS-13 failed `pg_dump ENOENT`; T-DR-2 cascaded on absent manifestPath. Server-binary dependent tests also skipped. Cause: command environment, not application. Added installed PG16 tools to PATH and reran full source/compiled; results above. No backup/application code changed.
- Empty cursor edge test passed with existing SQL-error-to-validation mapping; no speculative fix was made.

## Persisted raw local evidence

These are developer-executed TAP files for this implementation, distinct from CI observations. SHA256 identifies the exact file bytes. Source/compiled logs were captured before commit; no runtime/test changes were made afterward. Generated examples/docs were regenerated from executed fictional API responses.

| Evidence | SHA256 |
|---|---|
| [red-missing-api.tap](u001/red-missing-api.tap) | `f0a6a20334e82618ce01446ef722451cd940f9d69647a0882f167a2894573097` |
| [focused-green.tap](u001/focused-green.tap) | `660b48bd5b4e5db45420999337fc89985093a6ba99eef24980df1cd1cf185e17` |
| [source-utc.tap](u001/source-utc.tap) | `343af30470e88bbd7cdfa9c70ecad99c4ef42369c11d8cc82472c8cf53a9e4df` |
| [compiled-utc.tap](u001/compiled-utc.tap) | `a67f495384a39b15c2b07401a5b401d84b49251bfd4cc1cde6109de48f6a5432` |
| [focused-tunis.tap](u001/focused-tunis.tap) | `3d280e55f1c406845b45ec9ce9605755689f417ad862614e8568918023914c75` |
| [focused-toronto.tap](u001/focused-toronto.tap) | `ecc30ad8388ba5e8a387091e162e388502e885e30a4be57090f8906f895e8245` |

## Gates and next actor

Independent Muse review has NOT been obtained by this worker. Founder authorization and independent Muse review are mandatory before merging this privacy workflow. Retention/deletion policy, legal/privacy validation, full U001 UI and real receptionist/physical workflow acceptance remain OPEN. Duplicate fingerprint is a heuristic, not verified identity; closing is a manual queue action, not proof of contact or booking. The synthetic flag enforces declaration only; it cannot inspect whether arbitrary supplied text describes a real person. No outbound communication, diagnosis or urgency assertion.

CI results must cite the exact PR head and actual run URLs in the PR; do not substitute the successful base/other PR runs. This document does not claim CI or independent review passed.
