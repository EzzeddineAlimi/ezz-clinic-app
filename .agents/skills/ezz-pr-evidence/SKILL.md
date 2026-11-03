---
name: ezz-pr-evidence
description: "Use when authoring a clinic PR description or merge handoff: concise summary, before/after proof, exact-head CI, review risks and merge danger."
---

# PR evidence that a reader can verify

Adapted from [Matt Pocock's PR presentation skill](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/pr/SKILL.md), including its [credited origin](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/pr/CREDITS.md).

Keep the PR body short and concrete:

## Summary

- **What changed and why:** one vertical requirement ID, current base/head, affected visible journey or API contract.
- **Visual:** one small data-flow diagram, screenshot pair, call path or file tree *only* if it makes the change easier to review.

## Evidence

- **Before (RED):** reproduction, observed error, exact command and commit where applicable.
- **After (GREEN):** actual tested commands/results, skipped cases, source and compiled backend, real-PG16 browser checks, exact-head GitHub Actions links.
- **Limits:** what you could **not** execute, what is still uncertain, and which human/physical proof is missing. Never reuse a previous head's green checks without marking them historical.

## Merge danger

- **Door:** reversible code/docs change or difficult-to-reverse data/protocol/clinical/financial change.
- **Blast radius:** affected roles, clinics, patient/privacy, money, database/schema, app/print/browser, or docs-only.
- **Approval:** current-head independent Primary Muse/Muse Ons findings when relevant; founder and specialist gates not implied by green CI. Keep unapproved work draft.

Add the agent's permanent ID and **actual** schedule ID to authored comments only when the scheduled worker created them. Manual coordination must not impersonate a scheduled reviewer.
