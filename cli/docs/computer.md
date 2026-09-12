<!-- guide -->
# Computer

Drive native macOS apps from AI agents via the Accessibility API.

## Overview

`agents computer` controls native applications through the Accessibility
(`AXUIElement`) framework, ScreenCaptureKit, and HID-tap event synthesis on
macOS; a UI Automation daemon on Windows over `--device`; or any GUI desktop
over RFB/VNC with `--vnc`.

Use this when you need to drive an app that has no web interface and no CDP
endpoint — a desktop finance tool, a native editor, a VM window, or an app that
Electron automation cannot reach cleanly. For the web, use
[`agents browser`](browser.md).

**The engine is a separate CLI.** Since PHNX-4075 the helper daemons, the
JSON-RPC transport, the RFB/VNC client, and the autonomous `run` loop all live
in the standalone `computer` CLI. `agents computer` is a thin consumer of it:

```bash
npm i -g @phnx-labs/computer-cli    # the engine — required
agents setup computer               # installs the helper + walks the TCC grants
```

Without it, every verb fails loud with that install line. There is deliberately
**no fallback engine** bundled in agents-cli — a fallback would re-couple two
release trains the split exists to separate.

## Architecture

agents-cli contributes what only the fleet CLI can know; the engine does the
driving. The two meet over three inherited file descriptors on one spawn.

```
agent process
     │
     │  agents computer <verb> [--device <name>] [--vnc <host:port>]
     ▼
  agents-cli  (commands/computer.ts)
     │         · permissions  → the allow-list + peer files       (lib/computer/policy.ts)
     │         · --device     → fleet resolution + ssh -L tunnel  (lib/computer/remote.ts)
     │         · actor/session identity                           (lib/computer/context.ts)
     │
     │  spawn, stdio 0/1/2 INHERITED (the engine owns the terminal)
     │    fd 3  COMPUTER_CONTEXT_FD  →  one JSON context object, then EOF
     │    fd 4  COMPUTER_EVENTS_FD   ←  NDJSON action events, one per line
     ▼
  computer  (@phnx-labs/computer-cli)
     │
     │  JSON-RPC over UNIX socket ~/.agents/.cache/helpers/computer.sock  (macOS)
     │  JSON-RPC over loopback TCP through the tunnel                     (--device)
     │  RFB                                                               (--vnc)
     ▼
  helper daemon  →  the app
```

The action events on fd 4 come back to agents-cli, which records them in the
feed and the session ledger — that is what `agents computer sessions` and
`agents sessions --computer` read.

### What lives where

| Concern | Owner | Why |
|---|---|---|
| Helper daemons, RPC, RFB/VNC, `run` loop | the engine | It is the automation; it releases on its own cadence |
| Helper download + signature/notarization checks | the engine | It resolves its own helper releases; agents-cli version-pins nothing |
| App allow list (`Computer(<bundle-id>)` rules) | agents-cli | Derived from the agents permissions resource layer |
| `--device` resolution and the ssh tunnel | agents-cli | It owns the devices registry, ssh identity, and the fleet |
| Action history, feed events, actor identity | agents-cli | It owns `sessions.db` and the feed |
| Per-verb flags and their `--help` | the engine | One surface, not a drifting copy |

### The context (fd 3)

One JSON object, written and closed immediately, so the engine reads to EOF and
proceeds. `version: 1` is what the engine matches on; fields added later are
optional so an older engine keeps working.

| Field | Meaning |
|---|---|
| `transport` | `socket` / `tcp` / `vnc`, already decided — including the loopback port a `--device` tunnel landed on |
| `device` | The resolved ssh target (`sshTarget`, `user`, `host`, `sshArgs`) so the engine can provision a remote helper without the devices registry |
| `policy` | `policyPath`, `peersPath`, the allowed bundle ids and peer exec paths, the gated verb classes, the admission cache path, and the exact grant hint |
| `identity` | `actor`, `sessionId`, `launchId`, and the `invocationId` that groups one run's actions |
| `logPath` | Where the daemon log belongs, so `status` and the engine agree |

### The action events (fd 4)

One JSON object per line, each an action the engine actually performed. A line
needs at least a `verb`; `targetPid`, `bundle`, `device`, and free-form detail
(a `task` preview, coordinates) are optional. An unreadable line is dropped
rather than failing the command — the action it describes already happened and
already reported its own success or failure. agents-cli bounds the `task`
preview itself, so an engine cannot write an unbounded string into the ledger.

The engine must never block on this pipe; emitting nothing is valid.

## Permissions

The helper reads an allow-list policy file
(`~/.agents/.cache/helpers/computer-policy.json`) at startup and on SIGHUP.
By default the policy is deny-all. You must explicitly whitelist each app the
daemon may drive.

