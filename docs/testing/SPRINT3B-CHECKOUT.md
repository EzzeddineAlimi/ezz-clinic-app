# Sprint 3B — receptionist checkout (#47)

## Verified dependency and scope

Started from main `d3e122ecbd239f358d204edde0cdc18dbeaab50c` (merged #43).
PR #46 remains an independent draft at `2ae378e76d2b252b6018ddd9b5f8bc63e97da4d8`.
Its seven-file care-confirmation diff, API contract and test were inspected. This
PR targets **main**: checkout requires the already-merged care/billing APIs, not
an unmerged frontend. No changes to #46 or other existing branches. Reconcile
additive API/page changes when #46 is separately integrated; share decimal money
parsing then, preserving its explicit zero-fee reason rule (payments require >0).

Sources: issue #47; docs/api/endpoints.md and openapi.json; backend modules
billing.ts (visit lock, balance, immutable snapshots, atomic receipts), cash.ts
(owner opening/count periods), print.ts (audited original/copy contracts),
care.ts (dentist-authenticated authorship), frontend existing API/error/modal rules.

## Delivered behavior

- Completed-visit checkout from the existing agenda, identity/file number visible.
- Typed server balance, confirmed charges and payment history; no local recomputation
  of payable balance. Exact decimal TND -> bounded positive integer millimes.
- Explicit cash/card choice, no default. Both are desk records, never independent
  evidence of physical cash or statement reconciliation.
- An immutable payment body/key from first submission; synchronous double-submit
  guard. No automatic retry. Unknown transport, malformed success or server5xx
  locks the fields and close control. Reconciliation refresh reads server history;
  manual retry preserves key/body even if the refreshed balance has decreased.
- Confirmed rejections allow an explicitly new intention. For a second
  genuine identical payment within 120 seconds, the receptionist must inspect
  server history, start a NEW intent with a NEW idempotency key, and explicitly
  confirm it really is another payment. This sends confirmDuplicate=true only
  on that new frozen request. Unknown outcomes NEVER trigger this override.
  No overpayment,
  refund, discount, void, clinical authorship or cash-period administration UI.
- Receipt read from server using the returned ID, with immutable partial-payment
  balance-after and original server label. Read failure never resubmits a payment.
- Print preparations use existing POST /receipts/:id/print: audited original/copy
  marks, same receipt reference, FR/AR server document sections and disclaimer.
  Rendering uses React text nodes, not server HTML injection. Each subsequent
  preparation gets a new print key; an uncertain preparation retains its key/lang.
  Print button clears prepared document after invocation; another preparation is
  required for another app print. Print preparation is not proof paper emerged.
- Existing session-expiry unmount removes checkout state; resource reload masks
  prior financial data on read denial/error. Financial writes remain server gated.
- French/Arabic, native dialog keyboard trap, 320px RTL checks, print CSS.
- Disposable fixture now includes dentist-confirmed Nour Ayadi care (100.000 TND)
  and owner-opened cash period, each via separately authenticated real API calls.
  Other fictional clinic has no period to exercise the blocked state.

No production backend source, permissions, schema or migration changes.

## Reproduce locally (fictional data only)

Use Node22.22+ within existing >=22.18 <23 engines, PostgreSQL16, Chromium.
Follow frontend/README.md for installation and disposable PG16 setup, then:

```sh
npm --prefix backend ci
npm --prefix frontend ci
# Point at a disposable PG16 superuser database; never a clinic database.
export EZZ_TEST_ADMIN_URL=postgres://postgres:fictional-dev-superuser-pw@127.0.0.1:54316/postgres
node backend/scripts/dev-web.ts
# In another terminal:
npm --prefix frontend run dev
```

Clinic `web-fictional`; user `desk`; password `fictional-pass-123`. Open
**Nour Ayadi → Encaissement**. Record e.g.30.000 cash, read the server receipt,
prepare print, close/reopen checkout and record70.000 card. All fictional only.
Stopping the fixture drops its database. Do not use these credentials for any
real installation. No deployment or production-readiness assertion.

## Executed evidence

Local Node22.22.0, PostgreSQL16.15, real API and installed Chromium:

| Command (repository root unless specified) | Result |
|---|---|
| npm --prefix backend run typecheck | PASS |
| npm --prefix frontend test | 9/9 PASS, zero skipped |
| npm --prefix frontend run build | strict TS + Vite PASS |
| from backend: node --test --test-concurrency=1 test/s3b-checkout.test.ts test/b10-cash-period-evidence.test.ts test/b15-printable-contracts.test.ts test/r73-api-contract.test.ts | 30/30 PASS, zero skipped |
| npm --prefix frontend run test:e2e | 17/17 PASS, zero skipped/flaky |

Raw command logs and machine-readable browser results: [sprint3b](sprint3b/).
The real-API tests assert role403, cross-clinic404, changed-payload same-key409,
similar payment rejection, overpayment rejection, partial/full balance, unchanged
receipt snapshot across original/copy preparation, and no extra financial rows.
Closed-only cash recovery state uses a documented disposable DB fixture after
real owner count/close, removing its automatically opened next period; no
application permission was changed to manufacture this scenario.

Browser tests create real care with a dentist token, commit cash then drop the
response, refresh history, retry the identical body/key, and assert one payment.
They also test post-commit503, duplicate UI rejection, exact final zero balance,
print copy numbering, no-period UI, assistant UI/real authorization, malformed401
checkout removal, Arabic320px focus/width and selected axe rules (zero violations).
Successes are real API writes; only failure transport/status injection is mocked.

### Failures investigated

- Initial replay assertion compared whole bodies, missing the documented
  `replayed:true` addition. Corrected to assert flag and stable payment/receipt;
  no backend fix was needed. Initial failure log retained.
- First browser test used an incorrect close accessible name. Direct DOM evidence
  showed `Fermer le formulaire`; corrected test, no UI change for that issue.
- Arabic button regression: reading document.lang during render lagged React's
  language effect. Reproduced in browser, fixed with the existing Words contract;
  retained language RED log, final passing Arabic regression.
- Initial relevant-test invocation misspelled the print-test filename. Final
  published 30-test command above uses its actual name; no missing test is counted.
- Nonblocking existing Zod annotation and NO_COLOR/FORCE_COLOR warnings retained.

## Screenshots

Real Chromium capture of disposable fictional data:

![French partial payment and numbered receipt](../images/sprint3b/checkout-fr.png)
![Arabic mobile settled checkout](../images/sprint3b/checkout-ar-mobile.png)

## Remaining review / release risks

- Independent Muse review at final head; native Arabic/fiscal wording and broader
  accessibility validation remain external. Selected axe rules are not certification.
- Intent survives only while this dialog/session is alive; refresh, browser crash
  or authentication expiry loses its memory key. Reconcile server history before
  any new intent after interruption. No persistent PHI/outbox was introduced.
- Payment history exposes receiptNumber but not receipt ID. This slice opens the
  receipt returned by the active payment; historical receipt navigation after a
  reload needs an approved API projection or separate lookup, not guessed IDs.
- History shows recorded payment amounts, not owner adjustment review. Server
  balance includes reductions/returns; refund/void/owner review remain other slices.
- A second legitimate identical cash or card payment can be confirmed only
  after a server duplicate rejection, explicit new intent, visible payment
  history review and staff acknowledgement. This DOES NOT independently verify
  that physical money or card settlement occurred; overpayment and role checks
  remain server enforced. The acknowledgement is never automatic.
- Browser print cancellation/repeated native print commands cannot establish paper
  delivery. Backend snapshot/print audit remains authoritative for preparation.
- No full backend local matrix/TLS execution claimed here. Exact-head CI outcomes
  must be read from this PR, separately from local evidence. Existing nonTLS CI
  optional TLS skip and all production auth/privacy/fiscal/legal gates remain.
- No merge, deployment, real patients/payments, PSP, tariff/CNAM changes.

## Muse M-276 F1/F2/F3 correction candidate (draft, not production evidence)

Following independent Muse review at PR49 `999ea54a`, this **separate**
candidate addresses three blocked but fail-closed UI workflows. The assertions
below are implementation intent, not passing CI claims until that candidate
head is explicitly verified:

- F1: dentist reads the full role-restricted current active medical-alert
  revisions and visible details, acknowledges them in the existing care modal,
  and sends exactly the server-provided alertSetHash. Backend rechecks the hash
  in the locked transaction; changed data is not accepted silently.
- F2: the server's CARE_ALREADY_CONFIRMED denial exposes an explicit
  second-performed-act checkbox, and any changed payload uses a NEW idempotency
  key. Corrections are NOT represented as another performed act.
- F3: the server's POSSIBLE_DUPLICATE_PAYMENT denial exposes a checked-history
  second-payment override; it is NEVER used for uncertain network/5xx writes.
  Changed intent body must have a different key. The server retains final
  financial, receipt and role authority.
- Browser tests `frontend/e2e/muse-fixes.spec.ts` target F1/F2/F3 against
  disposable PostgreSQL 16 and fictional data. No clinical, fiscal or legal
  certification is inferred.

A failed or skipped test stays a failure/skip, not an acceptance. Muse must
independently review the *new* exact head and all inherited safety boundaries.
