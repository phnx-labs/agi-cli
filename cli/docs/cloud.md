<!-- guide -->
# Cloud Dispatch

Run agent tasks on remote infrastructure across multiple cloud backends, with unified status tracking and live log streaming.

## Overview

`agents cloud` dispatches tasks to remote agent environments without requiring
a local CLI session. **Each agent runs in its own cloud** — five managed providers ship
today: Rush Cloud (Claude Code, Codex or OpenCode through the Rush developer API, with an optional repo → PR), Codex Cloud (pre-built
Codex environments), Factory (Droid on a cloud Droid Computer), and Antigravity
(Gemini Managed Agents), plus Cursor Cloud Agents. Pass `--agent` and the provider is auto-selected;
`--provider` overrides. Every dispatched task is tracked in a local SQLite store
so `agents cloud list` shows the full history across all providers, and transient
states (`queued`, `allocating`, `running`, `input_required`) are refreshed
from the live provider API on each `list` call. Tasks continue running after
you disconnect — reconnect any time with `agents cloud logs <id>`.

### Agent auto-routing

`agents cloud run --agent <id>` routes to that agent's native cloud unless you
pass `--provider`. Resolution precedence (`resolveProvider` in
`src/lib/cloud/registry.ts`): explicit `--provider` > the agent's `cloudProvider`
(declared in the agent registry, `src/lib/agents.ts`) > `cloud.default_provider`
in `~/.agents/agents.yaml` > `rush`.

| Agent | Native cloud | Why |
|---|---|---|
| `claude` | `rush` | Rush runs Claude against an optional repo → PR. (Claude Code does have a native `claude --cloud` on Anthropic-managed infra since 2026-08; routing to Rush is deliberate — one tracked fleet for every harness.) |
| `codex` | `codex` | `codex cloud exec` — first-class native CLI. |
| `droid` | `factory` | Factory Droid Computer (cloud VM) via `droid computer ssh` + remote `droid exec`. |
| `antigravity` | `antigravity` | Gemini Managed Agents Interactions API (remote sandbox). |
| `cursor` | `cursor` | Cursor Cloud Agents v1 REST API (repo-backed or no-repo agent). |

### Dispatch from `agents run` — the `--cloud` placement

