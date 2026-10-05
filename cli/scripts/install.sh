#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

dim()    { printf '\033[2m%s\033[0m\n'  "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
bold()   { printf '\033[1m%s\033[0m'    "$*"; }

die() { red "  Error: $*"; exit 1; }

SKIP_BUILD=false
SKIP_TESTS=false
BOUNCE_DAEMON=false
PREFIX="$HOME/.local/agents-cli-dev"
LINK_DIR="$HOME/.local/bin"

DEV_BINS=(agents ag)
DEV_SUFFIX="-dev"

PRODUCTION_BINS=(agents ag browser)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    --bounce-daemon) BOUNCE_DAEMON=true; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

command -v npm >/dev/null || die "npm not found"
command -v node >/dev/null || die "node not found"

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "local")
DIRTY=""
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then DIRTY="-dirty"; fi
DEV_VERSION="0.0.0-dev.${SHA}${DIRTY}"

REGISTRY_VERSION=$(node -p "require('./package.json').version")
PKG_NAME=$(node -p "require('./package.json').name")

bold "Dev install"
echo "  $PKG_NAME ($REGISTRY_VERSION -> $DEV_VERSION)"
echo "  prefix: $PREFIX"
echo "  bin:    $LINK_DIR/agents$DEV_SUFFIX"
echo

if ! $SKIP_BUILD; then
  BUILD_ARGS=()
  $SKIP_TESTS && BUILD_ARGS+=(--skip-tests)
  ./scripts/build.sh ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}
  echo
fi

[[ -f dist/index.js ]] || die "dist/index.js missing -- run scripts/build.sh first"

STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

dim "  Staging $STAGE_DIR"
mkdir -p "$STAGE_DIR/scripts"
cp -R dist "$STAGE_DIR/"
cp scripts/postinstall.js "$STAGE_DIR/scripts/"
[[ -f CHANGELOG.md ]] && cp CHANGELOG.md "$STAGE_DIR/"
[[ -f README.md ]] && cp README.md "$STAGE_DIR/"
[[ -f LICENSE ]] && cp LICENSE "$STAGE_DIR/"

node -e "
  const fs = require('fs');
  const p = require('./package.json');
  p.version = '$DEV_VERSION';
  delete p.scripts?.postinstall;
  delete p.scripts?.prepack;
  delete p.scripts?.prepare;
  fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2));
" "$STAGE_DIR/package.json"

dim "  Packing tarball"
(
  cd "$STAGE_DIR"
  TARBALL_FILE=$(npm pack --silent --ignore-scripts 2>&1 | tail -1)
  echo "$STAGE_DIR/$TARBALL_FILE" > "$STAGE_DIR/.tarball-path"
)
TARBALL=$(cat "$STAGE_DIR/.tarball-path")
[[ -f "$TARBALL" ]] || die "npm pack failed to produce a tarball"

dim "  Installing to $PREFIX"
mkdir -p "$PREFIX"
npm install -g "$TARBALL" \
  --prefix "$PREFIX" \
  --silent --no-fund --no-audit --no-save \
  --ignore-scripts \
  >/dev/null

# Publish only suffixed dev names; production names remain owned by the registry install.
mkdir -p "$LINK_DIR"

DEV_SHADOW_MARKER='AGENTS_CLI_DEV_SHADOW_LINK'

