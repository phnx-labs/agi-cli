#!/usr/bin/env bash
#
# Stage the PUBLISHED AGI Menu helper into bin/MenubarHelper.app (PHNX-4036).
#
# The helper's source lives in the private repo phnx-labs/agi-menu; this repo
# never builds it. agi-menu's scripts/release.sh publishes the signed +
# notarized bundle as release assets on the helper's own tag in the PUBLIC
# agi-cli repo:
#
#   https://github.com/phnx-labs/agi-cli/releases/download/menubar/v<floor>/
#     MenubarHelper.app.zip          the bundle (`ditto -c -k --keepParent`)
#     MenubarHelper.app.zip.sha256   `<hex>  MenubarHelper.app.zip`
#     menubar-source.txt             provenance: repo=/commit=/tag=/version=
#                                    (absent on releases cut before the split)
#
# <floor> is the `menubar` entry in src/lib/helper-versions.ts -- the exact
# address `src/lib/menubar/download-menubar.ts` resolves on a user's machine, so
# what this script stages is byte-for-byte what `agents menubar enable` installs.
#
# Steps: resolve the floor -> download the zip + .sha256 (+ the sidecar when the
# release has one) -> verify the sha256 -> extract into bin/MenubarHelper.app ->
# verify the signature (`codesign --verify --deep --strict`, `spctl --assess`)
# and the bundle gate (scripts/verify-menubar-helper.sh: designated-requirement
# pin, universal binary, stapled ticket). Every failure is fatal: a missing asset,
# a sha mismatch, or a bundle Gatekeeper rejects stops here -- there is no
# fallback build, because there is no source to build from.
#
# Extraction + signature verification need macOS. Elsewhere the script refuses
# unless --fetch-only is given, which downloads and sha-verifies the asset and
# stops (what release-attestation-produce.sh uses to record the helper manifest
# on any box).
#
# Usage:
#   scripts/stage-menubar-helper.sh [--fetch-only] [--download-dir DIR]
#                                   [--base-url URL] [--json]
#   scripts/stage-menubar-helper.sh --print-floor
#
# --fetch-only     download + verify the sha256; do not extract or codesign-verify.
# --download-dir   where the assets land (default: bin/.menubar-helper-dl).
# --base-url       the directory the assets are read from (default: the public
#                  release address above). A mirror or an offline copy; the
#                  default is the only address an installed CLI ever uses.
# --json           print one JSON object describing the staged asset instead of
#                  prose: {helper, floor, tag, assetUrl, zip, sha256, source, app}.
# --print-floor    print the resolved floor and exit (nothing is downloaded).
set -euo pipefail

cd "$(dirname "$0")/.."

die() { printf 'stage-menubar-helper: error: %s\n' "$*" >&2; exit 1; }
log() { [[ "$JSON" == true ]] || printf 'stage-menubar-helper: %s\n' "$*" >&2; }

HELPER_RELEASE_REPO="phnx-labs/agi-cli"
ASSET_NAME="MenubarHelper.app.zip"
SOURCE_NAME="menubar-source.txt"
APP_NAME="MenubarHelper.app"
DEST="bin/$APP_NAME"

FETCH_ONLY=false
DOWNLOAD_DIR="bin/.menubar-helper-dl"
BASE_URL=""
JSON=false
PRINT_FLOOR=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fetch-only) FETCH_ONLY=true; shift ;;
    --download-dir) [[ -n "${2:-}" ]] || die "--download-dir needs a directory"; DOWNLOAD_DIR="$2"; shift 2 ;;
    --base-url) [[ -n "${2:-}" ]] || die "--base-url needs a URL"; BASE_URL="${2%/}"; shift 2 ;;
    --json) JSON=true; shift ;;
    --print-floor) PRINT_FLOOR=true; shift ;;
    -h|--help)
      awk 'NR>2 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

