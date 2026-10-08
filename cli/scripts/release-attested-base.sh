#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:?usage: release-attested-base.sh <repo-root> <ref> [lookback]}"
TARGET_REF="${2:?usage: release-attested-base.sh <repo-root> <ref> [lookback]}"
LOOKBACK="${3:-40}"
ATTEST_TAG="${RELEASE_ATTEST_TAG:-main-attestations}"

assets="${RELEASE_ATTEST_ASSETS-}"
if [[ -z "$assets" ]]; then
  command -v gh >/dev/null 2>&1 || exit 1
  release_id="$(gh api "repos/{owner}/{repo}/releases/tags/$ATTEST_TAG" --jq .id 2>/dev/null || true)"
  [[ -n "$release_id" ]] || exit 1
  assets="$(gh api --paginate "repos/{owner}/{repo}/releases/$release_id/assets?per_page=100" \
    --jq '.[].name' 2>/dev/null || true)"
fi
[[ -n "$assets" ]] || exit 1

TARGET_SHA="$(git -C "$REPO_ROOT" rev-parse "$TARGET_REF^{commit}" 2>/dev/null)" || exit 1
while read -r sha; do
  [[ -n "$sha" ]] || continue
  tree="$(git -C "$REPO_ROOT" rev-parse "$sha^{tree}" 2>/dev/null)" || continue
  grep -qxF "attest-$tree.json" <<<"$assets" || continue
  if git -C "$REPO_ROOT" diff --quiet "$sha" "$TARGET_SHA" -- \
      cli apps/cli packages/session-tracker scripts/ci-scope.ts; then
    printf '%s\n' "$sha"
    exit 0
  fi
done < <(git -C "$REPO_ROOT" rev-list -n "$LOOKBACK" "$TARGET_SHA" 2>/dev/null)

exit 1
