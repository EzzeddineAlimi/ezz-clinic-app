# EZZ Clinic

**A dental-clinic management application for private practices in Tunisia.**

EZZ Clinic brings patient registration, appointments, dentist-authored care, payments, receipts and owner financial oversight together in one system. The design prioritizes a simple reception workflow, French/Arabic accessibility, and independent evidence for cash handling.

> [!IMPORTANT]
> **Development build — fictional data only. Not for clinical use, fiscal issuance or production deployment.** EZZ Clinic is not approved to store real patient records, process real payments or produce legally valid fiscal documents. Software cannot detect cash that is never recorded, and it cannot guarantee zero theft.

## Current build

| Area | Implementation status |
| --- | --- |
| **Backend** | TypeScript / Node.js 22 / PostgreSQL 16 modular monolith integrated into `main` through [PR #42](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/42). |
| **Web application** | React, TypeScript and Vite receptionist slice merged in [PR #43](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/43). Additional receptionist UX changes are in [draft PRs](https://github.com/EzzeddineAlimi/ezz-clinic-app/pulls), not in main. |
| **Receptionist workflow** | Real staff login, patient search and registration, daily clinic agenda, appointment scheduling and arrival recording; frontend connects to real API and fictional PostgreSQL records. |
| **Languages** | French and Arabic with responsive right-to-left (RTL) layouts in the receptionist slice. |
| **Other backend capabilities** | Server-enforced roles and clinic isolation, authenticated dentist care, payments, receipts, cash-period evidence, owner review, paper recovery and audit checks — **not yet all exposed in the web UI**. |
| **Release** | Not deployed and not production-approved; clinical, security, Tunisian legal/fiscal/privacy and CNAM gates remain open. |

### Screenshots of the working receptionist app

Captured in Chromium against a migrated database populated with fictional test records, not AI-generated concepts.

**French desktop agenda**

![EZZ Clinic French receptionist agenda, fictional data](docs/images/sprint2/agenda-fr-desktop.png)

**Arabic mobile agenda**

![EZZ Clinic Arabic right-to-left mobile agenda, fictional data](docs/images/sprint2/agenda-ar-mobile.png)

[See the other screenshots and test evidence](docs/testing/SPRINT2-FRONTEND.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| [`frontend/`](frontend/) | React / TypeScript / Vite web application, real-API browser tests and [run guide](frontend/README.md). |
| [`backend/`](backend/) | Node.js / TypeScript API, PostgreSQL 16 migrations, fictional fixtures and [backend guide](backend/README.md). |
| [`docs/`](docs/) | [Source-of-truth index](docs/INDEX.md), product, architecture, API, security, testing and review evidence. |
| [`src/`](src/) and [`test/`](test/) | Historical v0.1 local prototype retained as a separate reference. |

## Try the fictional development app locally

Requirements: Node.js 22 (`>=22.18 <23`), npm, PostgreSQL 16 binaries and a Chromium-compatible browser. **Run only on a trusted local development machine. Do not expose this fixture server on the public internet.**

From the repository root, install the locked dependencies:

```sh
npm --prefix backend ci --ignore-scripts --no-audit --no-fund
npm --prefix frontend ci --ignore-scripts --no-audit --no-fund
```

In the first terminal:

```sh
cd backend
bash scripts/dev-pg16.sh start
# Set EZZ_TEST_ADMIN_URL to the disposable PostgreSQL URL printed by the script.
node scripts/dev-web.ts
```

In a second terminal, from the repository root:

```sh
npm --prefix frontend run dev
```

Open **http://127.0.0.1:5173**. Use only the seeded **fictional** clinic and staff credentials documented in [`frontend/README.md`](frontend/README.md). The backend fixture creates disposable test data; stopping it tears down its test database.

For exact setup requirements, test commands, port assumptions, teardown and troubleshooting, follow the [frontend run instructions](frontend/README.md) rather than improvising production configuration.

## Private phone preview (fictional data only)

The temporary GitHub Codespaces configuration is in [draft PR #44](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/44). It requires a signed-in GitHub owner and a **Private** forwarded port. It is NOT production hosting. Start only from the preview branch with the [Codespaces guide](docs/operations/CODESPACES-FICTIONAL-PREVIEW.md); verify the port is Private before using it, enter only fictional records, and shut it down afterwards.

## Engineering and verification

The application uses server-derived staff identity and clinic scope, PostgreSQL-enforced data boundaries, integer **millimes** for monetary amounts, unique write-intent idempotency keys, and audit records for sensitive changes. The frontend shows server-authorized results; hiding buttons is **not** a security boundary.

- [API routes](docs/api/endpoints.md) and [OpenAPI contract](docs/api/openapi.json)
- [Frontend security states](docs/api/frontend-security-states.md)
- [Sprint 1 backend integration test evidence](docs/testing/SPRINT1-INTEGRATION.md)
- [Sprint 2 real-API frontend test evidence](docs/testing/SPRINT2-FRONTEND.md)
- [Engineering standards](docs/engineering/standards.md)
- [Documentation authority, review and update rules](docs/INDEX.md)

Automated tests and sample screenshots use fictional data. A passing test suite is not an independent production certification.

## What's next

1. Independently review the stacked receptionist UX draft PRs; merge only in approved dependency order after exact-head checks and founder authorization.
2. Build and review the dentist and owner workspaces against existing server-side permissions and monetary evidence rules.
3. Complete the 61 approved V1 acceptance-group evidence checks and separate paper-first CNAM workflow implementation without inventing current tariffs.
4. Validate the private, GitHub-authenticated fictional-data preview and address [production security blockers](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) and [CI/protection governance](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/68) before any real-clinic rollout.

**No real patient data, real payments or production deployment until separate safety, legal and founder release approval.**
