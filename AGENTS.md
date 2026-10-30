# EZZ Clinic — shared AI engineering instructions

## Non-negotiable project boundaries
- Development and previews use **fictional data only**. Do not ingest real patient data, process real payments, issue fiscal receipts, or claim production/clinical/legal readiness.
- Do not merge, deploy, alter production configuration, or touch real data without explicit founder authorization. Preserve independent review and existing release gates.
- The current checkout, exact PR head SHA, code, tests, and accepted task scope take precedence over historical handoffs. Read `docs/engineering/standards.md` when engineering policy is relevant.

## Work on the smallest verified scope
- At task start identify the target branch/head, intended behavior, affected files, and acceptance checks. Inspect relevant implementations, dependencies, and current diffs; do not re-read the entire repo or paste large handoffs for every small task. For a requested comprehensive audit or cross-cutting safety change, inspect all relevant code and evidence exhaustively.
- Bug protocol: formulate a causal theory, obtain direct evidence (existing logs or a targeted failing regression test), then make the minimum fix. Do not make speculative repairs.
- Keep modular TypeScript boundaries and server-side controls: role/clinic isolation, dentist authority, integer millimes, idempotency, append-only/audited facts, receipt sequence, and physical-cash evidence limitations. Do not weaken safeguards to speed delivery.
- Reuse scripts and CI for repeated deterministic operations. Introduce a new script only when repetition is demonstrated and maintaining it is worthwhile.

## Use AI context deliberately
- Start at `docs/INDEX.md` to locate current domain authorities; read only the relevant source documents and current code. Treat accepted product scope, implemented behavior, and release readiness as different claims. Draft PRs and historical handoffs are not merged functionality.
- When a change affects an accepted workflow, API, permission, schema, UX state, environment, security control or release gate, update the corresponding authoritative document in the same PR; regenerate generated contracts rather than hand-editing them. Record unresolved conflicts, not speculative decisions.
- Reuse stable repository instructions, precise file paths, current API contracts, diff ranges, and evidence links instead of repeatedly pasting the same project history.
- Keep one focused task per session; start a new session for an unrelated task and compact long sessions around the active task. Do not keep stale context just to chase cache hits.
- Use expensive reasoning for difficult architecture/security questions, and cheaper models for bounded routine work **when selected by the operator**. This file cannot switch models or guarantee vendor cache hits.
- Keep independent adversarial review for payment, authorization, privacy, clinical, and release-critical changes. A model must not self-certify its own high-risk work.

## Verify and hand off
- For applicable backend changes run `npm --prefix backend run typecheck`, `npm --prefix backend test`, and `npm --prefix backend run test:dist` with PostgreSQL 16 and the required test environment.
- For applicable frontend changes run `npm --prefix frontend test` and `npm --prefix frontend run build`; run `npm --prefix frontend run test:e2e` against the configured fictional real-API environment when affected. Leave GitHub Actions as the authoritative CI check on the exact PR head.
- Report exact commit/PR SHA, scope, commands **actually run**, pass/fail/skip, remaining risks, and reviewer action. Never claim unrun tests passed.
- The blueprint includes lint and formatting checks, but current backend/frontend manifests have no `lint`/`format:check` scripts. Explicitly report them **NOT CONFIGURED**, not PASS, until a small independently reviewed tooling/CI change establishes real commands. Avoid mass reformatting unrelated files.
- Persist durable outcomes and handoffs in GitHub PRs/docs and the approved Mission Control lane—not solely in a local agent workspace. Avoid duplicating old evidence; link it by immutable SHA.
