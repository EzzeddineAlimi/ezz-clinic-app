# EZZ Clinic — V1 role-based visual experience (design baseline)

Status: **proposed design foundation; Muse Ons first-pass research received, implementation-level UX review still pending**. Founder endorsed the recommended **Concept A: Clean Professional** direction on October 29, 2026. This document is a product design specification, **not** proof the screens are implemented. No production or real-patient approval.

Source of truth:
- Historical design snapshot: `main` at `406c5dd1fd16dd543f2c0b9a3a601af33ae6568b` (2026-10-29). For current implementation status, inspect live `main`, CI and Mission Control; this snapshot is not an acceptance ledger.
- 61 approved V1 groups: Mission Control `R76_FEATURE_SCOPE_DECISIONS` and `V1_ACCEPTANCE_CURRENT`.
- Clinical authorship: `docs/decisions/clinical-authorship.md`.
- Model-neutral engineering: `AGENTS.md`.
- Current fictional app screenshots: `docs/images/sprint2/`, `docs/images/sprint3b/`.
- UX coordination: GitHub issue #58. AI image studies are **references only** and may show imagined controls or text.

## Product design decisions

One **shared** accessible French + Arabic (RTL) design system and one secure app shell, with **different role-first task layouts**. Do **not** paste three generic dashboards into the product and call it finished. Each page shows the signed-in clinic, person's actual identity and current role, current patient identity (when relevant), and transparent permission limits. Design for a single receptionist and multiple dentists, elderly/basic-phone patients, paper handoffs, desktop-first workflow and useful mobile support. The dentist spends as little time in software as possible.

**Visual direction A:** primarily white / pale gray backgrounds, deep teal primary action, dark neutral type, subtle separators, restrained rounding/shadow. Medical alerts are semantic (not merely color-coded); money/custody actions have explicit authority and evidence states. No dental stock photos or decorative hero modules in active clinical/financial workflows. Typography must work in Arabic and French, numbers/dates bidi isolated, TND fixed to 3 decimal places. Use actual text contrast/focus measurements before implementing colors.

## Three workspaces, not three separate applications

### 1. Receptionist — operational speed (highest daily frequency)

**Above the fold**
- Today's appointment board by time with patient file number + verified identity, visit status, assigned dentist, reason/category at safe disclosure level, and warnings for same-dentist overlap. Allow dentist switching filters **without** granting clinical authority.
- Global patient lookup with clear ambiguous-identity choices; never auto-open a guessed chart.
- One primary task: book a visit or register a patient; one contextual action per row. Clear empty/loading/offline/retry states.
- Appointment workflow: book, arrival, cancellation, rescheduling (when backend supports it), print appointment slip. Phone-call queue only when authorized and opt-in; no patient app, kiosk or QR dependency.

**Secondary**
- Cash/card payment collection only when performed care is dentist-confirmed; expose exact due, prior payments, payment intent, reference and receipt after recording; never label staff-declared card as PSP-settled or a cash amount as independently verified.
- Payment **409 duplicate/stale/pending**: show reconciliation and exact resolution; no repeat-submit that can double charge.
- Minimal receptionist visibility of medical or guardian-sensitive fields; a desk-safe alert *presence* is not a medical clearance.

### 2. Dentist — safe clinical decisions, minimal clicks

**Above the fold**
- My day + clinic day lists. Actual signed-in author displayed clearly; **any authorized dentist in the same clinic** may take over a colleague's appointment (vacations), with action permanently attributed to the acting dentist.
- Pinned patient identity strip: name/file number, appointment/time, assigned dentist, actual actor, verification hints.
- Clinician-specific medical alerts before performing/signing care; never collapse alert absence into clinical permission.
- Quick actions only when allowed by server: enter signed SOAP note, record FDI finding, review plan, confirm *performed* care. Plans/quotes ≠ completed/billable treatment.

**Progressive detail**
- Adult and pediatric chart state, struck corrections visible with reason, planned-versus-performed distinction, signed notes (no editable rewrite), treatment plan phase/state, imaging/prescription/consent placeholders **only** with accurate 'not yet delivered' status until accepted.
- Next-visit plan and lab links after their backend acceptance. Clear consequence of signing: immutable entry + correction/addendum flow.

### 3. Owner — financial and operational oversight (not a receptionist superuser)

