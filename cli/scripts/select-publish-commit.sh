#!/usr/bin/env bash
# Pick the commit a release tags and publishes, given the squash-merge commit and the CI-tested PR
# head. The tarball must be a tree CI went green on: if unrelated PRs merged during CI, publish
# the CI-tested commit and the rest ride the next release.
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: select-publish-commit.sh <merged-sha> <ci-tested-sha>" >&2; exit 2; }
merged_sha="$1"
ci_commit="$2"

if [[ "$(git rev-parse "$merged_sha^{tree}")" == "$(git rev-parse "$ci_commit^{tree}")" ]]; then
  # No drift: the merge tree still equals the CI-tested tree. Tag the merge commit.
  printf '%s\n' "$merged_sha"
else
  # Concurrent-merge drift: publish the exact commit the matrix went green on.
  printf '%s\n' "$ci_commit"
fi
