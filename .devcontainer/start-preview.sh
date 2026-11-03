#!/usr/bin/env bash
# Start the built EZZ receptionist UI using the disposable, isolated fictional clinic.
# This does NOT deploy, publish ports or enable real patient data.
set -Eeuo pipefail

cd "$(dirname "$0")/.."

if [[ "${CODESPACES:-}" != "true" || ! "${CODESPACE_NAME:-}" =~ ^[a-z0-9-]+$ ]]; then
  echo "STOP: this preview may only run inside an authenticated GitHub Codespace." >&2
  exit 1
fi
if [[ "${EZZ_TEST_ADMIN_URL:-}" != *"host=/var/run/postgresql"* ]]; then
  echo "STOP: expected a local Unix-socket-only disposable PostgreSQL connection." >&2
  exit 1
fi
if [[ ! -d backend/node_modules || ! -d frontend/node_modules ]]; then
  echo "Dependencies absent. Rebuild your Codespace to run postCreateCommand." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is needed for the local readiness probe." >&2
  exit 1
fi
if ! node -e "const x=process.versions.node.split('.').map(Number);if(x[0]!==22||x[1]<18)process.exit(1)"; then
  echo "STOP: EZZ Clinic requires Node 22.18+ (not Node 24/26)." >&2
  exit 1
fi

echo "Building fictional-data web preview (React + TypeScript)..."
npm --prefix frontend run build

api_pid=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$api_pid" ]]; then
    kill -INT "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting disposable fictional database + API on loopback only..."
node backend/scripts/dev-web.ts &
api_pid=$!
ready=0
for _ in $(seq 1 90); do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "Preview API exited before readiness." >&2
    exit 1
  fi
  if curl --fail --silent --max-time 1 http://127.0.0.1:4180/api/v1/health >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Preview API readiness check failed." >&2
  exit 1
fi

echo
echo "Ready. Forward ONLY port 5173, keep its visibility PRIVATE, and open its HTTPS URL signed in to GitHub."
echo "Do NOT change port visibility to public or enter real patient information."
echo "Stopping this terminal also stops the disposable API/database."
echo
# Built production preview (not the development/HMR server), with same-origin API proxy.
npm --prefix frontend run preview -- --host 0.0.0.0
