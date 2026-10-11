---
name: run
description: "Execute a single agent headlessly or interactively. Supports plan/edit/auto/skip modes, secrets bundle injection, version pinning, fallback chains, balanced rotation, profile dispatch (Kimi/DeepSeek/etc.), and workflow dispatch by name. Triggers on: 'run claude', 'run codex', 'agents run', 'dispatch an agent', 'headless agent', 'one-off agent task'."
argument-hint: "<agent|profile|workflow> [prompt]"
allowed-tools: Bash(agents run*)
user-invocable: true
---

# Run Skill

Dispatch a single agent for a one-off task. `agents run` is the fundamental command for interactive sessions and headless automation across Claude, Codex, Gemini, Cursor, OpenCode, and OpenClaw.

## Headless vs interactive

Explicit flags are definitive; otherwise the mode is inferred from prompt presence:

- `--interactive` (`-i`) → always interactive, even with a prompt (the prompt is forwarded as the first message).
- `--headless` → always headless, even with no prompt (the prompt is read from stdin).
- Neither flag, **prompt provided** → headless. Pipes stdout, no TTY, exits when the agent finishes.
- Neither flag, **prompt omitted** → interactive. Launches the agent's TUI with full stdio inheritance.

`--interactive` and `--headless` are mutually exclusive — passing both errors out.

```bash
# Interactive (TUI)
agents run claude

# Headless one-shot
agents run claude "summarize recent git commits"
```

## Modes

Permission mode controls what the agent can do.

| Mode | What it allows |
|------|----------------|
| `plan` (default) | Read-only — research, audit, analysis. No writes, no shell side-effects. |
| `edit` | Read + write files; prompts for shell / risky operations |
| `auto` | Harness-native automatic approval: Claude/Copilot use the smart classifier; Droid uses `--auto high`; Kimi uses `--auto` interactively, while headless `-p` already auto-approves and emits no mode flag. |
| `skip` | Last-resort bypass of every permission prompt. Direct exec uses the native unsafe flag; ACP selects a protocol permission option. `full` remains an alias. |

```bash
agents run claude "fix lint errors in src/" --mode edit
agents run claude "/code:commit" --mode auto          # run a command unattended, safely
```

**Treat `skip` as a last resort.** In direct-exec runs (without `--acp`), agents-cli
forwards the harness's native bypass flag; it does not add another safety layer. Prefer
`auto` where it adds a safer automatic policy (smart classifier on Claude/Copilot,
native high-auto mode on Droid, or interactive Kimi), or `edit` everywhere else.
For headless Kimi, `edit`, `auto`, and `skip` all use the same already-auto-approved
`-p` behavior, so prefer `edit` rather than signaling a blanket bypass.

| Harness | Direct-exec `--mode skip` becomes |
|---|---|
| Claude Code | `--dangerously-skip-permissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` (equivalent to `--yolo`) |
| Gemini | `--yolo` |
| Cursor | `-f` |
| OpenClaw | `--mode full` |
| GitHub Copilot | `--allow-all` (alias: `--yolo`) |
| Antigravity | `--dangerously-skip-permissions` |
| Grok | `--always-approve` |
| Kimi | `--yolo` interactively; no extra flag in headless `-p` runs, which already auto-approve |
| Droid | `--skip-permissions-unsafe` |

With `--acp`, these native flags are not used. agents-cli instead grants `skip`
permission requests at the ACP protocol layer: it selects `allow_always` when offered,
otherwise the first permission option offered by the server. The same last-resort
warning applies.

Codex has no native smart-classifier mode, so `agents run codex --mode auto` resolves
to sandboxed `edit` and can still prompt. `agents run codex --mode skip` instead
bypasses approvals **and** removes the sandbox. Harnesses without a native bypass flag
reject direct-exec `skip`.

**Headless runs need a non-`plan` mode to act.** The default `plan` is read-only, so an
action command (e.g. `/code:commit`) run headless would otherwise stall forever at
`ExitPlanMode` with no TTY to approve the plan. Running a slash command headless without
an explicit `--mode` is rejected up front with a fix; pick `--mode auto` (recommended),
`edit`, or `skip`. Pass `--mode plan` explicitly only when you genuinely want a read-only run.

