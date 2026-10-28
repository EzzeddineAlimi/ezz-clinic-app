# EZZ Clinic v0.2 — verified test results matrix

Status: produced by Claude Opus 5.5 on 2026-10-28 in an isolated sandbox (Node v22.23.4, PostgreSQL 16.15 local, fictional data only).
**A PASS here means the synthetic regression test passed on the persistent PostgreSQL build. It is NOT production-security or compliance evidence**, and GitHub CI has **not** been run on this code (UNVERIFIED in CI).

How to reproduce: see `backend/README.md` → `npm test` (80 tests, ~22 s). Raw TAP output of the run is summarised below; nothing is hand-edited except formatting.

## 1. Existing failing tests — v0.1 RED baseline (re-run independently)

`backend/scripts/v01-baseline-probe.mjs` re-ran GPT_SECURITY_BASELINE against the **unchanged v0.1 prototype** (repo root `src/server.mjs`). Raw output: `docs/testing/v01-baseline-results.json`. All 9 checks reproduced RED, matching GPT's 27 Oct observations:

| Baseline ID | v0.1 observed (2026-10-28 re-run) | v0.2 test that now covers it | v0.2 result |
|---|---|---|---|
| T-CARE-1 | HTTP 200; care confirmed with no login | T-CARE-1, T-CARE-2, T-CARE-4 | PASS |
| T-CARD-1 | HTTP 200; balance reduced 100,000 with no proof | T-CARD-1, M-249-E, T-CARD-3 | PASS |
| T-IDEM-1 | 2 payments, receipts #2 and #3 | T-IDEM-1, T-IDEM-CONC, T-IDEM-2/3 | PASS |
| T-CASH-1/3 | 2 anonymous counts accepted; expected leaked in /api/state | T-CASH-1, T-CASH-2/3, T-CASH-4 | PASS |
| T-ORG-1 (CH-019) | text/plain POST accepted (HTTP 200) | T-ORG-1..3 | PASS |
| T-PAPER-1 | 404 (not built) | T-PAPER-1..9 | PASS |
| T-STMT-1 | 404 (not built) | T-STMT-1..8, M-249-A..E | PASS |
| T-EVT-3 | 9 events before restart → 2 after | T-REC-1 (SIGKILL restart), T-EVT-3 (anchor) | PASS |
| T-RECEIPT | receipt #1 again after restart | T-REC-1, T-REC-CONC, T-TX-1 | PASS |

The 7 original v0.1 logic tests were not modified and still describe the v0.1 prototype only.

## 2. New passing tests — v0.2 persistent build (80 / 80 PASS)

