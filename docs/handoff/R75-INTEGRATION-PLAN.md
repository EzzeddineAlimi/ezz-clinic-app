# R75 integration and merge-readiness plan (draft, for founder decision)

Claude, manual session 2026-10-29. Every fact below was checked live on GitHub or in git **today**. Nothing is merged or approved, and nothing is production-ready. All data is fictional. **The founder alone approves any merge.**

## 1. The real dependency graph

- **One lineage, not 39 independent PRs.** `git merge-base --is-ancestor` shows every head of #2–#20 is an ancestor of #21 `0a57234`. #21 is an ancestor of #22 → … → #34 `51e188b`.
- From `main` `c89d6e6` to #34 there are 86 commits, 171 files, +45,599 lines. `main` is an ancestor of #34, so a **fast-forward** is possible: no rebase is needed and there is no conflict.
- Merging the top PR of a group into `main` makes GitHub mark every PR contained in it as merged.
- **PR #1 is merged** (squash merge `c89d6e6`, 2026-10-27 21:03:17Z).
- R75 drafts (this session) branch off #34:
  - #35, #36, #37, #38 each have base #34;
  - #39 has base #35.
  - Local merge of all five onto `51e188b`: **no conflicts**. Merged tree: **337 tests / 336 pass / 0 fail / 1 skip (T-TLS-5)**, under server TZ=UTC and TZ=Africa/Tunis (America/Toronto and compiled runs: see the PR thread).

| Group | PRs (head) | Content | Independent review (exact head) | CI on head |
|---|---|---|---|---|
| G1 foundation + R72 integration | #21 `0a57234` containing #2–#20 | v0.2 backend, B05 TLS, B06, B07 clinical, B10–B15, R72 fixes | Muse reviewed slices standalone: M-266 (#13 STATIC PASS + objections), M-267 (#14 → fixed in #29), M-264/265 (B07 partial). **#21 as an integrated whole: NOT reviewed** (M-270 dep. 1–2). B02 founder gate (M-261), B07 overall, B10/B15 pending | green (run 40769076161) |
| G2 R73 A–C | #22 `87b715e`, #23 `92e011d`, #24 `bd173ae` | owner checkpoints; migrations / fail-fast / TLS; clinic settings | **Muse M-270: PASS / PASS / WITH_FIXES** (isoTime → fixed by **#36**) | green (40771653298, 40773639125, 40774755319) |
| G3 R73 D–I | #25 `fddae0e` … #30 `3d8354d` | documents/imaging; lab/stock; benchmarks; OpenAPI; B06 hardening; residuals | **NOT reviewed by Muse** (only the #29 `integrity.ts` slice, statically, in M-269) | green (runs 40799914860 … 40808968966) |
| G4 R74 SOLID | #31 `7daeafc`, #32 `f823104`, #33 `beef168`, #34 `51e188b` | DRY kernel; explicit wiring; exceptions sources; no catch-alls + report | **Muse M-269: PASS / WITH_FIXES / PASS / WITH_FIXES** | green (40811005829 … 40865577498) |
| G5 R75 corrections | #35 `90a7027`, #36 `7f89579`, #37 docs, #38 `a4cc2e4`, #39 `f6f0b3c` | fixes for the blockers named by Muse/GPT | **NOT reviewed** | green (40872044491, 40874071398, 40875409555, 40877837609; #37 docs-only) |

## 2. True blockers (each with an owner)

| # | Blocker | Status | Owner |
|---|---|---|---|
| B1 | CH-035 legacy ±120 s, plus the legacy carry-forward start that was **not compared at all** (new, unbounded) | fixed in **#35**, RED→GREEN | Muse review |
| B2 | #24 / CH-038: offset-less `scheduledAt`/`effectiveAt` read in the server TZ; `02-30` moved to `03-02` (new) | fixed in **#36**, RED→GREEN | Muse review |
| B3 | #32 resolver could be silently replaced (M-269 a) | fixed in **#38**, RED→GREEN | Muse review |
| B4 | #34 report: PR #1 wording, the skip name, ARCH-9 scope | fixed in **#37** (docs) | Muse / GPT check |
| B5 | Exception keys: one resolution hid all later integrity findings of the same kind; the checkpoint reminder could be silenced for good (new, anti-theft fail-open) | fixed in **#39**, RED→GREEN | Muse review |
| B6 | G3 (#25–#30) has no independent review. #25 handles uploads (magic bytes, quarantine, CSP) and is security-relevant | open | **Muse**, needs founder authorization (only COMMAND 535/536 scopes exist) |
| B7 | #21 integrated whole not reviewed; B07 overall verdict; B10/B15 reviews; B02 founder gate M-261 | open | Muse; founder for M-261 |
| B8 | CH-036/037 product decisions D-TZ-1..5 (`docs/product/timezone-change-safety.md`, in #36) | open, documented | **Founder** |
| B9 | Production gates unchanged: Tunisian legal/privacy (CH-003/004/005/006), hosting, TLS pinning, real backups, clinical validation. CH-002 (cash never entered) cannot be closed by software | open | Founder + qualified local advice |

Not blockers (recorded): #31 disclosed wording changes; #33 equivalence for card/count kinds is static only; deleted-period double finding (noise); `card:import:stale` constant key (candidate); `dev-pg16.sh` `rm -rf` guard; verify-ca accepted for remote hosts (documented weakness, verify-full preferred).

## 3. Shortest safe path (no rebase, no giant refactor)

1. **Founder:** authorize Muse to review G5 (#35–#39) and G3 (#25–#30) at the exact heads above. G5 is small (≈+300 lines, mostly tests), so review it first.
2. **Muse:** G5 → G3 → the #21-integrated checks (B7). Any fix goes on a NEW branch, never onto a reviewed head.
3. **Integration candidate:** one draft branch = #34 + #35…#39 merged (the composition already proven locally above). Run the gates in §4 on it in CI. It replaces separate merges of #35–#39.
4. **Founder merges in order**, each a fast-forward of `main`: G1 (#21) → G2 (#24) → G3 (#30) → G4 (#34) → G5 (integration candidate). Merge only when that group's review is PASS at the merged head and CI is green there. A changed commit invalidates the earlier review (R64).
5. #2–#20 then show as merged automatically. No separate work is needed.

## 4. Integration tests required on the candidate head (beyond the per-PR CI)

- Full suite, source **and** compiled, PG 16 + Node 22 (CI today), plus forward-node 24/26 (CI today).
- **The same suite with server `TZ=Africa/Tunis` and `TZ=America/Toronto`.** CI runs UTC only, which is how CH-038 and the T-OWN-9/T-SET-9 time bomb hid. Proposed as a CI matrix entry; not added in this PR.
- T-TLS-5 with `EZZ_TEST_TLS_ROOTCERT` set: the only test that has never run in CI. T-TLS-REAL-1..4 already cover a self-started TLS cluster.
- Fresh-database migration ledger check; `doctor.ts`; the demo journeys; `r72-whole-clinic-journey`.
- B14 backup → restore → `restore-verify` (with checkpoint lines) on the candidate.
- Benchmark smoke (0 isolation violations, 0 lost or duplicated payments after SIGKILL).

## 5. Rebase / conflict risk

- Low, because the lineage is linear and every PR is stacked.
- Risk arises only if someone pushes to a mid-stack head (#22–#33). Every later PR would then need a merge-forward, and its review would go stale. Rule: **no pushes to reviewed heads; fixes on new branches**, as done for #35–#39.
- #39 depends on #35 (same lines of `exceptions.ts`). Review and merge them together.