agents-cli renders that file from `Computer(<bundle-id>)` rules in
`~/.agents/permissions/groups/` before any lifecycle verb, so an edit is in
force after `agents computer reload`. The rule grammar is an agents-cli
concept, which is why the engine is handed the rendered answer rather than the
rules.

A peer-auth list (`~/.agents/.cache/helpers/computer-peers.json`) controls
which caller executables may connect to the socket — the standalone engine, the
runtime running agents-cli, and Rush.app when installed. This prevents a
malicious npm postinstall from connecting to the socket through a different
process.

## Setup

### 0. Install the engine

```bash
npm i -g @phnx-labs/computer-cli
```

Required once per machine. Every `agents computer` verb runs through it.

### 1. Install the helper

```bash
agents computer setup        # alias: install-helper
```

The engine installs the helper at `/Applications/Computer Helper.app`,
verifies its codesign signature, writes a LaunchAgent plist at
`~/Library/LaunchAgents/com.phnx-labs.computer-helper.plist`, and prints
the next steps. It does **not** start the daemon.

### 2. Grant TCC permissions (one-time)

Open System Settings on macOS:

```
System Settings > Privacy & Security > Accessibility   — add Agents Computer
System Settings > Privacy & Security > Screen Recording — add Agents Computer
```

These grants are keyed to the app's signed bundle identity at
`/Applications/Computer Helper.app`. They survive `npm update` as long as the
app stays at that path and the same certificate signs it.

### 3. Whitelist the apps the daemon may drive

Add a YAML file under `~/.agents/permissions/groups/`:

```yaml
# ~/.agents/permissions/groups/computer.yaml
name: computer
allow:
  - "Computer(com.apple.mail)"
  - "Computer(com.apple.notes)"
  - "Computer(com.apple.finder)"
```

The bundle ID is the value from `CFBundleIdentifier` in the app's `Info.plist`.
Find it with:

```bash
defaults read /Applications/SomeApp.app/Contents/Info CFBundleIdentifier
```

### 4. Start the daemon when you need it

```bash
agents computer start
```

The daemon is not always-on. Start it when you need it, stop it when done.
This is intentional: Accessibility and Screen Recording are sensitive grants;
an always-on background listener that can drive any app is a large attack
surface.

```bash
agents computer stop   # when finished
```

## Command Reference

Verbs are grouped the way `agents computer --help` groups them.

### Installation & daemon lifecycle

| Command | Description |
|---------|-------------|
| `setup` (alias `install-helper`) | Copy helper to /Applications/, write LaunchAgent plist |
| `start` | Write policy + peers, load the LaunchAgent, start the daemon |
| `stop` | Unload the LaunchAgent, remove the socket |
| `reload` | Reload the allow-list policy from ~/.agents/permissions/groups/ (SIGHUP the daemon); with `--device`, restart the remote Windows daemon |
| `status` | Report install state, daemon state, TCC trust, policy, and peer list; with `--device`, tunnel + liveness of the remote Windows daemon |

### Observe

| Command | Description |
|---------|-------------|
| `apps` | List running allow-listed apps (pid, bundle id, active flag) |
| `describe` | Dump the accessibility tree; element ids (`@eN`) feed `--id` flags |
| `screenshot` | Capture a window (default: largest), `--list` windows, or `--display` |
| `get-text` | Extract visible text from the app (or a subtree via `--id`) without OCR |

`screenshot` flags: `--bundle` / `--pid` (target), `--list` (enumerate windows
with id/title/layer/`on_screen`/bounds), `--window-id <n>` (capture a specific
window — the way to shoot a modal or dialog), `--display` (whole display,
composites stacked windows), `--out <path>`, `--quality <n>`, `--json`.

Every capture reports `origin` (global point origin of the captured region)
and `scale` (backing-store pixels per point). To click a feature seen at
screenshot pixel `(px, py)`:

```
global_x = origin_x + px / scale
global_y = origin_y + py / scale
```

Re-capture after any raise or window move — a window on an inactive
fullscreen Space reports shifted global coordinates.

### Interact

| Command | Description |
|---------|-------------|
| `launch` | Launch an app by `--bundle`, `--path`, or `--name` |
| `raise` | Bring an app — or one window via `--window-id`/`--title` — frontmost; switches Spaces for fullscreen windows |
| `click` | Click an element (`--id`) or coordinate (`--x --y`); `--count 2` double-clicks |
| `right-click` | Context-menu click (AXShowMenu when advertised, synthesized otherwise) |
| `type` | Set an AX field value (`--id`) or paste at a coordinate; `--commit` confirms |
| `type-text` | Stream unicode keystrokes into the focused field; `--commit` presses Return |
| `key` | Send a key chord: `enter`, `esc`, `cmd+shift+s`, ... |
| `drag` | Drag `--from "x,y"` `--to "x,y"` |
| `scroll` | Scroll by `--dy`/`--dx` at an element or coordinate |
| `ax-action` | Perform any advertised AX action (`AXConfirm`, `AXCancel`, ...) on an element |
| `focus` | Set AX keyboard focus to an element |
| `wait` | Sleep (`--duration`) or poll an element/locator until `exists`/`enabled`/`disappears` |

