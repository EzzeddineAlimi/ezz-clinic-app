# Security status — v0.2 fictional-data build (Claude Opus 5.5, 2026-10-28)

**Historical 2026-10-28 security snapshot, not a current certification.** The original 80-test persistent build evidence remains historical. Main has since integrated additional code and CI; [draft security PR #71](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/71) documents current security review, and [issue #72](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) tracks unresolved production gates. No independent production penetration test, legal approval or deployment is claimed. Threat model and risks: `docs/operations/privacy-compliance-and-operational-risk.md` §11–12.

## Council challenges — status after this sprint (proposal; GPT owns the COUNCIL_CHALLENGES cells)

Per the C-146 / M-245 close bar, a challenge may only be proposed for closure when its regression test passes on a **persistent** build. Founder closes; Muse may object.

| CH | Issue | v0.2 control | Tests (persistent build) | Proposed status |
|---|---|---|---|---|
| CH-007 | Count not blind / not independent | Counter = OWNER/DENTIST; no figures before submit; owner review only after a count; all attempts kept; recount reason | T-CASH-1..7, T-CASH-CONC | PASS-PERSISTENT (software side). Physical independence still UNPROVABLE |
| CH-012 | Unauthenticated care / fee | Sessions; DENTIST-only confirm/correct; body identity ignored; denial counter | T-CARE-1..6 | PASS-PERSISTENT (demo identity ≠ production identity) |
| CH-013 | False card tender | DESK_CLAIM tier; owner statement import; tier-2 ceiling; ambiguity-safe matching | T-CARD-1/3, T-STMT-1..8, M-249-A..E | PASS-PERSISTENT for the design battery; PROVIDER_VERIFIED unreachable (CH-022) |
| CH-014 | No window / float / outflows | Periods, float, owner movements, carry-forward of counted remainder | T-WIN-1..3 | PASS-PERSISTENT |
| CH-015 | Duplicate payments | Mandatory Idempotency-Key in the business tx; near-duplicate confirmation; visit row lock | T-IDEM-0..3, T-IDEM-CONC, T-RACE-1 | PASS-PERSISTENT |
| CH-016 | Receipt restart | Counter row in tx; separate paper namespace; reprint = COPY | T-REC-1 (SIGKILL), T-REC-CONC, T-TX-1, T-REPRINT-1 | PASS-PERSISTENT (legal format UNVERIFIED) |
| CH-017 | Volatile / mutable history | Durable hash chain; triggers + privileges; owner anchors; integrity check | T-EVT-2..5, T-MISS-1, T-BKP-1 | PASS-PERSISTENT with owner-anchor dependency |
| CH-018 | Unresolved visits invisible | Owner exception list incl. past visits without dentist record, desk-marked no-shows | AC-DASH-1, T-DASH-3, T-VIS-2 | PASS-PERSISTENT |
| CH-019 | Browser-origin write | JSON-only (415), Origin allow-list (403), Host allow-list (421), bearer tokens | T-ORG-1..3 | PASS server-side; browser test NOT RUN |
| CH-020 | Money rounding | Integer-only API; exact parser; ARCH-3 | T-INPUT-1, T-PAY-2, T-MONEY-1 | PASS-PERSISTENT |
| CH-010 | Paper outage continuity | Numbered books, once-only re-entry | T-PAPER-1..9 | PASS for the paper side; paper-vs-SQLite drill NOT RUN |
| CH-002 | Wholly unrecorded cash | none possible in software | — | **REMAINS OPEN by design** |

## Remaining vulnerabilities / gaps (ranked)

1. **HIGH — Production database transport/configuration not approved**. Main `backend/src/platform/postgres.ts` now uses pinned `pg` and rejects remote DB configurations without certificate-verifying TLS; prior no-TLS-driver warning is superseded. Actual hosting, CA/certificate rotation, network isolation, secrets and backup custody are still open under [issue #72](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72).
2. **HIGH — Demo-grade identity**: password-only, no MFA, no device binding, chairside auth undefined; a receptionist who learns the dentist's password can confirm care as the dentist. Mitigations: per-person accounts, lockout, re-auth, audit. Fix: identity ticket SEC-01.
3. **HIGH — Owner recovery** requires DB-owner CLI access; no sealed recovery procedure. Fix: SEC-02.
4. **HIGH — Repository visibility**: GitHub API reported `ezz-clinic-app` as **public** on 2026-10-28 although the Sheet says private. Founder to verify.
5. **MEDIUM — Token storage on the client** is a frontend responsibility (memory only, never localStorage; XSS would steal it). Astra must follow the CSP-friendly design.
6. **MEDIUM — Rate limiting** exists only for login; no per-IP or per-account request throttling on other routes. Fix: SEC-03.
7. **MEDIUM — Audit checkpoints are unsigned and manual**; exposure window = checkpoint interval. Fix: SEC-04 (owner-held signing key / scheduled off-site delivery).
8. **MEDIUM — Superuser / host operator** can bypass RLS and triggers; detection relies on anchors. Hosting choice must minimise who holds superuser (legal Art. 22 constraint also applies).
9. **MEDIUM — Exceptions and integrity checks are O(n)** and run synchronously; an attacker with a valid owner session could cause load. Acceptable for one clinic; revisit at scale.
10. **LOW — Session token sent on every request**; no rotation on privilege change (roles are re-read per request, so revocation is immediate). Rotation on re-auth would be better.
11. **LOW — `security_denials` shows the staff id**; wording is neutral but owner UI must avoid accusatory presentation.
12. **LOW — Dependency supply chain residuals**: current backend/frontend lockfiles contain pinned dependencies with integrity metadata, but production advisory monitoring and full reachable-history secret scanning remain subject to [draft PR #71](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/71), independent review and provider-side controls. Pinned Actions SHAs still need provenance review.

## What the software can never prove (state this wherever a "green" is quoted)

Cash taken before it is recorded; a lower amount recorded than the patient paid when no patient-held receipt is checked; a card taken on a personal terminal; collusion between owner and desk; who physically counted the drawer. These need human/physical controls (owner counts, patient receipts, clinic-owned payment destinations, spot checks).
