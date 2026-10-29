#!/usr/bin/env bash
# Verify the integration candidate: every PR head is included, migrations are unique and ordered, install,
# typecheck, generated permission matrix in sync, full PostgreSQL 16 suite, CI demos, compiled build.
# Needs a local PostgreSQL 16 superuser URL in EZZ_TEST_ADMIN_URL (fictional throwaway databases only), e.g.
#   export EZZ_TEST_ADMIN_URL=postgres://postgres:fictional-ci-only@localhost:5432/postgres
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
: "${EZZ_TEST_ADMIN_URL:?set EZZ_TEST_ADMIN_URL to a local PostgreSQL 16 superuser URL}"
echo "== candidate $(git rev-parse --short HEAD)"
missing=0
while read -r num sha branch; do
  [ -z "$num" ] && continue
  if git merge-base --is-ancestor "$sha" HEAD; then echo "ok   PR #$num ${sha:0:7}"; else echo "MISS PR #$num ${sha:0:7}"; missing=1; fi
done < <(grep -v '^#' scripts/integration/prs.txt)
[ $missing = 0 ] || { echo "a PR head is missing"; exit 1; }
dups=$(ls backend/migrations | cut -c1-4 | sort | uniq -d); [ -z "$dups" ] || { echo "duplicate migration numbers: $dups"; exit 1; }
echo "migrations: $(ls backend/migrations | tr '\n' ' ')"
cd backend
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm run -s typecheck && echo "typecheck ok"
node scripts/gen-permission-matrix.ts | diff -q - ../docs/security/permission-matrix.md >/dev/null && echo "permission matrix in sync"
npm test 2>&1 | tee /tmp/ezz-r72-tests.log | grep -E '^# (tests|pass|fail|skipped)|^not ok'
grep -q '^# fail 0' /tmp/ezz-r72-tests.log
node scripts/demo-visit-journey.ts > /tmp/ezz-r72-demo-visit.log && echo "demo-visit-journey ok"
node scripts/demo-dentist-encounter.ts > /tmp/ezz-r72-demo-encounter.log && echo "demo-dentist-encounter ok"
npm run -s build && rm -rf dist && echo "build ok"
echo "== VERIFIED (local). Logs: /tmp/ezz-r72-*.log"
