#!/usr/bin/env bash
# Build the agents-cli standalone Bun executable into ./dist/bin/agents. Cross-compile by setting
# BUN_COMPILE_TARGET (bun-<os>-<arch>) when running scripts/build-bin.sh.

set -euo pipefail

cd "$(dirname "$0")/.."

command -v bun >/dev/null || { echo "bun not found" >&2; exit 1; }
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

OUT_DIR="dist/bin"
OUT="$OUT_DIR/agents"
BUILD_DIR="$OUT_DIR/.compile-src"
VERSION="$(node -p "require('./package.json').version")"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT

cp -R src "$BUILD_DIR/src"

BUILD_DIR="$BUILD_DIR" VERSION="$VERSION" node <<'NODE'
const fs = require('fs');
const path = require('path');

const buildDir = process.env.BUILD_DIR;
const version = process.env.VERSION;
if (!buildDir || !version) throw new Error('BUILD_DIR and VERSION are required');

const bootstrapPath = path.join(buildDir, 'src', 'bootstrap.ts');
let bootstrap = fs.readFileSync(bootstrapPath, 'utf8');
const versionBlock = [
  "const packageJsonPath = path.join(__dirname, '..', 'package.json');",
  "const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));",
  "const VERSION = packageJson.version;",
].join('\n');
if (!bootstrap.includes(versionBlock)) {
  throw new Error('src/bootstrap.ts version block changed; update scripts/build-bin.sh');
}
bootstrap = bootstrap.replace(versionBlock, `const VERSION = ${JSON.stringify(version)};`);
fs.writeFileSync(bootstrapPath, bootstrap);

NODE

args=(bun build "$BUILD_DIR/src/index.ts" --compile --outfile "$OUT")
if [[ -n "${BUN_COMPILE_TARGET:-}" ]]; then
  args+=(--target="$BUN_COMPILE_TARGET")
fi

"${args[@]}"
chmod 755 "$OUT"