**Above the fold**
- Clinic-level activity and exceptions: visit coverage, unfinished care, recorded versus physically counted cash, unexplained differences, recorded card versus verifiably reconciled settlement. All evidence levels explicit; avoid 'theft proven' statements.
- A dedicated blind count entry path that **never shows expected balance before first submission**. Count → review discrepancies → authenticated approval/close. Owner should see who counted and whether count was truly independent (software cannot certify physical reality).
- Financial summary: charges, collections, patient dues, refunds/voids, exceptions with provenance, period and clinic scoping; only show aggregate figures backed by existing endpoints.

**Secondary**
- Staff/role settings, access reviews, office hours, scheduled leave, reports, exception resolution, financial export and reconciliation. Do not expose full clinical note text merely because the user is owner.

## Non-negotiable design risk states

1. Patient identity ambiguous / wrong chart / guardian authority unknown.
2. Unauthorized action and role changes; shared passwords prohibited.
3. Medical alert or treatment unconfirmed: no billing action.
4. Planned care/quote/consent versus performed, signed care clearly differentiated.
5. Payment interrupted, pending, duplicate-denied, stale version, cancelled, recorded, receipt ready, print error.
6. Blind physical cash-count form versus *post*-count review and disputed handover.
7. Card tender: `RECORDED BY STAFF` must not visually imply `PROVIDER VERIFIED` or `SETTLED`.
8. Offline/day outage: paper-first fallback with numbered documents, no promise of autonomous offline sync.
9. Signed clinical record entered in error, visibly struck with reason, authentic author unchanged.
10. Data integrity mismatch, unexpected multiple pending intents, audit discrepancy; fail closed and permit investigation.

## Screen inventory and delivery stages

| Stage | Screen | Source status at the 2026-10-29 snapshot (revalidate against live main) |
| --- | --- | --- |
| S0 | Role-aware shell, login, language switch, low-noise alerts | Basic frontend present; design unapproved |
| S1 | Receptionist appointment board, patient register/search | Functional fictional forms and tests; scheduling/leave later |
| S2 | Receptionist checkout/recovery and receipt | Integrated and tested; visual design unapproved |
| S3 | Dentist day/clinical encounter/FDI findings/plans | Integrated and tested; complete clinical UX not yet accepted |
| S4 | Owner blind count/review/close | Integrated and tested; independent custody not proved |
| S5 | Future hours/leave/rescheduling | Missing end-to-end; do not fake working buttons |
| S6 | Future quote, paper consent, prescription, imaging | Missing full implementation and local clinical/legal approval |
| S7 | Future owner analytics/CNAM paper tracking | Depends on remaining accepted APIs; do not invent data |

Build high-fidelity **1440px desktop + 390px mobile** designs and French/Arabic RTL variants for S0–S4. One real-world receptionist task should require fewer visual decisions/clicks than the current app, validated rather than assumed.

## Implementation contract

- **No backend rewrite.** A visual direction is not authority to change care/billing/cash guards.
- Define token set (colors, semantic alerts, typography, spacing, radius, shadows, density, focus); component variants for accessible buttons, money inputs, form controls, tables, lists, tabs, dialogs, notifications and paper print.
- Extract tested, reusable shell/surface primitives incrementally, then migrate one journey at a time (receptionist first). Preserve API contracts, no automatic form resubmission, frozen write idempotency key on uncertain outcomes.
- Verify `pnpm/npm` frontend typecheck/build, axe, 320/390px, 200% zoom, keyboard, RTL, print, mobile Safari limitations, and **real-PG16 API Playwright** tests. Add screenshot baselines for at least five core screens and high-risk states, not just ideal dashboards.
- No clinician's eye-candy: readability, 1–2 minute task completion and clear corrections outrank visual novelty.
- Founder reviews visuals for direction; independent reviewers inspect missing states/unsafe affordances. User does not manually run or test the app.

## U029 — paper appointment reminder (draft, not accepted)

Receptionists may prepare a large-print appointment card for a currently SCHEDULED fictional visit. The frontend re-reads the authenticated server day-board before preview and refuses missing, cancelled, no-show, or wrong-patient visits. Staff must verify the recipient privately; printed paper contains only clinic-local date/time and timezone, not the patient's name, file number, phone, medical or financial details. The card is marked fictional; printing and physical handoff are not confirmed. FR/Arabic RTL and mobile/paper-preview verification, physical printer usability and independent review remain open gates. No smartphone, QR or outbound communication is required.

If slip verification fails, no print occurs. Appointment conflicts trigger an authenticated day-board refresh; network/server/unknown failures show an explicit FR/Arabic warning that the board may be stale and must be refreshed before another card is prepared. Never automatically retry printing.
