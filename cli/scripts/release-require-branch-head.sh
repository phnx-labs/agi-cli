#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:?usage: release-require-branch-head.sh <remote> <branch> <expected-sha>}"
BRANCH="${2:?usage: release-require-branch-head.sh <remote> <branch> <expected-sha>}"
EXPECTED="${3:?usage: release-require-branch-head.sh <remote> <branch> <expected-sha>}"
EXPECTED="$(git rev-parse "$EXPECTED^{commit}")"
actual="$(git ls-remote --heads "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1; exit}')" \
  || { echo "error: could not read remote branch $BRANCH" >&2; exit 1; }
[[ "$actual" == "$EXPECTED" ]] || {
  echo "error: remote $BRANCH points at ${actual:-<missing>}, not workflow head $EXPECTED" >&2
  exit 1
}
