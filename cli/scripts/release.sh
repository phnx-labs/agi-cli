#!/usr/bin/env bash

set -euo pipefail

PHNX_PKG="@phnx-labs/agents-cli"
SWARMIFY_PKG="${SHIM_PACKAGE:-@swarmify/agents-cli}"

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

pkg_version_at_ref() {
  local ref="$1" path
  if git cat-file -e "$ref:cli/package.json" 2>/dev/null; then
    path="cli/package.json"
  elif git cat-file -e "$ref:apps/cli/package.json" 2>/dev/null; then
    path="apps/cli/package.json"
  else
    return 0
  fi
  git show "$ref:$path" 2>/dev/null | jq -r .version 2>/dev/null || true
}

readonly RELEASE_HOME_BASE_DEFAULT="mac-mini"

if [[ "$(uname)" == "Darwin" ]]; then
  THIS_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
else
  THIS_HOST="$(hostname -s 2>/dev/null || hostname)"
fi

PHASE_NUM=0
TOTAL_PHASES=6
phase() {
  PHASE_NUM=$((PHASE_NUM + 1))
  bold "[$PHASE_NUM/$TOTAL_PHASES] $1  (on: $2)"
}
phase_ok()   { green "  ✓ $1"; }
phase_fail() {
  red "  ✗ $1"
  [[ -n "${2:-}" ]] && red "    log: $2"
  exit 1
}

APPLY=false
WITH_HELPERS=false
SKIP_TESTS=false
YES=false
HOME_BASE_PHASE=false
# A NEW FLAG DOES NOT WORK UNTIL IT IS ON origin/<default>; the release re-execs there.
ORCHESTRATION_PHASE=false
TARGET=""
DEVICE=""
expect_device=false
for arg in "$@"; do
  if $expect_device; then DEVICE="$arg"; expect_device=false; continue; fi
  case "$arg" in
    --apply) APPLY=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    --with-helpers) WITH_HELPERS=true ;;
    --yes|-y) YES=true ;;
    --home-base-phase) HOME_BASE_PHASE=true ;;
    --orchestration-phase) ORCHESTRATION_PHASE=true ;;
    --device|--host) expect_device=true ;;
    --device=*|--host=*) DEVICE="${arg#*=}" ;;
    -h|--help) printf '%s\n' "usage: scripts/release.sh <version> [--apply] [--with-helpers] [--device <name>] [--skip-tests] [--yes]"; exit 0 ;;
    --*) die "unknown flag: $arg" ;;
    *)
      [[ -z "$TARGET" ]] || die "unexpected argument: $arg"
      TARGET="$arg"
      ;;
  esac
done
$expect_device && die "--device needs a machine name (e.g. --device zion)"
[[ -n "$TARGET" ]] || die "usage: scripts/release.sh <version> [--apply]  (e.g. 1.14.2 --apply)"
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be MAJOR.MINOR.PATCH (no pre-release tags)"

readonly RELEASE_HOME_BASE="${DEVICE:-$RELEASE_HOME_BASE_DEFAULT}"
ON_HOME_BASE=false
[[ "$THIS_HOST" == "$RELEASE_HOME_BASE" ]] && ON_HOME_BASE=true

if $APPLY && ! $YES && ! $HOME_BASE_PHASE && ! $ORCHESTRATION_PHASE && [ ! -t 0 ]; then
  die "--apply needs an interactive terminal to confirm, or --yes to skip the prompt. stdin is not a TTY, so the [y/N] confirmation cannot be answered -- refusing to exit 0 having published nothing. Re-run with --yes to publish non-interactively."
fi

if ! $HOME_BASE_PHASE && ! $ORCHESTRATION_PHASE; then
  CALLER_GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
    || die "release.sh must run from an agents-cli git checkout"
  CALLER_REPO_ROOT="$(dirname "$CALLER_GIT_COMMON_DIR")"
  exec scripts/release-worktree.sh "$CALLER_REPO_ROOT" "$@"
fi

if $APPLY; then
  bold "Mode: APPLY (real publish)"
else
  yellow "Mode: DRY-RUN (no branch, PR, merge, tag, publish, or push -- pass --apply to actually release)"
fi
gray "  this box:   $THIS_HOST$($ON_HOME_BASE && echo '  (home base)' || echo '')"
gray "  home base:  $RELEASE_HOME_BASE  (promote attested tgz + reuse helpers + install smoke)"
gray "  proof:      exact-tree attestation (tree/toolchain/lock/policy); ordinary P99 <=60s"
echo