Shared flags: every interact verb takes `--bundle`/`--pid`; reads take
`--json`. `click`/`type-text`/`key`/`drag`/`scroll` accept `--raise` to bring
the target frontmost before acting.

### Focus discipline

Keystrokes are posted to the target pid. Apps that gate input on key-window
status (VM guests such as Parallels, some Catalyst apps) silently drop them
when the app is not frontmost. The daemon therefore reports `"frontmost"` in
every `type-text`/`key` result, and the CLI prints a stderr warning when it is
`false`. Pass `--require-frontmost` to turn that situation into a hard
`not_frontmost` error instead. The reliable sequence for key-window-gated
apps:

```bash
agents computer raise --bundle <id> --title "<window>"
agents computer type-text --bundle <id> --text "..." --require-frontmost
```

### Errors worth knowing

| Error code | Meaning | Fix |
|------------|---------|-----|
| `not_frontmost` | Keystrokes would be dropped | `raise`, then retry |
| `window_offscreen` | Window is on an inactive fullscreen Space; SCK cannot capture it | `raise --window-id <n>`, re-screenshot |
| `element_not_found` | No window/element matched | `screenshot --list` / re-`describe` |
| `rpc_timeout` | Daemon did not respond within the per-call timeout | `status`; `stop` + `start` |
| `permission_denied` | Target app not in the allow list | Add `Computer(<bundle-id>)`, `reload` |

`status` output fields:

| Field | Description |
|-------|-------------|
| `installed` | Whether Agents Computer (`/Applications/Computer Helper.app`) exists |
| `daemon` | Socket up (running) or down (stopped) |
| `policy` | Count and names of allowed apps from the policy file |
| `peers` | Count of caller executables allowed to connect |
| `trust` | `granted` or `denied` from a live `trust_status` RPC call |
| `pid` | Helper process PID (when trust is probed successfully) |

### History and discovery

| Command | Description |
|---------|-------------|
| `agents computer sessions` | Browse computer-driving history, grouped by run. `agents sessions --computer` is the same view. |

`agents computer sessions` flags: `--machine <name>` (only rows on/driving a
matching hostname, machineId, or `--device` name), `--limit <n>` (cap the flat
table at this many rows — default 50; the interactive picker and `--json` are
unbounded), `--json`, `--no-interactive`.

There is no capture directory the way `agents browser sessions` has one per
task — a computer action drives a live GUI in place and leaves no file behind.
The durable source is the `computer.action` event every verb already writes
(`~/.agents/.history/events/`, 7-day/50 MiB default retention, same as any
other audit event), and each row is every action sharing one CLI process's
pid: a single explicit verb (e.g. `agents computer click ...`) is a one-action
row, and a whole `agents computer run --task "..."` loop collapses to one row
holding every verb the model drove, labeled with the (truncated) task text.

On a real terminal (no `--json`/`--no-interactive`), `sessions` opens an
interactive, **task-first** browser: one row per run, newest first, showing
machine, target app/window bundle when known, action counts by verb, and —
when the run's session identity resolves — the owning agent session. A run
whose CLI process carried a real `AGENT_SESSION_ID`/`AGENT_LAUNCH_ID` links
directly to that session's canonical digest (prompt, changes, tests, last
response); one that carried an identity nothing on this machine can index
shows **unresolved**; a bare terminal invocation with no agent session env at
all shows **unlinked** — its actions are still listed, there's just no session
to attribute them to.

Each invocation's identity is also written to a durable `computer_sessions` row
in the local session DB. The event ledger is deliberately bounded (7 days /
50 MiB by default), so once it prunes, a run's individual actions are gone —
before this, the whole run vanished from the listing with them. It now stays
listed from that row, carrying identity, timing and a total action count, with
an empty per-verb breakdown: those actions really are gone, and are never
reconstructed. The row is metadata only, and the bounded `--task` preview is the
same text the ledger already stored — no new content is captured.

Search matches task text, machine, target bundle, the
linked session's agent/topic, or a driven verb; `enter` prints the
highlighted run's full action list (there's nothing to open — no artifact
exists per action) and the picker keeps browsing. `--no-interactive` prints
the flat per-run table instead — the stable, scriptable surface `--json` also
uses.

