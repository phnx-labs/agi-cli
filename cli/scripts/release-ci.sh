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
[[ -z "${NODE_AUTH_TOKEN:-}" && -z "${NPM_TOKEN:-}" ]] \
  || die "stored npm tokens are forbidden; configure npm trusted publishing for release.yml"

REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT_SHA="$(git rev-parse 'HEAD^')" \
  || die "release commit must have one parent on main"
PARENT_TREE="$(git rev-parse "$PARENT_SHA^{tree}")"
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agents-cli-branch-release.XXXXXX")"
BASE_STORE="$WORK/base"
RELEASE_STORE="$WORK/release"
ASSET_DIR="$WORK/assets"
mkdir -p "$BASE_STORE" "$RELEASE_STORE" "$ASSET_DIR"

gh release download main-attestations \
  --repo "${GITHUB_REPOSITORY:-phnx-labs/agents-cli}" \
  --pattern "attest-$PARENT_TREE.json" \
  --dir "$BASE_STORE" \
  || die "main parent $PARENT_SHA has no published exact-tree attestation"
BASE_ATTEST="$(scripts/release-attestation.sh require \
  --dir "$BASE_STORE" --tree "$PARENT_TREE" --repo-root "$REPO_ROOT")" \
  || die "main parent $PARENT_SHA is not attested under this release policy"

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

remote_tag_commit() {
  local refs peeled direct
  refs="$(git ls-remote --tags origin "refs/tags/v$VERSION" "refs/tags/v$VERSION^{}")"
  peeled="$(awk '$2 ~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  direct="$(awk '$2 !~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  printf '%s' "${peeled:-$direct}"
}

REMOTE_TAG_SHA="$(remote_tag_commit)"
if [[ -z "$REMOTE_TAG_SHA" ]]; then
  git config user.name "agents-cli release"
  git config user.email "release@phnx-labs.invalid"
  scripts/create-annotated-release-tag.sh "$VERSION" "$HEAD_SHA"
  git push origin "refs/tags/v$VERSION"
elif [[ "$REMOTE_TAG_SHA" != "$HEAD_SHA" ]]; then
  die "v$VERSION already points at $REMOTE_TAG_SHA, not release branch head $HEAD_SHA"
fi

release_args=("v$VERSION" "$ASSET_DIR"/* --verify-tag --title "v$VERSION")
release_args+=(--notes-file ".changelog/$VERSION.md")
[[ "$VERSION" =~ -pre\.[0-9]+$ ]] && release_args+=(--prerelease)
if gh release view "v$VERSION" --repo "${GITHUB_REPOSITORY:-phnx-labs/agents-cli}" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$ASSET_DIR"/* \
    --repo "${GITHUB_REPOSITORY:-phnx-labs/agents-cli}" --clobber
else
  gh release create "${release_args[@]}" \
    --repo "${GITHUB_REPOSITORY:-phnx-labs/agents-cli}"
fi

scripts/release.sh "$VERSION" --ci-publish
