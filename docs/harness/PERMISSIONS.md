# Security boundary matrix: actual controls versus instructions

| Actor | Allowed development scope | Forbidden without separate authority | Status of enforcement |
| --- | --- | --- | --- |
| GPT COO | Approved frontend/architecture drafting, fictional tests, shared governance handoff, narrowly delegated low-risk merges after exact-head CI/review | High-risk merges, deploy, real patients, self-approve safety | Standing founder authorization is a **process rule**, not verified token isolation or required-check enforcement (#68) |
| Codex scheduled | Approved unclaimed backend task in isolated branch; draft PR and tests | Steal UX task, overwrite another branch, merge, production | Task preflight and ownership convention; hard token isolation **not proven** |
| Primary Muse | Independent financial, privacy, clinical safety and permission critique | Self-approval or real clinic operations | Manual reviewer; exact GitHub read-only permissions **not independently verified** |
| Muse Ons | Independently critique actual UI, 1440/390 FR/AR RTL accessibility and dangerous states | Own GPT implementation or waive review gates | Manual; no verified automatic schedule |
| Gemini | On-demand Tunisian clinic/domain research with source evidence | Unverified legal/CNAM rates or autonomous clinical decisions | Manual; no verified automatic schedule |
| Harness CI | Checkout GitHub repo; run Node 22 read-only source reference checks | Secrets, databases, deployment, releases | **Enforced in the workflow** by `permissions: contents: read`; no checkout credentials to production |

## Hardening backlog, never implied complete

- GitHub main `protected: true` alone does **not** prove all mandatory checks, approvals or admin bypass rules work. Verify/enforce with issue #68.
- Use dedicated least-privilege credentials for each external agent; prompts alone cannot constrain a token that already has broad access.
- Protect CI from PR source injection, secret exfiltration and untrusted shell data. This new check only reads static files and uses no user-supplied shell expansion.
- Do not place real patient data, passwords, provider reports or live clinical screenshots in public repo/Sheet or model prompts.
- Prod identity/MFA, HTTPS, backups, monitoring, malware quarantine, key custody and legal gates remain issue #72.
- Medical and financial authority is enforced by the application's server, not by model-specific prompt wording.

Standing founder authorization allows only reviewed low-risk development merges; the founder retains explicit decisions for high-risk merges and all production releases. Professional clinical, fiscal and privacy approval remain separate. An independent review is never inferred from green CI.
