- **Accounts added on your personal device reach the workers without a git pull (PHNX-4342).**
  `agents accounts add` writes the account row to `~/.agents/agents.yaml` and only
  commits it locally. A worker learned the row only after a user-repo push and pull, so
  a worker whose `~/.agents` had diverged never saw it. `agents accounts login
  <harness>#<name> --per-device` then failed there with `No grok account '<name>'`. A
  personal or desktop device now publishes its account rows (identity only, never a
  credential) in the fleet state it already exchanges with peers. A worker adds any row
  it lacks when the sender is headed and created that row; it never overwrites or
  removes a local row. Each worker still signs in for itself with `--per-device`.
  Source: `cli/src/lib/daemon/account-state-daemon-service.ts`,
  `cli/src/lib/accounting/usage-sync.ts`, `cli/src/lib/account-registry.ts`.
