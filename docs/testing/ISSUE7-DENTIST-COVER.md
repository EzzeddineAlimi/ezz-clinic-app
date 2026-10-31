# Issue #7 — same-clinic dentist cover regression

Fictional-data-only backend acceptance slice, 2026-10-31. This closes a specific automated coverage gap; it does **not** close issue #7, approve clinical terminology or authorize production.

## Scope and authority

- [Issue #7 scope clarification](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/7#issuecomment-6539802769) requests a dedicated two-dentist positive/negative PostgreSQL test. The [earlier policy/test request](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/7#issuecomment-6511862176) and [founder authorship decision](../decisions/clinical-authorship.md) supply the intended behavior.
- [Attributable claim/readback](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/7#issuecomment-6540011986): reporting label `CX-ISSUE7-COVER-20261031T0623`; native run ID **NOT_EXPOSED**, **COST_UNKNOWN**. The label is not a native execution ID. Deterministic new branch `codex/issue7-dentist-cover` was absent before creation; claim comments alone are not atomic exclusivity. No conflicting claim or open PR covered this slice at preflight.
- Verified base/main: `25708be843e0479c27d2d23e95e1594a50f30d6e`. The branch is standalone against main, not a fourth dependent-stack child. No other worker branch is changed.
- Reviewed actual routes/contracts: `src/modules/{clinical,care,medical}.ts`, `docs/api/{api-v1.md,endpoints.md,openapi.json}` and the clinical-domain contract. Existing runtime already permits same-clinic cover and uses the authenticated actor. **No runtime defect reproduced; no runtime, schema, API, permission, UI or dependency change.**

## New real-API PostgreSQL coverage

`backend/test/clinical-dentist-cover.test.ts` starts the real application with the least-privilege app role and a disposable migrated database, two independently logged-in same-clinic dentists, a receptionist, assistant and foreign-clinic dentist.

| Test | Observable acceptance |
|---|---|
| COVER-1 | Appointment assigned to dentist A; dentist B writes note, finding and 30,001-millime care. Forged A author fields cannot override B. Persisted note/finding/care and their audit events attribute B. Same-key note/care retries reuse originals. A appends an independently attributed addendum; B's original remains unchanged and hash-valid. Appointment remains assigned to A. App-role signer UPDATE is denied. |
| COVER-2 | Encounter read and each note/finding/care POST: anonymous 401, same-clinic receptionist/assistant 403, foreign dentist 404. All three clinical tables remain empty for the denied visit. |
| COVER-3 | B's cover does not bypass active medical alerts: unacknowledged care returns 409 `MEDICAL_ALERTS_NOT_ACKNOWLEDGED`, leaves no care, then succeeds with the current viewed alert-set hash and B attribution. |

This supplements existing general encounter/role/tenant tests; it is not a new chair-capacity, clinical consent, payment or regulatory feature.

## Reproduction

Use Node 22.18+ (supported major 22), PostgreSQL 16 and a **disposable fictional** test administrator database. The helper creates isolated databases and non-superuser `ezz_owner` / `ezz_app` roles. PostgreSQL client/server binaries must be on PATH for the existing backup/restore suite. Do not point these commands at production.

```bash
cd backend
npm ci --ignore-scripts
# Set EZZ_TEST_ADMIN_URL to your disposable test server, including its test-only password.
export TZ=UTC
node --test --test-timeout=60000 test/clinical-dentist-cover.test.ts
npm run typecheck
npm test
npm run test:dist
```

Local execution used Node **22.22.0**, PostgreSQL **16.15**, `127.0.0.1:54316`, UTC; inherited managed-environment network proxy. No real patients, services or production configuration.

## Evidence classification

| Evidence | Actual outcome |
|---|---|
| Local pinned dependency install | PASS, `npm ci --ignore-scripts` exit 0, 18 packages |
| Local focused source | PASS, 3/3, 0 failures/skips |
| Local strict typecheck | PASS, exit 0 |
| Local full source | PASS, exit 0: 371 tests / 370 pass / 0 fail / 1 optional real-TLS skip; 107.229s |
| Local full compiled/build | PASS, exit 0: 371 tests / 370 pass / 0 fail / 1 optional real-TLS skip; 101.618s |
| Exact new-head GitHub CI | Separate from local results; see PR for the exact SHA/run URLs and pending/completed status. Earlier main/PR63/PR100 green runs do not test this addition. |
| Lint/format | NOT CONFIGURED in repository manifests; not reported as passing |
| Local TLS | Full source and compiled suites each PASS `T-TLS-REAL-1..4`: real disposable PG16 TLS connection, unrelated-CA rejection, hostname mismatch, and whole-API encrypted connections. Separate optional `T-TLS-5` remains skipped because `EZZ_TEST_TLS_ROOTCERT` is not set. These are distinct tests. |
| Local browser/UI and complete local timezone matrix | NOT RUN for this test/document-only slice; no UI/screenshots changed. CI timezone jobs are observed evidence only when complete at the exact new head. |

### Failures investigated, not concealed as a product RED

1. First local attempt omitted the existing disposable database's password: before-hook failed with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`; teardown then lacked an initialized API. The stalled test process was terminated. Corrected only the command's test URL from the already documented fictional local credentials; no database/server settings changed.
2. First authenticated run: **0 pass / 3 fail** due to test assumptions. The response legitimately adds documented `replayed: true`, and reused fictional names correctly triggered patient duplicate confirmation. Compared replayed clinical objects plus the replay marker, and gave each fixture a distinct fictional name. Subsequent focused run **3 pass / 0 fail**. No security control was weakened and no product fix is claimed from these failures.

## Oldest-first queue and remaining gates

- At preflight all **20** open PRs were read in original creation order. Oldest owned backend #63 remains draft at `ddda4914b9c8a1c1244c83f0a92ab4e7d3607180`, exact-head checks successful, actual independent Muse carry-forward `MUSE-UX-63-NEWHEAD-DDDDA4914`; founder high-risk booking merge gate remains. [Prior executed current-main RED / exact-head GREEN and raw logs](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/63#issuecomment-6538280641) were **not rerun or relabeled as this run**. Main's backend tree is unchanged since that baseline `bbb3298`.
- GPT-owned #100 at preflight `c54306f94edfc6865299a79b03fb6e00e88b8c1b` already carries U012 (source lock inspected), but is unmerged. Exact-head checks now successful; independent current-head review/UX/founder gates remain. Never close #63 or claim U012/chair acceptance from an unmerged candidate.
- Seventeen-PR UX chain root #60 was older than 24h and exceeds the three-open-dependent-PR guard. This independent test slice does not extend that chain. #63 was about 27.5h old, below the standalone-backend 48h flag. Existing branches, main and schedules preserved.
- CNAM issue #67's first slice is already merged via #77; not selected again. #5 awaits independent acceptance, #6 actual staff/owner exercise timing, #68 admin enforcement, #69 evidence coordination, #72 production/security scope/decisions, #74 cross-frontend/backend tooling ownership. None is silently claimed as a follow-on implementation.
- Independent Muse review of this addition remains required; authors cannot self-approve. Issue #7 still has clinical terminology, imaging/prescription/consent and Tunisian regulatory validation gates. No official eligibility, tariffs or clinical/legal readiness claims.

## Local result manifest

Both full suites completed successfully before commit. The unchanged test/runtime files in the tested worktree are committed with this report. UTC source and compiled summary, each:

```text
1..371
# tests 371
# suites 0
# pass 370
# fail 0
# cancelled 0
# skipped 1
# todo 0
```

Skip: `T-TLS-5` — `EZZ_TEST_TLS_ROOTCERT not set (CI service container runs without TLS)`. This optional-test skip does not negate the four independently provisioned `T-TLS-REAL-1..4` tests, which each passed in both full suites. The new COVER tests all pass with no skip in both modes.

Evidence correction: the first documentation commit incorrectly grouped all local real TLS as NOT RUN. Reading the full source/compiled TAP and CI logs established the four passing real-TLS tests above. Only this evidence document changed in the correction; test/runtime blobs and their recorded local results are unchanged.

SHA-256 provenance (local transcripts are temporary build output; durable results and commands are above, exact-head CI logs are linked in the PR):

| Input/output | SHA-256 |
|---|---|
| New test source | `c8468114000119711843fb0aae5cb42d65f5ac2a85bcce9118dc4daef293d88a` |
| Focused source TAP | `329b15ba5a07a9b4faca76b262d723bf3d367be915424c486c05b8c7ad1b0b85` |
| Typecheck transcript | `b70cc478037f16b067eb02beb39536f37f7506baccae7caa3dd07db5d8c8e042` |
| Full source TAP | `85061684a8e73a93434430c1eef30c654d3fa35c803f213c0ceb0f46193e9ef0` |
| Full compiled TAP | `ef97145a5fc4678f302d424376f1608624b142a41bdf75e54feba75529672201` |

No bulky generated TAP files are committed. Screenshots are not applicable: no frontend or rendered UI changed. Frontend/API handoff: existing endpoints and payloads remain unchanged; client-supplied author identity is never authoritative.
