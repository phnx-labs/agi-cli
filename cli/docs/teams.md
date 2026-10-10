<!-- guide -->
# Teams

Coordinate multiple AI agents working in parallel on a shared task, with DAG-based dependency scheduling and live status tracking.

## Overview

`agents teams` groups agent processes into a named team. Each teammate runs
in the background — Claude, Codex, Cursor, OpenCode, Grok, or
Antigravity — against the same working directory or a dedicated git worktree.
Teammates can declare `--after` dependencies, forming a directed acyclic graph
(DAG) that the supervisor drains wave by wave. The state machine lives on disk
so the supervisor can be restarted mid-flight without losing work, and
teammates added by other processes (including agents themselves) are picked up
on the next wave.

## Architecture

```
CLI invocations                  Supervisor                   Agent processes
(agents teams add ...)           (teams start --watch)        (claude, codex, ...)

user
  │
  ├─ create team ─────────────▶  registry                     ~/.agents/.history/
  │   (registry.ts)                teams/<name>.yaml            teams/agents/
  │                                                               <uuid>/
  ├─ add teammate ─────────────▶  meta.json (PENDING)           │  meta.json
  │   (api.ts: handleSpawn)         status, prompt, after        │  stdout.log
  │                                                               │  pid
  ├─ add teammate --after bob ─▶  meta.json (PENDING)            │
  │                                                              ...
  └─ teams start --watch ──────▶  runSupervisor() loop
                                   │
                                   ├── rescanFromDisk()
                                   ├── startReady(team)
                                   │    ── resolve deps
                                   │    ── spawn ready agents
                                   ├── listByTask(team)
                                   │    ── count pending/running/done/failed
                                   ├── onWave(summary)
                                   │    ── print or emit JSON
                                   ├── wait intervalMs
                                   └── repeat until drained
```

Teammate state transitions (from `src/lib/teams/agents.ts:113-117`):

```
PENDING ──deps resolved──▶ spawned ──▶ RUNNING ──exit 0──▶ COMPLETED
                                                └─exit ≠0──▶ FAILED
                                                └─stop cmd──▶ STOPPED
```

## Command Reference

| Command | Alias | Description |
|---|---|---|
| `agents teams list [query]` | `ls` | List teams, most recent first |
| `agents teams create <team>` | `c`, `new` | Create a new team |
| `agents teams add <team> <agent> <task>` | `a` | Add a teammate |
| `agents teams status [team]` | `s`, `st`, `check` | Check team progress |
| `agents teams active` | — | All teammates running right now, across all teams |
| `agents teams start [team]` | — | Launch pending teammates whose deps are satisfied |
| `agents teams pr-watch [team]` | — | Watch the PRs a team opened: red CI spawns a fix teammate, a new review comment routes a bugfix teammate |
| `agents teams message <team> <teammate> <message>` | — | Send a follow-up: steers a running teammate via its mailbox, resumes a stopped one |
| `agents teams resume <team> <teammate> [message]` | — | Resume a stopped teammate (re-enter its own session with the message) |
| `agents teams stop [team] [teammate]` | — | Stop a running teammate (resume it later with `teams resume`) |
| `agents teams remove [team] [teammate]` | `rm` | Remove a stopped teammate's logs and metadata |
| `agents teams disband [team]` | `d` | Stop all teammates and delete the team |
| `agents teams logs [teammate]` | `log` | Show a teammate's concise session summary (`--full` or `-n` for raw stdout) |
| `agents teams doctor` | `dr` | Check which agent CLIs are installed |

### `teams list` options

`agents teams list` renders from the cached team registry and teammate `meta.json`
records. It does not poll remote hosts or read teammate logs while listing; choosing
a team or running `agents teams status <team>` performs the full status read.

| Flag | Description |
|---|---|
| `-a, --agent <agent>` | Filter to teams containing this agent (e.g. `claude` or `claude@2.1.112`) |
| `--status <status>` | Filter by team status: `working`, `done`, `stranded`, `failed`, `empty` |
| `--since <time>` | Teams active after this time (e.g. `2h`, `7d`, ISO date) |
| `--until <time>` | Teams active before this time |
| `-n, --limit <n>` | Max results (default 20) |
| `--json` | Machine-readable JSON |

### `teams create` options

