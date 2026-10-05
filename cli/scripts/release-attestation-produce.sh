#!/usr/bin/env bash
# Usage: scripts/release-attestation-produce.sh <commit-ish>
#   [--dir DIR] [--repo-root DIR] [--keep] [--with-helpers]
#   [--inherit-suite-from BASE.json]
#   [--test-shard N | --test-devices a,b | --test-device HOST | --test-here | --test-crabbox]
set -euo pipefail

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"

cd "$(dirname "$0")/.."
DEFAULT_REPO_ROOT="$(git rev-parse --show-toplevel)"

COMMIT_ISH=""
REPO_ROOT="$DEFAULT_REPO_ROOT"
STORE=""
KEEP=false
TEST_TARGET=()
WITH_HELPERS=false
INHERIT_BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) STORE="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --test-device) [[ -n "${2:-}" ]] || die "--test-device needs a machine name"; TEST_TARGET=(--device "$2"); shift 2 ;;
    --test-here) TEST_TARGET=(--here); shift ;;
    --test-crabbox) TEST_TARGET=(--crabbox); shift ;;
    --test-shard) [[ -n "${2:-}" ]] || die "--test-shard needs a worker count, e.g. --test-shard 6"; TEST_TARGET=(--shard "$2"); shift 2 ;;
    --test-devices) [[ -n "${2:-}" ]] || die "--test-devices needs a comma-separated list, e.g. --test-devices m1,m2,m3"; TEST_TARGET=(--devices "$2"); shift 2 ;;
    --inherit-suite-from) [[ -n "${2:-}" ]] || die "--inherit-suite-from needs a base attestation JSON path"; INHERIT_BASE="$2"; shift 2 ;;
    --with-helpers) WITH_HELPERS=true; shift ;;
    -h|--help)
      awk 'NR>2 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"
      exit 0
      ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$COMMIT_ISH" ]] || die "unexpected argument: $1"
      COMMIT_ISH="$1"
      shift
      ;;
  esac
done
[[ -n "$COMMIT_ISH" ]] || die "usage: scripts/release-attestation-produce.sh <commit-ish> [--dir DIR] [--repo-root DIR] [--keep]"

