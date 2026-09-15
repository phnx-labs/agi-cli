<!-- guide -->
# Browser

Drive real browsers from AI agents — the same Chrome, Brave, Edge, Chromium,
Comet, Firefox, or Arc you use by hand, with their profiles and cookies.

## Overview

`agents browser` gives agents a real browser over the Chrome DevTools Protocol
(Chromium family), WebDriver BiDi (Firefox), or Apple Events (Arc) — with your
existing cookies, fingerprint, and IP. There is no Playwright subprocess, no
automation flags, no relay extension. Sites that block Puppeteer and Playwright
let it through because there is nothing to detect. It can also drive a browser on
another machine over SSH with `--device`.

For native desktop apps with no web interface, use
[`agents computer`](computer.md).

**The engine is a separate CLI.** Since PHNX-4101 the CDP/BiDi/Arc drivers, the
browser IPC service, the chrome-data/profile store, and the network-capture
pipeline all live in the standalone `browser` CLI. `agents browser` is a thin
consumer of it:

```bash
npm i -g @phnx-labs/browser-cli    # the engine — required
agents setup browser               # installs it, seeds profiles, picks a default
```

Without it, every verb fails loud with that install line. There is deliberately
**no fallback engine** bundled in agents-cli — a fallback would re-couple two
release trains the split exists to separate.

## Architecture

agents-cli contributes what only the fleet CLI can know; the engine does the
driving. The two meet over two inherited file descriptors on one spawn.

```
agent process
     │
     │  agents browser <verb> [--device <name>]
     ▼
  agents-cli  (commands/browser.ts)
     │         · --device     → fleet resolution (an SSH target, on fd 3)   (lib/browser/context.ts)
     │         · remote-control consent (this machine's browser.remote-control)
     │         · actor/session identity                                     (lib/browser/context.ts)
     │
     │  spawn, env + stdio 0/1/2 INHERITED
     │    fd 3  BROWSER_CONTEXT_FD  →  one JSON context object, then EOF
     │    fd 4  BROWSER_EVENTS_FD   ←  NDJSON action events, one per line
     ▼
  browser  (@phnx-labs/browser-cli)
     │
     │  its own IPC service  ~/.agents/.cache/helpers/browser/browser.sock
     │  CDP / BiDi / Arc     (local, or over an SSH tunnel it opens for --device)
     ▼
  browser process  (Chrome / Brave / Edge / Chromium / Comet / Firefox / Arc)
     └── Profile A  chrome-data/A/  →  Task swift-crab-a1b2
     └── Profile B  chrome-data/B/  →  Task bold-phoenix-c3d4
```

The action events on fd 4 come back to agents-cli, which records them in the
durable `browser_sessions` row that `agents browser sessions` and
`agents sessions --browser` read.

### What lives where

| Concern | Owner | Why |
|---|---|---|
| CDP / BiDi / Arc drivers, the IPC service, the task index | the engine | It is the automation; it releases on its own cadence |
| Profile declarations, chrome-data, capture ledger | the engine | It keeps every on-disk path the old subsystem used |
| Browser detection + profile creation (`profiles seed`/`create`) | the engine | It resolves installed browsers itself |
| The abandoned-task reaper (`browser prune`) | the engine | It runs its own 5-minute reap |
| `--device` name → an SSH target (bound once at `start`) | agents-cli | It owns the devices registry, tailnet addressing, and ssh identity |
| Remote-control consent policy | agents-cli (the flag) / the engine (enforcement) | agents-cli reads `browser.remote-control`; the engine enforces it |
| Cross-machine session history, the feed | agents-cli | It owns `sessions.db` and the feed |
| Per-verb flags and their `--help` | the engine | One surface, not a drifting copy |

### The context (fd 3)

One JSON object, written and closed immediately, so the engine reads to EOF and
proceeds. `version: 1` is what the engine matches on; fields added later are
optional so an older engine keeps working.

| Field | Meaning |
|---|---|
| `target` | The resolved `--device` target: `alias`, `host` (`user@host`), `user`, `hostname`, `platform`, `sshArgs`. Absent for a local invocation (and for `--device local`) |
| `session` | `actor`, `sessionId`, `launchId` — who is acting |
| `remoteControl` | `{ allowed: boolean }` — whether THIS machine consents to being driven by a peer, from `browser.remote-control` (default off) |

