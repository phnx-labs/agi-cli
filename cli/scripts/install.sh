#!/usr/bin/env bash
#
# Install this working tree as a dev build of agents-cli, side-by-side with
# the registry-installed `agents` command.
#
# The dev install lives at its own prefix (default: $HOME/.local/agents-cli-dev)
# and is exposed as $HOME/.local/bin/agents-dev (plus `ag-dev`). Run it by name:
#
#   agents-dev sessions --active     # this working tree
#   agents      sessions --active    # your installed CLI, untouched
#
# This script MUST NEVER create, overwrite, or point at $HOME/.local/bin/agents,
# `ag`, or `browser`. Those names belong to the registry install alone. A dev
# build that answers to `agents` makes PATH order decide which code runs, and a
# cleaned dev prefix leaves the production command dangling -- so the dev build
# gets its own name instead. Any such shadow link a PREVIOUS run of this script
# left behind is removed on the next run.
#
# Version of the dev build is `0.0.0-dev.<sha>[-dirty]`, so `agents-dev --version`
# always tells you which commit you are driving.
#
# Usage: scripts/install.sh [--skip-build] [--skip-tests] [--prefix <dir>]
#                           [--bounce-daemon]
#
#   --skip-build      reuse existing dist/ instead of rebuilding
#   --skip-tests      skip the test suite (forwarded to build)
#   --prefix <dir>    install prefix (default: $HOME/.local/agents-cli-dev)
#   --bounce-daemon   restart a running routines daemon onto this dev build.
#                     Off by default: the daemon is shared (browser IPC,
#                     routines, and more), so pointing it at a dev build
#                     changes what your everyday `agents` talks to.

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

# The dev build answers to these names. `agents`, `ag`, and `browser` are
# deliberately absent -- see the header.
DEV_BINS=(agents ag)
DEV_SUFFIX="-dev"

# Names this script must never leave pointing at the dev prefix. `browser` is
# here because older revisions of this script linked it.
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

# Dev version keyed to the current commit so two installs from different
# commits are distinguishable. Bin name stays stable (`agents-dev`).
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

# Stage a copy of the package with the dev version. We don't mutate the
# working-tree package.json because that would dirty the tree mid-iteration
# and confuse later builds. The package's own `bin` names (`agents`, `ag`,
# `browser`) are kept as-is INSIDE $PREFIX so the dev install behaves
# identically to the registry release; only the links published into $LINK_DIR
# are renamed, so nothing on PATH collides with the registry install.
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

dim "  Staging $STAGE_DIR"
mkdir -p "$STAGE_DIR/scripts"
cp -R dist "$STAGE_DIR/"
cp scripts/postinstall.js "$STAGE_DIR/scripts/"
[[ -f CHANGELOG.md ]] && cp CHANGELOG.md "$STAGE_DIR/"
[[ -f README.md ]] && cp README.md "$STAGE_DIR/"
[[ -f LICENSE ]] && cp LICENSE "$STAGE_DIR/"

# Rewrite package.json: dev version. Skip the postinstall hook — it's designed
# to nudge the user to add the registry-install shims dir to PATH, which the
# dev install doesn't need.
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
  # --ignore-scripts: the package's prepack hook references files we don't
  # stage (it's a publish-time check, not relevant for the dev tarball).
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

# Publish the dev bins into a stable location ($HOME/.local/bin) under their own
# names, so the dev build can never win or lose a PATH-ordering race against the
# registry install. Nothing in the registry-install prefix is touched.
mkdir -p "$LINK_DIR"

# Marker embedded in the Windows wrapper scripts. Those are regular files, not
# symlinks, so the cleanup below cannot recognize them by their link target.
DEV_SHADOW_MARKER='AGENTS_CLI_DEV_SHADOW_LINK'

