# Developer environment: Node 22 and PostgreSQL 16 (R73 package B)

Fictional data only. Nothing here connects to a real clinic or a hosted database.

## Requirements
- **Node 22.** `backend/.nvmrc` pins 22.23.4; CI uses that file, and the same major version is required.
- **PostgreSQL 16 server binaries.** On Ubuntu: `apt install postgresql-16`. Docker is not required.

## Setup
```bash
cd backend
npm ci --ignore-scripts --no-audit --no-fund
eval "$(scripts/dev-pg16.sh start)"       # throwaway cluster on 127.0.0.1:54316; prints EZZ_TEST_ADMIN_URL
node scripts/doctor.ts                     # Node major, PostgreSQL 16.x, TLS policy of DATABASE_URL, migrations
npm run typecheck && npm test              # real PostgreSQL; every test creates and drops its own database
npm run test:dist                          # the same suite compiled (dist/); must match npm test
scripts/dev-pg16.sh stop                   # stops the cluster and deletes its data
```

## What changed in R73-B
| Area | Behaviour | Evidence |
|---|---|---|
| `npm run test:dist` | Failed 265/273 because paths were built relative to the compiled file (`dist/migrations`, `dist/src/server.ts` and similar). Paths now come from `src/platform/paths.ts`, which locates the backend root. **No test was removed or skipped.** | The compiled run matches the source run; CI step "Compiled test run". |
| `migrate()` | Refuses a database that has applied migrations **unknown to this code** (schema ahead of code). | RED T-MIG-1 |
| `migrationStatus()` / `scripts/migrate.ts --check` | Read-only status: current, pending, modified, unknownApplied. Exits 1 unless the schema is exactly current. | T-MIG-2, T-MIG-4; CI step |
| Failed migration | Each file runs in one transaction: no half schema, no ledger row; the fixed file applies on the next run. | T-MIG-3 (already true; now proven) |
| Server startup | Fails fast with **exit 3** and a safe JSON message (states only; never the URL, user or password) when the database is unreachable or the schema is not exactly current. | RED T-START-1 (schema ahead), RED T-START-2 (wrong password) |
| `GET /api/v1/health/ready` | Public; 200 `ready` or 503 `not_ready`, with `{database, migrations}` states only and no migration names. Migration 0010 lets the API role **read** `schema_migrations`. | T-START-3 |
| Real TLS | A throwaway PostgreSQL 16 cluster with `ssl=on` and a test CA generated on the fly. Covers: verify-full with a pinned CA; an unrelated CA rejected; a wrong-host certificate rejected by verify-full but **accepted by verify-ca** (the documented M-266 weakness); the whole app over verified TLS with zero plaintext API connections. | T-TLS-REAL-1..4 (skip only without initdb/openssl) |
| Environment doctor | `scripts/doctor.ts` prints JSON with no secrets and exits 1 on any failed check. | T-DOC-1 |

## Not verified here
- A docker-compose setup. No compose file is shipped, because the docker daemon was not available to test one.
- Behaviour on Windows or macOS.
- Production TLS certificate issuance and rotation: these are deployment decisions (CH-004/CH-006, ADR-0004a).
