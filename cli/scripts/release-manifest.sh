#!/usr/bin/env bash
#
# Immutable helper mapping for an agents-cli release (RUSH-2666).
#
# Ordinary release reuses already-signed helper artifacts keyed by a digest of
# their complete inputs. Missing or changed inputs fail closed. Rebuild and
# notarization live outside this path.
#
# Usage:
#   release-manifest.sh new --cli-version VER --cli-tree TREE
#   release-manifest.sh input-digest --repo-root DIR --helper NAME
#   release-manifest.sh put --file MANIFEST.json --helper NAME --input-digest D \
#                           --asset-digest D --helper-version VER [--asset-url U]
#                           [--asset-path P] [--signer-team T] [--arch A] [--platform P]
#   release-manifest.sh verify --file MANIFEST.json
#   release-manifest.sh resolve --file MANIFEST.json --helper NAME
#   release-manifest.sh reuse --file MANIFEST.json --helper NAME --input-digest D
#   release-manifest.sh require --file MANIFEST.json --repo-root DIR [--helper NAME]
#   release-manifest.sh copy-asset --file MANIFEST.json --helper NAME --asset-path DESTDIR
#
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

file_sha256() {
  local f="$1"
  [[ -f "$f" ]] || die "not a file: $f"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    shasum -a 256 "$f" | awk '{print $1}'
  fi
}

str_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \?//'
  exit 2
}

KNOWN_HELPERS="computer-mac menubar"

CMD="${1:-}"
[[ -n "$CMD" ]] || usage
shift

REPO_ROOT=""
FILE=""
HELPER=""
CLI_VERSION=""
CLI_TREE=""
INPUT_DIGEST=""
ASSET_DIGEST=""
HELPER_VERSION=""
ASSET_URL=""
ASSET_PATH=""
SIGNER_TEAM="2HTP252L87"
ARCH="universal"
PLATFORM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    --helper) HELPER="$2"; shift 2 ;;
    --cli-version) CLI_VERSION="$2"; shift 2 ;;
    --cli-tree) CLI_TREE="$2"; shift 2 ;;
    --input-digest) INPUT_DIGEST="$2"; shift 2 ;;
    --asset-digest) ASSET_DIGEST="$2"; shift 2 ;;
    --helper-version) HELPER_VERSION="$2"; shift 2 ;;
    --asset-url) ASSET_URL="$2"; shift 2 ;;
    --asset-path) ASSET_PATH="$2"; shift 2 ;;
    --signer-team) SIGNER_TEAM="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
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

assert_helper() {
  case " $KNOWN_HELPERS " in
    *" $1 "*) ;;
    *) die "unknown helper '$1' (want: $KNOWN_HELPERS)" ;;
  esac
}

helper_paths() {
  local root="$1" name="$2"
  case "$name" in
    computer-mac)
      printf '%s\n' \
        "$root/native/computer-mac/Sources" \
        "$root/native/computer-mac/scripts/build.sh" \
        "$root/native/computer-mac/Package.swift"
      ;;
    menubar)
      printf '%s\n' \
        "$root/cli/menubar/Sources" \
        "$root/cli/menubar/scripts/build.sh" \
        "$root/cli/menubar/Package.swift"
      ;;
  esac
}

# Hashes $path (a file or a directory tree) with each entry keyed by its path
# RELATIVE to $root, never the absolute path. input_digest_of's digest is
# recorded once (by the producer) and re-verified elsewhere (require_helpers,
# on a different machine or a differently-pid-suffixed worktree) -- an
# absolute path bakes in that machine/worktree's on-disk location, so the
# recorded digest can never match a re-derivation anywhere else (RUSH-2766).
hash_tree() {
  local root="$1" path="$2" out="" f rel
  if [[ -f "$path" ]]; then
    rel="${path#"$root"/}"
    printf '%s  %s\n' "$(file_sha256 "$path")" "$rel"
    return 0
  fi
  [[ -d "$path" ]] || die "helper input missing: $path -- no fallback rebuild"
  while IFS= read -r -d '' f; do
    rel="${f#"$root"/}"
    out+="$(file_sha256 "$f")  $rel"$'\n'
  done < <(find "$path" -type f -print0 | sort -z)
  printf '%s' "$out"
}

