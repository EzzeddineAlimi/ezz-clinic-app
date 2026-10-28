Status: RESEARCH/REQUIREMENTS DRAFT by Claude Opus 5.5, 2026-10-28 — not clinical validation; fictional data only

# EZZ Clinic: clinical domain requirements (dental)

**Audience:** backend developers, the UI designer (Astra), and the Founding Council.
**Scope:** workflows, data, states, permissions, validation and non-visual accessibility. This document does not cover visual design.
**Context:** small Tunisian private practices with one dentist-owner, usually one receptionist, and many elderly patients without smartphones. The app is bilingual in French and Arabic (RTL).

## 0. How to read the labels

| Label | Meaning |
|---|---|
| **ESTABLISHED STANDARD** | Taken from an international standard or a recognised clinical guideline, with the source cited. |
| **VENDOR PRACTICE** | Common in dental practice software. This is evidence of what is normal, not of what is correct. |
| **ASSUMPTION** | A reasoned design choice by the author. It can be changed. |
| **UNVERIFIED-LOCAL** | Depends on Tunisian law or practice and **must be reviewed by practising Tunisian dentists (and counsel where legal)** before clinical release. |

This document builds on the existing schema (migration `0002`): `care_items`, `visits`, `patients`, the four roles, and the append-only hash-chained audit. It also builds on council row R35/U4. The Tunisian legal points already logged (Décret 73-259 Art. 31; Law 2004-63 Art. 62-65; INPDP; PLO 95/2025 status unverified) are referenced here but not re-researched.

---

## 1. Tooth numbering, surfaces and regions

### 1.1 Canonical storage: FDI / ISO 3950

- **ESTABLISHED STANDARD.** ISO 3950:2016 "provides a system for designating teeth or areas of the oral cavity using two digits". It replaced ISO 3950:2009 and is listed as current [S1]. Quadrants are numbered 1 to 4 for permanent teeth: upper right, upper left, lower left, lower right. Primary teeth use quadrants 5 to 8 with positions 1 to 5. Positions count from the central incisor distally [S2][S3].
- **ESTABLISHED STANDARD.** ISO 3950 also defines **area codes**: 00 for the entire oral cavity, 01 maxillary, 02 mandibular, 03 to 08 for the sextants (03 upper right, 04 upper anterior, 05 upper left, 06 lower left, 07 lower anterior, 08 lower right), 09 for another area, and 10/20/30/40 for the quadrants [S4][S5]. The standard's principles add that "replacement of a zero by a nine identifies the presence of an anomaly in that specific area" [S4].
- **ESTABLISHED STANDARD (codes UNVERIFIED).** Supernumerary teeth are covered by a separate standard, **ISO 10394:2023**. It uses two alphanumeric characters compatible with ISO 3950 and does not reuse any ISO 3950 code [S6]. The actual code assignments are behind a paywall and **were not verified**.
- **VENDOR PRACTICE.** Tunisian vendors advertise FDI odontograms (dentalcare.tn, dentisys.tn, smartclinic.tn; see council R35/U4).
- **Decision (ASSUMPTION).**
  - Store `tooth_fdi smallint` exactly as the existing CHECK does: 11-48 with position 1-8, and 51-85 with position 1-5.
  - Add a separate `area_code smallint` with CHECK `IN (0,1,2,3,4,5,6,7,8,9,10,20,30,40)`.
  - Each tooth-linked record carries **exactly one** of `tooth_fdi` or `area_code`. The exception is a record that is explicitly "no anatomical site" (for example a consultation), which carries `site_kind='NONE'`. Today a NULL `tooth_fdi` is ambiguous: it could mean "full mouth" or "not recorded". The new column removes that ambiguity.
  - Until ISO 10394 is checked, store supernumerary teeth as `supernumerary=true` + `adjacent_tooth_fdi` + `position_note`. Do not invent codes.

### 1.2 Display and conversion

The app always stores FDI and converts only for display (ASSUMPTION). Default display is FDI.

| System | Status | Use in EZZ |
|---|---|---|
| FDI / ISO 3950 | ESTABLISHED STANDARD | Stored and shown by default. Always read aloud as two separate digits: "un-six" / "واحد-ستة", never "seize". This prevents 16 being heard as 60 (ASSUMPTION). |
| ADA Universal | US convention: permanent teeth 1-32 starting at the upper right third molar; primary teeth A-T [S7] | Optional read-only display, for US-trained readers or imported documents. Never accepted as input in v1. |
| Palmer | Quadrant bracket glyphs U+23BE..U+23CC with 1-8 or A-E. Known reproduction problems in electronic records [S8] | Not supported in v1. The glyphs are fragile in RTL and in fonts. |

Conversion rules (derived from the cited definitions and checked arithmetically; covered by unit tests):

- **Permanent FDI to Universal:** Q1: `9-p`; Q2: `8+p`; Q3: `25-p`; Q4: `24+p`. Examples: 18→1, 28→16, 38→17, 48→32.
- **Primary FDI to Universal letter index (A=1):** Q5: `6-p`; Q6: `5+p`; Q7: `16-p`; Q8: `15+p`. Examples: 55→A, 65→J, 75→K, 85→T.
- **Successor of a primary tooth:** `(q-4)*10 + p`. Examples: 55→15, 74→34.

### 1.3 Surfaces

The DB allows `^[MODBLIFP]{1,5}$`. Application validation must be stricter (ASSUMPTION, based on standard dental anatomy):

| Letter | Meaning | Valid on |
|---|---|---|
| M / D | Mesial / Distal | All teeth |
| O | Occlusal | Posterior teeth only: positions 4-8 permanent, 4-5 primary |
| I | Incisal | Anterior teeth only: positions 1-3 |
| B | Buccal | Posterior teeth. **Canonical vestibular letter.** |
| F | Facial / labial | Anterior teeth. Treated as a synonym of B for vestibular. Store **B** for posterior and **F** for anterior. |
| L | Lingual | Mandibular teeth: quadrants 3, 4, 7, 8 |
| P | Palatal | Maxillary teeth: quadrants 1, 2, 5, 6 |

