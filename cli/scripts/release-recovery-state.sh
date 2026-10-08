#!/usr/bin/env bash
set -euo pipefail

PUBLISHED="${1:?usage: release-recovery-state.sh <true|false> <tag-sha-or-empty> <branch-sha-or-empty>}"
TAG_SHA="${2-}"
BRANCH_SHA="${3-}"
[[ "$PUBLISHED" == "true" || "$PUBLISHED" == "false" ]] \
  || { echo "error: published state must be true or false" >&2; exit 1; }

if [[ -n "$TAG_SHA" ]]; then
  [[ -n "$BRANCH_SHA" ]] \
    || { echo "error: tag points at $TAG_SHA but the release branch is missing" >&2; exit 1; }
  [[ "$BRANCH_SHA" == "$TAG_SHA" ]] \
    || { echo "error: tag points at $TAG_SHA but the release branch points at $BRANCH_SHA" >&2; exit 1; }
  printf 'retry-tag:%s\n' "$TAG_SHA"
elif [[ -n "$BRANCH_SHA" ]]; then
  printf 'retry-branch:%s\n' "$BRANCH_SHA"
elif [[ "$PUBLISHED" == "true" ]]; then
  echo "error: registry version exists without a matching immutable release branch/tag" >&2
  exit 1
else
  echo new
fi
