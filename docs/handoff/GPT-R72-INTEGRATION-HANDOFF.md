# R72 integration handoff to GPT (2026-10-28)

Author: Claude (Claude Code session, R72). Audience: GPT, taking over active coding on 2026-10-29. Muse keeps independent review; Astra keeps the frontend.

**Status:** DRAFT integration candidate, fictional data only, **not merged, not approved, not deployable, not clinically ready**. Nothing here authorises payments, real patient data or clinical use.

---

## 1. Integration branch and commits

| Item | Value |
|---|---|
| Branch | `integration/r72-candidate` (from `main` `c89d6e6`) |
| Draft PR | [#21](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/21) (DRAFT, DO NOT MERGE) |
| All PRs merged, before any integration change | `054d718` (`scripts/integration/rebuild.sh` reproduces this tree exactly) |
| Last code and test commit | `4558681` |
| Handoff document commit | the commit that adds this file, directly on top of `4558681` |

Integration-only commits after `054d718`, each one separate and reviewable:

| Commit | Kind | What |
|---|---|---|
| `784dc15` | test (integration) | T-ENC-4 (#12) uses past slots, because B12 now refuses NO_SHOW before the appointment time. It also asserts the *documented-visit* refusal message. |
| `68bac20` | fix (integration) | B15 `print.ts` and B11 `review.ts` use the shared `patients.clinicTimezone`. B11's window is now clinic-local, not UTC. RED/GREEN: T-OWN-9. |
| `1ed8389` | tooling | `scripts/integration/{prs.txt,rebuild.sh,verify.sh}` |
| `915053e` | fix (M-264/M-265) | Clinical author role snapshots are true by construction (`requireDentistAuthor`). RED/GREEN: T-ROLE-1. |
| `7231b38` | fix (M-266) | The pool never reuses a client that is mid-transaction or in a failed transaction (T-POOL-8). Idle-client errors are logged by code only (T-POOL-9). Evidence tests T-ERR-2 and T-ARCH-6. |
| `5696583` | feature (M-264 (5)) | B06 value checks cover the 8 B07 clinical tables, plus a recomputation of each note's content hash. RED/GREEN: T-CINT-1..4; no false alarms: T-CINT-0. |
| `4002815` | test (M-265) | Executed perform-concurrency evidence: T-PLAN-3. |
| `030dd49`, `4558681` | test (Mission 3) | Whole-clinic journey: T-JOURNEY-1. |

## 2. PR dependency graph and integration order

```
main c89d6e6
 └─ #2  feat/opus55-v02-backend-review 2defdca
     ├─ #3  fix/opus55-audit-field-fidelity b6563eb ── #14 B06 660f699
     ├─ #13 B05 5211232 ── #15 B14 c4921d0
     ├─ #8  feat/outage-20-visit-drill 38190f4 ── #19 B13 2b9ae50
     ├─ #9  docs/astra-clinical-contracts addc5a5 ─┐
     ├─ #10 feat/visit-workbench-readmodel 0fe3bf3 ─ #11 ch028 26a139c ─┬─ #12 B07 da64428 (contains #9, #10, #11)
     │                                                                  └─ #16 B10 e16e624
     ├─ #17 B11 3e20d23
     ├─ #18 B12 1b3102a
     └─ #20 B15 2817d71
```

Merge order used, and recommended for main: **#2 → #3 → #13 → #15 → #12 (brings #9, #10, #11) → #16 → #14 → #8 → #19 → #17 → #18 → #20**, then the integration commits listed above. Exact SHAs are in `scripts/integration/prs.txt`.

Textual conflicts were limited to two files, and both were additive (keep both sides): `backend/src/app.ts` (route list) and `backend/test/architecture.test.ts` (module map), when merging #18 and #20.

There were also **semantic** conflicts, which textual merging cannot catch:
- B12 vs #12: T-ENC-4. Fixed in `784dc15`.
- B11 UTC window vs B12 clinic-local days. Fixed in `68bac20`.
- New B06 clinical checks vs #12's deliberate tamper in T-NOTE-1. That test now restores the note after asserting the integrity check sees it (`5696583`).

## 3. What is integrated and what is excluded

**Integrated:** all open PRs #2, #3, #8–#20, plus the R72 commits above. PR #1 is closed and its content is already on `main`.

**Excluded or not done:**
- No review branch was modified. The integration-only test edits to #12's `clinical-encounter-workflow.test.ts` exist **only** on this branch.
- Migrations: 0001–0009 (0008 = #12 clinical core, 0009 = B13 slip patient reference). No migration was added in R72, and no CHECK was relaxed.
- No frontend (Astra), no deployment, no payment provider, no patient contact, no real data.
- The `prototype/` v0.1 (repo root `src/`, `public/`, `test/`) is untouched and still checked by `demo-checks.yml`.

## 4. Test and CI results (actual)

Local runs: PostgreSQL 16.15, Node 22.22.0 (`backend/.nvmrc` pins 22.23.4; CI uses that), via `scripts/integration/verify.sh`. Final run at `030dd49` + the label-only commit `4558681`:

| Check | Result |
|---|---|
| All 12 listed PR heads are ancestors | yes |
| Migrations unique and ordered | yes (0001–0009) |
| `npm run typecheck` | pass |
| Permission matrix regenerated == committed | pass |
| `npm test` (real PostgreSQL 16) | **238 tests, 237 pass, 0 fail, 1 skipped** |
| Skipped | T-TLS-5 (B05): real PostgreSQL over TLS. It is local evidence only and skips unless `EZZ_TEST_TLS_ROOTCERT` is set (the CI service container has no TLS). |
| `scripts/demo-visit-journey.ts`, `scripts/demo-dentist-encounter.ts` | pass |
| `npm run build` | pass |
| `npm run test:dist` | **FAILS: 256 of 264.** Already broken on the base before R72 (compiled tests resolve `.ts` paths and migrations wrongly). CI does not run it. See §6, D-1. |
| `scripts/integration/rebuild.sh` | Re-merged the 12 heads in a fresh worktree; tree **identical** to `054d718`. |

Progression of the combined suite:
- First combined run at `054d718`: 225 tests, 223 pass, **1 fail (T-ENC-4)**, 1 skipped.
- After the integration fixes: 226/225/0/1.
- After M2: 237/236/0/1.
- After M3: 238/237/0/1.

GitHub CI on PR #21:
- Backend workflow: runs on every push to the PR.
- Earlier heads: see the PR checks.
- Final head: check the PR before relying on it. I do not claim a CI result I have not read (see the Mission Control C-row for the CI read at handoff time).

### Whole-clinic journey (T-JOURNEY-1), actual output

The output below is from one run on the integrated build. Visits are dated yesterday, clinic-local (Africa/Tunis).

```
clinic opened         clinics 2, opening float 20,000
patients registered   7; same-name duplicate warning CONFLICT for the no-phone elderly patient (file 1), confirmed as a different person
day-board             6 visits; elder flags IN_PERSON_CONTACT_ONLY, SAME_NAME_OTHER_FILE, NOT_ARRIVED_PAST_START; no phone numbers on the board
medical alert         declared by desk; desk sees presence only (criticalAlertCount 1, detail 403)
dentist encounter     alert verified, history reviewed, 1 finding, 1 signed note, plan performed 80,000; 3 other care items
role boundaries       desk / assistant clinical write 403; owner clinical read 403; assistant board shows no money
checkout              R-000001..R-000005 gap-free (payment, card claim, refund, payment, void); discount 10,000; refund 10,000; void 30,000
receipt printed       R-000001 ORIGINAL (FR + AR, 18 pt), then COPY 1
missed visits         1 no-show, 1 cancelled; cancelling the treated visit refused ("Cannot change visit from COMPLETED to CANCELLED")
paper outage          wrong-patient slip REJECTED; 1 posted; replay = DUPLICATE_ENTRY; 1 void; 2 unused; P-205 unaccounted
blind count           counted 135,000, expected 110,000, difference +25,000 ("owner review pending (not an accusation)")
period closed         workbench cash evidence DESK_CASH__DRAWER_PERIOD_COUNTED
owner review          evidence CASH_IN_COUNTED_PERIOD 2, CARD_DESK_CLAIM 1, PAPER_SLIP_RECORD 1; returns REFUND:R-000003, PAYMENT_VOID:R-000005;
                      exceptions CASH_COUNT_DIFFERS, AUDIT_CHECKPOINT_DUE, PAPER_DUPLICATE_ENTRY, PAPER_NOT_ACCOUNTED_FOR, DENIED_PRIVILEGED_ATTEMPT,
                      DESK_MARKED_NO_SHOW, DESK_MARKED_CANCELLED; integrity ok; 61 audit events
privacy sweep         6 desk and 1 assistant responses: no clinical free text
clinic B isolation    clinic A's patient / receipt / paper book -> 404; B's board shows 1 visit; B's review is empty; B's integrity ok
backup and restore    encrypted backup restored into a NEW database: 16/16 checks; clinical, paper and print rows identical; restored API integrity ok
```

The +25,000 surplus is fictional and deliberate. The journey proves the discrepancy is recorded and reaches the owner; it proves nothing about real cash.

## 5. Reproduce locally

```bash
# PostgreSQL 16 superuser for throwaway FICTIONAL databases (never a real DB)
export EZZ_TEST_ADMIN_URL=postgres://postgres:fictional-ci-only@localhost:5432/postgres
git fetch origin integration/r72-candidate && git switch integration/r72-candidate
scripts/integration/verify.sh            # ancestry, migrations, install, typecheck, matrix, tests, demos, build
scripts/integration/rebuild.sh           # optional: re-merge the PR heads from main and diff the tree with 054d718
cd backend && node --test test/r72-whole-clinic-journey.test.ts   # the journey alone, prints JOURNEY lines
```

Use `npm ci --ignore-scripts --no-audit --no-fund` in `backend/` after switching branches, because lockfiles differ between PR bases.

If the sandbox sets `NODE_OPTIONS=--use-openssl-ca`, B05's "no CA pinned" behaviour reflects the OS trust store (§6, D-3).

## 6. Known defects and open items (not fixed in R72)

| ID | Severity | Where | What | Reproduction or test |
|---|---|---|---|---|
| D-1 | LOW (tooling) | `backend/package.json` `test:dist` | Compiled test run fails 256/264. Pre-existing; not run in CI. | `npm run test:dist` |
| D-2 | MEDIUM (deployment policy) | `backend/src/platform/postgres.ts` (`tlsOptions`, verify-ca) | `sslmode=verify-ca` accepts a CA-signed certificate for the wrong host (standard libpq semantics). `verify-full` is the default. Whether to forbid verify-ca for remote hosts is a policy decision. | B05 T-TLS-3 |
| D-3 | MEDIUM (deployment condition) | ADR-0004a | Without `sslrootcert`, the Node/OS trust store decides. Production must pin the CA. | M-266 (2) |
| D-4 | LOW | `backend/src/platform/http.ts` `mapPgError` | API errors include constraint *names* (no values, detail or table). | T-ERR-2 documents the current shape |
| D-5 | LOW | `PgPool` | Session-level `SET` (not `SET LOCAL`) by a raw pool user would survive release. Mitigated: only `Db` builds a pool (T-ARCH-6), and `Db.tx` uses `SET LOCAL`. | none (by construction) |
| D-6 | LOW | `backend/src/modules/medical.ts` declare | No rate limit on OTHER / ALLERGY_OTHER declarations (M-264). | static |
| D-7 | LOW (maintainability) | `backend/src/modules/paper.ts` (`careVsSlips` SQL) | The clinic-timezone default `'Africa/Tunis'` is repeated in SQL instead of the shared helper. An invalid setting errors in SQL there. | static |
| D-8 | LOW | B11 review | No pagination on a 92-day window. | static |
| D-9 | INFO (semantics) | workbench (B10) | After the owner accepts a count *with* a difference, the desk sees `DRAWER_PERIOD_COUNTED` (blind by design). The difference is owner-only, in the cash review, B11 and exceptions. | T-JOURNEY-1 |
| D-10 | INFO | owner exceptions | `AUDIT_CHECKPOINT_DUE` always shows until the owner records a checkpoint. Outside checkpoints are the only defence against a consistent superuser rewrite (B06 T-INT-LIMIT-1). | T-JOURNEY-1 |
| D-11 | INFO | backup (B14) | No PITR or WAL (RPO = backup interval). Passphrase custody, scheduling, off-site copy and storage location are undecided. | docs/operations/disaster-recovery-drill.md |
| CH-002 | inherent | — | Money never recorded anywhere cannot be detected by software. | — |

## 7. Decisions still pending (not engineering's to make)

**Founder** (with qualified Tunisian advice where marked):
- **Owner access to staff free text** (B11 returns flags only; workbench/care keep the OWNER carve-out from #12). Loi 2004-63 Art. 63 is UNVERIFIED (CH-006).
- **ASSISTANT clinical access.** It is currently none; R72 made the role snapshot safe either way.
- **Physical paper slip fields.** B13 validates an optional patient file number; B15's printed slip proposes a box for it. Whether it becomes mandatory is open.
- **Receipt / fee-note mandatory fields** and the amount convention (CH-005 Art. 31; B15 is explicitly "not a fiscal document").
- **Receptionist cash collection** (CH-003/CH-005), **card provider and evidence path** (CH-013/CH-022).
- **Hosting and data residence** (CH-004, CH-006, CH-021): this blocks any real data.
- **Backup passphrase custody** and off-site storage (B14).
- **Clinical rules marked PROVISIONAL in migration 0008** need confirmation by a Tunisian dentist.
- **Arabic wording** in B15, B12 and B07 needs native review (Astra/founder).

**Security policy (GPT and Muse to propose; founder to accept):** verify-ca allowed or not for remote hosts (D-2); CA pinning in deployment (D-3).

## 8. Recommended next five engineering tasks (by dependency and risk)

1. **Independent review of the R72 fixes before anything lands.** Muse should check `915053e` (role guard), `7231b38` (pool release / logging) and `5696583` (clinical integrity), alongside the already-requested reviews of #14–#20. These change security-relevant behaviour and are Claude-authored and not yet reviewed.
2. **Decide the landing strategy.** Either merge the PRs in §2 order with the integration commits as a final PR, or rebase the integration commits onto each owning PR. Note that `784dc15` and the T-NOTE-1 change in `5696583` edit #12's test file and must travel with #12 (or after #18 and #14).
3. **Owner checkpoint workflow** (D-10). Today it is the only protection against a consistent superuser rewrite. It needs an owner action to record and print the checkpoint line (B15 print contracts can carry it), a reminder cadence, and use of anchors in `/integrity/check` and B14 restore.
4. **Clinic settings route with audit** (timezone, card settings), and replace the SQL timezone literal in `paper.ts` (D-7). The timezone currently changes only at bootstrap.
5. **Fix `test:dist`** (D-1), then freeze the API contracts for Astra: day-board, workbench, encounter, print, owner review, exceptions. Generate a schema from the route table after Muse's review.

Lower priority after these: rate-limit OTHER declarations (D-6), B11 pagination (D-8), and constraint-name stripping in errors (D-4) if Muse wants it.

## 9. How GPT should continue without duplicating work

**Done; don't redo:**
- The whole integration (`rebuild.sh` proves it).
- The M-264/M-265/M-266 fixes above.
- B06 clinical-table coverage.
- The perform-concurrency evidence.
- The whole-clinic journey.
- B05, B06, B10–B15 implementations (PRs #13–#20).

**Before coding:**
- Run `scripts/integration/verify.sh` on the branch head.
- Read the Mission Control rows C-190 (integration), C-191 (gaps) and the R72 close-out C-row.

**Rules that still hold:**
- Draft PRs only. No merge to `main` without independent review and founder approval.
- Fictional data only.
- Don't modify a PR under Muse review; put follow-ups on a new branch.
- Reproduce with a failing test before fixing.
- Keep wording neutral: no "theft" or "suspicious".

**Changing the integration branch:**
- Keep each change a separate commit.
- Update `scripts/integration/prs.txt` if any PR head moves.
- Re-run `rebuild.sh`. It must report IDENTICAL, or you must explain the difference.

**If a PR head moves:**
1. Update `prs.txt`.
2. Rebuild.
3. Re-apply the integration commits with `git cherry-pick 784dc15^..4558681`.
4. Run `verify.sh`.

**Role boundaries:** Muse's independent review and Astra's frontend are their lanes. Hand them contracts and evidence, not verdicts.
