- **One run-readiness gate, computed on the box that runs (PHNX-4116).** `agents view --json`
  now carries a per-agent `runReady` (`{ ready, reason, accounts: [{ name, ready, reason }] }`)
  computed from the router's own enumeration — native account slots AND version homes
  (`collectRunCandidates` → `readinessFromCandidate`), not the per-version list, which missed the
  slots a run actually picks from. `--device auto` reads that answer instead of re-deriving usage
  freshness on the dispatching box, so a worker holding a valid setup-token is schedulable on that
  fact: a synced-only usage row (its poller lives on the headed box that published it) is never
  refused for being old — its age weights the pick, it never decides eligibility — and a
  rate-limit window whose reset has already passed reads as available. A placement error now names
  the box's own reason, e.g. `no ready harness account (all signed_out)`, instead of a bare
  `no ready harness account`. `agents devices harnesses` now derives its displayed usage
  percentage from the SAME live windows as the status verdict (`liveUsageWindows`), so a
  maxed-then-reset account no longer reads `available` next to a stale ~100%. The one-release
  fallback for an older remote CLI without `runReady` keeps the pre-fix throttle exclusion — a
  FRESH `rate_limited`/`out_of_credits` or a FRESH dead auth verdict still disqualifies a
  launchable version, while a STALE reading stays unverified — so a throttled worker cannot slip
  into `--device auto` during a rolling upgrade. Source: `cli/src/commands/view.ts`,
  `cli/src/lib/hosts/ready.ts`, `cli/src/lib/accounting/rotate.ts`,
  `cli/src/lib/accounting/usage.ts`, `cli/src/lib/devices/harness-inventory.ts`,
  `cli/src/lib/smart-launch.ts`.