**Agents without a read-only mode** (antigravity, cursor, …) cannot honor `plan`.
`agents run` degrades unsupported `plan` to the agent's safest native mode (usually
`edit`) and prints a warning — same idea as `auto` → `edit` on agents without a
classifier. Prefer an explicit `--mode edit` to silence the warning. `skip` still
hard-fails when the agent has no skip-permissions flag.

Note: `auto` and `skip` cannot be scoped to a directory — they are per-run modes, not
per-repo. To restrict no-prompt behavior to one repository, use that repo's
`.claude/settings.json` `permissions.allow`/`deny` rules (file rules are path-anchored;
deny always wins) rather than a blanket mode.

## Reasoning effort and model

```bash
# Reasoning effort (claude and codex only)
agents run claude "..." --effort high

# Override the model directly
agents run claude "..." --model claude-opus-4-7
```

`--effort` accepts `low | medium | high | xhigh | max | auto`.

## Secrets injection

Inject keychain-backed bundles as env vars at run time. Repeatable.

```bash
agents run claude "deploy the api" --secrets prod
agents run claude "..." --secrets prod --secrets stripe
```

Bundles resolve from macOS Keychain (no plaintext on disk). See the `secrets` skill for bundle management.

For workflows with a frontmatter `secrets:` field, declared bundles auto-inject. Pass `--no-auto-secrets` to skip.

## Pass env vars directly

```bash
agents run claude "..." --env DEBUG=1 --env API_KEY=xyz
```

## Run strategy

Controls which installed version/account gets the work.

| Strategy | Behavior |
|----------|----------|
| `pinned` | Use the workspace/global pinned version. A logged-out default yields to a signed-in sibling on this device instead of dying; `--strategy pinned` still forces a rate-limited default |
| `available` | Use pinned if it can run right now; otherwise switch to another signed-in version |
| `balanced` (default) | Distribute load across healthy accounts by remaining capacity |

```bash
agents run claude "..." --strategy balanced
agents run claude "..." -b                  # shortcut for --strategy balanced
```

Strategy is ignored when `@version` is pinned, a profile is used, or `--fallback` is set.

## Fallback chains

Retry on rate-limit by handing off to another agent via `/continue`.

```bash
agents run claude "..." --fallback codex,gemini
agents run claude "..." --fallback codex@0.116.0,gemini
```

Primary runs first; on rate-limit error, the next agent picks up.

## Profile dispatch

Run any OpenAI-compatible model (Kimi, DeepSeek, Qwen, etc.) through a host CLI by passing a profile name in the agent slot.

```bash
agents profiles add kimi          # kimi is a built-in preset (host + endpoint + model baked in)
agents run kimi "..."
```

The profile bundles host CLI + endpoint + model + auth. See `agents profiles --help`.

## Workflow dispatch

Pass a workflow name in the agent slot. agents-cli resolves the workflow directory (project > user > system), launches the host agent, and prepends `WORKFLOW.md` to the prompt as system instructions.

```bash
agents run code-review "review PR #42 on acme/api" --mode edit
```

A workflow's `tools:` and `mcpServers:` frontmatter now *scope the run* (Claude): `tools: [Read, Grep]` runs with `--tools Read Grep`, which restricts the available tool set — Write/Bash/Edit are unavailable in the session — and `mcpServers:` connects only the named registry servers via an ephemeral `--mcp-config` paired with `--strict-mcp-config`. Declarations on an agent without the allowlist capability warn rather than silently run unscoped.

See the `workflows` skill for authoring workflows.

## Pin version

```bash
agents run claude@2.1.143 "..."
```

## Resume a previous session (Claude only)

```bash
agents run claude --session-id <id>
```

## Output and observability

```bash
# Stream ndjson events for parsing
agents run claude "..." --json --quiet | jq

# Verbose execution logs
agents run claude "..." --verbose
```

`--quiet` drops the rotation banner and "Running:" preamble.

