#!/usr/bin/env bash

set -euo pipefail

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"
cd "$(dirname "$0")/.."

EXPECTED_VERSION="${1:-}"
LOCAL_ASSETS=""
PUBLISH_DRY_RUN=false
if [[ "${2:-}" == "--local-assets" ]]; then
  [[ -n "${3:-}" ]] || die "--local-assets needs a directory"
  LOCAL_ASSETS="$3"
  shift 3
elif [[ -n "${2:-}" ]]; then
  die "unknown flag: $2"
else
  shift $(( $# > 0 ? 1 : 0 ))
fi
if [[ "${1:-}" == "--publish-dry-run" ]]; then
  PUBLISH_DRY_RUN=true
  shift
fi
[[ $# -eq 0 ]] || die "unexpected argument: $1"

REF="${GITHUB_REF:-}"
PREFIX="refs/heads/release/"
[[ "$REF" == "$PREFIX"* ]] \
  || die "release workflow requires GITHUB_REF=$PREFIX<x.y.z>, got '${REF:-unset}'"
VERSION="${REF#"$PREFIX"}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-pre\.[0-9]+)?$ ]] \
  || die "release branch must be release/x.y.z or release/x.y.z-pre.n, got release/$VERSION"
[[ -z "$EXPECTED_VERSION" || "$EXPECTED_VERSION" == "$VERSION" ]] \
  || die "workflow version $EXPECTED_VERSION does not match branch version $VERSION"

PACKAGE_VERSION="$(jq -r .version package.json)"
[[ "$PACKAGE_VERSION" == "$VERSION" ]] \
  || die "release/$VERSION carries package version $PACKAGE_VERSION"

scripts/release-other-branch.sh "release/$VERSION" \
  || die "another branch-push release must finish before release/$VERSION"

HEAD_SHA="$(git rev-parse HEAD)"
HEAD_TREE="$(git rev-parse 'HEAD^{tree}')"
RELEASE_BRANCH="release/$VERSION"
scripts/release-require-branch-head.sh origin "$RELEASE_BRANCH" "$HEAD_SHA" \
  || die "$RELEASE_BRANCH moved after this workflow was triggered"

if [[ -n "$LOCAL_ASSETS" ]]; then
  args=("$VERSION" --ci-publish --artifacts-dir "$LOCAL_ASSETS" \
    --expected-release-branch "$RELEASE_BRANCH")
  $PUBLISH_DRY_RUN && args+=(--publish-dry-run)
  exec scripts/release.sh "${args[@]}"
fi

[[ "${GITHUB_ACTIONS:-}" == "true" ]] || die "release-ci.sh only mutates releases in GitHub Actions"
[[ -n "${GH_TOKEN:-}" ]] || die "GH_TOKEN is required to create the tag and GitHub release"
[[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] \
  || die "GitHub OIDC is unavailable; grant permissions: id-token: write"
[[ -z "${NODE_AUTH_TOKEN:-}" && -z "${NPM_TOKEN:-}" ]] \
  || die "stored npm tokens are forbidden; configure npm trusted publishing for release.yml"

REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT_SHA="$(git rev-parse 'HEAD^')" \
  || die "release commit must have one parent on main"
git fetch --quiet origin main \
  || die "could not fetch canonical origin/main"
git merge-base --is-ancestor "$PARENT_SHA" origin/main \
  || die "release parent $PARENT_SHA is not on canonical origin/main"
scripts/release-attestation.sh validate-release-tree \
  --repo-root "$REPO_ROOT" --base "$PARENT_SHA" --commit "$HEAD_SHA" >/dev/null \
  || die "release/$VERSION changes files outside the release metadata allowlist"
REPO="${GITHUB_REPOSITORY:-phnx-labs/agi-cli}"
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agents-cli-branch-release.XXXXXX")"
BASE_STORE="$WORK/base"
RELEASE_STORE="$WORK/release"
ASSET_DIR="$WORK/assets"
EXISTING_DIR="$WORK/existing"
mkdir -p "$BASE_STORE" "$RELEASE_STORE" "$ASSET_DIR" "$EXISTING_DIR"

remote_tag_commit() {
  local refs peeled direct
  refs="$(git ls-remote --tags origin "refs/tags/v$VERSION" "refs/tags/v$VERSION^{}")"
  peeled="$(awk '$2 ~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  direct="$(awk '$2 !~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  printf '%s' "${peeled:-$direct}"
}

REMOTE_TAG_SHA="$(remote_tag_commit)"
[[ -z "$REMOTE_TAG_SHA" || "$REMOTE_TAG_SHA" == "$HEAD_SHA" ]] \
  || die "v$VERSION already points at $REMOTE_TAG_SHA, not release branch head $HEAD_SHA"

RELEASE_STATE="$(scripts/release-github-state.sh "$REPO" "v$VERSION")" \
  || die "could not establish GitHub release state for v$VERSION"
if [[ "$RELEASE_STATE" == "present" ]]; then
  existing_valid=false
  if gh release download "v$VERSION" --repo "$REPO" \
      --pattern release-attestation.json --pattern 'phnx-labs-agents-cli-*.tgz' \
      --dir "$EXISTING_DIR"; then
    EXISTING_ATTEST="$(scripts/release-attestation.sh require \
      --dir "$EXISTING_DIR" --tree "$HEAD_TREE" --repo-root "$REPO_ROOT" 2>/dev/null || true)"
    if [[ -n "$EXISTING_ATTEST" ]]; then
      EXISTING_TGZ_JSON="$(scripts/release-attestation.sh tarball \
        --file "$EXISTING_ATTEST" --require-file 2>/dev/null || true)"
      EXISTING_TGZ=""
      if [[ -n "$EXISTING_TGZ_JSON" ]]; then
        EXISTING_TGZ="$(jq -r '.path // empty' <<<"$EXISTING_TGZ_JSON")"
      fi
      if [[ -n "$EXISTING_TGZ" ]] \
        && scripts/release-attestation.sh promote \
          --file "$EXISTING_ATTEST" --tarball "$EXISTING_TGZ" >/dev/null 2>&1; then
        existing_valid=true
      fi
    fi
  fi
  if $existing_valid; then
    scripts/release-ensure-tag.sh "$VERSION" "$HEAD_SHA" "$REMOTE_TAG_SHA" "$RELEASE_BRANCH"
    exec scripts/release.sh "$VERSION" --ci-publish --artifacts-dir "$EXISTING_DIR" \
      --expected-release-branch "$RELEASE_BRANCH"
  fi
  REGISTRY_STATE="$(scripts/release-registry-state.sh "@phnx-labs/agents-cli" "$VERSION")" \
    || die "could not establish registry state before replacing invalid v$VERSION assets"
  [[ "$REGISTRY_STATE" == "absent" ]] \
    || die "v$VERSION release assets are invalid but npm already exposes the immutable version; refusing to replace canonical evidence"
fi

PROOF_MODE="--inherit"
if ! PROOF_SHA="$(scripts/release-attested-base.sh "$REPO_ROOT" "$PARENT_SHA")"; then
  PROOF_MODE="--impact"
  PROOF_SHA="$(scripts/release-attested-base.sh \
    "$REPO_ROOT" "$PARENT_SHA" --allow-relevant-drift)" \
    || die "release parent $PARENT_SHA has no retained tested ancestor"
fi
scripts/release-attestation.sh validate-release-inputs \
  --repo-root "$REPO_ROOT" --base "$PROOF_SHA" --commit "$HEAD_SHA" >/dev/null \
  || die "release/$VERSION changes files outside the CLI release-input allowlist since attested base $PROOF_SHA"
PROOF_TREE="$(git rev-parse "$PROOF_SHA^{tree}")"
gh release download main-attestations \
  --repo "$REPO" \
  --pattern "attest-$PROOF_TREE.json" \
  --dir "$BASE_STORE" \
  || die "could not download the selected main proof for $PROOF_SHA"
PROOF_WT="$WORK/proof-tree"
git worktree add --quiet --detach "$PROOF_WT" "$PROOF_SHA" \
  || die "could not inspect retained proof tree $PROOF_SHA"
BASE_ATTEST="$(scripts/release-attestation.sh require \
  --dir "$BASE_STORE" --tree "$PROOF_TREE" --repo-root "$PROOF_WT")" \
  || die "main proof $PROOF_SHA is not valid for its attested tree"
git worktree remove --force "$PROOF_WT" >/dev/null

PROOF_VALUE="$BASE_ATTEST"
[[ "$PROOF_MODE" == "--inherit" ]] || PROOF_VALUE="$PROOF_SHA"
scripts/release-ci-produce.sh "$HEAD_SHA" "$RELEASE_STORE" \
  "$PROOF_MODE" "$PROOF_VALUE" \
  || die "could not build and attest release/$VERSION"
RELEASE_ATTEST="$(scripts/release-attestation.sh require \
  --dir "$RELEASE_STORE" --tree "$HEAD_TREE" --repo-root "$REPO_ROOT")" \
  || die "producer did not write an exact-tree release attestation"
TGZ_JSON="$(scripts/release-attestation.sh tarball --file "$RELEASE_ATTEST" --require-file)"
TGZ="$(jq -r .path <<<"$TGZ_JSON")"
scripts/release-attestation.sh promote --file "$RELEASE_ATTEST" --tarball "$TGZ" >/dev/null
cp "$RELEASE_ATTEST" "$ASSET_DIR/release-attestation.json"
cp "$TGZ" "$ASSET_DIR/$(basename "$TGZ")"

scripts/release-ensure-tag.sh "$VERSION" "$HEAD_SHA" "$REMOTE_TAG_SHA" "$RELEASE_BRANCH"

release_args=("v$VERSION" "$ASSET_DIR"/* --verify-tag --title "v$VERSION")
release_args+=(--notes-file ".changelog/$VERSION.md")
[[ "$VERSION" =~ -pre\.[0-9]+$ ]] && release_args+=(--prerelease)
if [[ "$RELEASE_STATE" == "present" ]]; then
  gh release upload "v$VERSION" "$ASSET_DIR"/* \
    --repo "$REPO" --clobber
else
  gh release create "${release_args[@]}" \
    --repo "$REPO"
fi

scripts/release.sh "$VERSION" --ci-publish --expected-release-branch "$RELEASE_BRANCH"