# Remove only legacy links/wrappers demonstrably owned by this dev prefix. Real
# binaries and links to any other installation are never touched.
cleanup_legacy_shadow() {
  local path="$1" raw
  if [[ -L "$path" ]]; then
    raw=$(readlink "$path") || return 0
    case "$raw" in
      "$PREFIX"/*|"$HOME"/.local/agents-cli-dev/*)
        rm -f "$path"
        dim "  Removed stale dev link: $path -> $raw"
        ;;
    esac
  elif [[ -f "$path" ]] &&
       grep -qE "$DEV_SHADOW_MARKER|agents-cli-dev" "$path" 2>/dev/null; then
    rm -f "$path"
    dim "  Removed stale dev wrapper: $path"
  fi
}

REMOVED_LINKS=()
for bin in "${PRODUCTION_BINS[@]}"; do
  for candidate in "$LINK_DIR/$bin" "$LINK_DIR/$bin.cmd" "$LINK_DIR/$bin.ps1"; do
    [[ -e "$candidate" || -L "$candidate" ]] || continue
    cleanup_legacy_shadow "$candidate"
    [[ -e "$candidate" || -L "$candidate" ]] || REMOVED_LINKS+=("$candidate")
  done
done

# A removed legacy shadow may still be pinned in the shared daemon manifest.
# Warn with the repair command, but never restart that service without --bounce-daemon.
for manifest in \
  "$HOME/.config/systemd/user/agents-daemon.service" \
  "$HOME/Library/LaunchAgents/com.phnx-labs.agents-daemon.plist"
do
  [[ -f "$manifest" ]] || continue
  for removed in ${REMOVED_LINKS[@]+"${REMOVED_LINKS[@]}"}; do
    grep -qF "$removed\"" "$manifest" 2>/dev/null ||
      grep -qF "$removed<" "$manifest" 2>/dev/null || continue
    echo
    yellow "  The agents daemon service still points at $removed, which was"
    yellow "  just removed ($manifest)."
    yellow "  It runs until the next restart, then fails. Repoint it with:"
    echo   "      agents daemon restart"
    break
  done
done

if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then
  for bin in "${DEV_BINS[@]}"; do
    [[ -e "$PREFIX/$bin.cmd" ]] || continue
    dev="$bin$DEV_SUFFIX"
    printf ':: %s\r\n@"%%USERPROFILE%%\\.local\\agents-cli-dev\\%s.cmd" %%*\r\n' \
      "$DEV_SHADOW_MARKER" "$bin" > "$LINK_DIR/$dev.cmd"
    printf '# %s\r\n& "$HOME\\.local\\agents-cli-dev\\%s.ps1" @args\r\n' \
      "$DEV_SHADOW_MARKER" "$bin" > "$LINK_DIR/$dev.ps1"
    printf '#!/usr/bin/env bash\n# %s\nexec "$HOME/.local/agents-cli-dev/%s" "$@"\n' \
      "$DEV_SHADOW_MARKER" "$bin" > "$LINK_DIR/$dev"
    chmod +x "$LINK_DIR/$dev"
  done
else
  for bin in "${DEV_BINS[@]}"; do
    src="$PREFIX/bin/$bin"
    [[ -e "$src" ]] || continue
    ln -sf "$src" "$LINK_DIR/$bin$DEV_SUFFIX"
  done
fi

NATIVE_BIN="$PREFIX/lib/node_modules/$PKG_NAME/dist/bin/agents"
if [[ "$(uname)" == "Darwin" && -x "$NATIVE_BIN" ]] && "$NATIVE_BIN" --version >/dev/null 2>&1; then
  ln -sf "$NATIVE_BIN" "$LINK_DIR/agents$DEV_SUFFIX"
  ln -sf "$NATIVE_BIN" "$LINK_DIR/ag$DEV_SUFFIX"
  dim "  Linked agents$DEV_SUFFIX/ag$DEV_SUFFIX to the standalone binary (dist/bin/agents)"
fi

LINKED_PATH="$LINK_DIR/agents$DEV_SUFFIX"
[[ -e "$LINKED_PATH" ]] || die "agents$DEV_SUFFIX not installed at $LINKED_PATH"
LINKED_VER=$("$LINKED_PATH" --version 2>/dev/null | head -1 || echo "?")

if [[ -z "${CI:-}" && "${AGENTS_NO_HEAL:-}" != "1" && "$BOUNCE_DAEMON" == true ]]; then
  INSTALLED_PKG="$PREFIX/lib/node_modules/$PKG_NAME"
  if [[ -f "$INSTALLED_PKG/dist/lib/daemon/daemon.js" ]]; then
    dim "  Reloading daemon onto this build (if running)"
    AGENTS_INSTALL_DAEMON_MOD="$INSTALLED_PKG/dist/lib/daemon/daemon.js" \
    AGENTS_INSTALL_BIN="$LINKED_PATH" \
    node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const modPath = process.env.AGENTS_INSTALL_DAEMON_MOD;
      const bin = process.env.AGENTS_INSTALL_BIN;
      try {
        const d = await import(pathToFileURL(modPath).href);
        if (!d.isDaemonRunning?.()) process.exit(0);
        d.stopDaemon?.();
        d.startDaemon?.(bin);
        console.log("  Restarted the routines daemon onto this version.");
      } catch (err) {
        console.error("  Could not restart the daemon (non-fatal):", err && err.message ? err.message : err);
        console.error("  Run: agents daemon restart");
        process.exit(0);
      }
    ' || true
  fi
elif [[ -z "${CI:-}" ]]; then
  dim "  Shared daemon left on production code (browser IPC, routines, and more)."
  dim "  Pass --bounce-daemon to point it at this dev build -- that changes what your"
  dim "  everyday 'agents' talks to, not just agents$DEV_SUFFIX."
fi

green "  Ready"
dim   "  $LINKED_PATH ($LINKED_VER)"

if command -v agents >/dev/null 2>&1; then
  dim "  Run 'agents$DEV_SUFFIX <args>'. Your installed 'agents' is untouched."
else
  echo
  yellow "  'agents' does not resolve on this PATH."
  yellow "  A dev shadow was standing in for the registry install here. Restore it with:"
  echo   "      npm install -g @phnx-labs/agents-cli"
  yellow "  (or add npm's global bin dir to PATH). 'agents$DEV_SUFFIX' is unaffected."
fi

case ":$PATH:" in
  *":$LINK_DIR:"*) : ;;
  *)
    echo
    yellow "  $LINK_DIR is not on PATH. Add this to your shell rc:"
    echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
