# EZZ CLINIC — OPUS 5.5 MASTER ENGINEERING HANDOFF

Author: Claude Opus 5.5 (Anthropic) · Sprint date: 2026-10-28 · Scope: **fictional / synthetic data only** · Nothing merged, deployed, purchased or sent to clinics/patients · No final stack, scope, hosting, PSP, legal or production decision taken.

Labels used: **DONE** (built and verified by a test that actually ran) · **PARTIAL** · **NOT STARTED** · **BLOCKED** · **UNVERIFIED** (written but not executed/checked).

This document is self-contained: another AI developer can continue without this chat. Sources read first: Mission Control COMMAND R36–R42, V1_BUILD_LANE, TECH_STACK_COUNCIL, COUNCIL_CHALLENGES CH-001..022, GPT_SECURITY_BASELINE, R32/R34/R35, MODEL_INBOX G-30..G-33, C-135..C-148, M-242..M-249; GitHub `EzzeddineAlimi/ezz-clinic-app` main @ `c89d6e6` (code actually inspected, not only Sheet summaries).

---

## 1. What was actually completed

| Item | Status | Evidence |
|---|---|---|
| v0.2 backend (TypeScript/Node 22, PostgreSQL 16) — 10 modules, 7 migrations | **DONE** (fictional) | `backend/`; 80/80 tests PASS on real PostgreSQL, run 2026-10-28 |
| C1 dentist authority, auth, sessions, roles, clinic isolation (API + RLS + composite FKs) | **DONE** | T-CARE-1..6, T-ISO-1..3, T-PRIV-1, T-SESS-1..3 |
| C2 independent blind cash count, periods, float, owner movements, retries, carry-forward | **DONE** (software side) | T-CASH-1..7, T-WIN-1..3, T-CASH-CONC |
| C3 card evidence tiers, statement import (total / replay / overlap / re-issue / reversal), ambiguity-safe matching, M-249 tests | **DONE** (no PSP) | T-CARD-1/3, T-STMT-1..8, M-249-A..E |
| C4 idempotent payments, concurrency, gap-free receipts, discounts/refunds/voids | **DONE** | T-IDEM-0..3, T-IDEM-CONC, T-RACE-1, T-REC-CONC, T-ADJ-1, T-VOID-1 |
| C5 durability: SIGKILL restart, rollback, append-only, least privilege, hash chain + owner checkpoints, integrity (missing-record) check, backup/restore drill | **DONE** | T-REC-1, T-TX-1, T-EVT-2..5, T-MISS-1, T-BKP-1 |
| C6 paper outage books, once-only re-entry, void/unused custody, sequence check | **DONE** | T-PAPER-1..9 (C-146 drill numbers) |
| Owner exception list (MF17/CH-018), per-item resolution, no bulk clear | **DONE** | AC-DASH-1, T-RES-1, T-DASH-* |
| v0.1 RED baseline independently re-run (9/9 RED) | **DONE** | `docs/testing/v01-baseline-results.json` |
| Architecture (15 topics), ADRs, module map, implementation order | **DONE** (draft) | `docs/architecture/` |
| DB spec + API v1 contracts (generated from code, real captured examples) | **DONE** | `docs/database/schema.md`, `docs/api/api-v1.md` |
| Clinical domain requirements for Astra / future backend | **DONE** (research draft, not clinically validated) | `docs/clinical-domain/clinical-requirements.md` |
| Privacy / Tunisian compliance questions / STRIDE threat model / risk register | **DONE** (research draft, not legal advice) | `docs/operations/privacy-compliance-and-operational-risk.md` |
| Engineering standards, CI workflow, lockfile, .nvmrc, privacy .gitignore | **PARTIAL** — CI written, **not run** (UNVERIFIED); lockfile lacks integrity hashes | `docs/engineering/standards.md`, `.github/workflows/backend-ci.yml` |
| Future capabilities prioritisation | **DONE** (short) | `docs/product/future-capabilities.md` |
| GitHub branches / draft PRs | **BLOCKED** — connector 403 "Resource not accessible by integration"; git push denied by proxy | see §3 |
| Drive deliverables | **DONE** (docs) / code archive delivered as chat attachment | see §4 |
| Mission Control summary | see §4 (MODEL_INBOX Claude lane) | — |

