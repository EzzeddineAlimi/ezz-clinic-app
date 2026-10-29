# EZZ Clinic — integration readiness and test evidence

Verified: 2026-10-29 UTC, before creation of this documentation PR. **Not merge-ready on this audit's evidence.** No application branches have been edited or merged. Documentation is based on main because it changes no runtime files and does not need the unmerged backend to build; fixed-SHA source links describe that backend accurately without importing it.

## Live repository baseline

- main is c89d6e6889575b757324262ec73f6984c54c0467; PR1 merged 2026-10-27T21:03:17Z (squash import). main tree 1c568481a60f34df80253001263c42a7f1993e4e contains the prototype, no backend.
- GitHub compare main…#34: ahead86/behind0, base main SHA above. Returned earlier PR heads #2–20 all appear in #21 commit history. #21→#34 is the stacked lineage; no rebase needed to preserve it. A graph allowing fast-forward does not mean GitHub's selected merge method will perform one.
- 34 existing PR records: #1 merged; the other 33 open and draft. Numbers4–7 are not returned PRs. No current head change from the first audit was observed.
- Repository was public in the prior live metadata read; this redo verifies branch metadata main protected=false/required checks enforcement off. Treat repository visibility and protection as founder configuration decisions; no settings changed.

## Exact PR manifest

Source: live GET /repos/EzzeddineAlimi/ezz-clinic-app/pulls?state=all&per_page=100 and main branch read. Every SHA below is a complete head SHA at audit time. Base is the current PR target branch, not proof of integration into main.

