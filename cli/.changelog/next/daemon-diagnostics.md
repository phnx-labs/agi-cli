- **The daemon log says why it restarted (PHNX-4225).** `agents daemon logs` now
  carries levels (`debug`, `info`, `warn`, `error`) and structured `data` on each
  line. Every supervised tick is timed: a tick over half its deadline logs
  `tick.slow`, and a deadline breach logs `tick.breach` with every in-flight tick,
  the synchronous sections that ran during it, and the daemon's CPU, memory,
  event-loop delay and load. A once-a-minute `vitals` line and `loop.stall` /
  `span.slow` warnings attribute event-loop blocking to named sections, including
  the feed hub and active-session discovery, which run outside the supervisor.
  `agents daemon logs level debug` traces every tick and section and applies live;
  `agents daemon logs level info` turns it back off. The usage-refresh and
  active-sessions summaries are now structured log lines instead of raw stdout.
  Source: `cli/src/lib/daemon/diagnostics.ts`, `cli/src/lib/daemon/supervisor.ts`.
