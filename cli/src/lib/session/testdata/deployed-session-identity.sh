#!/usr/bin/env bash

input="$(cat 2>/dev/null || true)"

python3 - "$input" "$PPID" <<'PY' 2>/dev/null || true
import json, os, sys, time

raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    agent_ppid = int(sys.argv[2]) if len(sys.argv) > 2 else os.getppid()
except (ValueError, IndexError):
    agent_ppid = os.getppid()

data = {}
try:
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}

sid = data.get("session_id") or ""
cwd = data.get("cwd") or ""
transcript = data.get("transcript_path") or ""

if not sid:
    for k in ("GROK_SESSION_ID", "GEMINI_SESSION_ID", "CLAUDE_SESSION_ID"):
        if os.environ.get(k):
            sid = os.environ[k]
            break

if not sid:
    sys.exit(0)

if not cwd:
    cwd = os.environ.get("GEMINI_CWD") or os.getcwd()

home = os.path.expanduser("~")


def atomic_write_json(path, obj):
    """Best-effort atomic JSON write; a failure never breaks the session."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp.%d" % os.getpid()
        with open(tmp, "w") as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except Exception:
        pass


atomic_write_json(
    os.path.join(home, ".agents", ".cache", "state", "sessions", "%d.json" % agent_ppid),
    {"session_id": sid, "cwd": cwd, "pid": agent_ppid, "ts": int(time.time())},
)

reg_dir = os.path.join(home, ".agents", ".cache", "terminals", "by-pid")


def ppid_of(pid):
    try:
        with open("/proc/%d/stat" % pid) as f:
            after = f.read().rsplit(")", 1)[1].split()
        return int(after[1])
    except Exception:
        return 0


agent_pid = os.getppid()
cur, seen = agent_pid, 0
while cur and cur > 1 and seen < 25:
    if os.path.exists(os.path.join(reg_dir, "%d.json" % cur)):
        agent_pid = cur
        break
    cur = ppid_of(cur)
    seen += 1

reg_path = os.path.join(reg_dir, "%d.json" % agent_pid)
entry = {
    "pid": agent_pid,
    "agent": "",
    "sessionId": sid,
    "cwd": cwd,
    "tmuxPane": os.environ.get("TMUX_PANE", ""),
    "startedAtMs": int(time.time() * 1000),
}
LAUNCHER_PRESERVE = (
    "agent",
    "cwd",
    "tmuxPane",
    "startedAtMs",
    "terminalId",
    "launchId",
    "actor",
    "initiatedBy",
)
try:
    with open(reg_path) as f:
        prev = json.load(f)
    if isinstance(prev, dict):
        for k in LAUNCHER_PRESERVE:
            if prev.get(k):
                entry[k] = prev[k]
except Exception:
    pass
if not entry.get("terminalId"):
    tid = (os.environ.get("AGENT_TERMINAL_ID") or "").strip()
    if tid:
        entry["terminalId"] = tid
if not entry.get("launchId"):
    lid = (os.environ.get("AGENT_LAUNCH_ID") or "").strip()
    if lid:
        entry["launchId"] = lid
if not entry["agent"]:
    if os.environ.get("GROK_SESSION_ID"):
        entry["agent"] = "grok"
    elif os.environ.get("CLAUDE_SESSION_ID"):
        entry["agent"] = "claude"
atomic_write_json(reg_path, entry)

if os.environ.get("CLAUDECODE"):
    context = "Your current session id is %s." % sid
    if transcript:
        context += " Session transcript: %s" % transcript
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }))
PY
exit 0
