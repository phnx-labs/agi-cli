#!/usr/bin/env bash

set -euo pipefail

PHNX_PKG="@phnx-labs/agents-cli"

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ORIGINAL_ARGS=("$@")

APPLY=false
YES=false
ORCHESTRATION_PHASE=false
CI_PUBLISH=false
PUBLISH_DRY_RUN=false
ARTIFACTS_DIR=""
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --yes|-y) YES=true; shift ;;
    --orchestration-phase) ORCHESTRATION_PHASE=true; shift ;;
    --ci-publish) CI_PUBLISH=true; shift ;;
    --publish-dry-run) PUBLISH_DRY_RUN=true; shift ;;
    --artifacts-dir)
      [[ -n "${2:-}" ]] || die "--artifacts-dir needs a directory"
      ARTIFACTS_DIR="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'USAGE'
usage: scripts/release.sh <version> [--apply] [--yes]

Prepare a release/x.y.z or release/x.y.z-pre.n branch and open its pull request.
The branch-push GitHub Actions workflow is the only publisher.
USAGE
      exit 0
      ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$TARGET" ]] || die "unexpected argument: $1"
      TARGET="$1"
      shift
      ;;
  esac
done

[[ -n "$TARGET" ]] || die "usage: scripts/release.sh <version> [--apply]"
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-pre\.[0-9]+)?$ ]] \
  || die "version must be x.y.z or x.y.z-pre.n"

version_is_prerelease() {
  [[ "$1" =~ -pre\.[0-9]+$ ]]
}

npm_version_at_least() {
  local have="$1" need="$2" first
  first="$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -1)"
  [[ "$first" == "$need" ]]
}

run_ci_publish() {
  command -v npm >/dev/null || die "npm not found"
  command -v node >/dev/null || die "node not found"
  command -v git >/dev/null || die "git not found"
  command -v jq >/dev/null || die "jq not found"

  local npm_version checked_out_ver repo_root tree assets attest tgz_json tgz dist_tag published
  npm_version="$(npm --version)"
  npm_version_at_least "$npm_version" "11.5.1" \
    || die "npm >=11.5.1 is required for trusted publishing (found $npm_version)"

  checked_out_ver="$(jq -r .version package.json)"
  [[ "$checked_out_ver" == "$TARGET" ]] \
    || die "checked-out package is $checked_out_ver, not $TARGET"

  if ! $PUBLISH_DRY_RUN; then
    [[ "${GITHUB_ACTIONS:-}" == "true" ]] \
      || die "--ci-publish is restricted to GitHub Actions"
    [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] \
      || die "GitHub OIDC is unavailable; grant permissions: id-token: write"
    [[ -z "${NODE_AUTH_TOKEN:-}" && -z "${NPM_TOKEN:-}" ]] \
      || die "stored npm tokens are forbidden on the release publisher"
  fi

  repo_root="$(git rev-parse --show-toplevel)"
  tree="$(git rev-parse 'HEAD^{tree}')"
  if [[ -n "$ARTIFACTS_DIR" ]]; then
    assets="$(cd "$ARTIFACTS_DIR" && pwd)"
  else
    command -v gh >/dev/null || die "gh not found"
    assets="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agents-cli-release-assets.XXXXXX")"
    gh release download "v$TARGET" \
      --repo "${GITHUB_REPOSITORY:-phnx-labs/agents-cli}" \
      --pattern release-attestation.json \
      --pattern 'phnx-labs-agents-cli-*.tgz' \
      --dir "$assets" \
      || die "could not download the attestation and tarball from GitHub release v$TARGET"
  fi

  attest="$(scripts/release-attestation.sh require \
    --dir "$assets" --tree "$tree" --repo-root "$repo_root")" \
    || die "GitHub release v$TARGET has no proof for exact tree $tree"
  tgz_json="$(scripts/release-attestation.sh tarball --file "$attest" --require-file)"
  tgz="$(jq -r .path <<<"$tgz_json")"
  scripts/release-attestation.sh promote --file "$attest" --tarball "$tgz" >/dev/null \
    || die "the release tarball does not match its exact-tree attestation"

  bold "Install-smoke of the exact attested tarball..."
  scripts/release-install-smoke.sh "$tgz" "$TARGET" \
    || die "install smoke failed for $(basename "$tgz")"

  if ! $PUBLISH_DRY_RUN \
    && [[ "$(npm view "$PHNX_PKG@$TARGET" version 2>/dev/null || true)" == "$TARGET" ]]; then
    green "$PHNX_PKG@$TARGET is already visible on npm; the attested install smoke passed."
    printf 'BRANCH_RELEASE_PUBLISH version=%s tag=existing tarball=%s dry_run=false\n' \
      "$TARGET" "$(basename "$tgz")"
    return 0
  fi

  dist_tag="latest"
  publish_args=("$tgz" --access=public --provenance)
  if version_is_prerelease "$TARGET"; then
    dist_tag="next"
    publish_args+=(--tag next)
  fi
  if $PUBLISH_DRY_RUN; then
    publish_args+=(--dry-run --provenance=false)
  fi

  bold "Publishing $(basename "$tgz") with npm dist-tag $dist_tag..."
  npm publish "${publish_args[@]}" \
    || die "npm publish failed for $PHNX_PKG@$TARGET"
  if ! $PUBLISH_DRY_RUN; then
    published=""
    for _attempt in 1 2 3 4 5; do
      published="$(npm view "$PHNX_PKG@$TARGET" version 2>/dev/null || true)"
      [[ "$published" == "$TARGET" ]] && break
      sleep 2
    done
    [[ "$published" == "$TARGET" ]] \
      || die "npm publish returned success but $PHNX_PKG@$TARGET is not registry-visible"
  fi
  printf 'BRANCH_RELEASE_PUBLISH version=%s tag=%s tarball=%s dry_run=%s\n' \
    "$TARGET" "$dist_tag" "$(basename "$tgz")" "$PUBLISH_DRY_RUN"
}

