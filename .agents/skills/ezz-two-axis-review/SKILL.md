---
name: ezz-two-axis-review
description: "Use for PR/code reviews. Independently check standards and implementation against accepted requirements, at the exact head SHA, then apply clinical/financial/release gates."
---

# Two-axis review on a pinned diff

Adapted from [Matt Pocock's code-review skill](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/code-review/SKILL.md). **Do not self-issue an independent-review PASS.** The two axes can be checked separately by one reviewer; genuinely independent reviewer signoff still needs another actor.

1. **Pin exact context:** current main/base, PR head SHA, changed files, ancestry, open overlapping PRs, current CI. Review oldest actionable PR before newer ones unless an urgent documented risk justifies another order.
2. **Standards axis:** check [`AGENTS.md`](../../../AGENTS.md), [engineering standards](../../../docs/engineering/standards.md), [security](../../../docs/security/security-status.md), relevant module boundaries and real failure evidence. Flag concrete violations only; avoid speculative architecture rewrites.
3. **Requirement axis:** read founder-approved scope, affected [domain terminology](../../../GLOSSARY.md), issue/acceptance criteria, documented API/UX/FR-AR behavior and negative safety states. Check the actual diff **delivers the required behavior**, not merely that tests are green.
4. **Conditional threat and physical-evidence checklist within both axes:** verify clinical authorship, same-clinic RLS, permissions, payment/cash proof tiers, receipt sequence, write retry/recovery, no real patient data, CNAM and Tunisian legal unknowns. Distinguish software control from independently observed physical fact.
5. **Review outcome:** each finding names file/line (or test/contract), observed evidence, impact/severity, minimum correction and affected requirement. Record **PASS / WITH FIXES / BLOCK / UNVERIFIED**, exact SHA, check links and missing independent gates. Don't treat stale review as current-head PASS.
6. **Do not merge just from this playbook.** Primary Muse handles independent adversarial/security review; Muse Ons handles relevant independent UX/RTL. Founder/privacy/clinical/production approvals remain separate. No reviewer may approve their own high-risk implementation.

If a reviewer cannot inspect code, run tests or see actual rendered UI, label the limitation explicitly instead of inferring a passing result.
