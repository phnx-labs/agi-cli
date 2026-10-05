#!/usr/bin/env bash

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

STDIN_JSON=""
if [ ! -t 0 ]; then
  STDIN_JSON="$(cat || true)"
fi

SID=""
CWD=""
METHOD="hook-stdin"

extract_stdin_json() {
  local field_priority="$1"
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

PRUNE_SCRIPT="$SCRIPT_DIR/../dist/prune-state.js"
if [ -f "$PRUNE_SCRIPT" ]; then
  node "$PRUNE_SCRIPT" >/dev/null 2>&1 || true
fi

HISTORY_DIR="${AGENTS_HISTORY_DIR:-}"
RUN_MODE="${AGENTS_RUN_MODE:-}"
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