input_digest_of() {
  local root name concat p
  root="$(resolve_repo_root)"
  name="$1"
  assert_helper "$name"
  concat=""
  while IFS= read -r p; do
    concat+="$(hash_tree "$root" "$p")"
  done < <(helper_paths "$root" "$name")
  printf 'sha256:%s\n' "$(str_sha256 "$concat")"
}

new_manifest() {
  [[ -n "$CLI_VERSION" ]] || die "new needs --cli-version"
  [[ -n "$CLI_TREE" ]] || die "new needs --cli-tree"
  jq -nc --arg v "$CLI_VERSION" --arg tree "$CLI_TREE" \
    '{schemaVersion:1, cliVersion:$v, cliTree:$tree, helpers:{}}'
}

verify_manifest() {
  local f="$1"
  [[ -f "$f" ]] || die "release manifest not found: $f"
  jq -e '.schemaVersion == 1
      and (.cliVersion | type == "string" and length > 0)
      and (.cliTree | type == "string" and length > 0)
      and (.helpers | type == "object")' "$f" >/dev/null \
    || die "release manifest $f is incomplete"
}

verify_helper_record() {
  local rec="$1" name="$2"
  jq -e --arg n "$name" '
      (.helperVersion | type == "string" and length > 0)
      and (.inputDigest | type == "string" and startswith("sha256:"))
      and (.assetDigest | type == "string" and startswith("sha256:"))
      and (.platform | type == "string" and length > 0)
    ' <<<"$rec" >/dev/null \
    || die "helper $name record is incomplete -- no fallback rebuild"
}

put_helper() {
  [[ -n "$FILE" ]] || die "put needs --file"
  [[ -n "$HELPER" ]] || die "put needs --helper"
  assert_helper "$HELPER"
  verify_manifest "$FILE"
  [[ -n "$INPUT_DIGEST" && "$INPUT_DIGEST" == sha256:* ]] || die "put needs --input-digest sha256:..."
  [[ -n "$ASSET_DIGEST" && "$ASSET_DIGEST" == sha256:* ]] || die "put needs --asset-digest sha256:..."
  [[ -n "$HELPER_VERSION" ]] || die "put needs --helper-version"
  if [[ -n "$ASSET_PATH" ]]; then
    [[ -f "$ASSET_PATH" ]] || die "helper asset not found: $ASSET_PATH -- no fallback rebuild"
    local got
    got="sha256:$(file_sha256 "$ASSET_PATH")"
    [[ "$got" == "$ASSET_DIGEST" ]] \
      || die "asset digest $got != declared $ASSET_DIGEST -- refusing to record the wrong bytes"
  fi
  local plat
  plat="${PLATFORM:-darwin}"
  local tmp
  tmp="$(mktemp)"
  jq --arg n "$HELPER" \
     --arg hv "$HELPER_VERSION" \
     --arg id "$INPUT_DIGEST" \
     --arg ad "$ASSET_DIGEST" \
     --arg url "$ASSET_URL" \
     --arg path "$ASSET_PATH" \
     --arg team "$SIGNER_TEAM" \
     --arg arch "$ARCH" \
     --arg plat "$plat" \
     '.helpers[$n] = {
        helperVersion: $hv,
        inputDigest: $id,
        assetDigest: $ad,
        assetUrl: $url,
        assetPath: $path,
        signerTeam: $team,
        architecture: $arch,
        platform: $plat
      }' "$FILE" > "$tmp"
  mv "$tmp" "$FILE"
  printf '%s\n' "$FILE"
}