| # | File | Test — exact expected result (asserted in code) | Actual (2026-10-28 run) | ms |
|---|---|---|---|---|
| 1 | `architecture.test.ts` | ARCH-1 module dependency graph matches the declared map (no hidden coupling, no cycles) | PASS | 3 |
| 2 | `architecture.test.ts` | ARCH-2 platform layer never imports a business module | PASS | 0 |
| 3 | `architecture.test.ts` | ARCH-3 money safety: no parseFloat / Math.round / toFixed on amounts in server code | PASS | 3 |
| 4 | `architecture.test.ts` | ARCH-4 SQL values are parameterised: no ${...} interpolation inside SQL strings except whitelisted identifiers | PASS | 1 |
| 5 | `architecture.test.ts` | ARCH-5 docs/security/permission-matrix.md is in sync with the code matrix | PASS | 27 |
| 6 | `c1-identity-care.test.ts` | T-CARE-1 unauthenticated care confirmation -> 401, visit stays unconfirmed | PASS | 939 |
| 7 | `c1-identity-care.test.ts` | T-CARE-2 receptionist session -> 403 and a rate-limited denial counter for the owner | PASS | 24 |
| 8 | `c1-identity-care.test.ts` | T-CARE-4 body-supplied identity is ignored: receptionist sending role DENTIST -> 403 | PASS | 7 |
| 9 | `c1-identity-care.test.ts` | T-CARE-3 dentist confirms; duplicate rejected; correction is a new linked row; original unchanged | PASS | 45 |
| 10 | `c1-identity-care.test.ts` | T-CARE-5 free care needs an explicit reason | PASS | 25 |
| 11 | `c1-identity-care.test.ts` | T-CARE-6 / T-ISO-1 cross-clinic: clinic B staff cannot see or act on clinic A records (404, no existence leak) | PASS | 20 |
| 12 | `c1-identity-care.test.ts` | T-ISO-2 database-level RLS: app role sees nothing without clinic context and only its clinic with it | PASS | 6 |
| 13 | `c1-identity-care.test.ts` | T-ISO-3 composite foreign keys block cross-clinic references even for the schema owner | PASS | 21 |
| 14 | `c1-identity-care.test.ts` | T-PRIV-1 receptionist cannot escalate: staff management and audit checkpoints are owner-only | PASS | 21 |
| 15 | `c1-identity-care.test.ts` | T-SESS-1 employee departure: deactivation revokes live sessions immediately | PASS | 241 |
| 16 | `c1-identity-care.test.ts` | T-SESS-2 lockout after 5 failures: correct password then refused (423) | PASS | 301 |
| 17 | `c1-identity-care.test.ts` | T-SESS-3 sensitive owner action requires recent re-authentication | PASS | 126 |
| 18 | `c1-identity-care.test.ts` | T-ORG-1..3 / CH-019 HTTP guards: text/plain 415, foreign Origin 403, foreign Host 421, bad JSON 400, big body 413 | PASS | 21 |
| 19 | `c1-identity-care.test.ts` | T-INPUT-1 hostile money and identifier inputs are rejected, never rounded | PASS | 154 |
| 20 | `c1-identity-care.test.ts` | T-VIS-2 desk cannot cancel or no-show a visit that has dentist-confirmed care | PASS | 7 |
| 21 | `c1-identity-care.test.ts` | T-PAT-1 patient contact change keeps old and new values in the audit chain | PASS | 20 |
| 22 | `c1-identity-care.test.ts` | T-IDEM-0 idempotency key is mandatory on writes | PASS | 19 |
| 23 | `c2-cash-count.test.ts` | T-CASH-1 BLIND: counter-visible responses before and at submission contain no expected total or cash amounts | PASS | 670 |
| 24 | `c2-cash-count.test.ts` | T-CASH-2/3 retries are stored; recount needs a reason; owner sees first and latest difference | PASS | 358 |
| 25 | `c2-cash-count.test.ts` | T-CASH-4 receptionist cannot submit a count (403) and cannot record drawer movements | PASS | 247 |
| 26 | `c2-cash-count.test.ts` | T-CASH-6 software independence flags: owner who took cash, or a person holding RECEPTIONIST, is NOT independent | PASS | 404 |
| 27 | `c2-cash-count.test.ts` | T-WIN-1 float + cash - owner-approved petty expense: expected 100,000; without float the old design showed a false +50,000 | PASS | 326 |
| 28 | `c2-cash-count.test.ts` | T-WIN-2 / T-CASH-5 two periods: counted carry-forward after owner handover; closed period cannot be recounted; late cash goes to next period | PASS | 393 |
| 29 | `c2-cash-count.test.ts` | T-WIN-3 / FRAUD-SCENARIO-70-CASH patient pays 70,000, desk records 100,000 and pockets 30,000 -> count differs by -30,000 (neutral wording) | PASS | 266 |
| 30 | `c2-cash-count.test.ts` | T-CASH-CONC count submitted while 8 cash payments are in flight: stored expected equals recomputed expected for its cut-off | PASS | 544 |
| 31 | `c2-cash-count.test.ts` | T-CASH-7 cash cannot be recorded with no open period; denominations must add up | PASS | 495 |
| 32 | `c3-card-evidence.test.ts` | T-CARD-1 desk card claim with no statement stays DESK_CLAIM; awaiting within lag, overdue after (T-STMT-5) | PASS | 723 |
| 33 | `c3-card-evidence.test.ts` | T-STMT-5b 10 claims settled on day 2 produce 0 exceptions (lag noise control) | PASS | 564 |
| 34 | `c3-card-evidence.test.ts` | T-STMT-1 edited file (inserted 150,000 line) vs owner-read terminal total 300,000 -> BLOCKED, 0 lines stored | PASS | 295 |
| 35 | `c3-card-evidence.test.ts` | M-249-A total typed from a DESK-HANDLED slip is NOT an independent check (forged slip + forged file never silent) | PASS | 315 |
| 36 | `c3-card-evidence.test.ts` | T-STMT-2 replay: same file twice or renamed -> 0 new lines; two genuine identical lines -> 2, never 4 | PASS | 321 |
| 37 | `c3-card-evidence.test.ts` | M-249-B inserted duplicate line + total from a compromised desk slip: imports, but flagged NOT independent and surfaces as an unmatched line | PASS | 343 |
| 38 | `c3-card-evidence.test.ts` | M-249-C overlapping statements import only the surplus; a re-issued statement lacking earlier lines is BLOCKED; force imports new lines and reports the missing one | PASS | 323 |
| 39 | `c3-card-evidence.test.ts` | M-249-D reversal lines never satisfy a claim and always need owner review | PASS | 321 |
| 40 | `c3-card-evidence.test.ts` | T-STMT-3 amount-only match is a CANDIDATE, never "matched"; two claims + one line = BOTH ambiguous, independent of claim order (M-249 consumption race) | PASS | 739 |
| 41 | `c3-card-evidence.test.ts` | M-249-E owner confirmation can NEVER promote to PROVIDER_VERIFIED (API, DB constraint and privileges) | PASS | 327 |
| 42 | `c3-card-evidence.test.ts` | T-STMT-4 desk role cannot import (403, nothing stored); owner needs fresh re-auth; import records actor + file hash + line count | PASS | 339 |
| 43 | `c3-card-evidence.test.ts` | T-STMT-6 stale import banner when the newest statement is older than 7 days | PASS | 288 |
| 44 | `c3-card-evidence.test.ts` | T-STMT-7 wrong account or out-of-period lines -> REJECTED_SCOPE, 0 lines; non-card lines discarded and never stored | PASS | 324 |
| 45 | `c3-card-evidence.test.ts` | T-STMT-8 privacy: statement lines store only date, amount, ref, last-4 (no description column exists) | PASS | 9 |
| 46 | `c3-card-evidence.test.ts` | T-CARD-3 pair test: cash relabelled as card -> drawer +100,000 over AND card claim overdue; neither signal alone separates the cases | PASS | 343 |
| 47 | `c4-payments-idempotency.test.ts` | FRAUD-SCENARIO-70 partial payment: fee 100,000; pay 70,000 cash -> receipt states 70,000 and balance 30,000 | PASS | 664 |
| 48 | `c4-payments-idempotency.test.ts` | T-IDEM-1 same key + same body twice -> ONE payment, ONE receipt; replay flagged | PASS | 49 |
| 49 | `c4-payments-idempotency.test.ts` | T-IDEM-2 same key + different body -> 409 IDEMPOTENCY_KEY_REUSED, nothing written | PASS | 51 |
| 50 | `c4-payments-idempotency.test.ts` | T-IDEM-3 different keys, identical amount within 2 minutes -> needs explicit confirmation | PASS | 40 |
| 51 | `c4-payments-idempotency.test.ts` | T-IDEM-CONC 10 parallel requests with the same key (network retry storm) -> exactly one payment and one receipt | PASS | 89 |
| 52 | `c4-payments-idempotency.test.ts` | T-RACE-1 two parallel different-key payments of 60,000 on a 100,000 balance -> one succeeds, one 409 | PASS | 32 |
| 53 | `c4-payments-idempotency.test.ts` | T-REC-CONC 20 parallel payments on 20 visits -> receipt numbers unique and contiguous | PASS | 454 |
| 54 | `c4-payments-idempotency.test.ts` | T-PAY-2 hostile payment inputs: zero, negative, float, string, over balance, no tender, no care | PASS | 68 |
| 55 | `c4-payments-idempotency.test.ts` | T-ADJ-1 receptionist cannot discount, refund or void; dentist discount works; owner refund needs credit | PASS | 157 |
| 56 | `c4-payments-idempotency.test.ts` | T-VOID-1 owner void: original payment and receipt preserved, VOID receipt numbered, cannot void twice | PASS | 91 |
| 57 | `c4-payments-idempotency.test.ts` | T-REPRINT-1 reprint is marked COPY and never consumes a number | PASS | 38 |
| 58 | `c4-payments-idempotency.test.ts` | T-MONEY-1 exact millime arithmetic: 3 x 33,333 + 1 = 100,000 with no float drift | PASS | 63 |
| 59 | `c5-durability-audit.test.ts` | T-REC-1 / T-EVT-3(restart) REAL process restart (SIGKILL): receipts continue at next number, events and sessions survive | PASS | 1484 |
| 60 | `c5-durability-audit.test.ts` | T-TX-1 transaction rollback mid-payment leaves no payment, no receipt number consumed, no audit, no idempotency record | PASS | 72 |
| 61 | `c5-durability-audit.test.ts` | T-EVT-4 least privilege: the API database role cannot UPDATE/DELETE/TRUNCATE evidence tables | PASS | 11 |
| 62 | `c5-durability-audit.test.ts` | T-EVT-5 append-only triggers block UPDATE/DELETE even for the schema owner role | PASS | 10 |
| 63 | `c5-durability-audit.test.ts` | T-EVT-2 superuser alters one stored event -> verify names the first bad sequence number | PASS | 21 |
| 64 | `c5-durability-audit.test.ts` | T-EVT-3 tail truncation is invisible without an anchor and detected WITH the owner-held checkpoint | PASS | 669 |
| 65 | `c5-durability-audit.test.ts` | T-MISS-1 integrity check detects a payment deleted around the app and a row inserted without an audit event | PASS | 565 |
| 66 | `c5-durability-audit.test.ts` | T-BKP-1 backup -> restore drill: restored copy verifies; restoring an OLDER backup is caught by a newer owner checkpoint | PASS | 762 |
| 67 | `c6-paper-outage.test.ts` | T-PAPER-1 import 12 slips once -> exactly 12 payments totalling 800,000; electronic R sequence unchanged | PASS | 1036 |
| 68 | `c6-paper-outage.test.ts` | T-PAPER-2 re-entering P-007 (same content, new request) -> 0 payments, total stays 800,000, 1 owner-review item | PASS | 19 |
| 69 | `c6-paper-outage.test.ts` | T-PAPER-3 conflict: P-007 re-keyed at 90,000 (was 150,000) -> both kept, neither overwrites, neutral wording | PASS | 24 |
| 70 | `c6-paper-outage.test.ts` | T-PAPER-5 void: recorded with reason, counts 0, stays in sequence; void with an amount is rejected | PASS | 21 |
| 71 | `c6-paper-outage.test.ts` | T-PAPER-4 sequence check: custodian declares P-014..P-020 unused except P-016 -> exactly 1 "not accounted for" | PASS | 30 |
| 72 | `c6-paper-outage.test.ts` | T-PAPER-7 out-of-range slip, unknown visit, and amount above balance are rejected per slip without blocking the batch | PASS | 36 |
| 73 | `c6-paper-outage.test.ts` | T-PAPER-8 paper and electronic identifiers stay distinct; paper card slip is still only a DESK_CLAIM | PASS | 16 |
| 74 | `c6-paper-outage.test.ts` | T-PAPER-6 persistence: after a REAL process restart, re-importing the whole drill again creates 0 payments | PASS | 717 |
| 75 | `c6-paper-outage.test.ts` | T-PAPER-9 book issuance: owner only, custodian must not be the desk, ranges cannot overlap | PASS | 18 |
| 76 | `c7-owner-exceptions.test.ts` | T-DASH-BLIND before any count the owner list holds no expected-cash figure (170000 never appears) | PASS | 792 |
| 77 | `c7-owner-exceptions.test.ts` | AC-DASH-1 synthetic day: count 150,000 vs expected 170,000 -> one -20,000 item; visit C unresolved; no receipt gaps; scope line present | PASS | 24 |
| 78 | `c7-owner-exceptions.test.ts` | T-RES-1 resolution is per item with a reason code; receptionist cannot resolve; resolved items leave the list but are counted | PASS | 73 |
| 79 | `c7-owner-exceptions.test.ts` | T-DASH-2 receptionist and dentist cannot read the owner exception list | PASS | 12 |
| 80 | `c7-owner-exceptions.test.ts` | T-DASH-3 desk-marked no-show surfaces as INFO for the owner | PASS | 25 |