# Remove a $LINK_DIR entry that a PRIOR run of THIS script created under a
# production name. Two shapes qualify, one per platform:
#
#   POSIX   a symlink whose target points into the dev prefix.
#   Windows a regular wrapper file that execs into the dev prefix. Older
#           revisions wrote these with NO marker (they hardcoded the
#           `agents-cli-dev` path), so recognizing them by content is the only
#           thing that works -- a marker-only check silently repaired nothing on
#           the one platform where the shadow is a file rather than a link.
#
# A real binary, or a link/wrapper pointing anywhere else (the registry install,
# Homebrew, the user's own alias), is left exactly as it is.
cleanup_legacy_shadow() {
  local path="$1" raw
  if [[ -L "$path" ]]; then
    # readlink, not `[[ -e ]]`: -e is FALSE for a dangling symlink, and dangling
    # is precisely the state left behind once the dev prefix is cleaned -- the
    # shape that makes `agents` fail with "no such file or directory".
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

# A long-running service may have been pinned to a link we just removed. An
# earlier revision of this script bounced the shared routines daemon onto the dev
# build and recorded THAT path in the service manifest, so the daemon keeps
# running from memory but dies on its next restart -- silently taking the
# scheduler and browser IPC with it. Name it and hand over the
# one command that repoints the manifest; do not restart a shared service the
# caller did not ask us to touch.
#
# Match the EXACT path we removed, terminated. A bare substring test for
# "$LINK_DIR/agents" also matches "$LINK_DIR/agents-dev", so a box that ran
# --bounce-daemon (healthy manifest, pointing at agents-dev) plus any one stale
# link would be told to restart a working daemon. Both manifest formats delimit
# the path -- systemd quotes it, launchd wraps it in <string> -- so two fixed
# string tests are enough and need no regex escaping of $LINK_DIR.
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

# Prefer the standalone Mach-O when the staged dist carries one (macOS): the
# node-shebang shim is what EDR flags (#315). Runnable-probe first - an
# unsigned or wrong-arch artifact must not brick the dev install.
NATIVE_BIN="$PREFIX/lib/node_modules/$PKG_NAME/dist/bin/agents"
if [[ "$(uname)" == "Darwin" && -x "$NATIVE_BIN" ]] && "$NATIVE_BIN" --version >/dev/null 2>&1; then
  ln -sf "$NATIVE_BIN" "$LINK_DIR/agents$DEV_SUFFIX"
  ln -sf "$NATIVE_BIN" "$LINK_DIR/ag$DEV_SUFFIX"
  dim "  Linked agents$DEV_SUFFIX/ag$DEV_SUFFIX to the standalone binary (dist/bin/agents)"
fi

# Confirm the dev binary is runnable.
LINKED_PATH="$LINK_DIR/agents$DEV_SUFFIX"
[[ -e "$LINKED_PATH" ]] || die "agents$DEV_SUFFIX not installed at $LINKED_PATH"
LINKED_VER=$("$LINKED_PATH" --version 2>/dev/null | head -1 || echo "?")

# Bounce a running routines daemon onto this build (RUSH-2442).
#
# The npm postinstall hook is the registry-install path that restarts the
# daemon so every subsystem it hosts (browser IPC, the scheduler, and more)
# reloads the just-installed code. We strip that hook above so the PATH-nudge
# and alias-shim flow don't fire for a side-by-side dev prefix — which also
# skipped the restart, leaving those subsystems built from the PREVIOUS
# install still running. (The secrets broker is a separate process owned by
# the standalone `secrets` CLI now, PHNX-3989 — this daemon restart never
# touches it.)
#
# Match postinstall.js healLongRunningProcesses: only when a daemon is
# already running (never start one the user didn't want), best-effort and
# non-fatal, skipped in CI and when AGENTS_NO_HEAL=1.
#
# OPT-IN (--bounce-daemon), because the daemon is SHARED. It hosts the secrets
# broker, browser IPC, and the routines scheduler for the whole machine, and the
# restart pins it to whichever binary is passed. Doing that automatically would
# leave every `agents secrets`, `agents browser`, and scheduled routine served by
# a working-tree build while `agents` itself still looks untouched -- an invisible
# takeover, and the same class of problem the dev bin rename fixes. Earlier
# revisions justified the automatic restart on the premise that the dev build IS
# what `agents` resolves to; that premise no longer holds.
if [[ -z "${CI:-}" && "${AGENTS_NO_HEAL:-}" != "1" && "$BOUNCE_DAEMON" == true ]]; then
  INSTALLED_PKG="$PREFIX/lib/node_modules/$PKG_NAME"
  if [[ -f "$INSTALLED_PKG/dist/lib/daemon/daemon.js" ]]; then
    dim "  Reloading daemon onto this build (if running)"
    # Export paths for the node one-shot so shell metacharacters in PREFIX
    # can't break the import. Use the installed module (not PATH) so we
    # don't accidentally restart with a different agents binary.
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

# The cleanup above may have removed the only thing answering to `agents` on this
# box. postinstall.js short-circuits its own ~/.local/bin link when `agents`
# already resolves on the login PATH (`scripts/postinstall.js:311`), so on a box
# where npm's global bin dir is not on that PATH, the dev shadow was what
# satisfied that probe and npm never wrote a link of its own. Removing the shadow
# is still right -- but say so instead of claiming `agents` is untouched.
if command -v agents >/dev/null 2>&1; then
  dim "  Run 'agents$DEV_SUFFIX <args>'. Your installed 'agents' is untouched."
else
  echo
  yellow "  'agents' does not resolve on this PATH."
  yellow "  A dev shadow was standing in for the registry install here. Restore it with:"
  echo   "      npm install -g @phnx-labs/agents-cli"
  yellow "  (or add npm's global bin dir to PATH). 'agents$DEV_SUFFIX' is unaffected."
fi

# The dev build has its own name, so PATH ORDER no longer matters -- only whether
# $LINK_DIR is reachable at all.
case ":$PATH:" in
  *":$LINK_DIR:"*) : ;;
  *)
    echo
    yellow "  $LINK_DIR is not on PATH. Add this to your shell rc:"
    echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
