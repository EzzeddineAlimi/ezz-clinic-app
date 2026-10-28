Status: RESEARCH DRAFT by Claude Opus 5.5, 2026-10-28 — not legal advice, not a compliance approval

# EZZ Clinic — Privacy, Local Compliance and Operational Risk

Scope: EZZ Clinic, dental-clinic management SaaS for small Tunisian private practices (dentist-owner, one receptionist, many elderly patients without smartphones). All data in this project is FICTIONAL/SYNTHETIC; nothing is deployed. This document records the research, sorts it by how reliable the evidence is, and lists the questions that only qualified Tunisian counsel, the Conseil de l'Ordre, a tax adviser or the INPDP can answer. **It approves nothing.**

## 0. Evidence labels and conventions

| Label | Meaning |
|---|---|
| **CONFIRMED** | Read in a primary text (law, decree, official authority manual). Exact phrase quoted and URL given. Note: we read official texts as published copies (INS, Council of Europe, a law-firm mirror of the decree), not from the JORT itself. |
| **SECONDARY** | Law-firm, accounting-firm, professional-body guide or press report. Plausible, but not checked against the primary text. |
| **UNSETTLED / UNVERIFIED** | Conflicting sources, no source found, a draft text, or our own interpretation. Do not build on these without counsel. |
| **ASSUMPTION** | An engineering planning figure (likelihood, RPO/RTO and similar). Not a fact about Tunisia. |

All URLs accessed 2026-10-28 unless marked as a council finding (CH-xxx). Two primary sites could not be fetched this session because the permission requests timed out: `https://www.inpdp.nat.tn` and `https://app.cnomdt.tn/docs/relatedInfo/code-deontologie-85.pdf`. Points from the second come from CH-005 only.

Key sources:
- [L] Loi organique n° 2004-63 du 27 juillet 2004, INS copy: https://www.ins.tn/sites/default/files/2020-04/Loi%2063-2004%20Fr.pdf (CH-006, re-read today)
- [D4] Décret n° 2007-3004 du 27 novembre 2007, "fixant les conditions et les procédures de déclaration et d'autorisation pour le traitement des données à caractère personnel": https://www.knobbe.com/sites/default/files/2021-04/Tunisia_2007-3004_French.pdf (mirror: https://legislation-securite.tn/wp-content/uploads/sites/5/2023/11/Decret-n°-2007-3004-du-27-Novembre-2007-Fr.pdf)
- [D3] Décret n° 2007-3003 du 27 novembre 2007, on how the INPDP operates: https://legislation-securite.tn/wp-content/uploads/sites/5/2023/11/Decret-n°2007-3003-du-27-novembre-2007fr.pdf. **UNVERIFIED** on exact title wording: the fetched copy returned the 2007-3004 text, so we did not read 2007-3003 itself.
- [M] *Manuel de procédure de l'INPDP* (Council of Europe-hosted, cover Feb 2020 / header Feb 2021): https://rm.coe.int/manuel-procedures-inpdp/pdf/1680a297e2
- [G] *Guide pratique sur la protection des données à caractère personnel*, June 2018, aimed at private-practice doctors in Tunisia and citing the INPDP and the Tunisian CNOM: https://rm.coe.int/protection-des-donnees-personnelles-guide-pratique-a-destination-des-m/1680a8dd33. **SECONDARY, provenance unclear**: the title page credits the French CNIL and the French Ordre, while the body is Tunisian.
- [CD] Code de déontologie dentaire, Décret n° 73-259 (CH-005).

---

## 1. Tunisian health-data and privacy requirements

