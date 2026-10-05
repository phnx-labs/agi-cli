#!/usr/bin/env bash
# Build, sign, and notarize the standalone macOS `agents` binary (issue #315). The npm
# node-shebang entrypoint is unsignable and gets flagged by CrowdStrike Falcon, so we ship a
# Developer-ID-signed, notarized Mach-O built with `bun build --compile`.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${APPLE_ID:?APPLE_ID not set}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"

[[ "$(uname)" == "Darwin" ]] || { echo "sign-cli-binary.sh must run on macOS (codesign/notarytool); use scripts/remote-sign-mac.sh from other hosts" >&2; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "sign-cli-binary.sh builds the arm64 slice on an arm64 host (see header for why the binary is not universal)" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

SIGN_IDENTITY="Developer ID Application: Muqit Nawaz ($APPLE_TEAM_ID)"
ENTITLEMENTS="scripts/bun-jit-entitlements.plist"
BIN="dist/bin/agents"
STAGED="bin/agents-macos"
PIN="scripts/agents-cli-bin.sha256"

echo "Building standalone binary (bun build --compile, arm64)..."
scripts/build-bin.sh

echo "Signing (Developer ID, hardened runtime + JIT entitlement)..."
codesign \
  --sign "$SIGN_IDENTITY" \
  --identifier com.phnx-labs.agents-cli \
  --options runtime \
  --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --force \
  "$BIN"

echo "Verifying signature..."
codesign --verify --strict --verbose=2 "$BIN"

# Run the signed binary: catches a missing JIT entitlement (the binary signs
# fine but dies on startup) and a version drift between build and package.json.
echo "Smoke-running the signed binary..."
VERSION="$(node -p "require('./package.json').version")"
GOT="$("$BIN" --version)"
[[ "$GOT" == "$VERSION" ]] || { echo "signed binary reports '$GOT' but package.json says '$VERSION'" >&2; exit 1; }

echo "Packaging for notarization..."
ZIP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-notarize.XXXXXX")"
trap 'rm -rf "$ZIP_DIR"' EXIT
ditto -c -k "$BIN" "$ZIP_DIR/agents-cli-bin.zip"

echo "Submitting for notarization (~1 min)..."
NOTARY_LOG="$ZIP_DIR/notary.log"
xcrun notarytool submit "$ZIP_DIR/agents-cli-bin.zip" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait | tee "$NOTARY_LOG"
grep -q "status: Accepted" "$NOTARY_LOG" || { echo "notarization did not report 'status: Accepted'" >&2; exit 1; }

# No stapling: stapler cannot staple bare Mach-Os (it needs a bundle/dmg/pkg).
# Gatekeeper and EDR fetch the ticket online from the signature's cdhash.

echo "Staging for packaging + pinning sha256..."
mkdir -p bin
cp -f "$BIN" "$STAGED"
chmod 755 "$STAGED"
shasum -a 256 "$BIN" > "$PIN"
cat "$PIN"

echo
echo "Done. $BIN is signed + notarized; 'bun run build' packages $STAGED into dist/."
