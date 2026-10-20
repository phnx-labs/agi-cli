- **The stall watchdog is gone (PHNX-4439).** `agents watchdog`, `agents setup watchdog`, the
  daemon's `watchdog` service, the `watchdog.enabled` device key and the menubar snapshot's
  `watchdog` block are deleted. It was off by default, typed a generic "Continue." into a stalled
  split, and never confirmed that a VSCodium tab received it. Its replacement is the Stop-hook done
  check, which decides whose move it is, and the project Lead's drafted reply, which you send from the
  card. A leftover `watchdog: false` in `~/.agents/daemon/services.yaml` or `watchdogEnabled` in a
  device's `agents.yaml` is left in place and ignored, and `agents watchdog` is an unknown command
  that never autocorrects to a live one.
  Source: `cli/src/lib/daemon/daemon.ts`, `cli/src/lib/device-config.ts`.