if $CI_PUBLISH; then
  run_ci_publish
  exit 0
fi

if ! $ORCHESTRATION_PHASE; then
  CALLER_GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die "release.sh must run from an agents-cli git checkout"
  CALLER_REPO_ROOT="$(dirname "$CALLER_GIT_COMMON_DIR")"
  exec scripts/release-worktree.sh "$CALLER_REPO_ROOT" "${ORIGINAL_ARGS[@]}"
fi

if $APPLY && ! $YES && [[ ! -t 0 ]]; then
  die "--apply needs an interactive terminal, or --yes for a non-interactive release"
fi

command -v npm >/dev/null || die "npm not found"
command -v node >/dev/null || die "node not found"
command -v bun >/dev/null || die "bun not found"
command -v git >/dev/null || die "git not found"
command -v jq >/dev/null || die "jq not found"
command -v gh >/dev/null || die "gh not found"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"

git fetch --quiet origin
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[[ -n "$DEFAULT_BRANCH" ]] || DEFAULT_BRANCH="main"
BASE_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$DEFAULT_BRANCH")"
[[ "$BASE_SHA" == "$REMOTE_SHA" ]] \
  || die "release worktree is not at origin/$DEFAULT_BRANCH; retry from a fresh release worktree"
[[ -z "$(git status --porcelain)" ]] || die "release-owned worktree must start clean"

bun install --frozen-lockfile >/dev/null \
  || die "dependency install failed in the isolated release worktree"

PHNX_LATEST="$(npm view "$PHNX_PKG@latest" version 2>/dev/null || true)"
[[ -n "$PHNX_LATEST" ]] || die "could not read the latest $PHNX_PKG version from npm"
PKG_JSON_VERSION="$(jq -r .version package.json)"

if npm view "$PHNX_PKG@$TARGET" version >/dev/null 2>&1; then
  die "$PHNX_PKG@$TARGET is already published"
fi

if version_is_prerelease "$TARGET"; then
  BUMP="pre-release"
else
  BUMP="$(scripts/validate-bump.sh "$PHNX_LATEST" "$PKG_JSON_VERSION" "0.0.0" "$TARGET")" \
    || exit 1
fi

remote_version_tags() {
  local out
  out="$(git ls-remote --tags origin 'refs/tags/v*' 2>&1)" \
    || die "could not read remote tags from origin: $out"
  printf '%s\n' "$out" | grep -v '\^{}$' || true
}

if ! version_is_prerelease "$TARGET"; then
  TAG_FACTS=""
  REMOTE_TAG_LINES="$(remote_version_tags)"
  while read -r _sha ref; do
    version="${ref#refs/tags/v}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    [[ "$version" != "$PHNX_LATEST" ]] || continue
    [[ "$(printf '%s\n%s\n' "$PHNX_LATEST" "$version" | sort -V | tail -1)" == "$version" ]] || continue
    if npm view "$PHNX_PKG@$version" version >/dev/null 2>&1; then
      TAG_FACTS+="$version yes"$'\n'
    else
      TAG_FACTS+="$version no"$'\n'
    fi
  done <<<"$REMOTE_TAG_LINES"
  UNPUBLISHED_TAG="$(printf '%s' "$TAG_FACTS" \
    | scripts/stuck-release.sh "$PHNX_LATEST" "$BUMP" "$PKG_JSON_VERSION" || true)"
  [[ -z "$UNPUBLISHED_TAG" || "$UNPUBLISHED_TAG" == "$TARGET" ]] \
    || die "v$UNPUBLISHED_TAG is tagged but unpublished; release it before $TARGET"