# The floor is the CLI's own resolution, read from the module the installed CLI
# reads -- the same `bun -e` the attestation producer uses for computer-mac. Not
# a regex over the TS source: a second parser of that table is a second place
# for the answer to drift.
command -v bun >/dev/null 2>&1 || die "bun not found on PATH (needed to read the menubar floor from src/lib/helper-versions.ts)"
[[ -f src/lib/helper-versions.ts ]] || die "src/lib/helper-versions.ts not found under $(pwd)"
FLOOR="$(bun -e "console.log((await import('./src/lib/helper-versions.ts')).helperFloor('menubar'))" 2>/dev/null)" \
  || die "could not read the menubar floor from src/lib/helper-versions.ts"
[[ "$FLOOR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "menubar floor is not X.Y.Z: '$FLOOR'"
if [[ "$PRINT_FLOOR" == true ]]; then
  printf '%s\n' "$FLOOR"
  exit 0
fi

TAG="menubar/v$FLOOR"
[[ -n "$BASE_URL" ]] || BASE_URL="https://github.com/$HELPER_RELEASE_REPO/releases/download/$TAG"
ZIP_URL="$BASE_URL/$ASSET_NAME"
SHA_URL="$BASE_URL/$ASSET_NAME.sha256"
SOURCE_URL="$BASE_URL/$SOURCE_NAME"

# Refuse BEFORE downloading: an extracted bundle is only ever staged with its
# signature verified, and codesign/spctl exist only on macOS.
if [[ "$FETCH_ONLY" != true && "$(uname -s)" != "Darwin" ]]; then
  die "staging $DEST needs macOS (codesign + spctl verify the published signature); pass --fetch-only to download and sha256-verify $ASSET_NAME only"
fi
command -v curl >/dev/null 2>&1 || die "curl not found on PATH"
command -v jq >/dev/null 2>&1 || die "jq not found on PATH"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# fetch URL OUT -> prints the HTTP status. OUT exists only on 200. A transport
# failure (no network, DNS, TLS, a transfer stalled under 1 KiB/s for 60s)
# returns non-zero and prints curl's own message -- bounded, so a half-dead
# connection fails loud instead of hanging a release.
fetch() {
  local url="$1" out="$2" code
  rm -f "$out"
  if ! code="$(curl -sSL --retry 3 --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
                    -o "$out" -w '%{http_code}' "$url")"; then
    rm -f "$out"
    return 1
  fi
  [[ "$code" == "200" ]] || rm -f "$out"
  printf '%s\n' "$code"
}

mkdir -p "$DOWNLOAD_DIR"
DOWNLOAD_DIR="$(cd "$DOWNLOAD_DIR" && pwd)"
ZIP="$DOWNLOAD_DIR/$ASSET_NAME"
SHA_FILE="$ZIP.sha256"
SOURCE_FILE="$DOWNLOAD_DIR/$SOURCE_NAME"

# The checksum first: it is tiny and 404s fast when the tag has no assets.
log "fetching $TAG from $BASE_URL"
code="$(fetch "$SHA_URL" "$SHA_FILE")" || die "could not download $SHA_URL (network, DNS, or a mirror that is down)"
[[ "$code" == "200" ]] \
  || die "no $ASSET_NAME.sha256 on release $TAG (HTTP $code on $SHA_URL). Publish the helper from phnx-labs/agi-menu ('agents secrets exec apple.com -- scripts/release.sh $FLOOR' there) or point the menubar floor in src/lib/helper-versions.ts at a published release"
WANT_SHA="$(awk 'NR==1 {print $1}' "$SHA_FILE")"
[[ "$WANT_SHA" =~ ^[0-9a-f]{64}$ ]] || die "malformed $ASSET_NAME.sha256 on $TAG: '$(head -c 120 "$SHA_FILE")'"

code="$(fetch "$ZIP_URL" "$ZIP")" || die "could not download $ZIP_URL (network, DNS, or a mirror that is down)"
[[ "$code" == "200" ]] \
  || die "no $ASSET_NAME on release $TAG (HTTP $code on $ZIP_URL) -- the .sha256 is published but the bundle is not; re-run agi-menu's scripts/release.sh $FLOOR to upload it"
GOT_SHA="$(sha256_of "$ZIP")"
[[ "$GOT_SHA" == "$WANT_SHA" ]] \
  || die "sha256 mismatch for $ZIP_URL: published $WANT_SHA, downloaded $GOT_SHA -- refusing to stage the wrong bytes"

# Provenance is optional only because releases cut before agi-menu's release.sh
# (menubar/v1.0.0, v1.1.0) predate the sidecar. Any status but 200/404 is an
# error: a rate-limited or half-down mirror must not read as "no provenance".
SOURCE_JSON="null"
code="$(fetch "$SOURCE_URL" "$SOURCE_FILE")" || die "could not download $SOURCE_URL (network, DNS, or a mirror that is down)"
case "$code" in
  200)
    SOURCE_JSON="$(jq -Rn '[inputs | select(length > 0) | capture("^(?<key>[^=]+)=(?<value>.*)$")] | from_entries' "$SOURCE_FILE")" \
      || die "malformed $SOURCE_NAME on $TAG (want key=value lines)"
    ;;
  404) ;;
  *) die "unexpected HTTP $code fetching $SOURCE_URL" ;;
