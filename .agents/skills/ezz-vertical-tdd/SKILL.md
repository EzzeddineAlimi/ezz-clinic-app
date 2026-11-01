---
name: ezz-vertical-tdd
description: "Use when implementing or changing a testable EZZ Clinic behavior; create one real-contract RED test, one minimum GREEN implementation and preserve existing safety invariants."
---

# One vertical RED → GREEN slice

Adapted from [Matt Pocock's TDD skill](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/tdd/SKILL.md). Use existing authorized requirements and [`GLOSSARY.md`](../../../GLOSSARY.md); never invent business rules to write a test.

1. **Choose the contract seam** from the already accepted task: public API with disposable PostgreSQL 16 data, real-API Playwright browser journey, or an existing pure public utility. Record what this seam catches and what it cannot prove; reuse an established seam without adding a new tool or asking the founder to pick tests they already authorized.
2. **Write one behavior assertion.** Prefer user-visible outcomes, negative authorization cases, idempotency after a lost response, tenant isolation, signed clinician attribution, TND millime exactness and uncertain-error states where relevant.
3. **Observe RED before fixing.** Execute the test and keep the exact failing diagnostic. The failure must demonstrate *missing or wrong behavior*, not an invalid fixture, broken test runner or unreachable PostgreSQL. For an existing bug, make a causal theory and gather confirming evidence first (see [diagnosis](../ezz-bug-diagnosis/SKILL.md)).
4. **Minimum GREEN implementation.** Change the smallest production surface that makes this one test pass; do not build the next feature, blanket-refactor or bypass a gate.
5. **Verify at scale appropriate to the diff.** Run the new test and the adjacent real DB/browser regressions, relevant source/compiled backend tests, strict type checks and exact-head CI; identify actual skips. Add one next slice only when needed.
6. **Hand off the proof** with requirement ID, RED and GREEN result, exact SHA, source of expected values, and residual human/physical review.

Avoid tests that mirror the implementation's calculation or mock away the only behavior that matters. Prefer independent known values and stable public interfaces. A mocked browser success cannot prove real PostgreSQL transaction behavior. GREEN is never release approval.
