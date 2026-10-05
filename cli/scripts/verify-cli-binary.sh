#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

BIN="dist/bin/agents"
PIN="scripts/agents-cli-bin.sha256"

[ -f "$BIN" ] || { echo "missing $BIN - run scripts/sign-cli-binary.sh (macOS) or scripts/remote-sign-mac.sh, then 'bun run build'" >&2; exit 1; }
[ -f "$PIN" ] || { echo "missing $PIN - scripts/sign-cli-binary.sh writes it alongside the signed binary" >&2; exit 1; }

expected="$(cut -d ' ' -f 1 "$PIN")"

if command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$BIN" | cut -d ' ' -f 1)"
else
  actual="$(sha256sum "$BIN" | cut -d ' ' -f 1)"
fi

if [ "$actual" != "$expected" ]; then
  echo "dist/bin/agents SHA256 mismatch" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi

version="$(node -p "require('./package.json').version")"
if ! LC_ALL=C grep -aqF "VERSION = \"$version\"" "$BIN"; then
  echo "dist/bin/agents does not embed version $version - stale binary; re-run scripts/sign-cli-binary.sh" >&2
  exit 1
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --verify --strict "$BIN" || { echo "codesign --verify failed for $BIN" >&2; exit 1; }
  signature_info="$(codesign -dvv "$BIN" 2>&1)"
  if ! grep -q "^Authority=Developer ID Application" <<<"$signature_info"; then
    echo "dist/bin/agents is not Developer ID signed" >&2
    exit 1
  fi
fi
