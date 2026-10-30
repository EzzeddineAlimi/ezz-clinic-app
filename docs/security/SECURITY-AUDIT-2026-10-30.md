# EZZ Clinic — security review and mitigation ledger

**Snapshot:** 2026-10-30, audited merged main 406c5dd1fd16dd543f2c0b9a3a601af33ae6568b. **Status:** fictional-data-only development; NOT a penetration test, security certification, or permission to process real patients. This document is introduced in an UNMERGED draft PR.

## Control-by-control findings

| User-requested safeguard | Code evidence / finding | Verdict and next action |
| --- | --- | --- |
| Authentication | backend/src/modules/identity.ts: named accounts, hashed sessions, backend role matrix, expires/idle timeout, step-up reauth | PARTIAL: no MFA/device/chairside production identity assurance; staff credentials remain a high-value target |
| Hide keys | backend/.env.example contains placeholders; .gitignore excludes .env and dumps | PARTIAL: private host/provider stores inaccessible; never put live keys in frontend bundle, public GitHub or Sheet |
| Secure database | platform/postgres.ts requires certificate-verified TLS on remote DB hosts; db.ts scopes transactions; Postgres RLS and app role | PARTIAL: real production network rules, app privileges, backup custody and operator superuser controls not provisioned |
| HTTPS | server.ts binds loopback plaintext HTTP for local development; no HTTPS ingress deployed | OPEN P0: validate TLS termination, cert renewal, HTTPS redirect and HSTS on the real domain before external access |
| Hash passwords | identity.ts uses per-user random-salt scrypt (16384/8/1) and timingSafeEqual | PRESENT in source. Tune work factor and adopt MFA + breach response before production |
| Server form validation | validate.ts enforces integers/millimes, field types, IDs. isoDate incorrectly relied only on Date validity (can normalize Feb 30) | FIX IN DRAFT: strict canonical date round-trip + negative test. Full route-by-route acceptance still open |
| XSS | React text escaping, frontend preview CSP, API JSON no-store/CSP; documents forced attachment | PARTIAL: production web host CSP/stored-XSS evidence absent; preview allows unsafe-inline styles; file content screening limited |
| Suspicious activity | login_attempts, security_denials, app audit chain, neutral body-free request IDs/status logs | PARTIAL: no deployed aggregation, alerts, on-call response, retention or detection thresholds |
| Admin routes | server checks permissions and reauth; r73-api-contract.test.ts enumerates permission/role coverage | PRESENT for fictional API, production staff identity/MFA still missing |
| Parameterized SQL | node-postgres values array and architecture ARCH-4 forbidding unapproved interpolation | PRESENT baseline, independent SQLi testing and dynamic-identifier review still required |
| Environment variables | server.ts requires DATABASE_URL, ALLOWED_ORIGINS and ALLOWED_HOSTS optional, binds loopback by default | PARTIAL: no production environment schema/HTTPS edge verification, secret manager or fail-closed audit-log config |
| Rate limiting | identity.ts persisted login failures per clinic+username; denial counters | PARTIAL: no source-IP / gateway / expensive-owner-action throttling; design NAT-safe trusted-edge controls |
| CORS | Origin allowlist and Host check, no wildcard CORS; fetch credentials omit | PRESENT in app boundary, confirm actual domain, reverse proxy and preflight policy when hosted |
| Security headers | API has CSP/default-src none, nosniff, X-Frame-Options DENY, referrer no-referrer; Vite preview CSP | PARTIAL: DRAFT adds CORP and Permissions-Policy; deployment must configure HSTS only at HTTPS ingress |
| Secure session cookies | Current frontend uses short-lived bearer tokens held in React memory and credentials: omit, no session cookies | NOT APPLICABLE until cookies introduced; then use Secure/HttpOnly/SameSite, session rotation and CSRF |
| CSRF tokens | Cookie-less bearer API, server rejects unallowed Origin and non-JSON write types | NOT APPLICABLE for current auth; re-evaluate if cookies or cross-origin flows appear; XSS can still steal bearer tokens |
| Expiring reset links | No emailed/self-service password-reset-link feature in current backend; owner-controlled reset with reauth | NOT APPLICABLE. If implemented, use single-use hashed expiring tokens and invalidate prior sessions |
| File types/sizes | documents.ts dentist-only, 20 MiB max, SHA256 comparison, magic-byte JPEG/PNG/PDF/DICOM, structural checks and storage isolation | PARTIAL: structuralScreener explicitly is NOT antivirus; production malware scanning/quarantine and DICOM PHI protection needed |
| Prices/payments | Verified staff roles, integer millimes, idempotency, server billing, conditional card evidence; T-CARE/T-IDEM/T-CASH tests | PARTIAL: desk tender is not independently verified bank settlement, physical count cannot be proved; clinical/fiscal signoff open |
| Production debug | API sanitizes internal errors and defaults to localhost. Root src/server.mjs is an UNAUTHENTICATED FICTIONAL v0.1 prototype bound 127.0.0.1:4173 | P0: NEVER deploy root prototype, dev-web.ts, Vite dev or mock fixtures publicly. No real production deployment/config gate exists |
| Vulnerable dependencies | backend and frontend exact-pinned manifests + npm lockfiles; historical sprint2 audit found zero at that time | DRAFT new unconditional security-audit workflow checks current npm HIGH/CRITICAL; CI result must be verified and advisories fixed |
| Unused packages | Backend runtime pg, frontend React/ReactDOM/Zod plus build/test dependencies | NOT VERIFIED: no dynamic unused-package inventory. Remove only after static usage review and actual build/e2e |
| Exposed files | current Git tree no .env, key or dump; .gitignore excludes likely sensitive formats | PARTIAL: deployment web root and private scanning alert APIs inaccessible; check artifacts, .git, backups, source maps |
| Git history leak scan | prior audit only file listing; no full secret scanning evidence | DRAFT redacted signature-based all-reachable-history CI tripwire; not entropy scan or complete provider scan |
| Revoke leaked keys | No actual live key shown/leak confirmed; provider credentials and admin access unavailable | NOT PERFORMED: revoke/rotate at the provider immediately ONLY upon confirmed compromise; git rewrite alone insufficient |
| Test protections | Existing backend test suite, role-matrix/API/financial and clinical tests. This draft adds SEC-HTTP-1 and SEC-DATE-1 | IN PROGRESS: require exact-head CI before any merge, then independent Muse adversarial review |
| Branch protection | GitHub reports main protected=true, but zero required checks and non_admins enforcement in visible summary | OPEN: issue #68; require stable always-run security-audit and suitably refactored backend/frontend checks when verified |

