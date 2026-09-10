<!-- guide -->
# Routines (Scheduled Jobs)

Scheduled agent execution with sandboxed permissions and scheduler-driven cron execution.

## Architecture

```
~/.agents/
  routines/
    daily-review.yml        # Job config (YAML)
    weekly-cleanup.yml
  daemon/
    state.json              # Daemon PID, last reload timestamp
```

Each job is a YAML file in `~/.agents/routines/`. A background scheduler parses cron expressions with [croner](https://github.com/hucsm/croner), spawns agent processes at trigger time, and captures output.

### Daemon runtime — `agents daemon`

The scheduler above is one job the daemon runs; the daemon itself also hosts
browser IPC and the watchdog pass (RUSH-2354). The secrets broker is **not** one
of them — the standalone `secrets` CLI owns its own broker lifecycle (PHNX-3989),
and the daemon reaches secrets only as a client, through `secrets-client.ts`.
`agents routines start`/`stop`/`status`/`scheduler-logs` remain as
scheduler-scoped convenience wrappers, but the daemon's own runtime surface is
`agents daemon`:

```bash
agents daemon                # identity, duplicate __daemon-run processes, per-service health
agents daemon status --json  # same, machine-readable

agents daemon start | stop | restart
agents daemon enable | disable   # persisted device kill switch — see below
agents daemon reload             # SIGHUP: reload routines + re-evaluate scheduler.enabled
agents daemon services           # every hosted service + per-service toggles
agents daemon webhooks list      # the signed webhook receivers this box hosts
agents daemon logs -f --level warn --since 1h
agents daemon doctor             # one-shot check, non-zero exit on problems
```

There is no `agents daemon jobs` — scheduled work is always `agents routines`;
`agents daemon status`/`doctor` point at `agents routines stats` for per-routine
failure detail instead of duplicating it.

**Two independent gates control whether routines fire on a device**, and they are
not the same thing:

- `scheduler.enabled` (device config) gates only the routines `JobScheduler`
  inside an already-running daemon — browser IPC and the watchdog keep running
  when it is off.
- `daemon.enabled` (device config, new) is the daemon-wide kill switch. With it
  `false`, nothing **auto-starts** the daemon — not `routines add`, not
  `routines start`, not `routines catchup`, not a webhook trigger. `agents daemon
  start` still starts it explicitly, the same way `systemctl start` works on a
  disabled unit.

A per-subsystem health record (`{subsystem, lastError, lastErrorAt,
consecutiveFailures, lastOkAt}`, persisted at
`~/.agents/.cache/helpers/daemon/health.json`) backs `agents daemon status` and
`services`: browser IPC and the other hosted services record a success/failure on
every (re)start attempt, so a failure survives past whatever line of the daemon
log it would otherwise scroll out of.

A third subsystem, `daemon-start`, records the daemon's own startup and is the
one record that also **gates** behaviour rather than just reporting. It is
written from both sides: the launching CLI marks every start it issues as a
failure up front, and only a daemon that has finished booting — scheduler,
browser IPC, broker decision and every background tick up — clears it. A daemon
that spawns and then dies therefore leaves the streak growing, which a check on
the launch's own return value could never see (the spawn succeeded). After five
consecutive such starts the **implicit** auto-start refuses: the background
callers that opportunistically bring the daemon up (`secrets unlock`, `browser
start`, the watchdog) stop relaunching a daemon that never lives, and point at
`agents daemon doctor`, which reports the streak and the recorded cause. An
already-running daemon is still reported, and `agents daemon start` — the
explicit override — is never gated.

### Project routines (one enabled/disabled flag)

A routine has exactly one state: **enabled** or **disabled**. Project routines in `<project>/.agents/routines/` are surfaced in `agents routines list` (discovered from your registered projects, `agents projects`) as **disabled** rows until you turn one on — there is no separate project-level opt-in.

**A cloned repo never auto-fires.** Enablement lives solely in this device's `meta.deviceRoutines`; a project YAML's own `enabled:` field is never trusted for firing. So a discovered routine stays inert until you enable it locally.

```bash
# Enable a routine. If it is a project routine not yet materialised (from the
# current project or a registered one), enable materialises it first — one step.
agents routines enable security-sweep

# Disable it again (definition stays; only firing stops)
agents routines disable security-sweep

# Refresh materialised project routines from their source YAML (definition-only,
# never changes what is enabled). Runs automatically on daemon reload (SIGHUP).
agents routines sync
agents routines sync /path/to/repo
```

What `enable` does for a project routine:

1. Materialises `<project>/.agents/routines/<name>.yml` into `~/.agents/routines/<name>.yml` with a `source:` block (`kind: project`, `projectPath`, and git `repo`/`branch`/`commit` when known) — **without** enabling it.
2. Turns on the device flag (`meta.deviceRoutines`), which is the only thing that makes the daemon (user + system layers) fire it.
3. Hand-authored user routines of the same name are never overwritten — `enable` refuses with an error if the name collides with a foreign-source routine.

`agents routines list` groups terminal output by effective device/host scope so it is clear what runs on the current machine, the fleet, cloud, named devices, and named hosts. Use `agents routines list --flat` for the legacy single table, or `--json` for the flat machine-readable payload. Project-sourced routines still show the source repo (and `@branch` when known) in the Repo column; `--json` includes `source`, `sourceRepo`, `sourceBranch`, `hostStrategy`, `oneShot`, and `expired`.

When a routine's last run did not simply complete, the `Last Status` cell names **why** inline — `failed — auth_failed: Please run /login`, `skipped — wedged: a prior run is still active`, `blocked — <readiness>`, or `missed — scheduler was not running when it came due` — so a failing routine is diagnosable from the list without a drill-in. The interactive detail's Recent runs and the `agents routines logs` header (a `reason:` line) surface the same signal, drawn from the run record's `errorMessage` / `readiness` / `skipReason` already on disk (`--json`'s `failureReason` is unchanged).

The bare `agents routines` command (no subcommand) opens an **interactive browser** on a terminal — a filterable, grouped picker (built on the same picker primitive as `agents sessions`). The project/device group headers render as inline dividers, typing filters the rows (keeping only groups with a match), and the detail pane / drilling into a routine shows four blocks: Definition, Next fire, Recent runs, and Stats. It falls back to the static `agents routines list` output — byte-for-byte — under `--json` or in any non-interactive shell (a pipe, the menu bar, CI), and `--flat` keeps the legacy table. Separately, `agents inspect <target> --routines` lists routine *definitions* (name, last run, devices, schedule) through the inspect resource view; add a name to drill into one.

A project routine's own `enabled:` field in its YAML is a documentation signal only — daemon firing is governed solely by this device's enable state (`agents routines enable <name>`), so a cloned repo can never turn itself on.

### Host placement strategy

Where the **job body** runs when the daemon fires it (`devices` still controls which daemon may *fire*):

| Strategy | YAML | CLI | Behaviour |
| --- | --- | --- | --- |
| `local` | `hostStrategy: local` (default) | `--placement local` | Run on the firing machine |
| `host` | `hostStrategy: host` + `host: <name>` | `--placement host --run-on <name>` | Run on a named machine over SSH |
| `fleet` | `hostStrategy: fleet` | `--placement fleet` | Pick one online registered device per run (first eligible by name) |
| `fleet` (auto) | `hostStrategy: fleet` + `host: auto` | `--run-on auto` | Re-pick a healthy, signed-in, unloaded device AT EACH FIRE — the same picker as `agents run --device auto` |
| `cloud` | `hostStrategy: cloud` | `--placement cloud` | Dispatch via the agent's native cloud provider |

```bash
# Pin firing to this machine and place the body on a GPU box
agents routines add train --schedule "0 2 * * *" --agent claude \
  --placement host --run-on gpu-box --prompt "Train overnight"

# Fire once from this machine; each run picks any online fleet device
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --placement fleet --prompt "Drain the local work queue"

# Health-aware auto placement: each fire re-picks a healthy, signed-in,
# unloaded device (agents run --device auto semantics)
agents routines add shepherd --schedule "*/5 * * * *" --agent claude \
  --strategy balanced --run-on auto --prompt "Own the release through verification"

# Dispatch to Rush Cloud / the agent's native cloud
agents routines add review --schedule "0 9 * * 1" --agent claude \
  --placement cloud --repo phnx-labs/agents-cli --prompt "Review open PRs"
```

```yaml
# ~/.agents/routines/drain.yml
name: drain
schedule: "0 3 * * *"
agent: claude
hostStrategy: fleet
devices: [yosemite-s0]   # firing pin — only this daemon fires (avoids double-fire)
prompt: "Drain the local work queue"
```

**Double-fire guard.** `host` / `fleet` / `cloud` require a `devices` pin naming which daemon may *fire* the job. Without it every fleet daemon would fire and each dispatch once. Add and sync auto-pin `devices` to this machine when you omit `--devices`. For `fleet`, that pin is **firing only** — the body still runs on any online fleet device (`pickFleetDevice` does not filter by `devices`). `devices --clear` refuses for off-box strategies. Bare `host:` (without `hostStrategy`) still works and implies `host` strategy (and still needs a pin).

`--device` on `agents routines` is the remote-management passthrough ("manage routines **on** that machine") — do not overload it for placement. Use `--placement` / `--run-on`.

### Ending a recurring routine

Set `endAt` (ISO 8601) on a recurring routine to have the scheduler auto-disable it on or after that time:

```bash
agents routines add cleanup --schedule "0 3 * * *" --agent claude \
  --prompt "Tidy logs" --end-at "2026-12-31T23:59:00Z"
```

## Job Config

