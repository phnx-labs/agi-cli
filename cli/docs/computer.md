<!-- guide -->
# Computer: agents-cli and the standalone `computer` CLI

Native desktop control (macOS Accessibility, the Windows UI Automation daemon,
RFB/VNC) is the standalone [`@phnx-labs/computer-cli`](https://github.com/phnx-labs/computer-cli)
package. Its helper daemons, JSON-RPC transport, autonomous `run` loop, verbs,
flags, and run history all live there, and so does its user guide:
[computer-cli `docs/computer.md`](https://github.com/phnx-labs/computer-cli/blob/main/docs/computer.md).
Agents and people call `computer <verb>` directly.

This page is the contract between the two packages: what agents-cli still does
for `computer`, and what it stopped doing.

## What agents-cli still does

| Concern | Where |
|---|---|
| `agents setup computer` (macOS): installs the standalone CLI when it is missing, runs `computer setup` and `computer start`, opens the Accessibility and Screen Recording panes, and polls `computer status --json` for `trusted: true` for up to 2 minutes. `--install-only` installs the CLI and stops there | `src/commands/setup-computer.ts` |
| The `agents setup` checklist row for computer (`ready` when `computer status --json` reports trusted) | `src/commands/setup.ts` |
| Locating the binary: `$COMPUTER_BIN`, else the first `computer` on `PATH` that is the standalone package. A missing binary fails with `npm i -g @phnx-labs/computer-cli`; there is no bundled fallback engine | `resolveComputerBin` in `src/lib/computer-client.ts` |
| The fd-3 context on every spawn agents-cli makes (below) | `src/lib/computer/context.ts` |
| The app allow list, derived from `Computer(<bundle-id>)` rules | `loadComputerAllowList` in `src/lib/computer/policy.ts` |
| Feed tool rows: the feed reads `computer sessions --json --no-interactive --limit 500` and links each run to an agent session in this machine's index | `readStandaloneComputerRows` in `src/lib/feed/tool-activity.ts` |

agents-cli runs `computer` itself only from `agents setup computer` (`setup`,
`start`, `status`) and the feed read. Every other invocation is the standalone
called directly, which gets no context from agents-cli.

### The fd-3 context

When agents-cli spawns `computer`, it sets `COMPUTER_CONTEXT_FD=3`, writes one
JSON object to fd 3, and closes it. stdio and the environment are inherited
unchanged. The object:

| Field | Meaning |
|---|---|
| `version` | `1`. The engine matches on it; a later field must be optional so an older engine keeps working |
| `permissions` | `{ allow: string[] }`: the bundle ids that `Computer(<bundle-id>)` rules grant. Omitted when `COMPUTER_HELPER_TCP` or `COMPUTER_HELPER_VNC` is set, since the allow list applies only to the local helper |
| `peers` | `{ allow: string[] }`: the real paths of the executables the helper accepts a socket connection from (the `computer` binary, the runtime running agents-cli, and `/Applications/Rush.app` when installed) |
| `session` | `actor`, `sessionId`, `launchId`: who is acting. `sessionId` comes from the harness's own session variable (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, …) |

The transport, the remote helper's auth token, and the policy-file paths are not
in the context. The engine provisions the remote helper, mints its token, opens
its own tunnel, and writes its own policy file, so a copy from agents-cli would
be a second answer free to drift (and a loopback endpoint without the token
fails `auth_failed`).

### Permissions resource to allow list

The helper is deny-all by default. To let it drive an app, add a rule to a group
under `~/.agents/permissions/groups/`:

```yaml
# ~/.agents/permissions/groups/computer.yaml
name: computer
allow:
  - "Computer(com.apple.notes)"
```

`loadComputerAllowList` scans the user and system permissions layers, takes
each group file once (the first layer that has the name wins), and collects
every `"Computer(<bundle-id>)"` entry under `allow:`. The rule grammar is an
agents-cli concept, which is why the engine gets the resolved list rather than
the rules. Run `computer reload` after editing a group so the helper picks it up.

## What agents-cli no longer does (PHNX-4227)

- **`agents computer` is gone**, with no alias or forwarder. Running it exits 1
  with `error: 'agents computer' was removed; use the standalone 'computer' CLI (computer --help).`
- **No fleet `--device` resolution.** agents-cli no longer turns a device name
  into an ssh target or `--host <address>` for the engine, and the context has no
  `target` field. The engine takes `--host <address>` and also accepts
  `--device <alias>`, which it resolves as an ssh host (fleet devices become ssh
  aliases once `agents devices render --write` has written `~/.ssh/config.d/agents`
  and `~/.ssh/config` includes it).
- **No `devices.<name>.computer.host` config key.**
- **No fd-4 action recorder.** agents-cli no longer opens an events pipe or
  appends `computer.action` events to the feed. Run history is the engine's
  (`computer sessions`). Existing `computer.action` events in the feed log are
  still read when the session index computes whether a session used the desktop
  (`used_computer` in `src/lib/session/db.ts`); nothing new is written there.
- **No `sessions --computer`.** Use `computer sessions`.

## See also

- [browser.md](browser.md): the same contract for the standalone `browser` CLI
- [concepts.md](concepts.md): DotAgents repos and the permissions resource layer