run_home_base_phase() {
  gray "home base: $RELEASE_HOME_BASE (promote-only -- no signing on this path)"
  command -v npm >/dev/null  || die "npm not found on $RELEASE_HOME_BASE"
  command -v node >/dev/null || die "node not found on $RELEASE_HOME_BASE"
  command -v git >/dev/null  || die "git not found on $RELEASE_HOME_BASE"
  command -v jq >/dev/null   || die "jq not found on $RELEASE_HOME_BASE (brew install jq)"
  command -v gh >/dev/null   || die "gh not found on $RELEASE_HOME_BASE (needed to publish the GitHub release assets)"

  cd "$ROOT"

  if npm view "$PHNX_PKG@$TARGET" version >/dev/null 2>&1; then
    green "$PHNX_PKG@$TARGET already on the registry -- nothing to publish"
    return 0
  fi

  local checked_out_ver
  checked_out_ver="$(jq -r .version package.json)"
  [[ "$checked_out_ver" == "$TARGET" ]] \
    || die "checked-out tree is at $checked_out_ver, not $TARGET -- refusing to build/publish on $RELEASE_HOME_BASE"

  command -v agents >/dev/null 2>&1 \
    || die "'agents' CLI not on PATH on $RELEASE_HOME_BASE -- needed to inject the npmjs.com token"
  # shellcheck source=scripts/headless-sign-context.sh
  . scripts/headless-sign-context.sh
  resolve_npm_auth

  local repo_root tree attest_dir attest tgz_json tgz manifest
  repo_root="$(git rev-parse --show-toplevel)"
  tree="$(git rev-parse "HEAD^{tree}")"
  attest_dir="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-release-attest.XXXXXX")"
  dl_patterns=(--pattern 'release-attestation.json'
               --pattern 'phnx-labs-agents-cli-*.tgz')
  if [[ "$WITH_HELPERS" == true ]]; then
    dl_patterns+=(--pattern 'release-manifest.json')
  fi
  gh release download "v$TARGET" --dir "$attest_dir" "${dl_patterns[@]}" \
    || die "could not download attested artifacts from GitHub release v$TARGET -- the trigger must upload them before this phase"
  bold "Requiring exact-tree attestation for ${tree:0:12} (no parent/nearby fallback)..."
  attest="$(scripts/release-attestation.sh require --dir "$attest_dir" --tree "$tree" --repo-root "$repo_root")" \
    || die "no passing attestation for tagged tree $tree -- refusing parent/nearby evidence"
  tgz_json="$(scripts/release-attestation.sh tarball --file "$attest" --require-file)"
  tgz="$(jq -r .path <<<"$tgz_json")"
  scripts/release-attestation.sh promote --file "$attest" --tarball "$tgz" >/dev/null \
    || die "pretested tarball failed digest bind -- refusing to rebuild"

  if [[ "$WITH_HELPERS" == true ]]; then
    manifest="$attest_dir/release-manifest.json"
    [[ -f "$manifest" ]] || die "release manifest missing at $manifest -- no fallback rebuild"
    scripts/release-manifest.sh require --file "$manifest" --repo-root "$repo_root" \
      || die "helper manifest failed -- rebuild/notarization is outside the ordinary release path"
  else
    gray "CLI-only release: skipping helper-manifest verification (pass --with-helpers to include it)"
  fi

  bold "Install-smoke of the exact pretested tarball..."
  scripts/release-install-smoke.sh "$tgz" "$TARGET" \
    || die "install smoke failed for $tgz"

  bold "Publishing the exact pretested tarball $(basename "$tgz") as $PHNX_PKG@$TARGET..."
  if [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
    npm publish "$tgz" --access=public --provenance \
      || die "npm publish (OIDC provenance) failed on $RELEASE_HOME_BASE (tag exists; rerun to retry)"
  else
    npm publish "$tgz" --access=public --provenance=false \
      || die "npm publish failed on $RELEASE_HOME_BASE (tag exists; rerun to retry)"
  fi
  green "Published $PHNX_PKG@$TARGET from attested $tgz"

  # ComputerHelper.app.zip is intentionally absent; the standalone computer engine owns it.

}

resolve_npm_auth() {
  command -v agents >/dev/null || die "'agents' CLI not on PATH (needed to read npmjs.com secrets bundle on $RELEASE_HOME_BASE)"
  NPM_TOKEN="$(agents secrets exec npmjs.com -- printenv NPM_TOKEN 2>/dev/null || true)"
  [[ -n "$NPM_TOKEN" ]] \
    || die "could not resolve NPM_TOKEN from the 'npmjs.com' secrets bundle on $RELEASE_HOME_BASE (agents secrets create npmjs.com && agents secrets add npmjs.com NPM_TOKEN)"

  NPMRC_TMP="$(mktemp "${TMPDIR:-/tmp}/agents-cli-npmrc.XXXXXX")"
  chmod 600 "$NPMRC_TMP"
  # shellcheck disable=SC2016
  printf '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nalways-auth=true\n' > "$NPMRC_TMP"
  export NPM_TOKEN
  export NPM_CONFIG_USERCONFIG="$NPMRC_TMP"

  local npm_user
  npm_user="$(npm whoami 2>/dev/null || true)"
  [[ -n "$npm_user" ]] || die "npm whoami failed with the resolved NPM_TOKEN on $RELEASE_HOME_BASE -- token may be expired or lack publish scope"
  green "npm authenticated as $npm_user (via npmjs.com bundle on $RELEASE_HOME_BASE)"
}

remote_tag_commit() {
  local tag="$1" refs peeled direct
  refs="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")"
  peeled="$(awk '$2 ~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  direct="$(awk '$2 !~ /\^\{\}$/ { print $1; exit }' <<<"$refs")"
  printf '%s' "${peeled:-$direct}"
}

select_already_published_tag_sha() {
  local merged_sha="$1" recorded_head="$2" fetched_head="$3"
  [[ -n "$merged_sha" && -n "$recorded_head" && -n "$fetched_head" ]] \
    || die "already-published recovery: missing merged or recorded release identity"
  [[ "$fetched_head" == "$recorded_head" ]] \
    || die "fetched PR head ${fetched_head:0:9} != recorded release head ${recorded_head:0:9} -- refusing missing-tag recovery"
  [[ "$(pkg_version_at_ref "$merged_sha")" == "$TARGET" ]] \
    || die "already-published $TARGET: $DEFAULT_BRANCH does not contain the target version"
  [[ "$(pkg_version_at_ref "$recorded_head")" == "$TARGET" ]] \
    || die "already-published $TARGET: recorded release head does not contain the target version"
  printf '%s\n' "$recorded_head"
}

create_annotated_release_tag() {
  scripts/create-annotated-release-tag.sh "$@"
}

if $HOME_BASE_PHASE; then
  [[ -n "$TARGET" ]] || die "--home-base-phase needs a <version>"
  bold "[home-base phase] promote attested tgz + reuse helpers + install smoke on $THIS_HOST"
  NPMRC_TMP=""
  trap 'rm -f "${NPMRC_TMP:-}"' EXIT
  run_home_base_phase
  green "Released $TARGET (home-base phase)"
  exit 0
fi

command -v npm >/dev/null    || die "npm not found"
command -v node >/dev/null   || die "node not found"
command -v bun >/dev/null    || die "bun not found"
command -v git >/dev/null    || die "git not found"
command -v jq >/dev/null     || die "jq not found (brew install jq)"
command -v gh >/dev/null      || die "gh (GitHub CLI) not found (brew install gh) -- needed to open + merge the release PR"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated -- run 'gh auth login'"

