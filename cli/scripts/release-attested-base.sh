#!/usr/bin/env bash
# Prints the newest commit at or below `origin/<branch>` whose tree has a published attestation on
# the rolling `main-attestations` release (PHNX-3705). The tip is rarely attested, so any attested
# ancestor serves; `derive`'s allowlist still fails closed on code files.
set -euo pipefail

REPO_ROOT="${1:?usage: release-attested-base.sh <repo-root> <branch> [lookback]}"
BRANCH="${2:?usage: release-attested-base.sh <repo-root> <branch> [lookback]}"
LOOKBACK="${3:-40}"
ATTEST_TAG="${RELEASE_ATTEST_TAG:-main-attestations}"

assets="${RELEASE_ATTEST_ASSETS-}"
if [[ -z "$assets" ]]; then
  command -v gh >/dev/null 2>&1 || exit 1
  assets="$(gh release view "$ATTEST_TAG" --json assets -q '.assets[].name' 2>/dev/null || true)"
fi
[[ -n "$assets" ]] || exit 1

while read -r sha; do
  [[ -n "$sha" ]] || continue
  tree="$(git -C "$REPO_ROOT" rev-parse "$sha^{tree}" 2>/dev/null)" || continue
  if grep -qxF "attest-$tree.json" <<<"$assets"; then
    printf '%s\n' "$sha"
    exit 0
  fi
done < <(git -C "$REPO_ROOT" rev-list -n "$LOOKBACK" "origin/$BRANCH" 2>/dev/null)

exit 1