**Retention and privacy.** Nothing here adds a second retention policy —
`agents computer sessions` reads the same bounded, auto-pruned event ledger
every other `agents <cmd>` audit event already lands in. Nothing sensitive is
persisted: `type`/`type-text` actions already record only the typed length,
never the text; a `run --task` description is the agent's own instruction
(the same class of content `agents sessions` already stores as a session
prompt), kept but bounded to 200 characters before it is ever written — never
the full text.

## Remote Windows (`--device`)

Every verb takes `--device <device>` to drive a Windows machine registered with
`agents devices`: `setup --device` pushes the C# daemon
(`computer-helper-win.exe`) and registers a LOGON scheduled task,
`start --device` opens an `ssh -L` tunnel to its loopback port, and every other
verb reconnects through that tunnel. The daemon mirrors the macOS wire
contract, with these Windows specifics:

- **Screenshots are pid-scoped, PNG-encoded.** `--list` enumerates the target
  pid's top-level windows (`window_id` is the Win32 HWND — the same id
  `raise --window-id` takes), the default capture crops to the pid's largest
  on-screen window, `--window-id` shoots one window, `--display` the whole
  display the app is on. `--quality` is ignored (lossless PNG).
- **Lifecycle:** `status --device <device>` reports the recorded tunnel and a
  live daemon probe; `reload --device <device>` restarts the daemon's scheduled
  task (the way to pick up a freshly pushed exe) and confirms it answers.
  There is no allow-list policy on Windows — the daemon is tunnel-gated.
- **`--require-frontmost` is enforced:** Windows synthetic input lands in the
  *focused* window, so `type-text`/`key` report `frontmost` and the flag turns
  a non-foreground target into a hard `not_frontmost` error.
- **`--background` is rejected** (`action_unsupported`): the macOS
  focus-safe postToPid delivery has no Win32 analogue — synthetic input is
  global. Element mode (`--id` on an invokable element) is the focus-safe path.
- **`get-text` needs `--id`** (from `describe`); `--max-chars` caps the
  extraction (default 20k).

```bash
agents computer setup --device win-mini      # push exe + register LOGON task
agents computer start --device win-mini      # open the tunnel
agents computer status --device win-mini     # tunnel + daemon liveness
agents computer screenshot --device win-mini --pid 27180 --list
agents computer reload --device win-mini     # restart the remote daemon
agents computer stop --device win-mini       # tear down tunnel + task
```

## Recipes

### 1. Install engine + helper and grant accessibility

```bash
# The engine (once per machine)
npm i -g @phnx-labs/computer-cli

# Install the helper
agents computer setup

# Grant permissions in System Settings (manual step)
# Then:
agents computer start
agents computer status
# trust: granted means you are ready
```

### 2. Screenshot the active app

```bash
agents computer start

# Bring the app you want to the foreground, then:
agents computer screenshot --out /tmp/app-snapshot.jpg

# Or target a specific app by bundle ID:
agents computer screenshot --bundle com.apple.mail --out /tmp/mail.jpg

# Or enumerate windows (reveals modals) and capture one:
agents computer screenshot --bundle com.apple.mail --list --json
agents computer screenshot --bundle com.apple.mail --window-id 1234 --out /tmp/dialog.jpg

agents computer stop
```

### 3. Add a new app to the allow list, then reload

```bash
# Add the bundle ID to your permissions group
cat >> ~/.agents/permissions/groups/computer.yaml << 'EOF'
  - "Computer(com.apple.calendar)"
EOF

# Reload without restarting the daemon
agents computer reload
# Output: policy: 4 apps allowed (com.apple.mail, com.apple.notes, ...)

# Now screenshot Calendar
agents computer screenshot --bundle com.apple.calendar --out /tmp/calendar.jpg
```

### 4. Drive a native app end-to-end

The loop is observe → act → verify: act, then re-screenshot and compare —
a byte-identical image means the action did not land.

```bash
agents computer start
agents computer status                                  # confirm trust: granted

agents computer raise --bundle com.apple.notes
agents computer describe --bundle com.apple.notes       # element ids @eN
agents computer click --bundle com.apple.notes --id @e7
agents computer type-text --bundle com.apple.notes --text "meeting notes" --require-frontmost
agents computer screenshot --bundle com.apple.notes --out /tmp/notes-after.jpg

agents computer stop
```

For AX-opaque surfaces (VM guests, Chromium/UXP canvases) `describe` shows
nothing useful inside the content area — work in coordinate mode from
screenshot `origin`/`scale` instead, and gate keystrokes with
`--require-frontmost`. The `computer` skill in the system DotAgents repo
(`skills/computer/`) is the agent-facing playbook for both modes.

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/computer.mp4"></video>

## See also

- [docs/browser.md](browser.md) — drive real browsers via CDP; part of the automation triad
- [docs/pty.md](pty.md) — drive REPLs and TUI programs from an agent; part of the automation triad
- [docs/concepts.md](concepts.md) — DotAgents repos, resource resolution model