git fetch --quiet origin
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[[ -n "$DEFAULT_BRANCH" ]] || DEFAULT_BRANCH="main"
BASE_SHA="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$DEFAULT_BRANCH")"
if [[ "$BASE_SHA" != "$REMOTE" ]]; then
  git merge-base --is-ancestor "$BASE_SHA" "$REMOTE" \
    || die "release worktree base ${BASE_SHA:0:9} is not an ancestor of origin/$DEFAULT_BRANCH -- recreate only this release worktree and retry"
  gray "  base:       ${BASE_SHA:0:9} (newest attested ancestor; origin/$DEFAULT_BRANCH is $(git rev-list --count "$BASE_SHA..$REMOTE") ahead)"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  red "release worktree became dirty before orchestration; changed files:" >&2
  git status --short >&2
  die "release-owned worktree must stay clean -- inspect the listed files; do not stash or alter the caller checkout"
fi

bun install --frozen-lockfile >/dev/null \
  || die "dependency install failed in the isolated release worktree"


home_base_wt_snippet() {
  cat <<SNIPPET
set -euo pipefail
REPO_ROOT="\$(git rev-parse --show-toplevel)"
git -C "\$REPO_ROOT" fetch --quiet origin
git -C "\$REPO_ROOT" fetch --quiet origin "refs/tags/v$1:refs/tags/v$1" 2>/dev/null || true
git -C "\$REPO_ROOT" rev-parse --verify --quiet "refs/tags/v$1^{commit}" >/dev/null \\
  || { echo "tag v$1 not found on the home base after fetch" >&2; exit 1; }
CLI_DIR="cli"
git -C "\$REPO_ROOT" cat-file -e "v$1:cli/package.json" 2>/dev/null || CLI_DIR="apps/cli"
TAG_VER="\$(git -C "\$REPO_ROOT" show "v$1:\$CLI_DIR/package.json" | jq -r .version)"
[ "\$TAG_VER" = "$1" ] \\
  || { echo "tag v$1 tree is at \$TAG_VER, not $1 -- refusing home-base phase" >&2; exit 1; }
WT="\$REPO_ROOT/.agents/worktrees/homebase-publish-v$1-\$\$"
trap 'git -C "\$REPO_ROOT" worktree remove "\$WT" >/dev/null 2>&1 || echo "Retained publish worktree for inspection: \$WT" >&2' EXIT
git -C "\$REPO_ROOT" worktree add --quiet --detach "\$WT" "v$1" \\
  || { echo "could not create home-base publish worktree at \$WT" >&2; exit 1; }
[ -z "\$(git -C "\$WT" status --short | grep '^ D')" ] \\
  || { echo "home-base publish worktree \$WT is incomplete -- refusing to build" >&2; exit 1; }
mkdir -p "\$WT/\$CLI_DIR/bin"
cd "\$WT/\$CLI_DIR"
scripts/release.sh $1 --home-base-phase --device "$RELEASE_HOME_BASE"
SNIPPET
}
route_home_base_phase() {
  local snippet
  snippet="$(home_base_wt_snippet "$TARGET")"
  if $ON_HOME_BASE; then
    bold "Building + signing + publishing on the home base ($RELEASE_HOME_BASE, this box) from the tagged tree..."
    bash -c "$snippet" || return 1
    return 0
  fi
  bold "Routing build + sign + publish to the home base ($RELEASE_HOME_BASE) via agents ssh (from the tagged tree)..."
  if command -v agents >/dev/null 2>&1; then
    agents ssh "$RELEASE_HOME_BASE" -- 'cd $HOME/src/github.com/muqsitnawaz/agents-cli && bash -s' <<<"$snippet" \
      || return 1
  else
    ssh "$RELEASE_HOME_BASE" 'cd $HOME/src/github.com/muqsitnawaz/agents-cli && bash -s' <<<"$snippet" \
      || return 1
  fi
}

assert_promote_home_base() {
  local out rc probe="scripts/promote-home-base-probe.sh"
  bold "Preflight: verifying $RELEASE_HOME_BASE can promote + publish..."
  if $ON_HOME_BASE; then
    out="$(bash "$probe" 2>&1)" && rc=0 || rc=$?
  elif command -v agents >/dev/null 2>&1; then
    out="$(agents ssh "$RELEASE_HOME_BASE" -- "cd \$HOME/src/github.com/muqsitnawaz/agents-cli && bash -s" < "$probe" 2>&1)" && rc=0 || rc=$?
  else
    out="$(ssh "$RELEASE_HOME_BASE" "cd \$HOME/src/github.com/muqsitnawaz/agents-cli && bash -s" < "$probe" 2>&1)" && rc=0 || rc=$?
  fi
  if [[ "$rc" != "0" ]]; then
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    die "device $RELEASE_HOME_BASE cannot promote + publish (see probe output above) -- fix the named gap or pass --device <ready-box>"
  fi
  phase_ok "$RELEASE_HOME_BASE can promote + publish (npm token + gh auth verified)"
}

PHNX_LATEST="$(npm view "$PHNX_PKG" version 2>/dev/null || true)"
[[ -n "$PHNX_LATEST" ]] || die "could not read latest version of $PHNX_PKG from npm"

SWARMIFY_LATEST="$(npm view "$SWARMIFY_PKG" version 2>/dev/null || echo "0.0.0")"

bold "Current published versions"
gray "  $PHNX_PKG       $PHNX_LATEST"
gray "  $SWARMIFY_PKG   $SWARMIFY_LATEST"
gray "  target           $TARGET"
echo

parse_v() { echo "$1" | tr '.' ' '; }
read -r CMAJ CMIN CPAT <<< "$(parse_v "$PHNX_LATEST")"
read -r TMAJ TMIN TPAT <<< "$(parse_v "$TARGET")"

PKG_JSON_VERSION="$(jq -r .version package.json)"
if ! BUMP="$(scripts/validate-bump.sh "$PHNX_LATEST" "$PKG_JSON_VERSION" "$SWARMIFY_LATEST" "$TARGET")"; then
  exit 1
fi
read -r SMAJ SMIN SPAT <<< "$(parse_v "$SWARMIFY_LATEST")"

if [[ "$BUMP" != "shim-catchup" ]]; then
  if [[ "$TMAJ$TMIN$TPAT" == "$SMAJ$SMIN$SPAT" ]] || \
     { [[ $TMAJ -lt $SMAJ ]] || \
       { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -lt $SMIN ]]; } || \
       { [[ $TMAJ -eq $SMAJ ]] && [[ $TMIN -eq $SMIN ]] && [[ $TPAT -le $SPAT ]]; }; }; then
    die "target $TARGET is not strictly newer than @companion latest $SWARMIFY_LATEST"
  fi
