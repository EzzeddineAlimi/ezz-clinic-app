---
name: ezz-bug-diagnosis
description: "Use for EZZ Clinic bugs, failing or flaky tests, data inconsistencies and performance regressions; requires theory, direct proof and a minimal verified fix."
---

# Evidence-first bug diagnosis

Based on [Matt Pocock's diagnosing-bugs skill](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/diagnosing-bugs/SKILL.md), adapted for this project. This is guidance, **not** permission to change external accounts or production.

1. **Pin context.** Record branch and exact SHA, expected and observed behavior, impact and affected authority. Read [`GLOSSARY.md`](../../../GLOSSARY.md) if clinical/financial terms are involved. Never use real patients or payment credentials in a reproduction.
2. **Theory before edits.** State one specific causal hypothesis; isolate one failing route, test, query or UI state. If this is security/finance/clinical code, name the existing permission and audit invariants it must preserve.
3. **Collect direct evidence.** Obtain a reproducible failure through the smallest *public* contract seam: PG16 test or actual HTTP request, Playwright fictional API journey, or an existing exact-head CI log. Add bounded safe logging only when essential. **Redact** tokens, personally identifying data, secrets and patient notes. No speculative fixes, larger timeouts or swallowing errors just to turn CI green.
4. **Surgical fix.** Edit only after the observation distinguishes the hypothesis from competing causes. Keep TypeScript module boundaries and authorization/idempotency protections. Do not modify a reviewed SQL migration in place.
5. **Prove green.** Re-run the same failing reproduction and relevant safety/tenant/role/financial negative tests; inspect exact-head CI. If the bug is intermittent, report observed repetitions and unresolved confidence instead of calling it permanently fixed.
6. **Report.** Theory, direct RED log/test, cause, minimal diff, exact SHA, actual GREEN command/results/skips, remaining risk and reviewer gate. Remove temporary probes.

If no reproduction or decisive evidence is available, stop only that affected fix, record **CAUSE UNCONFIRMED** and work on an independent safe item. Independent human/professional acceptance still applies.
