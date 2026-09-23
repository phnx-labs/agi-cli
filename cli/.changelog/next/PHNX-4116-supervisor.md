- **A wedged daemon service now restarts the whole daemon instead of parking a dead service or reading `wedged` forever (PHNX-4116).**
  A supervised daemon service that HANGS past its deadline (a stuck usage refresh, a frozen heartbeat)
  no longer parks and waits for an in-process backoff restart that could stall for days — the
  supervisor records the cause and exits the process (code 70), and systemd (`Restart=always`,
  `RestartSec=30`, `StartLimitIntervalSec=0`, `KillMode=process`) / launchd (`KeepAlive` +
  `ThrottleInterval=30`) restart the daemon within ~30s, so it recovers on its own like any
  well-behaved service. A service whose tick merely THROWS is recorded and keeps ticking. The
  `parked` service state and the `wedged` daemon state are gone: `agents daemon status` now reports
  `running`/`stopped`, the daemon's PID, uptime, heartbeat age, and the count of supervised restarts
  in the last 24h with the last cause. Source: `cli/src/lib/daemon/supervisor.ts`,
  `cli/src/lib/daemon/daemon.ts`.
