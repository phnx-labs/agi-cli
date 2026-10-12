- **Secrets calls go through the published `@phnx-labs/secrets-cli/client`, and an unset `SECRETS_HOME` is no longer forced to `~/.agents` (PHNX-4227).**
  agents-cli kept a private copy of the process client for `secrets __serve`; it
  now imports the one secrets-cli 0.3.3 publishes (exact-pinned) and keeps only its
  typed wrappers, so the two cannot drift. Timeouts and the
  `AGENTS_SECRETS_PASSPHRASE` alias are unchanged. The client now checks the
  selected `secrets` before its first data request: an engine older than 0.3.1
  fails with `ENGINE_INCOMPATIBLE` instead of reporting a missing bundle. Every
  internal secrets read and the agents launched by `agents run` leave an unset
  `SECRETS_HOME` unset, so the standalone uses its own default root
  (`~/.agents/.secrets`, which adopts the earlier `~/.agents` and `~/.secrets`
  stores on first use and follows `AGENTS_REAL_HOME` when a harness such as
  Cursor swaps `HOME`); an explicit `SECRETS_HOME` still wins. A bundle push
  (`agents accounts login --fleet`, the worker `auth-sync` provisioning) likewise
  stops pinning the receiver to `~/.agents`, so the bundle lands in the default
  root the worker's agents-cli now reads; an explicit `remoteSecretsHome` still
  wins. The standalone `agents setup tools` installs is raised from 0.1.8 to
  0.3.3. `agents setup secrets` enforces that floor through the same
  `ensureToolPins` path instead of accepting any `secrets` on PATH, and an
  explicit `SECRETS_BIN` below it fails with the version it read rather than
  installing over PATH. Source: `cli/src/lib/secrets-client.ts`,
  `cli/src/lib/exec.ts`, `cli/src/lib/secrets-cli.ts`,
  `cli/src/lib/standalone-tools.ts`, `cli/src/commands/setup-secrets.ts`,
  `cli/package.json`, `cli/tests/secrets-standalone.ts`.
