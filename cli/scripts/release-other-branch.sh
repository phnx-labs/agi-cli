#!/usr/bin/env bash
set -euo pipefail

CURRENT="${1:?usage: release-other-branch.sh <current-release-branch> [remote]}"
REMOTE="${2:-origin}"
refs="$(git ls-remote --heads "$REMOTE" 'refs/heads/release/*')" \
  || { echo "error: could not read remote release branches from $REMOTE" >&2; exit 1; }
others=""
while read -r _sha ref; do
  branch="${ref#refs/heads/}"
  [[ "$branch" != "$CURRENT" ]] || continue
  version="${branch#release/}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-pre\.[0-9]+)?$ ]] || continue
  others+="$branch"$'\n'
done <<<"$refs"
[[ -z "$others" ]] || {
  printf 'error: another branch-push release is in flight:\n%s' "$others" >&2
  exit 1
}
