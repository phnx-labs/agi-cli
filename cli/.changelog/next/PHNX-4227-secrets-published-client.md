- **Secrets calls go through the published `@phnx-labs/secrets-cli/client`, and an unset `SECRETS_HOME` is no longer forced to `~/.agents` (PHNX-4227).**
  agents-cli kept a private copy of the process client for `secrets __serve`; it
  now imports the one secrets-cli 0.3.0 publishes (exact-pinned) and keeps only its
  typed wrappers, so the two cannot drift. Request handling, timeouts, error codes
  and the `AGENTS_SECRETS_PASSPHRASE` alias are unchanged. `agents secrets …`,
  every internal secrets read, and agents launched by `agents run` now leave an
  unset `SECRETS_HOME` unset, so the standalone uses its own default root
  (`~/.agents/.secrets`, which adopts the earlier `~/.agents` and `~/.secrets`
  stores on first use); an explicit `SECRETS_HOME` still wins. A bundle push
  (`agents accounts login --fleet`, the worker `auth-sync` provisioning) likewise
  stops pinning the receiver to `~/.agents`, so the bundle lands in the same
  default root the worker's agents-cli now reads (a push into `~/.agents` would be
  invisible once the worker's new root exists, since adoption runs only once); an
  explicit `remoteSecretsHome` still wins. The standalone `agents setup tools`
  installs is raised from 0.1.8 to 0.3.0, because a 0.1.x
  engine defaulted to `~/.secrets` without adopting. Source:
  `cli/src/lib/secrets-client.ts`, `cli/src/lib/exec.ts`, `cli/src/lib/secrets-cli.ts`,
  `cli/package.json`, `cli/tests/secrets-standalone.ts`.
