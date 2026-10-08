#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${1:?usage: release-new-state-guard.sh <package> <target> <package-json-version> <repo> <base> <release-branch>}"
TARGET="${2:?usage: release-new-state-guard.sh <package> <target> <package-json-version> <repo> <base> <release-branch>}"
PACKAGE_JSON_VERSION="${3:?usage: release-new-state-guard.sh <package> <target> <package-json-version> <repo> <base> <release-branch>}"
REPO="${4:?usage: release-new-state-guard.sh <package> <target> <package-json-version> <repo> <base> <release-branch>}"
BASE="${5:?usage: release-new-state-guard.sh <package> <target> <package-json-version> <repo> <base> <release-branch>}"
RELEASE_BRANCH="${6:?usage: release-new-state-guard.sh <package> <target> <package-json-version> <repo> <base> <release-branch>}"
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"; [[ "$SCRIPT_DIR" != "${BASH_SOURCE[0]}" ]] || SCRIPT_DIR=.

LATEST="$(npm view "$PACKAGE@latest" version)" \
  || { echo "error: could not read the latest $PACKAGE version from npm" >&2; exit 1; }
[[ -n "$LATEST" ]] \
  || { echo "error: npm returned no latest version for $PACKAGE" >&2; exit 1; }

TARGET_STATE="$("$SCRIPT_DIR/release-registry-state.sh" "$PACKAGE" "$TARGET")" \
  || exit 1
[[ "$TARGET_STATE" == "absent" ]] \
  || { echo "error: $PACKAGE@$TARGET is already present in the immutable registry" >&2; exit 1; }

tag_refs="$(git ls-remote --tags origin "refs/tags/v$TARGET" "refs/tags/v$TARGET^{}")" \
  || { echo "error: could not read remote tag v$TARGET" >&2; exit 1; }
[[ -z "$tag_refs" ]] \
  || { echo "error: remote tag v$TARGET appeared while preparing the release" >&2; exit 1; }

branch_sha="$("$SCRIPT_DIR/release-branch-head.sh" origin "$RELEASE_BRANCH" "$TARGET")" \
  || exit 1
[[ -z "$branch_sha" ]] \
  || { echo "error: remote branch $RELEASE_BRANCH appeared at $branch_sha" >&2; exit 1; }
"$SCRIPT_DIR/release-other-branch.sh" "$RELEASE_BRANCH" || exit 1

open_pr_lines="$(gh api --paginate "repos/$REPO/pulls?state=open&per_page=100" \
  | "$SCRIPT_DIR/release-pr-lines.sh" "$REPO" "$BASE")" \
  || { echo "error: could not list canonical open release PRs" >&2; exit 1; }
other_prs="$(printf '%s\n' "$open_pr_lines" \
  | "$SCRIPT_DIR/release-other-bump-prs.sh" "$RELEASE_BRANCH")"
[[ -z "$other_prs" ]] \
  || { echo "error: another release PR still owns the changelog queue: $other_prs" >&2; exit 1; }
current_pr="$(awk -v branch="$RELEASE_BRANCH" '$2 == branch { print $1; exit }' <<<"$open_pr_lines")"
[[ -z "$current_pr" ]] \
  || { echo "error: release PR #$current_pr for $RELEASE_BRANCH appeared while preparing" >&2; exit 1; }

if [[ "$TARGET" =~ -pre\.[0-9]+$ ]]; then
  printf 'pre-release %s\n' "$LATEST"
  exit 0
fi

BUMP="$("$SCRIPT_DIR/validate-bump.sh" "$LATEST" "$PACKAGE_JSON_VERSION" "0.0.0" "$TARGET")" \
  || exit 1
tag_facts=""
remote_tags="$(git ls-remote --tags origin 'refs/tags/v*')" \
  || { echo "error: could not read remote version tags" >&2; exit 1; }
while read -r _sha ref; do
  version="${ref#refs/tags/v}"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  [[ "$version" != "$LATEST" ]] || continue
  [[ "$(printf '%s\n%s\n' "$LATEST" "$version" | sort -V | tail -1)" == "$version" ]] || continue
  if npm view "$PACKAGE@$version" version >/dev/null 2>&1; then
    tag_facts+="$version yes"$'\n'
  else
    tag_facts+="$version no"$'\n'
  fi
done <<<"$remote_tags"
unpublished_tag="$(printf '%s' "$tag_facts" \
  | "$SCRIPT_DIR/stuck-release.sh" "$LATEST" "$BUMP" "$PACKAGE_JSON_VERSION" || true)"
[[ -z "$unpublished_tag" || "$unpublished_tag" == "$TARGET" ]] \
  || { echo "error: v$unpublished_tag is tagged but unpublished; release it before $TARGET" >&2; exit 1; }

printf '%s %s\n' "$BUMP" "$LATEST"
