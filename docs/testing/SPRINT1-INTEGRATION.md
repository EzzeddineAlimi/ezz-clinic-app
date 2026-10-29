# Sprint 1 — executable integration and security baseline

Manual, fictional data only. No merge, deployment, schedules or production-readiness claim.

## Candidate ancestry

Started at PR #34 `51e188b10a91b7269ff0d3db7d3fd320f97b325c` on a new branch,
`codex/sprint1-integration-security`. Merged, without conflicts, in this order:

1. #39 `f6f0b3c4d38a4395ae5ea18eff9d7cc2a9cff6dc`, which already contains #35
   `90a7027457f6bdcf34c4f1de65eb68047548a1f2`. #35 was not merged a second time.
2. #36 `7f8957926bbd77443e1ad2cb02c0fcef319a5e0a`.
3. #37 `5c4b0dc301586a7b29451df38265786da76e8e4a`.
4. #38 `a4cc2e4fba30d86c4eddb15f09dfd6de22afbb10`.

Merge-only head: `4c5cfa0a2c185c1c2b66b93ffc7c2f08cea9de13`.
Migration/runner/CI commit: `7889e9afb5dff0acc5c1bb13d37e332790431165`.
Final executed code commit: `3ecc18332790f1e560f5c574f0880689a0f8cb14`.
Subsequent evidence-only commits must leave the backend, lockfile and CI tree unchanged.
Review PR: https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/42 (draft against main).
The large main diff is the intentionally preserved unmerged backend lineage, not a rewrite.

## Reproduced defects and minimal changes

### Migration runner race (runtime fix)

`T-SP1-MIG-1` starts two real PostgreSQL migration runners against the same pending
migration. A short SQL sleep permits both pre-fix runners to read the old ledger.
Before the fix one runner failed with `pg_type_typname_nsp_index` uniqueness error.
See [RED log](sprint1/initial/migration-red.log). After the fix both succeed and
only one returns the applied migration; exactly one fact and ledger row exist.
See [focused GREEN log](sprint1/initial/migration-green.log).

Cause: ledger creation/applied-set read were outside any runner-wide lock. The fix
adds a session advisory lock on the dedicated migration connection **before ledger
creation/read**. It spans the existing per-file transactions; closing the connection
in finally releases it after success/failure. No shared SQL migration was rewritten.
Review lock scope/lifecycle; callers must not migrate as the application role.

### TLS URL handling in an existing isolation test (test fix)

The first full TLS source matrix produced 338 tests, 337 pass, 1 fail, 0 skip in
each timezone. `T-INT-SCOPE-1` used `/postgres$` replacement, which fails when the
admin URL ends with TLS query parameters. It queried the admin database and failed
with `relation "receipts" does not exist`. Replaced only that URL construction with
`new URL(...); pathname = ...`, preserving TLS parameters and the superuser role.
The isolation assertion was retained, not skipped or weakened.
All three original failure logs are retained in [initial evidence](sprint1/initial/).

## Reproducible environment

Executed on Debian13 as an unprivileged user, Node22.22.0, PostgreSQL16.15 built
with OpenSSL, npm pinned dependencies installed via `npm ci --ignore-scripts
--no-audit --no-fund`. The initial install command ran under Node24 and emitted an
engine warning; all backend builds/typechecks/tests here use the Node22 PATH.
No production dependencies or lockfile were changed. Docker/system installation
was unnecessary. Network-enabled sandbox commands use the configured proxy;
default sandbox commands could not reach it. No proxy bypass was used.
`doctor.ts` passed Node/PG checks; it disclosed that .nvmrc specifies 22.23.4
while this run uses 22.22.0. The package engine and doctor require the supported
22 major (>=22.18), which this runtime satisfies; exact .nvmrc patch parity is
not claimed. Root prototype tests also passed 7/7 under Node22.