```yaml
# ~/.agents/routines/daily-review.yml
name: daily-review
schedule: "0 9 * * *"         # 9am daily (cron syntax)
agent: claude                 # A native harness id, or a custom harness name (agents harness list) —
                              # a custom harness is delegated to `agents run <name>` and pins its own
                              # host version and auth (no version:/strategy: for those jobs)
account: muqsit@trp.so        # Optional: pin to a signed-in account by identity (see "Pinning an account")
version: 2.0.65               # Optional: pin to an exact version (or --agent claude@2.0.65); strategy-selected if omitted
strategy: balanced            # Optional: per-routine selection policy (pinned | available | balanced) —
                              # beats the firing box's run.<agent>.strategy; conflicts with version:
mode: auto                    # auto (default), plan (read-only), edit, or skip
effort: default               # fast, default, or detailed
timeout: 10m
runOnce: false                # true for one-shot jobs (--at)
endAt: "2026-12-31T23:59:00Z" # optional: auto-disable on/after this time
hostStrategy: local           # local | host | fleet | cloud (see Host placement strategy)
devices:                      # optional: the ONE device that owns this routine
  - yosemite-s0               # omit entirely (or --clear) to run on every device
projects:                     # optional: organises the routine under a project group in `list`
  - myapp                     # single name → "myapp" group; ["*"] → All projects
project: myapp                # optional: singular execution anchor from `agents projects`
cwd: apps/api                 # optional: portable execution directory (see below)
# source:                     # set by `agents routines enable <name>` / sync
#   kind: project
#   projectPath: /path/to/repo
#   repo: owner/name
#   branch: main
#   commit: abc1234

prompt: |
  Review open PRs and summarize status.

allow:
  dirs:
    - ~/projects/myapp
  tools:
    - Bash(git *)
    - Read
    - Grep
```

### Execution project and working directory

`projects` and `project` are intentionally different:

- `projects` is a repeatable grouping tag. It affects list/menu organization only.
- `project` is a singular execution anchor. The CLI resolves its
  `defaultPath`, falling back to `root`, on the device that will execute the
  routine.
- `cwd` selects the execution directory. A relative value is joined to the
  execution project's base. When the project was imported from Linear without a
  local `root`/`defaultPath`, or no project is selected, a relative `cwd` is
  joined to the execution device user's home directory.

The daemon process's own current directory is never an execution default. `repo`
identifies the external GitHub/cloud/webhook repository and does not determine a
local checkout path.

```yaml
# A Linear-imported project may have tracker identity but no checkout binding.
# This still runs from $HOME/src/github.com/acme/app on the selected device.
project: acme-app
cwd: src/github.com/acme/app
```

For agent and workflow routines, omitting both `project` and `cwd` is incomplete
setup. The definition is saved but remains paused. Command routines may use the
target user's home because device-local housekeeping commands commonly operate
there. Absolute paths outside the user's home are local-device-only; host, fleet,
and cloud placement rejects them as non-portable.

Creation, edit, and resume all run the same readiness entry point. Every placement
gets structural project/CWD and portability checks. Local agent routines also
check the local directory, installed harness, live authentication, and Codex
workspace trust. An explicit host placement additionally resolves the target's
HOME/project catalog, proves reachability and real write access there, and probes
the target harness. Fleet and cloud placement cannot prove a selected target at
definition time, so target-dependent checks are deferred to the run path and any
failure remains recorded in attempt history. Workflow and command routines receive
the structural checks that apply to their execution path. A syntactically valid
definition with a proven blocker is saved paused with a stable finding and repair
command. `resume` reruns readiness and does not bypass it.

```bash
agents routines add morning-briefing \
  --project-anchor acme-app \
  --cwd src/github.com/acme/app \
  --schedule "0 8 * * 1-5" \
  --agent claude \
  --prompt "Summarize the pipeline"

agents routines doctor morning-briefing --fix
agents routines resume morning-briefing
```

Raw YAML editing is transactional: `agents routines edit <name> --yaml` edits a
temporary copy, then parses and validates it before replacing the live definition.
Invalid YAML leaves the prior definition and activation untouched.

Two edits apply without an editor, so an agent with no TTY can repair a routine
the readiness gate paused:

```bash
agents routines edit <name> --cwd apps/api            # set the execution directory
agents routines edit <name> --project-anchor myapp    # set the execution anchor
```

Both validate before writing and print the remaining blocker, or the
`agents routines resume <name>` that activates the routine.

### Registering a definition from a file

`agents routines add <path>` copies a definition into `~/.agents/routines/`. When
the path you pass is already that canonical file — the normal case for a routine
tracked in the `~/.agents` git repo — the file is left untouched rather than
re-serialized, so hand-authored keys and formatting survive registration.

A `devices:` key in a definition is legacy input. Activation now lives in each
device's `agents.yaml` (see [Device activation](#device-activation)), so `add`
applies the pin to the current box only and tells you to pin the fleet with
`agents routines devices <name> --set <hosts>`.

### One-Shot Jobs

```bash
agents routines add reminder --at "14:30" --agent claude --prompt "Remind Muqsit to stand up"
```

Prefer `--at` for one-time routines. It accepts `"14:30"` (today at that time, or tomorrow if the time already passed) or `"2026-02-24 09:00"` (absolute). The daemon converts it to a cron expression with `runOnce: true` and deletes the routine after it fires.

Raw cron schedules that pin minute, hour, day, and month with wildcard weekday, such as `"0 14 29 7 *"`, are also treated as one-shot at creation time. The CLI prints a warning and persists `runOnce: true`; use `--at` instead when an agent is scheduling a one-time wake-up.

List output marks one-shot routines in the Schedule column. Expired one-shots that missed cleanup show `expired` instead of next year's recurrence.

Remove completed, expired one-shots that still have user-layer YAML:

```bash
agents routines prune --dry-run
agents routines prune
```

### Webhook Triggers

