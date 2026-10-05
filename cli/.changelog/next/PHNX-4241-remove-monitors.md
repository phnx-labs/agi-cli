- **`agents monitors` is removed (PHNX-4241).** The command group, the monitor
  engine, and the daemon's `monitors` service are gone; `agents monitors …` now
  fails as an unknown command. Upgrading stops monitor polling and dispatch: the
  self-updating daemon relaunches onto code with no monitor service, and a stale
  `monitors:` key in `~/.agents/daemon/services.yaml` is ignored. Monitor
  definitions in `~/.agents/monitors/` and fire history in
  `~/.agents/.history/monitors/` are left on disk untouched. Use `agents routines`
  for scheduled work, webhook receivers for push events, and
  `agents projects prs automerge` for merge-on-green. Source: `cli/src/lib/daemon/daemon.ts`,
  `cli/src/lib/daemon-services.ts`, `cli/src/cli/command-registry.ts`.
