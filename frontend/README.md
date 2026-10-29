# EZZ Clinic web application — Sprint 2

Working React + TypeScript + Vite interface backed by the existing Node/PostgreSQL
application. **Fictional development data only.** No deployment or clinical/legal
production approval. Base: main `28520b8c627f74741f368a7de98f4962ad9e28d5` (merged #42).

## Run locally

Requirements: supported Node22 (>=22.18), npm, PostgreSQL16 server/client binaries
on PATH, and a free 4180/5173. No Docker required. On this workspace the binaries
are `/workspace/pg16/bin` and Node22 is the previously provisioned runtime; ordinary
PG16 installations can use `/usr/lib/postgresql/16/bin`.

From repository root:

```sh
npm --prefix backend ci --ignore-scripts --no-audit --no-fund
npm --prefix frontend ci --ignore-scripts --no-audit --no-fund
```

Start the disposable PG16 development cluster (unprivileged user):

```sh
cd backend
bash scripts/dev-pg16.sh start
# Export the EZZ_TEST_ADMIN_URL printed by the command, for example:
export EZZ_TEST_ADMIN_URL=postgres://postgres:fictional-dev-superuser-pw@127.0.0.1:54316/postgres
node scripts/dev-web.ts
```

The bootstrap applies the real checksummed migrations to a new disposable database,
creates named fictional staff, and seeds five patients/appointments **through the
real API**. API requests use the least-privilege application role. The administrative
URL is used only for test database/bootstrap lifecycle, never in frontend code.
Ctrl-C stops the API, closes the app pool and drops its disposable database. A
second fictional clinic is seeded only to test tenant separation.

In another terminal, from repository root:

```sh
npm --prefix frontend run dev
```

Open **http://127.0.0.1:5173** (the configured local browser origin). Sign in with:

- Clinic: `web-fictional`
- Personal account: `desk`, `dentist`, `owner` or `assistant`
- Fictional password: `fictional-pass-123`

Use your own named role; the assistant account is read-only. Patient phone is
optional. Receptionists can search/register, schedule, and record arrivals. There
are no simulated API successes, payment controls or unfinished navigation links.

To inspect the production bundle locally, stop Vite dev, then run:

```sh
npm --prefix frontend run build
npm --prefix frontend run preview
```

Preview includes the same-origin local API proxy and strict script CSP. The dev
server allows inline refresh preamble only for development HMR. Production hosting
and TLS/security-header configuration remain separate, unauthorised deployment work.
The Vite proxy's backend target is loopback 4180; no secret environment values are
included in the bundle. Do not expose this fictional fixture server publicly.

## Automated checks

Stop manually running 4180/5173 servers; keep PG16 running and export the same
EZZ_TEST_ADMIN_URL in the test terminal. Chromium is selected at `/usr/bin/chromium`
when available, otherwise install Playwright's pinned browser:

```sh
cd frontend
npm exec playwright install chromium
npm test
npm run build
npm run test:e2e
```

`test:e2e` starts **both** a fresh real clinic API and the built application preview;
it does not mock successful API responses. Browser tests run serially in isolated
browser contexts against the shared disposable fictional database. Controlled
network failure tests abort/delay transport; the lost-response test first commits
through the real API, then checks the exact-key replay creates only one patient.
Both servers and the fixture database stop after execution. Browser screenshots
are generated in `docs/images/sprint2/`, JSON evidence in `docs/testing/sprint2/`.
Do not use real patient data in these paths or a public repository.

The CI workflow `.github/workflows/frontend-ci.yml` installs PG16, both locked npm
projects, the pinned Playwright browser and executes the same real-API tests.
Local execution results are separate from subsequent CI evidence.

## Security and contract behaviour

- Token/session/patient/form state lives only in memory. No localStorage,
  sessionStorage, cookies, service worker or persistent clinical cache. Reload
  requires staff login again; locally discarded tokens expire on the server.
- Login is followed by GET/session. Role union selects available actions; the
  server remains authoritative. 401 removes the entire workspace/data; 403 is
  displayed and never bypassed. A role downgrade while the session is open is
  covered by a real-server browser test. Logout revokes server session, with an
  honest local-only warning if its network response is unconfirmed.
- Explicit typed endpoint wrappers and Zod response validation follow the existing
  OpenAPI/examples. Contract tests check every consumed route exists. No proposed
  clinical endpoints were used. Existing backend source/migrations were untouched.
- Every write intent owns one UUID key. A lost/invalid success response freezes
  the original body and key; retry is explicit. Unknown results never become saved
  confirmations. Closing an uncertain form warns to reconcile before starting over.
- Possible duplicate patients show returned file numbers and require an explicit
  human decision. Appointment overlaps require explicit confirmation; never auto-set
  either override flag. No appointment concurrency rule was changed in this slice.
- Day and timezone originate from the backend board. Local wall time is converted
  in that clinic zone, not the device zone. DST gaps/folds are refused for manual
  correction; no guessed instant. Financial response schemas accept integer
  millimes only; this slice does not calculate balances or collect payments.
- FR/AR root direction, CSS logical properties, bidi-isolated patient/file/time
  text, keyboard dialog containment/Escape/focus restoration, high-contrast errors,
  responsive 320px reflow and semantic controls are implemented. Automated axe
  coverage is bounded and is not a blanket accessibility or native-language claim.

## Current API limits and next slice

The receptionist cannot call GET/staff (OWNER only). Scheduling therefore offers
unassigned visits and dentists already visible on the loaded day's board; it does
not invent a practitioner directory or broaden permissions. The server searches
primary family/given name prefixes, exact file number or exact phone, up to 50
results; the optional extra `nameAr` field is not searched. Arabic primary names
remain valid input, and both names display with bidi isolation. UI language is
session-local rather than a server-saved per-user preference in this slice.

No detailed clinical information is fetched here. The next slice adds the dentist
encounter/odontogram workflow, then checkout/payment/receipt and owner review
against their actual contracts. Production auth/recovery, clinical/legal/privacy,
receipt timezone and CNAM validation gates remain unchanged.

[Actual screenshots and executed evidence](../docs/testing/SPRINT2-FRONTEND.md)
