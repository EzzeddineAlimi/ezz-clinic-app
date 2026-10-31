# Backend authored-source quality — issue #74 slice

This is a **backend-only, partial** delivery of [issue #74](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/74). It adds a real, reproducible lint gate without rewriting clinical/financial modules or changing APIs, permissions, schema, runtime dependencies or frontend files. Frontend lint, formatter adoption and administrator-enforced required checks remain open.

## Tool and scope

- Dev-only `@biomejs/biome` **2.6.4**, exact version and integrity-pinned optional platform binary in the lockfile. npm metadata declares Node `>=14.21.3`, **MIT OR Apache-2.0**; both license files are included in the package. Tested on this repository's Node22/TypeScript6 sources. This is not a universal compatibility or security certification.
- `backend/biome.json` includes authored TypeScript in `src/`, `test/`, and `scripts/`, plus authored `.mjs` scripts. It excludes test fixtures and the historical `scripts/v01-baseline-probe.mjs`. Generated API JSON outside backend, migration SQL, lockfiles, `dist/` and dependency trees are outside these source globs. Authored `src/contracts/clinical.ts` **is included**.
- The initial policy explicitly enables **13 error rules**; it is not Biome's full recommended preset. Existing strict TypeScript, architecture, permission, tenant, financial and security checks remain separate and unchanged.

| Group | Enabled rules |
|---|---|
| correctness | `noUnreachable`, `noUnreachableSuper`, `noUnsafeFinally`, `useValidTypeof` |
| suspicious | `noAsyncPromiseExecutor`, `noCompareNegZero`, `noDebugger`, `noDuplicateCase`, `noDuplicateClassMembers`, `noDuplicateElseIf`, `noDuplicateObjectKeys`, `noDuplicateParameters`, `noUnsafeNegation` |

The narrow initial rule set catches concrete correctness hazards without making unrelated stylistic/legacy rewrites a prerequisite. It is not a replacement for code review or a claim that every possible defect is linted. Rule expansion needs its own measured baseline and review.

## Commands

From the repository root:

```bash
npm --prefix backend ci --ignore-scripts
npm --prefix backend run lint
npm --prefix backend run lint:verify
npm --prefix backend run typecheck
```

`lint` checks the full configured authored-backend scope, not only changed files, and never fixes files. `lint:verify` executes the pinned CLI: an invalid TypeScript file in a temporary synthetic-fixture directory must be excluded; an authored temporary `debugger;` file must fail with the exact `lint/suspicious/noDebugger` diagnostic; cleanup must restore exit0. A generic command error cannot satisfy RED. Temporary probes are removed in `finally`; no patient, database or service is used.

## Baselines, formatting and CI

Before configuration, `biome lint src test scripts --reporter=json` against base `9dc5dba` reported **14 errors, 937 warnings, 147 infos** (107 checked files). The errors concern assignment expressions, callbacks returning ignored array-mutation/assertion values, and intentional control-character rejection in `validate.ts`; they were inspected, not labeled confirmed product defects. Most warnings are existing non-null assertions. No module was rewritten or suppressed inline to make the check pass.

The configured formatter was measured without writes: `biome format . --reporter=json` exited1 with **108 formatting diagnostics**. Formatter adoption is therefore **deferred**, not green. No `format:check` script or formatting CI claim is made in this slice. A later coordinated formatting policy must avoid a mass clinical/financial diff and include frontend ownership. The new lint gate does not run formatting or organize imports.

`.github/workflows/backend-quality.yml` runs job **`backend-lint`** on **every pull request**, including docs-only changes, with no path filter or conditional at the PR trigger. It uses the existing pinned checkout/setup-node actions, read-only repository permission, Node from `backend/.nvmrc`, lockfile install without lifecycle scripts, then both real lint commands. Push checks on main cover backend/quality-workflow changes. No database, secret, deployment, cron or new scheduled worker is introduced. Existing backend/frontend/security workflows are preserved, including GPT-owned PR #103's independent cache changes.

**Issue #68 remains open:** creating a stable check is not configuring required-check enforcement; no GitHub protection/settings were changed. New source rule failures must block this job. An independent review remains required, and this worker has no merge/deploy authority.

## Evidence and preflight history

- [Claim](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/74#issuecomment-6540596117), reporting label `CX-ISSUE74-BACKEND-LINT-20261031T0727`; native run ID **NOT_EXPOSED**, **COST_UNKNOWN**. No duplicate lint branch/PR/claim found before creating `codex/issue74-backend-lint`.
- Actual main advanced from `25708be` to **`9dc5dba2f3f8e10e1f77d96ca0822bcfdf7db394`** through an external PR #102 merge before edits. This worker did not merge the PR. Its own unused branch was fast-forwarded non-force to the new base.
- Post-main [backend run41180451056](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/41180451056) initially failed Node26.13 job124476594802: `T-PAPER-6` → `server did not start` at helpers.ts174; **371/369pass/1fail/1skip**. Helper does not emit child stderr, so the original cause is **UNKNOWN**. No speculative runtime/helper fix or timeout increase was made.
- Three **executed local Node26.13/PG16.15** repetitions of `node --test --test-timeout=60000 test/c6-paper-outage.test.ts` each passed **9/9**, including restart; no local failure reproduced. First single-job rerun request returned403 because the workflow was still active. After completion, the single failed job was rerun: attempt2 **SUCCESS**, all five backend jobs green. This cleared the post-main gate before implementation; it does not establish a root cause or prove the failure cannot recur.
- Oldest owned backend #63 remains draft `ddda4914b9c8a1c1244c83f0a92ab4e7d3607180`, exact CI green with independently authored Muse carry-forward; founder booking gate and physical-chair acceptance remain open. No edit/duplicate. GPT-owned #100/#103 untouched. #102 had actual independent Muse PASS `MUSE-UX-102-981CEC50`, read back in `UX_MODEL_REPORTS` row334; full clinical issue #7 remains open.

Implementation commands, final local full-suite results, exact candidate SHA and observed CI run URLs are recorded in the draft PR and operational ledger. Local execution, observed CI and independent review must remain distinct. No production, real-patient or full V1 acceptance is implied.

### Executed local candidate checks — Node22.22 / PG16.15 / UTC

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` from final lockfile | PASS; 21 packages, no lifecycle scripts |
| `npm run lint` | PASS; 108 files checked, no fixes applied |
| `npm run lint:verify` | PASS; actual authored `noDebugger` RED, ignored invalid fixture excluded, cleanup GREEN |
| `npm run typecheck` | PASS, strict TypeScript6 |
| `npm test` | PASS; 371 tests / 370 pass / 0 fail / 1 optional `T-TLS-5` skip; 106.234s |
| `npm run test:dist` | Build + compiled PASS; 371 / 370 / 0 / 1 optional `T-TLS-5` skip; 101.338s |
| Full local timezone matrix / browser | NOT RUN; existing CI must be independently observed at the new exact head |
| Formatter baseline, not a gate | Exit1, 108 diagnostics; NOT passed or silently fixed |

The four separate `T-TLS-REAL-1..4` tests passed in source and compiled; the optional external-CA `T-TLS-5` skip is not a claim that all TLS was skipped. The clean locked install was followed by another lint/smoke/typecheck PASS; no application or test input changed after full-suite execution. CI results for a new commit must be read back independently; earlier green main or PR102 runs are not candidate evidence.

```text
RED verified: authored debugger rejected; ignored synthetic fixture was excluded.
GREEN verified: cleanup restores the passing authored-backend lint baseline.
```

SHA256 provenance: config `7be74b6788efb35f40d354437c5f7413b6940f126697a4383c91ce6f6296efb1`; smoke script `7d2d702e312e1a78c80ba52fe2074faecd4b207e34e687b1798d27c60e7e845a`; source TAP `bd6612704daaf4223b79c66ff0617ad9471d23ed806fe5d1d201dd1c0374c59c`; compiled TAP `d0e447bf1c775c0d10dd58dab1de2e4bd731baaadb391e97053ec81069b60f91`. Local bulk transcripts are temporary; durable commands/results/risks are here and exact-head CI logs are linked in the draft PR. No UI changed, so screenshots are not applicable.
