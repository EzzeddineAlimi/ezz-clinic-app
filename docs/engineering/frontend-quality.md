# Frontend authored-source lint gate — issue #74

This draft adds pinned dev-only Biome 2.6.4 to the **frontend**. It reuses the backend's 13 explicitly selected correctness/suspicious lint rules, not the entire recommended preset. It does not reformat application files, change clinic behavior, or alter payment/clinical/tenant controls.

Run `cd frontend && npm ci --ignore-scripts && npm run lint && npm run lint:verify`. The verification script creates an excluded synthetic fixture and a temporary authored `debugger` violation, asserts real CLI RED, removes both, and requires GREEN.

Scope: authored `src/**/*.ts(x)`, `test/**/*.ts`, `e2e/**/*.ts`, and `playwright.config.ts`. Synthetic `test/fixtures`, screenshots, generated artifacts, `dist`, lockfiles, CSS, and copied dependencies are not linted.

The unconditional `frontend-lint` pull-request job checks this scope on documentation-only PRs too; the `main` push trigger is scoped to frontend or workflow changes. This is a draft until exact-head GitHub CI is verified and independently reviewed. Formatter adoption, existing formatting diagnostics and GitHub required-check configuration remain separately open under issues #74 and #68. This is not production/security/clinical approval.

## Formatter measurement — 2026-10-31, draft PR #106

The original lint-slice statements above are historical; they do not describe this newer draft. PR #106 adds `npm --prefix frontend run format:check` (`biome format .`) and a **diagnostic-only** step in the existing frontend quality workflow. It is intentionally not an enforced formatter gate: mass reformatting of clinical, financial or UI files is outside this change.

At PR #106 head `3f587b917110a1da54ea189378250ef19b0ef44e`, the [real GitHub Actions job](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/41233329406) installed pinned dependencies and executed the formatter. It exited **1** with **44 formatting diagnostics across 45 checked authored files**. Biome reported **No fixes applied**; the job's clean-working-tree assertion passed. This is measured formatting debt, not a passing formatting baseline or a finding of frontend runtime failure. The existing lint and RED/GREEN lint verifier also passed in that job.

To reproduce without changing source: `npm --prefix frontend ci --ignore-scripts` then `npm --prefix frontend run format:check`. Expect exit 1 until the measured baseline is deliberately resolved. Contributors should not run a repository-wide write-mode formatter as part of this PR. Independently review any future focused formatting diff and keep application behavior and clinical/payment controls unchanged.