## Offload to another machine

`agents run --device <name>` runs the agent on a registered host over SSH instead
of locally (see the `devices` skill). It follows live by default; `--no-follow`
detaches and returns immediately.

```bash
agents run claude "profile this build" --device gpu-box   # follows live
agents run claude "..." --device gpu-box --no-follow       # detach

agents devices ps          # list dispatched runs
agents devices stop <id>   # terminate a hung/detached run (alias: kill)
agents events logs --device gpu-box   # pick a host-dispatch run
agents events logs <id> -f        # follow a host-task log
agents sessions <id>             # session transcript
```

Run options follow a strict forwarding contract on `--device` runs — nothing
silently drops at the SSH boundary:

- **Forwarded** (same behavior remote as local): `--mode --model --name
  --effort --env --add-dir --timeout --strategy/--balanced/--fallback`, the
  `--loop` family, `--json --verbose --yes --acp`, `--resume <id>`, and `--
  <passthrough>`.
- **Rejected loud** (exit non-zero before dispatch): `--secrets/--secrets-keys/
  --allow-expired` (Keychain values never cross SSH implicitly — provision with
  `agents secrets export --device` instead), bare `--resume` (the picker can't
  cross a detached dispatch — pass a concrete id),
  `--resume-checkpoint`.
- **Local-only** (consumed by the dispatching side): `--quiet --no-follow
  --cwd/--project/--remote-cwd --device/--any --lease`.

Hosts are also a task backend (`agents cloud run "…" --device <name>` — see the
`cloud` skill) and a routines placement target (`agents routines add …
--run-on <name>` — see the `routines` skill).

`agents events logs <id>` shows a dispatched run's output or a session transcript; `agents events` is the timeline.
`agents devices stop <id>` (alias `kill`) terminates the remote process group from
this machine without deleting the remote log.

### Working directory on the host

`--cwd` sets the directory the agent runs in **on the host** too — a home-anchored
path (`~/…`, `$HOME/…`, or a local-home absolute your shell already expanded like
`/Users/me/…`) is re-rooted at the *remote* `$HOME`, so it resolves across machines
with different home paths (`/Users/me` → `/home/me`):

```bash
agents run claude "..." --device gpu-box --cwd ~/src/github.com/me/app
#   → runs on gpu-box in $HOME/src/github.com/me/app
```

`-P, --project <slug>[@worktree]` is a shorthand: it resolves `<slug>` against your
projects root (auto-inferred from the repo you launch inside and cached in
`agents.yaml`, e.g. `~/src/github.com/<user>`), and `@worktree` targets a git
worktree under `.agents/worktrees/`:

```bash
agents run claude "..." --device gpu-box --project app          # → $HOME/…/app
agents run claude "..." --device gpu-box --project app@fix-bug  # → app/.agents/worktrees/fix-bug
agents defaults project-root ~/src/github.com/<user>          # set/show the root
```

`--remote-cwd <dir>` is the explicit escape hatch — a literal remote path, used
verbatim (not re-rooted). Precedence: `--remote-cwd` > `--project`/`--cwd`.

## Lease a disposable cloud box (`--lease`)

`agents run <agent> "<task>" --lease` runs the agent on a **disposable cloud box**
(via crabbox) instead of locally, then tears it down. Unlike `--device`, no machine is
registered — the box is ephemeral. One-time provider setup, then run:

```bash
agents devices lease setup                            # provider creds (hetzner today)
agents run claude "refactor the auth module" --lease  # cwd must be a git repo
```

Progress renders as a live checklist: provision (or reuse a warm pool box) → sync the
working dir → install agents-cli + the runtime → **copy your local `~/.agents` setup**
(skills / hooks / commands / MCP) onto the box → run the agent → tear down. Because your
setup is copied, the agent on the box has the same skills it does locally.

