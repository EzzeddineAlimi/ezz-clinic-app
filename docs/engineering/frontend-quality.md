# Frontend authored-source lint gate — issue #74

This draft adds pinned dev-only Biome 2.6.4 to the **frontend**. It reuses the backend's 13 explicitly selected correctness/suspicious lint rules, not the entire recommended preset. It does not reformat application files, change clinic behavior, or alter payment/clinical/tenant controls.

Run `cd frontend && npm ci --ignore-scripts && npm run lint && npm run lint:verify`. The verification script creates an excluded synthetic fixture and a temporary authored `debugger` violation, asserts real CLI RED, removes both, and requires GREEN.

Scope: authored `src/**/*.ts(x)`, `test/**/*.ts`, `e2e/**/*.ts`, and `playwright.config.ts`. Synthetic `test/fixtures`, screenshots, generated artifacts, `dist`, lockfiles, CSS, and copied dependencies are not linted.

The unconditional `frontend-lint` pull-request job checks this scope on documentation-only PRs too; the `main` push trigger is scoped to frontend or workflow changes. This is a draft until exact-head GitHub CI is verified and independently reviewed. Formatter adoption, existing formatting diagnostics and GitHub required-check configuration remain separately open under issues #74 and #68. This is not production/security/clinical approval.
