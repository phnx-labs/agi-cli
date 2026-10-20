# Automation

The daemon is the sole scheduler for periodic maintenance. UI clients
may request an action or render state; they never own an acting timer.

```mermaid
flowchart TB
  SES[Session progress] --> D[Daemon decision loop]
  TICK[Service tick] --> D
  D --> CLAIM[Durable claim or policy decision]
  CLAIM --> EXEC[Execution engine]
  EXEC --> CONV[Session]
  CONV --> VIEW[CLI and UI projections]
```

## Scheduled agent work

The CLI has no job scheduler. Run recurring agent work from the OS scheduler (cron, a
systemd timer, or launchd) and have it invoke `agents run` headlessly:

```cron
0 9 * * 1-5 cd ~/src/app && agents run claude "Review yesterday's PRs" --mode plan
```

Each fire is an ordinary `agents run`, so it gets the same env build, version-home
isolation, account rotation, and session indexing as a run started by hand. A job that
drains shared input (a tracker, a PR queue) belongs on one device only, per
[§Scheduling & execution singularity](specifications.md#scheduling--execution-singularity)
SING-9.