Node provisioning: `npm --cache /workspace/npm-cache exec --yes
--package=node@22.22.0 -- node --version`. Put that installed Node22 binary on PATH.
The source distribution was fetched from
`https://ftp.postgresql.org/pub/source/v16.15/postgresql-16.15.tar.bz2` and checked
against the upstream HTTPS SHA256 file:
`c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed`.
Build: `./configure --prefix=/workspace/pg16 --without-readline --without-icu
--with-openssl`, `make -j8`, `make install`. Add its bin directory to PATH.
Requires gcc/make, OpenSSL headers/tool and zlib; no system or service config changed.
An upstream checksum fetched over HTTPS is not an independent signature audit.

From backend/:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
bash scripts/verify-integration.sh UTC 54321 /tmp/results/utc
bash scripts/verify-integration.sh Africa/Tunis 54322 /tmp/results/tunis
bash scripts/verify-integration.sh America/Toronto 54323 /tmp/results/toronto
```

The three cells were executed concurrently with distinct ports/clusters after one
build. The script does not rebuild dist during concurrent runs. Each cell creates
an ephemeral PG16 cluster with SCRAM authentication and TLS, supplies a fictional
test CA/certificate via `EZZ_TEST_TLS_ROOTCERT`, typechecks, runs full source and
compiled TAP suites, then both demonstration journeys. Cleanup stops/removes only
its mktemp-owned cluster; no scheduled/background agent is involved.

Full commands are in [the manual runner](../../backend/scripts/verify-integration.sh).
CI now includes the three timezones on the supported Node22 job. CI's ordinary
PG service still has no TLS certificate; local zero-skip TLS evidence is separate
from any CI skip and from the self-started `T-TLS-REAL` tests.

## Results and evidence

Results are filled from executed TAP logs, not historical CI reports. See the
committed `sprint1/final/` logs and `sprint1/results.json` for counts and log hashes.
The backend/test/workflow files at the executed code commit are unchanged by the
evidence commit, so the review head has the same executable tree. No claim that a
later documentation commit's SHA appeared in an earlier command is made.

Coverage includes TLS trust/hostname/no-plaintext failures and real encrypted API,
multi-clinic RLS/privilege/pool isolation, cash cutoff/count/business-value checks,
receipt/refund/void/payment idempotency, legacy-time and exception recurrence fixes,
concurrent migrations, PostgreSQL crash/recovery, and encrypted backup restoration
onto a fresh PG16 instance with receipt continuity/tenant and checkpoint checks.
Specific test outcomes are preserved in the TAP logs, including all skips/failures.

One attempted `npm run build` from repository root failed because only backend/
has that script; corrected working directory and backend build passed. This is
an invocation error, not suppressed backend evidence.

## Independent review handoff / remaining boundaries

Muse should review G5 composition, the migration session-lock fix/test, the TLS URL
test repair, and the combined cash/clinical/upload/restore behaviour at the exact
review head. Preserve pending G3 and integrated B07/B10/B15/M-261 policy/review gates;
executed tests do not resolve them automatically. No reviewer PASS is claimed.

Existing production gates remain: clinician authentication/recovery, OWNER finance
free-text/privacy and role policy, TLS verify-ca hostname weakness, actual external
owner-held checkpoints/PSP evidence, upload screening policy, receipt timezone
semantics (D-TZ decisions), hosting/clinical/fiscal/local CNAM validation. Scheduling
race and other product gaps are not silently fixed in this integration sprint.
Wholly unrecorded cash remains outside software detection.

## Final executed matrix

| Timezone | Source | Compiled | Skips | Journeys |
|---|---|---|---|---|
| UTC | 338/338 PASS | 338/338 PASS | 0 | Visit + dentist PASS |
| Africa/Tunis | 338/338 PASS | 338/338 PASS | 0 | Visit + dentist PASS |
| America/Toronto | 338/338 PASS | 338/338 PASS | 0 | Visit + dentist PASS |

All six runs include T-TLS-5 and T-TLS-REAL-1..4, T-DR-1..6, T-CP-7, T-CRASH-1 and T-SP1-MIG-1 without skips. Typecheck/build passed. Root prototype 7/7 and doctor Node/PG checks passed. The initial three failing source runs remain published alongside the corrected final runs. This is local executed evidence for the combined runtime tree, not inherited CI. Final remote CI status is tracked on PR42 and is not substituted for these results.