The same dispatch is a placement on `agents run`
([#2066](https://github.com/phnx-labs/agents-cli/pull/2066)):

```bash
agents run claude "fix the flaky e2e" --cloud --repo acme/example
agents run codex "add parser tests" --cloud --cloud-env env_a1b2c3
agents run cursor "fix the flaky parser test" --cloud --repo acme/example
agents run claude "…" --where cloud:codex   # one-door spelling (+ provider)
```

`--cloud` sits beside `--device` and `--lease` as one of three run
placements (local, machine, cloud) and is mutually exclusive with them. It
accepts `--provider`, `--repo` (repeatable), `--branch`, `--cloud-env` (run's
`--env` stays the KEY=VAL passthrough), `--timeout`, `--model`, `--no-follow`,
and `--json`; local-run flags (`--loop`, `--resume`, `--secrets`, `--terminal`,
`--cwd`, account strategy, …) are rejected, not silently dropped. Agents with
no native cloud (kimi, grok, opencode, …) fail loud with the capable
list unless `--provider` is given. Both surfaces call the shared dispatch core
(`executeCloudDispatch` in `src/lib/cloud/dispatch.ts` via
`src/commands/run-cloud.ts`), so tracking, streaming, and the budget
kill-switch are identical to `agents cloud run`. See
[concepts.md](concepts.md#devices-placement-and-projects) for the placement model.

### Pre-provisioned targets (env / computer)

Two of the clouds don't clone a repo per dispatch — they run *inside* something
you provision once:

- **Codex** runs in an **environment** (`env_…`) created in the Codex web UI,
  which bundles a repo + base image + setup scripts. `codex cloud exec` requires
  `--env`.
- **Factory** runs on a **Droid Computer** (a persistent cloud VM). Dispatch
  requires `--computer`.

(Rush takes an optional `--repo`, one per session; Antigravity spins up an on-demand sandbox — no
pre-provisioned target.)

So you supply the target one of three ways: per-run (`--env` / `--computer`), a
default in `agents.yaml` (`cloud.providers.codex.env` /
`cloud.providers.factory.computer`), or — interactively — let the CLI pick it.

**Discover targets:** `agents cloud envs [--provider <id>]` lists what you can
dispatch into. Factory enumerates Droid Computers via `droid computer list`
(surfacing the sign-in error verbatim if you're not authenticated). Codex has no
list-environments CLI, so it prints guidance to browse them with the interactive
`codex cloud` instead.

**Interactive picker:** if a dispatch is missing its target and you're in a TTY,
`agents cloud run` offers a picker rather than erroring — a `select` of your
Droid Computers (Factory), or, where the backend can't enumerate (Codex), the
actionable guidance. The picker falls back to a free-text prompt if the listing
is empty, so a dispatch is never hard-blocked.

## Architecture

```
CLI (agents cloud run ...)
  │
  ├─ resolveProvider()               src/lib/cloud/registry.ts
  │    reads cloud.default_provider  from ~/.agents/agents.yaml
  │    returns CloudProvider impl
  │
  ├─ provider.dispatch(options)      rush.ts | codex.ts | cursor.ts | factory.ts | antigravity.ts | host.ts
  │    POST to remote API
  │    returns CloudTask { id, status, ... }
  │
  ├─ insertTask(task)                src/lib/cloud/store.ts
  │    SQLite: ~/.agents/.cache/cloud/tasks.db
  │
  └─ renderStream(provider.stream(id))   src/lib/cloud/stream.ts
       SSE parser → CloudEvent union
       renders to terminal (or --json)
       returns { status, summary, prUrl }

agents cloud list
  ├─ listActiveTasks()               refresh transient states from each provider
  └─ listStoredTasks({ provider, status, limit })

agents cloud providers
  └─ getAllProviders()                instantiate every provider, report capabilities()
```

## Command Reference

| Command | Description |
|---|---|
| `agents cloud run [prompt]` | Dispatch a task to a cloud agent |
| `agents cloud list` | List cloud tasks (most recent first) |
| `agents cloud status <id>` | Show task detail and latest status |
| `agents cloud logs <id>` | Stream live output from a running task |
| `agents cloud transcripts [selector]` | List captured Rush Cloud run transcripts, or render one |
| `agents cloud cancel <id>` | Cancel a running task |
| `agents cloud message <id> <text>` | Send a follow-up to a finished or needs-review task |
| `agents cloud providers` | List available providers and their status |
| `agents cloud envs` | List the pre-provisioned targets (Codex environments / Droid Computers) you can dispatch into |

### `cloud run` options

| Flag | Description |
|---|---|
| `--provider <id>` | Cloud backend: `rush`, `codex`, `cursor`, `factory`, `antigravity`, `host` |
| `--agent <name>` | Agent to run; native cloud routing includes `claude`, `codex`, `cursor`, `droid`, and `antigravity` |
| `--repo <owner/repo>` | GitHub repository. Repeatable for multi-repo dispatch (Cursor Cloud); Rush Cloud takes one |
| `--branch <name>` | Target git branch |
| `-p, --prompt <text>` | Inline prompt (alternative to positional argument) |
| `--timeout <duration>` | Kill after duration (e.g., `30m`, `2h`) |
| `--model <model>` | Model override |
| `--env <id>` | Codex Cloud environment ID |
| `--computer <name>` | Factory/Droid computer target |
| `--device <name>` | One of your machines as the target (registered device, capability tag, or `user@host`); implies `--provider host` |
| `--remote-cwd <dir>` | Working directory on the device (`--provider host` only) |
| `--any` | With a capability-tag `--device`, pick any matching device instead of erroring |
| `--autonomy <level>` | Factory/Droid autonomy: `low`, `medium`, `high` (default `high`) |
| `--image <path>` | Attach an image (`.png`/`.jpg`/`.webp`); repeatable, up to 5 (Rush Cloud only) |
| `--skill <url>` | Skill by public URL: a GitHub `tree` URL to a directory with `SKILL.md`, a `SKILL.md` file, or a `.zip`; repeatable (Rush Cloud only) |
| `--json` | Structured JSON output |
| `--no-follow` | Dispatch and exit without streaming output |

### `cloud list` options

| Flag | Description |
|---|---|
| `--provider <id>` | Filter by provider |
| `--status <status>` | Filter by status |
| `--limit <n>` | Max results (default 20) |
| `--json` | JSON output |

### `cloud status` options

| Flag | Description |
|---|---|
| `--json` | JSON output |

### `cloud logs` options

| Flag | Description |
|---|---|
| `-f, --follow` | Follow output (default for running tasks) |
| `--json` | JSON event stream |

### `cloud transcripts` options

Lists Rush Cloud runs with your Rush API key (see [Rush Cloud credentials](#rush-cloud-credentials)),
or renders the one whose id, short id, or id prefix matches `[selector]`. Runs are
the sessions the key can read in `RUSH_ORG` (`GET /o/{org}/sessions`, newest first,
at most 100); a run whose harness is not `claude`, `codex` or `opencode` is not
listed. A missing or ambiguous selector, or a missing or rejected key, exits 1; it
never falls back to local sessions. Every render fetches the transcript again from
`GET /o/{org}/sessions/{id}/messages`; nothing is cached. It reads
transcripts only: the job commands above (`list`, `status`, `logs`) do not, and
this command has no artifact or preview mode.

| Flag | Description |
|---|---|
| `-n, --limit <n>` | Runs to list (default 50) |
| `--json` | The run list without a selector; the run's event array with one |
| `--markdown` | Render the transcript as markdown |
| `--no-redact` | Turn off the default secret redaction (`--markdown` and `--json`) |
| `--include <roles>` / `--exclude <roles>` | Keep or drop roles: `user`, `assistant`, `thinking`, `tools` |
| `--first <n>` / `--last <n>` | Keep the first or last N turns |

## Providers

Six providers, including the `host` machine backend, are registered at startup (`src/lib/cloud/registry.ts`):

| ID | Name | Dispatch target | Multi-repo |
|---|---|---|---|
| `rush` | Rush Cloud | Developer API session, optional GitHub repo + branch | No — one repository per session |
| `codex` | Codex Cloud | Pre-built Codex environment (`--env`) | No — bundle the repos into the env |
| `factory` | Factory (Droid) | Droid Computer (`--computer`) via relay SSH + `droid exec` | No |
| `antigravity` | Antigravity (Gemini) | Gemini Managed Agents remote sandbox | No — raw sandbox, no repo → PR |
| `cursor` | Cursor Cloud Agents | Cursor-hosted agent with optional GitHub repos | Yes — up to the API limit |
| `host` | Host (your machines) | One of your own devices (`--device`, `--remote-cwd`) | No |

The default provider is read from `cloud.default_provider` in
`~/.agents/agents.yaml`. If unset, it falls back to `rush`. Note that an
agent's native cloud (via `--agent`) takes precedence over `default_provider`.

**Factory (Droid).** `droid exec` is synchronous, so a Factory dispatch runs the
remote exec to completion (no live SSE — output appears when the run finishes)
and the task id is droid's own `session_id`. Requires the `droid` CLI, a Factory
login, and a pre-provisioned Droid Computer (`--computer <name>`, or
`cloud.providers.factory.computer`). Create one in Factory (Settings → Droid
Computers) or register a machine with `droid computer register`.

**Antigravity (Gemini).** Talks to the Interactions API
(`POST /v1beta/interactions`, agent `antigravity-preview-05-2026`). The Gemini
API key comes from a `secrets` bundle named in
`cloud.providers.antigravity.secretsBundle` (or `GEMINI_API_KEY` /
`GOOGLE_API_KEY` in the env). It is a raw sandbox — no GitHub repo → PR; pass a
repo and it routes you to `--provider rush` instead.

**Cursor.** Talks directly to `https://api.cursor.com/v1`; it does not invoke
`cursor-agent --cloud`. The API key comes from `CURSOR_API_KEY` in the
`secrets` bundle named by `cloud.providers.cursor.secretsBundle` (or
`CURSOR_API_KEY` in the env).
Free-plan keys fail with a paid-plan requirement instead of a generic auth error.

### Provider configuration (`~/.agents/agents.yaml`)

```yaml
cloud:
  default_provider: rush     # optional; defaults to rush

  providers:
    codex:
      env: env_a1b2c3        # default Codex Cloud environment ID
    factory:
      computer: linux-vm-1   # default Droid Computer name
      autonomy: high         # droid exec --auto level (low|medium|high; default high)
    antigravity:
      secretsBundle: gemini.com   # secrets bundle holding GEMINI_API_KEY
      # model: antigravity-preview-05-2026   # optional managed-agent override
    cursor:
      secretsBundle: cursor    # secrets bundle holding CURSOR_API_KEY
    rush:
      secretsBundle: getrush.ai   # secrets bundle holding RUSH_API_KEY and RUSH_ORG
```

### Rush Cloud credentials

Rush Cloud is called through its developer API at `https://api.prix.dev/o/{org}/sessions`
with an API key (`rk_live_…`), the way any customer calls it: start
(`POST /o/{org}/sessions`), read, list, the `…/events` stream, follow-ups and the
transcript (`…/messages`), and cancel. It does not read the deprecated `rush login`
session. Create a key on the Developers page of `cloud.getrush.ai`, then:

```bash
secrets add getrush.ai RUSH_API_KEY            # paste the rk_live_… secret
secrets add getrush.ai RUSH_ORG --value acme   # the org the key belongs to
```

and set `cloud.providers.rush.secretsBundle: getrush.ai`, or run a command under
`secrets exec getrush.ai --`, which puts both in the environment. A key acts as the
admin who created it and runs on that admin's own model accounts. The developer
API takes one repository per session (sent as a `resources` URL, with `--branch` as
its `tree/<branch>`), skills by public URL, and images as input blocks; it has no
execution mode and no per-run environment, so `--mode` is refused and an injected
share token is not sent (the CLI says so on stderr).

## Task Lifecycle

Task status values (from `src/lib/cloud/types.ts:6-14`):

```
queued
  │
  ▼
allocating
  │
  ▼
running ──────────────────────────▶ input_required
  │                                   (agent paused, awaiting message)
  │                                        │
  │        agents cloud message <id> ──────┘
  │
  ├── exit OK  ──▶ completed
  ├── exit err ──▶ failed
  └── cancel   ──▶ cancelled
```

`idle` is a long-lived session state — the agent has stopped between turns and
can be resumed via `agents cloud message`. It is distinct from the terminal
states (`completed`, `failed`, `cancelled`) which cannot re-enter `running`.

### Stream events

`agents cloud logs` and the post-dispatch follow mode consume a Server-Sent
Events stream decoded into typed `CloudEvent` values
(the `CloudEvent` union in `src/lib/cloud/types.ts`, decoded by
`src/lib/cloud/stream.ts`):

| Event type | Content |
|---|---|
| `text` | Agent's text output — written to stdout |
| `thinking` | Extended reasoning content — written to stderr |
| `tool_use` | Tool invocation — written to stderr |
| `tool_result` | Tool result — acknowledged on stderr |
| `status` | Lifecycle transition |
| `usage` | Token counts and model name |
| `done` | Final status, optional PR URL, optional summary |
| `error` | Error message from the provider |
| `unknown` | Provider event not in the known taxonomy — surfaced, not dropped |

Stream disconnect does not cancel the task. The task continues running; reconnect
with `agents cloud logs <id>`.

## Recipes

### 1. Dispatch to Rush Cloud and stream output

```bash
agents cloud run "fix the flaky e2e in tests/checkout.spec.ts" \
  --provider rush \
  --repo acme/monorepo \
  --branch main
```

### 2. A Rush Cloud run with no repository

```bash
secrets exec getrush.ai -- agents cloud run "reply with the word ok" --provider rush
```

### 3. Fire-and-forget, then tail logs later

```bash
# Dispatch and exit immediately
TASK=$(agents cloud run "bump tailwind to v4 and fix the breaks" \
  --provider rush --repo acme/monorepo --no-follow --json | jq -r .id)

# Reconnect later
agents cloud logs "$TASK"
```

### 4. Cancel a runaway task

```bash
agents cloud cancel tsk_4f2a91
```

### 5. List all active tasks, refreshed from providers

```bash
# Human-readable table
agents cloud list

# Filter by provider and status
agents cloud list --provider rush --status running

# Machine-readable
agents cloud list --json
```

### 6. Send a follow-up when the agent needs input

```bash
# Agent paused at input_required
agents cloud status tsk_4f2a91

# Unblock it
agents cloud message tsk_4f2a91 "Looks good — also update the OpenAPI spec"
```

### 7. Dispatch to a droid's own cloud (Factory Droid Computer)

`--agent droid` auto-routes to Factory; the run executes `droid exec` on the
named Droid Computer.

```bash
agents cloud run "add a vitest for src/util/slug.ts" \
  --agent droid \
  --computer cloud-vm-1 \
  --autonomy high
```

### 8. Dispatch to Antigravity (Gemini Managed Agents)

`--agent antigravity` auto-routes to the Gemini Interactions API. No repo — it's
a remote sandbox.

```bash
# key resolved from cloud.providers.antigravity.secretsBundle, or GEMINI_API_KEY
agents cloud run "benchmark three JSON parsers and report the fastest" --agent antigravity
```

## Budget Guardrails

Cloud dispatches use the same `budget:` caps as local runs (`per_run`,
`per_day`, `per_project`, `per_agent`, `on_exceed`), read from the `agents.yaml`
files walking up from the current directory and from `~/.agents/agents.yaml`
(`src/lib/budget/config.ts`). The target repo slug is the project
attribution key, so caps span every agent dispatched against that repo.

- **Pre-flight (Rush Cloud only).** Before a Rush dispatch is POSTed, its
  estimated cost is projected onto current spend; under `on_exceed: block`
  (the default), a dispatch that would breach a cap is **refused client-side**
  with a `[budget] BLOCKED cloud dispatch …` error and never starts
  (`src/lib/cloud/rush.ts`).
- **Live (while following).** When `agents cloud run` streams the task (no
  `--no-follow`), `usage` events feed a live spend watcher; on the first
  breach the CLI cancels the task through the provider, prints
  `[budget] cap … exceeded — cancelled cloud task <id>`, and exits 7
  (`src/lib/budget/live-cloud.ts`). A task dispatched with `--no-follow` is
  governed only by the provider's own controls once it starts.

## See Also

- [docs/concepts.md](./concepts.md) — DotAgents repos, resource kinds, `agents.yaml` structure
- [docs/teams.md](./teams.md) — use `--cloud rush|codex|factory` on `agents teams add` to dispatch cloud teammates from a DAG
