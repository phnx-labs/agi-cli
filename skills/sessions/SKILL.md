---
name: sessions
description: "Search, browse, and read agent conversation transcripts across Claude, Codex, Gemini, and OpenCode. Use this skill to find previous sessions, recover context, or inspect what agents have done."
argument-hint: "[search query or session ID]"
allowed-tools: Bash(sessions*), Bash(agents ps*), Bash(agents insights*), Bash(agents events*)
user-invocable: true
---

# Sessions Skill

Search and browse agent conversation transcripts. This skill teaches you how to use the standalone `sessions` CLI (`@phnx-labs/sessions-cli`) effectively. `agents sessions` was removed; running sessions are `agents ps`, and resuming one is `agents run auto --resume <id>`.

## Basic Usage

```bash
# Interactive picker: browse and search recent sessions
sessions

# List sessions from current project
sessions | head -20

# Search sessions by text
sessions "add auth middleware"

# Filter by project across all directories
sessions --project agents-cli --all
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
| `--teams` | `--teams` | Include team-spawned sessions |

## Reading Sessions

```bash
# Render session as markdown
sessions --markdown <session-id>

# Output as JSON
sessions --json <session-id>

# Include only specific roles
sessions --markdown --include user,assistant <session-id>

# Show only first/last N turns
sessions --markdown --last 10 <session-id>
```

## Artifacts

```bash
# List all files written or edited during a session
sessions artifacts <session-id>

# Read a specific artifact
sessions artifacts <session-id> <filename>
```

## Live Tailing

```bash
# Live-tail a session file (Claude and Codex only)
sessions tail <session-id>
# Press Ctrl+C to stop

# Or the unified viewer: resolves a session id OR a host-dispatch run (from
# `agents run --device`), and -f follows either (a session tail here is
# `sessions tail` under the hood)
agents events logs <id>      # show it
agents events logs -f <id>   # follow it
```

## Cost & Duration

Every session is priced offline at scan time (`costUsd`) and its wall-clock
runtime is stored (`durationMs`). Both appear in `--json` output, and the list
can be sorted by either.

```bash
# The 10 most expensive sessions, anywhere
sessions --all --sort cost --limit 10

# Longest-running sessions in this project
sessions --sort duration

# Per-session cost in JSON
sessions --all --sort cost --json | jq '.[] | {shortId, agent, costUsd, durationMs}'
```

Use `agents insights cost` for a rollup (daily $ histogram, top sessions,
per-agent/project/day breakdown):

```bash
agents insights cost                  # daily histogram + top sessions + per-agent breakdown
agents insights cost --since 30d       # last 30 days
agents insights cost --by project      # group by project instead of agent
agents insights cost --by day --json   # machine-readable daily rollup
```

`agents insights cost` answers "how much did this cost?"; `agents view` answers "how
much quota / rate limit is left?" — different commands.

## Tips

- Use `agents ps` to find sessions running right now across terminals, teams, cloud, and headless agents
- Use `--teams` to see what team-spawned agents are doing
- Use `--since 1h` for recent activity
- Use `--sort cost` / `--sort duration` to find your priciest or longest sessions
- `agents insights cost` for spend rollups; `agents view` for rate-limit status
- Combine filters: `sessions --project myapp --since 1d --agent claude`
