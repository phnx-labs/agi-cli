#!/usr/bin/env bash
# prepack gate: refuse to pack unless dist/bin/agents is exactly the signed, notarized binary
# scripts/sign-cli-binary.sh produced (issue #315). The embedded version must match package.json
# (a stale binary+pin pair matches its own sha); codesign --verify on macOS, the sha pin on Linux.
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

# build-bin.sh bakes the version as `const VERSION = "<v>";` and bun carries it into the binary as
# `var VERSION = "<v>"`, possibly merged with the next const (bun 1.3.14, RUSH-2335). Grep only up
# to the closing quote so merging cannot false-fail. -a because grep refuses binaries.
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
