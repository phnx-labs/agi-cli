#!/usr/bin/env bash

set -euo pipefail

[[ $# -ge 2 ]] || { echo "usage: release-worktree.sh <repo-root> <release args...>" >&2; exit 2; }

REPO_ROOT="$1"
shift
RELEASE_ARGS=("$@")
TARGET=""
for arg in "${RELEASE_ARGS[@]}"; do
  [[ "$arg" == --* ]] || { TARGET="$arg"; break; }
done
[[ -n "$TARGET" ]] || { echo "error: release version is required" >&2; exit 2; }

git -C "$REPO_ROOT" fetch --quiet origin
DEFAULT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[[ -n "$DEFAULT_BRANCH" ]] || DEFAULT_BRANCH="main"

WORKTREE="$REPO_ROOT/.agents/worktrees/release-v$TARGET-$$"
cleanup() {
  git -C "$REPO_ROOT" worktree remove "$WORKTREE" >/dev/null 2>&1 \
    || printf 'Retained release worktree for inspection: %s\n' "$WORKTREE" >&2
}
trap cleanup EXIT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_BASE="origin/$DEFAULT_BRANCH"
PROOF_BASE="$("$SCRIPT_DIR/release-attested-base.sh" "$REPO_ROOT" "$RELEASE_BASE")" \
  || { echo "error: no attested origin/$DEFAULT_BRANCH ancestor is available for release" >&2; exit 1; }
if [[ "$(git -C "$REPO_ROOT" rev-parse "$PROOF_BASE")" != "$(git -C "$REPO_ROOT" rev-parse "$RELEASE_BASE")" ]]; then
  behind="$(git -C "$REPO_ROOT" rev-list --count "$PROOF_BASE..$RELEASE_BASE")"
  printf 'note: current origin/%s inherits proof from attested ancestor %s across %s release-irrelevant commit(s)\n' \
    "$DEFAULT_BRANCH" "${PROOF_BASE:0:9}" "$behind" >&2
fi

git -C "$REPO_ROOT" worktree add --quiet --detach "$WORKTREE" "$RELEASE_BASE" \
  || { echo "error: could not create release worktree at $WORKTREE from $RELEASE_BASE" >&2; exit 1; }

missing="$(git -C "$WORKTREE" status --short | awk '$1 == "D" || $2 == "D" { print $2 }')"
if [[ -n "$missing" ]]; then
  printf 'error: release worktree %s is incomplete; missing tracked files:\n%s\n' "$WORKTREE" "$missing" >&2
  printf 'Remove only this isolated release worktree, then retry: %s\n' "$WORKTREE" >&2
  exit 1
fi

CLI_SUBDIR="cli"
[[ -d "$WORKTREE/cli" ]] || CLI_SUBDIR="apps/cli"
cd "$WORKTREE/$CLI_SUBDIR"
scripts/release.sh "${RELEASE_ARGS[@]}" --orchestration-phase
