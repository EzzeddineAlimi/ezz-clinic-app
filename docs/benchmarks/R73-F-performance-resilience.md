# R73-F — performance and resilience benchmarks (measured, fictional data)

Measured on **2026-10-29** with the code in this commit. Raw machine-readable results are in the JSON files next to
this report (`r73-f-run1-5x120.json`, `r73-f-run2-5x120-repeat.json`, `r73-f-run3-10x300.json`). These numbers describe
**this environment only**. They are not capacity guarantees and not a production-readiness claim.

## Environment (as recorded by the harness)

| | |
|---|---|
| Host | cloud container, 4 vCPU Intel Xeon @ 2.10 GHz, 16 GiB RAM, Linux 6.18 |
| Runtime | Node v22.22.0; API as a **separate server process** (`src/server.ts`), pool max 8 connections |
| Database | PostgreSQL 16.15 on the **same host** (loopback, no TLS, `shared_buffers` 128 MB, defaults otherwise) |
| Client | the harness itself, same host, 16 concurrent clients (`BENCH_CONCURRENCY`) |

## Reproduce

```bash
cd backend
export EZZ_TEST_ADMIN_URL=postgres://postgres:<local-admin-password>@localhost:5432/postgres   # throwaway local cluster
BENCH_CLINICS=5  BENCH_PATIENTS=120 node scripts/bench.ts --out ../docs/benchmarks/r73-f-run1-5x120.json   # ~35 s
BENCH_CLINICS=10 BENCH_PATIENTS=300 node scripts/bench.ts --out ../docs/benchmarks/r73-f-run3-10x300.json  # ~2.5 min
node --test test/r73-resilience.test.ts   # PostgreSQL crash test (needs initdb/pg_ctl)
```

The harness creates and drops its own database. It exits 1 if any invariant is violated (`violations` in the JSON).

## Datasets

| Run | Clinics | Patients | Visits | Care items | Payments = receipts | Audit events | DB size |
|---|---|---|---|---|---|---|---|
| run1 / run2 | 5 | 602 | 1 277 | 1 397 | 2 826 | 6 123 | 34 MB |
| run3 | 10 | 3 002 | 6 077 | 6 197 | 12 426 | 27 743 | 106 MB |

## Results: latency in ms (16 concurrent clients unless marked)

| Operation | run1 req/s | p50 | p95 | p99 | run3 req/s | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|---|
| Create patient | 227 | 65 | 113 | 142 | 290 | 54 | 80 | 102 |
| Schedule visit | 434 | 35 | 51 | 61 | 485 | 32 | 45 | 56 |
| Dentist confirms care | 264 | 57 | 92 | 111 | 292 | 48 | 89 | 235 |
| **Payment + receipt** | 279 | 56 | 78 | 89 | 280 | 56 | 76 | 88 |
| Isolation probes (cross-clinic / cross-role) | 1 574 | 10 | 15 | 19 | 1 531 | 10 | 15 | 19 |
| Day board (sequential) | | 5 | 7 | | | 5 | 8 | |
| Patient search (sequential) | | 3 | 4 | | | 3 | 9 | |
| Owner exceptions (sequential) | | 85 | 120 | | | 136 | 977* | |
| Integrity check, full recomputation (sequential) | | 61 | 118 | | | 134 | 929* | |
| Owner exceptions (4 concurrent) | | 182 | 209 | | | 425 | 1 170* | |

\* With 10 samples, p95 is the slowest single request: one cold first call per run (about 1 s) after the bulk load.
run2 repeated run1 within ±15 %.

## Invariants verified under concurrency (all held in all three runs)

| Check | Result |
|---|---|
| Receipt series per clinic contiguous and unique; counter = max + 1; every payment has a receipt; allocations add up; no visit paid above its confirmed fees | held after 2 826 and 12 426 concurrent payments |
| 20 concurrent 10 TND payments on a 50 TND visit (duplicate confirmed by the desk) | exactly **5** accepted, 15 refused with 409 |
| 10 concurrent requests with the **same** Idempotency-Key | **1** payment, 1 receipt number |
| 1 200 cross-clinic reads and receptionist→owner calls under load | **0** leaks (all 404/403) |
| Blind cash count submitted while 120 cash payments were arriving | expected cash stored at the cut = the owner review's recomputation; expected-at-cut + cash recorded after the cut = final drawer |
| Integrity check of every clinic after the load and after the kill | **0** findings |
| **API process SIGKILL** in the middle of 300 concurrent payments, then restart | 150–151 acknowledged before the kill, **0** lost; one payment committed whose answer was lost (run2) was replayed, not duplicated, on retry; 300 keys → exactly 300 payments |
| **PostgreSQL crash** (`pg_ctl -m immediate`) mid-burst (`test/r73-resilience.test.ts`, T-RES-1) | requests fail fast (no hang); readiness 503; the **same** API process recovers when PostgreSQL returns; no acknowledged payment lost; retries give exactly one payment per key; receipts contiguous; integrity clean |
| Encrypted backup + fresh restore + 16 checks | run1: 0.6 s backup (3.0 MB) and 2.4 s restore+verify; run3: 2.0 s (12.3 MB) and 7.9 s; all checks passed |

## Defects found and fixed (RED before GREEN)

1. **Readiness answered 500 instead of 503 while PostgreSQL was down.** The HTTP layer opens a transaction before every handler, so `/api/v1/health/ready` failed before its own "database unreachable" logic could run. Reproduced by T-RES-1 (`expected 503, actual 500`). Fix: a route can declare `transaction: false`; this is allowed only for public GET probes and enforced when the server starts. Load balancers treat both codes as unhealthy, but the documented contract (503 + `checks`) was wrong.
2. **The harness itself** had three bugs, fixed before the recorded runs:
   - it double-booked dentists (the app's overlap guard correctly refused);
   - it hit the intended duplicate-payment guard;
   - it started every heavy read at once, which turned queueing into a false "2.5 s integrity check".
   None of these were application defects.

## Observations (measured, not changed; for review)

- **O-1 Cash count waits for a continuous stream of cash payments.** Payments take `FOR SHARE` on the open cash period and the blind count takes `FOR UPDATE`. With 4 clients posting cash payments back-to-back, the count returned only after all 120 had finished (≈260 ms). Correctness held, as shown above. At real desk volumes the wait is the in-flight payments only. Changing this would alter the reviewed B10 locking design, so it is left to Muse.
- **O-2 Owner exceptions and the integrity check grow linearly with a clinic's history.** They recompute the hash chain and every audited value on each call: ≈60–90 ms at ~1.2k audit events per clinic, ≈135 ms at ~2.8k. At an assumed 20–30k audit events per busy clinic-year, expect ~1–1.5 s per call after one year. Options for later: incremental verification from the last owner checkpoint, or caching the exceptions list. This is not a defect today.
- **O-3** p99 for care confirmation rises to ~235 ms at 10 clinics (run3) while p50 is flat. This is a tail under 16-client contention on 4 vCPU.
- **O-4** The receptionist-relevant operations (patient create, visit, payment, day board, search) stay under ~100 ms p95 throughout.

## Not covered (honest limits)

- Separate hosts and network latency; TLS on the database link (TLS correctness is covered by T-TLS-REAL-1..4, not by benchmarks).
- Multiple API processes, or a pool larger than 8.
- Long-duration soak, memory growth, disk-full, slow disks.
- Document uploads (20 MiB bodies), and lab and stock load.
- PostgreSQL replication or failover.
- Real browsers and real devices.