| Flag | Description |
|---|---|
| `-d, --description <text>` | One-line summary of what this team is working on |
| `--enable-worktrees` | Each teammate works in its own git worktree |
| `--use-worktree <path>` | All teammates share this existing worktree path |
| `--devices <a,b,c>` | Distributed teams: pool of machines the team may run teammates on. See [Distributed teams](#distributed-teams). |
| `--repo <url\|path>` | How each **remote** (`--device`) teammate gets the code — one git URL/path for the whole team. Defaults to the local checkout's `origin`. **A team is single-repo:** for work spanning repos, make one team per repo. See [Placement & repos](#placement-and-repos). |
| `--project <slug>` | Work the team on a defined project (`agents projects`). Its primary directory becomes each local teammate's base cwd; its other bound directories are attached as `--add-dir` grants. Validated at create time, so a slug that does not resolve fails here rather than at the first `teams add`. |
| `--json` | Machine-readable JSON |

**`--project` vs `--repo`.** They answer different questions and compose. `--repo` is
*how a remote teammate gets the code* (clone URL / path on the host). `--project` is
*which directories a teammate can reach* — a project may bind several checkouts, and
the sibling ones ride along as access grants. A teammate's cwd resolves
`worktree → --cwd → the project's primary directory → the current directory`, so an
explicit `--cwd` or `--worktree` still wins; the grants are attached either way.
Claude, Codex, Cursor, Kimi, and Grok consume `--add-dir` — other harnesses see the cwd alone. Full
detail: [Projects](projects.md#a-project-is-a-set-of-directories).

### Placement and repos

*The part people get wrong* — the trap that turns one team into a teardown-and-rebuild.

**`--remote-cwd` does NOT place a teammate or set its repo.** It rides the shared
`--device` option family but is ignored on `teams add` (now **rejected** with
guidance, so you find out at once instead of after building a whole team on the
wrong model). A teammate's directory is the team's repo plus its `--worktree` —
there is no per-teammate repo/path override. Place with `--device <host>`; set
the code with the team's `--repo`.

**A team's `--repo` is one clone source** shared by all its remote teammates
(local teammates work in the checkout you run `add` from). If your tasks span two
repos (e.g. `agents-cli` + a monorepo), create **one team per repo** rather than
one team you tear down and rebuild:

```bash
agents teams create wave-cli  --repo ~/src/.../agents-cli --enable-worktrees
agents teams create wave-mono --repo ~/src/.../monorepo   --enable-worktrees
agents teams add  wave-cli claude "…" --name mcp --device yosemite-s0 --worktree mcp
```

For a **raw `--device` run** (not teams), `--remote-cwd` resolves on the host and is
used verbatim: pass a single-quoted `'$HOME/…'` path (an unquoted `~` expands
*locally* — `/Users/you` won't exist on a Linux worker) or a valid remote absolute
path. `--cwd` is the friendlier option — it re-roots a local-home path onto the
remote home for you.

### `teams add` options

| Flag | Description |
|---|---|
| `-n, --name <name>` | Friendly name (required when using `--after`) |
| `-m, --mode <mode>` | `plan` (read-only) \| `edit` (write files) \| `auto` (more autonomous than edit, per-harness) \| `skip` (bypass all permission prompts; `full` is an alias). Default: `edit`. kimi/grok/antigravity have no headless plan mode and downgrade `plan` to `auto` |
| `-e, --effort <effort>` | `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `auto`. Default: `medium` |
| `--model <model>` | Cost tier (`cheap`\|`default`\|`best`\|`ultra`) or a concrete id (e.g. `claude-opus-4-8`); tiers resolve per harness+version to a supported model. See Model tiers. |
| `--env <key=value>` | Set an env var for this teammate (repeatable) |
| `--cwd <dir>` | Working directory (default: current directory) |
| `--worktree <name>` | Run in a dedicated git worktree (requires `--enable-worktrees` on the team) |
| `--device <host>` | Distributed teams: run THIS teammate on `<host>`. Works with or without a team pool. `<host>` may also be `auto` (RUSH-2185) to affinity-pick a device the same way `agents run --device auto` does — a pick that lands on this machine just runs the teammate locally, same as omitting `--device`. See [Distributed teams](#distributed-teams). |
| `--after <names>` | Comma-separated teammate names to wait for before starting |
| `--task-type <type>` | Factory label: `plan` \| `implement` \| `test` \| `review` \| `bugfix` \| `docs` |
| `--cloud <provider>` | Dispatch to cloud backend: `rush` \| `codex` \| `factory` |
| `--repo <owner/repo>` | GitHub repository (required for `--cloud rush`) |
| `--branch <name>` | Target branch for cloud dispatch |
| `--force` | Skip the advisory "may not be signed in" / "account throttled" warnings |
| `--confirm` | Proceed even when the base checkout/repo is behind `origin/main`. Without it, a stale base [blocks the add](#stale-repo-guard). |
| `--json` | Machine-readable JSON |

### Stale-repo guard

Before a teammate is bound to a repo, `teams add` fetches `origin` and checks how
far behind `origin/<default>` the **base checkout** is — the local `--cwd` (default
current directory) for a local teammate, or the repo provisioned on the box for a
`--device` teammate. If it is behind, the add is **refused** with a sync command,
because a team started on stale code reasons and builds against a tree that has
already moved on (the real trigger: a 71-commit-stale checkout on another box that
nobody had fetched):

```
This checkout (/repo) is 71 commits behind origin/main. A team started here would
build on stale code — bring it up to date with remote main first:
  git -C /repo merge --ff-only origin/main
Then re-run `agents teams add wave …`, or pass --confirm to start on the stale repo anyway.
```

Sync the base to `origin/main` and re-run, or pass `--confirm` to start against it
anyway (you then get a one-line advisory instead of a block). The check **fetches
first** on purpose: a checkout nobody fetched has a stale remote-tracking ref, so a
naive `HEAD..origin/main` would read 0 and hide the drift. An offline / unreachable
/ non-git base can't be assessed and never blocks; cloud teammates clone fresh in
the provider and are skipped. This is independent of the [worktree base
freshness](#base-freshness) below — a `--worktree` teammate still forks off a
freshly-fetched `origin/<default>` regardless, but the guard flags the base you
pointed the team at so you keep it in sync.

### `teams start` options

| Flag | Description |
|---|---|
| `--watch` | Keep polling; fire new waves as deps complete; exit when DAG drains |
| `--interval <seconds>` | Seconds between waves in `--watch` mode (default 8) |
| `--max-waves <n>` | Safety cap on waves (default 1000) |
| `--force` | Skip the advisory "may not be signed in" / "account throttled" warnings for staged teammates |
| `--json` | Emit one JSON object per wave |

### `teams status` options

| Flag | Description |
|---|---|
| `-f, --filter <state>` | Show teammates in state: `running`, `completed`, `failed`, `stopped`, `all` (default: `all`) |
| `-s, --since <iso>` | Cursor from a previous status call; only show updates after this timestamp |
| `--agent-id <id>` | Show only this teammate (UUID or UUID prefix) |
| `--parent-session <id>` | Show the teammates spawned by this session, across teams |
| `-v, --verbose` | Emit full per-teammate detail (prompt, all paths, all messages); default is compact |
| `--json` | Machine-readable JSON (compact by default; pair with `--verbose` for the full shape) |

### `teams logs` options

| Flag | Description |
|---|---|
| `-n, --tail <n>` | Last N lines of raw stdout instead of the summary |
| `-m, --full` | Full raw stdout instead of the summary |
| `--teammate <name>` | Teammate name (alias for the positional argument) |
| `--team <team>` | Disambiguate when the same name appears in multiple teams |

## Resuming a teammate

A teammate often ends its turn with more to do — a PR opened and waiting on review,
a headless run that hit a turn cap, a task you want to redirect after the fact.
`agents teams resume` re-enters that teammate's **own** session with your message as
the next user turn, so it picks up with full context instead of you finishing the
work by hand or spawning a fresh, context-less teammate.

```bash
# A teammate finished with its PR open, waiting on review. Nudge it home:
agents teams resume my-team backend "prix-cloud approved — rebase-merge the PR, then cut the release"
```

`teams message` is the same command with automatic routing by the teammate's current
state:

| Teammate state | What happens |
|---|---|
| running | The message is **steered** into its mailbox and delivered at its next tool call (no re-launch). |
| completed / failed / stopped | The teammate is **resumed** — its session is re-entered with the message. |
| pending (unmet `--after`) | Rejected — run `teams start` to launch it first. |

The teammate re-launches through the same backend it first used (local process or
remote host) in its original working directory / worktree, and flips back to
`running` so `teams status` tracks it live again.

**Every harness.** The resume delegates to `agents run <agent> --resume <id>`, so it inherits that
command's coverage: native resume for Claude (`--resume`) and Codex (`resume`), and a
universal `/continue` replay for the rest (OpenCode, Grok, Kimi, …). The session id it
resumes is the teammate's underlying agent session — captured from the agent's own
output — so a non-Claude teammate that died before emitting its first event (no
captured id) is refused with a clear message rather than resumed into a fresh run.

## Boundary Contracts

Boundary contracts are the core correctness mechanism for parallel teams. Every
time you spawn teammates that touch the same codebase, you must declare what
each one owns, what it must not touch, and which shared artifacts one teammate
produces for others to consume.

The format:

```
Owns       — explicit files (with line ranges where helpful)
Must NOT   — files owned by others
Shared deps — one canonical owner; everyone else imports
```

The **independence test**: if teammate A must wait for teammate B's output
before A can start work, the boundary is wrong. Re-cut the split so each
teammate can start from the same baseline, or sequence them explicitly with
`--after`.

### Why this matters

Teammates coordinate via git and the filesystem only. There is no direct
peer-to-peer communication at runtime. The boundary contract is the only
coordination mechanism that runs before the agents start — once they are
running, violations (two agents editing the same file) cause merge conflicts,
test failures, or silent data loss.

### Contract in practice

Before spawning a team, write out the distribution plan:

```
auth teammate  — owns src/auth/* (all files)
               — must NOT touch src/ui/*, src/api/*
               — produces: src/auth/types.ts (shared dep)

ui teammate    — owns src/ui/login.tsx
               — must NOT touch src/auth/*
               — imports: src/auth/types.ts (read-only)
               — must NOT start until auth is done (use --after auth)
```

The `--after` flag enforces temporal ordering. Without `--after`, both
teammates start on wave 1 and race. Without a boundary contract, they race
invisibly — the contract makes the race explicit so you can cut it correctly.

<a id="base-freshness"></a>
### Worktrees and isolation

When hard filesystem isolation is required, use git worktrees:

```bash
agents teams create my-feature --enable-worktrees
agents teams add my-feature claude "..." --name alice --worktree feature-alice
agents teams add my-feature codex  "..." --name bob   --worktree feature-bob
```

Each teammate gets its own checkout of the branch. Worktrees are cleaned up on
`teams stop` or `teams disband` unless uncommitted changes are present, in
which case the worktree is kept and reported.

**What the worktree forks from** differs by placement, and the difference bites:

| Teammate | Base of the new worktree branch |
|---|---|
| **local** (no `--device`) | the **freshly-fetched `origin/<default>`** (`createWorktree` runs `git fetch origin` then bases the branch on `origin/<default>` — never local `HEAD`). |
| **remote** (`--device host`) | the host's **freshly-fetched `origin/<default>`** (`createRemoteWorktree` fetches first) — same base policy as local. |

So the pre-flight for a **local** worktree team is: fast-forward your checkout to
the default branch first. A remote team handles this itself. The
[stale-repo guard](#stale-repo-guard) now enforces this pre-flight — it blocks a
`teams add` whose base checkout is behind `origin/<default>` until you sync or pass
`--confirm`.

**Where a local worktree lands.** A new teammate worktree always resolves to
`<main-repo-root>/.agents/worktrees/<name>` — the MAIN checkout's root, never
wherever `--worktree` happened to be invoked from. `createWorktree` resolves the
placement root via `getMainRepoRoot` (a `git rev-parse --git-common-dir` lookup,
not `--show-toplevel`), so running `agents teams add` from inside a *different*
teammate's own worktree — e.g. one agent orchestrating another — still places the
new worktree as a sibling under the main repo, never nested inside the caller's
worktree.

**A failed `teams add` leaves nothing behind.** The branch is the shared resource
here, so a half-finished add used to poison every retry: the worktree was created
before the teammate record was written, and nothing removed it when the add
failed, so the next `teams add` with the same `--worktree` name died on
`fatal: a branch named 'agents/<name>' already exists`. Two guarantees now hold:

- **Rejected before anything is created.** Name uniqueness and the `--after`
  dependency graph are validated *before* `createWorktree` runs
  (`AgentManager.validateAddPreconditions`), so a duplicate name, an unknown
  dependency, or a cycle never gets as far as making a branch.
- **Torn down if it fails afterward.** A failure past that point — the harness CLI
  missing, a launch error, a cloud dispatch failure, or a `git worktree add` that
  created the branch ref but not the checkout — removes the worktree *and* its
  `agents/<name>` branch before the command exits non-zero.

Teardown is scoped twice, because removing a live teammate's worktree would
destroy real work rather than protect a retry:

| Guard | Why |
|---|---|
| Only a worktree **this add created** | A shared `--use-worktree` checkout and a `--device` teammate's remote worktree are never candidates — this add didn't create either. |
| Only when **no live teammate claims it** (`AgentManager.isWorktreeClaimed`) | The add can fail *after* the record is durably saved: `spawn()` writes a staged teammate's `meta.json` and only then runs the retention pass, which refreshes every sibling's status and can throw on a distributed one. That teammate exists and is merely pending its `--after` dependency, so it keeps its worktree. The check spans **every team**, since worktree names are global to the repo while records are per-team, and counts only **non-terminal** records — a stopped teammate's worktree is already gone, so its lingering record must not strand the branch. |

If we cannot prove a worktree is an orphan, it is left in place and the command
prints the exact `git worktree remove` / `git branch -D` pair to run — a stranded
branch is recoverable, a deleted worktree is not.

An unreadable `meta.json` is what makes the check fail closed in the first place,
so it must not be a *permanent* state. `saveMeta()` writes via a sibling tmp file
+ `fs.rename`, atomic on POSIX, so a process killed mid-write can never leave a
torn record. If an unreadable `meta.json` is found anyway (e.g. one written before
this fix), `loadFromDisk()` quarantines it — renaming it to `meta.json.corrupt`
with a warning — so it stops being mistaken for "no record" and a later
`isWorktreeClaimed` scan sees genuine absence instead of failing closed on it
forever (RUSH-2429).

Either way the add exits non-zero with the real error and never prints a success
block, and re-running the same command with the same name works.

## Distributed teams

Teammates can run on **different machines** across your fleet, not just the box
running `teams start`. One orchestrator still drives the DAG, polls status, and
cleans up — teammates just execute over SSH on their assigned host (via the same
device registry as `agents devices` / `agents ssh`).

There is one vocabulary — `--device` / `--devices` — and everything is optional;
omit it all and teams behave exactly as before (every teammate local).

**Send one teammate elsewhere** — no pool needed:

```bash
agents teams create feat
agents teams add feat claude "build the API"  --name backend --device yosemite-s0
agents teams add feat claude "build the UI"   --name ui         # stays local
agents teams start feat --watch
```

**A distributed team with a device pool** — unpinned teammates auto-schedule:

```bash
agents teams create feat --devices zion,yosemite-s0,yosemite-s1 \
  --repo https://github.com/you/your-repo.git
agents teams add feat claude "..." --name w1                    # auto-scheduled (best viable device)
agents teams add feat claude "..." --name w2 --device yosemite-s1   # or pin
agents teams start feat --watch
```

**Where a teammate runs** — resolved at launch, top-down:

1. teammate has `--device X` → **X** (explicit pin — no pool required, never second-guessed)
2. else the team pool is a **single** device → that device (whole team there)
3. else the team pool has **many** devices → **auto-scheduled** (best viable device)
4. else (no pin, no pool) → **local**, exactly like today

**Auto-scheduling is health-, harness-, and load-aware (RUSH-2002).** At
`teams start` the pool is probed once (reachability + load via the same snapshot
`agents devices` shows, plus whether the teammate's agent is installed there), and
the pick:

- **excludes** an unreachable device, an overloaded one (`loaded` headroom), a
  device at its `agents.max-concurrent` cap, and one the agent is not installed on;
- **ranks** the survivors by (a) agent installed **and signed in**, (b) lower load
  (idle beats busy), (c) fewer running teammates on that device.

If **no** pool device can run a pending teammate's agent, `teams start` **fails
loud** — e.g. `No device in the team pool can run claude@2.1.112. Run 'agents
devices ping' to see which devices have the agent installed + signed in.` —
instead of stranding the teammate; it never silently falls back to a local run you
did not ask for. A probe that simply
could not reach the pool (no positive evidence) does **not** trigger the failure —
the real error then surfaces at the SSH dispatch. Set a per-device cap with
`agents devices config <name> agents.max-concurrent N`.

**Repo provisioning.** The team's `--repo` (defaulting to the local checkout's
`origin`) is used to ensure the code is present on each device — an existing
checkout is reused, otherwise it is cloned into `~/.agents/repos/<team>`. With
`--enable-worktrees`, each remote teammate also gets its own worktree on the host,
branched off the freshly-fetched default branch, and cleaned up on stop/disband.

`--repo` is **one** clone source for the whole team — see
[Placement & repos](#placement-and-repos). Tasks spanning two repos need two teams
(e.g. `wave-cli --repo …/agents-cli` and `wave-mono --repo …/monorepo`), each
teammate placed with its own `--device`. Don't try to point individual teammates
at different repos with `--remote-cwd` — that flag has no effect on `teams add`.

`teams status` and `teams logs` show which host each teammate is on and stream its
output back (the local log mirror is capped so a large fleet can't blow up the
orchestrator). **v1 note:** remote teammates require a POSIX host (Linux/macOS);
Windows hosts are rejected with a clear message.

## Recipes

### 1. Two-teammate parallel docs job

```bash
agents teams create docs-update

agents teams add docs-update claude \
  "Rewrite docs/api.md — cover every endpoint in src/routes/" \
  --name api-docs --mode plan

agents teams add docs-update codex \
  "Update docs/config.md — document every option in src/config.ts" \
  --name config-docs --mode plan

# Both start immediately (no --after)
agents teams start docs-update
agents teams status docs-update
```

### 2. DAG with --after dependency

```bash
agents teams create pricing-page

agents teams add pricing-page claude \
  "Rewrite /v2/pricing endpoint" --name backend

agents teams add pricing-page codex \
  "Build /pricing route with three-tier layout" --name frontend

# QA waits for both
agents teams add pricing-page claude \
  "Run Playwright suite, fix flakes" --name qa --after backend,frontend

# Watch mode — supervisor fires QA when backend AND frontend complete
agents teams start pricing-page --watch
```

A staged (`--after`) teammate is durable while it waits: retention only ever
reaps a teammate that has actually **finished** (completed/failed/stopped), so a
`pending` teammate parked on an unmet dependency is never cleaned up, however
deep the machine's history of past runs goes.

### 3. Cloud dispatch for one teammate

```bash
agents teams create backend-fix

agents teams add backend-fix claude \
  "Fix the flaky payment test" --name fixer \
  --cloud rush --repo acme/monorepo --branch main

agents teams start backend-fix
agents teams status backend-fix
```

### 4. Git worktree per teammate

```bash
agents teams create parallel-refactor --enable-worktrees

agents teams add parallel-refactor claude \
  "Refactor auth module" --name auth \
  --worktree refactor-auth --name auth

agents teams add parallel-refactor codex \
  "Refactor billing module" --name billing \
  --worktree refactor-billing

agents teams start parallel-refactor --watch
```

### 5. Monitor with --watch and inspect JSON per wave

```bash
# Watch mode, one JSON line per wave — pipe to jq for dashboards
agents teams start my-team --watch --json | \
  jq '{ wave, launched, pending, running, completed, failed }'
```

### 6. Inspect team state via JSON

```bash
# Compact status as JSON (default; drops prompt, folds file paths to basenames)
agents teams status my-team --json

# Full status as JSON (legacy shape — prompt, all paths, all messages)
agents teams status my-team --json --verbose

# All teams as JSON
agents teams list --json
```

## Budget Guardrails

Teammates **inherit the project's budget caps** (the `budget:` block in
`agents.yaml`, see below).
Before each teammate launches, its estimated cost is projected onto current
spend; under `on_exceed: block`, a teammate that would breach `per_run`,
`per_day`, `per_agent`, or `per_project` is **refused** and the spawn fails with
a `[budget] BLOCKED teammate …` error. Because the caps aggregate across
vendors, a Claude teammate and a Codex teammate draw down the *same*
`per_project` / `per_day` pool — one budget governs the whole team regardless of
which CLIs it uses.

Under `teams start --watch`, a live watcher also reads the usage events in each
teammate's stdout every wave; on the first cap breach the supervisor stops every
teammate in the team, prints `[budget] cap … exceeded … — stopping team <team>`,
and exits (`src/lib/budget/live-team.ts`, `src/lib/teams/supervisor.ts`). A
one-shot `teams start` (no `--watch`) gets only the pre-flight check.

Set caps in the project's `agents.yaml`:

```yaml
budget:
  per_project: 100.00   # the whole team shares this
  on_exceed: block
```

## See Also

- [docs/concepts.md](./concepts.md) — DotAgents repos, resource resolution model
- [docs/cloud.md](./cloud.md) — cloud dispatch (`--cloud rush|codex|factory` on `teams add`)
