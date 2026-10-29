# EZZ Clinic — full-stack implementation roadmap

Date: 2026-10-29 UTC. Proposal for GPT/founder review, not coding/merge/deploy permission. Depends on the [engineering audit](EZZ-FULL-ENGINEERING-AUDIT.md), [61-feature traceability](EZZ-V1-TRACEABILITY.md), [46-row CNAM traceability](EZZ-CNAM-TRACEABILITY.md) and [integration readiness](EZZ-INTEGRATION-READINESS.md). Those documents contain fixed-SHA source links and evidence classifications. Roadmap units below are recommended future draft PRs, not existing PR numbers.

## Architecture and workflow constraints

Preserve the existing Node/TypeScript/PostgreSQL16 modular monolith and pg abstraction. Recommend React/TypeScript/Vite with a reviewed auth/client/design-system ADR. Do not select new libraries to replace proven code without measured need. Named clinical authorship, immutable attributable history, integer millimes and verified evidence semantics are mandatory. Multi-dentist/multi-receptionist in one clinic and complete paper-first CNAM remain V1. No assumed CNAM API, signature assets, unverified numeric reimbursement, patient reimbursement revenue, smartphone requirement or automatic offline financial sync.

Every final artifact must be committed to shared GitHub and linked in CODEX_ENGINEERING with exact SHA/readback. No local-only final handoffs. Use new isolated branches and draft PRs. No old Claude branch pushes, rebases, merges, deployment, schedules or real patient data without explicit authority. Muse review is manually assigned by founder; no autonomous review agent/contact scheduled.

## Dependency graph

```text
R0 reproducible reviewed integrated backend
 ├─ R1 identity/access ADR → R2 production auth slices
 ├─ R3 immutable receipt/timezone decisions and repair
 ├─ R4 frontend ADR/design specs → R5 shell/design/i18n/API client
 │    ├─ R6 patient/privacy/guardian → R7 register/day-board UI
 │    └─ R8 scheduler concurrency/chairs → R7 agenda completion
 ├─ R9 clinical workbench → R10 quote/consent/fees → R11 prescription/paper
 ├─ R12 credit/deposits/bank tender → R13 custody/expense/dispute/owner review
 └─ R14 CNAM provenance/admin → R15 acts/invoice/reconciliation
      → R16 immutable prepare/issue/copy → R17 dossier/deadline/outcomes
R18 remaining parity + integrated security/a11y/performance/recovery acceptance
```

CNAM administration can follow stable identity and clinical primitives without waiting for every bank integration. Financial reconciliation must use accepted invoice/fee contracts before CNAM issuance. Regulatory evidence collection can proceed manually alongside implementation design, but does not bypass fail-closed outputs. The graph describes work dependencies; it does not authorise parallel agents or background work.

## Reviewable draft PR units

