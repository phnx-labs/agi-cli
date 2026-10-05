#!/usr/bin/env bash
# Drop stale checkpoint/agent branches and orphan stash/reflog entries that may carry pre-scrub
# personal data, then gc. Run from the repo root. Idempotent; prompts before destructive ops.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REMOTE_BRANCHES=(
  task-03d89f4a
  task-33764465
  task-71179e82
  task-8b314ea9
  task-c5e76c39
  task-ebe4046a
  agent/EXAMPLE-314
  agent/project-agents-yaml
  agent/session-search-p2-p9
)

echo "==> Repo: $(pwd)"
echo "==> Current HEAD: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"
echo

echo "==> Stash entries"
git stash list || true
echo

echo "==> Remote branches that will be deleted on origin"
for b in "${REMOTE_BRANCHES[@]}"; do
  if git show-ref --quiet "refs/remotes/origin/$b"; then
    sha=$(git rev-parse --short "refs/remotes/origin/$b")
    subj=$(git log -1 --pretty=format:'%s' "refs/remotes/origin/$b")
    printf '  %-40s %s  %s\n' "$b" "$sha" "$subj"
  else
    printf '  %-40s (not found, skipping)\n' "$b"
  fi
done
echo

read -r -p "Proceed? [y/N] " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

echo
echo "==> 1. Dropping local stash entries"
while git rev-parse --verify --quiet refs/stash >/dev/null; do
  git stash drop
done

echo
echo "==> 2. Deleting remote branches on origin (one at a time, tolerant of misses)"
for b in "${REMOTE_BRANCHES[@]}"; do
  if git show-ref --quiet "refs/remotes/origin/$b"; then
    if git push origin --delete "$b" 2>/dev/null; then
      echo "  deleted: $b"
    else
      echo "  not on remote (already gone server-side): $b"
      git update-ref -d "refs/remotes/origin/$b" || true
    fi
  fi
done

echo
echo "==> 3. Pruning local remote-tracking refs"
git remote prune origin

echo
echo "==> 4. Expiring reflog and pruning unreachable objects"
git reflog expire --expire=now --all
git gc --prune=now --quiet

echo
echo "==> Verifying known orphans are gone"
ORPHANS=(fd71782 73c0285 3beb856 d233b73 1207c48 6b0263a 6bfaa1d bf659ab 6e2bfcf e6217c8)
remaining=0
for h in "${ORPHANS[@]}"; do
  if git cat-file -e "$h" 2>/dev/null; then
    held_by=$(git for-each-ref --contains="$h" --format='%(refname)' 2>/dev/null | head -1)
    printf '  %s  STILL EXISTS  %s\n' "$h" "${held_by:-(loose, not yet pruned)}"
    remaining=$((remaining + 1))
  else
    printf '  %s  gone\n' "$h"
  fi
done

echo
if [ "$remaining" -eq 0 ]; then
  echo "Clean. All 10 orphan commits dropped."
else
  echo "$remaining orphan(s) still reachable. Inspect refs above and re-run."
  exit 1
fi
