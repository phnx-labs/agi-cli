#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: release-pr-lines.sh <owner/repo> <base-branch>}"
BASE="${2:?usage: release-pr-lines.sh <owner/repo> <base-branch>}"
jq -r --arg repo "$REPO" --arg base "$BASE" '
  .[]
  | select(.head.repo.full_name == $repo)
  | select(.base.repo.full_name == $repo and .base.ref == $base)
  | "\(.number) \(.head.ref)"
'
