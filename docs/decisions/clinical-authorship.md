# EZZ Clinic — Clinical authorship policy (founder decision, 2026-10-29)

**Policy (M-279 F-C):** Any currently authenticated, authorized dentist in the **same clinic** may author clinical records and confirm actual treatment on that clinic's patient visit, even when the appointment lists another dentist.

**Why:** Continuity when a dentist is absent, on vacation, or when another colleague provides care. No mandatory administrative reassignment or cover-approval screen.

### Mandatory safeguards

- Appointment `dentistId` is a scheduling attribute, not an exclusive clinical write permission.
- The server enforces `clinical.write`, `care.confirm`, clinic/tenant isolation and any other existing authorization or medical-safety gate on every clinical action.
- A signed clinical note, dental finding, treatment-plan decision or care confirmation attributes its true **authenticated acting dentist**; it must never be recorded as if the assigned or absent practitioner performed it.
- Signed entries and clinical corrections follow the existing append-only/audit rules; no backdating or silent alteration.
- Receptionists, assistants and dentists from another clinic have no additional authoring rights under this policy.
- This defines **clinical authorship**, not insurance/CNAM eligibility, billing authority, regulatory approval, or permission to access an unrelated clinic.

**Verification:** Existing dentist role/tenant tests remain mandatory. Add a specific cross-dentist same-clinic test when the multi-dentist fixture is available. Preserve the founder's source decision in Mission Control G-89 and PR #56.

Development uses fictional data only. Do not interpret this policy as a production readiness approval.
