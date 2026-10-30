# Issue #67 — scoped CNAM paper-dossier backend evidence

Fictional-only development candidate; independent Muse review and founder merge gate remain open. No frontend, merge, deploy, real data, production settings or automation changes.

## Authority and baseline

- Approved implementation: [issue #67](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/67), including scheduled-worker handoff comment 6515363511; R76 CN-01..CN-11, R78 CN-R01..CN-R46 and COMMAND R80. These authorize the bounded local paper-office slice, not official form/rate/eligibility validation or full CNAM acceptance.
- Claim readback: [Codex claim](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/67#issuecomment-6517137297), correlation `CX67-20261030`. Native scheduler run ID/last_run/result are unavailable; prompt arrival and an executable shell are not claimed as independently verified unattended scheduler completion.
- Verified main/base: `406c5dd1fd16dd543f2c0b9a3a601af33ae6568b`. Branch `codex/issue67-cnam-paper-dossiers` was absent remotely, then created at this base and claimed before implementation. No conflicting CNAM PR/claim was observed on recheck.
- U012 remains owned by open draft [PR #63](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/63), head `8415f6069254aa1ade84f7c9cb9f0ce400407e79`. It is not merged; chair acceptance is still partial. No U012 or GPT UX/security/harness branch was changed. This PR is independent of #63 and GPT #60/#62/#64/#65/#66/#70/#71/#73/#75/#76.
- Read actual main `AGENTS.md`, engineering standards, source/migrations/auth/role matrix/OpenAPI/testing configuration, latest authored Muse UX/security findings, live Mission Control tabs, U012 acceptance row, approved CNAM scope/research and source grading. Official-source gaps from S-001..S-012 remain gaps; no new regulatory assertions were invented.

## Implementation and API handoff

[CNAM-PAPER-DOSSIERS.md](../api/CNAM-PAPER-DOSSIERS.md) is the complete frontend contract and residual-gap handoff. Module: `backend/src/modules/cnam.ts`; migration: `0015_cnam_paper_dossiers.sql`; regression: `backend/test/cnam-paper.test.ts`.

Four append-only RLS tables capture roots, immutable preparation versions, issue/copy/handoff/outcome events and permanent act-to-dossier reservations. Existing transaction/idempotency/audit/visit locks are reused. No new dependency or clinical/financial writer is introduced. Permission matrix and OpenAPI/endpoints were generated from actual routes/permissions and observed fictional API examples.

## RED and root causes

1. `cnam-paper/red.log`: `CNAM-1` initially FAILED, actual404 vs expected400. The module/route was absent, so this establishes a missing acceptance control, **not proof an existing endpoint accepted forged fees**. The implemented route derives/validates signed care and rejects the mismatched fee.
2. `cnam-paper/green-first.log`: first implementation had 2 pass/8 fail. Cause: existing PostgreSQL adapter serializes JS arrays as JSON, while `ANY($1::uuid[])` needs a PostgreSQL UUID array literal. Reused the validated UUID-array parameter pattern already in lab/documents; no driver rewrite.
3. `cnam-paper/green-second.log`: 7 pass/3 fail. Two failures were test assertions that ignored the existing replay metadata `replayed:true`; entity, snapshot and copy equality remain asserted, with the marker checked separately. The third exposed stale signed-fee revalidation returning400 instead of a useful409; issue now returns `CNAM_CARE_CHANGED` while forged creation input remains400.
4. `cnam-paper/red-db-reason.log`: `CNAM-15` FAILED, missing expected DB rejection. SQL CHECK permitted NULL correction reason because UNKNOWN passes a CHECK. Smallest fix: add explicit `correction_reason IS NOT NULL` for versions >1 in the new, not-yet-shared migration. Regression now verifies23514 below HTTP validation.

No failed test is hidden or reclassified as a pass.

## Executed targeted acceptance

Node22.22.0, PostgreSQL16.15; disposable test databases under the existing least-privilege API role. `green.log`: **15/15 PASS, 0 fail, 0 skip**. `typecheck.log`: strict TypeScript PASS.

| Test | Actual control exercised |
|---|---|
| CNAM-1 | Forged invoiced fee rejected, not desk-authored clinical truth |
| CNAM-2 | Wrong patient/dentist, signature-image field and fractional money rejected |
| CNAM-3 | 401/403/404 actions, foreign-patient refusal, direct SELECT RLS, foreign INSERT RLS and UPDATE privilege denial |
| CNAM-4 | Concurrent same-key replay, same-snapshot lost-key draft recovery, concurrent new-key issue recovery, list/detail recovery |
| CNAM-5 | Competing dossiers issue the same act concurrently: exactly one200, one409 CNAM_ACT_ALREADY_ISSUED |
| CNAM-6 | Desk/non-clinician owner correction denied; actual dentist appends version; stale writes/issue denied; old version exactly preserved |
| CNAM-7 | Signed fee correction after preparation blocks stale issue |
| CNAM-8 | Copies/handoff refused before issue; replay preserves copy; concurrent copies numbered2/3; printing/delivery not asserted |
| CNAM-9 | Optional follow-up consent required; OFFICIAL_VERIFIED source refused; reported reimbursement leaves money tables unchanged; audit and append-only triggers |
| CNAM-10 | Actual two-dentist, two-session care links; mixed-script identity; own-acts-only correction boundary; real API examples for all eight routes |
| CNAM-11 | Real patient payment/server receipt IDs reconciled read-only; payment change blocks unissued snapshot; paid warning clears only after a new version |
| CNAM-12 | Injected issue-write failure rolls reservation/event/audit/idempotency back; exact-key retry works after fault removal |
| CNAM-13 | Actual server subprocess SIGKILL/restart/new login, discarded response and new-key retry recover the one committed issue |
| CNAM-14 | Effective tooth amendment invalidates pending preparation; old tooth retained, new version carries actual amendment ID |
| CNAM-15 | Database rejects reasonless correction independent of HTTP validation |

The SIGKILL test kills **after commit**, with response deliberately discarded. The separate trigger test covers rollback before commit. It is not claimed as a network-partition test or every possible crash instant. Concurrency uses actual overlapping API requests, not mock timers.

## Reproducible commands

Use the existing supported Node22 runtime and PostgreSQL16 tooling. Set `EZZ_TEST_ADMIN_URL` to a **disposable fictional-only test server**; no credentials need be committed. Follow `backend/README.md` and do not migrate a production database.

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix backend run typecheck
node --test backend/test/cnam-paper.test.ts
npm --prefix backend test
npm --prefix backend run test:dist
```

Fictional API examples were captured with `EZZ_RECORD_EXAMPLES=1 node --test backend/test/cnam-paper.test.ts`, then `node backend/scripts/gen-openapi.ts` and `node backend/scripts/gen-permission-matrix.ts`. Normalized examples are real successful HTTP calls, not simulated successes. The module provides no UI/screenshots; bilingual rendering/a11y belong to GPT's subsequent frontend slice.

## Full suite and CI classification

Final local full-suite reruns and exact-head CI verification are in progress at initial draft publication. This paragraph must be updated with actual final counts/results; historical main/#63/#66 CI is **not** evidence for this change. Initial source/compiled runs (364 tests,363 pass,0 fail,1 existing optional real-TLS skip) predate the final tests/SQL constraint; retained logs must not be mistaken for final-head coverage. No real TLS execution or local frontend/browser run is claimed for this slice. No configured lint script exists on current main; this PR does not invent a lint pass.

## Remaining review gates

- Independent Muse review at the exact head: role/PHI minimization, actual dentist linkage, SQL/RLS/append-only grants, lock order, duplicate/rollback/recovery, stale source, correction policy, historical snapshots and source grading.
- GPT frontend adoption: immutable keys/version handling, explicit reported-vs-verified labels, no mock official form or numeric estimate, paper-only FR/AR workflow, physical-signature/stamp and privacy handling.
- Full CNAM scope is not complete: official form/version/fields, tariff/eligibility/deadline inputs, clinician identities, invoice-line objects, attachments/checklists/deposit proof, guardian/consent/retention, multi-dentist correction coordination, extensive history pagination and operational reporting remain pending acceptance work. See API handoff.
- A snapshot's private clinic fee is not a conventional tariff; `Estimation indisponible` is unconditional. Reported reimbursement has payee PATIENT and cannot change clinic money. No electronic CNAM API, stored signature/stamp or calibrated preprinted output exists here.
- Per-clinic serialization is deliberately conservative; no performance benchmark or official paperwork acceptance is claimed. Protected history inside one database does not replace off-machine audit checkpoints.
- Founder-authorized merge and all existing production/clinical/legal/privacy/fiscal/regulatory gates remain open. No merge, deploy, spending or real patient data.