fi

green "Bump: $BUMP ($PHNX_LATEST -> $TARGET)"

remote_version_tags() {
  local out
  out="$(git ls-remote --tags origin 'refs/tags/v*' 2>&1)" \
    || die "could not read remote tags from origin -- refusing to release without checking for a stuck version: $out"
  printf '%s\n' "$out" | grep -v '\^{}$' || true
}

TAG_FACTS=""
REMOTE_TAG_LINES="$(remote_version_tags)"
while read -r _sha _ref; do
  v="${_ref#refs/tags/v}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
  [[ "$v" != "$PHNX_LATEST" ]] || continue
  [[ "$(printf '%s\n%s\n' "$PHNX_LATEST" "$v" | sort -V | tail -1)" == "$v" ]] || continue
  if npm view "$PHNX_PKG@$v" version >/dev/null 2>&1; then
    TAG_FACTS+="$v yes"$'\n'
  else
    TAG_FACTS+="$v no"$'\n'
  fi
done <<< "$REMOTE_TAG_LINES"

UNPUBLISHED_TAG="$(printf '%s' "$TAG_FACTS" | scripts/stuck-release.sh "$PHNX_LATEST" "$BUMP" "$PKG_JSON_VERSION" || true)"

if [[ -n "$UNPUBLISHED_TAG" && "$UNPUBLISHED_TAG" != "$TARGET" ]]; then
  red "v$UNPUBLISHED_TAG is tagged but was never published -- finish that release first."
  gray "  registry latest   $PHNX_LATEST"
  gray "  stuck tag         v$UNPUBLISHED_TAG"
  gray "  you asked for     $TARGET"
  echo
  yellow "  Re-run with the stuck version; it rebuilds from that release PR's CI-tested tree:"
  yellow "    scripts/release.sh $UNPUBLISHED_TAG --apply"
  die "refusing to bump past an unpublished release"
fi

PHNX_TARGET_PUBLISHED=false
if npm view "$PHNX_PKG@$TARGET" version >/dev/null 2>&1; then
  PHNX_TARGET_PUBLISHED=true
fi
gray "  $PHNX_PKG@$TARGET     $($PHNX_TARGET_PUBLISHED && echo 'already published — will skip' || echo 'will publish')"
echo

RELEASE_BRANCH="release/v$TARGET"
MAIN_AT_TARGET=false
if [[ "$(pkg_version_at_ref "origin/$DEFAULT_BRANCH")" == "$TARGET" ]]; then
  MAIN_AT_TARGET=true
fi

if $MAIN_AT_TARGET; then
  TOTAL_PHASES=4
else
  TOTAL_PHASES=6
fi
EXISTING_PR="$(gh pr list --head "$RELEASE_BRANCH" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"
MERGED_RELEASE_JSON="$(gh pr list --head "$RELEASE_BRANCH" --base "$DEFAULT_BRANCH" --state merged --limit 1 --json number,mergeCommit,headRefOid 2>/dev/null || echo '[]')"
MERGED_RELEASE_PR="$(jq -r '.[0].number // empty' <<<"$MERGED_RELEASE_JSON")"
MERGED_RELEASE_SHA="$(jq -r '.[0].mergeCommit.oid // empty' <<<"$MERGED_RELEASE_JSON")"
MERGED_RELEASE_HEAD="$(jq -r '.[0].headRefOid // empty' <<<"$MERGED_RELEASE_JSON")"

HISTORICAL_CATCHUP=false
HISTORICAL_WT=""
INVOKING_ROOT="$ROOT"
REPO_ROOT="$(git rev-parse --show-toplevel)"
remove_historical_worktree() {
  if [[ -n "${HISTORICAL_WT:-}" ]]; then
    cd "$INVOKING_ROOT"
    git -C "$REPO_ROOT" worktree remove "$HISTORICAL_WT" >/dev/null 2>&1 \
      || yellow "Retained historical worktree for inspection: $HISTORICAL_WT"
    HISTORICAL_WT=""
  fi
}
cleanup_early() {
  rm -f "${NPMRC_TMP:-}"
  remove_historical_worktree
}
trap cleanup_early EXIT

