<!-- guide -->
# Secrets-agent process model

The broker that holds unlocked Keychain bundles lives in **`@phnx-labs/secrets-cli`**, not in this repo.

- **Process:** `secrets _agent-run` (Node). Bring it up with `secrets start`; tear it down with `secrets stop`.
- **Where:** `$SECRETS_HOME/.cache/helpers/secrets-agent/` (`agent.sock`, `agent.pid`, `agent.token`). agents-cli leaves an unset `SECRETS_HOME` unset (`agents secrets`, its own reads, and the agents `agents run` launches), so agents-cli, a bare `secrets` inside an agent session, and a bare `secrets` in your shell all use the standalone's default root (`~/.agents/.secrets` since secrets-cli 0.2.0) and share one broker. An explicit `SECRETS_HOME` selects another root and its own broker.
- **Platform:** macOS only. Linux has no broker (`secrets status` says so).
- **Not the agents daemon.** `agents daemon` never hosts the broker (PHNX-3989). The old launchd service `com.phnx-labs.agents-secrets-agent` is retired. There is no LaunchAgent for it.

`agents secrets unlock` / `status` / `start` / `stop` are passthroughs to those same verbs on the standalone CLI.

Historical design notes about daemon-hosted brokers (pre-extraction) are out of date and must not be re-implemented here.
