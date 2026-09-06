#!/usr/bin/env bash
# SessionStart hook: the single "who am I" hook for a starting agent. Merges
# three former hooks that each re-read the same SessionStart stdin JSON:
#
#   04-capture-session-start-metadata.sh  -> ~/.agents/.cache/state/sessions/<agent_pid>.json
#   08-register-session-pid.sh            -> ~/.agents/.cache/terminals/by-pid/<agent_pid>.json
#   07-inject-session-id.sh               -> stdout additionalContext (Claude harness only)
#
# Consolidated so session start spawns ONE process and parses stdin ONCE instead
# of three. Deployed to the UNION of the three former agent lists
# (claude/codex/gemini/kimi/grok/antigravity); the two silent state writes run
# for every agent (strictly additive — a metadata/registry file for an agent that
# lacked one before is harmless), while the stdout injection self-restricts to the
# Claude harness so non-Claude agents never see Claude-shaped context JSON.
#
# BLAST RADIUS: runs on EVERY session start. It must NEVER abort or delay the
# session. No `set -e`; every failure path exits 0; the ONLY thing ever written
# to stdout is the well-formed injection JSON (or nothing). File writes are
# silent and best-effort.
#
# Session id delivery differs per agent (verified against each vendor's hook
# docs): stdin SessionStart JSON `session_id` for Claude / Codex / Kimi /
# Antigravity; `$GROK_SESSION_ID` env for Grok; `$GEMINI_SESSION_ID` /
# `$CLAUDE_SESSION_ID` as further env fallbacks.

input="$(cat 2>/dev/null || true)"

# $PPID = the agent process that spawned this hook (bash's parent). The metadata
# file is keyed by it, matching the former 04 hook's `$PPID` behaviour. Passed
# explicitly because python's os.getppid() would resolve to bash, not the agent.
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

# Env fallbacks — Grok delivers the id only via env; the others expose one too.
if not sid:
    for k in ("GROK_SESSION_ID", "GEMINI_SESSION_ID", "CLAUDE_SESSION_ID"):
        if os.environ.get(k):
            sid = os.environ[k]
            break

# Nothing identifies this session -> no state worth writing, nothing to inject.
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


# ---------------------------------------------------------------------------
# 1) Session metadata (former 04-capture-session-start-metadata.sh)
# Consumers read ~/.agents/.cache/state/sessions/<agent_pid>.json to recover the
# live session UUID — the AGENT_SESSION_ID env var goes stale when a user exits
# and reruns the agent in the same terminal.
# ---------------------------------------------------------------------------
atomic_write_json(
    os.path.join(home, ".agents", ".cache", "state", "sessions", "%d.json" % agent_ppid),
    {"session_id": sid, "cwd": cwd, "pid": agent_ppid, "ts": int(time.time())},
)

# ---------------------------------------------------------------------------
# 2) Per-pid session registry (former 08-register-session-pid.sh)
# Records the live session id into ~/.agents/.cache/terminals/by-pid/<pid>.json
# so `ag sessions --active` can map a ps-discovered pid to its EXACT session
# instead of guessing the newest transcript in the cwd. The ancestor walk reads
# /proc (Linux) — exactly the headless/no-extension hosts where the guess
# collapses N co-located agents onto one row. Without /proc it fails safe.
# ---------------------------------------------------------------------------
reg_dir = os.path.join(home, ".agents", ".cache", "terminals", "by-pid")


def ppid_of(pid):
    # Linux /proc: ppid is field 4; comm (field 2) may contain spaces/parens,
    # so split on the LAST ')'.
    try:
        with open("/proc/%d/stat" % pid) as f:
            after = f.read().rsplit(")", 1)[1].split()
        return int(after[1])
    except Exception:
        return 0


# Resolve the AGENT process pid: walk ancestors and prefer the first that
# already has a launcher-written registry file (that IS the agent process).
# Fall back to our immediate parent when none is found (agent not run via ag run).
agent_pid = os.getppid()
cur, seen = agent_pid, 0
while cur and cur > 1 and seen < 25:
    if os.path.exists(os.path.join(reg_dir, "%d.json" % cur)):
        agent_pid = cur
        break
    cur = ppid_of(cur)
    seen += 1

reg_path = os.path.join(reg_dir, "%d.json" % agent_pid)
# sessionId is the only field THIS hook owns (from SessionStart / env). Everything
# else is launcher-owned and must survive the rewrite — especially terminalId and
# launchId, which Factory and `agents sessions --active` use to join a tab/spawn
# to the real session across --device dispatch (dropping them left Grok/Codex
# status bars unbound — RUSH-2192). Prefer launcher values; fall back to the env
# the launcher exported when no prior registry file exists.
entry = {
    "pid": agent_pid,
    "agent": "",
    "sessionId": sid,
    "cwd": cwd,
    "tmuxPane": os.environ.get("TMUX_PANE", ""),
    "startedAtMs": int(time.time() * 1000),
}
# Fields the launcher stamps at spawn (pid-registry writePidSessionEntry) that
# this hook must NEVER wipe when it rewrites the file with the real sessionId.
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
# Env fallbacks when the launcher entry is missing or incomplete (hand-started
# agent, or a race before writePidSessionEntry lands).
if not entry.get("terminalId"):
    tid = (os.environ.get("AGENT_TERMINAL_ID") or "").strip()
    if tid:
        entry["terminalId"] = tid
if not entry.get("launchId"):
    lid = (os.environ.get("AGENT_LAUNCH_ID") or "").strip()
    if lid:
        entry["launchId"] = lid
# If we still have no agent label, infer from which env var carried the id.
if not entry["agent"]:
    if os.environ.get("GROK_SESSION_ID"):
        entry["agent"] = "grok"
    elif os.environ.get("CLAUDE_SESSION_ID"):
        entry["agent"] = "claude"
atomic_write_json(reg_path, entry)

# ---------------------------------------------------------------------------
# 3) Inject the live session id into the model context (former
# 07-inject-session-id.sh) — Claude harness ONLY. `CLAUDECODE` is set by Claude
# Code for every Claude-harness run, including the kimi/deepseek ANTHROPIC_MODEL
# presets the former hook deliberately covered, and is NOT set under codex /
# gemini / standalone grok — so those agents never receive Claude-shaped JSON.
# Claude appends SessionStart `additionalContext` to the model context verbatim
# (proven empirically — sentinel round-trip + negative control).
# ---------------------------------------------------------------------------
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
