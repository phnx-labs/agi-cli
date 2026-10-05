#!/usr/bin/env bash
# Detect an earlier release's still-open version-bump PR before folding .changelog/next/*
# (PHNX-3084), so a later release does not fold the earlier version's notes under itself.
# release.sh's STUCK_BUMP_PR retry sees only the current target's PR.

set -euo pipefail

CURRENT="${1:-}"
[[ -n "$CURRENT" ]] || { echo "usage: release-other-bump-prs.sh <current-release-branch> < prs" >&2; exit 2; }

while read -r number branch _rest; do
  [[ -n "${number:-}" && -n "${branch:-}" ]] || continue
  # Only version-bump release branches -- release/v<semver>. A feature branch that
  # merely starts with "release" (release-notes-doc, releasing-guide) is not a
  # stuck bump and must not wedge every future release.
  [[ "$branch" =~ ^release/v[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  # The current target's own branch is handled by release.sh's same-target path,
  # not a cross-version conflict.
  [[ "$branch" != "$CURRENT" ]] || continue
  printf '#%s %s\n' "$number" "$branch"
done
