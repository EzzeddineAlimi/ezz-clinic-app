#!/usr/bin/env bash
# Recreate the R72 merge sequence from main into a throwaway branch and compare it with the candidate's
# "all PRs merged" commit. Read-only towards every PR branch: it only reads their exact head SHAs.
# Usage: scripts/integration/rebuild.sh [target-branch]   (default: integration/r72-rebuild-check)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
here="$(cd "$(dirname "$0")" && pwd)"
target=${1:-integration/r72-rebuild-check}
git fetch -q origin main
for sha in $(grep -v '^#' $here/prs.txt | awk '{print $2}'); do git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch -q origin "$sha"; done
git switch -q -c "$target" origin/main
grep -v '^#' $here/prs.txt | while read -r num sha branch; do
  [ -z "$num" ] && continue
  if ! git merge --no-ff -q -m "Integrate PR #$num ($branch @ ${sha:0:7})" "$sha" >/dev/null 2>&1; then
    # Only the two known ADDITIVE conflicts (route list, module map) are resolved automatically: keep both sides.
    for f in $(git diff --name-only --diff-filter=U); do
      case "$f" in backend/src/app.ts|backend/test/architecture.test.ts) ;; *) echo "UNEXPECTED conflict in $f (PR #$num)"; exit 1;; esac
      python3 - "$f" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [0-9a-f]+\n", lambda m: m.group(1) + m.group(2), s, flags=re.S)
open(p, 'w').write(s)
PY
      git add "$f"
    done
    git commit -q --no-edit -m "Integrate PR #$num ($branch @ ${sha:0:7}); additive conflicts resolved"
  fi
  echo "merged PR #$num ${sha:0:7}"
done
echo "rebuilt: $(git rev-parse --short HEAD)"
ref=$(git log --format=%H --grep='^Integrate PR #20' -1 integration/r72-candidate 2>/dev/null || true)
if [ -n "$ref" ]; then
  if git diff --quiet "$ref" HEAD; then echo "IDENTICAL tree to the candidate's all-merged commit ${ref:0:7}"; else echo "DIFFERS from ${ref:0:7}:"; git diff --stat "$ref" HEAD; exit 1; fi
fi
