#!/usr/bin/env bash
set -euo pipefail

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"

usage() {
  sed -n '3,22p' "$0" | sed 's/^# \?//'
  exit 2
}

CMD="${1:-}"
[[ -n "$CMD" ]] || usage
shift

REPO_ROOT=""
COMMIT="HEAD"
DIR=""
FILE=""
TREE=""
LOCK_DIGEST=""
POLICY=""
BUN_VER=""
NODE_VER=""
PLATFORM=""
SUITE=""
TGZ=""
BASE=""
REQUIRE_FILE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --commit) COMMIT="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --tree) TREE="$2"; shift 2 ;;
    --lock|--lockfile-digest) LOCK_DIGEST="$2"; shift 2 ;;
    --policy|--policy-version) POLICY="$2"; shift 2 ;;
    --bun) BUN_VER="$2"; shift 2 ;;
    --node) NODE_VER="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --suite) SUITE="$2"; shift 2 ;;
    --tarball) TGZ="$2"; shift 2 ;;
    --require-file) REQUIRE_FILE=true; shift ;;
    -h|--help) usage ;;
    *) die "unknown flag: $1" ;;
  esac
done

resolve_repo_root() {
  if [[ -n "$REPO_ROOT" ]]; then
    git -C "$REPO_ROOT" rev-parse --show-toplevel
  else
    git rev-parse --show-toplevel 2>/dev/null \
      || die "not inside a git repo (pass --repo-root)"
  fi
}

lockfile_digest_of() {
  local root="$1"
  local lock="$root/cli/bun.lock"
  [[ -f "$lock" ]] || lock="$root/bun.lock"
  [[ -f "$lock" ]] || die "lockfile not found under $root (cli/bun.lock or bun.lock)"
  printf 'sha256:%s\n' "$(file_sha256 "$lock")"
}

policy_version_of() {
  local root="$1"
  local concat="" f rel
  for f in \
    "$root/cli/vitest.config.ts" \
    "$root/cli/ci/test-ownership.yaml" \
    "$root/scripts/ci-scope.ts"
  do
    [[ -f "$f" ]] || continue
    rel="${f#"$root"/}"
    concat+="$(file_sha256 "$f")  $rel"$'\n'
  done
  [[ -n "$concat" ]] || die "no policy inputs found under $root"
  printf 'sha256:%s\n' "$(str_sha256 "$concat")"
}

toolchain_of() {
  local bun node plat
  bun="$(bun --version 2>/dev/null || true)"
  node="$(node --version 2>/dev/null || true)"
  plat="$(uname -s)-$(uname -m)"
  [[ -n "$bun" ]] || die "bun not on PATH -- cannot bind toolchain"
  [[ -n "$node" ]] || die "node not on PATH -- cannot bind toolchain"
  jq -nc --arg bun "$bun" --arg node "$node" --arg os "$plat" \
    '{bun:$bun, node:$node, os:$os}'
}

attestation_key_from_fields() {
  local tree="$1" lock="$2" policy="$3" bun="$4" node="$5" plat="$6" suite="$7"
  [[ -n "$tree" && -n "$lock" && -n "$policy" && -n "$bun" && -n "$node" && -n "$plat" && -n "$suite" ]] \
    || die "attestation key requires tree, lock, policy, bun, node, platform, suite"
  str_sha256 $'tree='"$tree"$'\nlock='"$lock"$'\npolicy='"$policy"$'\nbun='"$bun"$'\nnode='"$node"$'\nplatform='"$plat"$'\nsuite='"$suite"
}

key_from_file() {
  local f="$1"
  [[ -f "$f" ]] || die "attestation not found: $f"
  jq -e '.schemaVersion == 1' "$f" >/dev/null \
    || die "unsupported attestation schema in $f"
  attestation_key_from_fields \
    "$(jq -r '.candidateTree // empty' "$f")" \
    "$(jq -r '.lockfileDigest // empty' "$f")" \
    "$(jq -r '.policyVersion // empty' "$f")" \
    "$(jq -r '.toolchain.bun // empty' "$f")" \
    "$(jq -r '.toolchain.node // empty' "$f")" \
    "$(jq -r '.platform // empty' "$f")" \
    "$(jq -r '.suite // empty' "$f")"
}

