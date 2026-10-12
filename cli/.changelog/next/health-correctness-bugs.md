- **`--since` accepts weeks and rejects values it cannot read.** `agents daemon logs --since 1week`
  used to print nothing, because the parser had no week unit and an unreadable value silently
  meant "now". `daemon logs` and `events` now share one parser that takes `1w`/`1week`/`2weeks`
  and ISO dates, and an unparseable `--since` exits non-zero with `Invalid --since value`. A bare
  number now means seconds, so `events --since 2024` is 2024 seconds ago, not 1 January 2024;
  write the full ISO date (`2024-01-01`).
  Source: `cli/src/lib/hooks/cache.ts`, `cli/src/commands/daemon.ts`, `cli/src/commands/events.ts`.
- **A signal-killed process no longer exits 0.** After a self-upgrade, `agents` re-runs your
  command; if that child was killed by a signal, the CLI exited 0. It now exits 128+signal
  (143 for SIGTERM), the same code the `browser` and `computer` forwarders report.
  Source: `cli/src/lib/platform/process.ts`, `cli/src/bootstrap.ts`.
- **The watchdog log follows `AGENTS_LOGS_DIR`.** `watchdog.log` was always written to
  `~/.agents/.cache/logs`, even when `AGENTS_LOGS_DIR` pointed elsewhere; `agents watchdog history`
  now reads and reports the same logs directory every other log uses.
  Source: `cli/src/lib/watchdog/log.ts`.
- **Smaller fixes.** `agents cloud` with an unrunnable `codex` binary now fails with
  `could not run …` instead of an unhandled spawn error; two background auto-pull workers no
  longer both take a fresh repo lock (the lock is created with `O_EXCL`); `agents teams` pickers color a PR-open teammate the
  same magenta everywhere; `agents repo status` columns stay aligned with wide (CJK/emoji) names.
  Source: `cli/src/lib/cloud/codex.ts`, `cli/src/lib/auto-pull.ts`, `cli/src/lib/teams/delivery.ts`,
  `cli/src/commands/repo.ts`.