Rules:
- Letters are stored in canonical order M,O,I,D,B,F,L,P, with no duplicates. O and I are mutually exclusive. B and F are mutually exclusive. L and P are mutually exclusive.
- Example: "MOD" on tooth 36 is valid. "MOD" on tooth 11 is rejected, with the suggestion "MID".
- Requiring L/P by arch is UNVERIFIED-LOCAL. French-trained dentists often write "V" (vestibulaire) for buccal/labial. Ask whether the UI should show **V** while storing B/F.

### 1.4 Root and canal level

- ASSUMPTION: endodontic records need `root` and `canal` labels, for example MB, MB2, DB, P on 16, or M, D on 46.
- Store these as a validated text field (`^[A-Z0-9]{1,4}$`) on endodontic detail rows. Working length is in **mm with one decimal**, and the reference point is recorded.
- Root/canal detail is not a billing key. Billing stays per procedure and per tooth.

---

## 2. Odontogram data model (non-visual)

### 2.1 Four record kinds that must never mix

The source for this split is R35/U4 plus ADA charting guidance [S9]. It is ASSUMPTION as a design.

| Kind | Who records | Billable? | Example |
|---|---|---|---|
| **EXISTING** (prior work, often by another dentist) | Dentist or assistant-draft | Never | "Crown on 26, done elsewhere, about 2015" |
| **FINDING / DIAGNOSIS** | Dentist (assistant may draft) | Never | "Caries 36 MO", "Periapical lesion 21" |
| **PLANNED** (treatment-plan item) | Dentist | Never | "Composite 36 MO, phase 1" |
| **COMPLETED** = `care_items` row | Dentist only (existing rule) | **Yes. This is the only billable kind.** | "Composite 36 MO confirmed 2026-10-28" |

### 2.2 Tooth state (derived, append-only events)

A tooth's current state is **computed from the latest non-errored events** and never stored as a mutable cell (ASSUMPTION).

Allowed states:

