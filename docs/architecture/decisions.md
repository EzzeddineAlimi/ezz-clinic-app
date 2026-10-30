# Architecture Decision Records — EZZ Clinic v0.2 (fictional-data development)

Status values: ACCEPTED-FOR-DEV (used in code, reversible), PROPOSED, OPEN. None of these is a production or founder approval.
Original author: Claude Opus 5.5, 2026-10-28. The implementation status of ADR-0004a was checked against merged main `406c5dd1` on 2026-10-30; other open/proposed decisions remain subject to their own evidence and founder gates.

---

## ADR-0001 Modular monolith, one PostgreSQL — ACCEPTED-FOR-DEV
**Context**: money facts must commit atomically with receipt numbers, audit events and idempotency records; no clinic IT staff. **Decision**: one Node/TypeScript process, modules with enforced dependency map (ARCH-1), one PostgreSQL database. **Consequences**: simple ops and backups; must keep module discipline. **Alternatives**: microservices (rejected v1), local-first SQLite (OPEN, CH-010 drill). **Dissent**: GEM-REV-003 preserved.

## ADR-0002 Integer millimes everywhere — ACCEPTED-FOR-DEV
Money is `bigint` millimes in DB and safe-integer JSON numbers in the API; floats, strings and exponents rejected; exact `parseTndToMillimes` for UI/import (3 decimals max, never rounds). Fitness test ARCH-3 forbids `parseFloat/Math.round/toFixed` in server code.

## ADR-0003 Append-only evidence + compensating rows — ACCEPTED-FOR-DEV
Financial and evidence tables reject UPDATE/DELETE/TRUNCATE by trigger (SQLSTATE EZ001) and by privileges. Corrections are new rows (care CORRECTION, adjustments, paper DUPLICATE/CONFLICT entries). Operational state (visit status, cash period status, session timestamps) is mutable but every change is audited.

## ADR-0004 In-repo PostgreSQL wire client (temporary) — SUPERSEDED by ADR-0004a
**Context**: the sprint sandbox had no npm registry access. **Decision**: a ~400-line zero-dependency v3 protocol client (extended query with parameters, SCRAM/md5/trust, simple query only for migrations) behind `Db`/`Tx`. **Consequences**: no TLS, not battle-tested → dev/CI only. **Follow-up**: ENG-01 swap to `pg` (node-postgres) with TLS; module code unchanged.

## ADR-0004a node-postgres with enforced TLS for remote hosts (B05, issue #4) — ACCEPTED-FOR-DEV (merged into main; production configuration OPEN)
**Decision**: `src/platform/postgres.ts` implements the same `PgConnection`/`PgPool`/`PgError`/`parseDatabaseUrl` API over `pg` 8.23.1 (exact pin; lockfile regenerated so all 18 packages carry integrity hashes; none has install scripts). `pgwire.ts` is a re-export shim so callers and stacked branches compile unchanged. **TLS policy** (checked before any socket opens): remote hosts must use `sslmode=verify-full` (default) or `verify-ca`; `disable`/`allow`/`prefer`/`require`/`no-verify` are refused; loopback and Unix sockets are the only exemption. `sslrootcert=<path>` pins the CA; without it the process trust store applies (which can include system/OS CAs depending on Node flags), so **production configs should always pin `sslrootcert`**. **Pool**: `pg.Pool` with a 10 s acquire timeout (no unbounded waits), idle-client errors handled, broken clients discarded; API sessions get `statement_timeout=30s` and `idle_in_transaction_session_timeout=60s` unless overridden in the URL. Tenant context stays transaction-local (`set_config(..., true)`). **Not decided here**: hosting, managed-database vendor, certificate issuance/rotation, Tunisian data-location rules (CH-004/006).

## ADR-0005 Tenant isolation = session clinic + RLS + composite FKs — ACCEPTED-FOR-DEV
Three independent layers (architecture §4). API role `ezz_app` is NOBYPASSRLS, non-owner; RLS is FORCEd. Superusers still bypass RLS (documented residual).

## ADR-0006 Gap-free receipt numbering via counter row — ACCEPTED-FOR-DEV
Sequences are not gap-free; a per-clinic, per-series counter row locked in the payment transaction is. Paper slips use a separate namespace (P-nnn) and never consume R numbers. **OPEN**: whether Tunisian fee-note rules require gap-free numbering, a specific format or e-invoicing (ops doc §4).

## ADR-0007 Mandatory Idempotency-Key on all writes — ACCEPTED-FOR-DEV
Key stored with request hash and response in the business transaction; replay returns the stored response; conflicting reuse → 409. Near-duplicate detection (120 s, ASSUMPTION) requires explicit confirmation.

## ADR-0008 Hash-chained audit + owner-held external checkpoints — ACCEPTED-FOR-DEV
Chain per clinic; owner prints/keeps checkpoint lines outside the system; verification with anchors detects truncation and old-backup restores. Not a Merkle tree; not signed (PROPOSED next: owner-held signing key or external timestamp).

## ADR-0009 Blind count as a time cut-off within a period — ACCEPTED-FOR-DEV
Period = window `[opened_at, cutoff]`; count attempt = cut at `submitted_at`; expected computed from facts in the window; close accepts the latest attempt and carries `counted − handover` forward. Single drawer per clinic (ASSUMPTION). Counter must be OWNER/DENTIST; software independence flag is not physical proof.

## ADR-0010 Card evidence tiers with PROVIDER_VERIFIED unreachable — ACCEPTED-FOR-DEV
Vocabulary from G-31/C-148/M-249. Owner statement import with total check (independent only if read by the owner from terminal/bank), surplus-only replay protection, re-issue conflict blocking, ambiguity-safe matching (no first-wins), owner confirmation = tier 2 maximum; DB check + privileges make tier 3 impossible without a future authenticated provider feed. **OPEN**: which Tunisian provider/bank offers signed data (CH-022).

## ADR-0011 Exceptions computed on read; resolutions per item — ACCEPTED-FOR-DEV
Nothing to delete or silently clear; each resolution needs a reason code; no bulk clear; resolved counts by reason are shown. Scope line on every response.

## ADR-0012 Paper-first outage continuity — ACCEPTED-FOR-DEV (offline mode OPEN)
Numbered dentist-held books, once-only re-entry, neutral review items. No browser-side queued writes. Local-first write mode remains OPEN pending the drill.

## ADR-0013 Bearer tokens, not cookies — ACCEPTED-FOR-DEV
Avoids CSRF by construction; Origin/Host allow-lists and JSON-only bodies close CH-019 paths server-side. **Consequence for Astra**: token must live in memory (not localStorage) for production; refresh/expiry UX needed. OPEN for production: HttpOnly cookie + CSRF token alternative.

## ADR-0014 Node 22 for the sprint; LTS pin before production — PROPOSED
Node 22 security support ends 30 Apr 2027 (C-141). Pin the then-current LTS (Node 24 or 26) when choosing production; run TypeScript compiled (`dist/`) in production, type-stripping only in dev/tests.
