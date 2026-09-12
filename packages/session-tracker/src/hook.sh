#!/usr/bin/env bash
# Polyglot SessionStart hook.
#
# Registered as a SessionStart hook in each agent's native config file.
# Each agent passes the hook payload differently:
#   - claude/codex/cursor: JSON on stdin with session_id (+conversation_id for cursor)
#   - grok: GROK_SESSION_ID and GROK_WORKSPACE_ROOT env vars
#   - hermes: JSON on stdin (on_session_start payload); best-effort field probe
#   - gemini/antigravity: best-effort stdin-JSON probe
#
# Writes ~/.agents/.cache/terminals/sessions/<PPID>.json with the canonical
# SessionState schema from src/types.ts. Atomic via mktemp + mv.
#
# Invocation:
#   hook.sh <agent>            # required; selects which payload format to parse
#
# Silent on success (SessionStart stdout leaks into the model context).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TMP=""
SID_TMP=""
cleanup() {
  [ -n "$TMP" ] && rm -f "$TMP"
  [ -n "$SID_TMP" ] && rm -f "$SID_TMP"
  return 0
}
trap cleanup EXIT

AGENT="${1:-${AGENT_HINT:-}}"
if [ -z "$AGENT" ]; then
  exit 0
fi

# Read stdin if any (don't block forever).
# Use `cat` only when stdin is not a TTY — and rely on hosts (claude, codex,
# cursor) closing stdin promptly. macOS has no `timeout` in PATH by default,
# so we don't use it.
STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON="$(cat || true)"
fi

SID=""
CWD=""
METHOD="hook-stdin"

extract_stdin_json() {
  local field_priority="$1"  # space-separated list of JSON keys to try in order
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    for k in '''$field_priority'''.split():
        v = d.get(k)
        if isinstance(v, str) and v:
            print(v); sys.exit(0)
        if isinstance(v, list) and v and isinstance(v[0], str):
            print(v[0]); sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true
}

case "$AGENT" in
  claude|codex|droid|kimi)
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd')"
    ;;
  cursor)
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id conversation_id')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd workspace_roots')"
    ;;
  grok)
    SID="${GROK_SESSION_ID:-}"
    CWD="${GROK_WORKSPACE_ROOT:-$PWD}"
    METHOD="hook-env"
    ;;
  hermes|gemini|antigravity)
    # Best-effort stdin-JSON probe across the field names these harnesses use.
    # A miss exits 0 below (no state file) — never a wrong write.
    SID="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'session_id conversation_id sessionId')"
    CWD="$(printf '%s' "$STDIN_JSON" | extract_stdin_json 'cwd workspace_roots')"
    ;;
  *)
    exit 0
    ;;
esac

if [ -z "$SID" ]; then
  exit 0
fi

# The session id becomes two filenames below. Reject path components before
# either mktemp or mv sees the harness-provided value.
case "$SID" in
  *'/'*|*'\'*|'.'|'..') exit 0 ;;
esac

[ -z "$CWD" ] && CWD="$PWD"

STATE_DIR="$HOME/.agents/.cache/terminals/sessions"
mkdir -p "$STATE_DIR"

TID="${AGENT_TERMINAL_ID:-}"
LID="${AGENT_LAUNCH_ID:-}"

TMP="$(mktemp "$STATE_DIR/.${PPID}.XXXXXX")"
python3 - "$SID" "$CWD" "$PPID" "$AGENT" "$TID" "$LID" "$METHOD" > "$TMP" <<'PY'
import json, sys, time
sid, cwd, pid, agent, tid, lid, method = sys.argv[1:8]
out = {
    "session_id": sid,
    "agent": agent,
    "cwd": cwd,
    "pid": int(pid),
    "ts": int(time.time() * 1000),
    "method": method,
}
if tid:
    out["terminal_id"] = tid
if lid:
    out["launch_id"] = lid
json.dump(out, sys.stdout)
PY

mv -f "$TMP" "$STATE_DIR/$PPID.json"

# Prune dead-pid records, zero-byte files, and orphaned temp files left by
# crashed atomic writes. Keep stdout/stderr silent — it leaks into the model.
PRUNE_SCRIPT="$SCRIPT_DIR/../dist/prune-state.js"
if [ -f "$PRUNE_SCRIPT" ]; then
  node "$PRUNE_SCRIPT" >/dev/null 2>&1 || true
fi

# Persist launch metadata under the harness's real session id. `agents run`
# exports the EFFECTIVE mode after capability/headless resolution, plus the
# shared (non-version-home) history directory. Atomic replacement lets a native
# resume with an explicit --mode become the new mode for the next resume.
HISTORY_DIR="${AGENTS_HISTORY_DIR:-}"
RUN_MODE="${AGENTS_RUN_MODE:-}"
# The agents-cli version-home id this run launched under. Recorded here (not at
# spawn) for the same reason as RUN_MODE: the harness coins its real session id
# only after launch, so it must be joined to that id by this hook. A later native
# resume pins the exact origin version off it, so a session whose transcript
# carries no derivable version (codex's `.codex-homes/<version>/` home) still
# resumes natively instead of degrading to `/continue` (PHNX-3626).
RUN_VERSION="${AGENTS_RUN_VERSION:-}"
RUN_ACCOUNT_ID="${AGENTS_RUN_ACCOUNT_ID:-}"
TMUX_SESSION_NAME="${AGENT_TMUX_SESSION_NAME:-}"
if [ -n "$HISTORY_DIR" ] && { [ -n "$RUN_MODE" ] || [ -n "$RUN_VERSION" ] || [ -n "$RUN_ACCOUNT_ID" ] || [ -n "$TMUX_SESSION_NAME" ]; }; then
  BY_SESSION_DIR="$HISTORY_DIR/by-session"
  mkdir -p "$BY_SESSION_DIR"
  SID_TMP="$(mktemp "$BY_SESSION_DIR/.${SID}.XXXXXX")"
  python3 - "$SID" "$RUN_MODE" "${AGENTS_ACTOR:-}" "${AGENTS_ACTOR_KIND:-}" "$TMUX_SESSION_NAME" "$BY_SESSION_DIR/$SID.json" "$RUN_VERSION" "$RUN_ACCOUNT_ID" > "$SID_TMP" <<'PY'
import json, re, sys, time
sid, mode, actor, initiated_by, tmux_name, existing_path, version, account_id = sys.argv[1:9]
out = {}
try:
    with open(existing_path) as existing:
        value = json.load(existing)
        if isinstance(value, dict):
            out = value
except (OSError, ValueError):
    pass
out['sessionId'] = sid
if mode in ('plan', 'edit', 'auto', 'skip'):
    out['mode'] = mode
if version:
    out['version'] = version
if account_id:
    out.setdefault('accountId', account_id)
out['startedAtMs'] = int(time.time() * 1000)
if actor:
    out['actor'] = actor
if initiated_by in ('human', 'agent'):
    out['initiatedBy'] = initiated_by
if re.fullmatch(r'ag-[a-z][a-z0-9-]*-[0-9a-f]{8}', tmux_name, re.I):
    aliases = out.get('aliases')
    if not isinstance(aliases, list):
        aliases = []
    aliases = [alias.lower() for alias in aliases if isinstance(alias, str) and re.fullmatch(r'ag-[a-z][a-z0-9-]*-[0-9a-f]{8}', alias, re.I)]
    aliases.append(tmux_name.lower())
    out['aliases'] = list(dict.fromkeys(aliases))
json.dump(out, sys.stdout)
PY
  mv -f "$SID_TMP" "$BY_SESSION_DIR/$SID.json"
fi
exit 0