| Unit | Problem / concrete result | Dependencies | Tests / review gate | Scope mapping |
|---|---|---|---|---|
| R0a — reproducible environment and candidate manifest | Node22/PG16/scram/verified lockfile setup; exact #34+G5 candidate manifest and explicit source/dist runner commands | New coding assignment; environment network/socket provisioning | Fresh checkout/install, doctor, hash/ledger checks; no fake full-suite pass | All V1 prerequisite; existing #21–40 |
| R0b — final integrated evidence | NEW branch composition of #34+#35→#39+#36+#37+#38; retain all authorship/history | R0a, founder-authorised Muse review scopes | Full PG16 source/dist in UTC/Tunis/Toronto, realTLS, restore, crash, idempotency; exact-head review and draft PR | G1–G5 security/integration gates |
| R1 — auth/access/frontend ADRs | Agree auth transport, owner recovery, clinician session/reauth and least-privilege role semantics; confirm React/TS/Vite rationale | GPT/founder role/design decisions; audit risks02/03 | Threat scenarios, review checklist, no broad role expansion | U073/074/085/089/106 |
| R2a — identity/recovery | Implement agreed owner MFA/recovery and session protection in narrow slices | R0/R1 | Password/session theft, recovery abuse, revoke/deactivation/reauth negatives; Muse | U073/085 |
| R2b — scoped support/cover | Named limited cover and temporary visible scoped support access | R2a, privacy policy | Expiry/revoke/resource scope/cross-tenant denies, no permanent vendor access | U074/085 |
| R3 — receipt/timezone integrity | New issuing-zone snapshot; stable COPY; legacy warning; safe preview of future schedule effects | D-TZ-1..5 product/local decisions | Original+COPY before/after zone change, stale-preview409, historical grouping, DST boundaries | U054/024/063/106 |
| R4 — frontend architecture/design contract | Approve navigation, tokens, locale, component/UX specifications and API/auth contract | GPT designs + R1 | Accessible prototype acceptance using fictional patients; no independent screen invention | U081/083/084/099/102 |
| R5 — frontend foundation | Shell, reusable controls, FR/AR direction, session client, typed API boundaries and explicit loading/empty/error/offline states | R4 and reviewed API baseline | Keyboard/focus/large text, bidi money/date,401/403/409, CSP, no PHI persistence; route/bundle budget | Shared V1 foundation |
| R6a — patient/guardian/contact domain | Enquiries, assistance/guardian/disclosure authority and suppression states with history | R0/R1; qualified policy on minors/disclosure | Wrong relative/no consent/tenant leakage/ambiguous match; immutable provenance | U001/002/003/006/007/008/010/011/033/104 |
| R6b — receptionist register | Fast search/create/returning patient/walk-in UI with persistent identity context | R5/R6a | Real API browser journey, keyboard/autocomplete, Arabic search, no-phone path | U002/003/007/084/089 |
| R8a — schedule serialization | Reproduce/fix overlap race; define explicit justified override | R0, GPT conflict policy | Two concurrent same-dentist slots; rollback/no phantom success; new race regression | U012/106 |
| R8b — availability/chairs/reschedule | Add procedure durations, hours/leave/closure, optional chairs and audited reschedule lineage | R8a, role/privacy model | Same-chair races, stale preview, future-zone changes, leave and series conflicts | U013/014/016/022/105/106 |
| R7 — shared day board/agenda | Receptionist and dentist agenda/check-in with role-filtered read models, minimal print and plan-linked visits | R5/R6/R8 | Two dentists+two receptionists, stale state, arrival/cancel guards, large-print/no-phone | U012/020/022/024/029/106 |
| R9a — encounter/chart | Patient banner, source-graded alerts, primary/permanent FDI odontogram, findings versus performed care, signed note/addenda | R2/R5/R6; clinical specs | Wrong-chart switch, alert hash conflict, permission, no orphan care; keyboard/touch/native clinical validation | U009/032/034/036/089 |
| R9b — treatment plan/media | Plan phases/dependencies/next session and authorised attachment gallery | R9a; storage/screening and desk-scan policy | Concurrent perform, site amendment/fee neutrality, malware/role/tenant downloads and accessible viewing | U040/043/022 |
| R10a — effective fees and quotes | Dentist fee catalogue and immutable versioned quote acceptance snapshots | R9, pricing/format decisions | Effective-date boundaries, private fees vs CNAM tariff, edits cannot rewrite acceptance | U045/052/056 |
| R10b — consent revisions | Paper consent record and authorised scan linked to guardian/procedure/tooth/quote; changes invalidate affected consent | R6/R10a and legal/clinical consent policy | Wrong guardian/version/tooth, revised plan→needs consent, role limits | U046/047 |
| R11a — clinical paper/prescription | Approved instructions and scripts, clinician-reviewed prescription lines and identity/date print | R9/R10, qualified medication/print policy | Unsigned/wrong-clinician issue denied, exact copy, RTL/large print and native review | U031/048/049/054 |
| R11b — scoped patient copies | Authorised minimal patient chart copy and export manifest/download audit | R6/R9, retention/disclosure policy | Wrong recipient, desk bulk export denied, manifest/file completeness, holds | U055/078/079/081 |
| R12a — deposit/credit ledger | Patient-specific prepayments, allocations, corrections and exact balance statements | R0, reviewed financial model/role decisions | Idempotency, concurrent allocate/refund/void, cross-patient transfer denial; update integrity assumptions atomically | U058/059/062, MF10 |
| R12b — tender/bank evidence | Transfer tender, split legs and source-graded bank/card reconciliation | R12a, actual external statement/provider evidence | Money conservation, lag/refund matching/ambiguous rows; no staff-asserted provider verification | U063, MF06/08 |
| R13a — counted custody/expenses | Receiver-counted pending handover, separate petty vouchers/supplier bills and controlled paid evidence | R12, actual physical process and approval policy | Sender cannot self-verify receiver; pending without evidence; expense cannot hide revenue | U064/063, MF01/02/04 |
| R13b — disputes/owner review | Reasoned request/approval, aged balances/no-chase, monthly activity and concise source-graded exceptions | R12/R13a, settled dentist/owner permissions | #39 recurrence, no resolution authorises money, neutral wording, reporting sum reconciliation | U058/062/071/072, MF11/16/17 |
| R13c — lab parity | Coded slips, dentist order/fitting approval, plan/invoice reconciliation and source provenance | R9/R10/R13a | Remakes/late delivery/external evidence, assistant creation not clinical approval | U067, MF19 |
| R14 — CNAM admin/provenance | Patient/insured/guardian/practitioner data, effective affiliation snapshots, source/rule register and rights | R2/R6; CNAM field verification remains explicit | Tenant/role/stale revision, per-act historical affiliation and unknown field labels | CN-R01/02/03/20/21/29/43/46; U060/108 |
| R15 — CNAM act reconciliation | Signed acts/teeth/dentist↔invoice↔bulletin links, exact fee derivation and separate outcome amounts | R9/R10/R12 contract stability; R14 | Omitted/wrong act/tooth, duplicate association, private/reference fee distinction, reimbursement never revenue | CN-R04/05/09/10/11/30/31/32/34/35/37/40/45 |
| R16 — CNAM paper issue/copies | Labelled bilingual preparation, own-dentist issuance authentication, immutable snapshot/hash, duplicate/reprint/correction/handoff chain | R14/R15, official-field/source policy; no official facsimile assumption | Signature-image rejected, wrong author/backdate denied, copy preserves original, concurrent duplicate issuance | CN-R12/13/14/15/23/27/33/38/39/41/42/44 |
| R17a — CNAM dossier/deadlines | Evidence-graded status timeline, optional deposit proof, rule-backed warning and backlog | R16; effective rule verification | Staff report never official, last-care/zone/unknown-rule paths and safe export | CN-R16/17/22/28/36 |
| R17b — CNAM outcomes/estimator | Optional consent-based volunteered patient outcomes; unavailable estimates until all verified inputs | R17a and current rule evidence | Missing/stale tariff/rate/cap/entitlement returns no numeric result; no clinic posting | CN-R06/07/08/18/19; U108 |
| R18 — V1 parity and release | Remaining communication/admin parity, approved export/retention/ops, integrated clinical/finance/CNAM journey and premium UX | All relevant slices, local validators and founder release authority | Full source/dist/TZ/security/restore/browser/RTL/a11y/performance evidence; documented residuals and sign-offs | All61/46, U075/076/079/102 and MF selected set |

