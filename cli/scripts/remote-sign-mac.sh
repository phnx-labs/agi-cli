#!/usr/bin/env bash
#
# Offload the macOS native-helper build + codesign + notarize to the release home
# base so an agents-cli release can be DRIVEN FROM ANOTHER MAC.
#
# NOTE: the normal release flow no longer calls this. release.sh routes the whole
# privileged phase (build + sign + notarize + npm publish + computer-helper) to
# the home base directly (run_home_base_phase / --home-base-phase). This script
# remains for the narrow case of building + pulling back JUST the signed macOS
# artifacts from another Mac, without publishing.
#
# The published tarball bundles one signed macOS .app helper that Linux cannot
# produce: bin/MenubarHelper.app — the menu-bar status item (swift build →
# codesign → notarize → staple). See menubar/scripts/build.sh. (A second
# helper, the keychain broker, used to build here too; it moved out of this
# repo entirely with the standalone `secrets` engine, PHNX-3989.)
#
# This script rsyncs the exact build INPUTS from THIS worktree to the home base,
# runs the Mac build script there under its headless signing creds, then
# pulls the signed bundle back into THIS worktree's cli/bin/ so
# `bun run build` (presence-gated) can package it.
#
# NO ENV VARS: the sign host defaults to mac-mini (matching release.sh) and is
# overridable only with `--device <name>` (alias `--host`) -- a flag, never
# ambient config. No secret-host override, no force-remote knob, no fleet
# discovery, no auto-failover.
#
# The home base must have: a Developer ID identity in rush-signing.keychain-db,
# the kcpass + secrets.pass files under ~/Library/Application Support/rush/, and
# the `apple.com` secrets bundle (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
# APPLE_TEAM_ID).
#
# Usage: scripts/remote-sign-mac.sh [--device <name>]
set -euo pipefail

# The Mac that builds + signs, matching release.sh: mac-mini by default,
# overridable with `--device <name>` (alias `--host`). A flag with a default,
# never an env var.
readonly RELEASE_HOME_BASE_DEFAULT="mac-mini"
DEVICE=""
expect_device=false
for arg in "$@"; do
  if $expect_device; then DEVICE="$arg"; expect_device=false; continue; fi
  case "$arg" in
    --device|--host) expect_device=true ;;
    --device=*|--host=*) DEVICE="${arg#*=}" ;;
    -h|--help) printf '%s\n' "usage: scripts/remote-sign-mac.sh [--device <name>]"; exit 0 ;;
    *) printf 'error: unexpected argument: %s\n' "$arg" >&2; exit 1 ;;
  esac
done
$expect_device && { printf 'error: --device needs a machine name\n' >&2; exit 1; }
readonly RELEASE_HOME_BASE="${DEVICE:-$RELEASE_HOME_BASE_DEFAULT}"

# cli in THIS worktree (script lives in cli/scripts/).
LOCAL_CLI="$(cd "$(dirname "$0")/.." && pwd)"

log()  { printf '\033[36m[remote-sign]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[remote-sign]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[remote-sign] error:\033[0m %s\n' "$*" >&2; exit 1; }

command -v ssh   >/dev/null || die "ssh not found"
command -v rsync >/dev/null || die "rsync not found"

HOME_BASE="$RELEASE_HOME_BASE"
log "home base:        $HOME_BASE (build + sign + notarize)"
log "local cli:   $LOCAL_CLI"

# Resolve the remote build workspace. $HOME expands on the REMOTE side (never the
# local shell), so single-quote it and let the home base's shell expand it.
HOST_CLI="$(ssh "$HOME_BASE" 'echo $HOME/src/github.com/muqsitnawaz/agents-cli/cli')" \
  || die "could not reach the home base $HOME_BASE over ssh"
[[ -n "$HOST_CLI" ]] || die "resolved an empty remote cli path on $HOME_BASE"
log "remote cli:  $HOME_BASE:$HOST_CLI"

# ----- 1. Ship the build inputs from this worktree to the sign host -----
# We stage into the sign host's cli subtree so the Mac build scripts see the
# layout they expect (scripts/.., src/.., menubar/..). This is a build
# workspace, not a git checkout — the sign host's own branch/version is irrelevant.
log "staging build inputs on $HOME_BASE ..."
ssh "$HOME_BASE" "mkdir -p '$HOST_CLI/scripts' '$HOST_CLI/bin' '$HOST_CLI/menubar'"

# Full src tree + package manifest: the standalone CLI binary is compiled from
# src/ with `bun build --compile` (scripts/build-bin.sh), which resolves its
# npm imports from node_modules — the remote script runs `bun install` first.
rsync -az --delete --exclude '__tests__/' --exclude '*.test.ts' \
          "$LOCAL_CLI/src/" "$HOME_BASE:$HOST_CLI/src/"
