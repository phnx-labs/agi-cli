#!/usr/bin/env bash
# Run release orchestration from a fresh detached origin/<default> worktree.

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

# Cut the release from the newest ATTESTED ancestor of origin/<default>, not the
# bare tip (PHNX-3705). On a repo where agents merge continuously the tip is
# essentially never attested -- attest-main.yml runs the full suite per push, so
# main outruns it and the release starves at phase 2 forever. An attested
# ancestor is an equally sound base: the tarball is still bound to a tree whose
# suite passed, and derive's allowlist still fails closed on any code file.
# Falls back to the tip when the resolver finds nothing, so phase 2 still fails
# loud with its usual message rather than this script dying obscurely.
# Absolute path: this script does not cd into cli/ until the very end, so a
# relative `scripts/...` here resolves against the CALLER's cwd and silently
# never runs -- which, combined with the `|| true`, would quietly fall back to
# the tip and make this whole change a no-op.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_BASE="$("$SCRIPT_DIR/release-attested-base.sh" "$REPO_ROOT" "$DEFAULT_BRANCH" 2>/dev/null || true)"
if [[ -z "$RELEASE_BASE" ]]; then
  RELEASE_BASE="origin/$DEFAULT_BRANCH"
elif [[ "$(git -C "$REPO_ROOT" rev-parse "$RELEASE_BASE")" != "$(git -C "$REPO_ROOT" rev-parse "origin/$DEFAULT_BRANCH")" ]]; then
  behind="$(git -C "$REPO_ROOT" rev-list --count "$RELEASE_BASE..origin/$DEFAULT_BRANCH")"
  printf 'note: releasing from the newest ATTESTED ancestor %s (%s commit(s) behind origin/%s); the tip is not attested yet\n' \
    "${RELEASE_BASE:0:9}" "$behind" "$DEFAULT_BRANCH" >&2
fi

git -C "$REPO_ROOT" worktree add --quiet --detach "$WORKTREE" "$RELEASE_BASE" \
  || { echo "error: could not create release worktree at $WORKTREE from $RELEASE_BASE" >&2; exit 1; }

missing="$(git -C "$WORKTREE" status --short | awk '$1 == "D" || $2 == "D" { print $2 }')"
if [[ -n "$missing" ]]; then
  printf 'error: release worktree %s is incomplete; missing tracked files:\n%s\n' "$WORKTREE" "$missing" >&2
  printf 'Remove only this isolated release worktree, then retry: %s\n' "$WORKTREE" >&2
  exit 1
fi

# The attestation store lives in the CALLER's checkout (that is where
# release-attestation-produce.sh writes it), but REPO_ROOT inside this
# throwaway worktree resolves to the worktree — so `require` looked in an empty
# directory and reported "missing exact attestation key" with `?` for every key
# component, which reads like a key mismatch rather than a wrong directory.
# Operators had to know to export RELEASE_ATTESTATION_DIR; now they do not
# (an explicit export still wins). RUSH-2970 trap 2.
if [[ -z "${RELEASE_ATTESTATION_DIR:-}" && -d "$REPO_ROOT/.release-attestations" ]]; then
  export RELEASE_ATTESTATION_DIR="$REPO_ROOT/.release-attestations"
fi

# apps/cli -> cli flatten (RUSH-3189 follow-up): the CLI moved up to cli/. Drive
# off whichever layout the checked-out default branch actually has.
CLI_SUBDIR="cli"
[[ -d "$WORKTREE/cli" ]] || CLI_SUBDIR="apps/cli"
cd "$WORKTREE/$CLI_SUBDIR"
scripts/release.sh "${RELEASE_ARGS[@]}" --orchestration-phase
