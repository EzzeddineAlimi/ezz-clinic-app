# EZZ Clinic

**A dental-clinic management application for private practices in Tunisia.**

EZZ Clinic brings patient registration, appointments, dentist-authored care, payments, receipts and owner financial oversight together in one system. The design prioritizes a simple reception workflow, French/Arabic accessibility, and independent evidence for cash handling.

> [!IMPORTANT]
> **Development build — fictional data only. Not for clinical use, fiscal issuance or production deployment.** EZZ Clinic is not approved to store real patient records, process real payments or produce legally valid fiscal documents. Software cannot detect cash that is never recorded, and it cannot guarantee zero theft.

## Current build

| Area | Implementation status |
| --- | --- |
| **Backend** | TypeScript / Node.js 22 / PostgreSQL 16 modular monolith integrated into `main` through [PR #42](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/42). |
| **Web application** | React, TypeScript and Vite receptionist slice merged to `main` through [PR #43](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/43), following independent Muse M-275 review. |
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
| [`docs/`](docs/) | Product, architecture, API, security, testing and review evidence. |
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

A **temporary GitHub Codespaces** configuration is being prepared for testing the merged receptionist slice from a signed-in phone. The preview must use a **Private** forwarded port, never a public port or real patient data. It is not a production deployment.

[**Create a private Codespace from the preview branch**](https://codespaces.new/EzzeddineAlimi/ezz-clinic-app/tree/gpt/codespaces-private-fictional-preview) · Follow the [phone preview guide](docs/operations/CODESPACES-FICTIONAL-PREVIEW.md) for startup, private-port checks and teardown. A working Codespace and its private URL require the repository owner's GitHub sign-in; configuration alone does not create a live service.

## Engineering and verification

The application uses server-derived staff identity and clinic scope, PostgreSQL-enforced data boundaries, integer **millimes** for monetary amounts, unique write-intent idempotency keys, and audit records for sensitive changes. The frontend shows server-authorized results; hiding buttons is **not** a security boundary.

- [API routes](docs/api/endpoints.md) and [OpenAPI contract](docs/api/openapi.json)
- [Frontend security states](docs/api/frontend-security-states.md)
- [Sprint 1 backend integration test evidence](docs/testing/SPRINT1-INTEGRATION.md)
- [Sprint 2 real-API frontend test evidence](docs/testing/SPRINT2-FRONTEND.md)
- [Engineering standards](docs/engineering/standards.md)

Automated tests and sample screenshots use fictional data. A passing test suite is not an independent production certification.

## What's next

1. Test the merged receptionist frontend in a private, GitHub-authenticated, fictional-data-only Codespaces preview (not production).
2. Complete the dentist workflow, checkout, payment/receipt printing and owner cash-review screens against the existing backend contracts.
3. Test a private fictional-data deployment before considering any real-clinic rollout.
4. Resolve outstanding production authentication, privacy/clinical access, scheduling concurrency, receipt-timezone, document screening, independent financial evidence, and Tunisian clinical/fiscal/CNAM requirements.

**No real patient data, real payments or production deployment until separate safety, legal and founder release approval.**
