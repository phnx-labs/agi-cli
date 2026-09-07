#!/usr/bin/env bash
# prepack gate: refuse to pack unless dist/bin/agents is exactly the signed +
# notarized binary that scripts/sign-cli-binary.sh produced (issue #315).
# Mirrors scripts/verify-menubar-helper.sh, plus two checks that helper does
# not need:
#   - the embedded version must match package.json - the binary is rebuilt
#     every release, and a stale binary+pin pair from an earlier release
#     matches its own sha, so the sha alone cannot catch it;
#   - codesign --verify + a Developer ID authority check, macOS only. A Linux
#     release box cannot run codesign; there the sha pin (produced by the
#     macOS sign run and pulled back by scripts/remote-sign-mac.sh) still
#     guarantees bit-identical content.
set -euo pipefail

cd "$(dirname "$0")/.."

BIN="dist/bin/agents"
PIN="scripts/agents-cli-bin.sha256"

[ -f "$BIN" ] || { echo "missing $BIN - run scripts/sign-cli-binary.sh (macOS) or scripts/remote-sign-mac.sh, then 'bun run build'" >&2; exit 1; }
[ -f "$PIN" ] || { echo "missing $PIN - scripts/sign-cli-binary.sh writes it alongside the signed binary" >&2; exit 1; }

expected="$(cut -d ' ' -f 1 "$PIN")"

# Portable sha256: macOS ships `shasum`, Linux ships `sha256sum`.
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

# scripts/build-bin.sh bakes the version in as `const VERSION = "<v>";` and
# bun's bundler carries it into the binary as `var VERSION = "<v>";` (no
# minification here) — or, when it merges adjacent declarations, as
# `var VERSION = "<v>", NEXT_CONST = …;` (observed with bun 1.3.14 once the
# RUSH-2335 bootstrap split put another const right after VERSION). Grep only
# up to the closing quote so declaration merging can't false-fail the gate;
# the quoted version is already an exact match. -a because grep otherwise
# refuses to match inside a binary. Runs even where the Mach-O cannot execute
# (Linux release box).
version="$(node -p "require('./package.json').version")"
if ! LC_ALL=C grep -aqF "VERSION = \"$version\"" "$BIN"; then
  echo "dist/bin/agents does not embed version $version - stale binary; re-run scripts/sign-cli-binary.sh" >&2
  exit 1
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --verify --strict "$BIN" || { echo "codesign --verify failed for $BIN" >&2; exit 1; }
  # Capture, then grep: piping codesign straight into `grep -q` under pipefail
  # fails spuriously (grep exits at first match, codesign dies with SIGPIPE).
  signature_info="$(codesign -dvv "$BIN" 2>&1)"
  if ! grep -q "^Authority=Developer ID Application" <<<"$signature_info"; then
    echo "dist/bin/agents is not Developer ID signed" >&2
    exit 1
  fi
fi
