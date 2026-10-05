#!/usr/bin/env bash
set -euo pipefail

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"

[[ $# -ge 1 ]] || die "usage: release-install-smoke.sh <tarball.tgz> [expected-version]"
TGZ="$1"
EXPECT_VER="${2:-}"
[[ -f "$TGZ" ]] || die "tarball not found: $TGZ"

command -v npm >/dev/null || die "npm not on PATH"
command -v node >/dev/null || die "node not on PATH"

PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/agents-cli-install-smoke.XXXXXX")"
cleanup() { rm -rf "$PREFIX"; }
trap cleanup EXIT

npm install --prefix "$PREFIX" --ignore-scripts "$TGZ" >/dev/null \
  || die "npm install failed for $TGZ"

PKG_DIR="$(find "$PREFIX/node_modules" -mindepth 2 -maxdepth 2 -type d -name 'agents-cli' | head -1)"
[[ -n "$PKG_DIR" && -d "$PKG_DIR" ]] || die "installed package directory missing under $PREFIX"

BIN=""
if [[ -x "$PREFIX/node_modules/.bin/agents" ]]; then
  BIN="$PREFIX/node_modules/.bin/agents"
elif [[ -f "$PKG_DIR/dist/index.js" ]]; then
  BIN=(node "$PKG_DIR/dist/index.js")
elif [[ -f "$PKG_DIR/package.json" ]]; then
  MAIN="$(node -e "const p=require('$PKG_DIR/package.json'); process.stdout.write(p.bin?.agents || p.main || '')")"
  [[ -n "$MAIN" ]] || die "installed package has no bin/main"
  BIN=(node "$PKG_DIR/$MAIN")
else
  die "could not locate an installed agents entrypoint in $PKG_DIR"
fi

OUT="$("${BIN[@]}" --version 2>&1)" || die "installed binary --version failed: $OUT"
if [[ -n "$EXPECT_VER" ]]; then
  printf '%s\n' "$OUT" | grep -Fq "$EXPECT_VER" \
    || die "installed --version did not contain $EXPECT_VER (got: $OUT)"
fi
printf '%s\n' "$OUT"
