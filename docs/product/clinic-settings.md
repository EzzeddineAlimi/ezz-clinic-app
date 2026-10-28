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