## 3. Tests that could NOT run here (state honestly)

| Test / check | Why not run | What would be needed |
|---|---|---|
| GitHub Actions `backend-ci.yml` | The Claude GitHub connector returned **403** on branch creation; nothing was pushed by Claude | GPT (has write access) imports the git bundle, opens draft PRs; CI then runs on GitHub |
| Browser cross-origin exploit (C-139 T-ORG-5) | No browser test harness authorised; server-side guards only | Playwright page on a second origin posting text/plain |
| 4-hour / 20-visit outage drill paper vs local-SQLite (C-141, CH-010) | Needs a timed human-in-the-loop drill and a SQLite prototype | Fictional drill script + timing sheet |
| Chairside dentist authentication usability (gloves, shared PC) | Requires real users / hardware | Founder-approved usability session with fictional data |
| TLS / network deployment tests | In-repo driver has no TLS; no hosting chosen (legal blocker CH-004/006) | Swap to `pg` driver with TLS (ENG-01) + hosting decision |
| Load / performance tests beyond 20 parallel requests | Out of sprint scope | k6/autocannon run against a seeded fictional clinic |
| Restore of a backup taken on a different PostgreSQL major version | Only PG16 available | Matrix CI job |

## 4. Production risks that remain UNRESOLVED (a PASS does not close these)

