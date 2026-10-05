- **Slow monitors no longer restart the daemon every two minutes.** The monitors
  service polled every due monitor one after another, so a set of slow polls
  (`agents devices ps` takes about 30 s) kept its tick past the 2-minute deadline
  and the daemon exited for a restart, which also dropped every `agents feed watch`
  stream. A tick now runs up to four polls at once and starts new ones only in its
  first minute; monitors it did not reach run first on the next tick. A timed-out
  command poll now kills the whole pipeline, not just the shell. Source:
  `cli/src/lib/monitors/engine.ts`, `cli/src/lib/monitors/sources/command.ts`,
  `cli/src/lib/daemon/monitor-engine-service.ts`.