R-unit numbering is a planning label, not a promise of one PR per row. Split migrations/domain/API/UI when a reviewer cannot assess them independently, and declare required base/stack. Keep the exact-source/test/error/security meaning together for financial invariant changes. No delivery dates or staffing assumptions are invented.

## First recommended implementation sprint

**Integration reproducibility/security baseline only**, after GPT assigns it:

1. Create a new isolated integration candidate from the verified backend lineage, preserving Claude's existing heads. Compose G5 in dependency order and retain doc corrections.
2. Establish supported Node22/PG16/dependencies and test fixtures on an accessible runner; fix infrastructure failures before calling tests executed. Do not change proxy routes or request broad permissions without a necessary supported action.
3. Add the full UTC/Tunis/Toronto source+compiled matrix and explicit real-TLS skip accounting; exercise fresh/upgrade migration, synthetic whole-clinic journey, crash/idempotency and encrypted restore with external checkpoint.
4. Record exact SHA, commands, outputs/failures/skips, source-versus-CI-versus-peer evidence and security residuals. Any reproduced code defect becomes a minimal new fix branch, never a push onto old reviewed heads.
5. Deliver draft candidate and evidence for manually authorised Muse review. Stop before merge/deploy. In parallel planning terms, GPT can finalise frontend/auth/timezone specs; no background agent or screen implementation implied.

Exit criteria: reproducible runner/environment; exact-head passing required tests with justified non-passes visible; G5/G3/#21 bounded reviews scheduled by founder and resolved or explicitly blocking; founder decisions enumerated. The sprint may end with a well-evidenced blocker rather than a false green.

## Decision ledger / external dependencies

| Decision | Recommended direction | Owner / cannot assume |
|---|---|---|
| Source integration / merge strategy | New candidate and independent final-head review; preserve all prior branches | Founder authorises merge separately; GitHub auto-close is not acceptance |
| D-TZ-1..5 | Snapshot issue zone; preview old/new future appointment times and bind confirmation to a stable revision; printed patient-check list | GPT/founder with local fiscal/date validation |
| Identity/roles | Named clinician authorship, safe workstation lock/re-auth, owner MFA/recovery, least-privilege support/scan access | GPT/founder plus qualified local health-data advice |
| CNAM official inputs | Accept source-graded unknowns and honest preparation; enable numbers only with complete current validated inputs | Gemini/local qualified verification when founder requests; no assumed API |
| Print/form/fiscal | Preparation sheet V1, physical sign/stamp; calibrated preprinted V1.1 | Qualified dentist/fiscal/legal/printing validation |
| Physical cash / bank | Actual independent counts/receiver evidence and owner-held records | Clinic owner/provider; software cannot create external evidence |
| Hosting/backup/privacy | Documented jurisdiction/transfers/retention/access/key ownership and proven restore | Founder and qualified local advisers; no production deployment now |
| Frontend stack/specifications | React/TS/Vite candidate; semantic tokenised FR/AR UI | GPT design and acceptance; architecture ADR approved before implementation |
| Paper identity | Match required file number where the actual numbered slip has it | GPT/founder CH-030 decision; do not silently make unsupported physical fields mandatory |

## Definition of done per draft PR

- Problem/approved IDs, exact dependency base and before/after behaviour are reviewable; no unapproved scope change.
- Money, patient, tenant, role and evidence invariants explicitly assessed; migrations immutable, rollback/upgrade plan and API drift reviewed.
- Meaningful tests executed on the exact head where possible; failed/blocked/skipped tests visible; CI/peer evidence never labelled locally executed.
- UI includes FR/AR RTL, keyboard/focus/large text and loading/empty/error/unknown-commit/offline states with no extra clinical confirmation burden.
- Docs/API/test evidence committed and retrievable by exact SHA; draft PR accessible; new unique Codex row includes links and readback. No local-only final artifact.
- Independent adversarial review and founder decisions remain explicit. Completion of implementation is not merge/deploy/live clinical/legal readiness.
