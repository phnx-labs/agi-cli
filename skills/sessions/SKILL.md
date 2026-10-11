---
name: sessions
description: "Search, browse, and read agent conversation transcripts across Claude, Codex, Gemini, and OpenCode. Use this skill to find previous sessions, recover context, or inspect what agents have done."
argument-hint: "[search query or session ID]"
allowed-tools: Bash(agents sessions*), Bash(agents cost*), Bash(agents events*)
user-invocable: true
---

# Sessions Skill

Search and browse agent conversation transcripts. This skill teaches you how to use the `agents sessions` CLI effectively.

## Basic Usage

```bash
# Interactive picker: browse and search recent sessions
agents sessions

# List sessions from current project
agents sessions | head -20

# Search sessions by text
agents sessions "add auth middleware"

# Filter by project across all directories
agents sessions --project agents-cli --all
```

## Filters

| Filter | Example | Description |
|--------|---------|-------------|
| `--agent` | `--agent claude` | Filter by agent type |
| `--all` | `--all` | Include sessions from every directory |
| `--project` | `--project myapp` | Filter by project name |
| `--since` | `--since 2h` | Only sessions newer than this |
| `--until` | `--until 2026-01-01` | Only sessions older than this |
| `--limit` | `--limit 10` | Maximum sessions to return |
| `--sort` | `--sort cost` | Order by `cost`, `duration`, or `recent` (default) |
| `--active` | `--active` | Only currently running sessions |
| `--teams` | `--teams` | Include team-spawned sessions |

## Reading Sessions

```bash
# Render session as markdown
agents sessions --markdown <session-id>

# Output as JSON
agents sessions --json <session-id>

# Include only specific roles
agents sessions --markdown --include user,assistant <session-id>

# Show only first/last N turns
agents sessions --markdown --last 10 <session-id>
```

## Artifacts

```bash
# List all files written or edited during a session
agents sessions --artifacts <session-id>

# Read a specific artifact
agents sessions --artifact <filename> <session-id>
```

## Live Tailing

```bash
# Live-tail a session file (Claude and Codex only)
agents sessions tail <session-id>
# Press Ctrl+C to stop

# Or the unified viewer: resolves a session id OR a host-dispatch run (from
# `agents run --device`), and -f follows either (a session tail here is
# `sessions tail` under the hood)
agents sessions <id>     # show the transcript
agents sessions tail <id> # follow a live one (claude/codex)
```

## Cost & Duration

Every session is priced offline at scan time (`costUsd`) and its wall-clock
runtime is stored (`durationMs`). Both appear in `--json` output, and the list
can be sorted by either.

```bash
# The 10 most expensive sessions, anywhere
agents sessions --all --sort cost --limit 10

# Longest-running sessions in this project
agents sessions --sort duration

# Per-session cost in JSON
agents sessions --all --sort cost --json | jq '.[] | {shortId, agent, costUsd, durationMs}'
```

Use `agents cost` for a fleet-wide rollup (daily $ histogram, top sessions,
per-agent/project/day breakdown):

```bash
agents cost                  # daily histogram + top-10 + per-agent breakdown
agents cost --since 30d       # last 30 days
agents cost --by project      # group by project instead of agent
agents cost --by day --json   # machine-readable daily rollup
```

`agents cost` answers "how much did this cost?"; `agents view` answers "how
much quota / rate limit is left?" — different commands.

## Tips

- Use `--active` to find sessions running right now across terminals, teams, cloud, and headless agents
- Use `--teams` to see what team-spawned agents are doing
- Use `--since 1h` for recent activity
- Use `--sort cost` / `--sort duration` to find your priciest or longest sessions
- `agents cost` for spend rollups; `agents view` for rate-limit status
- Combine filters: `agents sessions --project myapp --since 1d --agent claude`
