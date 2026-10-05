#!/usr/bin/env bash
# One-shot: create the npmjs.com secrets bundle and cut the release. Workaround: the bundled
# keychain helper fails writes with OSStatus -34018 (macOS 26.4) while reads still work, so write
# the items directly via `security` in the schema agents-cli expects.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-1.20.6}"
BUNDLE_NAME="npmjs.com"
META_SERVICE="agents-cli.bundles.${BUNDLE_NAME}"
SECRET_SERVICE="agents-cli.secrets.${BUNDLE_NAME}.NPM_TOKEN"
ACCOUNT="$(whoami)"

# 1. Prompt for token if not already present in keychain.
if security find-generic-password -s "$SECRET_SERVICE" -a "$ACCOUNT" -w >/dev/null 2>&1; then
  echo "NPM_TOKEN already in keychain (service: $SECRET_SERVICE) — reusing."
else
  echo
  echo "Paste your npm publish token (Automation type from"
  echo "  https://www.npmjs.com/settings/<your-user>/tokens )"
  echo "Input is hidden:"
  echo
  read -rs NPM_TOKEN
  echo
  [[ -n "$NPM_TOKEN" ]] || { echo "error: empty token, aborting"; exit 1; }
  # Replace any existing entry, then add fresh.
  security delete-generic-password -s "$SECRET_SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
  security add-generic-password -s "$SECRET_SERVICE" -a "$ACCOUNT" -w "$NPM_TOKEN"
  unset NPM_TOKEN
fi

# 2. Write the bundle metadata (idempotent — overwrite each run).
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
META_JSON=$(cat <<JSON
{"created_at":"${NOW}","updated_at":"${NOW}","description":"npm publish token for @phnx-labs/agents-cli","vars":{"NPM_TOKEN":"keychain:NPM_TOKEN"},"meta":{"NPM_TOKEN":{"type":"api-key"}}}
JSON
)
security delete-generic-password -s "$META_SERVICE" -a "$ACCOUNT" >/dev/null 2>&1 || true
security add-generic-password -s "$META_SERVICE" -a "$ACCOUNT" -w "$META_JSON"

echo
echo "Bundle written. Verifying agents-cli can read it..."
if ! agents secrets list | grep -q "^${BUNDLE_NAME} "; then
  echo "error: 'agents secrets list' does not see the bundle. Aborting before release."
  exit 1
fi
echo "  ✓ agents secrets list shows: ${BUNDLE_NAME}"

# 3. Cut the release.
echo
echo "Cutting release ${VERSION}..."
echo
scripts/release.sh "$VERSION" --apply