**That is the whole object.** Everything else the engine needs it already has:
the CDP/BiDi endpoint, the IPC socket, the chrome-data store, and the profile
declarations all live on disk at the paths below, which the engine reads
directly. `--device <alias>` is forwarded on the engine's argv verbatim; the
engine matches the alias against `context.target`, then `~/.ssh/config` — it has
no fleet registry of its own. The device is bound once at `start`; page verbs run
against the task's bound device, so `--device` is only valid there.

### The action events (fd 4)

One JSON object per line, each an action the engine actually performed. A line
carries `event: "browser.action"` and needs at least a string `command` — the
verb that ran. `invocationId`, `pid`, `task`, `profile`, `url`, `host` (the
driven device), `sessionId`, `launchId`, `actor`, and free-form detail are
optional. agents-cli upserts the durable `browser_sessions` row from an event
that names a `task` AND a `profile` — a lifecycle verb (`status`, `profiles`)
carries neither and is skipped. An unreadable line is dropped rather than failing
the command; the engine must never block on this pipe, and emitting nothing is
valid.

## Profiles and endpoints

A **profile** names a browser, where it runs, and how to reach it. Profiles are
machine-local and stored under `~/.agents/devices/<machine>/agents.yaml`, which
both `agents browser` and the standalone `browser` read and write — a
`browser use <name>` typed at either surface agrees. `agents browser profiles`
forwards to the engine:

```bash
agents browser profiles create work --browser chromium   # local Chromium
agents browser profiles seed                              # one profile per installed browser
agents browser profiles list
agents browser use work                                   # this machine's default
```

Each profile resolves to an endpoint the engine drives:

- `cdp://127.0.0.1:9222` — a Chromium-family browser over the DevTools Protocol.
- `firefox-bidi://127.0.0.1:9674` — Firefox over WebDriver BiDi.
- `ssh://user@box?port=9222` — a browser on a remote host reached over SSH.

## Sessions and captures

`agents browser sessions` (and `agents sessions --browser`) is agents-cli's own
reader — it never reaches the engine. It groups a profile's on-disk captures
(screenshots, PDFs, recordings, downloads under
`~/.agents/.cache/browser/<profile>/sessions/<task>/`) by task, newest first, and
links each task to the agent session that drove it when the identity resolves:

- **linked** — the run carried a real session id / launch id that indexes here,
  so the row shows the owning session's digest.
- **unresolved** — an identity nothing on this machine can index.
- **unlinked** — a bare invocation with no agent-session identity, or a legacy
  task whose run already stopped. Its captures are still listed.

Flags: `--profile <name>`, `--open [selector]` (`latest` or a filename
substring), `--json`, `--no-interactive`. On a TTY it opens an interactive
task-first browser; `enter` opens a capture.

## Remote-control consent

Another fleet machine may drive THIS machine's browser only after its owner opts
in:

```bash
agents browser remote-control on     # device-local, never synced; default off
```

agents-cli reads that flag into the fd-3 context (`remoteControl.allowed`); the
engine enforces it. `agents browser remote-control` forwards to the engine, which
reads and writes the same `browser.remote-control` config key.

## Remote browsers (`--device`)

Bind a task to a browser on another machine at `start`:

```bash
agents browser start --device box --profile work
agents browser navigate https://example.com     # runs against the bound device
agents browser screenshot -o shot.png
agents browser done
```

agents-cli resolves `--device <name>` against the fleet — registry, ssh identity,
platform — and hands the target on fd 3; the engine opens the SSH tunnel and
drives the remote browser over it. `--device local` forces this machine. Because
the device is bound at `start`, page verbs reject `--device` — they run against
the task's bound device.

## Setup

### 0. Install the engine

```bash
npm i -g @phnx-labs/browser-cli
```

Required once per machine. Every `agents browser` verb runs through it.

### 1. Seed a profile and pick a default

```bash
agents setup browser
```

Interactively, the wizard installs the engine if missing, runs
`browser profiles seed` (a machine-local profile per installed browser), and
opens `browser use` to set this machine's default. Non-interactively it only
recognizes an already-configured default — it never mints one on a headless box
(a headless box gets its browser from the fleet hub, `browser.device`).