### 1.1 Declaration and authorisation
- **CONFIRMED [L Art. 7]:** every processing operation needs a prior declaration to the INPDP. INPDP silence "dans un délai d'un mois à compter de la présentation de la déclaration, vaut acceptation."
- **CONFIRMED [L Art. 14, 15]:** processing that concerns health "directement ou indirectement" is prohibited by default ("Est interdit le traitement…"). Art. 15 allows it with an INPDP authorisation decided "dans un délai ne dépassant pas trente jours", and "Le défaut de la réponse dans ce délai vaut refus." **Silence means refusal**, the opposite of the declaration rule.
- **CONFIRMED [L Art. 62–63]:** health data may be processed on listed grounds (consent, legal requirement, public health…). It "ne peut être mis en œuvre que par des médecins" or by persons bound by professional secrecy. A doctor's communication of health data to others needs INPDP authorisation (decision within one month).
- **CONFIRMED [D4 Art. 11; M §II.A.2, II.D]:** the manual says sensitive data "doivent faire en plus l'objet d'une ou de plusieurs demande d'autorisation". In other words, health data needs an authorisation **on top of** the declaration. D4 Art. 11 names "la communication des données à caractère personnel relatives à la santé" and transfers abroad among the authorisation cases.
- **CONFIRMED [D4 Arts. 3, 4, 8, 9, 12]:** forms on paper or electronic, "signés personnellement par le responsable du traitement". Filing against receipt or by registered letter. The declaration must state the purposes, the data, the storage place and retention period ("le lieu de conservation … et sa durée"), and the security measures. Declarations: one month, silence counts as acceptance. Authorisations: one month, "L'absence de réponse … vaut refus implicite." The INPDP may demand "garanties supplémentaires" (Art. 5), and the clock stops while information is pending (Art. 6).
- **UNSETTLED [L Art. 16]:** Arts. 7, 8, 27, 28, 31 and 47 "ne s'appliquent pas" to processing "qu'exige le suivi de l'état de santé de la personne concernée". It is not clear whether this exempts a dental practice's clinical file from the Art. 7 declaration. The guide [G] says the opposite: health processing "est soumis à une déclaration et une autorisation préalable de l'Instance". **Counsel question Q1.**
- **SECONDARY [G p.9–10; DLA Piper https://www.dlapiperdataprotection.com/?t=law&c=TN]:** INPDP Délibération n° 4 of 5 September 2018 on health-data processing reportedly requires health establishments to appoint a DPO ("chargé de protection des données personnelles"), notified to the INPDP, and to keep an internal processing register. We did not find the deliberation text: **UNVERIFIED**.

**Design consequence:** each clinic (the dentist) is the controller and must file. EZZ is at most a sub-contractor (sous-traitant). The product should generate a pre-filled declaration/authorisation **data sheet** (purposes, data categories, storage location, retention, security measures) for the dentist to sign. EZZ must not file on the dentist's behalf, and must not claim the clinic is "INPDP compliant".

### 1.2 Who may process: the Art. 22 problem
- **CONFIRMED [L Art. 22]:** the natural person, or the legal representative of a legal person, who wants to process data, and their agents, must "être de nationalité tunisienne", "être résident en Tunisie", "être sans antécédents judiciaires". The article adds: "Ces conditions s'appliquent également au sous-traitant et à ses agents."
- **UNSETTLED:** how this applies to a SaaS vendor's staff, a foreign cloud operator's personnel, an outsourced IT helper, or an AI model provider. Read literally, it could rule out any non-resident developer or operator with access to production data. **This is the single most structurally important open question (Q2, Q3).**
- **CONFIRMED [L Art. 20]:** the controller "doit choisir scrupuleusement le sous-traitant", and the sub-contractor must have the technical means.

### 1.3 Who inside the clinic may see what
- **CONFIRMED [L Art. 63]:** only doctors or secrecy-bound persons. The receptionist must be bound by secrecy, through contract and through Code pénal Art. 254 (see §3).
- **SECONDARY [G p.7]:** "Quant au personnel administratif, il ne peut avoir un accès global aux dossiers des patients." This supports EZZ's split: the receptionist role sees identity, scheduling and financial data, not clinical notes, odontograms or images.

### 1.4 Patient rights
- **CONFIRMED [L Art. 32–42]:** right to "consulter toutes les données à caractère personnel la concernant" and to obtain correction or erasure (Art. 32). The right cannot be waived in advance (Art. 33). It applies "à des intervalles raisonnables et de façon non excessive" (Art. 34). Limits are narrow (Art. 35). Electronic submission of rectification requests must be possible (Art. 37). Answer and copies "dans un délai ne dépassant pas un mois" (Art. 38, 40). A disputed accuracy must be flagged until decided (Art. 39). Opposition is possible "à tout moment", and "L'opposition suspend immédiatement le traitement" (Art. 42).
- **UNSETTLED:** how Art. 42 opposition and Art. 32 erasure interact with append-only financial tables, the hash-chained audit log and accounting retention duties (Q6). Our proposed default is to keep financial and audit rows, mark them as under opposition or contested (Art. 39), and record the request. Only counsel can confirm this.
- Elderly patients without smartphones: rights requests must work **on paper at the front desk**, using a printed request form, a register entry and a printed export.

### 1.5 Retention and destruction
- **CONFIRMED [L Art. 64]:** processing must not exceed "la durée nécessaire pour la réalisation du but".
- **CONFIRMED [L Art. 45]:** data "doivent être détruites dès l'expiration du délai fixé à sa conservation". According to our read of the INS copy, the destruction is recorded by a bailiff (huissier) with an expert appointed by the Instance. **UNSETTLED** how this formality applies to a database row or a backup file (Q7). Design: **no hard-delete button.** Retention expiry produces a destruction list that waits for an owner-led, documented procedure.

### 1.6 Security obligations
- **CONFIRMED [L Art. 18–19]:** "prendre toutes les précautions nécessaires pour assurer la sécurité". Art. 19 lists equipment access control, protection of storage media against unauthorised reading or copying, after-the-fact verification of who accessed what, and "sauvegarder les données par la constitution de copies de réserve sécurisées". Our reading of the INS copy is that Art. 94 penalises breaches of Arts. 18–19; the penalty amount is **UNVERIFIED**.
- **SECONDARY [G p.8]:** "Verrouillage … automatiquement après maximum 30 minutes", up-to-date antivirus, encryption, strong authentication, monthly backups "sur 12 mois glissants", and paper files under lock. EZZ's 30-minute idle timeout matches this.

### 1.7 Breach handling
- **CONFIRMED (absence):** the articles of [L] we reviewed contain **no explicit breach-notification duty** to the INPDP or to patients.
- **SECONDARY [DLA Piper]:** Décret-loi n° 2023-17 du 11 mars 2023 on cybersecurity (ANCS) reportedly requires some entities to inform the ANCS of cyberattacks. The press summary (https://africanmanager.com/entree-en-vigueur-lundi-du-decret-loi-n-2023-17-du-11-mars-2023-fixant-les-missions-de-lagence-nationale-de-la-cyber-securite/) shows no explicit duty. **UNVERIFIED** (Q8).
- Design: an incident runbook that notifies the clinic owner, preserves evidence (audit chain, checkpoints) and leaves any regulatory notification decision to the owner and counsel.

### 1.8 Pending reform
- **UNVERIFIED (CH-021 + update):** the draft organic law on personal data (PLO 95/2025) was still in the ARP Commission des droits et libertés per press up to mid-2026. A 24 Feb 2026 hearing report says the bill provides for "la restriction du transfert ou de l'hébergement des données en dehors du territoire national", and a ministry representative said "il n'existe pas de stockage de données de santé en dehors du territoire tunisien" (https://www.tunisienumerique.com/donnees-de-sante-encadrement-renforce-et-telemedecine-discutes-au-parlement/). We found no evidence of adoption. Plan for stricter localisation.
- **SECONDARY:** Tunisia acceded to Council of Europe Convention 108 and Protocol 181 (in force 1 Nov 2017, per DLA Piper).

---

## 2. Hosting and international transfers

- **CONFIRMED [L Art. 50–52; D4 Art. 11]:** transfers abroad are banned where they could harm public security or vital interests (Art. 50). They are allowed only if the country "assure un niveau de protection adéquat" (Art. 51), and need "l'autorisation de l'Instance", decided within one month (Art. 52). Transfer without authorisation is penalised under Art. 90 (one year and 5,000 TND).
- **CONFIRMED [M §II.F.3]:** a transfer authorisation request "doit être accompagnée d'une copie des conditions générales de protection des données avec le partenaire étranger."
- **SECONDARY [G; DLA Piper]:** INPDP Délibération n° 3 of 5 Sept 2018 lists "adequate" states. DLA Piper says the list is non-exhaustive and authorisation is still required. The guide says messaging "hébergeant les données de santé en dehors de la Tunisie est à proscrire", and that remote hosting needs "un hébergeur de données de santé qualifié et accrédité". We found **no Tunisian accreditation scheme for health-data hosts**, so that phrase may have been copied from the French HDS regime. **UNVERIFIED.**
- **CH-006:** no source says local hosting is legally mandatory **today**. The reform bill and the guide both point that way.

**Data flows that count as transfers** if the receiving server or operator is outside Tunisia. Each needs INPDP authorisation plus an Art. 22 check, or must be designed out:

| Flow | Default EZZ position |
|---|---|
| Primary database (PostgreSQL) | Hosted in Tunisia (category: Tunisian data centre, colocation, or on-premises server in the clinic). No vendor recommended. |
| Backups | Same jurisdiction. Offline copy held by owner (§6). Foreign cloud object storage = transfer. |
| Email (appointment reminders, password-reset mails) | No patient clinical data in email bodies. Foreign mail relay = transfer of identity and appointment data. |
| SMS reminders | Tunisian operator or aggregator category. Message text is minimal ("RDV demain 10h"), with no treatment details. |
| Error telemetry / APM | Off by default. If enabled, Tunisian-hosted, with the §10 allow-list only. |
| AI services (transcription, summarisation, image analysis) | **Not permitted** for patient data until counsel answers Q4. Any foreign LLM API would be a transfer, plausibly an Art. 63 issue and an Art. 22 issue. |
| Remote support (screen share by EZZ staff or IT helper) | Counts as access by a sub-contractor agent (Art. 22). Owner-approved, time-boxed, logged. |
| Software updates / CDN | Code only, no data. Acceptable. |

Hosting options, as categories only: (a) Tunisian commercial data centre / IaaS; (b) colocation of a clinic-owned or EZZ-owned server in Tunisia; (c) on-premises server in the clinic with an encrypted off-site copy; (d) foreign cloud (would need a transfer authorisation; not the default).

**Technical blocker:** the in-repo PostgreSQL driver has **no TLS**. It may only be used over loopback or a local socket. Any deployment where the app and the database are on separate hosts is blocked until TLS is added.

---

## 3. Medical record access restrictions and retention

- **SECONDARY (quoted in *La Tunisie Médicale*, https://latunisiemedicale.com/index.php/tunismed/article/view/1345/339):** Code pénal Art. 254: "Les médecins, chirurgiens et autres officiers de santé ainsi que les pharmaciens … et toutes autres personnes dépositaires par état ou profession du secret qu'on leur confie … qui … auront révélé ces secrets … seront punis d'un emprisonnement de six mois et d'une amende de 120 dinars." The article number and wording are consistent with Council knowledge, but the source's reference list mislabels it "Code de procédure pénale", and we did not read the Code itself. Treat as **SECONDARY**. The phrase "toutes autres personnes dépositaires par état ou profession" plausibly covers the receptionist and possibly EZZ operators (Q9).
- **CH-005:** the Code de déontologie dentaire was not re-fetched (blocked). Its secrecy and record articles were not verified this session (**UNVERIFIED**).
- **Retention: no binding Tunisian rule found for private dental or medical records.** [G p.6] (SECONDARY): "En l'absence de dispositions spécifiques portant sur la durée de conservation", it recommends **"20 ans à compter de la date de la dernière consultation du patient"**. It extends this for minors (to age 28) and for deaths (10 years after death in certain cases), suspends the period during liability litigation, and sets 3 months for copies of claim forms. These rules mirror hospital practice and French rules, and are **not law** as far as we found.
- Design default (ASSUMPTION pending Q10): clinical records retained **20 years after last visit**, configurable per clinic. Nothing is auto-deleted. An expiry list goes to the owner (see §1.5 Art. 45).

---

## 4. Fee notes, receipts and financial records

### 4.1 Fee note
- **CH-005 (CONFIRMED by council):** [CD] Art. 31: the dentist must establish the fee note himself. Art. 30: no fee below the published scale "en clientèle", but free care is allowed. Art. 5, "Payement direct entre malade et Chirurgien-dentiste": meaning **UNVERIFIED**.
- Design implication: the receptionist may **record** a payment, but the fee note itself is issued under the dentist's identity, using the dentist's credential or a dentist-approved template. Whether a receptionist may print a fee note the dentist pre-approved is Q11.

### 4.2 Electronic invoicing (facture électronique)
- **SECONDARY (KPMG Tunisia, *Circulaire fiscale février 2026*, https://assets.kpmg.com/content/dam/kpmgsites/tn/pdf/circulaires-fiscales/Circulaire%20fiscale%20f%C3%A9vrier%202026%20final.pdf.coredownload.inline.pdf):** Art. 53 of Loi n° 17 du 12 décembre 2025 (LF 2026) extended mandatory e-invoicing (Code TVA Art. 18; décret 2016-1066) to "les opérations de prestations de services". Note commune n° 2/2026 explains the extension. It applies from 1 Jan 2026 to providers who have joined the network, with a tolerance for providers "ayant déposé une demande d'adhésion". The fine is "entre 100 et 500 D par facture non conforme", capped at 50,000 D per audit. For services to non-VAT persons (i.e. patients), "il doit être établi une note d'honoraires globale".
- **SECONDARY (press):** La Presse says médecins are "pleinement concernées" because the note d'honoraires is "fiscalement assimilée à une facture" (https://www.lapresse.tn/2026/01/09/liste-des-professions-concernees-par-la-facturation-electronique-en-tunisie/). The Ordre des médecins raised medical-secrecy objections at the ARP on 2 March 2026. The ARP considered an amendment to LF 2026 and a deadline-postponement bill, and deputies floated "une période transitoire sans sanctions" (https://www.tunisienumerique.com/a-larp-debat-sur-la-facturation-electronique-secret-medical-donnees-et-periode-transitoire-au-coeur-des-echanges/). On 3 Oct 2026 the Ordre said the amendment's "examen n'est pas encore achevé" (https://www.tuniscope.com/article/441589/conseils/vie/medecins-435011).
- **UNSETTLED:** whether **dentists** (not named in any source we found), with patient-facing (B2C) fee notes, must issue e-invoices through the accredited platform; what the "note d'honoraires globale" is; and whether patient names may be omitted (deputies reported the Ministry saying the fee note "does not require the patient's name"). **Q12–Q14.**
- Design: keep fee-note generation **format-pluggable**. Never send patient identity or clinical detail to any external invoicing platform until Q12–Q14 are answered.

### 4.3 Cash payments
- **UNSETTLED (press sources conflict):** Managers.tn says Art. 45 of LF 2019 (Loi 2018-56) "capped cash payments at 5,000 dinars" and that LF 2026 repealed it from 1 Jan 2026 (https://managers.tn/2025/12/02/a-partir-de-2026-les-paiements-en-numeraire-superieurs-a-5-000-dinars-seront-possibles/). Business News says Art. 45 concerned real estate, fonds de commerce and vehicles, was repealed by LF 2026 **Art. 54**, and that tax rules remain: a 20% fine (minimum 2,000 D) on companies or legal persons **paying** cash above 5,000 D for goods or services, and an 8% fine on a professional **receiving** cash above 5,000 D who does not report the payer's identity in its tax return (https://businessnews.com.tn/2026/02/04/transactions-en-especes-en-tunisie-ce-que-change-reellement-la-nouvelle-reglementation-fiscale/1386603/).
- Design (cheap and safe either way): the payment form shows a **payer-identity field** (CIN or tax ID) that is **required when one cash payment is at least 5,000 TND, i.e. 5,000,000 millimes**. The threshold is configurable. A report lists such payments for the tax adviser. Q15.

### 4.4 Bookkeeping retention
- **SECONDARY:** Loi n° 96-112 du 30 décembre 1996 (système comptable des entreprises): "pendant dix ans au moins à compter de la clôture de l'exercice concerné" (https://www.tunisienumerique.com/conservation-des-documents-comptables-quelles-obligations-pour-lentreprise-tunisienne/). Whether this applies to an individual dentist under the non-commercial-professions regime, and what the fiscal limitation period is under the CDPF, is **UNVERIFIED** (Q16).
- Design default: financial rows, fee notes and audit chain are **retained at least 10 years** after fiscal year close and are never deleted by the app.

---

## 5. Clinic-owned payment arrangements (questions only)

Context (CH-022): Stripe does not list Tunisia. We have not verified any Tunisian payment service provider's merchant terms, signed-callback scheme or statement format. Provider categories: bank acquirer / card terminal (TPE); national e-payment switch (e.g. the SMT/Clictopay category); licensed payment institutions and e-wallets; postal payment. Principles we propose (design, not legal):
- The merchant account, settlement account and PSP credentials **belong to the dentist or clinic**, never to EZZ. EZZ never holds or settles patient money.
- Card and e-payment receipts are reconciled against PSP statements imported by the owner. The receptionist cannot alter PSP data.
- Questions: Q17–Q19 (§13).

---

## 6. Backup custody, recovery, migration and vendor exit

### 6.1 Backups (ASSUMPTIONS for a 1–2 chair clinic)
- **3-2-1:** (1) the live DB; (2) an encrypted nightly `pg_dump` to a second medium on site or at the hosting provider in Tunisia; (3) an **offline encrypted copy held by the owner** (removable media, rotated weekly, stored off-premises, e.g. at home). Keep monthly copies for 12 months rolling, following [G]'s "sauvegardes mensuelles sur 12 mois glissants".
- **Encryption:** backups encrypted with a key the **owner holds**. EZZ cannot decrypt the owner's offline copy. Loss of the key means loss of that copy, so key escrow is covered in §7.
- **Targets (ASSUMPTION):** RPO 24 h for the offline copy and ≤ 1 h for hosted copies (with WAL archiving, not yet built). RTO 4 business hours to a restored system. During that window the clinic runs on paper books (§8).
- **Restore drills:** the `pg_dump` restore is tested **in dev only**. Before any pilot: a quarterly drill that restores to a clean host, verifies hash-chain continuity against the owner's external checkpoints, and reconciles cash totals. Record each drill as an audit event.
- **Art. 19 [L]** requires "copies de réserve sécurisées". Backups are themselves health-data stores: they belong in the INPDP declaration, have the same storage-location rules (§2) and fall under Art. 45 destruction (Q7).

### 6.2 Data export, patient copies, vendor exit
- **Patient copy (Art. 38/40, one month):** printable PDF plus a machine-readable file (CSV/JSON; images in their original format). Generated by the dentist, logged, delivered on paper or USB at the desk.
- **Clinic export:** full export on demand, owner-only with step-up re-auth. Formats: PostgreSQL dump, CSV per table with a data dictionary, original image/DICOM files, and the audit chain with a verification script. No proprietary format.
- **Vendor exit:** contract term (to draft) of 90 days' read-only access after termination, a final export, then documented destruction of EZZ-held copies under the Art. 45 procedure. The clinic's offline copies stay with the clinic.
- **Cessation of the practice** (retirement or death of the dentist): who inherits custody of records is a deontological and legal question (Q10).

---

## 7. Permission changes, departures, credentials, shared devices

- **Employee departure:** owner disables the account (no deletion; history stays attributable). Active sessions are revoked immediately. Any physical items (cash-box key, offline backup media) are recovered. A shift close is forced and the cash count is reconciled before the account is disabled. Permission changes are step-up-protected owner actions recorded in the audit chain.
- **Forgotten staff password:** owner resets it (no self-service, no email recovery). The reset is audited and forces a password change at next login.
- **Owner lockout (gap):** today owner recovery needs DB-owner access, which means an IT helper or EZZ operator. That is a privileged path an attacker or malicious helper could abuse. Proposed: a **sealed recovery code** generated at onboarding, printed once, kept by the owner in a sealed envelope off-site (optionally a second copy with a notary or trusted person). Using it is a step-up event that notifies the owner on every channel and marks the audit chain. Without the code, recovery requires in-person identity proof plus an audited DB-owner procedure with two people present (ASSUMPTION: owner and EZZ support).
- **Lockout after 5 failures:** it can be abused to lock the receptionist out during opening hours (denial of service). Make it a timed lockout with owner unlock, and alert on repeats.
- **Shared devices:** the front-desk PC is often shared. Use per-person accounts only (no shared login). The 30-minute idle timeout may be too long at the front desk; consider a quick lock (PIN re-entry) on window blur. No stored passwords in the browser (`autocomplete=off` is a hint only; document it in onboarding). Bearer tokens kept in memory/sessionStorage, not localStorage. Printing: watch for leftover print-spool files and download folders holding patient PDFs.

---

## 8. Internet and power outages

Evidence (SECONDARY, headline-level press):
- 14–15 July 2026: night-time power cuts in Ennasr, El Ghazala, Riadh Andalous and coastal and southern towns during a heat wave. Demand rose about 30% to about 5,000 MW, with load shedding plus an incident on the Algerian interconnection. STEG says a planned cut "ne devrait pas dépasser une heure"; residents waited "pendant de longues heures" (https://www.tunisienumerique.com/coupures-delectricite-et-de-communication-la-steg-a-sauve-le-reseau-pas-la-confiance/).
- 20 Aug 2026: STEG published rotating load-shedding lists for Grand Tunis, Cap Bon, Sahel, Sfax and the South, **13:30–17:00, up to two hours per zone**, during **clinic opening hours** (https://businessnews.com.tn/2026/08/20/delestages-la-steg-annonce-de-nouvelles-coupures-dans-plusieurs-regions-ce-jeudi-20-aout-2026/1414878/).
- 20 May 2026: Tunisie Télécom outage in El Ghazala, Raoued and Ennasr caused by third-party works (https://www.lapresse.tn/2026/05/20/coupures-dans-les-zones-del-ghazala-raoued-et-ennasr-tunisie-telecom-presente-ses-excuses-a-ses-clients/).
- We found no national STEG outage statistics (SAIDI/SAIFI) this session (**UNVERIFIED**).

Continuity design:
- **Paper first:** numbered paper outage books (appointments, payments received, fee notes issued), pre-printed and serial-numbered. Payments during an outage go into the numbered book with the patient's countersignature. On recovery, each book entry is keyed in with its book and page number, and the system flags any gaps in the numbering.
- **UPS (ASSUMPTION):** 30–60 min for the front-desk PC, router/ONT and receipt printer, enough to finish the current transaction and print the day list. It does not cover a full 2-hour load-shedding slot.
- **Daily pre-print:** before opening, print the day's appointment list and the outstanding-balance sheet.
- **Connectivity:** a mobile-data backup router (category) for hosted deployments. With an on-premises server the LAN keeps working without internet, but the server needs a UPS.
- **No offline-sync app** in v1: two systems of record would weaken the anti-theft core.

---

## 9. File uploads and malicious attachments

Uploads expected: intraoral photos, panoramic or periapical X-rays (JPEG/PNG; possibly DICOM from sensors), scanned referral letters and lab results (PDF).
- **Allow-list** by extension **and** magic bytes (JPEG `FF D8 FF`, PNG `89 50 4E 47`, PDF `%PDF-`, DICOM `DICM` at offset 128). Reject everything else, including SVG, HTML, Office macro files, archives and executables.
- **Size caps (ASSUMPTION):** 15 MB per image/PDF, 50 MB per DICOM, plus a per-clinic quota.
- **Image re-encoding** in a sandboxed worker: decode and re-encode, stripping EXIF/metadata (which may hold GPS or device data). Keep the original only if clinically required, stored quarantined.
- **PDF:** never render server-side in the main process. Serve with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a strict CSP. Consider rasterising for preview.
- **AV scanning** with a locally hosted engine category (no cloud scanning, which would be a transfer). Flag unscanned files.
- **No execution:** store outside the web root under random IDs, never under the user's filename. Do not serve from the app origin without a download header.
- **DICOM risks:** parsers have a history of memory-safety bugs. DICOM files can carry patient identity in tags and can hide polyglot payloads in the 128-byte preamble. Parse only in an isolated, resource-limited process; validate and rewrite the preamble; do not auto-forward to any foreign viewer.
- Uploads are clinical data, so the receptionist role cannot view them (§1.3).

---

## 10. Operational logs that must not leak patient data

Current state: logs contain route, status and timing only (no bodies, tokens or patient fields). Formalise this as an **allow-list**:
- **Allowed fields:** timestamp (UTC), request ID, HTTP method, **route template** (`/patients/:id`, never the concrete path or query string), status code, duration in ms, response size, clinic ID (opaque), user ID (opaque), role, error class/code, app version.
- **Forbidden:** request or response bodies, query strings, headers (especially `Authorization` and cookies), IP address beyond /24 truncation (ASSUMPTION; IP is personal data), patient names, phone numbers, CIN, amounts linked to a patient, file names, SQL text with parameters, stack traces holding values.
- **Enforcement:** the logger accepts only a typed record. Free-form `log(string)` is banned by lint. A test asserts that a request containing synthetic sentinel patient strings never appears in the log output.
- **Retention (ASSUMPTION):** 90 days for operational logs. The security audit chain is separate and kept ≥ 10 years (financial).
- **Access:** EZZ operators see only operational logs. Audit-chain content is the clinic's data. Log storage location follows §2.

---

## 11. STRIDE threat model: anti-theft financial core

**Assets:** payment records (integer millimes), fee notes, shift/cash-drawer counts, refunds and discounts, the append-only ledger, the hash-chained audit and the owner's external checkpoints, user accounts and roles, backups, the patient balance sheet.

**Actors:** R = receptionist; D = dentist (employed dentist, if not the owner); O = owner; X = outside attacker; H = malicious or careless IT helper; C = compromised device (front-desk PC, owner phone); P = cloud/hosting operator (including EZZ staff).

| # | STRIDE | Actor | Threat | Existing controls | Residual risk |
|---|---|---|---|---|---|
| T1 | Spoofing | R | Uses dentist's or owner's session left open on a shared PC | Per-user accounts, 30-min idle timeout, 5-min step-up for sensitive owner actions | Medium: within the idle window, non-step-up actions are possible. Add a quick lock. |
| T2 | Spoofing | X | Password guessing | Lockout after 5 failures | Low–Med. Lockout can be used for denial of service (§7). |
| T3 | Tampering | R | Edits or deletes a recorded cash payment after the patient leaves | Append-only financial tables; corrections only as reversing entries with reason and actor; hash chain | Low for recorded cash. Reversals stay visible in owner review. |
| T4 | Tampering | H/P | Direct DB edit that bypasses the app, then recomputes the hash chain | Least-privilege roles (app role cannot UPDATE/DELETE ledger), RLS; owner-held **external** checkpoints make chain rewrites detectable | Medium: someone with DB-owner rights can do anything. Detection depends on the owner actually comparing checkpoints. |
| T5 | Repudiation | R/D | "I didn't record that discount/refund" | Every financial event carries actor, time and hash; refunds/discounts above a threshold need owner step-up | Low |
| T6 | Info disclosure | P/H | Reads patient and financial data on server or backup | RLS, encrypted backups (planned), logs allow-list | **High until TLS is added and disk/backup encryption is in place**. Art. 22/63 exposure. |
| T7 | Info disclosure | X | Network sniffing between app and DB | None. **In-repo driver has no TLS** | High if app and DB are split across hosts. Deployment blocker. |
| T8 | DoS | X / environment | Power or internet loss stops recording, so cash is taken "off-book" | Numbered paper outage books, gap detection on re-entry | Medium: depends on discipline at the desk. |
| T9 | Elevation | R | Gets owner rights through the owner-recovery path or an IT helper | No self-service recovery; owner resets staff | Medium: owner recovery via DB owner is a social-engineering target. Sealed recovery code proposed (§7). |
| T10 | Elevation | C | Malware on front-desk PC steals bearer token | Short idle timeout, step-up for sensitive actions | Medium: a stolen token works until it expires. Consider binding the token to the device and IP range. |
| T11 | Tampering | D | Employed dentist under-records fees for "friends" or pockets them | Fee notes tied to appointments and procedures; owner daily review of procedures done vs fees | Medium: needs procedure-to-fee reconciliation. |
| T12 | Tampering | O | Owner manipulates own records (tax fraud) | Audit chain records it | **Out of scope:** the software cannot protect the owner from the owner. |
| T13 | Tampering | R | Records payment at a lower amount than collected | Printed receipt with number shown to patient; patient-facing amount; balance statements | Medium: elderly patients may not check receipts. |

**Explicit limits (CH-002):**
1. **Zero theft cannot be guaranteed.** The controls make theft detectable, attributable and costly. They do not make it impossible.
2. **Cash that is never recorded anywhere is invisible to software.** If a patient pays cash and no appointment, procedure, fee note, paper-book entry or receipt is created, no algorithm can detect it. The only mitigations are outside the software: printed receipts as a norm, a sign telling patients to ask for a receipt, the owner reconciling procedures actually performed (chair schedule, lab orders, consumables) against fees, and spot checks.
3. Insiders with DB-owner rights (H/P) can defeat in-app controls. External checkpoints only make this **detectable after the fact**, and only if the owner compares them.

---

## 12. Operational risk register

Likelihood and impact are **ASSUMPTIONS** (L/M/H) for a single small clinic.

| ID | Risk | L | I | Existing control | Gap | Owner | Next action |
|---|---|---|---|---|---|---|---|
| R01 | Processing health data without INPDP authorisation (silence = refusal) | H | H | none | No filing kit | Clinic owner (controller) | Build declaration/authorisation data-sheet generator; Q1, Q5 |
| R02 | Art. 22 nationality/residence rule breached by vendor or helper staff | M | H | none | Unknown applicability | EZZ founder | Q2–Q3 before any production access by non-residents |
| R03 | Foreign hosting, email, SMS, telemetry or AI = unauthorised transfer (Art. 90) | M | H | Telemetry off by default | No data-flow inventory enforced | EZZ tech lead | Maintain flow table (§2); block foreign endpoints in config |
| R04 | App to DB traffic without TLS | H (if split hosts) | H | Dev only | Driver lacks TLS | EZZ tech lead | Add TLS or co-locate on loopback; deployment gate |
| R05 | Backup lost, unencrypted or unrestorable | M | H | pg_dump drill in dev | No offline encrypted owner copy; no prod drill | Clinic owner + EZZ | Implement 3-2-1 + quarterly drill |
| R06 | Owner locked out; recovery path abused | M | H | No self-service recovery | Recovery relies on DB owner | EZZ product | Sealed recovery code + two-person procedure |
| R07 | Receptionist session hijack on shared PC | M | M | 30-min idle, step-up | No quick lock | EZZ product | Quick lock; per-user accounts enforced at onboarding |
| R08 | Off-book cash (never recorded) | M | H | Paper books, receipts | Undetectable by software | Clinic owner | Receipt norm, patient signage, procedure-vs-fee review |
| R09 | Power/internet outage in opening hours (13:30–17:00 load shedding) | H (summer) | M | Paper outage books | UPS not specified; re-entry gap checks | Clinic owner | UPS spec; gap detection on re-entry |
| R10 | Malicious upload (PDF/DICOM exploit) | L | H | none built | No upload pipeline yet | EZZ tech lead | Implement §9 before enabling uploads |
| R11 | Patient data in logs/telemetry | L | M | Route/status/timing only | No automated test | EZZ tech lead | Sentinel-string log test; typed logger |
| R12 | E-invoicing obligation applies to dentists | M | M | none | Format unknown | Clinic owner + tax adviser | Q12–Q14; keep fee-note format pluggable |
| R13 | Cash ≥ 5,000 TND without payer identity reported | L | M | none | Field not built | EZZ product | Add conditional CIN/tax-ID field; Q15 |
| R14 | Patient erasure/opposition conflicts with append-only ledger | M | M | Append-only design | Legal position unknown | Counsel | Q6; implement "contested/opposed" flags |
| R15 | Departing employee keeps access or cash-box key | M | M | Owner disables accounts | No offboarding checklist | Clinic owner | Offboarding checklist with forced shift close |
| R16 | Retention: premature deletion or over-retention | M | M | No hard delete | Period unknown; Art. 45 formalities | Counsel | Q7, Q10; destruction-list workflow |
| R17 | Vendor exit leaves clinic without data | L | H | pg_dump | No contract terms; no export UI | EZZ founder | Export spec + contract exit clause |
| R18 | Breach with no notification plan | L | H | Audit chain | No runbook | EZZ founder | Incident runbook; Q8 |
| R19 | Reform law imposes in-country hosting or new duties | M | M | Tunisia-first hosting default | Monitoring | EZZ founder | Track PLO 95/2025 monthly |
| R20 | Receptionist issues fee notes the dentist did not establish (Art. 31) | M | M | Role separation planned | Workflow undefined | Dentist / Ordre | Q11 |

---

## 13. Questions for qualified advisers

Each question names the design decision it blocks. INPDP = Instance nationale de protection des données personnelles; CNOMDT = Conseil national de l'Ordre des médecins dentistes; TAX = tax adviser / expert-comptable; COUNSEL = Tunisian data-protection or health lawyer.

1. **(COUNSEL/INPDP)** Does Art. 16 of Law 2004-63 ("suivi de l'état de santé") exempt a dental practice's patient file from the Art. 7 declaration, or must the dentist file a declaration **and** an Art. 15 authorisation? *Blocks: onboarding checklist and filing kit.*
2. **(COUNSEL)** Does Art. 22 (Tunisian nationality, residence, no criminal record) apply to a SaaS vendor acting as sous-traitant, to each employee or contractor with production access, and to a hosting provider's staff? *Blocks: who may operate, support and administer production.*
3. **(COUNSEL)** If a non-resident developer only ever touches synthetic data and production is run by Tunisian residents, does that satisfy Art. 22? *Blocks: team structure and access model.*
4. **(COUNSEL/INPDP)** Is sending patient data to a foreign AI/LLM API (transcription, summarisation) a "transfert" needing Art. 52 authorisation, and is it compatible with Art. 63? *Blocks: any AI feature.*
5. **(INPDP)** What forms (and electronic channel) apply today for a private dental practice's health-data authorisation, and can one filing cover the clinical file, appointment reminders and fee notes? *Blocks: generated filing data sheet.*
6. **(COUNSEL)** How do Art. 32 erasure and Art. 42 opposition ("suspend immédiatement le traitement") apply to append-only financial records and a hash-chained audit log that must be kept for accounting? *Blocks: rights-request workflow and ledger design.*
7. **(COUNSEL/INPDP)** Does the Art. 45 destruction formality (bailiff plus Instance-appointed expert, per our reading) apply to deleting database rows and expired backup media? *Blocks: retention-expiry and backup-rotation procedure.*
8. **(COUNSEL)** Is there any binding breach-notification duty (INPDP, ANCS under Décret-loi 2023-17, or patients) for a small private clinic or its SaaS processor? *Blocks: incident runbook.*
9. **(COUNSEL)** Does Code pénal Art. 254 ("toutes autres personnes dépositaires par état ou profession") cover the receptionist and the SaaS operator's staff? What confidentiality clauses are needed? *Blocks: employment and vendor contract templates.*
10. **(CNOMDT)** Is there a mandatory retention period for dental records (clinical notes, X-rays), and who takes custody when a practice closes or the dentist dies? *Blocks: default retention setting and practice-closure export.*
11. **(CNOMDT)** Under Code de déontologie Art. 31, may a receptionist print or hand over a fee note that the dentist pre-approved in the system? May the receptionist collect cash and record it? What does Art. 5 "Payement direct" require? *Blocks: receptionist permissions on fee notes and payments.*
12. **(TAX)** Are dentists treating private patients (B2C) required by LF 2026 Art. 53 / Note commune 2/2026 to issue e-invoices through the accredited platform, and from what date? What is the status of the ARP amendment or postponement? *Blocks: fee-note output format and integration.*
13. **(TAX/COUNSEL)** If e-invoicing applies, may the patient's name and treatment be omitted ("note d'honoraires globale")? What exactly must the fee note contain? *Blocks: fee-note template fields and secrecy safeguards.*
14. **(TAX)** What are the mandatory mentions on a dentist's paper note d'honoraires today (matricule fiscal, numbering, date, amount in figures and words, TVA/stamp duty if any)? Must numbering be continuous per year? *Blocks: fee-note numbering scheme.*
15. **(TAX)** After LF 2026, what exactly applies to a dentist **receiving** a cash payment above 5,000 TND (identity reporting, 8% fine), and to a company paying the dentist in cash? *Blocks: conditional payer-identity field and threshold report.*
16. **(TAX)** What is the retention period for a dentist's accounting records and fee-note copies (Loi 96-112 vs CDPF limitation), and may they be kept only electronically? *Blocks: financial retention default and paper-book archiving.*
17. **(COUNSEL/bank)** Must the PSP merchant account be in the dentist's personal name (liberal professional) or may it belong to a practice company? What KYC applies? *Blocks: onboarding of card or e-payment.*
18. **(COUNSEL/bank)** Can a receptionist operate the card terminal or e-payment portal under the dentist's merchant account without a delegation document? *Blocks: receptionist payment role.*
19. **(PSP/bank)** Which Tunisian PSPs offer signed payment callbacks and machine-readable statements for reconciliation? *Blocks: automated reconciliation (CH-022).*
20. **(COUNSEL/INPDP)** Does INPDP Délibération n° 3 of 2018 (adequate states) exist in force, and does it remove the need for Art. 52 authorisation for any destination? *Blocks: whether any foreign backup or mail relay is ever acceptable.*
21. **(COUNSEL/INPDP)** Is there any accreditation scheme for health-data hosts in Tunisia (the 2018 guide mentions "hébergeur … qualifié et accrédité")? *Blocks: hosting-provider selection criteria.*
22. **(INPDP)** Is a DPO ("chargé de protection des données") mandatory for a solo private dental practice under Délibération n° 4 of 2018? Can the dentist be the DPO? *Blocks: onboarding role setup.*
23. **(COUNSEL)** Are SMS appointment reminders sent through a Tunisian aggregator processing health data (an appointment at a dental clinic reveals health information)? Is patient consent required? *Blocks: reminder feature and consent capture.*
24. **(COUNSEL)** What form of patient consent is valid for elderly or illiterate patients (signed paper, thumbprint, witness)? *Blocks: paper consent form design.*
25. **(COUNSEL)** If PLO 95/2025 is adopted, what transitional period is expected, and does it mandate in-country hosting of health data? *Blocks: long-term hosting architecture.*
26. **(COUNSEL)** May the clinic owner hold the only decryption key and sealed recovery code, and is the vendor liable if the owner loses them and records become unavailable? *Blocks: key-custody and recovery design.*

---

## 14. Summary of decision-relevant findings

1. Health data needs an INPDP **authorisation** (silence = refusal) on top of the declaration, and processing is limited to doctors or secrecy-bound persons (Law 2004-63 Arts. 14–15, 62–63; Decree 2007-3004 Arts. 9, 11, 12). CONFIRMED.
2. Art. 22 requires processors **and sub-contractors' agents** to be Tunisian nationals, resident, with no criminal record (CONFIRMED text). Its application to a SaaS team is UNSETTLED and could shape the whole operating model.
3. Transfers abroad need adequacy plus INPDP authorisation (CONFIRMED). A Tunisian practitioner guide says foreign messaging for health data is "à proscrire", and the pending reform restricts hosting abroad. Default to Tunisia-only hosting and treat email, SMS, telemetry and AI as transfers.
4. No binding dental-record retention period was found; a guide recommends 20 years from last visit (SECONDARY). Destruction has formalities (Art. 45), so the app should never hard-delete.
5. E-invoicing was extended to services by LF 2026 Art. 53 (SECONDARY). Its application to dentists and B2C fee notes is UNSETTLED and contested by the Ordre at the ARP. Cash rules above 5,000 TND are UNSETTLED (press conflicts). Keep formats pluggable and capture payer identity above the threshold.
