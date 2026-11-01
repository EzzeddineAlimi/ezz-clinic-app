# Clinic settings (R73 package C)

Settings are append-only, audited and tenant-isolated (`clinic_setting_changes`, migration 0011). Only policies the code **already relied on** are configurable; a new key needs a new migration and a reviewed reason. No hosting, payment-provider, fiscal or clinical policy is configured here.

| Setting | Default | Allowed | Used by |
|---|---|---|---|
| `timezone` | `Africa/Tunis`, or the bootstrap `clinics.settings.timezone` | IANA name known to both Node and PostgreSQL | All clinic-day logic: day-board, visit list, owner review, receipts and prints, exceptions, card reconciliation, medical-history review dates, paper reconciliation |
| `checkpointDueDays` | 7 | 1–31 | Owner checkpoint status (R73-A) and the `AUDIT_CHECKPOINT_DUE` exception |
| `notArrivedGraceMinutes` | 15 | 5–120 | Day-board `NOT_ARRIVED_PAST_START` |

## API
- `GET /api/v1/clinic/settings` (`clinic.settings.read`, every role) returns:
  - `settings` and `sources` per key: `default`, `bootstrap` or `changed`;
  - `defaults`, `limits`, and `clinicToday`.
- `POST /api/v1/clinic/settings` (`clinic.settings.manage`, OWNER, password re-entry, idempotent). Body: `{ changes: {...}, reason, confirmTimezoneImpact? }`.
  - Unknown keys, invalid values and a missing reason are rejected; nothing is written.
  - Moving the timezone of a clinic that has visits needs `confirmTimezoneImpact: true` (409 otherwise, with the visit count).
  - Each change writes one row and one `clinic.setting_changed` audit event `{key, from, to}`.
- `GET /api/v1/clinic/settings/history` (OWNER): the last 200 changes, with who, when and the reason.
- `/integrity/check` compares each change with its audit event. It reports `SETTING_AUDIT_VALUE_MISMATCH`, `ROW_WITHOUT_AUDIT_EVENT` and `AUDITED_ROW_MISSING` (T-SET-5).

## Hard-coded time handling removed
| Before | After | Test |
|---|---|---|
| Owner exceptions sliced `asOf` days in UTC: a 02:00 Kolkata visit "today" was reported as a past visit. | Clinic-local `asOf` (and its default). | **RED T-SET-7** |
| Card claims were dated by the UTC day: a 00:30 Tunis card payment was dated the previous day, and its age was one day too old. | Clinic day; `asOf` defaults to the clinic's today. | **RED T-SET-8** |
| The medical-history next review was computed from `current_date` (UTC), and overdue was compared with the UTC today. | Clinic today. | **RED T-SET-9** |
| `paper.ts` SQL repeated the literal `'Africa/Tunis'` (handoff D-7). | The settings timezone is passed as a parameter. | B13 tests |
| `patients.clinicTimezone`, day-board grace and checkpoint due were each separate constants or reads. | One `settings` module (`clinicSettings`, `clinicTimezone`, `localDate`). | T-SET-6 |

## Known residual
`security_denials.day` (identity) is still the UTC `current_date`. It feeds a 7-day counter in owner exceptions, so it can be off by one day around midnight. This is low impact and left for a later change.

## U014 clinic opening hours and manually confirmed closure dates (fictional draft)

This calendar is a separate booking policy from the OWNER-only general clinic settings above.
The effective policy is the latest append-only `clinic_setting_changes` row with key `clinic_calendar`,
paired with a same-transaction `clinic.setting_changed` audit event and the existing integrity verifier.

- `GET /api/v1/clinic/schedule` (visit.read): returns `weeklyHours`, `closedDays`, `revision`, and `timezone`.
- `POST /api/v1/clinic/schedule` (visit.schedule, fresh password re-entry, idempotent): OWNER, DENTIST and RECEPTIONIST
  replace the full calendar with `{expectedRevision, weeklyHours, closedDays, reason}`. First revision is `null`;
  stale revisions fail with 409 instead of overwriting a coworker's change.
- `weeklyHours` is `null` when not configured (existing booking behavior unchanged), or seven Sunday-first
  arrays of zero to four sorted, non-overlapping `{start:'HH:mm',end:'HH:mm'}` local windows per weekday.
  An empty weekday is closed; windows cannot span midnight. `closedDays` is a manually confirmed,
  unique list of up to 366 real `YYYY-MM-DD` dates. No automatic holidays or dentist-specific leave.
- New bookings are checked server-side against the clinic timezone, date closures and the full visit duration.
  `allowOverlap` may still override a dentist overlap warning, **never** a closed day or outside-hours denial.
  A change that would invalidate an existing future visit is rejected (409, count only); staff must reschedule
  the visit first. Booking and calendar changes share a transaction advisory lock to prevent concurrent races.
- This is a fictional-data backend contract, **not** a delivered receptionist UI, measured staff workflow,
  clinical policy, Tunisian holiday authority, privacy/legal approval or V1 acceptance. Independent reviews remain open.