if $MAIN_AT_TARGET && ! $PHNX_TARGET_PUBLISHED && [[ -n "$MERGED_RELEASE_SHA" ]] && [[ "$MERGED_RELEASE_SHA" != "$BASE_SHA" ]]; then
  [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_HEAD" ]] \
    || die "main is ahead of the unpublished $TARGET release, but release PR metadata is incomplete"
  git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
    || die "could not fetch the CI-tested head for merged release PR #$MERGED_RELEASE_PR"
  CI_TESTED_HEAD="$(git rev-parse FETCH_HEAD)"
  [[ "$CI_TESTED_HEAD" == "$MERGED_RELEASE_HEAD" ]] \
    || die "fetched PR head ${CI_TESTED_HEAD:0:9} != recorded release head ${MERGED_RELEASE_HEAD:0:9} -- refusing catch-up publish"
  HISTORICAL_CATCHUP=true
  bold "Catch-up: main already at $TARGET (merged PR #$MERGED_RELEASE_PR at ${MERGED_RELEASE_SHA:0:9}); routing publish to the home base."
fi

# ----- Sync package.json with target -----
ORIGINAL_PKG_VERSION="$(jq -r .version package.json)"

if [[ "$ORIGINAL_PKG_VERSION" != "$TARGET" ]]; then
  yellow "Updating package.json: $ORIGINAL_PKG_VERSION -> $TARGET"
  tmp="$(mktemp)"
  jq --arg v "$TARGET" '.version = $v' package.json > "$tmp"
  mv "$tmp" package.json
fi

bold "Type-checking (tsc --noEmit)..."
TSC_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-tsc.XXXXXX")"
if ! npx --no-install tsc --noEmit --pretty false > "$TSC_LOG" 2>&1; then
  red "TypeScript errors:"
  cat "$TSC_LOG" >&2
  rm -f "$TSC_LOG"
  die "fix the type errors above before releasing"
fi
if grep -iE '\bwarning\b|\bdeprecated\b' "$TSC_LOG" >/dev/null 2>&1; then
  red "tsc emitted warnings:"
  grep -iE '\bwarning\b|\bdeprecated\b' "$TSC_LOG" >&2
  rm -f "$TSC_LOG"
  die "fix the warnings above before releasing"
fi
rm -f "$TSC_LOG"
green "Type check clean."



if [[ -n "${RELEASE_PRETESTED_TGZ:-}" && -f "${RELEASE_PRETESTED_TGZ}" ]]; then
  bold "Pretested tarball $RELEASE_PRETESTED_TGZ"
  ls -l "$RELEASE_PRETESTED_TGZ"
else
  gray "Pretested tarball is resolved from the attestation store at promote time -- this path never rebuilds one."
fi
echo

bold "Building $SWARMIFY_PKG@$TARGET shim..."
SHIM_SRC="$ROOT/scripts/companion-shim"
SHIM_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-shim.XXXXXX")"
stage_release_metadata() {
  git add -A package.json CHANGELOG.md .changelog docs/command-index.md docs/command-index.json docs/command-reference.html
}

restore_release_tree() {
  local paths=(package.json CHANGELOG.md .changelog docs/command-index.md docs/command-index.json docs/command-reference.html)
  if git diff --quiet HEAD -- "${paths[@]}" && git diff --cached --quiet HEAD -- "${paths[@]}"; then
    return
  fi
  local untracked
  if ! untracked="$(git ls-files --others -- "${paths[@]}")"; then
    yellow "Retained release edits for inspection: $ROOT"
    return
  fi
  if [[ -n "$untracked" || -z "${RELEASE_CI_HEAD:-}" ]] \
    || ! git diff --quiet "$RELEASE_CI_HEAD" -- "${paths[@]}" \
    || ! git diff --cached --quiet "$RELEASE_CI_HEAD" -- "${paths[@]}"; then
    yellow "Retained release edits for inspection: $ROOT"
    return
  fi
  git restore --source=HEAD --staged --worktree -- "${paths[@]}"
}

cleanup_all() {
  restore_release_tree
  rm -rf "${SHIM_TMP:-}"
  rm -f "${NPMRC_TMP:-}"
  remove_historical_worktree
  if [[ -n "${LEASE_RENEWER_PID:-}" ]]; then
    kill "$LEASE_RENEWER_PID" >/dev/null 2>&1 || true
    wait "$LEASE_RENEWER_PID" 2>/dev/null || true
  fi
  if [[ "${LEASE_HELD:-false}" == "true" ]]; then
    scripts/release-lease.sh release || true
  fi
}
trap cleanup_all EXIT

cp -R "$SHIM_SRC/bin" "$SHIM_SRC/scripts" "$SHIM_SRC/README.md" "$SHIM_TMP/"
cat > "$SHIM_TMP/package.json" <<EOF
{
  "name": "$SWARMIFY_PKG",
  "version": "$TARGET",
  "description": "This package has moved to $PHNX_PKG. Install that instead.",
  "dependencies": {
    "$PHNX_PKG": "$TARGET"
  },
  "bin": {
    "agents": "bin/agents.js",
    "ag": "bin/agents.js"
  },
  "scripts": {
    "postinstall": "node scripts/postinstall.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/phnx-labs/agi-cli.git"
  },
  "homepage": "https://agents-cli.sh",
  "bugs": {
    "url": "https://github.com/phnx-labs/agi-cli/issues"
  }
}
EOF

bold "Tarball preview ($SWARMIFY_PKG@$TARGET shim)"
( cd "$SHIM_TMP" && npm pack --dry-run 2>&1 | tail -10 )
echo

if ! $APPLY; then
  green "Dry run looks good. Re-run with --apply to release $TARGET via a PR."
  echo
  bold "Detected state:"
  gray "  default branch            $DEFAULT_BRANCH @ ${BASE_SHA:0:9}"
  gray "  $PHNX_PKG@$TARGET on npm     $($PHNX_TARGET_PUBLISHED && echo yes || echo no)"
  gray "  origin/$DEFAULT_BRANCH at $TARGET   $($MAIN_AT_TARGET && echo yes || echo no)"
  gray "  open release PR           ${EXISTING_PR:-none} ($RELEASE_BRANCH)"
  gray "  merged release PR         ${MERGED_RELEASE_PR:-none} ($RELEASE_BRANCH)"
  echo
  yellow "Will run on --apply (self-routing, zero-config -- no env vars, no 2FA prompt):"
  yellow "  1. [this box: $THIS_HOST] fold .changelog/next/* -> .changelog/$TARGET.md + regenerate CHANGELOG.md"
  yellow "  2. [this box] require exact-tree attestation (tree/toolchain/lock/policy) for the release base (newest attested ancestor of origin/$DEFAULT_BRANCH)"
  yellow "  3. [this box] push branch $RELEASE_BRANCH (chore(release): $TARGET); open a PR"
  yellow "  4. [this box] require attestation + pretested tgz for the release commit tree (30s fallback), fail-closed"
  yellow "  5. [this box] tag v$TARGET at the ATTESTED release commit (publish is decoupled from live main)"
  yellow "  6. [$RELEASE_HOME_BASE] promote exact tgz + reuse helpers + install smoke + npm publish"
  yellow "  7. [this box] merge the version-bump PR into $DEFAULT_BRANCH -- ASYNC, after publish, never gates it"
  gray   "  (steps already done in a prior run are skipped: published / tagged / PR-open)"
  exit 0
fi

if ! $YES; then
  read -r -p "Release $TARGET via a PR into $DEFAULT_BRANCH, then publish $PHNX_PKG? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "aborted"
fi

export RELEASE_LEASE_HOLDER_PID=$$
LEASE_HELD=false
if ! scripts/release-lease.sh claim "$TARGET"; then
  die "another release is in flight -- watch it instead of racing it (scripts/release-lease.sh status)"
fi
LEASE_HELD=true

LEASE_RENEWER_PID=""
( while sleep 600; do scripts/release-lease.sh renew >/dev/null 2>&1 || exit 0; done ) &
LEASE_RENEWER_PID=$!

require_lease() {
  scripts/release-lease.sh verify \
    || phase_fail "lost the release lease before $1 -- refusing to continue; another releaser owns this pipeline now"
}

phase "Preflight + version validation complete" "$THIS_HOST"
phase_ok "isolated origin/$DEFAULT_BRANCH, bump $BUMP ($PHNX_LATEST -> $TARGET), type check + tarball preview done"

assert_promote_home_base

if $PHNX_TARGET_PUBLISHED; then
  green "$PHNX_PKG@$TARGET is already on the registry."
  REMOTE_TAG_SHA="$(remote_tag_commit "v$TARGET")"
  if [[ -z "$REMOTE_TAG_SHA" ]]; then
    if [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_SHA" && -n "$MERGED_RELEASE_HEAD" ]]; then
      git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
        || die "could not fetch the CI-tested head for merged release PR #$MERGED_RELEASE_PR"
      TAG_TARGET="$(select_already_published_tag_sha \
        "$MERGED_RELEASE_SHA" "$MERGED_RELEASE_HEAD" "$(git rev-parse FETCH_HEAD)")"
    else
      TAG_TARGET="origin/$DEFAULT_BRANCH"
    fi
    [[ "$(pkg_version_at_ref "$TAG_TARGET")" == "$TARGET" ]] \
      || die "refusing to create v$TARGET: $TAG_TARGET does not contain package version $TARGET"
    require_lease "pushing the missing tag v$TARGET"
    create_annotated_release_tag "$TARGET" "$(git rev-parse "$TAG_TARGET^{commit}")" --force
    git push origin "v$TARGET" && green "Pushed missing tag v$TARGET"
  else
    git fetch --quiet --force origin "refs/tags/v$TARGET:refs/tags/v$TARGET" \
      || die "could not fetch remote tag v$TARGET to verify its version"
    [[ "$(pkg_version_at_ref "v$TARGET")" == "$TARGET" ]] \
      || die "remote tag v$TARGET points at $REMOTE_TAG_SHA, which is not version $TARGET"
    gray "Tag v$TARGET already present for the published release."
  fi
  STUCK_BUMP_PR="$(gh pr list --head "$RELEASE_BRANCH" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"
  if [[ -n "$STUCK_BUMP_PR" ]] && scripts/release-lease.sh verify >/dev/null 2>&1; then
    if gh pr merge "$STUCK_BUMP_PR" --rebase; then
      green "Landed the deferred version-bump PR #$STUCK_BUMP_PR into $DEFAULT_BRANCH"
    else
      yellow "$PHNX_PKG@$TARGET is published; its bump PR #$STUCK_BUMP_PR still needs a manual merge:"
      yellow "  gh pr merge $STUCK_BUMP_PR --rebase"
    fi
  fi
  exit 0
fi

attestation_store_dir() {
  printf '%s\n' "${RELEASE_ATTESTATION_DIR:-$REPO_ROOT/.release-attestations}"
}

ATTEST_MAIN_TAG="main-attestations"

fetch_main_attestation() {
  local tree="$1" store="$2"
  [[ -n "$tree" && -n "$store" ]] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  if scripts/release-attestation.sh require --dir "$store" --tree "$tree" --repo-root "$REPO_ROOT" >/dev/null 2>&1; then
    return 0
  fi
  mkdir -p "$store" || return 1
  if command -v timeout >/dev/null 2>&1; then
    timeout 15 gh release download "$ATTEST_MAIN_TAG" --pattern "attest-$tree.json" --dir "$store" >/dev/null 2>&1 || return 1
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 15 gh release download "$ATTEST_MAIN_TAG" --pattern "attest-$tree.json" --dir "$store" >/dev/null 2>&1 || return 1
  else
    return 1
  fi
  scripts/release-attestation.sh require --dir "$store" --tree "$tree" --repo-root "$REPO_ROOT" >/dev/null 2>&1
}

upload_release_proof() {
  local tree="$1"
  local store attest tgz_json tgz dest
  store="$(attestation_store_dir)"
  attest="$(scripts/release-attestation.sh require --dir "$store" --tree "$tree" --repo-root "$REPO_ROOT")" \
    || die "cannot upload proof: no attestation for $tree"
  dest="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-release-proof.XXXXXX")"
  cp "$attest" "$dest/release-attestation.json"
  tgz_json="$(scripts/release-attestation.sh tarball --file "$attest" --require-file)"
  tgz="$(jq -r .path <<<"$tgz_json")"
  [[ -n "$tgz" && -f "$tgz" ]] || die "pretested tarball missing -- refusing to rebuild"
  cp "$tgz" "$dest/$(basename "$tgz")"
  if [[ "$WITH_HELPERS" == true ]]; then
    [[ -f "$store/release-manifest.json" ]] \
      || die "release manifest missing at $store/release-manifest.json -- no fallback rebuild"
    cp "$store/release-manifest.json" "$dest/release-manifest.json"
  else
    gray "CLI-only release: no helper assets staged onto v$TARGET (pass --with-helpers to include them)"
  fi
  if gh release view "v$TARGET" >/dev/null 2>&1; then
    gh release upload "v$TARGET" "$dest"/* --clobber \
      || die "failed to upload attested artifacts to v$TARGET"
  else
    gh release create "v$TARGET" "$dest"/* --verify-tag --title "v$TARGET" \
      --notes "attested tarball + reused helper for $TARGET" \
      || die "failed to create GitHub release v$TARGET with attested artifacts"
  fi
}


derive_release_attestation() {
  local head="$1" store tree base_tree base
  [[ -n "$head" ]] || return 1
  store="$(attestation_store_dir)"
  tree="$(git rev-parse "$head^{tree}")" || return 1

  scripts/release-attestation.sh require --dir "$store" --tree "$tree" \
      --repo-root "$REPO_ROOT" >/dev/null 2>&1 && return 0

  base_tree="$(git rev-parse "$BASE_SHA^{tree}" 2>/dev/null)" || return 1
  fetch_main_attestation "$base_tree" "$store" || true
  base="$(scripts/release-attestation.sh require --dir "$store" --tree "$base_tree" \
      --repo-root "$REPO_ROOT" 2>/dev/null)" || return 1

  bold "Deriving release-tree attestation ${tree:0:12} from ${base_tree:0:12} (no suite re-run)..."
  scripts/release-attestation-produce.sh "$head" --inherit-suite-from "$base" --dir "$store" \
    || { yellow "  could not derive -- falling back to the attestation poll"; return 1; }
  green "  derived (suite inherited from the attested $DEFAULT_BRANCH base)"
}

wait_for_attestation() {
  local tree="$1"
  local attest_dir
  attest_dir="$(attestation_store_dir)"
  local out
  [[ -n "$tree" ]] || die "missing tree digest for attestation"
  fetch_main_attestation "$tree" "$attest_dir" || true
  local deadline=$(( $(date +%s) + 30 ))
  bold "Waiting for exact-tree attestation ${tree:0:12} (30s fallback budget)..."
  while :; do
    if out="$(scripts/release-attestation.sh require --dir "$attest_dir" --tree "$tree" --repo-root "$REPO_ROOT" 2>/dev/null)"; then
      green "attestation $(basename "$out")"
      printf '%s\n' "$out"
      return 0
    fi
    (( $(date +%s) >= deadline )) && break
    sleep 5
  done
  scripts/release-attestation.sh require --dir "$attest_dir" --tree "$tree" --repo-root "$REPO_ROOT"
}

select_historical_catchup_publish_sha() {
  local merged_sha="$1" recorded_head="$2" fetched_head="$3"
  local attested_tree
  [[ -n "$merged_sha" && -n "$recorded_head" && -n "$fetched_head" ]] \
    || die "catch-up: missing merged or recorded release identity"
  [[ "$fetched_head" == "$recorded_head" ]] \
    || die "fetched PR head ${fetched_head:0:9} != recorded release head ${recorded_head:0:9} -- refusing catch-up publish"
  [[ "$(pkg_version_at_ref "$merged_sha")" == "$TARGET" ]] \
    || die "catch-up: $DEFAULT_BRANCH ${merged_sha:0:9} is not version $TARGET -- refusing to tag/publish"
  [[ "$(pkg_version_at_ref "$recorded_head")" == "$TARGET" ]] \
    || die "catch-up: attested PR head ${recorded_head:0:9} is not version $TARGET -- refusing to tag/publish"
  attested_tree="$(git rev-parse "$recorded_head^{tree}")"
  wait_for_attestation "$attested_tree" >/dev/null
  printf '%s\n' "$recorded_head"
}

if $MAIN_AT_TARGET && ! $PHNX_TARGET_PUBLISHED; then
  [[ -n "$MERGED_RELEASE_PR" && -n "$MERGED_RELEASE_SHA" && -n "$MERGED_RELEASE_HEAD" ]] \
    || die "main is already at $TARGET but no complete merged $RELEASE_BRANCH PR exists -- refusing an unverified catch-up publish; cut the next patch through the normal release PR flow"
  if [[ -z "${CI_TESTED_HEAD:-}" ]]; then
    git fetch --quiet origin "pull/$MERGED_RELEASE_PR/head" \
      || die "could not fetch the attested head for merged release PR #$MERGED_RELEASE_PR"
    CI_TESTED_HEAD="$(git rev-parse FETCH_HEAD)"
  fi
  HISTORICAL_CATCHUP=true
fi

if ! $MAIN_AT_TARGET; then
  phase "Require release-base attestation" "$THIS_HOST"
  if $SKIP_TESTS; then
    gray "(--skip-tests does not skip attestation; exact-tree proof is still required)"
  fi
  wait_for_attestation "$(git rev-parse "$BASE_SHA^{tree}")" >/dev/null
  phase_ok "release base ${BASE_SHA:0:9} is attested (toolchain/lock/policy bound)"
fi

if ! $MAIN_AT_TARGET; then
  phase "Open release PR, wait for release-tree attestation" "$THIS_HOST"
  if ! OPEN_PR_LINES="$(gh pr list --state open --limit 200 --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"' 2>/dev/null)"; then
    die "could not list open PRs (gh pr list failed) to check for a stuck earlier release bump — refusing to fold, or an earlier version's notes could be silently re-attributed under $TARGET. Retry when gh is reachable."
  fi
  OTHER_BUMP_PRS="$(printf '%s\n' "$OPEN_PR_LINES" | scripts/release-other-bump-prs.sh "$RELEASE_BRANCH")"
  if [[ -n "$OTHER_BUMP_PRS" ]]; then
    red "Refusing to fold .changelog/next/* for $TARGET — an earlier release bump PR is still open:" >&2
    while IFS= read -r line; do red "  $line" >&2; done <<< "$OTHER_BUMP_PRS"
    red "Its notes are still queued on $DEFAULT_BRANCH; folding $TARGET now would re-attribute them." >&2
    red "Land it first (gh pr merge <n> --rebase), then re-run this release." >&2
    exit 1
  fi
  PR_BODY="Release $TARGET."
  if ! NOTES="$(bun scripts/release-changelog.ts "$TARGET")"; then
    red "CHANGELOG queue empty (or fold failed) — a release must document itself." >&2
    red "  Add a note at .changelog/next/<ticket>.md before releasing $TARGET." >&2
    exit 1
  fi
  PR_BODY="$(printf '## %s\n\n%s' "$TARGET" "$NOTES")"
  green "Folded .changelog/next/* -> .changelog/$TARGET.md; regenerated CHANGELOG.md"

  scripts/generate-reference.sh
  green "Regenerated docs/command-index.{md,json} and docs/command-reference.html"

  stage_release_metadata
  BRANCH_TREE="$(git write-tree)"
  RELEASE_COMMIT="$(git commit-tree "$BRANCH_TREE" -p "$BASE_SHA" -m "chore(release): $TARGET")"

  PR_NUMBER=""
  RELEASE_CI_HEAD=""
  if [[ -n "$EXISTING_PR" ]]; then
    PR_NUMBER="$EXISTING_PR"
    EXISTING_HEAD="$(gh pr view "$EXISTING_PR" --json headRefOid --jq .headRefOid 2>/dev/null || true)"
    if [[ -n "$EXISTING_HEAD" && "$(git rev-parse "$EXISTING_HEAD^{tree}" 2>/dev/null || true)" == "$BRANCH_TREE" ]]; then
      RELEASE_CI_HEAD="$EXISTING_HEAD"
      gray "Reusing open PR #$PR_NUMBER ($RELEASE_BRANCH); branch tree already matches."
    else
      git push --force-with-lease origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
      RELEASE_CI_HEAD="$RELEASE_COMMIT"
      gray "Updated PR #$PR_NUMBER branch to the freshly built release commit."
    fi
  else
    git push --force-with-lease origin "$RELEASE_COMMIT:refs/heads/$RELEASE_BRANCH"
    RELEASE_CI_HEAD="$RELEASE_COMMIT"
    green "Pushed $RELEASE_BRANCH"
  fi

  restore_release_tree

  if [[ -z "$PR_NUMBER" ]]; then
    gh pr create --base "$DEFAULT_BRANCH" --head "$RELEASE_BRANCH" \
      --title "chore(release): $TARGET" --body "$PR_BODY" >/dev/null \
      || die "failed to open release PR for $RELEASE_BRANCH"
    PR_NUMBER="$(gh pr view "$RELEASE_BRANCH" --json number --jq .number 2>/dev/null || true)"
    [[ -n "$PR_NUMBER" ]] || die "opened PR but could not resolve its number for $RELEASE_BRANCH"
    green "Opened release PR #$PR_NUMBER"
  fi

  [[ -n "$RELEASE_CI_HEAD" ]] || die "could not resolve attested head for PR #$PR_NUMBER"
  derive_release_attestation "$RELEASE_CI_HEAD" || true
  wait_for_attestation "$(git rev-parse "$RELEASE_CI_HEAD^{tree}")" >/dev/null

  phase_ok "PR #$PR_NUMBER: release tree attested (merge deferred until after publish)"
fi

phase "Tag v$TARGET at the attested release commit" "$THIS_HOST"

if $HISTORICAL_CATCHUP; then
  git fetch --quiet origin "$DEFAULT_BRANCH"
  bold "Re-validating attested PR head for merged release PR #$MERGED_RELEASE_PR before catch-up publish..."
  PUBLISH_SHA="$(select_historical_catchup_publish_sha \
    "$MERGED_RELEASE_SHA" "$MERGED_RELEASE_HEAD" "$CI_TESTED_HEAD")"
else
  CI_COMMIT="$RELEASE_CI_HEAD"
  [[ -n "${CI_COMMIT:-}" ]] || die "internal: no attested release commit resolved -- refusing to publish"
  [[ "$(pkg_version_at_ref "$CI_COMMIT")" == "$TARGET" ]] \
    || die "attested release commit ${CI_COMMIT:0:9} is not version $TARGET -- refusing to publish"
  ATTESTED_TREE="$(git rev-parse "$CI_COMMIT^{tree}")"
  wait_for_attestation "$ATTESTED_TREE" >/dev/null
  PUBLISH_SHA="$CI_COMMIT"
fi


REMOTE_TAG_SHA="$(remote_tag_commit "v$TARGET")"
[[ -z "$REMOTE_TAG_SHA" || "$REMOTE_TAG_SHA" == "$PUBLISH_SHA" ]] \
  || die "remote tag v$TARGET points at $REMOTE_TAG_SHA, not verified release commit $PUBLISH_SHA"
if git rev-parse --verify --quiet "refs/tags/v$TARGET" >/dev/null; then
  [[ "$(git rev-parse "refs/tags/v$TARGET^{commit}")" == "$PUBLISH_SHA" ]] \
    || die "local tag v$TARGET does not point at the verified release commit $PUBLISH_SHA"
  if [[ "$(git cat-file -t "refs/tags/v$TARGET")" != "tag" ]]; then
    create_annotated_release_tag "$TARGET" "$PUBLISH_SHA" --force
    green "Upgraded lightweight local tag v$TARGET to annotated at $(git rev-parse --short "$PUBLISH_SHA")"
  else
    gray "Tag v$TARGET already exists locally at the verified release commit"
  fi
else
  create_annotated_release_tag "$TARGET" "$PUBLISH_SHA"
  green "Created annotated tag v$TARGET at $(git rev-parse --short "$PUBLISH_SHA")"
fi

require_lease "pushing tag v$TARGET"
git push origin "v$TARGET"
upload_release_proof "$ATTESTED_TREE"
phase_ok "attested tree verified; tag v$TARGET at ${PUBLISH_SHA:0:9} pushed; proof uploaded"

restore_release_tree

phase "Promote attested tgz + reuse helpers + install smoke" "$RELEASE_HOME_BASE"
require_lease "publishing $PHNX_PKG@$TARGET"
route_home_base_phase \
  || phase_fail "privileged phase failed on the home base ($RELEASE_HOME_BASE) -- tag v$TARGET pushed; rerun to retry: $0 $TARGET --apply"
phase_ok "published $PHNX_PKG@$TARGET from $RELEASE_HOME_BASE (token resolved there; no Touch ID)"

phase "Verify live" "$THIS_HOST"
PUBLISHED_NOW="$(npm view "$PHNX_PKG@$TARGET" version 2>/dev/null || true)"
if [[ "$PUBLISHED_NOW" == "$TARGET" ]]; then
  phase_ok "npm registry reports $PHNX_PKG@$TARGET; tag v$TARGET pushed"
else
  phase_fail "npm registry does not yet report $PHNX_PKG@$TARGET (saw '${PUBLISHED_NOW:-none}') -- check the home-base publish output"
fi

# ----- Land the version bump on main -- AFTER publish, non-gating -----
if [[ -n "${PR_NUMBER:-}" ]] && ! $HISTORICAL_CATCHUP; then
  if scripts/release-lease.sh verify >/dev/null 2>&1 \
    && gh pr merge "$PR_NUMBER" --rebase; then
    green "Merged release PR #$PR_NUMBER into $DEFAULT_BRANCH"
  else
    yellow "$PHNX_PKG@$TARGET is PUBLISHED. Release PR #$PR_NUMBER did not auto-merge"
    yellow "  (main moved or a CHANGELOG conflict) -- this does NOT block anything."
    yellow "  Land the bump when convenient: gh pr merge $PR_NUMBER --rebase"
  fi
fi

green "Released $TARGET"
gray "$PHNX_PKG@$TARGET is live. The version bump lands on $DEFAULT_BRANCH via the release PR"
gray "  (merged above, or -- if it deferred on a conflict -- when that PR is merged)."