esac

APP_PATH=""
if [[ "$FETCH_ONLY" != true ]]; then
  EXTRACT="$(mktemp -d "${TMPDIR:-/tmp}/menubar-stage.XXXXXX")"
  trap 'rm -rf "$EXTRACT"' EXIT
  ditto -x -k "$ZIP" "$EXTRACT" || die "could not extract $ZIP"
  [[ -d "$EXTRACT/$APP_NAME" ]] || die "$ASSET_NAME on $TAG does not contain $APP_NAME at its top level"
  # rm -rf first so a re-run does not nest the new .app INSIDE a stale bundle
  # (cp/mv into an existing dir), which corrupts the signature ("unsealed
  # contents present in the bundle root").
  mkdir -p bin
  rm -rf "$DEST"
  mv "$EXTRACT/$APP_NAME" "$DEST"
  codesign --verify --deep --strict "$DEST" \
    || die "$DEST failed codesign --verify --deep --strict -- the published $TAG bundle is not a valid signed bundle"
  spctl --assess --type execute "$DEST" \
    || die "$DEST is rejected by Gatekeeper (not notarized) -- the published $TAG bundle cannot ship"
  scripts/verify-menubar-helper.sh >/dev/null \
    || die "$DEST failed scripts/verify-menubar-helper.sh (designated-requirement pin / universal binary / stapled ticket)"
  APP_PATH="$(pwd)/$DEST"
fi

if [[ "$JSON" == true ]]; then
  jq -nc \
    --arg floor "$FLOOR" --arg tag "$TAG" --arg url "$ZIP_URL" \
    --arg zip "$ZIP" --arg sha "$GOT_SHA" --arg app "$APP_PATH" \
    --argjson source "$SOURCE_JSON" \
    '{helper: "menubar", floor: $floor, tag: $tag, assetUrl: $url, zip: $zip, sha256: $sha,
      source: $source, app: (if $app == "" then null else $app end)}'
else
  if [[ "$SOURCE_JSON" == "null" ]]; then
    log "$TAG: $ASSET_NAME sha256 $GOT_SHA (no $SOURCE_NAME on this release)"
  else
    log "$TAG: $ASSET_NAME sha256 $GOT_SHA (built from $(jq -r '"\(.repo)@\(.commit)"' <<<"$SOURCE_JSON"))"
  fi
  if [[ -n "$APP_PATH" ]]; then
    log "staged, signed, notarized: $DEST"
  else
    log "fetched only: $ZIP"
  fi
fi