if [[ -n "$INHERIT_BASE" ]]; then
  [[ -f "$INHERIT_BASE" ]] || die "--inherit-suite-from: base attestation not found: $INHERIT_BASE"
  [[ ${#TEST_TARGET[@]} -eq 0 ]] || die "--inherit-suite-from skips the suite; do not also pass a --test-* target"
fi

SHARD_CAP=8
resolve_default_shards() {
  local n
  n="$(agents devices pick --json 2>/dev/null | jq -r '[.candidates[] | select(.headroom != "loaded")] | length' 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  if (( n >= 2 )); then
    (( n > SHARD_CAP )) && n=$SHARD_CAP
    printf '%s\n' "$n"
  fi
}
if [[ -z "$INHERIT_BASE" && ${#TEST_TARGET[@]} -eq 0 ]]; then
  default_shards="$(resolve_default_shards)"
  if [[ -n "$default_shards" ]]; then
    TEST_TARGET=(--shard "$default_shards")
    gray "Sharding the suite across $default_shards fleet workers (each at --maxWorkers=2)."
  else
    gray "Fewer than 2 eligible workers; running the suite on one auto-picked box."
  fi
fi

git -C "$REPO_ROOT" fetch --quiet origin
SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$COMMIT_ISH^{commit}" 2>/dev/null)" \
  || die "cannot resolve '$COMMIT_ISH' to a commit in $REPO_ROOT (fetch origin first if it's a remote ref)"
TREE="$(git -C "$REPO_ROOT" rev-parse "$SHA^{tree}")"

STORE="${STORE:-${RELEASE_ATTESTATION_DIR:-$REPO_ROOT/.release-attestations}}"
mkdir -p "$STORE"
STORE="$(cd "$STORE" && pwd)"

mkdir -p "$REPO_ROOT/.agents/worktrees"
WT="$(mktemp -d "$REPO_ROOT/.agents/worktrees/attest-produce.XXXXXX")"
cleanup() {
  if $KEEP; then
    gray "kept worktree for inspection: $WT"
  else
    git -C "$REPO_ROOT" worktree remove "$WT" >/dev/null 2>&1 \
      || gray "Retained attestation worktree for inspection: $WT"
  fi
}
trap cleanup EXIT

bold "Producing attestation for ${SHA:0:12} (tree ${TREE:0:12})"
git -C "$REPO_ROOT" worktree add --quiet --detach "$WT" "$SHA" \
  || die "could not create worktree at $WT from $SHA"

missing="$(git -C "$WT" status --short | awk '$1 == "D" || $2 == "D" { print $2 }')"
[[ -z "$missing" ]] || die "worktree $WT is incomplete; missing tracked files: $missing"

CLI_DIR="cli"
[[ -d "$WT/cli" ]] || CLI_DIR="apps/cli"
cd "$WT/$CLI_DIR"

bun install --frozen-lockfile || die "bun install failed for ${SHA:0:12}"

[[ -n "$INHERIT_BASE" ]] || bold "Running the full suite..."
unset CI
export AGENTS_ATTEST_PRODUCER=1
suite_green_despite_worker_crash() {
  local log="$1" files_line tests_line
  grep -q 'Worker exited unexpectedly' "$log" || return 1
  files_line="$(grep -E '^[[:space:]]*Test Files[[:space:]]' "$log" | tail -1)"
  tests_line="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$log" | tail -1)"
  [[ -n "$files_line" && -n "$tests_line" ]] || return 1
  grep -qE '(^|[^[:alnum:]])failed([^[:alnum:]]|$)' <<<"$files_line" && return 1
  grep -qE '(^|[^[:alnum:]])failed([^[:alnum:]]|$)' <<<"$tests_line" && return 1
  grep -qE '(^|[^[:alnum:]])passed([^[:alnum:]]|$)' <<<"$tests_line"
}
SUITE_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-attest-suite.XXXXXX")"
if [[ -n "$INHERIT_BASE" ]]; then
  green "Inheriting the suite result from $(basename "$INHERIT_BASE") (skipping the full suite)."
  rm -f "$SUITE_LOG"
elif scripts/test.sh ${TEST_TARGET[@]+"${TEST_TARGET[@]}"} -- --retry=2 --maxWorkers=2 2>&1 | tee "$SUITE_LOG"; then
  green "Suite passed."
  rm -f "$SUITE_LOG"
elif suite_green_despite_worker_crash "$SUITE_LOG"; then
  gray "vitest worker exited after zero test failures; treating as pass (RUSH-2215)."
  green "Suite passed (teardown worker-exit tolerated on a green summary)."
  rm -f "$SUITE_LOG"
else
  die "suite failed for ${SHA:0:12} -- refusing to attest a red tree (log: $SUITE_LOG)"
fi

if [[ "$WITH_HELPERS" == true && "$(uname)" == "Darwin" ]] && command -v agents >/dev/null 2>&1 \
  && [[ -x scripts/sign-cli-binary.sh ]]; then
  bold "Signing + notarizing the CLI binary..."
  # shellcheck source=scripts/headless-sign-context.sh
  . scripts/headless-sign-context.sh
  agents secrets exec apple.com -- scripts/sign-cli-binary.sh \
    || die "CLI binary sign/notarize failed"
else
  gray "Not a macOS signing box -- nothing to do: the tarball ships no helper bundle."
fi

bold "Building the complete CLI package..."
scripts/build.sh --clean --skip-tests || die "build failed for ${SHA:0:12}"

bold "Packing the pretested tarball (npm pack)..."
TGZ_NAME="$(npm pack --silent 2>&1 | tail -1)"
[[ -f "$TGZ_NAME" ]] || die "npm pack did not produce a tarball (got: $TGZ_NAME)"
if command -v sha256sum >/dev/null 2>&1; then
  TGZ_DIGEST="$(sha256sum "$TGZ_NAME" | awk '{print $1}')"
else
  TGZ_DIGEST="$(shasum -a 256 "$TGZ_NAME" | awk '{print $1}')"
fi
green "Packed $TGZ_NAME (sha256:$TGZ_DIGEST)"

ATTEST_TMP="$(mktemp "${TMPDIR:-/tmp}/agents-cli-attest.json.XXXXXX")"
if [[ -n "$INHERIT_BASE" ]]; then
  scripts/release-attestation.sh derive \
      --base "$INHERIT_BASE" --tarball "$TGZ_NAME" \
      --repo-root "$WT" --commit "$SHA" \
      > "$ATTEST_TMP" \
      || die "derive failed for ${SHA:0:12} -- the release tree is not a metadata-only descendant of the base; run the full suite instead"
else
  scripts/release-attestation.sh identity --repo-root "$WT" --commit "$SHA" \
    | jq --arg name "$TGZ_NAME" --arg digest "sha256:$TGZ_DIGEST" \
        '. + {schemaVersion: 1, suite: "selected", conclusion: "pass", tarball: {filename: $name, digest: $digest}}' \
    > "$ATTEST_TMP"
fi

DEST_JSON="$(scripts/release-attestation.sh write --dir "$STORE" --file "$ATTEST_TMP")" \
  || die "failed to write attestation record"
rm -f "$ATTEST_TMP"
DEST_DIR="$(dirname "$DEST_JSON")"
mv "$TGZ_NAME" "$DEST_DIR/$TGZ_NAME"

green "Wrote $DEST_JSON"
green "Tarball at $DEST_DIR/$TGZ_NAME"

newest_release_with_manifest() {
  local tags tag newest=""
  tags="$(gh release list --limit 20 --json tagName --jq '.[].tagName' 2>/dev/null)" || return 1
  while read -r tag; do
    [[ -n "$tag" && "$tag" != "null" ]] || continue
    [[ -n "$newest" ]] || newest="$tag"
    if gh release view "$tag" --json assets \
         --jq '[.assets[].name] | index("release-manifest.json")' 2>/dev/null \
         | grep -qE '^[0-9]+$'; then
      printf '%s\n' "$tag"
      return 0
    fi
  done <<< "$tags"
  printf '%s\n' "$newest"
}

if [[ "$WITH_HELPERS" == true && -x scripts/release-manifest.sh ]]; then
  bold "Updating the helper manifest..."
  MANIFEST_FILE="$STORE/release-manifest.json"
  CLI_VERSION_MANIFEST="$(jq -r .version package.json)"
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    seed_note=""
    if ! command -v gh >/dev/null 2>&1; then
      seed_note="no gh on PATH"
    elif ! PRIOR_TAG="$(newest_release_with_manifest)"; then
      seed_note="gh could not list releases (auth or network)"
    elif [[ -z "$PRIOR_TAG" || "$PRIOR_TAG" == "null" ]]; then
      seed_note="no published release to seed from"
    elif ! gh release download "$PRIOR_TAG" --pattern release-manifest.json --dir "$STORE" >/dev/null 2>&1 \
      || [[ ! -f "$MANIFEST_FILE" ]]; then
      seed_note="$PRIOR_TAG carries no release-manifest.json"
    fi

    if [[ -z "$seed_note" ]]; then
      gray "Seeded the helper manifest from $PRIOR_TAG (unchanged helpers carry forward)."
    else
      gray "Starting a fresh helper manifest — $seed_note."
      scripts/release-manifest.sh new --cli-version "$CLI_VERSION_MANIFEST" --cli-tree "$TREE" \
        > "$MANIFEST_FILE"
    fi
  fi

  manifest_asset_sha256() {
    local f="$1"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$f" | awk '{print $1}'
    else
      shasum -a 256 "$f" | awk '{print $1}'
    fi
  }

  record_menubar_from_published() {
    local want_digest="$1" info floor tag zip sha url source
    [[ -x scripts/stage-menubar-helper.sh ]] \
      || die "helper menubar input changed but scripts/stage-menubar-helper.sh is missing from this tree -- cannot record the published helper"
    info="$(scripts/stage-menubar-helper.sh --fetch-only --json --download-dir "$WT/.mb-helper-dl")" \
      || die "helper menubar input changed and the published release could not be fetched/verified (see above) -- publish the helper from phnx-labs/agi-menu ('agents secrets exec apple.com -- scripts/release.sh <x.y.z>' there), point the menubar floor in src/lib/helper-versions.ts at it, then re-run this producer"
    floor="$(jq -r .floor <<<"$info")"
    tag="$(jq -r .tag <<<"$info")"
    zip="$(jq -r .zip <<<"$info")"
    sha="$(jq -r .sha256 <<<"$info")"
    url="$(jq -r .assetUrl <<<"$info")"
    source="$(jq -c .source <<<"$info")"
    [[ -f "$zip" && "$sha" =~ ^[0-9a-f]{64}$ ]] \
      || die "stage-menubar-helper.sh reported no verified asset for $tag: $info"
    local put_args=(--file "$MANIFEST_FILE" --helper menubar
      --helper-version "$floor" --input-digest "$want_digest"
      --asset-digest "sha256:$sha" --asset-path "$zip" --asset-url "$url" --platform darwin)
    [[ "$source" == "null" ]] || put_args+=(--source "$source")
    scripts/release-manifest.sh put "${put_args[@]}" >/dev/null \
      || die "failed to record menubar in the manifest"
    if [[ "$source" == "null" ]]; then
      green "Recorded menubar from published $tag (asset ${sha:0:12}; release carries no menubar-source.txt)"
    else
      green "Recorded menubar from published $tag (asset ${sha:0:12}, source $(jq -r '"\(.repo)@\(.commit)"' <<<"$source"))"
    fi
  }

  for helper in menubar; do
    helper_digest="$(scripts/release-manifest.sh input-digest --repo-root "$WT" --helper "$helper")" \
      || die "could not compute input digest for helper $helper"
    recorded_digest="$(jq -r --arg n "$helper" '.helpers[$n].inputDigest // empty' "$MANIFEST_FILE")"
    if [[ -n "$recorded_digest" && "$recorded_digest" == "$helper_digest" ]]; then
      gray "helper $helper unchanged (${helper_digest#sha256:}) -- carrying forward its attested record"
      continue
    fi
    case "$helper" in
      menubar) record_menubar_from_published "$helper_digest" ;;
    esac
  done
  green "Manifest at $MANIFEST_FILE"
else
  if [[ "$WITH_HELPERS" != true ]]; then
    gray "CLI-only attestation: skipping the helper manifest (pass --with-helpers to include it)."
  else
    gray "No scripts/release-manifest.sh in this tree -- skipping helper manifest production."
  fi
fi
