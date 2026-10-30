# U012 booking concurrency — validated defect and surgical fix

Base main406c5dd1fd16dd543f2c0b9a3a601af33ae6568b. Approved direct founder delegation:
independent Codex backend worker; GPT retains UX12/13/14 and PR60/62. Claim/readback:
https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/61#issuecomment-6513672579 .
Read AGENTS.md, engineering standards and live V1_ACCEPTANCE_CURRENT row13:
U012 Booking — “R books day/week calendar; app warns of conflicting slots.”
Status PARTIAL/TESTED_SLICE; concurrency/chair acceptance OPEN. This PR does not
change that acceptance record or self-certify full U012 acceptance.

## Direct evidence

POST /visits validated dentist, SELECTed conflicting active intervals, then INSERTed
without serializing the empty-calendar case. Only scheduling writer found under
backend/src is this route. Existing browser overlap-warning/explicit-override tests
and dayboard tests do not establish concurrent acceptance safety.

A real PostgreSQL SHARE table-lock barrier holds INSERT while allowing overlap
SELECTs. Two real API calls must both reach database lock waits before release
(observed using pg_stat_activity, no probabilistic sleep to cause the race). On
unmodified main the test FAILS:201+201; both silently book the same dentist/interval.
The RED log retains actual fictional responses.

Fix: use existing transaction-scoped advisoryLock, keyed by clinic+dentist, before
the overlap query. Hold through the existing insert/audit/idempotency transaction.
The second request observes the committed first visit and returns409 with the
existing overlapping/retryWith shape. No new permission, schema, migration, endpoint,
frontend, financial behavior or clinical-author policy. Explicit allowOverlap:true
still permits a consciously accepted overlap; this is a warning gate, not an
absolute prohibition. Lock is across the dentist calendar rather than a date to
cover cross-midnight intervals. Future reschedule/resource writers must reuse the
same locking rule. Ordinary cancellations only remove conflicts; no reactivation
or reschedule path currently exists.

## Executed checks

Node22.22.0 and PostgreSQL16.15, fictional disposable databases only:

```sh
npm --prefix backend ci
export EZZ_TEST_ADMIN_URL=postgres://postgres:fictional-dev-superuser-pw@127.0.0.1:54316/postgres
npm --prefix backend run typecheck
cd backend
node --test test/u012-booking-concurrency.test.ts
npm test
npm run test:dist
```

Focused GREEN3/3, no skip/fail; strict backend typecheck PASS. Raw RED/GREEN and
full source/compiled logs committed in u012/. Full source354:353pass/0fail/1optionalTLSskip; compiled354:same. CI must be verified on the exact new head; previous
PR greens are not evidence for this change. No local browser test claimed.

Coverage: deterministic two-request race, one stored booking,409 evidence;
half-open adjacent slots; explicit overlap override; same-key replay; midnight
boundary; cancelled interval release; foreign patient404 and independent clinic.
Broader authorization, audit, finance, timezone and API-contract checks remain in
the unchanged full suites and GitHub CI.

## Chair acceptance and remaining gates

Physical chair/resource identifiers, capacity, assignment and chair conflict policy
are absent from the schema/API. Unassigned-dentist bookings remain permitted.
Different dentists are not assumed to represent different chairs. No chair capacity,
leave/closure policy or full day/week UI acceptance is claimed. Those need an
explicit approved backend contract/task and independent review; this patch does
not invent a chair model or silently add controls. Independent Muse review and
founder merge gate remain; fictional-only, no merge/deploy/production approval.

Four-hour recurrence remains disabled; native scheduler execution is not independently
confirmed. This run makes no scheduling changes. Subsequent Codex runs need a ranked,
approved, unassigned backend queue entry/delegation, which can use existing Mission
Control. No new unapproved tasks or queue items have been created.