## 2. Code created or modified

- **Created** `backend/` (new package; the v0.1 prototype at repo root is **unchanged**):
  - `migrations/0001_platform_identity_audit.sql` … `0007_owner_exceptions.sql`
  - `src/platform/` — `pgwire.ts` (temporary zero-dependency PostgreSQL client, **no TLS**, ADR-0004), `db.ts`, `http.ts`, `validate.ts`, `errors.ts`, `canonical.ts`, `migrate.ts`
  - `src/modules/` — `identity`, `audit`, `patients`, `care`, `billing`, `cash`, `card`, `paper`, `integrity`, `exceptions`
  - `src/app.ts`, `src/server.ts`
  - `test/` — `helpers.ts`, `architecture`, `c1-identity-care`, `c2-cash-count`, `c3-card-evidence`, `c4-payments-idempotency`, `c5-durability-audit`, `c6-paper-outage`, `c7-owner-exceptions`
  - `scripts/` — `migrate.ts`, `seed-fictional.ts`, `bootstrap-roles.sql`, `v01-baseline-probe.mjs`, `gen-permission-matrix.ts`
  - `package.json`, `package-lock.json`, `tsconfig.json`, `.nvmrc`, `.env.example`, `README.md`
- **Created** `.github/workflows/backend-ci.yml` (SHA-pinned actions, read-only token, Postgres service, privacy guard).
- **Modified** root `.gitignore` (adds patient-data/evidence file patterns). No other existing file changed.
- **Created** `docs/` tree (architecture, database, api, security, testing, clinical-domain, operations, engineering, product, handoff).

Size: 60+ files, ~7,500 lines added. Each slice is a separate commit (see §3).

## 3. Exact GitHub branches and PR links

