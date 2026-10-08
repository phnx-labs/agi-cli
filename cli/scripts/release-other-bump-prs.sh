#!/usr/bin/env bash

set -euo pipefail

CURRENT="${1:-}"
[[ -n "$CURRENT" ]] || { echo "usage: release-other-bump-prs.sh <current-release-branch> < prs" >&2; exit 2; }

while read -r number branch _rest; do
  [[ -n "${number:-}" && -n "${branch:-}" ]] || continue
  [[ "$branch" =~ ^release/[0-9]+\.[0-9]+\.[0-9]+(-pre\.[0-9]+)?$ ]] || continue
  [[ "$branch" != "$CURRENT" ]] || continue
  printf '#%s %s\n' "$number" "$branch"
done
