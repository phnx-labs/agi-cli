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

HEAD_SHA="$(git rev-parse HEAD)"
HEAD_TREE="$(git rev-parse 'HEAD^{tree}')"

if [[ -n "$LOCAL_ASSETS" ]]; then
  args=("$VERSION" --ci-publish --artifacts-dir "$LOCAL_ASSETS")
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

if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  existing_valid=false
  if gh release download "v$VERSION" --repo "$REPO" \
      --pattern release-attestation.json --pattern 'phnx-labs-agents-cli-*.tgz' \
      --dir "$EXISTING_DIR"; then
    EXISTING_ATTEST="$(scripts/release-attestation.sh require \
      --dir "$EXISTING_DIR" --tree "$HEAD_TREE" --repo-root "$REPO_ROOT" 2>/dev/null || true)"
    if [[ -n "$EXISTING_ATTEST" ]]; then
      EXISTING_TGZ_JSON="$(scripts/release-attestation.sh tarball \
        --file "$EXISTING_ATTEST" --require-file 2>/dev/null || true)"
      EXISTING_TGZ="$(jq -r '.path // empty' <<<"${EXISTING_TGZ_JSON:-{}}")"
      if [[ -n "$EXISTING_TGZ" ]] \
        && scripts/release-attestation.sh promote \
          --file "$EXISTING_ATTEST" --tarball "$EXISTING_TGZ" >/dev/null 2>&1; then
        existing_valid=true
      fi
    fi
  fi
  if $existing_valid; then
    exec scripts/release.sh "$VERSION" --ci-publish --artifacts-dir "$EXISTING_DIR"
  fi
  [[ "$(npm view "@phnx-labs/agents-cli@$VERSION" version 2>/dev/null || true)" != "$VERSION" ]] \
    || die "v$VERSION release assets are invalid but npm already exposes the immutable version; refusing to replace canonical evidence"
fi

PROOF_SHA="$(scripts/release-attested-base.sh "$REPO_ROOT" "$PARENT_SHA")" \
  || die "release parent $PARENT_SHA has no safe main attestation in its recent ancestry"
PROOF_TREE="$(git rev-parse "$PROOF_SHA^{tree}")"
gh release download main-attestations \
  --repo "$REPO" \
  --pattern "attest-$PROOF_TREE.json" \
  --dir "$BASE_STORE" \
  || die "could not download the selected main proof for $PROOF_SHA"
BASE_ATTEST="$(scripts/release-attestation.sh require \
  --dir "$BASE_STORE" --tree "$PROOF_TREE" --repo-root "$REPO_ROOT")" \
  || die "main proof $PROOF_SHA is not valid under this release policy"

scripts/release-attestation-produce.sh "$HEAD_SHA" \
  --inherit-suite-from "$BASE_ATTEST" --dir "$RELEASE_STORE" \
  || die "could not build and attest release/$VERSION"
RELEASE_ATTEST="$(scripts/release-attestation.sh require \
  --dir "$RELEASE_STORE" --tree "$HEAD_TREE" --repo-root "$REPO_ROOT")" \
  || die "producer did not write an exact-tree release attestation"
TGZ_JSON="$(scripts/release-attestation.sh tarball --file "$RELEASE_ATTEST" --require-file)"
TGZ="$(jq -r .path <<<"$TGZ_JSON")"
scripts/release-attestation.sh promote --file "$RELEASE_ATTEST" --tarball "$TGZ" >/dev/null
cp "$RELEASE_ATTEST" "$ASSET_DIR/release-attestation.json"
cp "$TGZ" "$ASSET_DIR/$(basename "$TGZ")"

if [[ -z "$REMOTE_TAG_SHA" ]]; then
  git config user.name "agents-cli release"
  git config user.email "release@phnx-labs.invalid"
  scripts/create-annotated-release-tag.sh "$VERSION" "$HEAD_SHA"
  git push origin "refs/tags/v$VERSION"
fi

release_args=("v$VERSION" "$ASSET_DIR"/* --verify-tag --title "v$VERSION")
release_args+=(--notes-file ".changelog/$VERSION.md")
[[ "$VERSION" =~ -pre\.[0-9]+$ ]] && release_args+=(--prerelease)
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$ASSET_DIR"/* \
    --repo "$REPO" --clobber
else
  gh release create "${release_args[@]}" \
    --repo "$REPO"
fi

scripts/release.sh "$VERSION" --ci-publish
