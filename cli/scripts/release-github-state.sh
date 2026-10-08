#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: release-github-state.sh <owner/repo> <tag>}"
TAG="${2:?usage: release-github-state.sh <owner/repo> <tag>}"
set +e
response="$(gh api -i --silent "repos/$REPO/releases/tags/$TAG" 2>&1)"
status=$?
set -e
if [[ $status -eq 0 ]]; then
  echo present
elif grep -qE '^HTTP/[^ ]+ 404 ' <<<"$response"; then
  echo absent
else
  printf 'error: could not query GitHub release %s/%s\n%s\n' "$REPO" "$TAG" "$response" >&2
  exit 1
fi
