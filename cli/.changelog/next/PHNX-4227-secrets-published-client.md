- **Secrets calls go through the published `@phnx-labs/secrets-cli/client`, and an unset `SECRETS_HOME` is no longer forced to `~/.agents` (PHNX-4227). Requires the `secrets` engine 0.4.0 or newer.**
  agents-cli kept a private copy of the process client for `secrets __serve`; it
  now imports the one secrets-cli 0.4.0 publishes (exact-pinned) and keeps only its
  typed wrappers, so the two cannot drift. Timeouts, the
  `AGENTS_SECRETS_PASSPHRASE` alias, one `secrets __serve` process per request,
  and engine stderr going to `secrets-serve.log` under the agents logs directory
  (never the terminal) are unchanged. Every response now carries the engine's
  contract, so an engine older than 0.4.0 fails every secrets read with
  `ENGINE_INCOMPATIBLE` instead of reporting a missing bundle from another root.
  Upgrade each machine, fleet workers included, with
  `agents setup tools --tool secrets` (or `npm i -g @phnx-labs/secrets-cli@0.4.0`);
  `agents doctor` reports an old engine as the critical
  `secrets-engine-incompatible` finding, locally and for fleet devices. Every
  internal secrets read and the agents launched by `agents run` leave an unset
  `SECRETS_HOME` unset, so the standalone uses its own default root
  (`~/.agents/.secrets`, which adopts the earlier `~/.agents` and `~/.secrets`
  stores on first use and follows `AGENTS_REAL_HOME` when a harness such as
  Cursor swaps `HOME`); an explicit `SECRETS_HOME` still wins. A bundle push
  (`agents accounts login --fleet`, the worker `auth-sync` provisioning) likewise
  stops pinning the receiver to `~/.agents`, so the bundle lands in the default
  root the worker's agents-cli now reads; an explicit `remoteSecretsHome` still
  wins. The standalone `agents setup tools` installs is raised from 0.1.8 to
  0.4.0. `agents setup secrets` enforces that floor through the same
  `ensureToolPins` path instead of accepting any `secrets` on PATH, and an
  explicit `SECRETS_BIN` below it fails with the version it read rather than
  installing over PATH. Source: `cli/src/lib/secrets-client.ts`,
  `cli/src/lib/exec.ts`, `cli/src/lib/secrets-cli.ts`,
  `cli/src/lib/standalone-tools.ts`, `cli/src/commands/setup-secrets.ts`,
  `cli/src/commands/doctor.ts`, `cli/src/lib/devices/doctor-findings.ts`,
  `cli/package.json`, `cli/tests/secrets-standalone.ts`.
