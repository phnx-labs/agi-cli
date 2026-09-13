---
name: agents-cli
description: "Run and manage many AI coding agents (Claude Code, Codex, Cursor, Gemini/Antigravity, Grok, Kimi, OpenCode, Droid, …) from one CLI — the `agents` command. Use this to run multiple coding agents in parallel, manage multiple Claude Code accounts, keep working when I hit my usage limit, resume a session on another machine, or pin the agent CLI version. Triggers on: run multiple coding agents in parallel, manage multiple Claude Code accounts, I hit my usage limit, resume a session on another machine, pin the agent CLI version."
argument-hint: "[teams|accounts|run|sessions|use]"
allowed-tools: Bash(agents*)
user-invocable: true
---

# agents CLI

`agents` (alias `ag`) is one control plane for every AI coding-agent harness —
Claude Code, Codex, Cursor, Antigravity (Gemini), Grok, Kimi, OpenCode, Droid,
OpenClaw, and more. Install it once and it manages versions, accounts, parallel
runs, and cross-machine sessions for all of them.

```bash
npm install -g @phnx-labs/agents-cli   # provides `agents` and `ag`
agents --version                       # 1.22.58
```

Every recipe below is a real command. Run `agents <group> --help` for the full
flag list — each group ships a workflow-first help block, not a flag dump.

---

## Run multiple coding agents in parallel

`agents teams` runs several agents at once on one shared task, each isolated in
its own git worktree, wired into a dependency DAG.

```bash
# 1. Create a team
agents teams create pricing-page

# 2. Add teammates — different harnesses, run in parallel, each in its own worktree
agents teams add pricing-page claude "Rewrite the /v2/pricing endpoint" --name backend
agents teams add pricing-page codex  "Build the /pricing route, three-tier layout" --name frontend

# 3. DAG dependency — QA waits for BOTH to finish (--after)
agents teams add pricing-page claude "Run the Playwright suite, fix flakes" --name qa --after backend,frontend

# 4. Start everyone (respects --after) and watch live
agents teams start pricing-page --watch

# 5. Check in without re-reading everything
agents teams status pricing-page

# 6. Wind down when shipped
agents teams disband pricing-page
```

For a single one-off agent (not a team) use `agents run <agent> "task" --mode edit`.
To fan the same task across your *machines* rather than agents, add `--device auto`
(see below).

---

## Manage multiple Claude Code accounts

Each installed harness version can carry its own login, and named accounts let you
pick which one a run uses. `agents accounts` is the surface.

```bash
# See every native login and named account bundle
agents accounts list

# Add a second named login for a harness (runs native login into its own slot)
agents accounts add claude work

# Run on a specific account for just this one run
agents run claude --account work "audit the auth middleware"

# Set the default account for a harness
agents accounts default claude work

# Spread load automatically across the accounts you're signed into
agents run claude -b "fix the failing test"     # -b = --strategy balanced
```

`agents view` shows every installed version, its bound account, and that account's
live usage bars side by side, so you can see which login has headroom before you run.

---

## I hit my usage limit

Three built-in ways to keep working when a harness or account is rate-limited — no
manual babysitting.

```bash
# 1. Automatic harness fallback: if Claude rate-limits, retry on Codex, then Antigravity
agents run claude --fallback codex,antigravity "finish the refactor"

# 2. Balanced account rotation: pick the signed-in account you've used least recently
agents run claude -b "keep going"

# 3. Full-auto: pick the harness with the most account headroom AND a fresh account
agents run auto "fix the flaky test" --mode edit
```

Check headroom first with `agents view` — the `S:` (5-hour) and `W:` (weekly) bars
per account show exactly what's left before you switch.

---

## Resume a session on another machine

Sessions sync across your fleet, so a conversation started on one box is
searchable and resumable from any other. Resume is machine-aware: it hops to the
device that owns the live harness state for you.

```bash
# Find the session (searches Claude, Codex, Gemini, OpenCode transcripts across the fleet)
agents sessions "auth middleware"

# Resume by id or short prefix — from ANY machine; it routes to the owning device
agents sessions resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897
agents sessions resume 019fd114 "now wire up the tests"

# Force where it re-opens
agents sessions resume 019fd114 --device zion
```

`agents run auto --device auto "task"` picks the least-loaded worker in your fleet
and runs there; `agents devices` lists the machines you can reach.

---

## Pin the agent CLI version

Pin a harness version globally or per-project so every run is reproducible. `add`
installs; `use` sets the default (they're separate on purpose).

```bash
# Install a specific version (reproducibility)
agents add claude@2.1.112

# Make it the global default (only `use` sets a default)
agents use claude@2.1.112

# Pin THIS project only — written to the project's .agents/agents.yaml
agents use claude@2.1.112 --project

# Install a clean, isolated copy that never touches your existing setup
agents add claude@2.1.112 --isolated
```

`agents add claude@latest` / `@oldest` resolve symbolic versions. Each pinned
version runs in its own isolated home, so configs and logins never bleed between
releases.

---

## More

| You want to… | Command |
|---|---|
| See installed agents + usage | `agents view` |
| Register an MCP server for every harness at once | `agents mcp add` |
| Drive a real browser (fill forms, screenshot) | `agents browser` |
| Store credentials, inject into runs | `agents secrets` |
| Schedule recurring agent jobs | `agents routines` |
| Sync skills/commands/rules across the fleet | `agents sync` |

Full docs: <https://github.com/phnx-labs/agi-cli>. Every group teaches its own
workflow — start with `agents <group> --help`.