## Changes in the security draft PR

1. Reject content-type lookalikes such as application/jsonp while allowing legitimate application/json; charset=UTF-8. Keep API JSON-only, Host/Origin restrictions and no credentials relaxation.
2. Add Cross-Origin-Resource-Policy and Permissions-Policy on API responses and focused regression tests for headers and MIME rejections.
3. Reject impossible clinical calendar days (Feb 30, non-leap Feb 29), add leap-year and positive-path tests.
4. Add always-run security-audit GitHub Actions job: full-history checkout without stored credentials; privacy-preserving known-token signature tripwire; npm audit for backend/frontend high/critical advisories.

## Priority release blockers

**P0:** production authentication/MFA and recovery, real HTTPS ingress and HSTS, database network/TLS/roles/secrets, hosting privacy and clinical controls, audit alerting, signed/verified backups, independent pen test and local Tunisian health/privacy/fiscal signoff. Never handle real patient data before approval.

**P1:** edge NAT-aware rate limits, non-silent security monitoring, genuine antivirus/CDR and quarantine for uploads, stored-XSS tests, dependency review, privileged action alerting, restore drill, independent cash and settlement proofs, review of all admin actions.

**P2:** password-work-factor calibration, session rotation, CSP inline-style elimination, signed audit checkpoints, dependency trimming, vulnerability escalation and recovery rehearsal.

## Method and limitations

This assessment read current main source, selected tests, workflows, manifests and project status; it did not run a production app or contact external infrastructure. GitHub connector cannot enumerate Dependabot, code-scanning or secret-scanning alerts, edit account secrets, inspect cloud services or rotate API keys. New PR CI is separate proof, not yet known at report creation. Scanner covers known token signatures and fetched reachable commits, not all possible secrets; outputs no sensitive token bytes. Clinic cash theft cannot be reduced to zero by software.

**Release decision:** NOT APPROVED. Merge only with founder authorization after exact-head CI and independent review. Do not deploy.