resolve_helper() {
  [[ -n "$FILE" ]] || die "resolve needs --file"
  [[ -n "$HELPER" ]] || die "resolve needs --helper"
  assert_helper "$HELPER"
  verify_manifest "$FILE"
  local rec
  rec="$(jq -c --arg n "$HELPER" '.helpers[$n] // empty' "$FILE")"
  [[ -n "$rec" ]] || die "missing helper $HELPER in $FILE -- no fallback rebuild"
  verify_helper_record "$rec" "$HELPER"
  printf '%s\n' "$rec"
}

reuse_helper() {
  [[ -n "$INPUT_DIGEST" ]] || die "reuse needs --input-digest"
  local rec current
  rec="$(resolve_helper)"
  current="$(jq -r '.inputDigest' <<<"$rec")"
  if [[ "$current" != "$INPUT_DIGEST" ]]; then
    die "helper $HELPER input digest changed ($current != $INPUT_DIGEST) -- rebuild/notarization is outside the ordinary release path"
  fi
  printf '%s\n' "$rec"
}

require_helpers() {
  [[ -n "$FILE" ]] || die "require needs --file"
  verify_manifest "$FILE"
  local names name current expected
  if [[ -n "$HELPER" ]]; then
    names="$HELPER"
  else
    names="$KNOWN_HELPERS"
  fi
  for name in $names; do
    HELPER="$name"
    resolve_helper >/dev/null
    expected="$(input_digest_of "$name")"
    current="$(jq -r --arg n "$name" '.helpers[$n].inputDigest' "$FILE")"
    if [[ "$current" != "$expected" ]]; then
      die "helper $name input digest changed ($current != $expected) -- rebuild/notarization is outside the ordinary release path"
    fi
  done
  printf '%s\n' "$FILE"
}

# Copy verified helper bytes into DEST without rebuilding. Used to keep the
# per-CLI-version ComputerHelper.app.zip on v<new> while the downloader still
# resolves that URL (N/N+1).
copy_asset() {
  [[ -n "$FILE" ]] || die "copy-asset needs --file"
  [[ -n "$HELPER" ]] || die "copy-asset needs --helper"
  [[ -n "$ASSET_PATH" ]] || die "copy-asset needs --asset-path (destination directory)"
  local rec digest src dest name
  rec="$(resolve_helper)"
  digest="$(jq -r '.assetDigest' <<<"$rec")"
  src="$(jq -r '.assetPath // empty' <<<"$rec")"
  name="$(jq -r --arg n "$HELPER" '
      if $n == "computer-mac" then "ComputerHelper.app.zip"
      elif $n == "menubar" then "MenubarHelper.app"
      else $n end' <<<"$rec")"
  if [[ -z "$src" || ! -f "$src" ]]; then
    die "helper $HELPER asset is not on disk -- no fallback rebuild"
  fi
  local got
  got="sha256:$(file_sha256 "$src")"
  [[ "$got" == "$digest" ]] || die "helper $HELPER asset digest $got != $digest -- refusing to attach the wrong bytes"
  mkdir -p "$ASSET_PATH"
  dest="$ASSET_PATH/$name"
  cp -a "$src" "$dest"
  if [[ -f "$src.sha256" ]]; then
    cp -a "$src.sha256" "$dest.sha256"
  else
    printf '%s  %s\n' "${digest#sha256:}" "$name" > "$dest.sha256"
  fi
  printf '%s\n' "$dest"
}

case "$CMD" in
  new) new_manifest ;;
  input-digest)
    [[ -n "$HELPER" ]] || die "input-digest needs --helper"
    input_digest_of "$HELPER"
    ;;
  put) put_helper ;;
  verify)
    [[ -n "$FILE" ]] || die "verify needs --file"
    verify_manifest "$FILE"
    printf '%s\n' "$FILE"
    ;;
  resolve) resolve_helper ;;
  reuse) reuse_helper ;;
  require) require_helpers ;;
  copy-asset) copy_asset ;;
  *) die "unknown command: $CMD" ;;
esac