rsync -az "$LOCAL_CLI/package.json" "$LOCAL_CLI/bun.lock" "$HOME_BASE:$HOST_CLI/"
rsync -az "$LOCAL_CLI/scripts/build-bin.sh" \
          "$LOCAL_CLI/scripts/sign-cli-binary.sh" \
          "$LOCAL_CLI/scripts/bun-jit-entitlements.plist" \
          "$LOCAL_CLI/scripts/headless-sign-context.sh" \
          "$HOME_BASE:$HOST_CLI/scripts/"
# Menu-bar Swift package — exclude build outputs so we don't ship stale artifacts.
rsync -az --delete --exclude '.build/' --exclude 'dist/' \
          "$LOCAL_CLI/menubar/" "$HOME_BASE:$HOST_CLI/menubar/"
ok "inputs staged"

# ----- 2. Build + sign on the sign host -----
# Runs under a login shell so `agents` is on PATH, unlocks the signing keychain
# headless, and injects the Apple notarization creds via the `apple.com` bundle.
log "building + signing on $HOME_BASE (menu-bar helper, then the standalone CLI binary) ..."

# Generate the remote build script LOCALLY and ship it as a file, then run it on
# the host. A file dodges the multi-layer quoting hell of embedding a multi-line
# script (with its own single-quoted `bash -c '...'`) inside an ssh command that
# the host's login shell re-parses. `$HOME` / `$(cat …)` stay literal so the
# REMOTE bash expands them; only the resolved workspace path is baked in via %q.
# Trailing X's (PHNX-3631): BSD/macOS mktemp only substitutes X's at the END of
# a template, so `...XXXXXX.sh` is a literal filename that collides on reuse.
BUILD_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/remote-sign-build.sh.XXXXXX")"
trap 'rm -f "$BUILD_SCRIPT"' EXIT
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\ncd %q\n' "$HOST_CLI"
  cat <<'REMOTE_EOF'
# Enter the shared headless signing + secrets context (unlock the signing
# keychain + export AGENTS_SECRETS_PASSPHRASE) -- the single source of truth,
# also sourced by release.sh's run_home_base_phase.
. scripts/headless-sign-context.sh
agents secrets exec apple.com -- bash -c '
  set -euo pipefail
  echo "== menu-bar helper: swift build + codesign + notarize + staple =="
  menubar/scripts/build.sh release
  # rm -rf first so a re-run does not nest the new .app INSIDE a stale
  # bin/MenubarHelper.app (cp -R into an existing dir), which corrupts the
  # signature ("unsealed contents present in the bundle root").
  rm -rf bin/MenubarHelper.app
  cp -R menubar/dist/MenubarHelper.app bin/MenubarHelper.app
  codesign --verify --deep --strict "bin/MenubarHelper.app"
  echo "== standalone agents binary: bun build + codesign + notarize =="
  bun install --frozen-lockfile
  scripts/sign-cli-binary.sh
'
REMOTE_EOF
} > "$BUILD_SCRIPT"

rsync -az "$BUILD_SCRIPT" "$HOME_BASE:$HOST_CLI/.remote-sign-build.sh"
# `bash -lc` gives the run `agents` on PATH (homebrew); `bash <file>` avoids
# needing the staged script to be +x.
ssh "$HOME_BASE" "bash -lc 'bash \"$HOST_CLI/.remote-sign-build.sh\"'" \
  || die "remote build/sign failed on $HOME_BASE (see output above)"
ok "remote build + sign complete"

# ----- 3. Pull the signed bundle + refreshed sha pin back into this worktree -----
log "pulling signed bundle back into $LOCAL_CLI/bin/ ..."
mkdir -p "$LOCAL_CLI/bin"
rsync -az --delete "$HOME_BASE:$HOST_CLI/bin/MenubarHelper.app" "$LOCAL_CLI/bin/"
rsync -az "$HOME_BASE:$HOST_CLI/bin/agents-macos" "$LOCAL_CLI/bin/agents-macos"
rsync -az "$HOME_BASE:$HOST_CLI/scripts/agents-cli-bin.sha256" "$LOCAL_CLI/scripts/agents-cli-bin.sha256"
ok "bundle pulled back"

# ----- 4. Local sanity: recompute the sha over the pulled Mach-O and assert match -----
if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL=(shasum -a 256)
else
  SHA_TOOL=(sha256sum)
fi

[[ -d "$LOCAL_CLI/bin/MenubarHelper.app" ]] || die "menu-bar helper bundle missing after pull-back"
ok "menu-bar helper bundle present: bin/MenubarHelper.app"

# Same integrity assert for the standalone CLI binary (issue #315): the pulled
# bin/agents-macos must match the sha pin its sign run produced.
expected_cli="$(cut -d ' ' -f 1 "$LOCAL_CLI/scripts/agents-cli-bin.sha256")"
actual_cli="$("${SHA_TOOL[@]}" "$LOCAL_CLI/bin/agents-macos" | cut -d ' ' -f 1)"
[[ "$actual_cli" == "$expected_cli" ]] \
  || die "standalone agents binary sha mismatch after pull-back: expected $expected_cli, got $actual_cli"
ok "standalone agents binary sha verified: $actual_cli"

ok "signed bundles ready in $LOCAL_CLI/bin — 'bun run build' will package them."