1. **CH-002 — wholly unrecorded cash** remains undetectable by any software control; only non-desk roots (dentist record, patient-held receipt, owner count, PSP/bank) can expose it.
2. **Physical independence of the cash count** is not provable by software (counter role + "did not take cash" is a software check only).
3. **Owner-device sharing**: re-auth + 5-min window + actor log are mitigations, not proof (M-248/M-249).
4. **PROVIDER_VERIFIED card evidence is unreachable**: no authenticated Tunisian PSP/bank source has been verified (CH-022).
5. **Superuser rewrite of the whole audit chain** is detectable only against an owner checkpoint kept outside the database and only for changes before the newest checkpoint.
6. **Demo identity**: passwords are logic-test scaffolding; chairside identity, MFA and owner recovery procedure are not designed for production.
7. **In-repo PostgreSQL driver** (no TLS, small surface, not battle-tested) — must be replaced by `pg` before any networked deployment (ENG-01).
8. **Legal**: hosting/transfer (Law 2004-63 Art. 22, 50-52, 62-63), fee-note / e-invoicing format, receipt legal validity, delegated cash collection — all UNVERIFIED (see docs/operations/privacy-compliance-and-operational-risk.md).
9. **Lockfile** was generated offline without integrity hashes; regenerate online (ENG-02).
