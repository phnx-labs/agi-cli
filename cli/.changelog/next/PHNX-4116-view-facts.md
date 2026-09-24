- **`agents view` / `agents accounts list` show FACTS per account per box, never a
  word that means "we did not look" (PHNX-4116).** Each account row now states its
  evidence: the **token** on disk (`sk-ant-oat01 (Sep 16)` = the slot's
  `.claude/.oauth_token` scheme prefix + file date, `api key (present)`, or
  `no token`), what happened when it was last **used** (`last used ok 12m ago` /
  `last auth failure 401 Sep 20 14:02` / `rate-limited until 15:00` / `not used on
  this box yet`), and a **usage** reading that names its origin when it came from
  another box (`S 12% W 40% … (from zion)`). The auth fact is recorded from real run
  outcomes into the auth-health cache with a new `source: 'run'` field — an auth
  failure at the routine runner's `isAuthFailureFromLog` sites, a success at
  statusline ingest and a clean headless `agents run` exit. `agents view <harness>
  --json` accounts now carry `token` and `lastAuth` for the emitting box. Source:
  `cli/src/lib/auth-health.ts`, `cli/src/lib/account-catalog.ts`,
  `cli/src/commands/accounts.ts`, `cli/src/commands/view.ts`.

- **A synced usage file no longer masquerades as a live auth verdict, and a worker
  no longer publishes a `unverified` probe row (PHNX-4116).** `verdictFromFreshUsage`
  refuses a `freshness.source === 'sync'` snapshot — a fresh reading from another
  box's poller proves the shared token works somewhere, not that THIS box can
  authenticate. A worker's setup-token box, which cannot read the usage endpoint,
  now returns the honest `no_evidence` verdict (dropped from the published probe
  rows) instead of the overloaded `unverified`, so eight identical workers read one
  distinct picture instead of five. Source: `cli/src/lib/auth-health.ts`.

- **A `--host <worker>` routine activates on a token-backed worker again
  (PHNX-4116).** Dropping the worker's `no_evidence` probe row left `agents devices
  ping --local --json` with no row for the agent, so host-placed routine readiness
  read the absent row as `unconfigured` and reported `agent_auth_failed` with a
  valid token on disk. `devices ping --local --json` now also emits `launchable`
  (the agents this box holds a launchable signed-in credential for, from the same
  `collectRunCandidates` the run router uses), and one shared decision
  (`decideRoutineAuthReadiness`) is used by both the local and host readiness paths:
  an absent row plus a launchable credential is ready, a box with no credential
  fails, and a fresh `revoked` blocks — so both paths reach the same answer for the
  same box. Source: `cli/src/lib/routine-readiness.ts`, `cli/src/commands/ssh.ts`.
