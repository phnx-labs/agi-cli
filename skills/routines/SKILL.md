---
name: routines
description: "Schedule agents to run on a cron schedule or one-shot at a specific time. The scheduler auto-starts on first add. Triggers on: 'schedule an agent', 'recurring job', 'cron', 'daily', 'every weekday', 'run at 2pm'."
argument-hint: "[add|list|run|logs|report|pause|resume|remove]"
allowed-tools: Bash(agents routines*)
user-invocable: true
---

# Routines Skill

Schedule agents to run on a cron schedule or one-shot at a specific time. Routines are YAML jobs that specify which agent runs, when, what task, and execution constraints.

## What a routine is

A YAML job with four parts:

- **Which agent** — claude, codex, gemini, cursor, opencode
- **When** — cron schedule (recurring) or specific time (one-shot)
- **What task** — the prompt for the agent
- **Execution constraints** — mode, effort, timeout

The background scheduler auto-starts the first time you add a routine.

## Quickstart: recurring (cron)

```bash
# Every weekday at 9 AM
agents routines add daily-standup \
  --schedule "0 9 * * 1-5" \
  --agent claude \
  --prompt "Draft standup from git log"
```

Cron format is standard 5-field (minute hour day month weekday).

## Quickstart: one-shot

Runs once at a specific time, then disables itself.

```bash
# Tomorrow at 2:30 PM
agents routines add hotfix-review \
  --at "14:30" \
  --agent codex \
  --prompt "Review hotfix PR #42"

# Exact date + time
agents routines add launch-check \
  --at "2026-06-01 09:00" \
  --agent claude \
  --prompt "Run launch readiness audit"
```

## From a YAML file

For complex routines with multiple settings, author a YAML and reference its path.

```bash
agents routines add ./weekly-report.yml
```

Example `weekly-report.yml`:

```yaml
name: weekly-report
schedule: "0 17 * * 5"
agent: claude
mode: edit
effort: high
timeout: 1h
timezone: America/Los_Angeles
prompt: |
  Summarize this week's shipped PRs and open issues.
  Post the summary to #engineering.
```

## Mode, effort, timeout

```bash
agents routines add backup-job \
  --schedule "0 2 * * *" \
  --agent claude \
  --prompt "Run nightly backup verification" \
  --mode edit \
  --effort high \
  --timeout 1h
```

| Flag | Default | Values |
|------|---------|--------|
| `--mode` | `plan` | `plan` (read-only), `edit` (can write files) |
| `--effort` | `auto` | `low \| medium \| high \| xhigh \| max \| auto` |
| `--timeout` | `30m` | Duration string (e.g., `30m`, `2h`) |

## Timezone

Interpret the cron schedule in a specific timezone.

```bash
agents routines add london-update \
  --schedule "0 9 * * *" \
  --timezone Europe/London \
  --agent claude \
  --prompt "Post morning update to #london"
```

## Create paused

```bash
agents routines add experimental --schedule "0 * * * *" --agent claude --prompt "..." --disabled
agents routines resume experimental
```

## Scheduler lifecycle

The scheduler auto-starts on first `add`. Manage manually:

```bash
agents routines status            # is the scheduler running?
agents routines start             # start it
agents routines stop              # stop all routines
agents routines scheduler-logs    # tail scheduler stdout
agents routines scheduler-logs --follow -n 200
```

## Inspect routines

```bash
agents routines list              # all routines + next run + last status
agents routines view daily-standup
```

## Test a routine right now

Run in the foreground, ignoring the schedule. Use this to validate prompts before letting them fire on schedule.

```bash
agents routines run daily-standup
```

## Run on another machine

`--run-on <name>` places the job body on a host/device over SSH (placement);
`--devices` restricts which machine's scheduler may fire it (eligibility).
`--run-on` without `--devices` auto-pins firing to the adding machine so a
fleet of schedulers can't dispatch duplicates.

```bash
agents routines add nightly -s "0 2 * * *" -a claude -p "run the sweep" \
  --run-on gpu-box --run-cwd ~/proj
```

The dispatched run tracks in `agents devices ps` (named after the routine) and
the run history finalizes from the remote exit code. Workflow-bundle and
`loop:` routines can't cross SSH yet and refuse `--run-on` at add time.

## Pause and resume

```bash
agents routines pause daily-standup
agents routines resume daily-standup
```

## History, logs, and reports

Each fire is recorded as a run. Inspect them:

```bash
agents routines runs daily-standup           # list recent runs
agents routines logs daily-standup           # latest run's stdout
agents routines logs daily-standup --run <id>
agents routines report daily-standup         # extract markdown the agent produced
agents routines report daily-standup --run <id>
```

## Remove, edit

```bash
agents routines edit daily-standup           # opens the YAML in $EDITOR
agents routines remove daily-standup
```

## Sandboxing

Routines run with the permissions you grant them. Agents only see directories and tools you allow — same model as `agents run --mode plan/edit/full`. Use `--mode plan` for routines that should never write.

## Quick reference

| Command | Purpose |
|---------|---------|
| `add <name> --schedule ... --agent ... --prompt ...` | Create cron routine |
| `add <name> --at "14:30" --agent ... --prompt ...` | Create one-shot routine |
| `add ./file.yml` | Create from YAML |
| `list` | All routines + next run |
| `view <name>` | Show routine YAML |
| `edit <name>` | Open routine in $EDITOR |
| `run <name>` | Foreground run (ignores schedule) |
| `runs <name>` | Recent run history |
| `logs <name> [--run <id>]` | Stdout of a run |
| `report <name> [--run <id>]` | Extract markdown output |
| `pause <name>` / `resume <name>` | Disable / re-enable |
| `remove <name>` | Delete routine |
| `start` / `stop` / `status` | Scheduler lifecycle |
| `scheduler-logs [--follow] [-n N]` | Tail scheduler logs |

For everything else, run `agents routines --help`.
