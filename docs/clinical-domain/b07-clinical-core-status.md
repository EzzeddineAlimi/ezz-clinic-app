# B07 dentist clinical core — implementation status (fictional data only)

Branch `claude/b07-clinical-core`, migration `backend/migrations/0008_clinical_core.sql`, modules `medical.ts`, `clinical.ts`, changes in `care.ts`, `patients.ts`, `workbench.ts`. API: [`../api/clinical-v1.md`](../api/clinical-v1.md). This builds a first coherent slice of `clinical-requirements.md` §2–§5, §12, §16 and the MODEL_INBOX C-172/C-173 site-amendment design. **Not approved for clinical use; not independently reviewed yet (GPT/Muse).**

## Built and tested (PostgreSQL 16, real HTTP, synthetic data)

| Area | What works | Tests |
|---|---|---|
| Shared site validator (CH-032) | One `readDentalSite()` (on PR #9's `canonicalDentalSurfaces`) for care, amendments, findings, plan items; canonical letters; surfaces need a tooth; DB CHECK for new CARE rows | `ch032-care-site-validation.test.ts` (6) |
| Duplicate-charge guard | Compares the effective canonical site (`DOM` after `MOD` no longer slips through) | T-CL-SURF-6, T-CL-AMEND-6 |
| Site amendments | Dentist-only, original immutable, linear chain (unique index + trigger proving the previous site), optimistic concurrency, fee-neutral by construction, effective site everywhere, corrections carry the effective site | `clinical-site-amendment.test.ts` (11) |
| Medical alerts | Desk declares (write-only), dentist verifies/updates/resolves via revision chains, presence-only desk summary, dentist detail | `clinical-medical-alerts.test.ts` (9) |
| History review | Dated review, explicit "no known allergies" (refused while an allergy is active), review status NEVER_REVIEWED / CURRENT / OVERDUE / CHANGED_SINCE_REVIEW | T-MED-6 |
| Display-before-treatment | Care / plan perform refused while ACTIVE alerts are unacknowledged for the visit, or with a stale `alertSetHash`; implicit acknowledgement when the hash is echoed | T-MED-4/5, T-PLAN-2 |
| Signed notes | SOAP sections, signed at creation, ADDENDUM / LATE_ENTRY / ENTERED_IN_ERROR, content hash in the audit chain (never the text), hash re-checked on read | T-NOTE-1/2 |
| Chart findings | EXISTING / FINDING on one tooth or ISO 3950 area, strike once, never billable | T-FIND-1 |
| Treatment plan | Items with PROPOSED/ACCEPTED/DECLINED/CANCELLED/COMPLETED; one-step perform creates the care item through the same path as `POST /visits/:id/care`; quote vs charged | T-PLAN-1/2 |
| Encounter / record | Visit encounter view; longitudinal record with per-tooth projection and visit timeline | T-ENC-1 |
| CH-018 extension | Desk cannot cancel / no-show a visit with a signed note or finding | T-ENC-4 |

## Deliberate design choices (for reviewers)

- **Site amendments live in their own table, not as a new `care_items` kind** (C-172 proposed a kind). Reason: `care_items` feeds every balance (`visit_balances`, `visitBalance`, payments gate, integrity check); a table with no money column makes "a clinical correction cannot change a fee" true by construction, and no existing sum/count had to change. C-172's semantics (immutable original, `correctsId`/`supersedesId`, previous/new site, reason code, optimistic concurrency, no-op refusal) are otherwise implemented as proposed.
- **No server-side draft state for notes.** Every entry is signed when written by the authenticated dentist session; drafts (autosave) are a client concern for now. A separate "sign encounter" step would add a tap without adding evidence.
- **Alert acknowledgement is folded into treatment** (echo `alertSetHash`) instead of a mandatory extra click; an explicit acknowledgement route exists for UIs that want one.
- **No enforcement for NEVER_REVIEWED / OVERDUE history** (§5.3 point 3): shown prominently, not blocking, to avoid blocking every first visit before the dentist decides the rule.
- Free text (alert detail, note text, reasons) never enters the audit payload; codes, sites and content hashes do.
- Plan items are unversioned in this slice; versions / quotes (devis) / consent can wrap them additively later (§3).

## Not built (next slices, in suggested order)

1. Receptionist/owner-visible plan summary (presented items, totals) and printable quote (§3, §12).
2. Consent records for plan acceptance (§6) — needs paper/witness workflow decisions.
3. Imaging: **metadata only after** a secured storage decision (§8). No file storage was built on purpose.
4. Prescriptions (§7) — needs clinical/legal review; no medication logic.
5. Recalls, lab cases, fee schedule (§9, §10).
6. ASSISTANT clinical access and break-glass (§12) — policy decision.
7. Integrity-check coverage of the new clinical tables (row-without-audit-event), owned by GPT B06 (`integrity.ts`).

## Clinical / legal assumptions needing a Tunisian dentist or lawyer (UNVERIFIED)

1. Surface letters and anatomy rules (B/F, L/P, O/I; French "V" vestibulaire not supported).
2. Alert code list, CRITICAL/CAUTION split, 12-month review interval.
3. Whether a signed record may be amended this way (append-only entry + visible history) under the Code de déontologie / Ordre rules and Law 2004-63.
4. Condition codes for findings (free uppercase codes today; no catalogue).
5. Whether the desk may record patient-declared health information at all, and what the desk may see (presence + "allergy on file").
6. Whether a non-clinician owner may read free-text fee-correction reasons (currently yes, per C-173, for fraud review).
7. Retention period of clinical records; data residence (CH-004/CH-006) — blocks any real data.
8. Review/overdue dates use the UTC calendar day, not Africa/Tunis.
