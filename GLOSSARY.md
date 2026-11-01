# EZZ Clinic domain glossary

**Scope:** common language for the fictional development app, reviewers, tests and product specifications. **Not** a legal, clinical or CNAM authority. Technical column names, accepted founder decisions and current API/migrations prevail if this prose falls behind. Disagreements belong in the relevant issue/ADR, never in a speculative database rename.

| Term | Meaning here | Do not confuse with |
| --- | --- | --- |
| **Clinic / tenant** | An isolated practice context derived from the authenticated session and enforced by API checks, PostgreSQL RLS and clinic-scoped keys. | A staff-entered clinic identifier in a write request. |
| **Staff account** | An individual actor with server-resolved identity and current permissions. | A shared front-desk login or an actor chosen by the client. |
| **Assigned dentist** | The practitioner scheduled for the visit. | The clinician who actually authored care; another authorized same-clinic dentist may cover, with true authorship recorded. |
| **Acting dentist** | The authenticated dentist who signs the note, finding or performed care. | A default copied from the appointment. |
| **Patient file** | The clinic-scoped patient record, matched using explicit identity confirmation when ambiguous. | A guessed person from a similar name or shared phone. |
| **Visit / appointment** | A scheduled clinical encounter with arrival and status history. | Evidence that treatment was performed or paid. |
| **Planned care / quote** | A proposed treatment or estimated fee. | Dentist-confirmed **performed care**, the clinical billing authority. |
| **Confirmed care** | A dentist-authored, authenticated performed-care fact, with corrections attributable and auditable. | A desk claim or the mere fact that an appointment ended. |
| **Recorded payment** | A durable payment fact entered through the system under the correct role and transaction rules. | Proof the physical cash was received or the card provider settled. |
| **Payment intention** | A durable attempt/recovery record used with version checks and idempotency to resolve uncertain payment outcomes. | A second payment or evidence that a bank transaction succeeded. |
| **Idempotency key** | A unique identifier bound to an immutable write intent so retrying the same request cannot silently duplicate its effect. | A user-visible receipt number or permission to submit a changed amount. |
| **Receipt** | A system-numbered record of a recorded payment or reversal, with print/reprint events. | An approved Tunisian fiscal document or verified patient handoff. |
| **Cash period** | The cash drawer's opening, movements, coverage window, count and owner close/review. | A statement about who physically held the drawer. |
| **Blind count** | A physical amount entered **without displaying the expected amount beforehand**; server controls protect the software sequence. | Independent observation of the real person counting; physical independence requires operational proof. |
| **Count discrepancy** | **Counted cash minus expected cash**, in millimes, for a submitted period count. A negative value indicates a shortage; a positive value indicates a surplus. | A determination that theft occurred or who caused it. |
| **Card desk claim** | A card payment entered by staff without verified settlement evidence. | A provider-confirmed payment. |
| **Owner-reviewed statement** | Reconciliation evidence an authorized owner imported and reviewed. | Direct verification from the card provider or a guaranteed settlement. |
| **Audit event** | An actor-attributed record of an application change in the clinic's database audit history. | Proof that an unrecorded event occurred or independent preservation outside the database. |
| **External owner checkpoint** | A snapshot of the recorded audit history that becomes independent evidence **only when the owner keeps it outside the clinic database**, allowing later comparison for changes or rollback. | The database's own checkpoint copy, physical-custody proof or evidence of unrecorded care or money. |
| **Paper outage slip** | A numbered paper record later reconciled and entered once after an outage. | An electronic write queued while offline, or proof of physical delivery without a human check. |
| **CNAM dossier** | A local, paper-oriented workflow to prepare and track an insurance-related case using recorded clinic facts. | Official CNAM eligibility, approved rates, government integration or a reimbursement guarantee. |
| **V1 scope group** | One of **61 founder-approved** first-release requirement groups. | A delivered or independently accepted feature. |
| **Tested slice** | A defined behavior tested against a known code SHA and environment. | Whole-feature acceptance, production certification or final human approval. |
| **Independent review** | Findings written by a reviewer distinct from the implementer, against the **exact current head SHA**. | A green author's CI run, a self-review or a stale pass from an earlier commit. |

### Authoritative pointers

- [Documentation index](docs/INDEX.md) and [founder-approved scope](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit) — product definitions and release scope.
- [Clinical authorship](docs/decisions/clinical-authorship.md) and [visit workbench](docs/product/visit-workbench.md) — assigned vs acting practitioner, care and balance evidence.
- [Owner financial review](docs/product/owner-financial-review.md), [payment recovery](docs/api/PAYMENT-RECOVERY.md), [security status](docs/security/security-status.md) — recorded facts, evidence levels and important limits.
- [V1 acceptance gate](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/69), [security and production gate](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) — unresolved approval work.

**Change rule:** edit a definition only with a cited accepted decision or source change, and update affected API/UX docs and tests in the same PR. Never use glossary text as permission to bypass a safety check.