| PR | Title / branch | Head | Base branch | State |
|---|---|---|---|---|
| [#1](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/1) | Import verified fictional-data prototype v0.1<br>`chore/import-fictional-prototype` | `8d0b95b3974d49aebddc58cbfcfe1fbcc37aceee` | `main` | MERGED 2026-10-27T21:03:17Z |
| [#2](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/2) | Review Opus 5.5 v0.2 fictional backend and security tests<br>`feat/opus55-v02-backend-review` | `2defdcafbf8b4332935f09091e52f7f17d5ab324` | `main` | open / DRAFT |
| [#3](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/3) | Fix CH-026: compare all stored audit fields with canonical event<br>`fix/opus55-audit-field-fidelity` | `b6563eb29611684a368557fd3f952f0221d547b3` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#8](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/8) | R46: 20-visit paper outage vs experimental SQLite outbox<br>`feat/outage-20-visit-drill` | `38190f424befc6ea15d512fc9e47f715d0a418d6` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#9](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/9) | R46: dental domain contracts + tests for Astra (nonvisual)<br>`docs/astra-clinical-contracts` | `addc5a531976ed72083849ebf979664fa46e3694` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#10](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/10) | Build first real visit workbench API: patient → dentist → checkout<br>`feat/visit-workbench-readmodel` | `0fe3bf3ef7b11aefc3816c35248c0ace89d4b40a` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#11](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/11) | Fix CH-028: workbench balance provenance; zeroed visits no longer read "no payment required"<br>`claude/ch028-workbench-provenance` | `26a139c54d13dca743a65d00e570c3896ed88759` | `feat/visit-workbench-readmodel` | open / DRAFT |
| [#12](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/12) | B07: dentist clinical core — site amendments (CH-032), medical alerts gate, signed notes, findings, treatment plan, encounter & record APIs<br>`claude/b07-clinical-core` | `da644283e81d73627d89991ab4af9d86787bc4fd` | `claude/ch028-workbench-provenance` | open / DRAFT |
| [#13](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/13) | B05: node-postgres driver with enforced verified TLS for remote hosts and safe pooling (issue #4)<br>`claude/b05-pg-tls-pool` | `52112328e510130b52b639e3b46e6132f8865c75` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#14](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/14) | B06: owner integrity check compares financial rows with their audited values (CH-027, issue #5)<br>`claude/b06-business-value-integrity` | `660f6998db88286cd695f563a7c67a054106d36d` | `fix/opus55-audit-field-fidelity` | open / DRAFT |
| [#15](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/15) | B14: encrypted backup + verified restore onto a fresh PostgreSQL 16 instance (DR drill)<br>`claude/b14-backup-restore-drill` | `c4921d09a51275361cc5da152e983b2d97b10452` | `claude/b05-pg-tls-pool` | open / DRAFT |
| [#16](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/16) | B10: drawer-period count evidence in the visit workbench (period counted ≠ payment verified)<br>`claude/b10-cash-period-evidence` | `e16e624e9c7310de1b90e8318903b487bb4966d9` | `claude/ch028-workbench-provenance` | open / DRAFT |
| [#17](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/17) | B11: owner financial review API (read-only, owner-only)<br>`claude/b11-owner-financial-review` | `3e20d236d282d5b8af712e715622de604644bf14` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#18](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/18) | B12: clinic-local day-board API and patient-flow guards<br>`claude/b12-day-board` | `1b3102a4165599e41452dc8b1bba740e3bfb186b` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#19](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/19) | B13: conflict-safe paper slip re-entry and book-level care reconciliation (extends #8)<br>`claude/b13-paper-reconciliation` | `2b9ae5040d2dab378755bb4a923f7a734ea8b3c3` | `feat/outage-20-visit-drill` | open / DRAFT |
| [#20](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/20) | B15: printable FR/AR receipt and paper workflow contracts<br>`claude/b15-printable-contracts` | `2817d71ab50fd9dcb3dcb0723e8dd7603539cffe` | `feat/opus55-v02-backend-review` | open / DRAFT |
| [#21](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/21) | DRAFT — R72 integration candidate (all open PRs combined; DO NOT MERGE)<br>`integration/r72-candidate` | `0a57234aafe34db3c34bf742b442e4ff8b6d51d9` | `main` | open / DRAFT |
| [#22](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/22) | R73-A: owner-controlled independent audit checkpoints (create, print, verify, restore)<br>`r73/a-owner-checkpoints` | `87b715ee180a28e0497736b807e9bc59c3473040` | `integration/r72-candidate` | open / DRAFT |
| [#23](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/23) | R73-B: compiled tests fixed, migration safety, fail-fast startup, real PostgreSQL TLS tests, dev environment<br>`r73/b-dev-reliability` | `92e011de400e1805a031f4b61dc929ec37a74e08` | `r73/a-owner-checkpoints` | open / DRAFT |
| [#24](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/24) | R73-C: audited clinic settings; remove hard-coded UTC/timezone handling<br>`r73/c-clinic-settings` | `bd173aecbe848112d343129522acaa169da9831c` | `r73/b-dev-reliability` | open / DRAFT |
| [#25](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/25) | R73-D: secure patient documents and dental imaging attachments (foundation)<br>`r73/d-patient-documents` | `fddae0e8ecbd122b546ba3e217801308f944bb7d` | `r73/c-clinic-settings` | open / DRAFT |
| [#26](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/26) | R73-E: dental lab cases (MF19 exceptions) and basic stock ledger<br>`r73/e-lab-stock` | `0848839d0709c982add8185926195f3a44a995f9` | `r73/d-patient-documents` | open / DRAFT |
| [#27](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/27) | R73-F: measured performance and resilience benchmarks; readiness 503 fix (PostgreSQL crash test)<br>`r73/f-benchmarks` | `f5526dc1ef9c44c6a59ced6cf3010d623daaeb7c` | `r73/e-lab-stock` | open / DRAFT |
| [#28](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/28) | R73-G: generated OpenAPI, recorded Astra examples, live contract tests, frontend security states + GPT takeover<br>`r73/g-api-contracts` | `62530273e3b69e91c1cab8ef076794d0e6ed431d` | `r73/f-benchmarks` | open / DRAFT |
| [#29](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/29) | R73-H: B06 integrity hardening for Muse M-267 (objections 1–7) and CH-034, RED first<br>`r73/h-b06-hardening` | `67f794836ec8df7c1caee555261b7ea937c56b85` | `r73/g-api-contracts` | open / DRAFT |
| [#30](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/30) | R73-I: clinic-day denial counter, bounded desk alert declarations, examples for all 102 operations<br>`r73/i-residuals` | `3d8354d190c715d083f73221d4c41c53d66d1b52` | `r73/h-b06-hardening` | open / DRAFT |
| [#31](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/31) | R74-A refactor: one owner per shared rule (locks, pg arrays, dental site, clinic day), stricter compiler, no behaviour change<br>`r74/a-dry-kernel` | `7daeafcaee980ff2113bfbe2e514ae3ffbf19ae6` | `r73/i-residuals` | open / DRAFT |
| [#32](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/32) | R74-B: billing→cash wired in the composition root and failing closed; modules never import the DB driver<br>`r74/b-explicit-wiring` | `f8231043e8b27e1f4ca55686d67bb96c2ced6b16` | `r74/a-dry-kernel` | open / DRAFT |
| [#33](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/33) | R74-C: owner exceptions from named sources; table-driven optional integrity checks (output proven identical)<br>`r74/c-integrity-owners` | `beef1689f84acbc46636ba9a375bd09924e67dae` | `r74/b-explicit-wiring` | open / DRAFT |
| [#34](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/34) | R74-D: no catch-all for expected absences (ARCH-9) + full SOLID audit report (deliverables A–F)<br>`r74/d-no-swallowed-errors` | `51e188b10a91b7269ff0d3db7d3fd320f97b325c` | `r74/c-integrity-owners` | open / DRAFT |
| [#35](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/35) | R75-A: legacy cash times fail safe — INCONCLUSIVE, never silently verified (CH-035 + legacy carry-forward start)<br>`r75/a-legacy-cash-time` | `90a7027457f6bdcf34c4f1de65eb68047548a1f2` | `r74/d-no-swallowed-errors` | open / DRAFT |
| [#36](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/36) | R75-B: appointment/late-entry times need a UTC offset; impossible dates refused (CH-038) + CH-036/037 safe-behaviour note<br>`r75/b-appointment-time-offset` | `7f8957926bbd77443e1ad2cb02c0fcef319a5e0a` | `r74/d-no-swallowed-errors` | open / DRAFT |
| [#37](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/37) | R75-C (docs only): correct R74 audit report — PR #1 merged, skipped test is T-TLS-5, ARCH-9 scope<br>`r75/c-audit-report-provenance` | `5c4b0dc301586a7b29451df38265786da76e8e4a` | `r74/d-no-swallowed-errors` | open / DRAFT |
| [#38](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/38) | R75-D: cash-period resolver cannot be silently replaced; explicit fail-closed reset (Muse M-269 #32 residual)<br>`r75/d-cash-resolver-lifecycle` | `a4cc2e4fba30d86c4eddb15f09dfd6de22afbb10` | `r74/d-no-swallowed-errors` | open / DRAFT |
| [#39](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/39) | R75-E: one owner resolution closes one exception, never all future ones of its kind (integrity + checkpoint reminder)<br>`r75/e-exception-keys` | `f6f0b3c4d38a4395ae5ea18eff9d7cc2a9cff6dc` | `r75/a-legacy-cash-time` | open / DRAFT |
| [#40](https://github.com/EzzeddineAlimi/ezz-clinic-app/pull/40) | R75-F (docs only): dependency-aware integration and merge-readiness plan<br>`r75/f-integration-plan` | `5e1493f9fd63ac42f54d18ce2ad5ba3713b1cd5a` | `r74/d-no-swallowed-errors` | open / DRAFT |

## Dependency map and isolated fixes

```text
main c89d6e6
 ├─ #2 foundation + #3/#8–20 slices → #21 0a57234 (all these heads ancestors)
 │    → #22 → #23 → #24 → #25 → #26 → #27 → #28 → #29 → #30
 │    → #31 → #32 → #33 → #34 51e188b
 │                              ├─ #35 90a7027 → #39 f6f0b3c
 │                              ├─ #36 7f89579
 │                              ├─ #37 5c4b0dc (docs)
 │                              ├─ #38 a4cc2e4
 │                              └─ #40 5e1493f (docs integration plan)
 └─ new documentation audit branch (this PR; no backend import)
```

#34 contains G1–G4 runtime work, not G5 fixes. #39 includes #35 by base, but not #36/#37/#38. #40 is a plan based on #34 and includes none of the isolated G5 code. Green runs on these siblings cannot prove the composition.

| Fix | Source-inspected effect | Required independent acceptance |
|---|---|---|
| #35 | integrity.ts adds LEGACY_TIME_UNANCHORED/INCONCLUSIVE for legacy cash timestamps across cutoffs; checks carried-forward start against accepted count/anchored close; exceptions preserve uncertainty | Legacy paired timestamp/expected changes, carry-forward boundary and historical false-positive tests on combined head |
| #36 | validate.isoTime rejects missing offset and impossible calendar dates; timezone policy note is design only | Same valid/invalid inputs under UTC/Africa-Tunis/America-Toronto; copy/appointment timezone policy still unresolved |
| #37 | Corrects PR1 merge provenance, T-TLS-5 skip and ARCH-9 regex scope in R74 report | Verify documentation against CI log and review source; no runtime fix |
| #38 | Billing resolver refuses replacement by a different function, supports fail-closed reset | Order-independent wiring tests, CASH refusal while unwired, same-function rewiring |
| #39 | Exception key includes check/detail hash; checkpoint reminder keyed by last checkpoint sequence; explicit clinic filter | Resolve findingA then introduceB of same type; new checkpoint interval reappears; cross-clinic negative tests |

All fix patches and test filenames were reread directly from current PR files endpoints. No local combined merge/reproduction was performed. Hashing finding text in #39 needs stable detail semantics; it is not a fraud proof or a substitute for review.

## Original reviews and remaining blockers

The following are direct reads of original MODEL_INBOX rows, not merely PR40's summary. Muse's execution is inherited evidence, not Codex execution.

| Review | Actual bounded result / current disposition |
|---|---|
| [M-261](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A261:H261) | B02 CONDITIONAL, not founder-gate-ready. CH-028 waived/zero-fee provenance, CH-030 paper wrong-patient attribution, CH-032 site divergence and runtime acceptance. Subsequent #11/#12/#19/#21 code addresses parts, but no new overall founder-gate closure inferred. Paper patientFileNo check remains optional. |
| [M-264](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A264:H264) / [M-265](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A265:H265) | B07 bounded static answers; overall verdict pending. OWNER finance free-text carve-out requires founder/privacy decision. #21 has later clinical integrity/role/concurrency fixes, but integrated independent review remains required. Hash acknowledgement is presentation consistency, not proof of reading. |
| [M-266](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A266:H266) | B05 static pass on bounded transport questions with wrong-host verify-ca, trust-store/pinning, raw-acquire/error handling objections. #21/#23 contain later transport/real-TLS tests; do not call old review a full integrated pass. |
| [M-267](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A267:H267) | Original B06 expected-cash recomputation inputs, receipt full snapshot, corrections, adjustment hashes, count display, deleted-period and clinic-scope gaps. #29/#34 address new anchored-event paths per direct source and M-269; legacy paths need #35. |
| [M-269](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A269:H269) | #31 PASS; #32 WITH_FIXES (resolver lifecycle → #38); #33 PASS with static-only equivalence classes; #34 WITH_FIXES (doc provenance → #37). Muse executed 12 architecture/wiring tests and pure helpers at #34, no DB suite. Legacy tolerance and unreviewed G3/integration remain. |
| [M-270](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A270:H270) | #22 PASS/#23 PASS/#24 WITH_FIXES; missing-offset server-TZ behaviour reproduced by Muse, fixed in isolated #36. Muse executed 5 architecture tests and pure helpers at #24; DB suite not executed. CH-036/037, B10/B15/B07 and #21-as-whole remain open. |
| [C-206](https://docs.google.com/spreadsheets/d/1tsLppkHcR6nK5Ovc-NcOfFV-qg8Tzcgvh-M5cksRM7g/edit#gid=2004&range=A206:H206) | Author reports all R75 fixes and locally composed suite. Inherited author evidence only. No review of G5/G3 or M-261 decision supplied by this handoff. |

Primary integration plan: [PR40 document at 5e1493f9fd63ac42f54d18ce2ad5ba3713b1cd5a](https://github.com/EzzeddineAlimi/ezz-clinic-app/blob/5e1493f9fd63ac42f54d18ce2ad5ba3713b1cd5a/docs/handoff/R75-INTEGRATION-PLAN.md). Its reported no-conflict composition remains author evidence. Its statement that merging group tops automatically marks every contained PR merged is not used as a release criterion; actual GitHub target/merge semantics must be verified.

## Executed, inherited and blocked test evidence

| Classification | Exact action/evidence | Result / limitation |
|---|---|---|
| E-CODEX | node test/clinic.test.mjs, Node24.19.0, exact source mirror | **7/7 PASS**; prototype only |
| E-CODEX | node backend/test/clinical-contract.test.ts | **4/4 PASS**; pure FDI/site/surface contract only, no clinical acceptance |
| E-CODEX | node --test --test-reporter=tap variants | Exit0 but reporter lists one file-level subtest each; direct runs above provide named assertion counts |
| E-CODEX failed | backend npm run typecheck | tsc not found; no typecheck acceptance |
| E-CODEX failed | backend node --test --test-reporter=tap test/c1-identity-care.test.ts | ERR_MODULE_NOT_FOUND pg; no DB assertions ran |
| BLOCKED infra | command -v psql/tsc; docker info; git ls-remote | PG binaries/tools and TypeScript absent; Docker socket operation not permitted; configured proxy:8080 unreachable for Git shell |
| CI-LOG-VERIFIED | [run40865577498](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40865577498), job123419388634 at #34 | Read job steps and decoded log. Source and compiled: **325 total /324 pass /0 fail /1 skip** each; T-CRASH-1 passed; T-TLS-5 skipped without EZZ_TEST_TLS_ROOTCERT. Not local reproduction. |
| CI-STATUS-VERIFIED | #34 forward-node24/26 jobs | Steps/conclusions success; no separate manual log audit for each forward job |
| AUTHOR-REPORTED | C-206 #35/#36/#38/#39 and combined G5 | Author source/dist per-fix results; combined 337/336/0/1 in UTC/Tunis/Toronto and compiled. Not Codex-composed/CI candidate evidence. |
| PEER-EXECUTED | Muse M-269/M-270 | Bounded pure/architecture/wiring results described above; no Muse DB suite |
| NOT RUN | Codex full PG suite, migrations, TLS, restore, benchmarks, browser/RTL/accessibility | No claim of success; proposed acceptance requirements below |

Local mirror provenance: 127 previously materialized source/config/test files initially had one extra trailing newline from patch transport. This redo removed only that transport byte and verified **127/127 Git blob hashes against the live #34 tree**; then reran the 7+4 direct tests. Missing backend lockfile/docs/public HTML mean this remains an audit mirror, not a reproducible installed checkout. No remote runtime file changed.

### Current run-status evidence

Run status read directly by exact head; success is not a claim that every test ran or that sibling fixes were integrated.

| PR | Run | Workflow | Conclusion |
|---|---|---|---|
| #21 | [40769076161](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40769076161) | Backend v0.2 fictional-data checks | success |
| #24 | [40774755319](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40774755319) | Backend v0.2 fictional-data checks | success |
| #30 | [40808968966](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40808968966) | Backend v0.2 fictional-data checks | success |
| #34 | [40865577498](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40865577498) | Backend v0.2 fictional-data checks | success |
| #35 | [40872044491](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40872044491) | Backend v0.2 fictional-data checks | success |
| #36 | [40874071398](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40874071398) | Backend v0.2 fictional-data checks | success |
| #38 | [40875409555](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40875409555) | Backend v0.2 fictional-data checks | success |
| #39 | [40877837609](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40877837609) | Backend v0.2 fictional-data checks | success |
| #40 | [40879692863](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40879692863) | Fictional prototype checks | success |
| #40 | [40879667259](https://github.com/EzzeddineAlimi/ezz-clinic-app/actions/runs/40879667259) | Fictional prototype checks | success |

#40 only triggered prototype workflow runs in these results; its green status is **not backend CI evidence**. Source workflow [.github/workflows/backend-ci.yml](https://github.com/EzzeddineAlimi/ezz-clinic-app/blob/51e188b10a91b7269ff0d3db7d3fd320f97b325c/.github/workflows/backend-ci.yml) runs Node22 supported, Node24/26 forward checks, PG16, source/dist, demo journeys and fresh migration checks. It has no explicit non-UTC TZ matrix, no deployment job and no browser frontend suite. Postgres image is tagged16 rather than digest-pinned; action SHAs are pinned but provenance re-verification is still a supply-chain gate.

## Safe sequence (requires separate coding/integration assignment)

1. Freeze this exact manifest; request founder-authorised manual Muse review of G5, then G3 (especially uploads), then integrated #21/B07/B10/B15 and M-261 gate. No outbound review request was sent in this task.
2. Provision supported Node22 and throwaway PG16 with scram auth, dependencies from verified lockfile, TLS fixtures and restore tooling. Repair shell proxy/runner access using approved environment configuration, not a bypass.
3. On a NEW isolated integration branch, compose accepted #34 and #35→#39, #36, #37, #38; include #40 documentation as appropriate. Never overwrite/rebase old heads. C-206's clean local merge must be reproduced and recorded, not assumed.
4. Run full acceptance on the final exact SHA and obtain review of that composition. Re-review new code changes; do not transfer an old PASS to new commits automatically.
5. Founder chooses merge method, target retargeting and sequence. main/G1/G2/G3/G4/G5 ordering is a review plan, not permission to merge or assertion that automatic PR closure proves integration.

### Required negative/timezone/operational gates

- UTC, Africa/Tunis, America/Toronto source and compiled full suites; clinic-zone effective-date boundaries, invalid offsets/impossible dates, server-zone independence, DST examples and clinic setting recovery.
- Receipt original/COPY after clinic-zone change, new issuing-zone snapshot, legacy zone-not-recorded warning, immutable original issue dates. D-TZ-1..5 require product/local validation.
- CH-035 legacy cash window paired edits, carry-forward start; CH-039 later finding after resolved same-kind finding; checkpoint reminder recurrence and no cross-clinic suppression.
- Two simultaneous booking requests same dentist/chair; explicit override policy and stale preview detection. Static scheduling race identified in architecture audit needs a real PG reproduction.
- Two simultaneous perform/refund/void/credit allocations; no orphan care, negative/duplicate balances, receipt collision or idempotent replay after lost HTTP response.
- Cross-tenant IDs in patient/visit/clinical/doc/lab/CNAM routes; role escalation, deactivation, reauth expiry, CSRF/origin/host/error redaction, upload compressed payload cases, and no bulk desk export.
- Fresh and upgrade migrations, modified/unknown ledger rejection, concurrent migrator exclusion (not currently implemented), readiness fail-closed and least-privilege pool reuse.
- Wrong-host verify-full refusal, explicitly documented verify-ca weakness, pinned CA policy, real TLS test including currently skipped T-TLS-5 or equivalent evidence.
- SIGKILL/restart, PG crash/recovery, encrypted backup→fresh restore→owner-held checkpoint verification and missing/old-backup detection; no real patients.
- Runtime/contract regeneration drift, meaningful limits for integrity scans, fictional performance smoke and responsive FR/AR keyboard/large-text/no-phone print workflows.

No merge, deploy, new scheduler, review agent or application implementation is authorised by this document.
