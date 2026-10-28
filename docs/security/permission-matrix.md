# Permission matrix (generated — do not edit by hand)

Source of truth: `backend/src/modules/identity.ts` `PERMISSIONS`. Regenerate with `node scripts/gen-permission-matrix.ts`; `test/architecture.test.ts` fails if this file drifts.
Enforced server-side on every request; identity comes only from the session. Routes marked *re-auth* in docs/api/api-v1.md additionally need a password re-entry within 5 minutes.

| Permission | OWNER | DENTIST | RECEPTIONIST | ASSISTANT |
|---|:-:|:-:|:-:|:-:|
| `session.self` | yes | yes | yes | yes |
| `staff.manage` | yes | — | — | — |
| `staff.read` | yes | — | — | — |
| `patient.create` | yes | yes | yes | — |
| `patient.read` | yes | yes | yes | yes |
| `patient.update_contact` | yes | yes | yes | — |
| `visit.schedule` | yes | yes | yes | — |
| `visit.read` | yes | yes | yes | yes |
| `visit.desk_status` | yes | yes | yes | — |
| `care.confirm` | — | yes | — | — |
| `care.correct` | — | yes | — | — |
| `care.read` | yes | yes | yes | — |
| `care.amend_site` | — | yes | — | — |
| `clinical.read` | — | yes | — | — |
| `clinical.write` | — | yes | — | — |
| `medical.declare` | — | yes | yes | yes |
| `medical.alert_presence` | — | yes | yes | yes |
| `payment.record` | yes | yes | yes | — |
| `payment.read` | yes | yes | yes | — |
| `receipt.reprint` | yes | — | yes | — |
| `adjustment.discount` | yes | yes | — | — |
| `adjustment.refund` | yes | — | — | — |
| `adjustment.void_payment` | yes | — | — | — |
| `cash.manage_period` | yes | — | — | — |
| `cash.count_submit` | yes | yes | — | — |
| `cash.review` | yes | — | — | — |
| `card.import_statement` | yes | — | — | — |
| `card.review` | yes | — | — | — |
| `paper.issue_book` | yes | — | — | — |
| `paper.enter_slips` | yes | yes | yes | — |
| `paper.custody` | yes | yes | — | — |
| `paper.read` | yes | yes | — | — |
| `exceptions.read` | yes | — | — | — |
| `exceptions.resolve` | yes | — | — | — |
| `audit.checkpoint` | yes | — | — | — |
| `audit.verify` | yes | — | — | — |
