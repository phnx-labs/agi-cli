<!-- guide -->
# Browser: agents-cli and the standalone `browser` CLI

Driving real browsers (Chrome, Brave, Edge, Chromium, Comet, Firefox, Arc over
CDP, WebDriver BiDi, or Apple Events) is the standalone
[`@phnx-labs/browser-cli`](https://github.com/phnx-labs/browser-cli) package. Its
drivers, IPC service, profile store, task history, capture ledger, verbs, and
flags all live there, and so does its user guide:
[browser-cli `docs/browser.md`](https://github.com/phnx-labs/browser-cli/blob/main/docs/browser.md),
with the consumer seam in
[`docs/integration.md`](https://github.com/phnx-labs/browser-cli/blob/main/docs/integration.md).
Agents and people call `browser <verb>` directly.

This page is the contract between the two packages: what agents-cli still does
for `browser`, and what it stopped doing.

## What agents-cli still does

| Concern | Where |
|---|---|
| `agents setup browser`: installs the standalone CLI when it is missing, runs `browser profiles seed` (one machine-local profile per installed browser) and then `browser use` to pick this machine's default. Non-interactively it only recognizes an already-configured default and never mints one on a headless box | `src/commands/setup-browser.ts` |
| `agents setup preferences` runs the same `profiles seed` and `use` steps, only in an interactive terminal, with the standalone installed and no `browser.profile` set yet | `src/commands/setup-preferences.ts` |
| Opening a page for a person to read (an HTML artifact, a dashboard): `browser show <url> --profile <viewer>` when `browser.viewer` (else `browser.profile`) names a profile and the standalone is installed, otherwise the OS default handler | `showUrl` / `resolveViewer` in `src/lib/open-url.ts` |
| Locating the binary: `$BROWSER_BIN`, else the first `browser` on `PATH` that is the standalone package. A missing binary fails with `npm i -g @phnx-labs/browser-cli`; there is no bundled fallback engine | `resolveBrowserBin` in `src/lib/browser-client.ts` |
| The fd-3 context on every spawn agents-cli makes (below) | `src/lib/browser/context.ts` |
| The `browser.*` config keys (below) | `src/lib/device-config.ts` |
| Feed tool rows: the feed reads `browser sessions --tasks --json --no-interactive` and links each task to an agent session in this machine's index | `readStandaloneBrowserRows` in `src/lib/feed/tool-activity.ts` |

agents-cli runs `browser` itself only for those setup steps, the viewer open,
and the feed read. Every other invocation is the standalone called directly,
which gets no context from agents-cli.

### The fd-3 context

When agents-cli spawns `browser`, it sets `BROWSER_CONTEXT_FD=3`, writes one
JSON object to fd 3, and closes it. stdio and the environment are inherited
unchanged. The object:

| Field | Meaning |
|---|---|
| `version` | `1`. The engine matches on it; a later field must be optional so an older engine keeps working |
| `session` | `actor`, `sessionId`, `launchId`: who is acting. `sessionId` comes from the harness's own session variable (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, …) |
| `remoteControl` | `{ allowed: boolean }`: whether this machine consents to being driven by a fleet peer, from `browser.remote-control` |

`buildBrowserContext` can also carry a `target` (a resolved device), but none of
the spawns above pass a device, so in practice it is absent.

### Config keys

These are registered `agents config` keys, so `agents config get/set` validates
them. They are stored in the device file (`~/.agents/devices/<machine>/agents.yaml`)
or, for `browser.device`, the central `agents.yaml`, and the standalone reads the
same stored keys.

| Key | Scope | Meaning |
|---|---|---|
| `browser.profile` | device | The profile `browser start` uses without `--profile` (set by `browser use`) |
| `browser.viewer` | device | Where this machine shows a person a page: a profile name, or `os`. Unset follows `browser.profile` |
| `browser.device` | user | The fleet browser hub: the device whose browser drive verbs target by default |
| `browser.remote-control` | device | Whether other fleet machines may drive this machine's browser. Default `false`; machine-local, never shared with peers. `browser remote-control on` turns it on |
| `browser.task-idle-minutes` | device | Minutes a task may sit with no action before the abandoned-task reaper closes it (default 30, `0` disables idle reaping) |

## What agents-cli no longer does (PHNX-4227)

- **`agents browser` is gone**, with no alias or forwarder. Running it exits 1
  with `error: 'agents browser' was removed; use the standalone 'browser' CLI (browser --help).`
- **No fleet `--device` resolution for drive verbs.** The standalone binds a
  device at `browser start --device <alias>` and resolves the alias itself
  (fleet devices become ssh aliases once `agents devices render --write` has
  written `~/.ssh/config.d/agents` and `~/.ssh/config` includes it).
- **No events pipe.** The engine records every action in its own task history
  (`~/.agents/.history/browser/history.db`); agents-cli writes no browser
  history of its own.
- **No `sessions --browser`.** Use `browser sessions`.

## See also

- [computer.md](computer.md): the same contract for the standalone `computer` CLI
- [concepts.md](concepts.md): DotAgents repos and resource resolution
