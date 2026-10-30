# Sprint 4 backend evidence

Base main: `8024d54195cf2aa3ac961071f95ee8069c867ac0`; isolated branch
`codex/sprint4-payment-recovery`. No merges, deployment, production setting changes,
real patient data or modifications to other branches.

## Council/source readback

Read current source, billing/identity HTTP idempotency/transactions, migration and
contract generator, receipt/print code, existing financial, architecture, API and
Sprint3B tests. Read Mission Control MODEL_INBOX row289 M-278 in full: crash/reload
memory-only intent gap, missing receipt IDs, mixed print/reprint counter residual,
and preserved financial/authorship/tenant boundaries. G-83 was not locatable in
the accessible COMMAND, MODEL_INBOX, SUBMISSIONS, DECISIONS and TECH_STACK_COUNCIL
ranges; no claim to have read unavailable guidance. Founder assignment provides
implementation authority. M-278 is inherited peer evidence, not new peer approval.

## Implemented/reused

- Reused `recordPayment`, visit locks, integer validators, transactional receipt
  counter, audit chain, RLS and existing payment/print permissions.
- One migration with append-only tenant intentions and terminal outcome records;
  canonical ledger-version and exact prior-payment acknowledgement gate new work.
- Pending intentions exclude all shared competing payment writes. Terminal result
  replays across keys/sessions/staff with the same payment/receipt. Cancellation
  never edits money. Inconsistent multiple pending rows fail closed.
- Payment history now links existing server receipt IDs and series.
- Shared print/reprint locking, correct mixed copy sequence and explicit UNKNOWN
  physical delivery. No rewrite of historical print records or receipt numbering.
- New API examples captured from real fictional API calls; generated OpenAPI and
  endpoint table retained. No weakened contract assertions or test exclusions.

Full [frontend API handoff](../api/PAYMENT-RECOVERY.md) includes exact calls,
response states, errors, migration/rollout and legacy-client limitations.
**Frontend adoption remains required; existing checkout was not changed here.**

## Reproduction

Node22.22.0, PostgreSQL16.15, Linux Chromium. Disposable PG16 only:

```sh
npm --prefix backend ci
npm --prefix frontend ci
export EZZ_TEST_ADMIN_URL=postgres://postgres:fictional-dev-superuser-pw@127.0.0.1:54316/postgres
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend run test:dist
npm --prefix frontend test
npm --prefix frontend run test:e2e
```

Use backend/scripts/dev-pg16.sh for a disposable server if needed; never point this
harness at an actual clinic. Existing readiness/migration checks remain authoritative.

## Executed evidence classifications

Local focused regression:10/10 new PostgreSQL recovery/print tests PASS;38/38
combined focused architecture/API/print/Sprint3B/recovery tests PASS before adding
the two final SIGKILL/ambiguity regressions. Frontend9/9 and real-API Playwright21/21
PASS, zero skip/flaky; no UI implementation change. Full source suite350 tests:
349 PASS,0 fail,1 existing optional realTLS skip (EZZ_TEST_TLS_ROOTCERT unset).
Full compiled suite also350 tests:349 PASS,0 fail,1 identical optional TLS skip.
Final-head CI is recorded separately with the published PR handoff.
Do not infer real TLS verification from a skipped test.

Raw logs and browser JSON are committed under [sprint4](sprint4/). CI is observed
from GitHub at the final pushed head, separately from these local executions.

Tests cover six concurrent new-key record calls -> one payment; five prepare calls
-> one pending intention; stale version, missing prior-payment acknowledgement,
changed payload, cancellation/retry and care/fee ledger changes; assistant403,
foreign clinic404, unauthenticated401, actual recorder attribution; immutable DB
permissions; receipt links/numbering; mixed concurrent print/reprint sequencing and
same-key print replay. A real API process is SIGKILLed after discarding a committed
response; a new process/login recovers the committed intention without the key.
A separate PostgreSQL trigger fault before outcome insertion proves rollback of
payment, receipt counter, audit and HTTP idempotency; same-key retry later commits
receipt1. This is fault injection and process restart, not a power-loss/PITR claim.

## Direct failures and fixes

- Initial two RED tests: recovery endpoint missing404; /reprint after original
  returned copyNo2 instead of1. Logs retained. Implemented durable protocol and
  reproduced/fixed the counter cause using a shared lock and actual copy count.
- First combined run36/38: one-character assistant fixture username violated the
  existing constraint; corrected the fixture, not the constraint. Contract coverage
  correctly refused four routes without recorded examples; captured real examples
  and regenerated contracts, retaining the every-route example gate. Green38/38.
- Existing nonblocking Zod annotations / NO_COLOR warnings remain in browser logs.

## Remaining risks

Frontend must adopt recovery-on-open/reconnect/login before claiming crash recovery
for the application. Legacy new-key writes without durable intentions retain their
old limitations. Payment intentions do not prove physical transfer; reviewed new
payments can be legitimate duplicates. Browser/OS printer delivery remains UNKNOWN.
Existing receipt timezone/native-language/fiscal/privacy/clinical/legal/CNAM and
independent Muse review gates remain; no production-ready or theft-impossibility claim.
Recovery GET currently returns visit-scoped intent history without pagination;
this first slice has no clinic-wide queue or expiry worker. No scheduled tasks added.
