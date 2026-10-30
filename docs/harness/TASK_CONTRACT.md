# Portable engineering and review contract

Use this checklist for GPT COO, scheduled Codex, manually invoked Muse/Muse Ons, and on-demand Gemini. **Neither a model name nor a scheduled task is proof of capability, action or review.**

| Required field | Meaning |
| --- | --- |
| Task ID / approved scope | Original founder scope ID, current issue, or explicit review assignment |
| Role / ownership | Implementer, safety reviewer, UX reviewer or domain checker; verify no active conflicting owner |
| Exact source | Main SHA, target PR head SHA, dependency and diff range checked **during this run** |
| Clinic task | One concrete receptionist/dentist/owner job from approved scope |
| Expected outcome | Visible state plus server-controlled clinical/money/permission meaning |
| Failure cases | Wrong patient; unconfirmed care; cross-clinic; duplicate/retry; offline; role denied; negative case |
| Baseline / goal | Observed metric with sample and environment, or **NOT_MEASURED**; proposed targets are not accepted |
| Evidence | Actual test commands, PASS/FAIL/SKIP, current CI link, screenshots or log where available |
| Independent disposition | PASS, WITH FIXES, BLOCK, or NOT REVIEWED, tied to exact SHA and reviewer |
| Next actor | Assigned owner, blockers, dependency and explicit founder gate if relevant |

### Agent protocol

1. Discover live current main, accepted scope and in-progress ownership in GitHub + Mission Control. Do not act on the last summary alone.
2. Check that this model's actual tools/privileges can run the requested actions. If not, report the missing access, never simulate execution.
3. For changes, work in a new isolated draft PR, reuse patterns, minimize scope, run actual tests and record negative evidence. Never merge or touch production automatically.
4. For independent reviews, inspect exact diff and real UI where claiming usability; cite severity/file/line and clear reproduction. No rubber-stamp, no self-approval.
5. For A/B comparisons, hold fictional scenario, environment and acceptance outcome constant; measure task completion, errors, steps, accessibility, not just beautiful screenshots.
6. Publish durable PR links and append-only assigned Sheet reports with readback. Scheduled GPT/Codex will discover new handoffs; Muse/Muse Ons/Gemini cannot be assumed to execute when merely named in a Sheet.

No AI agent diagnoses patients, signs a clinical action for a dentist, creates a real payment or independently proves physical cash counts.
