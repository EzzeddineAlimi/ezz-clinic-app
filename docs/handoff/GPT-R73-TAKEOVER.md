# R73 final sprint: takeover package for GPT (2026-10-29)

Everything here is a **DRAFT, fictional-data foundation**. None of it is independently reviewed, merged, deployed, or
production-ready. Muse remains the independent reviewer; Astra owns the frontend. It continues
[`GPT-R72-INTEGRATION-HANDOFF.md`](GPT-R72-INTEGRATION-HANDOFF.md) (on `integration/r72-candidate`, PR #21).

## 1. Exact PR heads (stacked; each PR's base is the previous branch)

| PR | Branch | Base | Head | Content | CI on head (source / compiled) |
|---|---|---|---|---|---|
| #21 | `integration/r72-candidate` | `main` | `0a57234` | R72 integration of #2, #3, #8–#20 (**not modified in R73**; under review) | 238 tests, 237 pass, 0 fail, 1 skip |
| #22 | `r73/a-owner-checkpoints` | #21 | `87b715e` | A: owner checkpoints | 246 / 245 / 0 / 1 |
| #23 | `r73/b-dev-reliability` | #22 | `92e011d` | B: test:dist, migration safety, readiness, fail-fast start, real TLS tests, dev env | 258 / 257 / 0 / 1 (both) |
| #24 | `r73/c-clinic-settings` | #23 | `bd173ae` | C: audited clinic settings, clinic-local days | 267 / 266 / 0 / 1 (both) |
| #25 | `r73/d-patient-documents` | #24 | `fddae0e` | D: patient documents and imaging attachments (+ `7518a40` T-PRT-3 fix) | 281 / 280 / 0 / 1 (both) |
| #26 | `r73/e-lab-stock` | #25 | `0848839` | E: lab cases (MF19) and basic stock | 291 / 290 / 0 / 1 (both) |
| #27 | `r73/f-benchmarks` | #26 | `f5526dc` | F: benchmarks + readiness 503 fix + PostgreSQL crash test | 292 / 291 / 0 / 1 (both, on `a28d785`; `f5526dc` renames a test ID only) |
| #28 | `r73/g-api-contracts` | #27 | `6253027` | G: OpenAPI, recorded examples, contract tests, frontend security states, this handoff | local 297 / 296 / 0 / 1 (both) |
| #29 | `r73/h-b06-hardening` | #28 | the commit adding this row | H: B06 integrity hardening for Muse M-267 (1–7) and CH-034 | local 308 / 307 / 0 / 1 (both) |

- The skipped test everywhere is the pre-existing manual T-TLS-5. It is superseded by T-TLS-REAL-1..4, which run in CI.
- All CI runs are GitHub Actions `backend-ci.yml` (PostgreSQL 16 service, Node 22). They include `npm run test:dist` and the migration ledger check added in B.

## 2. What each package delivered (do not rebuild)

**A — owner checkpoints**
- `EZZ-CP2` line with an 8-hex check code.
- Create, status, print and verify endpoints. Verdicts: MATCHES, TAMPERED, CHAIN_SHORTER, WRONG_CLINIC, CHECKSUM_FAILED and MALFORMED.
- The integrity check gains `INTERNAL_CHECKPOINT_MISMATCH`.
- The B14 restore verifies against outside lines.
- Never claims to detect unrecorded cash. Docs: `docs/security/owner-checkpoints.md`.

**B — development and operations reliability**
- `platform/paths.ts` fixes `test:dist` (it was 265/273 failing).
- `migrationStatus`; `migrate` refuses a schema that is ahead of the code; `migrate --check`.
- `GET /health/ready`; the server exits with code 3 when the database is not ready; `scripts/doctor.ts`.
- `scripts/dev-pg16.sh`; real PostgreSQL TLS tests with a local test CA.
- Docs: `docs/engineering/dev-environment.md`.

**C — clinic settings**
- `timezone`, `checkpointDueDays`, `notArrivedGraceMinutes` (and, from E, `labUnbilledDays`).
- Append-only, audited, owner-only with re-auth; timezone changes need explicit confirmation.
- All UTC-day logic replaced by clinic-local days (exceptions, card, medical, paper, day board).
- Docs: `docs/product/clinic-settings.md`.

**D — patient documents**
- Two-step upload; the body is read only after authentication.
- Magic-byte typing and a 20 MiB cap; the declared size and SHA-256 must match.
- GPS/XMP location metadata removed.
- QUARANTINE → ACTIVE/REJECTED via a pluggable screener; the default is a format check, **not** a malware scanner.
- Audited, attachment-only downloads, re-hashed on every read.
- Dentist-only access; ENTERED_IN_ERROR plus re-attachment; owner deletion requests are recorded, never executed.
- Replaceable `BlobStore`; the driver now handles bytea.
- Docs: `docs/product/patient-documents.md`.

**E — lab and stock**
- Lab case state machine; dentist signs, assistant handles logistics; desk board without clinical detail.
- Remakes; care links; supplier invoices as clinic expenses.
- MF19 owner exceptions.
- Stock ledger with per-item seq and running on-hand, never negative.
- Docs: `docs/product/lab-and-stock.md`.

**F — benchmarks**
- `scripts/bench.ts` with invariants after every phase.
- Three recorded runs; T-CRASH-1 (PostgreSQL crash mid-burst).
- Docs: `docs/benchmarks/R73-F-performance-resilience.md` (+ JSON).

**G — API contracts**
- `docs/api/openapi.json` (OpenAPI 3.1, 102 operations, generated) and `endpoints.md`.
- `examples/*.json`: receptionist, dentist, owner, patient-facing, security-states.
- `frontend-security-states.md`.
- T-API-1..5: the role matrix is checked live for all 384 role/route pairs.

**H — B06 hardening (Muse M-267 1–7, CH-034)**
- Audit payloads anchor exact row timestamps, the full receipt snapshot hash, the denominations hash, and correction procedure/site.
- Free text is anchored by hash only.
- The integrity check compares:
  - cash period float and start (first and carry-forward periods);
  - every expected-cash input time;
  - the refund/void visit;
  - the receipt snapshot hash.
- A deleted period is a finding, not a crash. Explicit `clinic_id` filters.
- Docs: the R73-H section in `docs/security/integrity-value-checks.md`.

## 3. Defects confirmed and corrected in R73 (RED test before the fix)

| Defect | Test (RED → GREEN) | Fixed in |
|---|---|---|
| Internal checkpoint copies not compared with the chain | T-CP-4 | #22 |
| A schema ahead of the code was used silently | T-MIG-1 | #23 |
| The server started on a wrong schema or a bad password | T-START-1, T-START-2 | #23 |
| `npm run test:dist` failed 265/273 (R72 D-1) | full compiled run equals the source run; now in CI | #23 |
| Owner exceptions used UTC days | T-SET-7 | #24 |
| Card claims dated by UTC day | T-SET-8 | #24 |
| Medical next-review date from the UTC day | T-SET-9 | #24 |
| `paper.ts` timezone literal (R72 D-7) | covered by T-SET-* and the paper tests | #24 |
| **T-PRT-3 hard-coded `28/10/2026`**: fails on any later day | T-PRT-3 (failed at 2026-10-29T01:15Z) | #25 `7518a40`. **Still present on #20 and #21**: port before any re-run there |
| Readiness answered 500 instead of 503 when PostgreSQL was down | T-CRASH-1 | #27 |
| M-267 (1): expected-cash inputs (float, start, count time) unchecked | T-INT-CASH-A, T-INT-CASH-B | #29 |
| CH-034: payment, movement or refund moved across the cut-off | T-INT-CASH-C, T-INT-CASH-D | #29 |
| M-267 (6): deleted cash period aborted the check (500) | T-INT-CASH-E | #29 |
| M-267 (5): denominations rewrite unchecked (the difference was already DB-enforced) | T-INT-CASH-F | #29 |
| M-267 (2): receipt snapshot fields unchecked | T-INT-RCPT-1 | #29 |
| M-267 (3): correction site/procedure and care reason unchecked | T-INT-CORR-1 | #29 |
| M-267 (4): refund visit and adjustment note unchecked | T-INT-ADJ-1 | #29 |
| M-267 (7): check crashed without RLS (another clinic's counter) | T-INT-SCOPE-1 | #29 |

From R72's table:
- **Closed:** D-1 and D-7.
- **Still open:** D-2, D-3, D-4, D-5, D-6, D-8, D-9, D-10 (now addressed by A's workflow) and D-11.
- **New residual:** `security_denials.day` still uses the UTC `current_date` (`identity.ts`, the denial counter). It is low impact: the 7-day window shifts by up to one hour.

## 4. Setup

```bash
# Node 22.x, PostgreSQL 16 (no Docker needed)
backend/scripts/dev-pg16.sh start        # throwaway cluster on :54316 (fictional superuser password), or use any local PG16
export EZZ_TEST_ADMIN_URL=postgres://postgres:<superuser-pw>@localhost:<port>/postgres
cd backend && npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck && npm test            # 297 tests (1 manual skip)
npm run build && npm run test:dist       # same suite compiled
node scripts/doctor.ts                   # Node/PG versions, TLS policy of DATABASE_URL, migrations current (no secrets printed)
node scripts/migrate.ts --check          # JSON status; exit 1 if pending/modified/ahead
npm run gen:openapi                      # regenerate docs/api/openapi.json + endpoints.md (T-API-2 enforces)
EZZ_RECORD_EXAMPLES=1 node --test test/r73-api-contract.test.ts   # re-record docs/api/examples after an intended API change
BENCH_CLINICS=5 BENCH_PATIENTS=120 npm run bench                  # ~35 s, exits 1 on any invariant violation
```

The TLS tests and T-CRASH-1 start their own clusters through `initdb`/`pg_ctl` (as the `postgres` OS user when run as root). They skip, with a reason, if the binaries are missing.

## 5. Data migrations added in R73 (all forward-only, transactional, in `backend/migrations/`)

| File | Change | Notes |
|---|---|---|
| `0010_app_reads_schema_migrations.sql` | `GRANT SELECT ON schema_migrations TO ezz_app` | readiness reads the ledger as the app role |
| `0011_clinic_settings.sql` | `clinic_setting_changes` (append-only, RLS) | the effective value is the latest change, else bootstrap `clinics.settings`, else the default |
| `0012_patient_documents.sql` | `document_blobs`, `patient_documents`, `patient_document_events`, `document_deletion_requests`; **adds `UNIQUE (clinic_id, id, patient_id)` on `visits`** | the bytea foundation is in backups; the app role has no DELETE or UPDATE |
| `0013_lab_stock.sql` | lab and stock tables (8); **widens the `clinic_setting_changes.key` CHECK** to add `lab_unbilled_days` | the stock ledger uses a per-item `seq`, not timestamps |

- Downgrades are refused by design: `migrate` throws when the database has migrations the code does not know.
- No migration rewrites existing rows.

## 6. Integration dependencies

- The stack is linear: #21 → #22 → … → #28. Land or review in that order. Each PR's diff is only its own package.
- The T-PRT-3 fix (`7518a40`) is test-only. Port it to #20 (B15) and #21 the next time those heads move. Their recorded CI is green, but any re-run after 2026-10-28 fails T-PRT-3.
- R73 code touches shared files. Expect conflicts there if #21 changes underneath:
  - `src/app.ts`, `src/platform/http.ts` (binary bodies, file responses, `transaction: false`), `src/platform/postgres.ts` (bytea);
  - `identity.ts` (permissions), `integrity.ts`, `exceptions.ts`, `test/architecture.test.ts`;
  - `docs/security/permission-matrix.md`, which is regenerated with `node scripts/gen-permission-matrix.ts > ../docs/security/permission-matrix.md`.
- After any route or permission change: regenerate the matrix and the OpenAPI document. If response shapes changed on purpose, re-record the examples. T-API-1, T-API-2 and ARCH-5 enforce all three.

## 7. Unverified or out of scope (be explicit with reviewers)

- **Nothing in R73 is independently reviewed.** The security-relevant parts are:
  - checkpoint verification;
  - the binary upload path and its pre-auth body read order;
  - document access and the screener;
  - the `transaction: false` routes;
  - lab and stock permissions;
  - settings re-auth.
  Muse should review these first.
- Document storage is the PostgreSQL foundation only. The following are not decided or built: production provider, malware scanning, retention and deletion execution, CBCT sizes above 20 MiB, DICOM header policy, assistant/receptionist upload.
- Benchmarks come from one 4-vCPU container with PostgreSQL on the same host. There is no TLS-under-load, multi-instance, soak, failover or real-device data.
- The docker-compose files were not exercised; there is no Docker daemon in this environment.
- The Arabic wording in prints and examples still needs native review.
- No patient-facing API exists.

## 8. Decisions recorded for the founder / operations / legal (not engineering's to make)

New in R73 (each also listed in its package doc):
1. Production document storage, data residency and encryption keys.
2. The malware scanner.
3. The retention and deletion policy (Q16) and who approves erasure.
4. ASSISTANT and RECEPTIONIST document and lab-receipt rights.
5. DICOM identity fields.
6. Lab price lists and supplier payments.
7. Stock valuation (fiscal).
8. Whether the shade and material lists should be coded.
9. Whether `verify-ca` may be used for remote databases (R72 D-2).
10. Backup passphrase custody (R72 D-11).
11. The checkpoint cadence default (7 days, now an owner setting).

## 9. Next prioritised coding tasks for GPT

1. **Get Muse's review of #22–#29** in stack order (#29 answers M-267 directly). Address findings on a new commit per PR; never force-push.
2. **Port `7518a40` (the T-PRT-3 date fix)** to #20, and to #21 via the integration process (`prs.txt` and `rebuild.sh`), when those heads next move.
3. **O-2 (scaling):** incremental integrity verification from the latest owner checkpoint. Re-verify the chain only after the anchor; recompute value checks only for rows newer than it. Keep a full mode for the owner on demand. Measure with `npm run bench` at 10×300 and a larger run.
4. **Close the remaining small residuals:**
   - `security_denials` clinic-local day;
   - pagination for the B11 review (D-8);
   - rate limits on OTHER declarations (D-6);
   - constraint names in errors (D-4) if Muse asks.
5. **Astra hand-off support:** answer contract questions from `docs/api/*`. Add recorded examples for the remaining 64 operations (`x-ezz-example: false` in `openapi.json`), starting with the paper, card, lab, stock and staff screens.

Lower priority:
- O-1 (cash count waits behind a continuous payment stream): only if a reviewer judges it relevant at clinic volumes.
- Document upload benchmarks.
- A real malware-scanner adapter, once operations chooses one.

## 10. Working rules (unchanged)

- Draft PRs only. No merge to `main`. No deployment. Fictional data only.
- Do not modify a PR while it is under independent review: stack or follow up instead.
- Reproduce defects with a failing test (RED) before fixing, and keep that test.
- Never skip, disable or quarantine tests.
- Keep the evidence wording neutral. Never claim detection of unrecorded cash.
- Commit attribution and PR footers as in previous rounds. No model names in code or commits.