emit_identity() {
  local root commit tree lock policy tool
  root="$(resolve_repo_root)"
  commit="$(git -C "$root" rev-parse "$COMMIT")"
  tree="$(git -C "$root" rev-parse "$COMMIT^{tree}")"
  lock="$(lockfile_digest_of "$root")"
  policy="$(policy_version_of "$root")"
  tool="$(toolchain_of)"
  jq -nc \
    --arg commit "$commit" \
    --arg tree "$tree" \
    --arg lock "$lock" \
    --arg policy "$policy" \
    --argjson toolchain "$tool" \
    '{
      candidateCommit: $commit,
      candidateTree: $tree,
      lockfileDigest: $lock,
      policyVersion: $policy,
      toolchain: $toolchain,
      platform: $toolchain.os
    }'
}

verify_file() {
  local f="$1"
  [[ -f "$f" ]] || die "attestation not found: $f"
  jq -e '.schemaVersion == 1
      and (.candidateTree | type == "string" and length > 0)
      and (.lockfileDigest | type == "string" and startswith("sha256:"))
      and (.policyVersion | type == "string" and startswith("sha256:"))
      and (.toolchain.bun | type == "string" and length > 0)
      and (.toolchain.node | type == "string" and length > 0)
      and (.platform | type == "string" and length > 0)
      and (.suite | type == "string" and length > 0)
      and .conclusion == "pass"
      and (.tarball.digest | type == "string" and startswith("sha256:"))
      and (.tarball.filename | type == "string" and endswith(".tgz"))' "$f" >/dev/null \
    || die "attestation $f is incomplete or is not a passing tarball proof"

  local got
  got="$(jq -r '.candidateTree' "$f")"
  [[ -z "$TREE" || "$got" == "$TREE" ]] \
    || die "attestation tree $got != required tree $TREE -- parent/nearby evidence is rejected"

  got="$(jq -r '.lockfileDigest' "$f")"
  [[ -z "$LOCK_DIGEST" || "$got" == "$LOCK_DIGEST" ]] \
    || die "attestation lock $got != required $LOCK_DIGEST"

  got="$(jq -r '.policyVersion' "$f")"
  [[ -z "$POLICY" || "$got" == "$POLICY" ]] \
    || die "attestation policy $got != required $POLICY"

  got="$(jq -r '.toolchain.bun' "$f")"
  [[ -z "$BUN_VER" || "$got" == "$BUN_VER" ]] \
    || die "attestation bun $got != required $BUN_VER"

  got="$(jq -r '.toolchain.node' "$f")"
  [[ -z "$NODE_VER" || "$got" == "$NODE_VER" ]] \
    || die "attestation node $got != required $NODE_VER"

  got="$(jq -r '.platform' "$f")"
  [[ -z "$PLATFORM" || "$got" == "$PLATFORM" ]] \
    || die "attestation platform $got != required $PLATFORM"

  got="$(jq -r '.suite' "$f")"
  [[ -z "$SUITE" || "$got" == "$SUITE" ]] \
    || die "attestation suite $got != required $SUITE"
}

missing_key_msg() {
  printf 'missing exact attestation key: tree=%s lock=%s policy=%s bun=%s node=%s platform=%s suite=%s\n' \
    "${TREE:-?}" "${LOCK_DIGEST:-?}" "${POLICY:-?}" "${BUN_VER:-?}" "${NODE_VER:-?}" "${PLATFORM:-?}" "${SUITE:-selected}"
}

