#!/usr/bin/env bash
set -euo pipefail

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

LOCAL_CLI="$(cd "$(dirname "$0")/.." && pwd)"

log()  { printf '\033[36m[remote-sign]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[remote-sign]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[remote-sign] error:\033[0m %s\n' "$*" >&2; exit 1; }

command -v ssh   >/dev/null || die "ssh not found"
command -v rsync >/dev/null || die "rsync not found"

HOME_BASE="$RELEASE_HOME_BASE"
log "home base:        $HOME_BASE (build + sign + notarize)"
log "local cli:   $LOCAL_CLI"

HOST_CLI="$(ssh "$HOME_BASE" 'echo $HOME/src/github.com/muqsitnawaz/agents-cli/cli')" \
  || die "could not reach the home base $HOME_BASE over ssh"
[[ -n "$HOST_CLI" ]] || die "resolved an empty remote cli path on $HOME_BASE"
log "remote cli:  $HOME_BASE:$HOST_CLI"

log "staging build inputs on $HOME_BASE ..."
ssh "$HOME_BASE" "mkdir -p '$HOST_CLI/scripts' '$HOST_CLI/bin'"

rsync -az --delete --exclude '__tests__/' --exclude '*.test.ts' \
          "$LOCAL_CLI/src/" "$HOME_BASE:$HOST_CLI/src/"
rsync -az "$LOCAL_CLI/package.json" "$LOCAL_CLI/bun.lock" "$HOME_BASE:$HOST_CLI/"
rsync -az "$LOCAL_CLI/scripts/build-bin.sh" \
          "$LOCAL_CLI/scripts/sign-cli-binary.sh" \
          "$LOCAL_CLI/scripts/bun-jit-entitlements.plist" \
          "$LOCAL_CLI/scripts/headless-sign-context.sh" \
          "$LOCAL_CLI/scripts/stage-menubar-helper.sh" \
          "$LOCAL_CLI/scripts/verify-menubar-helper.sh" \
          "$HOME_BASE:$HOST_CLI/scripts/"
ok "inputs staged"

log "staging + signing on $HOME_BASE (published menu-bar helper, then the standalone CLI binary) ..."

BUILD_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/remote-sign-build.sh.XXXXXX")"
trap 'rm -f "$BUILD_SCRIPT"' EXIT
{
  printf '#!/usr/bin/env bash\nset -euo pipefail\ncd %q\n' "$HOST_CLI"
  cat <<'REMOTE_EOF'
. scripts/headless-sign-context.sh
bun install --frozen-lockfile
echo "== menu-bar helper: stage the published menubar/v<floor> release =="
bash scripts/stage-menubar-helper.sh
agents secrets exec apple.com -- bash -c '
  set -euo pipefail
  echo "== standalone agents binary: bun build + codesign + notarize =="
  scripts/sign-cli-binary.sh
'
REMOTE_EOF
} > "$BUILD_SCRIPT"

rsync -az "$BUILD_SCRIPT" "$HOME_BASE:$HOST_CLI/.remote-sign-build.sh"
ssh "$HOME_BASE" "bash -lc 'bash \"$HOST_CLI/.remote-sign-build.sh\"'" \
  || die "remote build/sign failed on $HOME_BASE (see output above)"
ok "remote stage + sign complete"

log "pulling signed bundle back into $LOCAL_CLI/bin/ ..."
mkdir -p "$LOCAL_CLI/bin"
rsync -az --delete "$HOME_BASE:$HOST_CLI/bin/MenubarHelper.app" "$LOCAL_CLI/bin/"
rsync -az "$HOME_BASE:$HOST_CLI/bin/agents-macos" "$LOCAL_CLI/bin/agents-macos"
rsync -az "$HOME_BASE:$HOST_CLI/scripts/agents-cli-bin.sha256" "$LOCAL_CLI/scripts/agents-cli-bin.sha256"
ok "bundle pulled back"

if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL=(shasum -a 256)
else
  SHA_TOOL=(sha256sum)
fi

[[ -d "$LOCAL_CLI/bin/MenubarHelper.app" ]] || die "menu-bar helper bundle missing after pull-back"
ok "menu-bar helper bundle present: bin/MenubarHelper.app"

expected_cli="$(cut -d ' ' -f 1 "$LOCAL_CLI/scripts/agents-cli-bin.sha256")"
actual_cli="$("${SHA_TOOL[@]}" "$LOCAL_CLI/bin/agents-macos" | cut -d ' ' -f 1)"
[[ "$actual_cli" == "$expected_cli" ]] \
  || die "standalone agents binary sha mismatch after pull-back: expected $expected_cli, got $actual_cli"
ok "standalone agents binary sha verified: $actual_cli"

ok "signed artifacts ready in $LOCAL_CLI/bin (published menu-bar helper staged, CLI binary signed)."
