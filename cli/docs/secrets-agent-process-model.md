<!-- guide -->
# Secrets-agent process model

The broker that holds unlocked Keychain bundles lives in **`@phnx-labs/secrets-cli`**, not in this repo.

- **Process:** `secrets _agent-run` (Node). Bring it up with `secrets start`; tear it down with `secrets stop`.
- **Where:** `$SECRETS_HOME/.cache/helpers/secrets-agent/` (`agent.sock`, `agent.pid`, `agent.token`). agents-cli's secrets client and the `agents secrets` passthrough set `SECRETS_HOME=~/.agents`, and `agents run` exports the same `SECRETS_HOME` to the agent it launches, so a bare `secrets` inside an agent session shares that broker. Outside agents-cli a bare `secrets` uses its own default root (`~/.secrets` on the 0.1.x line agents-cli pins, `~/.agents/.secrets` from 0.2.0), a second root with its own broker; set `SECRETS_HOME=~/.agents` in your shell to use one.
- **Platform:** macOS only. Linux has no broker (`secrets status` says so).
- **Not the agents daemon.** `agents daemon` never hosts the broker (PHNX-3989). The old launchd service `com.phnx-labs.agents-secrets-agent` is retired. There is no LaunchAgent for it.

Run `secrets unlock` / `status` / `start` / `stop` directly; the legacy `agents secrets <verb>` spelling is a passthrough to the same verbs.

Historical design notes about daemon-hosted brokers (pre-extraction) are out of date and must not be re-implemented here.
