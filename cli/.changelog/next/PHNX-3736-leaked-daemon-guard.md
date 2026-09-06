- **`agents doctor` flags a leaked daemon no owner record names (W4, PHNX-3736).**
  A headless e2e session launched `agents __daemon-run` under
  `HOME=/tmp/pin-e2e-<pid>` and never stopped it; the daemon ran 4+ days,
  invisible to the pid-file takeover because it keeps its own pid file under the
  temp home. `agents doctor` now reports any same-uid `__daemon-run` whose pid is
  neither the service manager's unit main PID nor the recorded `daemon.pid` —
  checked against both the caller's HOME and the real account home, so a
  test-harness caller never accuses the production daemon — as a `leaked-daemon`
  warning carrying the process's HOME and start time, with a `kill <pid>`
  remediation. Source: `cli/src/lib/daemon/leaked-daemons.ts`,
  `cli/src/lib/devices/doctor-findings.ts`.

- **`agents daemon start` refuses under a redirected HOME unless
  `AGENTS_ALLOW_TEST_DAEMON=1` (W4, PHNX-3736).** RUSH-3021 gated auto-start from
  a sandbox/test HOME but left the explicit `startDaemon()` open — the path the
  e2e harness took to leak the `/tmp/pin-e2e-<pid>` daemon. The launch now throws
  `RedirectedHomeDaemonError` (printed without a stack, exit 1); a deliberate
  test/e2e launch opts in with `AGENTS_ALLOW_TEST_DAEMON=1` and owns stopping
  what it starts. Reporting an already-running daemon — and therefore
  `agents daemon stop` of a leaked one — is not gated. Auto-start side effects
  (`routines add`, webhook fires, `monitors add`) state the refusal and leave
  the foreground command green, the same tier split as the auto-start circuit
  breaker; only the explicit start commands fail loud. Source:
  `cli/src/lib/daemon/daemon.ts` (`startDaemon`).