- `PRESENT_SOUND`
- `UNERUPTED`
- `PARTIALLY_ERUPTED`
- `IMPACTED`
- `MISSING_CONGENITAL`
- `MISSING_UNKNOWN`
- `EXTRACTED` (with date and with/without a link to a care item)
- `EXFOLIATED` (primary teeth only)
- `IMPLANT`
- `CROWN`
- `BRIDGE_ABUTMENT`
- `BRIDGE_PONTIC` (the tooth is absent and replaced by a pontic; the brief's "pontoon" means pontic)
- `ROOT_CANAL_TREATED`
- `ROOT_REMNANT`
- `REMOVABLE_PROSTHESIS_REPLACED`

Some states are additive flags rather than a single state. For example, a tooth can be root-canal treated **and** crowned. So the model is: one **presence state**, plus a set of **restoration/condition attributes**.

Each event records:
- author, author role, `recorded_at` (server time), and `effective_at` (when it clinically happened, which may be earlier)
- source: `THIS_CLINIC` / `PATIENT_REPORT` / `EXTERNAL_RECORD`
- optional visit, optional image, and optional care item/plan item link
- `supersedes_id` for corrections, or `entered_in_error_of_id`

### 2.3 Dentition transitions

The age-based dentition rules below are ASSUMPTION; ages are not hard rules and are a question for dentists.

- **Dentition mode per patient:** `PRIMARY` / `MIXED` / `PERMANENT`. This is suggested from date of birth but **always confirmed by the dentist**.
- Primary and permanent teeth at the same position (for example 55 and 15) can coexist in MIXED mode. Both must be addressable.
- **Exfoliation or extraction of a primary tooth:**
  1. Recording 55 as EXFOLIATED or EXTRACTED does **not** automatically mark 15 as PRESENT. The app *offers* a prompt to record the state of 15 (e.g. UNERUPTED / PRESENT / MISSING_CONGENITAL).
  2. Agenesis must remain recordable, e.g. 55 retained with 15 missing.
- **Guard:** entering a primary code (5x-8x) for a patient whose age is ≥ 14 and who is in PERMANENT mode requires an explicit "retained primary tooth" confirmation. The reverse case requires a confirmation as well. See risk R5.

---

## 3. Treatment plans

The structure follows R35/U4 and VENDOR PRACTICE. Details are ASSUMPTION.

- **Plan** → **version** (a quote, "devis"). Versions are immutable once presented. A change creates a new version.
- Each version → **items** with:
  - tooth or area, surfaces, procedure code/label
  - `phase_no` (1 = urgent/pain, 2 = disease control, 3 = restorative/prosthetic, 4 = maintenance; the phase labels are configurable)
  - `alternative_group` (e.g. "36: implant **or** bridge **or** nothing"; a patient accepts one option per group)
  - fee in millimes, copied from a **fee schedule version**
- **Lifecycle (plan-version level):** `DRAFT → PRESENTED → ACCEPTED (full/partial) | DECLINED | EXPIRED → SUPERSEDED`.
- **Lifecycle (item level):** `PROPOSED → ACCEPTED → SCHEDULED → IN_PROGRESS → COMPLETED | CANCELLED | DECLINED`.
  - `COMPLETED` is set **only** by linking a confirmed `care_items` row.
  - Multi-visit items such as a root canal or crown stay `IN_PROGRESS` until the final care item. Intermediate-stage billing is a question for dentists (Q11).
- **Acceptance = consent event** (see §6). It stores:
  - which version and which alternatives were accepted
  - who accepted (patient or guardian), the method and witness
  - the paper document scan reference
- **Dentist-only actions:** create/edit a draft, present it, set fees below the schedule (a discount needs a reason), mark accepted alternatives, cancel with a clinical reason.
- **Receptionist actions:** print a presented version, and record a *payment plan* against the version.
- **Fee link:** the plan fee is a *quote* only. The billable amount is always the `care_items.fee_millimes` at completion. A mismatch with the accepted quote is shown and must be explained when it exceeds a threshold (anti-fraud, ASSUMPTION).

---

## 4. Clinical notes and visit history

- **ESTABLISHED GUIDANCE** (ADA, US) [S9]:
  - belated entries and corrections "should include the date and time"
  - each entry should be attributed to its author
  - "the dentist should sign off on all entries"
  - complete notes within 24 hours
  - consider SOAP
  - "never alter the record" when facing a claim
- **Structure (ASSUMPTION).** Optional SOAP sections:
  - Subjective: chief complaint, in the patient's words, in either language
  - Objective: findings, which are linked findings rows from §2
  - Assessment
  - Plan
  - Anaesthesia block: agent, concentration, vasoconstrictor ratio, cartridges or mL, site
  - Free-text "procedure narrative"
- **States:** `DRAFT` (author only, autosaved) → `SIGNED` (dentist attests; the content hash is written to audit) → immutable.
- **After signing:**
  - `ADDENDUM`: new info, own timestamp and author.
  - `LATE_ENTRY`: `effective_at` < `recorded_at`, with a mandatory reason and a visible label.
  - `ENTERED_IN_ERROR`: wrong patient or wrong visit. The original stays readable to the dentist with a strike flag, is excluded from summaries, and needs a reason. A copy can be re-created on the right patient with a link back.
- **No deletion. No edit after signing.** This mirrors `care_items` and is enforced by `ezz_make_append_only`.
- **Copy-forward is disabled for Objective/Assessment.** Templates are allowed but must be visibly edited before signing (see R7).
- **Assistant notes** are drafts and need dentist co-signature. Unsigned drafts older than 24 h appear on the dentist's to-do list.

---

## 5. Medical history and critical alerts

### 5.1 Structured alerts

A coded list plus free text. Each alert has a severity of `CRITICAL` or `CAUTION`.

| Code | Why it matters | Source / label |
|---|---|---|
| `ALLERGY_PENICILLIN` (class: amoxicillin, amox-clav, etc.) | Dental antibiotics, IE prophylaxis | ASSUMPTION (clinical common knowledge). Drug-class mapping is UNVERIFIED-LOCAL (Tunisian brand names). |
| `ALLERGY_LATEX` | Gloves, dam | ASSUMPTION |
| `ALLERGY_LOCAL_ANAESTHETIC` (agent named; also sulfite/vasoconstrictor sensitivity) | Anaesthesia choice | ASSUMPTION |
| `ALLERGY_OTHER` (free text + agent) | | |
| `ANTICOAGULANT_VKA` (warfarin, acenocoumarol) | Bleeding; INR check | **ESTABLISHED GUIDANCE (UK SDCEP, 2nd ed., March 2022):** check INR ideally ≤ 24 h before (≤ 72 h if stable). INR < 4: treat without interrupting. INR ≥ 4: delay or refer [S10][S11] |
| `ANTICOAGULANT_DOAC` (apixaban, dabigatran, rivaroxaban, edoxaban) | Bleeding | SDCEP: drug-specific timing of the morning dose for higher-risk procedures [S11] |
| `ANTIPLATELET` (aspirin; P2Y12 inhibitors) | Bleeding | SDCEP: aspirin alone, treat without interrupting; dual/other, consult the prescriber; never interrupt in stents/metal valves [S11] |
| `ANTIRESORPTIVE_OR_ANTIANGIOGENIC` (bisphosphonate oral/IV, denosumab, etc.) + indication (osteoporosis vs cancer) | MRONJ risk before extractions/implants | **AAOMS 2022 position paper:** osteoporosis risk very low; oncology risk "considerably higher"; avoid dentoalveolar surgery where possible in oncology patients; implants contraindicated in that group [S12] |
| `PREGNANCY` (with expected date; auto-expires for review) | Imaging justification, drugs | FDI policy *Radiation Safety in Dentistry* (rev. 2026): pregnant patients and children need particular attention [S13] |
| `DIABETES` (type, control if known) | Healing, infection | ASSUMPTION |
| `CARDIAC_IE_HIGH_RISK` (prior IE; prosthetic/transcatheter valve or valve repair with material; certain congenital heart disease; VAD) | Antibiotic prophylaxis | **ESC 2023:** prophylaxis recommended for high-risk patients undergoing at-risk oral-dental procedures and not otherwise; not for cardiac implanted electronic devices (CIED) [S14][S15]. **AHA 2021:** no change from 2007; prophylaxis only for the highest-risk patients for procedures that manipulate gingiva or the periapical region or perforate the mucosa [S16][S15]. **The app must not hard-code regimens.** Doses were not verified in this research; the dentist chooses. |
| `IMMUNOSUPPRESSION`, `HEAD_NECK_RADIOTHERAPY`, `BLEEDING_DISORDER`, `EPILEPSY`, `OTHER` | | ASSUMPTION |

### 5.2 Provenance and review

- Each alert carries `source` = `PATIENT_DECLARED` (receptionist/assistant may enter) or `DENTIST_VERIFIED` (only the dentist).
  - Unverified alerts still show **as alerts**, marked "declared, not verified". They are never hidden.
- **History review:** each review records the reviewing dentist, the date, the method (`INTERVIEW` / `PAPER_FORM`; the paper form is scanned) and `next_review_due` (default 12 months, configurable; ASSUMPTION; Q5).
- **States:** `ACTIVE`, `RESOLVED` (with date and reason), `ENTERED_IN_ERROR`. All are append-only.
- **"No known allergies" is an explicit, dated assertion**, not an empty list. Empty means "never asked".

### 5.3 Display-before-treatment rule

The following must happen before a visit moves to `IN_CHAIR`, and before a prescription or a care-item confirmation can be submitted:

1. The dentist sees the alert summary.
2. The dentist **acknowledges** it in one action: the acknowledgement is recorded with the visit ID and the alert-set hash.
3. If the review is overdue, or the list is "never asked", acknowledgement requires selecting "reviewed today" or "proceed without review" with a reason.

**Stale-history risks:** a new anticoagulant, a pregnancy, or a new bisphosphonate since the last review. This is addressed by the review date, by a pregnancy auto-expiry prompt, and by a receptionist check-in question: "Has anything changed in your health or medicines?". The answer is recorded as yes/no and a "yes" flags the dentist.

---

## 6. Consent and documentation

| Item | Requirement | Label |
|---|---|---|
| Consent per plan version | Linked to the plan version and its accepted alternatives. Records the information given (risks/alternatives text version), signer, method and date. Consent can be withdrawn as a new row. | ASSUMPTION; dental consent law in Tunisia is UNVERIFIED-LOCAL |
| Consent per procedure | Optional, for extractions, surgery, implants and sedation. The dentist decides which procedures require it (configurable list). | UNVERIFIED-LOCAL |
| Refusal | "Informed refusal" is recorded the same way. ADA guidance lists consent/refusal documents as part of the record [S9]. | ESTABLISHED GUIDANCE (US) |
| Minors | Signer is `GUARDIAN` with relationship and ID note. Age of majority assumed 18. | UNVERIFIED-LOCAL |
| Illiterate patients | Methods: `WRITTEN_SIGNATURE`, `VERBAL_WITNESSED` (witness name/role, read-aloud language fr/ar/Tunisian Arabic) or `THUMBPRINT` on the paper form, which is scanned. | **Legal validity UNVERIFIED-LOCAL** |
| Photo / X-ray consent | Separate flags: clinical use (implied by treatment?), use in referral letters, **teaching/marketing (opt-in, default NO)**. | Health-data rules: Law 2004-63 Art. 62-65 (council-logged); scope UNVERIFIED-LOCAL |
| Evidence | The paper form is primary for no-phone patients. A scan is attached and hashed. The app never requires a smartphone or e-signature. | ASSUMPTION |

---

## 7. Prescriptions ("ordonnances")

- **Authoring:** only the DENTIST can author and issue. An assistant can prepare a draft, which the dentist must issue. Issued prescriptions are immutable. Voiding is a new row with a reason, and the printed copy is marked as void in the record.
- **Line fields:**
  - drug name (free text plus an optional local list; there is no national drug-database integration)
  - form, strength with unit (`mg`, `g`, `mL`, `%`, `UI`), dose
  - route, frequency, duration (days), quantity, instructions in the patient's language
- **Allergy check:** the drug class is matched against active allergy alerts.
  - A match produces a **hard stop**. Overriding it needs a reason and a second confirmation from the dentist.
  - Anticoagulant or pregnancy alerts produce a caution, not a block.
- **Printing:** one or two copies, with the patient name, age/date of birth, date, prescriber identity and signature space. Tunisian mandatory elements are unknown: CNOMDT registration number? Address? Format rules for controlled drugs? All are **UNVERIFIED-LOCAL** (Q14).
- **Validation:** units come from a list (no free-text unit), duration is ≤ 90 days, and numeric fields reject both `,` and `.` ambiguity by showing a parsed read-back ("500 mg, 3 fois/jour, 7 jours").
- A prescription is **never billable on its own** (§11).

---

## 8. X-rays and image attachments

| Topic | Requirement | Label |
|---|---|---|
| Modalities | `INTRAORAL_PERIAPICAL`, `BITEWING`, `OCCLUSAL`, `PANORAMIC_OPG`, `CEPHALOMETRIC`, `CBCT`, `INTRAORAL_PHOTO`, `EXTRAORAL_PHOTO`, `SCAN_3D` (STL/PLY), `DOCUMENT_SCAN` | ASSUMPTION |
| Formats | DICOM defines a Digital Intra-Oral X-Ray Image IOD, which inherits from the Digital X-Ray IOD [S17]. Dental DICOM interoperability is uneven: conformance statements do not guarantee interoperability, and CBCT studies are large [S18]. **v1 accepts JPEG/PNG exports plus DICOM files stored as-is (not parsed/rendered), and PDF for reports.** | ESTABLISHED STANDARD + ASSUMPTION |
| Required metadata | patient, visit (optional), modality, tooth list **or** area code, laterality check, acquisition date (may differ from upload), device/source (`IN_CLINIC_SENSOR`, `EXTERNAL_RADIOLOGY`, `PATIENT_BROUGHT`), uploader, upload time, SHA-256 of the original bytes, MIME type detected by signature, byte size | ASSUMPTION (R35/U4) |
| Dose | Optional fields: kV, mA, exposure time, DAP/DLP if the device reports them, FOV for CBCT. FDI requires justification and smallest-FOV CBCT. It does not mandate per-patient dose records [S13]. | ESTABLISHED (justification) / ASSUMPTION (fields) |
| Justification | Optional "indication" text per acquisition. Prompted for CBCT, children and pregnancy. | FDI [S13] |
| Protection | Role-based access, no public or guessable URLs, short-lived signed download per request, allowlisted types with magic-byte check, size limit (e.g. 25 MB 2D, 500 MB CBCT; ASSUMPTION), malware scan before `ACTIVE` (state `QUARANTINE`), stripping of EXIF location from photos, and every view/download written to audit. (The OWASP File Upload Cheat Sheet was the intended source; the fetch was blocked during research, so this row is general security practice.) | ASSUMPTION |
| Mis-association | Re-assigning an image to another tooth or patient creates a new association row and marks the old one `ENTERED_IN_ERROR` with a reason. It is dentist-only. | ASSUMPTION |
| Retention | Same as the clinical record. The Tunisian retention period is **UNVERIFIED-LOCAL** (Q16). | |

---

## 9. Dental laboratory workflow

ASSUMPTION/VENDOR PRACTICE, plus the **MF19** anti-fraud tie-in.

- **Lab case fields:**
  - patient, plan item(s), tooth/area
  - type (`CROWN`, `BRIDGE`, `INLAY_ONLAY`, `VENEER`, `PARTIAL_DENTURE`, `COMPLETE_DENTURE`, `NIGHT_GUARD`, `ALIGNER`, `REPAIR`, `OTHER`)
  - material, shade (system + value, e.g. "VITA classical A2"; the shade system is a question for dentists)
  - impression type (`PHYSICAL` / `DIGITAL_SCAN`, with file attachments)
  - lab (supplier list), sent date, due date, try-in stages
- **States:**
  `CREATED → SENT → (TRY_IN_RETURNED ↔ RESENT)* → RECEIVED → FITTED | REMAKE_REQUESTED → … | CANCELLED`.
  - A remake requires a reason, the responsible party (`LAB` / `CLINIC` / `PATIENT`), and links to the original.
- **Lab invoices:** supplier, invoice number, amount in millimes, linked lab case(s), scan. Lab invoices are clinic expenses, never patient billing.
- **MF19 (anti-fraud):**
  - A lab case that is `RECEIVED` or `FITTED` with **no linked confirmed `care_items` row** within N days (configurable, default 30) appears on the owner exception list.
  - A paid lab invoice whose lab case has no linked fitted care item also appears.
  - Rationale: lab work implies a billable procedure. Missing billing suggests off-book cash.
  - Read-only for the receptionist.

---

## 10. Recalls and follow-up

- **ESTABLISHED GUIDANCE (UK NICE CG19):** recall intervals are risk-based. Adults: 3-24 months; under-18s: 3-12 months. The interval is agreed with the patient, recorded, and reviewed at each oral-health review [S19]. Tunisian practice norms are UNVERIFIED-LOCAL.
- **Recall record:** reason (`CHECKUP`, `HYGIENE`, `POST_OP`, `ENDO_REVIEW`, `PROSTHESIS_CHECK`, `ORTHO`, `IMPLANT_REVIEW`, `OTHER`), due date, interval, set by (dentist for clinical intervals), status (`DUE`, `CONTACTED`, `BOOKED`, `DONE`, `DECLINED`, `LOST`).
- **Channel follows `contact_preference`:**
  - `IN_PERSON`: a printed **paper recall card** at checkout, with date, time and the clinic phone in fr/ar. The receptionist books the next visit at the desk.
  - `BASIC_PHONE_CALL`: a receptionist call list. Each attempt is logged (outcome, by whom).
  - `SMS`: only with **explicit opt-in recorded** (date, by whom). SMS content contains no clinical detail.
  - `NONE`: no outreach. The recall appears only when the patient is next seen.
- Elderly patients often come with a family member. A "contact via relative" option needs that relative's name, phone and consent (UNVERIFIED-LOCAL: data-protection basis, Q20).

---

## 11. Billing linked to confirmed clinical work

| Rule | Enforcement |
|---|---|
| Only `care_items` (DENTIST-confirmed) are billable | Already in the DB (`confirmed_by_role='DENTIST'`) |
| Findings, plan items, existing work, notes, images, prescriptions, recalls and lab cases are **never** billable | No FK path from these to billing. Payments allocate only to care items. |
| A chart edit or prescription alone creates no charge | The test asserts zero receivable after such events |
| Fee schedule versioning | `fee_schedules` (effective_from, immutable) with items. A care item records the `fee_schedule_item_id` used and the actual fee. A deviation from the schedule is shown to the owner. |
| Free care | fee 0 + reason (already enforced); reason codes are added (`WARRANTY_REDO`, `FAMILY`, `HARDSHIP`, `FOLLOW_UP_INCLUDED`, `OTHER`) |
| Corrections | Existing CORRECTION rows. Never edits. |
| Fee note | Established by the dentist (Décret 73-259 Art. 31, council-logged). The receptionist prints; the dentist confirms. |
| Insurance/CNAM forms | Out of scope v1; UNVERIFIED-LOCAL (Q18) |

---

## 12. Clinical permissions matrix

V = view, C = create, D = draft only (needs dentist signature), S = sign/confirm, R = read summary only, "—" = no access. Matrix is ASSUMPTION; legal basis Law 2004-63 Art. 62-65 (council-logged).

| Object | DENTIST | ASSISTANT | RECEPTIONIST | OWNER (non-clinician) |
|---|---|---|---|---|
| Patient identity/contact | V C | V | V C | V |
| Critical alert **presence** ("alert: see dentist") | V | V | V | — |
| Alert detail / medical history | V C S | V D | C (patient-declared at intake only; cannot view others' entries) | — |
| Odontogram findings / existing work | V C S | V D | — | — |
| Treatment plan | V C S | V | V (presented versions, totals, print) | R (totals) |
| Clinical notes | V C S | V D | — | — |
| Consent records | V C S | V C (witness) | V C (witness, scan upload) | — |
| Prescriptions | V C S | V D | Reprint of issued only | — |
| Images | V C, reassign | V C | Upload `DOCUMENT_SCAN` only | — |
| Lab cases | V C S | V C | V (status, dates) | R (exceptions) |
| Care items (billable) | V C S | — | V (label, tooth, fee) | V (label, fee) |
| Recalls | V C | V C | V C (contact log) | R (counts) |
| Fee schedule | V C | — | V | V C (with dentist countersign? Q9) |

- Note: a person may hold OWNER+DENTIST. In that case the permissions are the union of the two roles. The OWNER-only column applies to a **non-clinician owner**.
- **Break-glass (ASSUMPTION):**
  - Use cases: a substitute dentist ("remplaçant"), or an assistant needing allergy detail in an emergency.
  - The grant is time-limited (≤ 8 h), reason required, granted by a DENTIST, or self-invoked by a DENTIST-role user not assigned to the patient.
  - Each grant is written to audit and listed on the owner/dentist review page.
  - There is no break-glass for receptionist/owner into clinical detail.

---

## 13. Clinical safety risk register

| # | Hazard | Mitigation (requirement) | Testable acceptance criterion |
|---|---|---|---|
| R1 | Wrong patient | Patient banner with full name, file number, age, and alert presence on every clinical screen. Two identifiers (name + date of birth or file number) are read back before sign or confirm. Switching patients warns if a draft is open. | Sign/confirm API rejects requests whose `patient_id` ≠ the context patient. The e2e test switches patients mid-draft and expects a blocking warning. |
| R2 | Wrong tooth or side | FDI is spoken and written as digits with a quadrant phrase ("16 — haut droit / علوي أيمن"). Surface validity is checked per §1.3. Extraction of a tooth already `EXTRACTED`/`MISSING` is blocked. | Unit tests: `MOD` on 11 is rejected; extraction of a missing tooth is rejected; read-back text contains the quadrant label in both languages. |
| R3 | Unit confusion (money, dose) | Money in millimes, shown as `25,000 DT` (fr) with explicit "dinars" in read-back. Dose units come from a list. Thousand and decimal separators are never both accepted in one field. | `"25.000"` and `"25,000"` must both parse to 25 000 millimes in a fee field, or the field rejects input; the parse result is shown before save. Dose fields reject a missing unit. |
| R4 | Missing or stale allergy display | Rule §5.3 (acknowledgement gate). "Never asked" differs from "none". | A prescription with an amoxicillin line for a patient with `ALLERGY_PENICILLIN` returns a hard stop. `IN_CHAIR` transition without acknowledgement is rejected. |
| R5 | Mixed dentition errors | Dentition mode, age guard, successor prompt, both 55 and 15 addressable. | Primary code for a 30-year-old needs a "retained primary" flag. The 55→15 prompt is offered but does not auto-set. |
| R6 | Image mis-association | Required tooth/area and acquisition date, hash, reassignment workflow, thumbnail plus metadata read-back before attach. | Duplicate SHA-256 upload to a *different* patient shows a warning. Reassign leaves an `ENTERED_IN_ERROR` trail. |
| R7 | Copy-paste notes | No copy-forward for O/A sections. Templates must be modified. Identical-text detection across patients. | Signing a note whose O section is byte-identical to another patient's note from the same day requires confirmation. |
| R8 | RTL/bidi corruption of tooth numbers and codes | Tooth codes, surfaces, doses and money are rendered in **LTR isolates** (Unicode UAX #9 isolates, e.g. FSI/LRI…PDI, or `<bdi>`/`dir="ltr"`) [S20]. Bidi override characters (LRO/RLO) are stripped from all input. Tooth codes are stored as integers, never as text. | Snapshot test: AR UI string "سن 16 MOD" keeps "16 MOD" order. Input containing U+202E is rejected or sanitised. Printed fr/ar prescriptions show identical numerals. |
| R9 | Billing without clinical basis / missing billing (MF19) | Rules in §9 and §11 | Lab case FITTED + 30 days without a care item appears on the owner exception list. |
| R10 | Unauthorised clinical access | Matrix §12, audit of all views of history, images and notes | Receptionist GET on note/history detail returns 403 and a `security_denials` row is written. |

---

## 14. Non-visual requirements for Astra

**Screens and their required fields:**

- **Patient intake:**
  - required: family name, given name, date of birth (or "unknown", with age estimate), sex, preferred language, contact preference, health questionnaire answered yes/no/"to ask dentist"
  - optional: Arabic name, phone (required only for SMS/phone preference)
- **Pre-treatment alert acknowledgement:** alert list (critical first), source, last review date, a single acknowledge action, and the "review today / proceed with reason" choice.
- **Chart entry:**
  - Patient → kind (finding/existing/plan) → tooth or area → surfaces → condition/procedure → read-back → save.
  - Keyboard path: type "36", press Tab, type "MO", press Tab, pick the procedure from a typeahead, press Enter, read the read-back, press Enter to confirm.
  - No mouse-only paths and no drag-only interactions.
  - The odontogram must have an equivalent **list/table mode** (tooth number, state, findings) for screen readers and keyboard users.
- **Care confirmation (dentist):** procedure, tooth/area, surfaces, fee (prefilled from the schedule; a deviation needs a reason), free-care reason when the fee is 0. The read-back states patient, tooth with quadrant phrase, procedure and amount in words for both money and tooth.
- **Prescription:** see §7. The read-back sentence is printed exactly as shown.
- **Consent capture:** method, signer type, witness when verbal or thumbprint, scan attached (it can be added later; the state shows `PENDING_SCAN`).
- **States to expose (text, not colour only):** every status in §§3, 4, 5, 7, 8, 9, 10. "Declared, not verified" and "entered in error" must be **text labels**, not only styling.
- **Validation messages:** in the user's language, naming the field and the fix ("La face O n'existe pas sur une incisive : utilisez I").
- **Terminology:** FR and AR clinical glossary is required. Examples:
  - carie / تسوس
  - couronne / تاج
  - extraction / قلع
  - dent de lait / سن لبني
  - vestibulaire / دهليزي
  - palatin / حنكي
  - lingual / لساني

  Whether Tunisian dentists use MSA, French or Derja terms in the AR UI is a question for dentists (Q21).
- **Elderly / no-phone paths:** every outreach has a paper or in-person path. The printed card and prescription use large type; the size is a function of print settings, not the UI. No step depends on the patient owning a phone.
- **200% zoom:** all workflows must remain operable with no loss of content or function and no two-dimensional scrolling for forms. The odontogram table mode is the fallback when the graphic cannot fit. The patient banner and alert presence must remain visible or reachable in one keystroke.
- **Timeouts:** drafts autosave. No clinical data is lost on session expiry.

---

## 15. Questions for practising Tunisian dentists (before clinical release)

1. Do you chart in FDI only? Do you ever receive Universal or Palmer notation?
2. Surfaces: do you write V (vestibulaire) or B/F? P vs L for the upper arch?
3. Supernumerary teeth: how do you record them today?
4. Which tooth states and conditions do you need on day one (§2.2)? Are any missing?
5. What is a realistic medical-history review interval? Do you use a paper questionnaire? In which language?
6. Which alerts must block treatment versus warn only?
7. Which IE prophylaxis guidance do you follow (ESC, AHA, Tunisian)? Should the app show a reference link only?
8. Treatment plan phases: what are your usual phase names? Are quotes ("devis") signed by patients today?
9. Who can change the fee schedule in a dentist-owned versus a non-dentist-owned clinic?
10. Discounts and free care: which reasons are legitimate and common?
11. Multi-visit procedures (endo, crown): bill per stage or at completion? How do you currently handle deposits?
12. Consent: is written consent legally or ordinally required for any dental procedures in Tunisia? Do you use a standard form?
13. Minors and illiterate patients: who signs? Is a thumbprint plus witness accepted? Is verbal consent with a witness acceptable?
14. Prescription mandatory elements: registration number, address, format, carbon copy, controlled drugs?
15. Do you need a local drug list? Which antibiotics and analgesics are most prescribed?
16. Retention period for dental records and radiographs in Tunisia?
17. X-ray sources: which sensors and panoramic units are common? Which export formats (DICOM, JPEG)? Do you record dose?
18. CNAM: do you fill reimbursement forms that should be generated from care items?
19. Laboratory: typical turnaround time, shade system, how remakes are paid, invoice frequency?
20. Recall by relative: is it acceptable to call a family member? Is consent needed?
21. Arabic terminology for dental terms in the UI: MSA, French loanwords or Derja? Western digits in Arabic text?
22. Should a non-dentist owner see procedure labels on billing, given professional secrecy?
23. Break-glass: how do substitute dentists ("remplaçants") access records today?
24. What counts as "completion" for a visit with several procedures? Should the first confirmation mark the visit COMPLETED (current behaviour)?
25. Should the assistant be allowed to record findings as drafts?

---

## 16. Suggested next DB tables (future migration `0008_clinical_*`)

All tables follow existing conventions:
- `clinic_id uuid NOT NULL REFERENCES clinics(id)`, `UNIQUE (clinic_id, id)`
- composite FKs `(clinic_id, x_id)`
- `ezz_enable_tenant_rls`, and `ezz_make_append_only` unless stated otherwise
- changes are new rows with `supersedes_id` / `entered_in_error_of_id` plus `reason` (length ≥ 3)
- authors are `(clinic_id, staff_id)` with `*_role` CHECKs
- money in `bigint` millimes

Shared site check (domain or CHECK copied into each table):
`tooth_fdi` (same CHECK as `care_items`), `area_code smallint CHECK (area_code IN (0,1,2,3,4,5,6,7,8,9,10,20,30,40))`, and `CHECK (num_nonnulls(tooth_fdi, area_code) <= 1)`.

| Table | Key columns | Notable constraints |
|---|---|---|
| `dentition_modes` | patient_id, mode (`PRIMARY`/`MIXED`/`PERMANENT`), set_by, set_at | latest row wins; set_by role DENTIST |
| `chart_events` | patient_id, visit_id?, kind (`EXISTING`/`FINDING`/`STATE`), tooth_fdi?, area_code?, supernumerary bool, adjacent_tooth_fdi?, surfaces?, root_canal?, presence_state?, condition_code, source, effective_at, recorded_by, recorded_role, signed_by?, care_item_id?, image_id?, supersedes_id?, entered_in_error_of_id?, reason | surfaces regex as `care_items`; `supersedes_id`/`entered_in_error_of_id` → same table; supernumerary ⇒ adjacent_tooth_fdi NOT NULL |
| `medical_alerts` | patient_id, code, severity, detail, agent?, source (`PATIENT_DECLARED`/`DENTIST_VERIFIED`), status (`ACTIVE`/`RESOLVED`/`ENTERED_IN_ERROR`), recorded_by, verified_by?, supersedes_id? | `DENTIST_VERIFIED` ⇒ verified_by NOT NULL (role DENTIST) |
| `medical_history_reviews` | patient_id, reviewed_by, reviewed_at, method, no_known_allergies bool, next_review_due, document_id? | reviewed_by role DENTIST |
| `alert_acknowledgements` | visit_id, patient_id, acknowledged_by, alert_set_hash, review_choice, reason? | needed for visit → `IN_CHAIR` (enforced in service + test) |
| `fee_schedules` / `fee_schedule_items` | effective_from, created_by; procedure_code, label_fr, label_ar, fee_millimes | items immutable; UNIQUE (clinic_id, schedule_id, procedure_code) |
| `treatment_plans` | patient_id, created_by, title | |
| `treatment_plan_versions` | plan_id, version_no, status, fee_schedule_id, total_millimes, presented_at?, supersedes_version_id? | UNIQUE (clinic_id, plan_id, version_no); status changes via `plan_version_events` |
| `treatment_plan_items` | plan_version_id, phase_no, alternative_group?, tooth_fdi?/area_code?, surfaces?, procedure_code, fee_millimes ≥ 0 | immutable with the version |
| `plan_item_events` | plan_item_id, status, care_item_id?, by, reason? | `COMPLETED` ⇒ care_item_id NOT NULL |
| `consent_records` | patient_id, scope (`PLAN_VERSION`/`PROCEDURE`/`IMAGING`/`PHOTO_TEACHING`/`SMS`), plan_version_id?, decision (`GIVEN`/`REFUSED`/`WITHDRAWN`), signer_kind, signer_name, relationship?, method, witness_staff_id?, witness_name?, info_text_version, document_id?, recorded_by | `VERBAL_WITNESSED`/`THUMBPRINT` ⇒ witness present |
| `clinical_notes` | patient_id, visit_id, kind (`NOTE`/`ADDENDUM`/`LATE_ENTRY`/`ENTERED_IN_ERROR`), parent_note_id?, s_text, o_text, a_text, p_text, anaesthesia jsonb?, author_id, author_role, effective_at, signed_by?, signed_at?, content_sha256 | DRAFT lives in a separate mutable `clinical_note_drafts` table (only drafts mutable); signed rows append-only |
| `prescriptions` / `prescription_lines` | patient_id, visit_id, issued_by (DENTIST), issued_at, language, void_of_id?, reason?; drug_name, strength, unit, dose, route, frequency, duration_days, quantity, instructions, allergy_override_reason? | unit from list; duration_days 1-90 |
| `clinical_images` | patient_id, visit_id?, modality, acquired_at, source, device_label?, uploaded_by, sha256 (`^[0-9a-f]{64}$`), mime, byte_size, storage_key (never a URL), status (`QUARANTINE`/`ACTIVE`/`REJECTED`), dose jsonb?, indication? | UNIQUE (clinic_id, patient_id, sha256) |
| `image_sites` | image_id, tooth_fdi?/area_code?, by, entered_in_error_of_id? | reassignment = new row |
| `lab_suppliers`, `lab_cases`, `lab_case_events`, `lab_invoices` (+ `lab_invoice_cases`) | case: patient_id, plan_item_id?, type, material, shade_system, shade, impression_type, due_date; event: status, by, remake_reason?, responsible?; invoice: supplier_id, number, amount_millimes, document_id | UNIQUE (clinic_id, supplier_id, number); MF19 view joins to `care_items` |
| `recalls` / `recall_contacts` | patient_id, reason, interval_months, due_date, set_by, status; contact: channel, outcome, by, at | interval 1-24 |
| `break_glass_grants` | staff_id, patient_id, granted_by, reason, starts_at, expires_at | expires_at − starts_at ≤ 8 h |
| `care_items` additions | nullable `area_code`, `plan_item_id`, `fee_schedule_item_id`, `free_reason_code` | additive ALTER; existing rows untouched; same site CHECK |

---

## Sources (all accessed 2026-10-28)

- [S1] AFNOR Boutique, ISO 3950:2016 record: https://www.boutique.afnor.org/en-gb/standard/iso-39502016/dentistry-designation-system-for-teeth-and-areas-of-the-oral-cavity/xs127557/126470
- [S2] anatomy.app, "ISO-3950 dental notation system": https://anatomy.app/article/dental-notation-systems/iso-3950-dental-notation-system
- [S3] Wikipedia, "FDI World Dental Federation notation" (secondary; primary-teeth quadrants 5-8): https://en.wikipedia.org/wiki/FDI_World_Dental_Federation_notation
- [S4] ANSI webstore preview, ISO/ANSI/ADA Specification No. 3950-2010 (area codes 00-05, 10-40; "zero by nine" anomaly principle): https://webstore.ansi.org/preview-pages/ADA/preview_ISO+ANSI+ADA+Specification+No.+3950-2010.pdf
- [S5] ResDAC, "Tooth/Oral Cavity Area Designated Code" (full 00-09, 10-40 list): https://resdac.org/cms-data/variables/tooth-oral-cavity-area-designated-code
- [S6] DIN Media, EN ISO 10394:2024 (ISO 10394:2023, supernumerary teeth): https://www.dinmedia.de/en/standard/din-en-iso-10394/378268835
- [S7] Wikipedia, "Universal Numbering System": https://en.wikipedia.org/wiki/Universal_Numbering_System
- [S8] Wikipedia, "Palmer notation": https://en.wikipedia.org/wiki/Palmer_notation
- [S9] American Dental Association, "What and How to Write, or Change, in the Dental Record": https://www.ada.org/resources/practice/practice-management/writing-in-the-dental-record
- [S10] SDCEP, Management of Dental Patients Taking Anticoagulants or Antiplatelet Drugs (2nd ed., March 2022): https://sdcep.org.uk/published-guidance/anticoagulants-and-antiplatelets/
- [S11] SDCEP Quick Reference Guide, 2nd ed.: https://www.SDCEP.org.uk/media/imrflqss/sdcep-anticoagulants-quick-reference-guide-2nd-edition.pdf
- [S12] AAOMS, Medication-Related Osteonecrosis of the Jaw – 2022 Update (position paper PDF): https://aaoms.org/wp-content/uploads/2024/03/mronj_position_paper.pdf
- [S13] FDI World Dental Federation, Policy Statement "Radiation Safety in Dentistry" (revised 2026): https://fdiworlddental.org/sites/default/files/2026-04/DPS1-Radiation-Safety-in-Dentistry.pdf
- [S14] American College of Cardiology summary, "2023 ESC Guidelines for Management of Endocarditis: Key Points": https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2023/08/29/20/49/2023-esc-guidelines-for-endocarditis-esc-2023
- [S15] SDCEP Antibiotic Prophylaxis, "ESC and AHA guidelines" overview: https://www.antibioticprophylaxis.sdcep.org.uk/implementation-advice/overview-of-other-guidelines/esc-and-aha-guidelines/
- [S16] Wilson WR et al., AHA Scientific Statement 2021, PubMed abstract: https://pubmed.ncbi.nlm.nih.gov/33853363/
- [S17] DICOM PS3.3 2024c, A.28 Digital Intra-Oral X-Ray Image IOD: https://dicom.nema.org/medical/dicom/2024c/output/chtml/part03/sect_A.28.html
- [S18] Burgess J., "Digital DICOM in Dentistry", The Open Dentistry Journal 2015;9:330: https://opendentistryjournal.com/VOLUME/9/PAGE/330/FULLTEXT/
- [S19] NICE CG19, Dental checks: intervals between oral health reviews, recommendations: https://www.nice.org.uk/guidance/CG19/chapter/recommendations
- [S20] Wikipedia, "Unicode bidirectional algorithm" (summarising UAX #9 isolates and override risks; normative text: https://www.unicode.org/reports/tr9/): https://en.wikipedia.org/wiki/Unicode_bidirectional_algorithm

**Research limits:**
- The AHA "Top Things to Know" page and the OWASP File Upload Cheat Sheet could not be fetched.
- The PubMed abstract for the AAOMS paper returned a CAPTCHA, so the AAOMS PDF was used instead.
- ISO 3950 and ISO 10394 full texts are paywalled; only previews and secondary listings were read.
- No Tunisian primary legal text was re-checked in this pass.