**Reuse-first, self-cleaning.** By default `--lease` reuses a ready box from the repo's
warm profile pool when one exists (and keeps it); only a freshly-provisioned box is
destroyed after the run. Each lease also **auto-stops expired, idle strays** in that pool
(an expired box can never be reused, so it's pure cost) — the pool self-cleans toward a
single warm box. Control the box lifecycle:

| Flag | Effect |
|------|--------|
| `--fresh` | Always provision a brand-new box (skip the warm-pool reuse); tear down after |
| `--reuse` | Reuse the most-recently-used warm box if any, else provision fresh (scriptable form of the picker) |
| `--box <slug>` | Reuse one specific warm box by slug (see `agents devices lease list`) |
| `--keep-box` | Keep the box after the run instead of stopping it |
| `--bare` | Skip copying your `~/.agents` setup — a stock box with just the runtime |
| `--tailscale` / `--no-tailscale` | Join the box to your tailnet (private) vs. force a public-IP lease |
| `--lease <backend>` | Pick the cloud: `hetzner` (default), `aws`, `do`. Also spellable `--where lease[:backend]` |

### Manage leased boxes

```bash
agents devices lease list             # warm boxes you can reuse (--box <slug>)
agents devices lease stop <slug>      # stop / release one now
agents devices lease gc               # stop expired, idle boxes holding provider quota (safe)
agents devices list --all     # also show ephemeral leased boxes alongside the fleet
```

## Bounded runs

Kill the agent after a duration. Useful in CI and scheduled jobs.

```bash
agents run claude "generate sales report" --timeout 30m
agents run claude "..." --timeout 2h30m
```

## Autonomous loop (`--loop`) + checkpoint/resume

`--loop` re-injects the prompt each iteration until a stop condition. The driver is deterministic; the agent inside stays free to spawn subagents. Every guard runs OUTSIDE the agent — the agent cannot vote past a kill-switch.

```bash
# Re-inject up to 5 turns, stop early on the agent's signal, 100k-token hard cap.
agents run claude "drive the migration to green" \
  --loop --until signal --max-iterations 5 --budget 100000 --interval 0 --mode skip
```

| Loop flag | Stop reason | Meaning |
|-----------|-------------|---------|
| `--max-iterations <n>` | `max` | Hard cap on iterations. |
| `--budget <tokens>` | `budget` | Cumulative-token cap, enforced outside the agent (exit 7). |
| `--until signal` | `condition-met` | Reads `<runDir>/loop-signal.json` `{continue,reason}` each turn; absent or `continue:false` stops (fail-closed). |
| `--interval <dur>` | — | Delay between turns (`0` back-to-back, `30m` paces; units `w/d/h/m`, `30s`/bare numbers rejected). |

Each iteration pins its **own fresh `--session-id`** (`--session-id` *creates* a session — re-passing one errors `Session ID already in use`). To carry memory forward, iteration 2+ prepends `/continue <prior session id>` to the re-injected prompt so the agent recalls the prior turn first. Continuity is **claude-only**; other agents loop as independent fresh conversations (the driver warns). The driver hands the entrypoint `AGENTS_LOOP_SIGNAL` (path to write its `{continue, reason}` vote), `AGENTS_RUN_DIR`, and `AGENTS_LOOP_ITERATION`.

**Checkpoint/resume.** A `checkpoint.json` is written under `~/.agents/.history/runs/<runId>/` after every iteration (and on SIGINT/SIGTERM). Resume a killed run:

```bash
agents run claude --resume-checkpoint ~/.agents/.history/runs/<runId>/checkpoint.json --max-iterations 10
```

Resume continues from the last completed iteration with the same runId, prompt, and carried token count; the first resumed iteration `/continue`s from the checkpoint's recorded session id (the last completed iteration's). CLI loop flags on a resume RAISE the checkpoint's bounds (e.g. a higher `--max-iterations`), so "continue, run more" is one command.

## Budget guardrails (pre-flight estimate + hard kill)

When a `budget:` block is configured in `agents.yaml` (project > user), every
run is gated:

- **Pre-flight estimate.** Before spawn, `agents run` prints
  `[budget] est. $X for this <agent> run` and, under `on_exceed: block`, refuses
  to launch if the run would breach any cap (`per_run` / `per_day` / `per_agent`
  / `per_project`). A block exits **non-zero (code 2)** — CI/headless inherit it.
