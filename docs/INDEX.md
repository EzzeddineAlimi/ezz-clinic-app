# EZZ Clinic — current sources of truth

**Purpose:** one short routing page for humans, GPT, Codex and independent reviewers. This index is not an implementation, approval or replacement for source documents. Snapshot checked against merged main `406c5dd1` on **2026-10-30**; always re-read the live branch and issue/PR heads.

## Authority depends on the question

| Question | Authoritative location | Interpret correctly |
| --- | --- | --- |
| What V1 is approved? | [Mission Control — R76_FEATURE_SCOPE_DECISIONS](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit) and accepted CNAM decisions | **61 V1 / 43 Later / 4 Excluded** is product scope, not delivered functionality |
| Is this built? | Merged `main` source, migrations, generated contracts and exact-SHA tests | A draft PR, historical handoff or screenshot is not implementation on `main` |
| Has V1 been accepted? | Mission Control `V1_EVIDENCE_REFRESH_20261030`, [issue #69](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/69) and founder acceptance | **0 of 61 accepted** at this snapshot; green CI alone cannot close a group |
| Can we merge? | Exact-head CI, independent review, explicit founder authorization and dependency order | Main branch reports protected; required-check/admin enforcement remains an [open gate](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/68) |
| Can we deploy or use actual patient records? | [Security status](security/security-status.md), [operations risk assessment](operations/privacy-compliance-and-operational-risk.md) and [issue #72](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) | **No**. Fictional-data-only; separate clinical/privacy/fiscal/CNAM/security approval required |

## Read the established documents, not new duplicate templates

| Domain | Start here | Implementation/authority |
| --- | --- | --- |
| Product / PRD | `R76_FEATURE_SCOPE_DECISIONS`; `docs/product/` and [clinical requirements](clinical-domain/clinical-requirements.md) | Approved scope in Sheet; domain contracts in code/tests |
| Design and UX flows | [Concept A role-workspaces draft PR #59](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/59), `UX_DECISION_LEDGER` and `UX_BATCH_COMMAND` | Draft specs/screen inventory are not shipped screens |
| Architecture and decisions | [Architecture](architecture/architecture.md), [ADRs](architecture/decisions.md) and [SOLID audit](architecture/R74-SOLID-AUDIT.md) | Code and architecture tests settle implemented behavior; older audits retain their historical SHAs |
| Database | [Schema catalogue](database/schema.md), `backend/migrations/` | **Migrations** are authoritative; the `schema.md` catalogue covers only the 0001–0007 historical slice and must be regenerated for a complete current schema |
| API and errors | [OpenAPI](api/openapi.json), [generated endpoints](api/endpoints.md), [frontend security states](api/frontend-security-states.md), [payment recovery](api/PAYMENT-RECOVERY.md) | Generated route contract + real-API tests settle behavior |
| Security / roles | [Status](security/security-status.md), [generated permission matrix](security/permission-matrix.md), [operational risks](operations/privacy-compliance-and-operational-risk.md) | Server permissions and database restrictions; [draft PR #71](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/71) is **not merged** |
| Code style and agents | [Engineering standards](engineering/standards.md), root [AGENTS.md](../AGENTS.md) | Small verified diffs, evidence-first bugs, modular boundaries |
| Testing / acceptance | [Results matrix](testing/results-matrix.md), `docs/testing/SPRINT*`, GitHub Actions, [issue #69](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/69) | Each log speaks for its recorded SHA/environment, not current HEAD automatically |
| Environment | `backend/.env.example`, [development setup](engineering/dev-environment.md), `frontend/README.md` | Node 22 / PG16 for current development; production infrastructure not chosen |
| Recovery / deployment | [Disaster recovery drill](operations/disaster-recovery-drill.md), [risk assessment](operations/privacy-compliance-and-operational-risk.md), [issue #72](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) | Documented assumptions are **not** an executed production restore or approved rollout |
| Observability | [Security status](security/security-status.md), owner audit/integrity code and [issue #72](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) | Logs and hash chains exist; live alerting/on-call not verified |
| Roadmap / changes | Mission Control `UX_BATCH_COMMAND`, `CODEX_ENGINEERING`, [PRs](https://github.com/EzzeddineAlimi/ezz-clinic-app/pulls), [issues](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues) | PR history is a development record, not a clinical release changelog |

> **Coverage is not completion.** [The 17-area blueprint maturity check](engineering/blueprint-adoption-2026-10-30.md#second-pass-coverage-assessment-of-the-17-blueprint-areas) distinguishes documented-for-development, partial, and production-gated material. In particular, no repository `lint`/formatter script exists yet; no agent may report a lint pass that did not run.

## Update-on-change contract

1. **Before coding:** identify the exact current base/head, accepted feature IDs and relevant specification, existing implementation, known active owner/PR, failure theory if fixing a bug, and independent evidence. Do not invent business rules or reuse stale handoff status.
2. **When behavior changes:** update the closest existing product/UX-flow specification and its FR/Arabic states (loading, empty, error, offline, pending/retry) in that PR.
3. **When an interface changes:** regenerate API/permission-matrix documents through their existing generators, update tests and consumer contracts; never edit generated output by hand.
4. **When data or security changes:** update migrations/ADRs/security/privacy documentation and exercise tenant, role, patient, money, audit, concurrency and error-path regressions as applicable.
5. **Before review:** record exact SHA, changed files, executed commands and outcomes including skips, relevant acceptance IDs, and remaining uncertainties. Require an **independent** reviewer for financial, clinical, privacy, access-control and release-critical changes.
6. **Before merge:** check CI required-check coverage on the exact head (docs-only PRs may be skipped by path filters); never infer approval from green status. Founder authorization is separate from security/production release authorization.
7. **After merge:** reconcile only affected current-state documentation and the acceptance evidence pointer. Preserve historical audit outputs and previous SHAs, rather than retroactively rewriting them.

## Priority work, with existing ownership

- **P0 production blockers:** [#72](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/72) identity/MFA, recovery, HTTPS, backup/restore, monitoring, document malware screening, independent testing, Tunisian clinical/privacy/fiscal/CNAM assessment; [#68](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/68) required-check protection and Mission Control link access. Neither stops fictional-data draft development.
- **P1 implementation quality:** [#58](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/58), [draft UX-12 chain](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/70), then dentist and owner UX. Preserve real-API evidence, correct patient identity, blind counts and independent settlement distinctions.
- **P1 release evidence:** [#69](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/69) 61-group acceptance audit; [CNAM issue #67](https://github.com/EzzeddineAlimi/ezz-clinic-app/issues/67) remains Codex-owned; [draft security PR #71](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/71) remains in its independent review lane.
- **P2 hygiene:** keep this index/README/engineering policy current; use the lightweight PR checklist. Do **not** create 17 competing template files or fork assigned work.

**Non-negotiable:** no real patients, payments or production deployment; software cannot prove wholly unrecorded cash, physical handover or provider settlement without independent evidence.