**No branch or PR exists on GitHub from this sprint** (BLOCKED: `create_branch` → 403; `git push` → proxy refused, repo not in session's authorised set). The work is packaged as a **git bundle** with these stacked branches (each passes its own tests):

| Branch (in bundle) | Commit | Contents | Open draft PR against |
|---|---|---|---|
| `opus55/01-core-identity-care` | slice 1 | platform, identity, audit chain, patients/visits, dentist care, C1 tests (17) | `main` |
| `opus55/02-payments-receipts` | slice 2 | payments, receipts, idempotency, adjustments, integrity, C4/C5 tests | `opus55/01-…` |
| `opus55/03-cash-count` | slice 3 | blind cash count, periods, movements, C2 tests | `opus55/02-…` |
| `opus55/04-card-evidence` | slice 4 | card tiers, statement import, matching, C3/M-249 tests | `opus55/03-…` |
| `opus55/05-paper-outage` | slice 5 | paper books and re-entry, C6 tests | `opus55/04-…` |
| `opus55/06-exceptions-ci` | slice 6 | owner exceptions, architecture tests, v0.1 probe, CI, gitignore, scripts | `opus55/05-…` |
| `opus55/07-docs-handoff` | docs | all documentation + this handoff | `opus55/06-…` |

**Import instructions for GPT (has repo write access per R39):**
```bash
git clone https://github.com/EzzeddineAlimi/ezz-clinic-app && cd ezz-clinic-app   # main must contain c89d6e6
git bundle verify /path/to/ezz-opus55.bundle
git fetch /path/to/ezz-opus55.bundle 'refs/heads/opus55/*:refs/heads/opus55/*'
cd backend && npm ci --ignore-scripts && EZZ_TEST_ADMIN_URL=postgres://postgres:<pw>@localhost:5432/postgres npm test   # expect 80/80
git push origin 'refs/heads/opus55/*'        # then open 7 DRAFT PRs as stacked above; DO NOT MERGE
```
Repository observation (needs founder check): the GitHub search API returned `private: false` for `ezz-clinic-app` on 2026-10-28.

## 4. Exact Google Drive document / file links

Folder: **EZZ Clinic — Opus 5.5 Engineering Sprint 2026-10-28 (fictional data)** — https://drive.google.com/drive/folders/1eIkTM6CO9zxmhKeYso6pHH4uHUs5TDyz

| Document | Link |
|---|---|
| Architecture (Mission A) | https://docs.google.com/document/d/1OsG09gX4LVMBjD-KvhIWSEkMZX0bYWteHzcCSh1fuHs/edit |
| ADRs 0001–0014 | https://docs.google.com/document/d/1jaVCD6m0M9oCoY34y0WvN_jDaV_qltgKaiMHJ2NvdN8/edit |
| Security status + verified test results (80/80) | https://docs.google.com/document/d/1CInVwvFifE7C2Y6kM7UXrubuwx12GP7sWVKL9dtE7hM/edit |
| This master handoff, API, DB, clinical, compliance, standards | in the same folder (links appended in the Drive copy of this handoff) |

Code archive: `ezz-opus55.bundle` (git, stacked branches) and `ezz-clinic-opus55-src.zip` (working tree) were delivered as **chat attachments** on 2026-10-28; I could not upload binaries to Drive from this session without hand-transcribing them. **Founder: save both attachments into the Drive folder above** so GPT/Muse can use them.

## 5. Tests executed, passed and failed

- **v0.1 baseline (existing failing tests)**: 9 checks executed, **9 RED** as expected (T-CARE-1, T-CARD-1, T-IDEM-1, T-CASH-1/3, T-ORG-1, T-PAPER-1, T-STMT-1, T-EVT-3, T-RECEIPT).
- **v0.2 suite**: **80 executed, 80 passed, 0 failed**, ~22 s (Node v22.23.4, PostgreSQL 16.15, local sandbox). Full list with expected results: `docs/testing/results-matrix.md`.
- **Typecheck** (`tsc` 6.0.3 strict) PASS; **build** (`tsc` to `dist/`) PASS.
- **Not run**: GitHub CI (BLOCKED), browser cross-origin exploit, paper-vs-SQLite outage drill, chairside usability, TLS/network, load, cross-version restore.
- Original 7 v0.1 logic tests: untouched (they still describe v0.1 only).

## 6. Remaining security vulnerabilities (ranked; detail in `docs/security/security-status.md`)

1. HIGH — temporary DB driver has **no TLS** (ENG-01).
2. HIGH — demo-grade identity (password only; no MFA; chairside auth undefined; dentist password sharing defeats MF12).
3. HIGH — owner recovery procedure missing (needs DB-owner CLI).
4. HIGH — repository possibly **public** (verify).
5. MEDIUM — client token storage (Astra: memory only); no general rate limiting; unsigned manual checkpoints; superuser/host operator bypass (anchors are the only control); O(n) synchronous checks.
6. LOW — no token rotation on re-auth; lockfile without integrity; action SHAs unverified against signed tags.
7. BY DESIGN — CH-002 unrecorded cash, physical count independence, owner–desk collusion, personal card terminals: not detectable by software.

## 7. Architecture decisions and unresolved alternatives

Accepted for development (reversible): modular monolith + PostgreSQL; integer millimes; append-only facts + compensating rows; RLS + composite FKs; gap-free counter-row receipts; mandatory Idempotency-Key; hash chain + owner checkpoints; blind count as time cut-off; card tiers with PROVIDER_VERIFIED unreachable; exceptions computed on read; paper-first outage; bearer tokens (ADR-0001…0014).
Unresolved: local-first SQLite vs cloud PostgreSQL (needs the 4-hour/20-visit drill; GEM-REV-003 dissent preserved); hosting jurisdiction; identity provider / MFA / chairside auth; PSP or bank data source; signed checkpoints; multi-drawer cash; patient credits (MF10); Node LTS for production; replacing the in-repo driver with `pg`.

## 8. Clinical and legal assumptions (all UNVERIFIED unless stated)

- FDI/ISO 3950 is the canonical tooth notation (ESTABLISHED standard; Tunisian practice preference UNVERIFIED).
- Dentist must author the fee note (Code de déontologie Art. 31, as read by the council — interpretation UNVERIFIED); receptionist collection is modelled as an agent of the dentist (ASSUMPTION).
- Law 2004-63: health data processing needs INPDP **authorisation**, silence = refusal; **Art. 22 requires processors, their agents and sub-contractors to be Tunisian nationals resident in Tunisia** (text CONFIRMED; application to SaaS/hosting/AI UNSETTLED) — this may constrain who can operate or support the system.
- Transfers abroad (backups, email/SMS, telemetry, AI) need adequacy + INPDP authorisation → default: no foreign processors.
- No binding dental-record retention period found (20 years recommended in a secondary guide); financial records 10 years (SECONDARY).
- 2026 Finance Law Art. 53 e-invoicing extension to services — applicability to dental fee notes UNSETTLED.
- Settlement lag 2 days, re-auth 5 min, idle 30 min, duplicate window 120 s, stale-import 7 days, single drawer per clinic: ASSUMPTIONS.

## 9. Prioritised next 10 engineering tasks

1. **ENG-00** Import bundle, push stacked branches, open 7 draft PRs, run CI (GPT).
2. **ENG-01** Replace in-repo driver with `pg` (TLS), keep `Db/Tx` interface.
3. **ENG-02** Regenerate `package-lock.json` online with integrity; enable Dependabot/alerts.
4. **SEC-01** Production identity design + implementation: owner TOTP MFA, per-dentist quick re-auth at chair, session rotation.
5. **SEC-02** Owner recovery: two-person or sealed-code procedure; test that the desk cannot trigger it.
6. **SEC-03** General rate limiting + request-size/time limits per route.
7. **SEC-04** Signed/off-site owner checkpoints + daily reminder job.
8. **FIN-01** Patient credits/deposits (MF10) with independent source of cash credit.
9. **CLIN-01** Clinical migration 0008: odontogram events, findings, plans, notes/addenda, medical alerts (per clinical requirements §16).
10. **OPS-01** Outage drill (paper vs local-SQLite) + restore drill on a staging DB with fictional data.

## 10. Small implementation tickets with acceptance criteria

| Ticket | Acceptance criteria (all on persistent build, fictional data) |
|---|---|
| ENG-00 | 7 branches on GitHub; 7 draft PRs stacked; CI green on each or failures documented; nothing merged |
| ENG-01 | `pgwire.ts` removed; `pg` behind `Db`; all 80 tests pass; TLS `sslmode=verify-full` supported and tested against a TLS-enabled PG |
| ENG-02 | lockfile has `resolved` + `integrity` for every package; `npm ci` works in CI |
| SEC-01 | owner sensitive routes require TOTP; T-SESS tests extended; dentist re-auth ≤ 2 actions; receptionist cannot satisfy dentist MFA |
| SEC-02 | recovery requires two independent factors held outside the desk; test: receptionist session cannot start recovery (403) |
| SEC-03 | > N requests/min per account → 429; login lockout unchanged; tests for both |
| SEC-04 | checkpoint signed with owner key or timestamp; verify rejects forged checkpoint; exception item when no checkpoint in 7 days (exists) |
| FIN-01 | overpayment becomes credit only with owner/dentist approval; credit consumption audited; drawer expected unchanged by credit transfers; tests incl. receptionist cannot create credit |
| CLIN-01 | migration + API for findings vs completed procedures; chart edit alone never billable; dentist-only sign; addenda; FDI + region codes; tests for wrong-tooth/mixed dentition |
| OPS-01 | drill script; timing sheet; duplicate receipt count = 0; owner review minutes recorded; decision memo to founder |

## 11. Dependencies between tasks

ENG-00 → (ENG-01, ENG-02, all reviews). ENG-01 → any networked/staging test → OPS-01 restore part. SEC-01 → SEC-02. CLIN-01 depends on clinical questions answered by Tunisian dentists (clinical requirements §15) for anything beyond fictional data. FIN-01 independent. Astra UI can start now against `/api/v1` (contracts stable for additive change). Any real-data use depends on: legal answers (ops doc §13), hosting decision, SEC-01/02, ENG-01, external security review, founder gate.

## 12. What GPT should implement next

ENG-00 (import + draft PRs + CI), then ENG-01 and ENG-02, then SEC-03. Keep each change as its own draft PR with red→green tests. Update V1_BUILD_LANE / GPT_SECURITY_BASELINE / COUNCIL_CHALLENGES cells (GPT-owned) with **PASS-PERSISTENT (synthetic)** wording — not "closed", not "secure". Do not merge without Claude/Muse file-level review and founder approval.

## 13. What Muse should independently attack or review

1. Read the actual code (not this summary) of `cash.ts`, `card.ts`, `billing.ts`, `paper.ts`, `identity.ts`, `http.ts` and the migrations; try to break: count blindness (any endpoint that reveals per-period cash sums to the counter), card tier promotion, idempotency hash collisions (same key, reordered JSON keys), paper re-entry with altered `writtenOn`, cross-clinic ids via composite keys, RLS bypass through views or functions, SQL injection via route params.
2. Concurrency: refund + void race on the same payment; count + close race; two statement imports of overlapping periods in parallel.
3. Time attacks: clock skew between app and DB; payments exactly at count cut-off; DST/UTC date boundaries in card lag.
4. Re-check M-249 objections against the implemented tests; add any missing case as a failing test first.
5. Wording audit: any exception text that reads as an accusation (FR/AR translations later).

## 14. What Astra needs to know before visual UI/UX work

- Build against `docs/api/api-v1.md`; every write needs an `Idempotency-Key` generated **once per user intent** (form open), reused on retries; show `replayed` results as the same success.
- Money input: exact TND string → millimes with `parseTndToMillimes` semantics (max 3 decimals, never round); always read back "Espèces 70,000 TND — confirmer ?" with unit.
- Tender has **no default**; card shows "Carte — déclaration accueil uniquement (non vérifiée)" until the owner links a statement; never show a green "verified".
- Blind count screen: never fetch or display expected cash before submission; after submission show only "Enregistré — en attente de revue". Owner review is a separate owner-only screen.
- Owner exception list: show evidence label + known / unknown / next step; neutral wording; one item at a time resolution with reason; never a "clear all".
- Dentist care confirmation: one act per visit; show patient + second identifier + tooth (FDI) + procedure + fee; receptionist sees status only.
- Paper outage: banner modes (online / read-only / paper); P-slip numbers are not R-receipt numbers; re-entry shows per-slip outcomes POSTED / DUPLICATE / CONFLICT / REJECTED.
- Store the session token in memory only; handle 401 `REAUTH_REQUIRED` with a password prompt, 423 lockout, 409 business conflicts with `details.retryWith`.
- Elderly / no-phone: paper receipt is the default; never require QR/SMS; FR + AR RTL with direction-isolated amounts, tooth numbers and file numbers; 200 % zoom and keyboard-only checkout are acceptance criteria (R35).
- Clinical screens: follow `docs/clinical-domain/clinical-requirements.md` §14 (non-visual requirements); no clinical diagrams are validated.

## 15. What requires founder approval before production

1. Any real patient or clinic data (currently forbidden by DB CHECKs `is_fictional` / `is_synthetic`).
2. Hosting jurisdiction and provider; data-flow inventory; INPDP declaration/authorisation; Art. 22 operating model.
3. Payment provider / bank statement source; clinic-owned merchant account arrangements.
4. Fee-note / receipt legal format and e-invoicing applicability.
5. Final stack (incl. offline mode decision) and identity/MFA approach.
6. External security review and penetration test; restore drill sign-off.
7. Clinical validation by practising Tunisian dentists.
8. Merge of the v0.2 branches into `main` and repository visibility.
9. Go-live / pilot with a real clinic.
