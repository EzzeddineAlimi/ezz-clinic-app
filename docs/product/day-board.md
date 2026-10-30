# Clinic day-board and patient flow (B12)

**Historical B12 backend-slice document.** The receptionist frontend was subsequently merged through PR #43. The current UI is in `frontend/`; UX-12 refinements are still draft PRs. This B12 record is not an authoritative current UI delivery checklist.

## Clinic-local days

- A clinic's day is its **local** calendar day. The timezone comes from `clinics.settings.timezone`, and the default is `Africa/Tunis`. This is a configuration default, not a hosting or legal decision.
- `GET /api/v1/visits?day=` and `GET /api/v1/day-board?day=` both use the clinic-local day. Before B12, the visit list sliced days in UTC, so a 00:30 appointment in Tunis showed up on the previous day's list (RED test T-DAY-1).
- An invalid timezone setting returns a 409 that names the setting. It never falls back silently to UTC (T-DAY-12).
- **B12 historical state:** the timezone originally came only from clinic bootstrap. **Current merged state:** the OWNER-only `POST /api/v1/clinic/settings` route supports timezone changes with reauthentication and impact confirmation; consult `docs/product/clinic-settings.md` and its tests for the actual contract.

## `GET /api/v1/day-board`

Permission: `visit.read` (OWNER, DENTIST, RECEPTIONIST, ASSISTANT).

| Field | Notes |
|---|---|
| `day`, `timezone`, `scope`, `dentistId` | Echo of the resolved query. |
| `summary` | `total`, `byStatus`, `notArrivedPastStart`. |
| `visits[]` | Ordered by time. Each visit has `localTime` (HH:MM in the clinic timezone), status, `waitingMinutes` (ARRIVED / IN_CHAIR, minutes since the status change), patient (file no., FR + AR names, preferred language, contact preference, `hasPhone`, `sameNameFileNos`), dentist, care item count, and `flags`. |

**Flags** (operational wording only):
- `IN_PERSON_CONTACT_ONLY`: no phone, or the patient prefers in-person contact (elderly / no-phone patients).
- `SAME_NAME_OTHER_FILE`: another file has the same name, so the desk should check it opened the right one. The other file numbers are listed.
- `NOT_ARRIVED_PAST_START`: still SCHEDULED 15 minutes after the start time.
- `DESK_MARKED`: a NO_SHOW or CANCELLED set by an account that is neither dentist nor owner (CH-018 hidden-visit risk, as in owner exceptions).
- `OVERLAPS_SAME_DENTIST`: overlaps another active visit of the same dentist.

**Role-aware fields**
- Dentists default to `scope=mine`, which shows their own visits **plus unassigned ones**, so nobody is lost. `scope=all` shows every visit.
- `scope=mine` without the DENTIST role is a 400.
- `balanceDueMillimes` is shown only to roles with `payment.read` (not ASSISTANT).
- The desk-written `statusReason` is shown only to roles with `visit.desk_status`. Others see `hasStatusReason`.
- **Phone numbers are never on the board.** They stay on the patient file.

**Cost**: two SQL statements per request (timezone and day), whatever the number of visits. T-DAY-11 asserts that 3 visits and 40 visits issue the same number of statements.

## Patient-flow guards changed in B12

- **NO_SHOW before the appointment time is refused (409).** Recording a no-show in advance would hide a visit; cancel it with a reason instead. This was confirmed on the base by RED test T-DAY-3.
- **Same-name duplicate warning.** The warning now fires on the same normalised name unless both phones are known and differ, or both birth dates are known and differ. Before, a patient without a phone was never matched by a new record that had one, which is a common elderly case (RED test T-DAY-4). The rule is still warn, never merge, never block: `confirmNotDuplicate: true` creates the record.

## Not covered

- Searching by Arabic name, or by full name across family and given name.
- An owner route to change the clinic timezone.
- Late-arrival and no-show statistics.
- Appointment reminders: patient contact is out of scope.
- The visual board (Astra).