### 2. Finish the first-run + sign in

```bash
agents browser start --profile <name>   # complete the browser first-run, sign in to sites
agents browser profiles doctor <name>   # confirm it is ready
```

## Command reference

Verbs are grouped the way `agents browser --help` groups them. Every verb except
`sessions` forwards to the engine; **per-verb flags are the engine's** — ask it
directly with `agents browser <verb> --help`.

### Session lifecycle

| Command | Description |
|---------|-------------|
| `use` | Pick the profile `start` uses when no `--profile` is passed |
| `start` | Start a browser task — `--profile`/`--url`/`--record`/`--title`, and `--device <name>` to bind a remote box |
| `done` | Complete a task and close its tabs |
| `status` | Show browser service state and running tasks |
| `prune` | Close tabs for abandoned tasks (the reaper the engine runs, on demand) |

### Drive the page

| Command | Description |
|---------|-------------|
| `navigate` | Navigate the current tab to a URL |
| `tabs` / `tab` | List tabs; `tab add`/`tab focus`/`tab close` |
| `screenshot` | Capture a screenshot (auto-saved per task) |
| `evaluate` | Evaluate JavaScript in the current tab |
| `click` / `type` / `press` / `hover` / `scroll` | Interact with the page |
| `wait` | Wait for a condition |
| `upload` | Upload file(s) — hidden inputs, drag-drop, OS chooser interception |
| `set` / `devices` | `set viewport`/`set device`; list emulation presets |
| `show` | Open a URL for a human to read (goes to `browser.viewer`; binds no task) |

### Capture evidence

| Command | Description |
|---------|-------------|
| `console` / `errors` | Read console logs / page errors |
| `requests` | Read captured network requests; `--format har` emits HAR 1.2 |
| `responsebody` | Wait for and read a response body by URL pattern |
| `record` | `record start` / `record stop` a video of the page |
| `pdf` | Export the current tab as PDF via CDP |
| `logs` | Read merged app + CLI logs for a task |
| `download` / `waitdownload` | Set the download directory; wait for a download |

### History and discovery

| Command | Description |
|---------|-------------|
| `sessions` | Browse captures grouped by task (agents-cli's own reader — see above) |
| `history` | Recent browser task history |
| `refs` | DOM refs for interactive elements |

### Other

| Command | Description |
|---------|-------------|
| `profiles` | Manage profiles (`create`/`list`/`edit`/`rename`/`show`/`remove`/`use`/`seed`/`claim`/`prune`/`doctor`) |
| `remote-control` | Allow or deny other fleet machines driving this machine's browser |
| `stop` | Stop a task; `--profile` detaches a profile; `--service` stops the IPC service |
| `ps` / `tasks` | List tracked browser processes / all browser tasks |
| `stream` | Keep one process + IPC socket open; NDJSON requests on stdin, responses on stdout |

## On-disk layout

browser-cli keeps every path the in-repo subsystem used:

| Path | Meaning |
|---|---|
| `~/.agents/.cache/helpers/browser/browser.sock` | IPC socket |
| `~/.agents/.cache/browser/<profile>@<device>/` | runtime chrome-data / pids |
| `~/.agents/.history/browser-profiles/` | durable user-data dirs (logins survive) |
| `~/.agents/devices/<machine>/agents.yaml` `browser:` | machine-local profiles |
| `~/.agents/.cache/browser/actions/YYYY-MM-DD.jsonl` | local action ledger |

## Recipes

### Install engine + a profile, then drive a page

```bash
npm i -g @phnx-labs/browser-cli
agents browser profiles create work --browser chromium
agents browser use work

agents browser start --profile work
agents browser navigate https://example.com
agents browser screenshot -o /tmp/shot.png
agents browser done
```

### Drive a remote box over the fleet

```bash
agents browser start --device box --profile work
agents browser navigate https://example.com
agents browser screenshot -o /tmp/remote.png
agents browser done
```

## See also

- [docs/computer.md](computer.md) — drive native desktop apps; part of the automation triad
- [docs/concepts.md](concepts.md) — DotAgents repos, resource resolution model
- `@phnx-labs/browser-cli` — the engine; `browser --help` and `browser <verb> --help` for the full surface