Routines can fire from signed GitHub or Linear webhooks instead of a cron
schedule, and **Slack** deliveries fire webhook *handlers* (see
[Slack — tag an agent](#slack--tag-an-agent-it-replies-in-your-thread) below).
The same detached runner path is used as scheduled jobs.

```bash
agents routines add agent-labeled-issue \
  --on linear:Issue \
  --action update \
  --team-key RUSH \
  --label agent \
  --agent claude \
  --prompt "Work the Linear issue that was just labeled agent"
```

Equivalent YAML:

```yaml
name: agent-labeled-issue
trigger:
  type: linear_event
  event: Issue
  action: update
  teamKey: RUSH
  label: agent
agent: claude
prompt: "Work the Linear issue that was just labeled agent"
```

GitHub triggers use `type: github_event` with optional `repo` and `branch`:

```bash
agents routines add pr-review \
  --on github:pull_request \
  --repo phnx-labs/agents-cli \
  --branch main \
  --agent claude \
  --prompt "Review the pull request"
```

Add `--action` and `--label` when a routine should fire only for a specific
GitHub webhook action and label, such as a UX test agent after a human adds
`ux-approved`:

```bash
agents routines add ux-tests \
  --on github:pull_request \
  --repo phnx-labs/agents-cli \
  --branch main \
  --action labeled \
  --label ux-approved \
  --agent claude \
  --prompt "Run Playwright E2E and visual regression checks, then comment the results on the PR."
```

#### Slack — tag an agent, it replies in your thread

Slack is a third webhook source. A slash command (`/agents AGI: rebase my open PR
and check CI`) or an `@mention` of your Slack app reaches `POST /hooks/slack`,
runs the agent that holds that project's context **on your box**, and the agent
replies in the same thread. Unlike GitHub/Linear (which fire routine `trigger`
blocks), Slack matches a webhook **handler** in `~/.agents/webhooks/*.yml` — the
handler is what routes the message to an agent.

The receiver verifies Slack's `v0` request signature (with a 5-minute replay
guard), answers the one-time `url_verification` handshake, and parses both slash
commands and `app_mention` events. It exposes a `{{slack.*}}` substitution
namespace — `prompt`, `project`, `channel`, `thread_ts`, `user`, `text`,
`command`, `response_url` — where `project` and `prompt` come from a `PROJECT: rest` prefix in
the message (`AGI: rebase …` → project `AGI`, prompt `rebase …`). A handler may
template its `project`/`cwd` from that namespace, so one handler serves every
project:

```yaml
# ~/.agents/webhooks/slack-agent.yml
name: slack-agent
source: slack
command: /agents          # match this slash command (omit to also match @mentions)
project: "{{slack.project}}"   # route to the project named in the message
run:
  agent: claude
  prompt: |
    A Slack request came in from <@{{slack.user}}> in channel {{slack.channel}}.
    Project: {{slack.project}}
    Request: {{slack.prompt}}

    Read the project's prior context if useful (`agents sessions -p {{slack.project}}`),
    do the work, then reply. A slash command carries a `response_url`, which Slack
    accepts for 30 minutes with no token and no channel membership:
    curl -s -X POST '{{slack.response_url}}' -H 'Content-type: application/json' \
      -d '{"response_type":"in_channel","text":"<your result>"}'
```

`response_url` is empty on an `@mention` delivery — that reply goes into the thread
through the Slack Web API (`chat.postMessage` with `SLACK_BOT_TOKEN`, which needs the
bot in that channel), or through `agents send --channel slack`, which routes via the
Rush daemon's Slack gateway rather than this app's token and so needs `rush` logged
in there. The full example is in
[`docs/examples/slack/slack-agent.yml`](examples/slack/slack-agent.yml). Restrict a
handler to one channel with `channel: C0…`, or drop the `command`/`channel` filters
to match every mention.

Route with `{{slack.project}}`, not `{{slack.prompt}}`. The project token is a
single bare word (no slashes, never `..`), so it is safe in `project:`/`cwd:`;
`{{slack.prompt}}` is free text from the sender and must stay in the prompt body,
never in an execution path. And note the blast radius: anyone who can message the
app triggers a `mode: auto` (write-capable) run on the host box — that authority
is the point, but scope it with `channel:`/`command:` filters and a project the
handler trusts.

**Setup (once per workspace).** Create the app at
[api.slack.com/apps](https://api.slack.com/apps) — the manifest and handler in
[`docs/examples/slack/`](examples/slack/) are ready to paste — then:

```bash
# 1. Signing secret (verify inbound). The bot token is only needed for an
#    @mention reply, which posts through the Slack Web API into the thread —
#    a slash command replies via `{{slack.response_url}}` and needs no token:
agents secrets add slack SLACK_SIGNING_SECRET <from Slack "Basic Information">
agents secrets add slack SLACK_BOT_TOKEN <xoxb-… from "OAuth & Permissions">

# 2. Host the receiver publicly (Funnel) on the box that holds your context:
agents daemon webhooks add --secrets-bundle slack --port 8787 --funnel-port 443
agents daemon restart

# 3. Point the Slack app's slash-command + Events "Request URL" at:
#    https://<box>.<tailnet>.ts.net/hooks/slack
```

#### Hosting the receiver — supervised (recommended) or foreground

**Supervised.** Declare the receiver on the ingress box and the daemon hosts it
as the `webhook-receiver` service, so it comes back after a reboot and after a
crash:

```bash
agents daemon webhooks add --secrets-bundle webhooks --port 8787 --funnel-port 443
agents daemon webhooks list
agents daemon restart      # bind the change
```

The declarations live in `~/.agents/daemon/webhooks.yaml` — per-box operational
state, deliberately outside the fleet-synced config, because a public receiver
runs on exactly one machine. Port is the identity: a second `add` on a port
edits that receiver. `agents daemon webhooks remove <port>` stops hosting it. A
box with no declarations binds nothing, and the whole service can be turned off
with `agents daemon services disable webhook-receiver`.

The daemon resolves each receiver's signing secret through the standalone
`secrets` CLI (an `agentOnly` read via `secrets-client.ts`, SEC-13), so a hosted
receiver needs no `AGENTS_SECRETS_PASSPHRASE` and no `nohup`. A bundle that is
locked or holds neither webhook secret **fails that receiver loud** in
`agents daemon logs` rather than binding ingress it cannot verify; the other
receivers are unaffected.

**Foreground.** For a one-off or for testing, run the receiver yourself — same
HTTP surface, no supervision:

```bash
agents webhooks serve --secrets-bundle webhooks --port 8787
```

The bundle may contain any of `GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`,
and `SLACK_SIGNING_SECRET` (a Slack app also uses `SLACK_BOT_TOKEN` for the
reply). The receiver accepts `POST /hooks/github`, `POST /hooks/linear`, and
`POST /hooks/slack`, rejects unsigned deliveries, dedupes repeated delivery IDs,
rate-limits each source, and binds `127.0.0.1` by default. Keep webhook signing
keys in `agents secrets`; do not put keys in webhook URLs, path segments, query
strings, routine YAML, or Funnel commands.

#### The ack is asynchronous

A verified delivery is answered `202 {"ok":true,"accepted":true,"deliveryId":…}`
**immediately**, and the matched routines and handlers are dispatched after the
response. Dispatch starts an agent run and takes 15-20 seconds, which exceeds
Linear's delivery timeout — the receiver used to hold the socket open across it,
so every real delivery logged a timeout and a retry on Linear's side.

What this changes for a caller: the HTTP body no longer carries `fired` /
`runs` / `handlers`, and a dispatch failure no longer surfaces as a 4xx. Fired
routines appear in `agents daemon logs` (or the foreground receiver's stdout)
and in the `webhook.fired` event; a failure after the ack is logged and emitted
as `webhook.failed`.

**A dispatch that fails after the ack does not retry itself.** The 4xx was what
made GitHub and Linear re-send a delivery, and a sender does not retry a 202. The
per-job ledger still records exactly which matches completed and the delivery
stays unmarked, so re-sending it from the provider's UI runs only what did not —
but nothing triggers that automatically. Watch `agents daemon logs` for
`dispatch failed after ack`.

Dedup is unchanged. `<source>:<delivery-id>` is still the key, a retry of a
settled delivery is still answered `200 {"duplicate":true}`, and per-job marking
still means a retry finishes only the matches that failed. A retry that arrives
while the first is *still dispatching* is also answered as a duplicate, so the
async window cannot double-fire.

Expose the receiver publicly from a Linux/macOS Tailscale node with Funnel:

```bash
agents daemon funnel up yosemite-s0 --local-port 8787 --port 443
agents daemon funnel status yosemite-s0
```

Funnel public ports are limited to `443`, `8443`, and `10000`; `agents daemon funnel up`
validates that before running the remote Tailscale CLI.

Operational runbook:

1. Create or update the secret bundle on the ingress host:

   ```bash
   agents secrets create webhooks
   agents secrets add webhooks GITHUB_WEBHOOK_SECRET
   agents secrets add webhooks LINEAR_WEBHOOK_SECRET
   ```

   If a key already exists, replace the matching `add` command with
   `agents secrets rotate webhooks <KEY>`.

2. Host the receiver on the ingress host, bound to localhost:

   ```bash
   agents daemon webhooks add --secrets-bundle webhooks --port 8787
   agents daemon restart
   agents daemon webhooks list
   ```

3. Enable Funnel only after the receiver is listening:

   ```bash
   agents daemon funnel up yosemite-s0 --local-port 8787 --port 443
   agents daemon funnel status yosemite-s0
   ```

4. Rotate a signing key source by source. Set the new source secret in the
   `webhooks` bundle, update the provider webhook configuration to sign with the
   new value, run `agents daemon restart`, then send one signed test delivery
   before deleting the old provider secret.

5. Disable public ingress before stopping or moving the receiver:

   ```bash
   agents daemon funnel down yosemite-s0 --port 443
   agents daemon funnel status yosemite-s0
   ```

### Webhook handlers

In addition to routine triggers, you can define one-off **webhook handlers** in
`~/.agents/webhooks/*.yml`. A handler matches incoming webhooks the same way a
routine trigger does, but instead of scheduling a recurring job it runs an
agent, workflow, shell command, or an existing routine once.

```yaml
# ~/.agents/webhooks/linear-status-planner.yml
name: linear-status-planner
source: linear
event: Issue
action: update
stateTo: Plan
devices:
  - mac-mini
run:
  agent: claude
  prompt: |
    Issue {{issue.identifier}} moved from {{updatedFrom.state.name}} to {{issue.state.name}}.
    Create a concise implementation plan and post it as a Linear comment.
```

#### Handler YAML format

| Field | Description |
| --- | --- |
| `name` | Unique handler name. |
| `enabled` | Set to `false` to disable without deleting the file. |
| `devices` | Same fleet allowlist as routines — only matching devices run the handler. |
| `source` | `github` or `linear`. |
| `event` | Source event name (e.g. `Issue`, `pull_request`). |
| `action` | Webhook action (e.g. `update`, `opened`, `labeled`). |
| `run` | One-of `agent`, `workflow`, or `command`, plus an optional `prompt` and `env`. |
| `host` | Where the action executes: a device name, `fleet`, or `fleet/<platform>`. Omitted runs locally. |
| `project` | Named `agents projects` execution anchor — a dispatched `agent`/`workflow` run lands in that project's base directory (so it has a repo checkout to edit). Ignored by `run.command`. |
| `cwd` | Portable execution directory for the dispatched run. Relative resolves under `project`, otherwise the target's `$HOME`. |
| `mode` | Permission mode for a dispatched `agent`/`workflow` run: `plan`, `edit`, `auto` (default), `skip`, or `full`. |
| `routine` | Name of a routine to delegate to instead of `run`. `project`/`cwd`/`mode` set here override the routine's own. |

#### Filters

Handlers support the same filters as routine triggers:

- `source`, `event`, `action` — always available.
- Linear: `teamKey`, `label`, `stateTo`, `stateFrom`.
- GitHub: `repo`, `branch`, `label`.

`stateTo` matches a **transition into** that state, not merely sitting in it: the
current state (`payload.data.state.name`) must equal the value AND this delivery's
`updatedFrom` must record a state change (`payload.updatedFrom.state` or
`payload.updatedFrom.stateId`), so a later edit that leaves the state unchanged does
not re-fire. `stateFrom` matches the previous state (`payload.updatedFrom.state.name`).

#### Actions

- `run.agent` — run the agent headlessly with the substituted prompt.
- `run.workflow` — run `agents run <workflow>` with the prompt.
- `run.command` — run a shell command directly (the command string is also
  variable-substituted). Substituted values are **shell-quoted**: the webhook
  payload is external input, so `{{issue.title}}` and friends arrive as one inert
  argument and cannot inject extra commands. Your own template is not quoted, so
  pipes, redirects, and `&&` still work — write `grep {{issue.title}} log.txt`,
  not `grep '{{issue.title}}' log.txt` (the quotes are added for you). On Windows
  this path runs through `cmd.exe`, which these quoting rules do not cover, so a
  `run.command` containing `{{…}}` is refused with an error; use `run.prompt` or
  a command without placeholders there.
- `routine` — load the named routine, substitute its prompt, and run it
  detached. The handler's `devices` pin overrides the routine's for this fire.

#### Environment and placement

`run.env` injects environment variables into the spawned process, on top of the
sandbox overlay's own. It applies to both the foreground and detached paths.

`host` chooses where the action executes. It is distinct from `devices`:
`devices` says which daemon may *fire* the handler, `host` says where the fired
run *executes*.

| `host` | Effect |
| --- | --- |
| omitted | run locally |
| `yosemite-s0` | run on that device over SSH (or locally if it names this machine) |
| `fleet` | pick any eligible online worker device |
| `fleet/linux`, `linux/fleet`, `linux` | pick any eligible online worker on that platform |

Platforms are `linux`, `macos`, `windows`. A fleet expression that matches no
eligible device raises `no eligible online fleet device` rather than falling back
to this machine — otherwise `fleet/linux` could silently land on a macOS box.

```yaml
# ~/.agents/webhooks/deploy-on-merge.yml
source: github
event: pull_request
action: closed
host: fleet/linux
run:
  agent: claude
  prompt: "Deploy {{pull_request.title}}"
  env:
    DEPLOY_TARGET: staging
```

#### Prompt variables

Use `{{dotted.path}}` placeholders in `run.prompt` (and in the delegated
routine's prompt). For Linear webhooks the context is:

```ts
{
  source: 'linear',
  event: 'Issue',
  action: 'update',
  issue: payload.data,
  updatedFrom: payload.updatedFrom,
}
```

Examples: `{{issue.identifier}}`, `{{issue.state.name}}`,
`{{updatedFrom.state.name}}`, `{{issue.title}}`, `{{issue.description}}`.

For GitHub webhooks the context includes `repository`, `pull_request`, and
`issue`.

#### mac-mini ingress with funnel

Handlers are fired by the same receiver as routine triggers. On a headless Mac
(e.g. `mac-mini`), host it under the daemon and expose it with Tailscale Funnel:

```bash
# On mac-mini
agents daemon webhooks add --secrets-bundle webhooks --port 8787 --funnel-port 443
agents daemon restart
```

Then point Linear/GitHub at `https://mac-mini.<tailnet>.ts.net/hooks/<source>`.
The handler's `devices: [mac-mini]` pin ensures only that machine dispatches the
one-off agent run.

### Device activation

Routine YAML files are immutable definitions: they describe what runs and when.
Enablement is device-owned metadata in
`~/.agents/devices/<hostname>/agents.yaml`:

```yaml
routines:
  - check-updates
  - drain
  - watchdog
```

Membership means enabled; absence means disabled. Each host writes only its own
file, so toggles on different devices do not conflict when the DotAgents repo
syncs. The same definition can be active on several devices; each daemon runs it
against that device's local state.

```bash
agents routines resume drain
agents routines resume drain --device yosemite-s0
agents routines pause drain --device mac-mini
agents routines devices drain --set yosemite-s0,mac-mini
agents routines devices drain --clear   # disable everywhere
```

`agents routines devices` reads the synced manifests and executes each mutation
on its target host. `routines list --json` exposes `enabledDevices` and
`runsHere`. Run history remains under
`~/.agents/.history/runs/<routine>/<run>/`; definitions are never rewritten with
activation or last-run metadata.

On upgrade, explicit legacy `enabled:` and `devices:` values are materialized
once into the current host's routine membership. Subsequent toggles edit only the
device manifest.

### Daemon-core housekeeping (not a routine you manage)

The daemon's own housekeeping — session-cache warming, device probing, and the
watchdog — runs as plain `setInterval` timers in `lib/daemon/daemon.ts`
(`runActiveSessionsWarm`, `runDeviceProbeTick`, `runWatchdogTick`), not as
entries under `agents routines`. This replaced an earlier `builtin-routines.ts`
registry that surfaced them as `(built-in)`-tagged routines with
`agents routines pause`/`devices` support; that registry, the
`__daemon-tick <name>` entrypoint, and the `JobConfig.builtin` field were torn
out (RUSH-2495) because they doubled a scheduling layer the plain timers already
covered. `agents routines list` no longer shows them — housekeeping is invisible
to that command, not degraded.

The `auto-dispatch` and `launch-health` routines, and the **5-minute
`tmux-reconcile` poll** that used to retrofit a stale `pane-died` hook onto
managed tmux sessions, were deleted in the same pass and have **no** daemon-core
replacement timer. `tmux-reconcile`'s job is instead covered by two
lifecycle-enforcement points that don't need a poll (RUSH-2435): the daemon
repairs every managed session's hook once at startup, and `agents run
--resume`/`agents focus`/`agents go`/`agents tmux attach` each repair the ONE
session they're about to attach to right before attaching
(`ensureSessionHookRepaired`, `lib/tmux/session.ts`). A version-skew one-shot at
upgrade time (`runMigration`, `lib/installations/migrate.ts`) covers a machine that upgrades
without immediately restarting its daemon.

### Legacy device allowlists

> Historical format only. `enabled:` and `devices:` in definition YAML are read
> during migration but are no longer written or used after a host has a
> `routines:` manifest. Use the device-activation commands above.

`~/.agents/routines/` rides the user repo, so every routine syncs to every machine —
and without a restriction, an enabled routine fires on **every** device running the
scheduler. Set `devices:` to restrict which machines may execute the job:

```yaml
# ~/.agents/routines/drain.yml
name: drain
schedule: "0 3 * * *"
agent: claude
devices:
  - yosemite-s0
prompt: "Drain the local work queue"
```

Only the **owner** fires the job — one copy, one run history. Ownership is the
first device in normalized sort order, computed from the config alone, so every
daemon agrees without coordination. Listing several devices is a misconfiguration
(it used to fire the routine once per device) and is refused at creation; omit
`devices:` entirely for a routine that genuinely belongs on every machine.
A single-entry list is equivalent to an exclusive pin: `devices: [yosemite-s0]`
restricts the job to one machine.

Or set the allowlist at creation with `--devices`:

```bash
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --devices yosemite-s0 --prompt "Drain the local work queue"
```

`--devices` is validated against the registered fleet (`agents devices sync`).

For a grouped view of everything, run:

```bash
agents routines list                    # Default: group by project
agents routines list --group-by device  # Group by device/placement instead
agents routines list --flat             # Flat table, no grouping
```

The default grouping buckets routines under their associated project name, **All projects** (for routines tagged `["*"]`), **Cross-project** (multiple projects), **Operations** (no project tag), or **Unknown projects** (stale project names). Pass `--group-by device` to restore the device-placement view, which buckets routines under **This machine**, **Fleet-wide**, **Cloud**, one section per pinned device, and one section per named host. Offline or unknown registry entries are marked in the section header.

Device names are compared against the local `machineId()` (normalized hostname, as
shown by `agents devices`), so `Yosemite-S0` and `yosemite-s0.tailnet.ts.net` both
match `yosemite-s0`.

**A routine runs on exactly one device.** `devices:` is an allowlist, but only its
**owner** fires — the first entry in normalized sort order. Ownership is derived from
the config alone, so every daemon independently reaches the same answer with no lease
and no coordination. Listing several devices is a misconfiguration: it used to fire the
routine once per listed device (duplicate work, duplicate spend), so `add`/`devices --set`
now reject it and `agents doctor` reports any that remain on disk.

**Omitting `devices:` at creation means unrestricted** — the job fires on every
device running the scheduler. That is the genuine fleet-wide case (`watchdog`,
`check-updates`). Later, `devices --clear` **disables** the routine on every
registered device (it does not restore unrestricted — re-add without `--devices`
or enable it on every host if you need fleet-wide again).

On a device not in the allowlist the job is fully inert:

- the cron scheduler skips it
- webhook triggers never match it
- it is never counted overdue, so `catchup` won't fire it and the daemon won't nag
- detached daemon fires and one-shot `--at` jobs skip it
- `agents routines run <name>` errors, naming the allowed devices and offering a
  ready-to-paste `--device <device>` command to run it remotely

`agents routines list` shows the allowlist in a **Devices** column. Unrestricted
jobs display the word `all`; restricted lists are grayed when the local machine
is not in the list. `--json` includes a `devices` array and `runsHere` boolean.

#### Last Status is per-device

Run records live in the runs dir of whichever machine fired the routine and carry
no device attribution, so a record only ever describes the device you are reading
it on. `agents routines list` therefore reports **Last Status only for routines
this device fires**: a routine pinned elsewhere shows `-` in the table, and
`--json` returns `null` for `lastStatus`, `exitCode`, `failureReason`,
`lastRunStartedAt`, and `lastRunCompletedAt` (`runsHere: false` says why). The
same routine renders one row per pinned device, and only the **This machine** row
carries a status.

Without this, a routine re-pinned from one device to another kept reporting the
old device's leftover records — showing a peer's healthy routine as failed, both
in the table and in the menu bar, which reads this JSON.

Read a peer's status where it actually ran:

```bash
agents routines list --device yosemite-s0     # that device's own view
agents routines runs <name> --device yosemite-s0
```

#### v12 migration

Existing routines that use the legacy singular `device: X` field are automatically
migrated to `devices: [X]` on the next load. No manual edit is required.

#### Managing the allowlist

`agents routines devices <name>` opens a preselected multi-select so you can toggle
devices without editing the YAML:

```bash
agents routines devices drain
```

The picker starts with the current allowlist pre-checked. Confirm to overwrite.
`--set` and `--clear` are mutually exclusive.

For scripting:

```bash
agents routines devices drain --set yosemite-s0            # set the owning device
agents routines devices drain --clear                      # disable on every registered device
```

`--set` / `--clear` fan out pause/resume to every registered device so peers
outside the new set stop firing the routine (`--clear` disables it everywhere;
it does **not** restore the unrestricted "fires on every scheduler" default —
omit `--devices` at `add` time for that). An **unreachable** peer (asleep,
offline, missing address) is **skipped with a warning**, not a hard fail — the
pin on reachable targets still succeeds, and an offline box cannot be running
the routine (it picks up the enabled set on its next sync). The command exits
non-zero only when a **selected** target device could not be enabled.

### Project tagging

Tag a routine to one or more projects defined in `agents projects`. Tagging is
**metadata-only** — it organises the routine in `agents routines list` and the menu
bar, and has no effect on scheduling or execution.

```bash
# Tag to a single project
agents routines add nightly-build --schedule "0 3 * * *" --agent claude \
  --project myapp --prompt "Build and run nightly tests"

# Tag to multiple projects (--project is repeatable)
agents routines add cross-test --schedule "0 4 * * *" --agent claude \
  --project myapp --project billing --prompt "Run cross-service integration tests"

# Tag to all defined projects
agents routines add fleet-check --schedule "0 9 * * 1-5" --agent claude \
  --all-projects --prompt "Check fleet health across every project"
```

`--all-projects` and `--project` are mutually exclusive. Both validate names
against `agents projects list` — unknown project names are rejected with a helpful
message.

Project names appear in the YAML as a `projects:` array. The special value `["*"]`
means "all defined projects" (set by `--all-projects`). Routines with no `projects:`
field appear under the **Operations** group.

`agents routines list` groups by project by default:

| Group | Condition |
| --- | --- |
| `<project name>` | single entry in `projects:` |
| **All projects** | `projects: ["*"]` |
| **Cross-project** | two or more entries |
| **Operations** | `projects:` absent or empty |
| **Unknown projects** | project name(s) no longer exist in `agents projects` |

Pass `--group-by device` to switch to the device/placement grouping, or `--flat`
for a single unordered table.

> **Grouping (`projects`) is not the execution anchor.** The `projects:` list above
> only organises the routine in listings — it never decides *where* the body runs.
> The execution directory comes from placement (`devices` / `hostStrategy` / the
> planned singular `project` anchor below), not from these tags. See
> [Execution context and readiness](#execution-context-and-readiness).

### Execution context and readiness

> **Status: planned (RUSH-2290).** The singular `project` anchor, the routine-level
> `cwd`, the readiness/pause behaviour, and the `blocked`/`skipped` run statuses
> described here are the routine reliability contract and are **not yet on `main`**.
> They are specified normatively in
> [specifications.md §Routine execution & readiness](specifications.md#routine-execution--readiness)
> (RT-1..RT-11, RT-GAP-1). Today a routine carries only the `projects` grouping list
> and `remoteCwd` for `host`/`fleet` body placement. This section documents the target
> so hand-authored YAML and downstream tools can align now.

An **agent** or **workflow** routine needs a working directory to run in. Two fields
set it, and they are deliberately separate from the `projects` grouping tags:

```yaml
project: myapp          # singular: the ONE execution anchor (an `agents projects` entry).
                        #   CLI: --project-anchor myapp  (distinct from the repeatable --project grouping flag)
cwd: services/api       # optional: a directory RELATIVE to the resolved anchor/home
```

The directory is resolved **on the device that will run the body** — not on the
daemon that fired it — so a `fleet`/`host`/`cloud` run is checked against the
*target's* filesystem, and a path that only exists on the firing box is caught as a
blocker instead of launching in the wrong place:

| Configuration | Resolved directory | Result |
| --- | --- | --- |
| `project` anchor with a usable base, no `cwd` | the project's base path | runs there |
| `project` anchor + relative `cwd` | base joined with `cwd` (must stay inside the base) | runs there |
| Rootless `project` (e.g. a Linear-imported project with no local checkout) + relative `cwd` | the target's `$HOME` joined with `cwd` (if it exists) | runs there |
| No `project` + relative `cwd` | the target's `$HOME` joined with `cwd` (if it exists) | runs there |
| Absolute `cwd` outside `$HOME` | — | **paused** — not portable across devices |

A **`command`** routine (a plain shell body, no agent, no sandbox) may run from the
target `$HOME` when it has no anchor or `cwd` — housekeeping like `git pull` or
`npm i -g` is home-relative by nature. An **agent**/**workflow** routine may not:
with no anchor and no `cwd` it is saved **paused** with `execution_context_missing`
rather than launched in an arbitrary home.

**Readiness is checked at `add` and `edit`, and a proven blocker saves the routine
paused** — carrying the exact failing check — instead of activating a routine that
would fail at fire time. The codes are stable and machine-readable:

| Readiness code | Meaning |
| --- | --- |
| `project_not_found` | the named `project` anchor is not in `agents projects` |
| `project_path_missing` | the anchor has no usable local base path on the target |
| `cwd_missing` | the resolved `cwd` does not exist on the target |
| `cwd_not_portable` | an absolute `cwd` outside `$HOME` — would not resolve on another device |
| `codex_workspace_untrusted` | the Codex workspace-trust check failed for the resolved directory |
| `agent_auth_failed` | a real headless authenticated smoke failed (a dead/expired account) — not a cache read |
| `execution_context_missing` | an agent/workflow routine with no anchor and no `cwd` |

`agents routines resume <name>` re-runs these checks and refuses to activate a
routine whose blocker is still present — resume is not a way to bypass readiness. A
raw edit of the YAML (or `agents routines edit`) is atomic: the change is parsed and
validated on a temporary copy and only then replaces the live definition, so an
invalid edit leaves the prior bytes untouched, and a valid-but-unready edit replaces
the definition **and** pauses it.

`repo` on a routine is an **external identity**, never the working directory: it is
the GitHub `owner/repo` a webhook trigger filters on, and the origin remote recorded
as provenance under `source:` when a routine is materialised from a project. The
local execution directory is the anchor/`cwd` above; the Git/cloud/webhook `repo`
identity is separate.

### Remote Routing

`--device <name>` routes any `routines` subcommand to a remote machine over SSH,
so you can query or trigger a job on another box without an explicit `agents ssh` call:

```bash
# List another device's routines
agents routines list --device yosemite-s0

# Trigger a job on a specific machine right now
agents routines run drain --device yosemite-s0

# Create a job pre-assigned to two hosts, then confirm it looks right on one
agents routines add drain --schedule "0 3 * * *" --agent claude \
  --devices yosemite-s0 --prompt "Drain queue" --device yosemite-s0
```

When you try to run a job on a host outside its allowlist, the CLI prints:

```
Job 'drain' can only run on: yosemite-s0, mac-mini
  agents routines run drain --device yosemite-s0
```

## Sandbox Isolation

Each job runs with `HOME` set to an overlay directory:

```
~/.agents/routines/daily-review/home/
  .claude/
    settings.json             # Generated with allow.tools permissions
  projects -> ~/projects      # Symlink from allow.dirs
```

The agent can only:
- See directories listed in `allow.dirs`
- Use tools listed in `allow.tools`
- Cannot access `~/.ssh`, `~/.gitconfig`, etc.

**GitHub CLI auth the overlay would otherwise hide is forwarded** (RUSH-2860):
`prepareJobHome` links this machine's `~/.config/gh` (or `$GH_CONFIG_DIR`) into
the overlay, and `buildSpawnEnv` pins `GH_CONFIG_DIR` and forwards
`GH_TOKEN`/`GITHUB_TOKEN`, so a sandboxed monitor `--run` child sees the same
GitHub CLI auth as interactive `agents run`. Same-host only — credentials are
never copied to another box. Nothing else from the host home is linked in: the
overlay still does not contain `~/.ssh`, `~/.gitconfig`, or `~/.agents` (which
holds the secrets master key and the encrypted store).

`assertSandboxForwardsHostGhAuth` is a **regression tripwire, not a runtime
guarantee**. It trips only when a routine's own `env:` overrides
`GH_CONFIG_DIR`; it checks that a `hosts.yml` exists, not that `gh` can
authenticate, so a `hosts.yml` left behind by `gh auth logout` still satisfies
it.

**Windows is not covered.** `resolveHostGhConfigDir` checks `$XDG_CONFIG_HOME/gh`
and `~/.config/gh` only; `gh` on Windows stores config under
`%AppData%\GitHub CLI`, so the forwarding is a no-op there and the new tests
skip on `win32`.

When an agent routine finishes, agents-cli copies the agent transcript out of
the overlay before the next run recreates it. The durable copy lives beside the
run metadata:

```
~/.agents/.history/runs/<routine>/<run-id>/sessions/<agent>/...
```

Those archives are indexed by `agents sessions` with `origin: "routine"`,
`routineName`, and `routineRunId`. Use `agents sessions --routine` (or the
`--routines` alias) to pick a routine interactively, or pass a fuzzy name such
as `agents sessions --routine nightly-review`, to list them. Routine discovery
spans every working directory because a scheduled run is not tied to the shell
where its history is inspected. The picker
includes last-run and session-count context, and the selected view groups sessions
by run ID and timestamp. Use `agents sessions <run-id>` to render the existing session summary view
for a specific routine run.

Archiving is per-agent (`ROUTINE_TRANSCRIPT_SPECS` in `runner.ts`, mirroring
`SESSION_ROOT_SPECS` in `session/discover.ts`) and covers every on-disk session
agent: claude, codex, cursor, gemini, antigravity, droid, kimi, grok. `opencode`
is the one exception — its transcripts live in one incrementally-scanned SQLite
db (`~/.local/share/opencode/opencode.db`), not a per-session file tree, so
there's nothing for this mechanism to copy out.

### Account auth for routines

A native Claude identity is pinned to its installed version home:
`buildRoutineSpawnEnv` sets `CLAUDE_CONFIG_DIR` to that home (`runner.ts`), so even
under the sandbox overlay — which gives the spawn a clean `HOME` — Claude Code
resolves the credential it owns from `CLAUDE_CONFIG_DIR`. The routine removes an
ambient `CLAUDE_CODE_OAUTH_TOKEN`; agents-cli neither copies nor converts native
OAuth material.

A provider account follows the same adapter path as interactive `agents run`: its
device-local secret bundle supplies the configured API key, setup token, or bearer
token. The account may be selected explicitly with `account:` or through the
agent's provider default. A routine preflights the account metadata and secret on
the firing device before spawn. A missing bundle, mismatched stable identity, or
incompatible provider/model fails the run rather than rotating to another account.

To bring a signed-out box back, log in on that box once — `agents run claude` (or
`claude` directly) drives the interactive login and writes the credential the
routine then reuses. The daemon does not need restarting; it reads no credential.

### Cursor auth and workspace trust for routines

A sandboxed Cursor routine reuses the login from this same device without copying
credentials to another host. The routine overlay links the local Cursor auth file
from `$XDG_CONFIG_HOME/cursor` (or `~/.config/cursor`) and the CLI preferences from
`~/.cursor/cli-config.json`, then pins `XDG_CONFIG_HOME` to that overlay. If the
device is signed out, the run fails as `auth_failed` with Cursor's `agent login`
instruction.

Cursor routines pass `--trust` because configuring a routine with a working
directory is the user's workspace-trust decision. This is narrower than `--yolo`
or `-f`: it accepts the workspace without bypassing tool permissions. Cursor's
read-only plan mode exists in the CLI but is not enabled in the agents-cli
capability registry yet (RUSH-2101), so `mode: plan` currently warns and runs the
registry-selected writable mode.

The same trust rule applies to any headless `agents run cursor "<prompt>"` launch:
agents-cli passes `--trust` because the caller selected both a working directory
and a non-interactive prompt. Interactive `agents run cursor` launches preserve
Cursor's own workspace-trust prompt and never add `--trust`.

### Pinning an account (avoid the OAuth-rotation revocation storm)

When no provider default is configured, an unpinned `claude` routine selects a
native identity by the default `balanced` strategy — a stateless weighted-random
roll (`rotate.ts`) that can land two
concurrent runs, on one box or across the fleet, on the *same* account. Claude's
OAuth refresh token is **single-use and rotates server-side on every refresh**, so
when a second run refreshes an account the first is still holding, the first run's
token is revoked mid-flight and the run dies with:

```
Failed to authenticate. API Error: 401 OAuth access token has been revoked.
```

Multiplied across ~20 unpinned routines that all wake in the same morning window,
this is a self-inflicted logout storm (RUSH-1957).

**The durable cure: give each routine (or each device's routines) its own
account.** Pin by identity with `account:` — the login email, resolved at launch
to whichever installed version holds that account, run pinned with no rotation and
no failover onto other accounts:

```yaml
name: drain-prix
schedule: "15,45 * * * *"
agent: claude
devices: [yosemite-s1]
account: muqsit@trp.so      # this box's routines all refresh ONE account, no one else's
```

Prefer `account:` over `version:`: a `version:` pin names a version *number* that
is garbage-collected on the next `claude` upgrade, after which the routine
silently falls back to `balanced` and the storm returns. Pinning by account
identity survives version churn. If the named native identity is not signed in on
the box at fire time, the routine refuses to run rather than rotating to a sibling
identity. List native and provider accounts with `agents accounts`.

## Execution Flow

Temporal sequence from cron fire to report saved.

```
croner            JobScheduler          runner.ts           sandbox.ts       spawned agent       filesystem
(library)         scheduler.ts:20       executeJob          prepareJobHome   (claude/codex/      ~/.agents-system/runs/
                                                                              kimi)

     │                  │                  │                    │                │                    │
     ●──fire callback──▶│                  │                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │──onTrigger(cfg)──▶                    │                │                    │
     │                  │  (scheduler.ts:42)                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │──resolveJobPrompt──│                │                    │
     │                  │                  │  + buildJobCommand │                │                    │
     │                  │                  │  (runner.ts:40)    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │  if sandbox≠false: │                │                    │
     │                  │                  │──prepareJobHome───▶│                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │                    ├─rm old overlay─────────────────────▶│
     │                  │                  │                    ├─mkdir ~/.agents/routines/{name}/home▶│
     │                  │                  │                    ├─generateClaudeConfig (etc.)────────▶│ .claude/
     │                  │                  │                    │                                    │   settings.json
     │                  │                  │                    ├─symlinkAllowedDirs─────────────────▶│ home/<dir>->...
     │                  │                  │                    │                │                    │
     │                  │                  │◀──overlayHome──────│                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  │──buildSpawnEnv─────▶│                │                    │
     │                  │                  │  HOME=overlay      │                │                    │
     │                  │                  │  + ENV_ALLOWLIST   │                │                    │
     │                  │                  │  (sandbox.ts:19)   │                │                    │
     │                  │                  │                    │                │                    │
     │                  │                  ├─mkdir runDir, open stdout fd────────────────────────────▶│ runs/{job}/{runId}/
     │                  │                  ├─writeRunMeta(status='running')──────────────────────────▶│   meta.json
     │                  │                  │                    │                │                    │
     │                  │                  ├─spawn(cmd, {       │                │                    │
     │                  │                  │    detached:true,  │                │                    │
     │                  │                  │    stdio:[ign,     │                │                    │
     │                  │                  │          fd, fd],  │                │                    │
     │                  │                  │    env: spawnEnv   │                │                    │
     │                  │                  │  })  runner.ts:159─────────────────▶●                    │
     │                  │                  │                    │                │──stdout────────────▶│ stdout.log
     │                  │                  │                    │                │                    │
     │                  │                  │  setTimeout(timeout)                │                    │
     │                  │                  │  runner.ts:170     │                │                    │
     │                  │                  │                    │                ●──agent runs──       │
     │                  │                  │                    │                │   prompt, uses     │
     │                  │                  │                    │                │   allowed tools    │
     │                  │                  │                    │                ●──exits(code)───    │
     │                  │                  │◀───────'exit'──────────────────────────────────────────  │
     │                  │                  │                    │                │                    │
     │                  │                  ├─writeRunMeta(status=code===0 ? 'completed' : 'failed')──▶│ meta.json
     │                  │                  │                    │                │                    │
     │                  │                  ├─extractAndSaveReport(stdoutPath, agent, runDir)─────────▶│ report.md
     │                  │                  │  runner.ts:271     │                │                    │
     │                  │                  │                    │                │                    │
     │                  │◀──resolve────────│                    │                │                    │
     │                  │                  │                    │                │                    │
     │                  │  if runOnce:     │                    │                │                    │
     │                  │  ├─unschedule    │                    │                │                    │
     │                  │  └─deleteJob     │                    │                │                    │
     ▼                  ▼                  ▼                    ▼                ▼                    ▼
```

On timeout: the setTimeout at `runner.ts:170` fires, sends `SIGTERM` to the
process group (`process.kill(-child.pid, 'SIGTERM')`), waits 5s, then
`SIGKILL`. Report extraction runs regardless — a truncated stdout is still
valuable.

## Run State Machine

Each `RunMeta.status` value maps to one terminal state. Transitions are
one-shot — a run never re-enters `running` once it leaves.

```
                        ┌─────────────┐
                        │  (spawned)  │
                        └──────┬──────┘
                               │
                               ▼
              writeRunMeta(status='running')
              runner.ts:149
                               │
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         │                     │                     │
         ▼                     ▼                     ▼
    exit code=0          exit code≠0         timeout fires
    runner.ts:200        runner.ts:200       runner.ts:184
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────┐           ┌────────┐            ┌─────────┐
    │completed│           │ failed │            │ timeout │
    └─────────┘           └────────┘            └─────────┘
                                                      │
                                                      │
                                             SIGTERM → wait 5s → SIGKILL
                                             report still extracted from
                                             partial stdout
```

Plus one error branch: `child.on('error')` at `runner.ts:208` (spawn itself
failed — binary not found, EACCES, etc.) → `status='failed'` with `exitCode=null`.

### `missed` — the run that never started

`missed` is the one status the runner never writes, because no process was ever
spawned. It records that a scheduled fire **did not happen**: the scheduler was
down, asleep, or wedged when the routine came due. `claimMissedFire`
(`catchup.ts`) writes it with `pid: null`, `exitCode: null`, and `startedAt` set
to the moment the fire was **due** — not the moment it was noticed — so the gap
lands at the right point in `agents routines runs <name>`.

Without it a miss left no trace at all, and the listing kept showing the previous
run's `completed` as though it were current.

### `blocked` and `skipped` — planned attempt records (RUSH-2290)

> **Status: planned.** These two statuses and the pre-session attempt records they
> describe are the routine reliability contract, not yet on `main` (today the status
> set stops at `missed`). Specified in
> [specifications.md §Routine execution & readiness](specifications.md#routine-execution--readiness)
> (RT-6, RT-7) and [§Scheduling & execution singularity](specifications.md#scheduling--execution-singularity) (SING-13).

Two operational states are today invisible because no process spawns for them, and
the reliability plan makes each its own terminal run so it shows up in
`agents routines runs` before any session exists:

- **`blocked`** — a **readiness** check failed at fire time (a dead account, an
  untrusted Codex workspace, a missing anchor/cwd), so the body never ran. Distinct
  from `failed`, where the body ran and errored: a routine that never launched because
  its account was dead is a different problem from one that threw mid-run, and
  collapsing them hides which one you have. For the **signed-out** case specifically
  (PHNX-3415), the daemon preflights the rotation-resolved account against the
  auth-health cache and records `blocked`/`agent_auth_failed` — with the exact
  `agents run <agent>@<v> -- login` repair — when it is `revoked` or `unconfigured`,
  instead of spawning a run that 401s and lands as `failed`. The fire-time check is
  cache-only (a live smoke on every fire would risk a 429 storm) and fails **open** on
  any still-usable or indeterminate verdict, so a stale probe never wedges a routine
  (RT-12).
- **`skipped`** — the routine was **already running** when its next slot arrived
  (self-overlap). Rather than launch a second concurrent instance, the new occurrence
  records a `skipped` run linked to the still-active run.

Run history is the canonical record of what a routine did — a session transcript,
log, report, or artifact is an *optional child* of a run, not the record itself. That
is why a `missed`, `blocked`, or `skipped` attempt is fully visible with no session
attached.

### One fire launches once

A single scheduled occurrence launches a routine **at most once**, even if the same
UTC slot is evaluated by two timer callbacks or replayed on a daemon restart. The
landed guarantee for the catch-up path is the atomic `mkdir` claim below (a `missed`
record's run directory is a test-and-set). The reliability plan (RUSH-2290) extends
the same idea to the primary scheduled path: one atomic claim on the occupancy
identity `(routine, scheduledFor)` before dispatch, kept separate from the
active-run claim that prevents self-overlap (`SING-13`, `SING-15`, `SING-16`).

## Catching up a missed fire

Fires are in-process croner timers, and croner only schedules forward from "now".
A daemon that was not running when a routine came due therefore loses that fire —
`loadAll()` (`scheduler.ts`) rebuilds every timer looking only at the future, so
nothing replays it. This is routine on a laptop: close the lid over a 9pm
schedule and the routine simply never ran.

The daemon recovers from this itself. `detectOverdueJobs` (`overdue.ts`) compares
each enabled routine's most recent expected fire against its most recent recorded
run; `runCatchup` (`catchup.ts`) then records each miss and re-runs it via the
same detached path `agents routines catchup` uses. It runs **at daemon startup
and every 5 minutes** — a startup-only pass would miss a fire lost while the
daemon stayed up but its event loop was wedged, or one lost across an OS suspend
the process survived.

Detection looks back far enough to see the routine's own period. The window widens
week → month → quarter → year, and only when the narrower one finds nothing, so a
dense schedule never walks more than a week of occurrences. A fixed one-week
lookback silently skipped anything sparser: `0 9 1,13,25 * *` has 12-day gaps, so on
10 of every 28 days it could not be evaluated at all.

A routine past its `endAt`, and a one-shot (by flag *or* by schedule shape), is never
caught up — catch-up replays a missed fire, it does not resurrect a retired routine.

Catch-up is idempotent without a ledger: the `missed` record advances the overdue
comparison, so the same missed fire is never reconsidered — across ticks, a daemon
restart, or a restart storm.

Two callers that overlap are handled by a claim rather than a lock. Writing the
`missed` record creates its run directory with a non-recursive `mkdir` — an
atomic test-and-set — and only the caller that wins it runs the routine. So if
the daemon's 5-minute pass and a manual `agents routines catchup` overlap, the
routine still starts exactly once; the loser reports `already claimed by the
scheduler`. This is deliberately at-most-once: a process that dies between
claiming and spawning leaves that fire un-run, which is the right trade when the
alternative is spawning an agent twice.

Device scoping still applies: a routine pinned elsewhere is skipped, so a fleet of
machines never all catch up the same routine.

A routine is also never caught up for a fire that **predates it**. `writeJob` stamps
`createdAt` once, and overdue detection floors the most recent expected occurrence at
it (`routineEffectiveStart`, `overdue.ts`), falling back to the routine file's mtime
for routines written before the field existed. Without that floor, adding a routine on
any daily or weekly schedule whose slot had already passed would make it instantly
overdue — and catch-up would run it once, immediately, minutes after you created it.

### Opting out — `catchup: false`

Catch-up defaults to **on**: a routine you scheduled is one you expect to have
run, so losing a fire silently is never the helpful default.

Set `catchup: false` on a routine whose value is tied to its clock — a 9am
standup brief is worthless at 3pm:

```yaml
name: crm-pipeline-brief
schedule: "0 8 * * 1-5"
catchup: false
```

or at creation:

```bash
agents routines add crm-pipeline-brief --schedule "0 8 * * 1-5" --agent claude \
  --no-catchup --prompt "Morning pipeline brief"
```

An opted-out routine still **records** the miss — you see it as `missed` in the
listing and in `agents routines runs` — it is just not re-run.
`agents routines list --json` reports the effective value as `catchup`.

Force a pass by hand at any time:

```bash
agents routines catchup            # record + run every missed fire now
agents routines catchup --dry-run  # record the misses, run nothing
```

## Sandbox Data Flow

What `prepareJobHome` produces on disk, given a job config.

```
Input:  JobConfig                                Output:  ~/.agents/routines/{name}/home/

┌──────────────────────────┐                    ┌─────────────────────────────────────────┐
│ name: daily-review       │                    │ (cleanJobHome removes any prior overlay)│
│ agent: claude            │                    │                                         │
│ mode: plan               │  prepareJobHome    │ .claude/                                │
│ allow:                   │  sandbox.ts:74     │   settings.json  ← generateClaudeConfig │
│   dirs:                  │                    │                    - mode → permMode    │
│     - ~/projects/myapp   │ ─────────────────▶ │                    - allow.tools        │
│   tools:                 │                    │                    - SAFE_TOOLS expand  │
│     - Bash(git *)        │                    │                                         │
│     - Read               │                    │ myapp -> /Users/you/projects/myapp      │
│     - web_search         │                    │   (symlink, from allow.dirs)            │
│                          │                    │                                         │
└──────────────────────────┘                    └─────────────────────────────────────────┘

                                                 Env handed to child process:
                                                 (sandbox.ts:52, buildSpawnEnv)
                                                 ┌─────────────────────────────────────────┐
                                                 │ HOME=~/.agents/routines/daily-review/home│
                                                 │ + forwarded from parent only if in      │
                                                 │   ENV_ALLOWLIST (sandbox.ts:19):        │
                                                 │   PATH, SHELL, TERM, LANG, LC_*, USER,  │
                                                 │   TMPDIR, XDG_*, NVM_DIR, NODE_PATH,    │
                                                 │   BUN_INSTALL, EDITOR, VISUAL, NO_COLOR │
                                                 │   FORCE_COLOR                           │
                                                 │ + TZ (if config.timezone)               │
                                                 │                                         │
                                                 │ Everything else (AWS_*, OPENAI_API_KEY, │
                                                 │ GITHUB_TOKEN, etc.) is DROPPED.         │
                                                 └─────────────────────────────────────────┘
```

Tools in `allow.tools` are expanded per two small tables at `sandbox.ts:43-49`:

- `SAFE_TOOLS` — safe wildcards (`web_search` → `WebSearch(*)`, `web_fetch` → `WebFetch(*)`)
- `DIR_SCOPED_TOOLS` — always scoped, never wildcarded (`read`, `write`, `edit`, `glob`, `grep`, `notebook_edit`). A bare `Read` in config expands to `Read(dir1)`, `Read(dir2)`… for each entry in `allow.dirs`.

This is the core isolation invariant: the spawned agent's view of the
filesystem is **only** the symlinks we created in the overlay, plus any
file:// paths its tools touch via the allowed-tool expansion. No `~/.ssh`,
no `~/.gitconfig`, no ambient AWS/OPENAI keys.

### Run Output

Each execution creates a run directory with structured output:

```
~/.agents/
  runs/
    daily-review/
      2026-04-17T09:00:00.000Z/
        stdout.log                    # Full terminal output
        stderr.log                    # Error output
        exit-code                     # Exit status (0, 1, etc.)
        report.md                     # Extracted report
        meta.json                     # RunMeta: { agent, version, mode, status, duration, ... }
```

### Desktop notifications

The daemon fires a native macOS notification on the routine lifecycle, routed
through the `MenubarHelper.app` companion (`src/lib/menubar/notify-desktop.ts`)
so it carries the agents-cli mark (the bundle's `AppIcon`) rather than the
generic AppleScript/Script Editor icon. An agent routine carries the harness it
runs on as the banner's right-hand avatar (`routineAgent`); a workflow routine
runs via `agents run <workflow>` (delegated to claude), so it shows the Claude
avatar — the same harness the finish banner records; a command routine has no
agent and shows the agents-cli mark alone. When the
menu-bar helper is not
installed (Linux, or a machine that disabled it), delivery degrades to
`osascript`/`notify-send` so a notice is never silently lost.

| Event | When | Threshold |
| --- | --- | --- |
| **Start** | The scheduler triggers a routine | Agent/workflow routines only — command (housekeeping) routines are suppressed to avoid spam |
| **Finish** | The run reaches a terminal state | Always for agent/workflow; command routines notify only on **failure** |
| **Overdue** | Daemon startup finds a missed recurring routine | Any overdue routine (`src/lib/overdue.ts`) |

All three of the above fire from **inside** `runDaemon()`, so none of them can
ever notice that the daemon itself has died — the exact outage that means no
routine will fire again until someone restarts it. That gap is closed by a
separate, daemon-independent watchdog in the menu-bar helper (which runs as its
own launchd `KeepAlive` service): see
[AGI Menu → Daemon-down watchdog](https://github.com/phnx-labs/agi-menu/blob/main/docs/menubar.md#daemon-down-watchdog)
(the helper's own repo; [menubar.md](menubar.md) here is the cross-repo contract).

"Notable output" is folded into the single **Finish** notification, not sent as
a third message: on success the body is the first line of `report.md` (the
routine's user-facing result), on failure it is the error reason. So a normal
run produces exactly one start + one finish notification.

Notifications are actionable where a target exists: clicking a **Finish** opens
the run's `report.md`/`stdout.log`; **Start**/**Overdue** open the runs folder.
The finish notification only fires for locally-run routines — `host:`-placed
runs are finalized by the monitor sweep and do not emit one.

### Owner notification on failure (RUSH-2288)

Desktop notifications never leave the machine, so a failed routine on a headless
fleet box was invisible until someone looked. On a **failure only** — a
`failed`/`timeout` finish, or a pre-spawn failure such as `auth_failed` — the
daemon also pings the **owner's phone**, through the same channel stack `agents
notify` uses (the `owner.channels` in `humans.yaml`, or the legacy
`notify.owner` in `agents.yaml`). This is the failure the per-routine `agents
notify` prompt can never send itself: when the routine's own agent fails to
spawn, that prompt never runs.

- **Only failures.** A green routine of any kind stays silent. The desktop
  thresholds above are unchanged; this is an additional failures-only lane.
- **In-process, not `ssh`.** The daemon calls the channel providers directly
  (`src/lib/routine-notify-owner.ts`) — it does not shell out to `ssh mac-mini
  agents notify`.
- **Fallback channel.** If the primary owner channel cannot deliver from this
  box, the daemon walks the remaining configured `owner.channels` in order
  (e.g. an OpenClaw channel after iMessage). Telegram and intrusive (voice)
  channels are excluded; an owner whose only channel is Telegram gets no ping.
- **Deduped** per job+runId, so a run reaches the owner at most once.

## Commands

```bash
# Lifecycle
agents routines list                  # List all jobs with next run + status
agents routines list --device yosemite-s0  # List another device's routines
agents routines add <name> --schedule "0 9 * * *" --agent claude --prompt "..."  # Inline
agents routines add <name> --devices yosemite-s0 --schedule "0 3 * * *" \
  --agent claude --prompt "..."       # Add with device allowlist
agents routines add <name> --project myapp --schedule "0 9 * * *" \
  --agent claude --prompt "..."       # Group under a named project (repeatable metadata)
agents routines add <name> --project-anchor myapp --cwd apps/api \
  --schedule "0 9 * * *" --agent claude --prompt "..."  # Execution context
agents routines add <name> --all-projects --schedule "0 9 * * *" \
  --agent claude --prompt "..."       # Tag to all defined projects
agents routines add <path.yml>        # Add from YAML file
agents routines add <name> --at "14:30" --agent claude --prompt "..."            # One-shot
agents routines edit <name>           # Transactional temporary-YAML editor
agents routines edit <name> --yaml    # Same editor; explicit compatibility flag
agents routines remove <name>         # Delete a job
agents routines pause <name>          # Disable a job
agents routines resume <name>         # Re-enable a paused job
agents routines doctor <name>         # Check execution context + harness readiness
agents routines doctor --all --fix    # Apply safe deterministic readiness repairs

# Device allowlist management
agents routines devices <name>                         # Interactive multi-select picker
agents routines devices <name> --set yosemite-s0           # Set the owning device
agents routines devices <name> --clear                 # Disable on every registered device

# Execution
agents routines run <name>            # Run immediately in foreground
agents routines run <name> --device yosemite-s0  # Run on a specific remote device
agents routines view <name>           # Show job config
agents routines runs <name>           # Attempt history (session optional)
agents routines stats                 # Run count/failed/missed/avg/p50/p95 duration, every job
agents routines stats <name>          # Same rollup, scoped to one job
agents routines logs <name>           # Show concise summary from latest run
agents routines logs <name> --run <id>  # Show specific run
agents routines logs <name> --full    # Show raw stdout from latest run
agents routines report <name>         # Show report from latest run
agents routines report <name> --run <id>  # Show specific run report
agents sessions <run-id>              # Show the archived agent transcript summary

# Scheduler service (manual controls; the shared daemon stays up)
agents routines start                 # Enable/reload the scheduler service
agents routines stop                  # Disable/reload only the scheduler service
agents routines status                # Show scheduler + shared-daemon status and upcoming runs
agents routines scheduler-logs        # Read scheduler log output
```

> **Planned (RUSH-2290), not yet on `main`:** the readiness contract above adds an
> execution anchor and a diagnose/repair command —
> `agents routines add|edit <name> --project-anchor <name> --cwd <dir>` to set the
> singular anchor and working directory, and `agents routines doctor [name] [--fix]`
> to re-check readiness and repair blockers. `--project-anchor` is deliberately
> distinct from the existing repeatable `--project` grouping flag. See
> [Execution context and readiness](#execution-context-and-readiness).

### Non-Interactive Usage

For scripting, pass explicit names and flags to avoid interactive pickers:

```bash
# Add a job without pickers
agents routines add morning-briefing --schedule "0 8 * * 1-5" \
  --agent claude --mode plan --prompt "Summarize overnight changes in the repo"

# Run a job in the foreground
agents routines run morning-briefing

# View the report
agents routines report morning-briefing
```

## Scheduler

A scheduler service inside the shared `agents` daemon watches for cron-triggered jobs. It persists across CLI invocations and auto-reloads when job configs change.

```bash
agents routines start     # Enable/reload it (usually unnecessary after install)
agents routines stop      # Disable/reload it; sibling daemon services stay up
agents routines status    # Check scheduler state, daemon state, PID, binary, heartbeat, and upcoming runs
```

`routines start|stop` are scheduler-service controls, not aliases for daemon
start/stop. They persist the `scheduler` toggle and signal a running daemon with
SIGHUP, preserving its PID and every sibling service. `start` cold-starts the
daemon only when no daemon is running. Whole-process lifecycle remains the
operator-owned `agents daemon start|stop|restart` surface (PHNX-3605).
`routines status --json` reports both `serviceEnabled` (the daemon-service
toggle) and `deviceEnabled` (the machine-local `scheduler.enabled` gate), while
`state` reflects their effective conjunction and `daemonState` reports the
shared process independently.

The daemon **starts at install/upgrade** (`postinstall` on darwin/linux) and on
first `agents setup` / `agents setup --force` (when `daemon.enabled` is not
false), so launchd/systemd KeepAlive keep it up. `agents routines add`
still ensures the scheduler is running and reloads it — you rarely need
`routines start` manually. When you `add`, `remove`, `pause`, or `resume` a job,
it auto-reloads. `daemon.enabled=false` suppresses cold starts at install and
setup, and still gates `ensureDaemonStarted`; deliberate `agents daemon start`
remains the operator override.
Scheduled fires use two independent guards. An atomic slot claim keyed by routine
name and the intended UTC schedule time ensures a delivered slot launches once,
including across daemon reloads. A separate active-run claim prevents a routine
from overlapping itself across scheduled, catch-up, webhook, detached, and manual
foreground paths. A later slot while work is active writes a `skipped` attempt
linked to the active run and spawns no process.

Every requested attempt receives run metadata before placement, account selection,
sandbox construction, readiness, or dispatch. `blocked` means the readiness gate
prevented entry into placement; `failed` means placement, dispatch, or execution
failed after the run path began;
`skipped` means another slot/active/owner claim won. Routine history is therefore
complete even when no transcript was created. `agents sessions --routines` builds
its routine picker from definitions and run directories so zero-session routines
remain selectable, but its result rows are archived sessions. Use `agents routines
runs <name>` for canonical attempt history, including attempts with no transcript.

`agents routines status` reports the scheduler as `running`, `wedged`, or `stopped`. A live PID whose heartbeat is more than three monitor ticks old is `wedged`; the status output includes the restart command. Both `routines list` and `routines status` also finalize orphaned `running` records before rendering. Run metadata records process birth time to reject recycled PIDs and persists the configured execution deadline. Detached children are killed when that deadline expires, including after a scheduler restart.

The status output includes the resolved daemon binary. Startup rejects bun virtual-filesystem paths and warns when the binary lives under an ephemeral root — a git worktree, or a temporary directory (`/tmp`, `/var/folders`, `/dev/shm`) — because deleting that directory would strand the service. The daemon resolves its own job modules from the launch path, so a direct `agents __daemon-run` from such a build wedges every routine with `ENOENT` once the directory is removed; the warning fires both at spawn time (`validateDaemonBinary`) and at the daemon's own startup (`warnEphemeralDaemonRoot`), so a directly-launched daemon still surfaces the risk. Run it from the globally installed binary to root it at a stable version home.

## Key Functions

| Function | File | Purpose |
|------|------|------|
| `listJobs()` | routines.ts | List all configured jobs |
| `writeJob()` / `readJob()` | routines.ts | Persist job config |
| `executeJob()` | runner.ts | Run job with sandbox isolation |
| `createOverlay()` | sandbox.ts | Create HOME overlay with permissions |
| `scheduleJob()` | scheduler.ts | Register cron trigger |
| `signalDaemonReload()` | daemon.ts | Notify daemon to reload config |
| `parseAtTime()` | routines.ts | Parse --at time strings to cron |
| `getLatestRun()` / `listRuns()` | routines.ts | Query execution history |
| `jobRunsOnThisDevice()` | routines.ts | Check if job is eligible on current machine |
| `routineStats()` | routines.ts | Fold `listRuns()` into `{count, failed, missed, avgMs, p50, p95}` — `agents routines stats` |