fi

RELEASE_BRANCH="release/$TARGET"
OPEN_PR_LINES="$(gh pr list --state open --limit 200 --json number,headRefName \
  --jq '.[] | "\(.number) \(.headRefName)"')" \
  || die "could not list open release PRs"
OTHER_BUMP_PRS="$(printf '%s\n' "$OPEN_PR_LINES" \
  | scripts/release-other-bump-prs.sh "$RELEASE_BRANCH")"
[[ -z "$OTHER_BUMP_PRS" ]] \
  || die "another release PR still owns the changelog queue: $OTHER_BUMP_PRS"

cleanup_release_tree() {
  git restore --source=HEAD --staged --worktree -- \
    package.json CHANGELOG.md .changelog \
    docs/command-index.md docs/command-index.json docs/command-reference.html \
    >/dev/null 2>&1 || true
  if ! git ls-files --error-unmatch ".changelog/$TARGET.md" >/dev/null 2>&1; then
    rm -f ".changelog/$TARGET.md"
  fi
}
trap cleanup_release_tree EXIT

if [[ "$PKG_JSON_VERSION" != "$TARGET" ]]; then
  tmp="$(mktemp)"
  jq --arg version "$TARGET" '.version = $version' package.json >"$tmp"
  mv "$tmp" package.json
fi

bold "Type-checking the release tree..."
npx --no-install tsc --noEmit --pretty false \
  || die "type-check failed"

NOTES="$(bun scripts/release-changelog.ts "$TARGET")" \
  || die "the changelog queue is empty or could not be folded"
scripts/generate-reference.sh

git add -A package.json CHANGELOG.md .changelog \
  docs/command-index.md docs/command-index.json docs/command-reference.html
BRANCH_TREE="$(git write-tree)"
RELEASE_COMMIT="$(git commit-tree "$BRANCH_TREE" -p "$BASE_SHA" -m "chore(release): $TARGET")"

if ! $APPLY; then
  green "Dry run prepared release/$TARGET from $DEFAULT_BRANCH@$BASE_SHA."
  gray "  bump: $BUMP ($PHNX_LATEST -> $TARGET)"
  gray "  tree: $BRANCH_TREE"
  gray "  apply: scripts/release.sh $TARGET --apply"
  exit 0
fi

if ! $YES; then
  read -r -p "Push $RELEASE_BRANCH and let GitHub Actions publish $PHNX_PKG@$TARGET? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || die "aborted"
fi

export RELEASE_LEASE_HOLDER_PID=$$
LEASE_HELD=false
if ! scripts/release-lease.sh claim "$TARGET"; then
  die "another release is in flight; inspect scripts/release-lease.sh status"
fi
LEASE_HELD=true
release_lease() {
  cleanup_release_tree
  if $LEASE_HELD; then
    scripts/release-lease.sh release >/dev/null 2>&1 || true
  fi
}
trap release_lease EXIT

EXISTING_REMOTE="$(git ls-remote origin "refs/heads/$RELEASE_BRANCH" | awk '{print $1; exit}')"
if [[ -n "$EXISTING_REMOTE" ]]; then
  git push --force-with-lease="refs/heads/$RELEASE_BRANCH:$EXISTING_REMOTE" \
    origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
else
  git push --force-with-lease="refs/heads/$RELEASE_BRANCH:" \
    origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
fi

PR_NUMBER="$(gh pr list --head "$RELEASE_BRANCH" --base "$DEFAULT_BRANCH" \
  --state open --json number --jq '.[0].number // empty')"
if [[ -z "$PR_NUMBER" ]]; then
  PR_BODY="$(printf '## %s\n\n%s\n\nThe branch-push Release workflow is the sole npm publisher.' "$TARGET" "$NOTES")"
  gh pr create --base "$DEFAULT_BRANCH" --head "$RELEASE_BRANCH" \
    --title "chore(release): $TARGET" --body "$PR_BODY" >/dev/null
  PR_NUMBER="$(gh pr view "$RELEASE_BRANCH" --json number --jq .number)"
fi

green "Opened release PR #$PR_NUMBER from $RELEASE_BRANCH."
green "GitHub Actions now owns attestation, tag, GitHub release, install smoke, and npm publish."
printf 'https://github.com/%s/actions/workflows/release.yml\n' \
  "${GITHUB_REPOSITORY:-phnx-labs/agents-cli}"