bind_tree_lock_policy() {
  if [[ -z "$LOCK_DIGEST" || -z "$POLICY" ]]; then
    local root
    root="$(resolve_repo_root)"
    [[ -n "$LOCK_DIGEST" ]] || LOCK_DIGEST="$(lockfile_digest_of "$root")"
    [[ -n "$POLICY" ]] || POLICY="$(policy_version_of "$root")"
  fi
  [[ -n "$SUITE" ]] || SUITE="selected"
}

require_from_dir() {
  [[ -n "$DIR" ]] || die "require needs --dir"
  [[ -n "$TREE" ]] || die "require needs --tree"
  [[ -d "$DIR" ]] || die "$(missing_key_msg)"
  bind_tree_lock_policy

  local f got_tree got_lock got_policy got_suite
  shopt -s nullglob
  for f in "$DIR"/*.json "$DIR"/release-attestation.json; do
    [[ -f "$f" ]] || continue
    got_tree="$(jq -r '.candidateTree // empty' "$f")"
    [[ "$got_tree" == "$TREE" ]] || continue
    BUN_VER="" NODE_VER="" PLATFORM="" verify_file "$f"
    got_lock="$(jq -r '.lockfileDigest' "$f")"
    got_policy="$(jq -r '.policyVersion' "$f")"
    got_suite="$(jq -r '.suite' "$f")"
    [[ "$got_lock" == "$LOCK_DIGEST" ]] || continue
    [[ "$got_policy" == "$POLICY" ]] || continue
    [[ -z "$SUITE" || "$got_suite" == "$SUITE" ]] || continue
    printf '%s\n' "$f"
    return 0
  done
  die "$(missing_key_msg)"
}

tarball_from_file() {
  [[ -n "$FILE" ]] || die "tarball needs --file"
  verify_file "$FILE"
  local name digest dir path
  name="$(jq -r '.tarball.filename' "$FILE")"
  digest="$(jq -r '.tarball.digest' "$FILE")"
  dir="$(cd "$(dirname "$FILE")" && pwd)"
  if [[ -n "${RELEASE_PRETESTED_TGZ:-}" ]]; then
    path="$RELEASE_PRETESTED_TGZ"
  elif [[ -f "$dir/$name" ]]; then
    path="$dir/$name"
  else
    path=""
  fi
  if $REQUIRE_FILE; then
    [[ -n "$path" && -f "$path" ]] \
      || die "pretested tarball $name (digest $digest) is not on disk -- refusing to rebuild"
  fi
  jq -nc --arg filename "$name" --arg digest "$digest" --arg path "$path" \
    '{filename:$filename, digest:$digest, path:$path}'
}

promote_tarball() {
  [[ -n "$FILE" ]] || die "promote needs --file"
  [[ -n "$TGZ" ]] || die "promote needs --tarball"
  [[ -f "$TGZ" ]] || die "pretested tarball not found: $TGZ -- refusing to rebuild"
  verify_file "$FILE"
  local expect got name
  name="$(jq -r '.tarball.filename' "$FILE")"
  expect="$(jq -r '.tarball.digest' "$FILE")"
  expect="${expect#sha256:}"
  got="$(file_sha256 "$TGZ")"
  [[ "$got" == "$expect" ]] \
    || die "tarball digest sha256:$got != attested sha256:$expect -- refusing to publish a different artifact"
  local base
  base="$(basename "$TGZ")"
  [[ "$base" == "$name" ]] \
    || die "tarball filename $base != attested $name -- refusing to publish a different artifact"
  printf '%s\n' "$TGZ"
}

release_diff_is_metadata_only() {
  local root="$1" base_tree="$2" rel_tree="$3" line rel
  local changed
  changed="$(git -C "$root" diff --name-only "$base_tree" "$rel_tree")" \
    || die "cannot diff base tree ${base_tree:0:12} against release tree ${rel_tree:0:12}"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    case "$line" in
      cli/*|apps/cli/*) ;;
      packages/session-tracker/*)
        die "derive refused: packaged session-tracker input changes '$line' -- run the full suite for this tree"
        ;;
      scripts/ci-scope.ts)
        die "derive refused: release policy changes '$line' -- run the full suite for this tree"
        ;;
      README.md) continue ;;
      *) continue ;;
    esac
    rel="$line"
    rel="${rel#apps/cli/}"
    rel="${rel#cli/}"
    case "$rel" in
      package.json|CHANGELOG.md|docs/command-index.md|docs/command-index.json|docs/command-reference.html) ;;
      .changelog/*) ;;
      *) die "derive refused: release tree changes '$line' beyond CLI version/changelog/command-index -- run the full suite for this tree" ;;
    esac
  done <<< "$changed"
}

derive_release_tree() {
  [[ -n "$BASE" ]] || die "derive needs --base BASE.json"
  [[ -n "$TGZ" ]] || die "derive needs --tarball TGZ (the release-tree pack)"
  [[ -f "$TGZ" ]] || die "release tarball not found: $TGZ"
  TREE="" LOCK_DIGEST="" POLICY="" BUN_VER="" NODE_VER="" PLATFORM="" SUITE="" \
    verify_file "$BASE"

  local root base_tree rel_commit rel_tree
  root="$(resolve_repo_root)"
  base_tree="$(jq -r '.candidateTree' "$BASE")"
  rel_commit="$(git -C "$root" rev-parse "$COMMIT")"
  rel_tree="$(git -C "$root" rev-parse "$COMMIT^{tree}")"

  release_diff_is_metadata_only "$root" "$base_tree" "$rel_tree"

  local name digest
  name="$(basename "$TGZ")"
  digest="sha256:$(file_sha256 "$TGZ")"

  jq -nc \
    --arg commit "$rel_commit" \
    --arg tree "$rel_tree" \
    --arg lock "$(jq -r '.lockfileDigest' "$BASE")" \
    --arg policy "$(jq -r '.policyVersion' "$BASE")" \
    --argjson toolchain "$(jq -c '.toolchain' "$BASE")" \
    --arg platform "$(jq -r '.platform' "$BASE")" \
    --arg suite "$(jq -r '.suite' "$BASE")" \
    --arg name "$name" \
    --arg digest "$digest" \
    --arg baseTree "$base_tree" \
    --arg baseDigest "$(jq -r '.attestationDigest // empty' "$BASE")" \
    '{
      schemaVersion: 1,
      candidateCommit: $commit,
      candidateTree: $tree,
      lockfileDigest: $lock,
      policyVersion: $policy,
      toolchain: $toolchain,
      platform: $platform,
      suite: $suite,
      conclusion: "pass",
      tarball: { filename: $name, digest: $digest },
      derivedFrom: ( { baseTree: $baseTree }
        + (if $baseDigest == "" then {} else { baseAttestationDigest: $baseDigest } end) )
    }'
}

write_record() {
  [[ -n "$DIR" ]] || die "write needs --dir"
  [[ -n "$FILE" ]] || die "write needs --file"
  verify_file "$FILE"
  mkdir -p "$DIR"
  local key dest tmp
  key="$(key_from_file "$FILE")"
  dest="$DIR/$key.json"
  tmp="$(mktemp "$DIR/.$key.XXXXXX")"
  if ! jq --arg digest "sha256:$key" '. + {attestationDigest:$digest}' "$FILE" > "$tmp"; then
    rm -f "$tmp"
    die "could not serialize attestation record"
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$dest"
  printf '%s\n' "$dest"
}

case "$CMD" in
  identity) emit_identity ;;
  key)
    [[ -n "$FILE" ]] || die "key needs --file"
    printf '%s\n' "$(key_from_file "$FILE")"
    ;;
  write) write_record ;;
  verify)
    [[ -n "$FILE" ]] || die "verify needs --file"
    verify_file "$FILE"
    printf '%s\n' "$FILE"
    ;;
  require) require_from_dir ;;
  tarball) tarball_from_file ;;
  promote) promote_tarball ;;
  derive) derive_release_tree ;;
  *) die "unknown command: $CMD (try identity|key|write|verify|require|tarball|promote|derive)" ;;
esac
