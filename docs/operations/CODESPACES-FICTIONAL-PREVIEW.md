# EZZ Clinic — private GitHub Codespaces preview (fictional data only)

**Status:** repository configuration for a private, user-authenticated, temporary development preview. This is **not** a deployment or proof of production readiness. It requires a Codespace created and started by the GitHub account owner. The exact preview URL is created by GitHub **after the Codespace starts**.

## Requirements and threat boundary

- A GitHub account with Codespaces access and available compute quota. Codespaces may consume your included hours or incur charges; check your GitHub billing before creating one.
- Create the Codespace from the **reviewed branch containing `.devcontainer/`**, not an older `main` lacking these files.
- Forward **only port 5173**, with port visibility explicitly shown as **Private**, never Public or Organization.
- GitHub authenticates private forwarded ports; open the port URL in a browser signed in as the Codespace owner.
- The web browser makes same-origin API calls through the Vite **built preview** proxy. To authenticate the private forwarded port, the browser sends GitHub's own same-origin authentication cookie **only at the exact Codespaces HTTPS preview hostname**. The EZZ app itself still does not create or read session cookies; API permissions remain enforced using the app's memory-only bearer session. Port **4180** stays bound to loopback and is not forwarded. PostgreSQL has **no TCP listener**, **no published port**, and is accessed over a Docker Compose shared Unix socket only.
- The backend's `isSynthetic` requirement remains unchanged; no patient data or image from a real clinic belongs in this Codespace. Fictional credentials are intentionally published for a fixture **behind the separate private GitHub port authentication**; if the port accidentally becomes public, STOP THE PREVIEW.

## Start from a phone (no laptop required)

1. Open [**Create EZZ Clinic private Codespace from the preview branch**](https://codespaces.new/EzzeddineAlimi/ezz-clinic-app/tree/gpt/codespaces-private-fictional-preview) in Safari, and sign in to GitHub. This link selects the branch containing `.devcontainer/`; no repository-wide merge is needed for the test.
2. Confirm the selected branch is `gpt/codespaces-private-fictional-preview`, then create the Codespace (or use **Code → Codespaces → New with options** in the repository). Choose the smallest suitable machine; Codespaces can incur compute/storage charges. You will be able to open its editor in the browser.
3. Allow the container to finish `postCreateCommand` (it installs both locked npm dependency sets). Open a terminal in the Codespace.
4. Run:
   ```sh
   bash .devcontainer/start-preview.sh
   ```
   The command builds the real frontend, waits for the disposable API to become healthy, and serves the **built** web app on port **5173**.
5. Select the editor's **PORTS** tab. Verify **5173 → Visibility: Private**. If anything says Public or Organization, change it to Private *before opening the preview*. Do not forward 4180 or 5432.
6. In the PORTS tab, select port 5173 → **Open in Browser** (or copy the forwarded HTTPS address). GitHub may ask you to authenticate again. If it does, sign in with the same GitHub account that created the Codespace.
7. Use only the seeded test credentials:
   - Clinic: `web-fictional`
   - Username: `desk` (or `dentist`, `owner`, `assistant`; each account has role-limited fictional development workflows)
   - Password: `fictional-pass-123`

These are demo-only accounts and **must not be used in a public port or production**. No one should enter real patient details.

## What to verify on your phone

- Open the app through the GitHub-authenticated private HTTPS port.
- Login → receptionist agenda populated with fictional patients.
- Switch **FR ↔ العربية**, inspect RTL layout, navigate appointments.
- Search an existing fictional file and create a new clearly fictional patient without a phone number.
- Schedule a fictional appointment and record arrival.
- Logout, then verify the interface returns to login.

This branch contains fictional-data receptionist checkout, dentist clinical notes/workspace and owner cash-control screens in addition to the day board. They are **development features**, not verified clinical, payment, physical-cash custody or production workflows. The newer UX-12/13/14 integration candidate in PR #100 is a separate unmerged draft; do not assume its fixes are included in this preview. Verify what the running branch actually shows rather than treating a role's ability to sign in as acceptance evidence.

## Stopping and removal

- Press `Ctrl-C` in the terminal where the preview is running to stop the frontend and API; on orderly shutdown the backend fixture drops its disposable test database.
- **Stop the Codespace** from GitHub Codespaces management when finished; delete it when it is no longer needed to remove its remaining disposable environment and avoid storage charges. Stop/delete the private forwarded port if it remains.
- No GitHub Actions test, local devcontainer validation, or Codespace build alone certifies that Safari on your own phone can access the link; **test it after GitHub creates the actual private forwarding URL**.

## Failure boundaries

- **Blank page / 502:** Check that the terminal remains running, `npm --prefix frontend run build` passed, and the 5173 PORTS row exists.
- **Missing GitHub authentication / unauthorized:** Ensure the port is still Private and sign in to GitHub as its creator. Do **not** make the port public to bypass the sign-in.
- **PostgreSQL connection error:** Confirm the Compose database service is healthy and `EZZ_TEST_ADMIN_URL` includes `host=/var/run/postgresql`; never change to a remote plaintext database host.
- **400 invalid host or 403 origin:** Check that Codespaces set `CODESPACES=true` and `CODESPACE_NAME`; the Vite/backend allowlists accept only the corresponding exact forwarded hostname. Do not use wildcard allowed hosts.
- **Codespace doesn't pick up configuration:** Verify you created it from the preview branch, or rebuild the container using the new `.devcontainer/devcontainer.json`.
- **Codespaces is unavailable or requires billing:** Do not activate a paid plan without your own choice; the same fictional workflow still runs locally as described in [frontend instructions](../../frontend/README.md).

## Security and scope

No production hosting, no public ports, no real patients, no real payment processing, no external database, no live email/SMS integrations. A passing private preview demonstrates only that a temporary fictional-data workflow can be opened after GitHub authentication. Professional security, legal, clinical, fiscal and Tunisian privacy/CNAM approvals remain separately gated.
