#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:?usage: release-branch-head.sh <remote> <branch> <version>}"
BRANCH="${2:?usage: release-branch-head.sh <remote> <branch> <version>}"
VERSION="${3:?usage: release-branch-head.sh <remote> <branch> <version>}"

sha="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1; exit}')"
[[ -n "$sha" ]] || exit 0
git fetch --quiet "$REMOTE" "refs/heads/$BRANCH"
actual="$(git show "$sha:cli/package.json" | jq -r .version)" \
  || { echo "error: $BRANCH does not carry a readable cli/package.json" >&2; exit 1; }
[[ "$actual" == "$VERSION" ]] \
  || { echo "error: $BRANCH carries package version $actual, not $VERSION" >&2; exit 1; }
printf '%s\n' "$sha"
