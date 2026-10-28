# Disaster-recovery drill (B14) — fictional data only

**Status: draft (branch `claude/b14-backup-restore-drill`, stacked on B05 / PR #13). Not reviewed. Not a hosting, vendor or legal decision.**

## Tools

```bash
cd backend
# 1. Encrypted backup of one database (AES-256-GCM, key from an owner-held passphrase via scrypt)
EZZ_ADMIN_URL='postgres://postgres:...@localhost:5432/postgres' EZZ_BACKUP_PASSPHRASE='<owner passphrase, >=16 chars>' \
  node scripts/backup.ts ezz_dev ./backups
# -> backups/<name>.dump.enc and backups/<name>.manifest.json (counts, totals, hashes; no patient data)

# 2. Restore into a NEW database on any PostgreSQL 16 instance (fresh instances included) and verify
EZZ_ADMIN_URL='postgres://postgres:...@target:5432/postgres?sslmode=verify-full&sslrootcert=/path/ca.pem' \
EZZ_BACKUP_PASSPHRASE='...' EZZ_OWNER_PW='...' EZZ_APP_PW='...' \
  node scripts/restore-verify.ts backups/<name>.dump.enc backups/<name>.manifest.json ezz_restored owner-anchors.json
# exit 0 only if every check passes; JSON report with each check and measured timings
```

`owner-anchors.json` holds the owner's checkpoints kept **outside** the system (paper / personal device): `{ "<clinicId>": [{ "seq": 41, "hash": "…" }] }`.

## What restore-and-verify checks

| Check | Meaning |
|---|---|
| `ARCHIVE_INTEGRITY` | GCM authentication of every byte (wrong passphrase or one flipped byte = refusal) and SHA-256 equal to the manifest. Nothing is created before this passes. |
| `ROLES_PRESENT` | `pg_dump` does **not** carry cluster roles. On a fresh instance `ezz_owner`/`ezz_app` are created first, otherwise the restored grants would fail or be lost. |
| `MIGRATIONS_CURRENT`, `MIGRATION_LEDGER_MATCH` | every migration already applied with the same checksum; re-running migrations is a no-op |
| `FACTS_MATCH` | per clinic: patients, visits, care count/total, payment count/total, allocation total, adjustment count/total, receipt count, highest receipt number, receipt counter, cash counts, audit head (seq + hash) identical to the manifest |
| `RLS_POLICIES_MATCH`, `APPEND_ONLY_TRIGGERS_MATCH`, `APP_GRANTS_MATCH` | security inventories identical to the source (forced row-level security, append-only triggers, `ezz_app` table privileges) |
| `AUDIT_CHAIN:<clinic>` | hash chain recomputed, plus the owner's outside checkpoints |
| `INTEGRITY:<clinic>` | owner integrity check (receipt gaps/counter, audit presence, …) |
| `TENANT_ISOLATION:<clinic>`, `TENANT_ISOLATION:no-context` | the application role sees only its clinic, and nothing without a clinic context |
| `APP_ROLE_LEAST_PRIVILEGE` | `ezz_app` still cannot UPDATE payments or DELETE audit events |

The restore never writes into an existing database.

## Measured evidence (local run, 2026-10-28, PostgreSQL 16.15, fictional 2-clinic data set)

`test/b14-backup-restore.test.ts` against a **freshly initdb'd instance** (no application roles):
decrypt 110 ms, `pg_restore` 425 ms, verification 73 ms for a 178 KB dump; 16 checks, all passing.
After restore: staff log in, the next payment receives **R-000008** after the last restored **R-000007** (no gap, no reuse), clinic B cannot read clinic A, and the integrity check with the owner's checkpoint passes.

Negative evidence: wrong passphrase, a single modified byte, and a manifest with a different SHA-256 are all refused before any database is created. Restoring an **older** backup when the owner holds a **newer** checkpoint fails `AUDIT_CHAIN` with `SHORTER_THAN_ANCHOR`, so a silent roll-back is visible.

Fictional sizes say nothing about production durations; scale was not measured.

## Not covered / open (do not claim)

- **RPO**: equal to the backup interval. No WAL archiving / point-in-time recovery is built (ops doc §6.1 target ≤1 h for hosted copies is not met by this tool alone).
- **Where backups are stored**: not decided. An off-site or foreign copy may be a data transfer under Law 2004-63 (CH-004/006); backups are health-data stores in the INPDP declaration and fall under Art. 45 destruction (ops doc Q7).
- **Passphrase custody**: the owner keeps it; loss = loss of that backup. Escrow is an open ops question (ops doc §7).
- **Scheduling, rotation (12-month monthly copies), off-machine transfer and recording each drill as an audit event**: not built.
- Restore drill on the real target host and network: not done (no host chosen).
