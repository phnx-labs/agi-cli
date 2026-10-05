#!/usr/bin/env bash
#
# Build agents-cli into ./dist.
#
# Usage: scripts/build.sh [<version>] [--clean] [--skip-tests] [--device <box>] [--here]
#
#   <version>      optional, e.g. 1.15.0 or 1.15.0-alpha.9 -- writes to package.json
#   --clean        wipe ./dist first
#   --skip-tests   skip the test suite
#   --device <box> run the suite on that fleet box instead of a crabbox
#   --here         run the suite on THIS machine (loud; never the default)

set -euo pipefail

cd "$(dirname "$0")/.."

dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m'    "$*"; }

die() { red "  Error: $*"; exit 1; }

CLEAN=false
SKIP_TESTS=false
# Where the suite runs; empty = scripts/test.sh's default (offload to a crabbox).
TEST_TARGET=()
VERSION=""
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta)\.[0-9]+)?$'
# A while/shift loop, not `for arg in "$@"`: the for-loop snapshots the argument list, so `shift`
# cannot consume a flag's value and `$2` is the script's second positional. That worked only while
# every flag was value-less; --device takes one.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=true; shift ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    --device)
      [[ -n "${2:-}" ]] || die "--device needs a machine name"
      TEST_TARGET=(--device "$2"); shift 2 ;;
    --device=*)
      TEST_TARGET=(--device "${1#*=}")
      [[ -n "${TEST_TARGET[1]}" ]] || die "--device needs a machine name"
      shift ;;
    --here) TEST_TARGET=(--here); shift ;;
    -h|--help)
      sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$VERSION" ]] || die "unexpected argument: $1"
      [[ "$1" =~ $SEMVER_RE ]] || die "invalid version '$1' (expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-(alpha|beta).N)"
      VERSION="$1"
      shift ;;
  esac
done

command -v bun >/dev/null || die "bun not found (curl -fsSL https://bun.sh/install | bash)"

if [[ -n "$VERSION" ]]; then
  node -e "const fs=require('fs'),p='./package.json',j=JSON.parse(fs.readFileSync(p));j.version='$VERSION';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
fi

bold "Build"; echo "  $(node -p "require('./package.json').name")@$(node -p "require('./package.json').version")"
echo

if $CLEAN; then
  dim "  Cleaning dist/"
  rm -rf dist
fi

dim "  Installing dependencies"
bun install --silent

dim "  Compiling TypeScript"
bun run build >/dev/null 2>&1

# Bundle the session-tracker SessionStart hook helper into the CLI dist: `agents sync`/`add`
# register hook.sh per harness, which works only if the helper ships in the tarball. Build it
# here; a conditional copy shipped a CLI with the hook disabled on clean checkouts.
ST_ROOT=../packages/session-tracker
[ -d "$ST_ROOT" ] || { echo "error: $ST_ROOT missing — monorepo layout expected" >&2; exit 1; }
dim "  Building session-tracker hook helper"
(cd "$ST_ROOT" && bun install --silent && bun run build >/dev/null)
[ -f "$ST_ROOT/dist/install-hook.js" ] || { echo "error: session-tracker build produced no dist/install-hook.js" >&2; exit 1; }
mkdir -p dist/session-tracker/dist
cp -R "$ST_ROOT/dist/"* dist/session-tracker/dist/
cp "$ST_ROOT/src/hook.sh" dist/session-tracker/dist/hook.sh

# TypeScript emits CLI entrypoints with mode 644, npm pack preserves it, and newer npm does not
# auto-chmod the bin target, giving `zsh: permission denied: agents` via the global shim. Set
# executable bits on every file in `package.json#bin`.
node -e "
  const fs = require('fs');
  const bin = require('./package.json').bin || {};
  for (const target of Object.values(bin)) {
    if (!target) continue;
    try { fs.chmodSync(target, 0o755); }
    catch (err) { console.error('  warn: chmod failed for ' + target + ': ' + err.message); }
  }
"

if $SKIP_TESTS; then
  dim "  Skipping tests (--skip-tests)"
else
  # Offloaded by default (RUSH-3178). scripts/test.sh decides WHERE; build.sh
  # only decides WHETHER. Pass --device <box> / --here through to choose.
  dim "  Running tests (via scripts/test.sh${TEST_TARGET[*]:+ ${TEST_TARGET[*]}})"
  TEST_LOG=$(mktemp)
  # bash 3.2 (what macOS ships, and the producer MUST run on a Mac when a helper
  # input changed) treats "${arr[@]}" on an EMPTY array as an unbound variable
  # under `set -u`. The ${arr[@]+"${arr[@]}"} guard is the portable form.
  if ! scripts/test.sh ${TEST_TARGET[@]+"${TEST_TARGET[@]}"} >"$TEST_LOG" 2>&1; then
    echo
    red "  Tests failed"
    cat "$TEST_LOG" >&2
    rm -f "$TEST_LOG"
    exit 1
  fi
  TEST_SUMMARY=$(grep -E '^\s*[0-9]+ (pass|fail|skip)' "$TEST_LOG" | tail -3 | tr '\n' ' ' | sed 's/  */ /g')
  rm -f "$TEST_LOG"
  [[ -n "$TEST_SUMMARY" ]] && dim "    $TEST_SUMMARY"
fi

OUT_BYTES=$(find dist -type f \( -name '*.js' -o -name '*.d.ts' \) -exec wc -c {} + | tail -1 | awk '{print $1}')
OUT_KB=$(( OUT_BYTES / 1024 ))
OUT_FILES=$(find dist -type f \( -name '*.js' -o -name '*.d.ts' \) | wc -l | tr -d ' ')

echo
green "  Ready"
dim   "  $OUT_FILES files, ${OUT_KB} KB in dist/"