- **`-y` / `--yes`** skips the interactive `require_confirm_over` confirm prompt
  for scripts. It does **NOT** skip a hard block — a cap breach blocks regardless.
- **Live kill-switch.** Local **non-interactive** (`-p` / headless) runs
  hard-stop the moment accumulated spend crosses a cap (SIGTERM → SIGKILL),
  resolving with a distinct exit code (7) — attached whether or not output is
  piped. Interactive REPL sessions rely on the pre-flight gate, not live kill.
  (`agents teams` teammates and `agents cloud` dispatch are gated **pre-flight
  only** in v1 — no live mid-run kill there yet.)

```bash
# Tiny per_run cap blocks before the agent ever starts:
$ agents run claude "huge refactor" --model claude-opus-4
[budget] est. $2.48 for this claude run (claude-opus-4, prompt size)
[budget] BLOCKED: estimated $2.48 exceeds per_run cap $0.01
$ echo $?   # 2

# Skip the confirm prompt in a script (still blocks on a hard cap):
agents run claude "..." --yes
```

Caps are **cross-vendor**: one `per_project` / `per_day` cap spans Claude,
Codex, Gemini, and every other agent the CLI dispatches. View and set them with
`agents budget`. Full reference: [docs/observability.md](../../docs/observability.md#budget-guardrails-agents-budget).

## Grant access to extra directories (Claude only)

```bash
agents run claude "refactor shared utils" --add-dir ../shared --add-dir ../other-pkg
```

## Working directory

```bash
agents run claude "..." --cwd /path/to/repo
agents run claude "..." --project app          # shorthand: <root>/app
```

`--cwd` sets the working directory locally, and **on the host** for `--device` runs
(see [Working directory on the host](#working-directory-on-the-host)). `-P, --project
<slug>[@worktree]` resolves a project name against your cached projects root; set it
with `agents defaults project-root <path>`.

## ACP routing

Route through the Agent Client Protocol (Zed integration).

```bash
agents run gemini "..." --acp
agents run claude "..." --acp           # via @zed-industries/claude-code-acp adapter
```

Emits a unified event stream; ndjson when combined with `--json`.

## Quick reference

| Flag | Purpose |
|------|---------|
| `--mode plan\|edit\|auto\|skip` | Permission level (default `plan`; `full` = alias for `skip`) |
| `--effort low\|...\|max\|auto` | Reasoning effort |
| `--model <id>` | Override model |
| `--secrets <bundle>` | Inject keychain bundle (repeatable) |
| `--env KEY=val` | Pass env var (repeatable) |
| `--cwd <dir>` | Working directory (local, or on the host for `--device` runs) |
| `-P, --project <slug>[@wt]` | Project shorthand → cwd from your projects root |
| `--remote-cwd <dir>` | Explicit host working directory (`--device`; verbatim) |
| `--add-dir <dir>` | Extra dir access (Claude, repeatable) |
| `--json` | ndjson event stream |
| `--quiet` | Drop preamble |
| `--verbose` | Detailed logs |
| `--timeout 30m` | Kill after duration |
| `--session-id <id>` | Resume conversation (Claude) |
| `--loop` | Re-inject the prompt until a stop condition |
| `--max-iterations <n>` | Loop iteration hard cap (`stoppedBy: max`) |
| `--budget <tokens>` | Loop cumulative-token cap (`stoppedBy: budget`) |
| `--until signal` | Loop stops on `loop-signal.json` `{continue:false}` / absent (fail-closed) |
| `--interval <dur>` | Loop delay between iterations (`0` back-to-back) |
| `--resume-checkpoint <file>` | Resume a killed loop from its `checkpoint.json` |
| `--fallback codex,gemini` | Rate-limit fallback chain |
| `-b, --balanced` | Shortcut for `--strategy balanced` |
| `--strategy pinned\|available\|balanced` | Version selection |
| `--acp` | Route via Agent Client Protocol |
| `-y, --yes` | Skip the budget confirm prompt (never skips a hard block) |

For everything else, run `agents run --help`.
