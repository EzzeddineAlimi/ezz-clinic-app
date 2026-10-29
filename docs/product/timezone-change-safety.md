# Clinic timezone changes: safe behaviour and open decisions (CH-036, CH-037)

Status: **design note only, no code change**. Written in R75-B (2026-10-29) together with the CH-038 fix. Checked against #34 @ `51e188b`. Nothing here is approved; the founder decides the open items.

## Facts in the code today (source-checked at 51e188b)

| Area | Behaviour | Source |
|---|---|---|
| Stored times | Every appointment, payment, receipt and count is a UTC **instant** (`timestamptz`). A zone change never rewrites one. | `patients.ts` `POST /visits`, `billing.ts`, `cash.ts` |
| Receipt print (CH-036) | The date line is `formatLocal(snapshot.issuedAt, clinicTimezone(...))`, using the zone **at print time**. The snapshot holds the instant, not the zone. | `print.ts` L88, L207; `billing.ts` L67 |
| Zone change (CH-037) | Owner + re-auth. If any visit exists, the change needs `confirmTimezoneImpact: true`. The warning counts **all** visits (past included) and only says "dates will show in <zone>". | `settings.ts` L95–97 |
| Day board / lists | Grouped by the **current** zone. | `dayboard.ts`, `patients.ts` `GET /visits` |
| Cash periods | Boundaries are instants (`opened_at`, `submitted_at`); expected cash does not depend on the zone. | `cash.ts` `expectedCash` |

## Safe behaviour (what must stay true whatever is decided)

1. **Never rewrite history silently.** Past visits, issued receipts, cash periods and audit events are not changed by a zone change.
2. **An issued paper receipt and its later COPY must show the same date and time.** Today a COPY printed after a zone change can show a different date for the same number and fingerprint (fictional example from C-202: issued 2026-10-28T23:30Z under Africa/Tunis prints 29/10 00:30; after a change to UTC, the COPY prints 28/10 23:30). Safe direction: new receipts record the issuing zone inside the hashed snapshot. A receipt without it prints in the current zone **with a visible "zone not recorded" note**. Old snapshots are never rewritten.
3. **Future appointments: no silent choice.** A zone change either keeps the *instant* (the local clock shown to the desk moves) or keeps the *wall time* the patient was told (the instant moves). For a one-site Tunisian clinic the likely reason for a change is fixing a wrong initial setting, where the promised wall time is the truth (C-203). Neither is applied automatically today. The owner must see the affected **future** visits with old and new local times before confirming.
4. **Instants stay the only source of truth** for money and counts; zone only affects display and day grouping.

## Open founder/product decisions (not implemented)

| # | Decision | Options | Recommendation (not approved) |
|---|---|---|---|
| D-TZ-1 | Receipt date on COPY after a zone change | (a) issuing zone stored in new snapshots; (b) keep current behaviour + warning | (a): matches "never relabel an issued receipt" (R35 R75) |
| D-TZ-2 | Future visits when the zone changes | (a) KEEP WALL TIME = audited batch reschedule; (b) KEEP INSTANT; (c) owner chooses per change | (c), with (a) highlighted but not preselected |
| D-TZ-3 | Confirm binding | bare boolean (today) vs exact count of future SCHEDULED visits shown in the preview (409 if it changed) | count-bound confirm |
| D-TZ-4 | Desk follow-up | printable "time to check with the patient" list only for visits whose local clock changed | yes, no automatic calls or SMS |
| D-TZ-5 | Tunisian rules on receipt dates/time zone | unknown (CH-005) | needs qualified local confirmation |

Proposed tests (NOT RUN): T-TZ-RCPT-1/2, T-TZ-RPT-1, T-TZ-CASH-1 (C-202); T-TZ-APPT-7/8/9 (C-203).

## Done in R75-B (separate, narrow)

CH-038: `scheduledAt`/`effectiveAt` without an offset are refused (400), so the stored instant never depends on the server host's zone. Impossible dates are refused. See `docs/api/api-v1.md` (Conventions) and `backend/test/r75-appointment-time.test.ts`.
