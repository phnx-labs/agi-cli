---
name: teams
description: "Organize AI coding agents into teams that collaborate on a shared task. Create teams, add teammates, start them, monitor progress, and collect results. Use this skill when you need parallel agent execution. For single-agent dispatch, use `agents run` instead."
argument-hint: "[create|add|start|status|disband]"
allowed-tools: Bash(agents teams*), Bash(agents run*), Bash(agents feed*), Bash(agents send*)
user-invocable: true
---

# Teams Skill

Organize AI coding agents into teams for parallel collaboration. This skill teaches you how to use the `agents teams` CLI.

## Single Agent vs Teams

- **Single agent**: Use `agents run <agent> "prompt" --mode edit` for one-off tasks
- **Multiple agents**: Use `agents teams` when you need parallel execution

## Quick Start

```bash
# Create a team
agents teams create my-feature

# Add teammates
agents teams add my-feature claude "Implement the auth middleware" --name auth
agents teams add my-feature codex "Build the login UI" --name frontend

# Start the team
agents teams start my-feature --watch
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `create` | Start a new team | `agents teams create my-team` |
| `add` | Add a teammate | `agents teams add my-team claude "Task" --name role` |
| `start` | Launch pending teammates | `agents teams start my-team --watch` |
| `status` | Check who's working | `agents teams status my-team` |
| `logs` | Read teammate output | `agents teams logs my-team frontend` |
| `remove` | Remove a teammate | `agents teams remove my-team frontend` |
| `disband` | Stop all and remove | `agents teams disband my-team` |
| `doctor` | Check installed agents | `agents teams doctor` |

## DAG Dependencies

Use `--after` to create dependencies:

```bash
# Backend first
agents teams add my-feature claude "Build API" --name backend

# Frontend waits for backend
agents teams add my-feature codex "Build UI" --name frontend --after backend

# QA waits for both
agents teams add my-feature claude "Run tests" --name qa --after backend,frontend

# Start drains the DAG automatically
agents teams start my-feature --watch
```

## Distributed Teams (teammates on other machines)

Place teammates on **different machines** across your fleet (from `agents devices`)
instead of all on the box running `teams start`. One orchestrator still drives the
DAG, polls status, and cleans up — teammates just execute over SSH. One vocabulary —
`--device` / `--devices` only (`--host` / `--hosts` is an unknown option);
all optional (omit it and every teammate runs local, exactly as before).

```bash
# Send ONE teammate elsewhere — no pool needed
agents teams create feat
agents teams add feat claude "build the API" --name backend --device yosemite-s0
agents teams add feat claude "build the UI"  --name ui               # stays local
agents teams start feat --watch

# A device POOL — unpinned teammates auto-schedule across it (least-loaded)
agents teams create feat --devices zion,yosemite-s0 --repo https://github.com/you/repo.git
agents teams add feat claude "..." --name w1                         # auto-scheduled
agents teams add feat claude "..." --name w2 --device yosemite-s0    # or pin
```

**Where a teammate runs** — resolved at launch, top-down:

1. teammate `--device X` → **X** (explicit pin, no pool required)
2. else single-device pool → that device (whole team there)
3. else multi-device pool → **auto-scheduled** (least-loaded)
4. else → **local** (today's behavior)

- `--devices <list>` on `create` declares the pool; `--repo <url|path>` is how each
  device gets the code (defaults to the local checkout's `origin`, reused or cloned
  into `~/.agents/repos/<team>`). Per-teammate worktrees work over SSH too.
- `status` / `logs` show each teammate's host. **POSIX hosts only** in v1 (Windows
  hosts are rejected with a clear message).

## Placement & Repos (read before a distributed or worktree team)

The trap that turns one team into a teardown-and-rebuild — get these right up front:

1. **`--remote-cwd` does NOT place a teammate or set its repo.** It rides the shared
   `--device` flag family but `teams add` ignores it (and now **rejects** it with
   guidance). Place a teammate with `--device <host>`; the code comes from the
   team's `--repo`. There is **no per-teammate repo/path override** — don't reach
   for `--remote-cwd` to send one teammate to a different repo.

2. **One team = one repo.** A team's `--repo` is a single clone source shared by all
   its remote teammates; local teammates work in the checkout you run `add` from.
   Tasks spanning two repos → **one team per repo**, not a cross-repo team:

   ```bash
   agents teams create wave-cli  --repo ~/src/.../agents-cli --enable-worktrees
   agents teams create wave-mono --repo ~/src/.../monorepo   --enable-worktrees
   agents teams add  wave-cli claude "…" --name mcp --device yosemite-s0 --worktree mcp
   ```

3. **Worktree fork point differs by placement — and it bites.**
   - **local** teammate → forks from your **current local `HEAD`, with no fetch**.
     Fast-forward the checkout first (`git fetch && git merge --ff-only origin/<default>`)
     or every teammate forks off stale code.
   - **remote** (`--device`) teammate → forks from the host's **freshly-fetched
     `origin/<default>`** automatically — no manual sync needed.

4. **For a raw `--device` run (not teams), `--remote-cwd` resolves on the host.** Pass a
   single-quoted `'$HOME/…'` path (an unquoted `~` expands *locally* — `/Users/you`
   won't exist on a Linux worker) or a valid remote absolute path.

## Modes

| Mode | Use When |
|------|----------|
| `plan` (default) | Read-only work: research, audit, analysis |
| `edit` | Code changes: implementation, refactoring |

Always use `--mode plan` for security audits, research, and analysis.

## Monitoring

```bash
# Check status
agents teams status my-feature

# Delta poll (efficient)
agents teams status my-feature --since 2026-04-24T09:00:00-07:00

# Read one teammate's log
agents teams logs my-feature frontend
```

### Watch the fleet's comms

`agents teams status` tells you *where each teammate is*; `agents feed` tells you
*what they need from you*:

```bash
agents feed                  # open questions / blocks, with the reply command
```

Reply to a teammate with `agents teams message <team> <teammate> "…"`, or queue a
note in any running agent's mailbox with
`agents send --channel mailbox --to <session-id> --text "…"`.

## Best Practices

- **Mix agents** if available — different agents have different blind spots
- **Use `--mode plan`** for read-only work (audits, research)
- **Give full context** — each teammate needs the big picture plus their specific task
- **Demand evidence** — end prompts with: `Return file:line quotes for every claim`
- **Run in parallel** — most tasks don't depend on each other
- **Name teammates** with `--name` for easy reference

## Budget Guardrails

Teammates **inherit the project's budget caps** from `agents.yaml` (see
[docs/observability.md](../../docs/observability.md#budget-guardrails-agents-budget)).
Before each teammate launches, its estimated cost is projected onto current
spend; under `on_exceed: block`, a teammate that would breach a cap is
**refused** (the spawn fails with `[budget] BLOCKED teammate …`). Caps are
**cross-vendor**: a Claude teammate and a Codex teammate draw down the *same*
`per_project` / `per_day` pool — one budget governs the whole team.

Teammate budgeting is **pre-flight only** in v1 — a teammate is estimated and
blocked *before* it spawns, but there is **no live mid-run hard-cap kill** for
teammates (that applies to local headless `agents run` today; teams is a planned
follow-up).

```yaml
# project agents.yaml
budget:
  per_project: 100.00   # shared by every teammate, regardless of agent
  on_exceed: block
```

Check spend-to-cap any time with `agents budget`.

## Short Aliases

```
teams c  = create    teams a  = add       teams s  = status
teams rm = remove    teams d  = disband   teams ls = list
```
