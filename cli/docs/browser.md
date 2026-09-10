<!-- guide -->
# Browser

Drive Chromium-family browsers from AI agents via the Chrome DevTools Protocol.

## Overview

`agents browser` gives agents a real browser — the same Chrome, Brave, or Edge you use manually, with your existing cookies, fingerprint, and IP. There is no Playwright subprocess, no automation flags, no relay extension. Sites that block Puppeteer and Playwright let it through because there is nothing to detect.

The CLI manages browser processes, tab lifetimes, and network capture through a browser IPC service hosted by the shared `agents` daemon. Each agent creates a named **task**. Multiple agents run tasks in parallel without sharing state: profile A has its own `chrome-data/`, profile B has its own — no cookie bleed, no race on focus.

Intended users: LLM agents that need to log in to real web apps, scrape authenticated pages, fill forms, upload files, or capture screenshots to feed back into a reasoning loop.

## Architecture

```
agent process
     │
     ├─ agents browser <subcommand> (one request, then exit)
     │
     └─ agents browser stream (long-lived NDJSON; process + socket stay warm)
        (both resolve $AGENTS_BROWSER_TASK or --task)
     ▼
  CLI (browser.ts)
     │
     │  JSON-RPC over UNIX socket
     │  ~/.agents/.cache/helpers/browser.sock
     ▼
  Browser IPC service (inside the shared agents daemon)
     │
     │  Chrome DevTools Protocol
     │  ws://127.0.0.1:<port>/json
     ▼
  Browser process
  (Chrome / Brave / Edge / Chromium / Comet)
     │
     ├── Profile A  chrome-data/A/  →  Task swift-crab-a1b2
     └── Profile B  chrome-data/B/  →  Task bold-phoenix-c3d4

  Remote variant (ssh:// endpoint):
  CLI → SSH tunnel → CDP on remote host → remote Chrome

  Native Arc variant (arc-native:// endpoint, macOS only):
  CLI → osascript (Apple Events) → running Arc → Space/tab
```

The browser service auto-starts on the first command that needs it. If the
shared daemon is already running, the client enables `browser-ipc` and reloads
that service in place; otherwise it starts the shared daemon. Commands that
only inspect local state (`ps`, `profiles list`) do not start it.

Liveness is a *reply*, not just an accept. The browser service shares one event
loop with the rest of `agents __daemon-run`, and a unix-socket `connect` succeeds
at the kernel level even when that loop is blocked — so a busy daemon accepts on
`browser.sock` while never servicing the request. Before running a verb the CLI
requires the service to actually answer a `version` probe; a reachable-but-wedged
service fails loud with the shared daemon log path and the operator-owned
recovery verb, instead of an indefinite hang. `agents browser stop --service`
disables and stops only `browser-ipc`; the daemon PID and sibling services stay
up, and the next browser action that requires IPC re-enables the service in
place (PHNX-3605). Inspection-only `browser status` reports the stopped state
without changing it.

A client/daemon version mismatch is advisory. The client keeps using the
compatible browser protocol and never stops or restarts the shared daemon. When
current daemon code is required, the warning points the operator to the explicit
`agents daemon restart` lifecycle command.

Tasks are addressed by a short machine id (8 hex chars). `browser status`
shows a human **label** (`--title` if given, else the first navigated host,
else `untitled`). In the common case you never type a handle: the CLI stamps
the caller's session/launch identity and the daemon resolves the single live
task for that caller. Pass `--task` only when deliberately running two tasks
at once. `$AGENTS_BROWSER_TASK` is still accepted as an explicit override.
Page verbs (`navigate`, `screenshot`, …) create a task when none resolves;
`done`/`stop` never create.

## Setup

### 1. Create a profile

A profile names a browser + CDP endpoint pair. **A new profile is machine-local
by default** (RUSH-2716): it is written to this machine's own
`~/.agents/devices/<machine>/agents.yaml` under `browser:`, and no other machine
sees it. That is the right default because a profile pins an OS-specific
`binary:` path and a locally chosen CDP port, so a synced copy is wrong on every
other box — and because agents create throwaway profiles freely, syncing each one
filled the shared file with junk.

A name declared by exactly one device is identity-bearing (the daemon tunnels
to that device). A name declared by several devices is fungible (use the local
one). Leftover central `browser:` entries are claimed with
`agents browser profiles claim` on the machine that hosts the browser.

Runtime state — the Chrome `chrome-data` cookie jar — lives separately under
`~/.agents/.cache/browser/<profile>@<device>/`, which is gitignored and
per-machine, so each machine logs in once.

```bash
# Minimal: let agents pick a free port and auto-detect the binary (this device)
agents browser profiles create work --browser chrome

# Pin an endpoint explicitly
agents browser profiles create work --browser chrome --endpoint "cdp://127.0.0.1:9222"

# Remote host via SSH — declare it on the machine that should own the name
agents browser profiles create staging --browser chrome \
  --endpoint "ssh://deploy@staging.example.com?port=9222"
```

`agents browser profiles list` shows a `WHERE` column of declaring devices.

If you skip `--profile`, or pass the reserved name `--profile default`, the
profile is resolved in this order — the same order in **every** command
(`start`, `stop`, `status`, `navigate`, `tab add`), not just `start`:

1. **A profile that literally bears the name you typed.** A profile you named
   `default` yourself resolves to itself and is never redirected.
2. **Your configured default** — the profile set via `agents browser use <name>`
   on THIS machine, when it can launch here. If its browser/binary isn't
   installed on this machine, `start` warns and falls through to auto-detect.
3. **The auto-detected profile, `auto-chrome`** — or the `default`-named
   predecessor an older agents-cli wrote on this machine, which keeps working.
4. **Auto-detect** (`start` only) — the first installed Chromium-family browser,
   saved as the `auto-chrome` profile. Detection priority:
   - macOS: Chrome > Brave > Edge > Chromium > Comet
   - Linux: Chrome > Chromium > Brave > Edge
   - Windows: Edge > Chrome > Brave > Comet

   An auto-detected profile that came from another OS whose binary is missing
   here — a `/Applications/...` Chrome path resolved on Linux, say — is
   **regenerated for this machine** rather than failing with "Custom binary not
   found". Remote (`ssh://`) defaults skip this check: their browser lives on the
   far host.

`default` is an **alias**, not a profile: it means "whatever profile this machine
is configured to use". The auto-detected profile is called `auto-chrome` so the
two cannot be confused (before RUSH-2709, `default` meant both, and only `start`
honored the alias — so `--profile default` reached a different profile in
`navigate` than in `start`).

### Profile names vs runtime keys

`agents browser profiles list`, `status`, and `--profile` all use the **bare**
profile name (`comet-local`). A running browser is *stored* under a runtime key
that also names the device it resolved to (`comet-local@zion`), so the same
name on two machines does not collide on disk. That key is an implementation
detail you never have to type or read. Leftover `@endpoint-N` dirs from older
builds are renamed onto the device key. `status` renders the two separately:

```
comet-local (device: zion, port 9222, pid 4183)
```

and `status --json` carries them as separate `profile`-side fields:

```json
{ "name": "comet-local", "device": "zion", "key": "comet-local@zion" }
```

Passing a runtime key where a name is expected still works, so a key copied out
of an older listing resolves to its profile.

The configured default is a **per-device setting**: it lives in this machine's
`browser.profile` config key (`devices/<machine>/agents.yaml` `config:`), so
each machine keeps its own choice — the profile it points at may hold
machine-local logins. It is machine-local: only this box can set it. Set it
once per machine.

Safari and Firefox are not supported. They do not implement the Chrome
DevTools Protocol.

### Attach-only profiles — one canonical browser (PHNX-3967)

A profile has a **launch policy** that decides how agents get a live browser:

- **`launch` (default):** agents spawn the browser themselves under a managed
  `--user-data-dir` when nothing is serving CDP on the port. Right for a
  throwaway automation profile.
- **`attach-only`:** agents **never spawn a rival window**. They attach to a
  browser you already started with remote debugging, and if none is there they
  fail loud with the exact relaunch command instead of opening a second,
  logged-out instance. This is how you keep **one** signed-in browser.

**Arc is always attach-only.** On macOS, agents-cli discovers and drives the
already-running Arc through native Apple Events; it never asks you to relaunch
Arc with a debug port. Comet remains the recommended Chromium/CDP profile when
the workflow needs screenshots, downloads, network capture, or trusted input:

```bash
agents browser profiles create agents-comet --browser comet --attach-only
agents browser use agents-comet
```

`create` prints the one-time relaunch. Start the canonical Comet once with a
**durable** data dir (kept under `~/.agents/.history/browser-profiles/<name>/`,
outside `.cache`, so the sign-in survives quit+relaunch and `profiles remove`):

```bash
open -a Comet --args --remote-debugging-port=<port> --user-data-dir=<durable>
```

Sign in once in that window. From then on agents attach to it — never a second
Comet, so there is exactly one dock tile. Multiple attach-only profiles are
supported; nothing hard-codes a single name.

**Port-squat protection.** Attaching checks ownership beyond browser family:
before adopting an endpoint agents compare the running instance's
`--user-data-dir` to the profile's durable dir. A foreign browser answering CDP
on the canonical port (for example a stray logged-out `/tmp` Comet) is
**rejected**, not driven — `agents browser profiles doctor <name>` flags it and
names the `kill` + relaunch to fix it.

Make an existing profile attach-only with `agents browser profiles edit <name>
--attach-only` (`--launch` undoes it).

### 2. First-run onboarding

On the first `start`, Chrome opens to a new user-data directory with no
cookies or saved state. Complete any first-run screens (agree to terms,
sign in) before automating. Run `agents browser profiles doctor <name>` to
check if onboarding is complete.

### 3. Drive the page (no export required)

```bash
# Implicit task create + navigate — identity tracks the rest of the session
agents browser navigate https://example.com
agents browser screenshot

# Explicit start still useful for --profile / --url / --record / --title
agents browser start --profile work --title "login check"
agents browser screenshot   # resolves from caller identity
```

Pass `--task <id>` only when running two tasks at once. `$AGENTS_BROWSER_TASK`
remains a valid explicit override.

### Keep the action loop warm

Normal `agents browser <command>` calls are convenient for individual actions,
but each shell invocation starts a new Node process and opens a new daemon IPC
connection. For an observe-and-act loop, start `browser stream` once and send one
IPC request object per line. It keeps both the narrow browser CLI process and the
existing browser-daemon socket open until stdin closes; the daemon continues to
reuse its existing CDP connection.

```bash
printf '%s\n' \
  '{"action":"screenshot","path":"/tmp/page.jpg"}' \
  '{"action":"click","atX":320,"atY":540}' \
  | agents browser stream --task "$AGENTS_BROWSER_TASK"
```

The response is one compact JSON object per non-empty input line, in the same
order. A long-lived caller can leave stdin open and write later requests to the
same process. `--task` supplies the default `task` field; a task returned by a
`start` request becomes the default for subsequent lines. Malformed JSON returns
an error response without closing the stream. A fleet-remote `start` line obeys
the same device-local `browser remote-control` consent gate as the ordinary
`browser start` command.

## Command Reference

### Profile management

| Command | Description |
|---------|-------------|
| `agents browser use [name]` | Pick this machine's default profile. No name opens a picker on a TTY or prints the current default headlessly; `--unset` or `auto` restores auto-detect. |
| `agents browser profiles list` | List configured profiles plus read-only native Arc discovery and the devices declaring each one (`WHERE`). A `*` marks this machine's configured default — which is NOT the same thing as the profile named `default`. `--json` adds `devices` + `kind` (`identity` \| `fungible`) + `isConfiguredDefault` |
| `agents browser profiles create <name>` | Create a new profile on this device (`add` is an alias). Prints `Added "<name>" on <device> (port N).` `--attach-only` makes it never spawn a rival window (PHNX-3967); `--user-data-dir <path>` pins a durable data dir |
| `agents browser profiles add <name>` | Alias of `create` |
| `agents browser profiles seed` | Create a machine-local profile for each installed browser (named `<browser>-local`), so you can `browser use` one instead of hand-crafting each. Idempotent — existing profiles are left untouched |
| `agents browser profiles prune` | Remove dead profiles this device declares — browser not installed here, or never started (see below) |
| `agents browser profiles edit <name>` | Edit an existing profile in place — description, endpoints, secrets, viewport, binary, `--attach-only`/`--launch` (PHNX-3967), `--user-data-dir`. Stays in the store it already lives in. The browser type and the name are NOT editable: both key the on-disk profile cache (and its logins), so changing either orphans it — delete and recreate instead |
| `agents browser profiles rename <from> <to>` | Rename a profile and move its browser data with it, so logins survive. Refuses while the profile is in use. The one safe way to change a name: `edit` refuses it, and delete-and-recreate abandons the `--user-data-dir` |
| `agents browser profiles claim [name]` | Move leftover central `browser:` entries into this device's declaration file. Only profiles this machine can host are claimed. Run on the machine that actually has the browser. |
| `agents browser profiles show <name>` | Show profile details |
| `agents browser profiles use <name>` | Compatibility spelling for `agents browser use <name>` |
| `agents browser profiles logins` | Per profile: `SERVICE \| ACCOUNT \| CREDS` — live session, the signed-in account (plaintext username, never decrypts), and whether login creds are in the profile's secrets bundle |
| `agents browser profiles remove <name>` (alias `delete`) | Remove the agents-cli alias and cache. For native Arc, never removes Arc profile, Space, or tab data. |
| `agents browser profiles doctor <name>` | Diagnose the native Arc profile/Spaces and running app, or the CDP profile's declaration, binary, port, user-data-dir, and onboarding state. |

`profiles create` flags:

| Flag | Description |
|------|-------------|
| `-b, --browser <type>` | Required. One of: `chrome`, `comet`, `chromium`, `brave`, `edge`, `arc`, `custom`. Native Arc profiles are auto-discovered rather than manually created; see [Arc](#arc-native-automation). Legacy CDP Arc declarations remain compatible. |
| `-e, --endpoint <url>` | CDP endpoint URL (repeatable). Auto-assigned if omitted |
| `-s, --secrets <bundle>` | Secrets bundle for this profile: injected as env vars at launch, AND the credential store for `browser type --secret` (keys `<PREFIX>_USERNAME`/`<PREFIX>_PASSWORD`). Warns if the bundle doesn't exist yet |
| `-d, --description <text>` | Human-readable description |
| `--headless` | Run in headless mode |
| `--window <WxH>` | Window size in CSS pixels (default: 1512x982, MacBook Pro 14") |
| `--position <X,Y>` | Window position on screen |
| `--binary <path>` | Absolute path to browser binary (required for `--browser custom`) |
| `--electron` | Treat as an Electron desktop app; never creates new targets |
| `--target-filter <expr>` | Pick the existing CDP page target to drive. Format: `url:<substring>` or `title:<substring>`. Requires `--electron` **or** `--browser arc` (both reuse an open tab rather than creating one) |

### Which browser shows YOU a page (`browser.viewer`)

Two browsers exist on a machine like this, and they are not interchangeable:

- the **OS default handler** — whatever `open`/`xdg-open` resolves to
- the **configured profile** — what `agents browser` drives, and where the
  fleet's logins accumulate (`agents browser profiles logins` lists them)

Anything the CLI shows you — a rendered artifact, `agents feedback`, a login
dashboard, `agents sessions trace --open` — goes through one seam that resolves
the viewer once:

| `browser.viewer` | Result |
|---|---|
| unset | follows `browser.profile`, i.e. the profile agents drive |
| a profile name | that profile |
| `os` | the OS default handler |

Set it with `agents config set browser.viewer <name>`, or `agents config set
browser.viewer os` to keep the OS default handler.

External tools reach the same seam through `agents browser show <url|file>`,
which is the entry point to use instead of `navigate` for anything a person is
going to read — `navigate` binds a task, and the abandoned-task reaper closes a
task's tabs. `--os-browser` forces the OS handler for one call; `--json` reports
where it landed (`profile`, `os`, or `none`).

Two deliberate carve-outs. Screenshots, PDFs and recordings go to the OS default
**app** regardless — Preview and QuickTime are the better viewer and a CDP tab is
a downgrade. And the viewer tab is bound to **no task**, so the abandoned-task
reaper never closes a page you are reading; `stop`/`done` leave it alone too,
because it is your tab now.

If the viewer cannot be reached — profile missing, Arc (which can't open a fresh
viewer tab; see [Arc](#arc-attach-to-your-running-window)), not launchable here —
the call falls back to the OS handler and prints one line saying why. It never
silently ignores your configuration.

### Identity-bearing names vs loopback endpoints

A name declared by exactly one device is identity-bearing. The daemon resolves
it without the caller naming a machine:

- this device declares it → connect locally
- only other devices declare it → rewrite `cdp://localhost:N` to
  `ssh://<device>?port=N` and tunnel; unreachable declaring devices fail loud
  (never a local logged-out fallback)
- nobody declares it → loud error. If the name still lives in the central
  `browser:` map, the error tells you to `profiles claim` it on the machine
  that hosts the browser; otherwise it lists similar names and who declares them

A name declared by several devices is fungible: each box uses its own.

`cdp://localhost:9333` on an identity-bearing name is the original
`comet-local` bug when a worker evaluates it locally — five real logins on
zion, a bare logged-out chromium on the worker, same name. The daemon now
tunnels that shape. `profiles doctor` still flags it (`FAIL where`) so a
worker does not report a green local binary/port for someone else's browser,
and `profiles prune` notes it in the `kept` reason. Diagnose the real browser
on the declaring device.

Leftover central `browser:` entries (the pre-registry `comet-local` sitting in
`~/.agents/agents.yaml`) are not claimed on upgrade. On the machine that owns
the browser:

```bash
agents browser profiles claim comet-local
```

Nothing claims implicitly — an implicit claim would race across devices.

`--device` is only valid on `agents browser start`. Later verbs (`navigate`,
`screenshot`, `type`, `stop --profile`, …) resolve the device from the task
and reject `--device`. `--device all` is rejected: a task lives on one device.

```bash
agents browser start --task post --device zion --url https://x.com/
agents browser type --task post --ref @e3 "hello"
agents browser screenshot --task post
```

### Native profiles are discovered, and the fleet sees them

On a Mac, `agents browser profiles list` shows the profiles your browsers
already have, without creating anything:

- **Arc**: one profile per Space (`arc-gmail`, `arc-work`, ...), see
  [Arc native automation](#arc-native-automation).
- **Comet**: one profile per entry in Comet's own profile menu (`comet-work`,
  ...), read from Comet's `Local State` and pinned to Comet's real user-data dir
  and profile directory. Agents and you share **one Comet window per profile**:
  agents attach when your Comet is running with remote debugging on the
  profile's port, launch Comet on your own store (your logins, your history)
  when it is not running, and fail loud with the exact relaunch command when it
  is running without a port. Clicking Comet in the Dock while agents hold it
  open focuses that same window. `AGENTS_COMET_DIR` points discovery at another
  store. Two profiles with the same display name stay distinct by their
  directory (`comet-work-default`, `comet-work-profile-2`).

The daemon's fleet-sync tick publishes every discovered profile into this
device's declaration (`~/.agents/devices/<device>/agents.yaml`), which the
shared-store sync carries to every other box. So on a worker,
`agents browser profiles list` shows `arc-gmail` with `WHERE=zion`, and
`agents browser start --profile arc-gmail` from that worker runs on zion
(native Arc dispatches the whole command; a Comet profile tunnels its CDP port
over SSH). A discovery read that fails for one browser never hides the others;
only a lookup of that browser's profile by name reports the failure.

### Arc native automation

Arc is single-instance, so `agents browser` never launches it. On macOS every
**Arc Space is listed as a browser profile** — `arc-personal`, `arc-work`,
`arc-dev` — discovered read-only from Arc's own metadata. A Space already
carries its Arc profile's cookies and logins, so it IS the profile agents pick
with `--profile`; there is no second "space" concept and nothing to create. The
CLI drives the Arc instance already running through Apple Events. No debug port
or Arc relaunch is required.

Discovery is read-only for `profiles list`, `profiles show`, and `profiles
doctor`. `browser use <arc-profile>` and an explicit `browser start` are the
adoption points that persist only the agents-cli alias; removal deletes that
alias, never Arc's profile, Space, or tab data.

```bash
agents browser profiles list          # one row per Arc Space
agents browser profiles show arc-personal
agents browser use arc-personal       # agents default to your Personal Space

agents browser start --profile arc-dev --url https://example.com
agents browser navigate https://example.org   # the task's own tab, in Dev
agents browser done                   # closes only the tabs the task created
```

Native Arc profiles use an `arc-native:` endpoint protocol and support a subset of
browser operations:

| Capability | Status |
|---|---|
| Space discovery from Arc metadata, one profile per Space | Supported |
| Create a tab in the profile's Space | Supported (marker-based resolution); Arc selects the new tab for about 100 ms, then the previously selected tab is restored |
| Navigate an owned tab | Supported, silent |
| Evaluate synchronous JavaScript | Supported, silent (a tab Arc has put to sleep times out after 15 s) |
| DOM click, fill, scroll via evaluate | Supported (events are `isTrusted: false`) |
| Close owned tabs | Supported, silent |
| Explicit `tab focus` | Supported; this is the only routine that keeps a tab selected |
| Screenshot and PDF | Unsupported |
| Async/promise evaluation | Unsupported |
| Network/console capture | Unsupported |
| Upload/download and trusted coordinate/key input | Unsupported |
| Background operation | Unsupported (`background:false`); Arc never becomes frontmost, but tab creation briefly selects the new tab |

Unsupported capabilities throw a structured `ArcNativeCapabilityError` with a clear
message and a pointer to Chromium-family alternatives. They never return fabricated
success or silently switch to another browser.

**Discovery.** `arc-discovery.ts` reads Arc's `User Data/Local State` (Chromium
profiles) and `StorableSidebar.json` (Spaces and the profile each binds to) under
`~/Library/Application Support/Arc` as read-only metadata; `AGENTS_ARC_DIR` points
at another root. Profile ids and Space ids are authoritative; profile names and
Space titles are display-only, and two Spaces sharing a title get the first six
characters of their Space id appended to the profile name. An unknown or malformed
Space-to-profile mapping fails discovery instead of falling back to the Default
profile.

**Tab identity.** Durable task state stores `{windowId, spaceId, tabId}` for each
owned tab. URL and title are display data, never identifiers. Every AppleScript
operation re-resolves current indices from those ids inside the same call. A tab
moved out of its original window/Space is missing and is never adopted elsewhere.

**Tab creation and crash recovery.** Before asking Arc to create anything, the
service persists a unique exact marker plus the intended final URL. It then
creates at that marker in the profile's Space, persists the returned native ids,
navigates, and restores the tab you had selected. After a daemon restart,
reconciliation matches that exact marker only; ambiguous, externally changed,
moved, or otherwise unprovable state fails closed. The prior active tab is
restored only when the newly owned tab is still active, so a later human
selection wins.

**DOM actions.** `refs` records CSS selectors for the current owned tab.
`click` invokes the element's `.click()`. Fill/type calls the native input or
textarea value setter and dispatches bubbling `input` and `change` events, so
React-controlled forms observe the edit. `scroll` calls `window.scrollBy`.
These operations use the exact native tab reference and do not select it.

**Invisible windows excluded.** Arc enumerates closed window tombstones with
`visible:false` — the driver filters them out so only user-accessible windows appear.

**Remote dispatch.** A worker dispatches the whole command to the device that
declares the native Arc profile. The task-to-device index records that owner, so
later task verbs follow it. Native endpoints are never exposed as fake local CDP
sockets or SSH tunnels. The existing remote-control consent gate still applies.

This is why Arc is never used as the [viewer](#which-browser-shows-you-a-page-browserviewer)
(showing a human a page needs its own fresh tab).

### Cleaning up dead profiles (`prune`)

Profiles accumulate — an agent mints one for a task and never removes it.
`agents browser profiles prune` removes the ones that are provably dead:

| Reason | Meaning |
|--------|---------|
| `binary-missing` | The profile's browser/binary is not installed on this machine, so it cannot launch here at all |
| `never-used` | No runtime dir has ever been created for it (`~/.agents/.cache/browser/<name>*` is absent) |

```bash
agents browser profiles prune --dry-run   # preview; changes nothing
agents browser profiles prune             # apply
agents browser profiles prune --json      # machine-readable plan
```

Four guards, each because removing that profile would be wrong rather than untidy:

- **In use** — a live browser, an SSH tunnel, or an open task on *any* of its
  runtime dirs, runtime-key (`<name>@<endpoint>`) dirs included.
- **This machine's configured default** — a bare `agents browser start` resolves
  to it.
- **The auto-detected profile** (`auto-chrome`, or a legacy `default`) —
  regenerated on demand, so pruning it is pure churn.

`prune` only considers profiles this device declares. A name declared only on
another device is left alone (and reported if it is misfiled).

Removing a profile drops its config entry and wipes its cache dirs, exactly like
`profiles remove`.

> A profile config records no creation time, so one you created seconds ago and
> have not started yet is indistinguishable from an abandoned one and reports
> `never-used`. Preview with `--dry-run` first.

### Session lifecycle

| Command | Description |
|---------|-------------|
| `agents browser start` | Start a browser task, or reuse a matching named task; prints its task handle to stdout |
| `agents browser done` | Complete the task and close its tabs |
| `agents browser stop` | Stop a task (or `--profile <name>` to detach whole profile) |
| `agents browser status` | Show browser service state and running tasks (interactive picker in TTY) |
| `agents browser tasks` | List all tasks in non-interactive table form |
| `agents browser ps` | List all tracked browser/electron/tunnel processes, alive or stale |
| `agents browser history` | Recent task history |
| `agents browser stream [--task <name>]` | Keep one CLI process and daemon IPC socket open; NDJSON requests in, NDJSON responses out |
| `agents browser prune [--dry-run]` | Run the abandoned-task reaper now instead of waiting for the daemon's next tick (alias: `gc`) |

`start` flags:

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Profile to use (auto-picks if omitted) |
| `--task <name>` | Choose a task name. An existing name reuses the same task only when caller, profile and endpoint match; a conflict fails |
| `-e, --endpoint <name>` | Endpoint preset within the profile |
| `-u, --url <url>` | Open URL in first tab. If an abandoned task on this profile already holds a tab showing that exact URL, the tab is reclaimed instead of a duplicate being opened (RUSH-2622) — a tab held by a live task, or one you opened yourself, is never taken |
| `--fresh` | Always open a new tab, skipping the reclaim above |
| `--json` | Return machine-readable task/tab IDs and operation outcome instead of the stdout task handle |
| `--no-skills` | Skip domain-skill auto-discovery |
| `--record` | Start recording immediately after tab opens |
| `--fps <n>` | Recording frames per second (1–30, default 5) |
| `--duration <sec>` | Recording duration cap (default 60s) |
| `--max-mb <mb>` | Recording size cap (default 25 MB) |

Retrying `start --task <name> --url <url>` refreshes the same tab when that URL
already lives in one of that task's owned tabs, and reports `Tab already
open—refreshed` with its tab ID. A different URL keeps normal navigate-current
behavior. Without `--url`, a named retry simply returns the existing task; it
does not reload a page. Without `--json`, stdout remains the task handle alone,
with operation notes and the tab ID on stderr.

### Tab hygiene — automatic reaping (RUSH-2622)

`agents browser done` / `stop` close a task's tabs, but agents routinely never
call them — the run ends, the process exits, and the tabs stay open in the
profile window forever. The daemon runs a periodic reaper so leftover tabs
don't pile up, on the same 5-minute cadence as its other housekeeping ticks:

- **Session-end reap.** When the agent session (or run) that started a task is
  no longer alive on this host, the daemon closes that task's tabs and marks it
  done — the same code path `done` uses. This always runs; there is no way to
  turn it off.
- **Idle reap.** A task with no IPC action (navigate, click, type, screenshot,
  evaluate, …) for `browser.task-idle-minutes` (default **30**) is closed the
  same way. Set it to `0` to disable idle reaping only — a task with no
  recorded identity then never gets closed by this path, though session-end
  reaping still catches every task that *does* carry one:

  ```bash
  agents devices config <this-machine> browser.task-idle-minutes 15
  agents devices config <this-machine> browser.task-idle-minutes 0   # idle reap off
  ```

  Machine-local, like `browser.profile` and `browser.remote-control` — it
  lives in this box's own config and cannot be set for a peer.

Both reasons are conservative: only tabs in `task.tabs` are ever closed (a tab
you opened yourself is never touched), a task mid-recording is always left
alone, and the shared profile window itself is never closed or killed.

Run the same pass on demand instead of waiting for the next tick:

```bash
agents browser prune --dry-run   # list what would be closed, close nothing
agents browser prune             # actually close it (alias: agents browser gc)
agents browser prune --idle-minutes 5   # override the idle window for this run
```

### Driving another machine's browser (`--device`) and consent

`--device` is only valid on `agents browser start`. It binds the task to that
device; later verbs resolve the device from `--task` (or caller identity) and
reject `--device`. Identity-bearing profiles do not need `--device` at all —
the daemon tunnels to the declaring device from the name.

`--device all` is rejected because a task lives on one device. A verb that
names an unknown task lists the open tasks and exits non-zero.

Because start-with-`--device` lets one machine open a browser on another, the
**target decides** whether it allows it:

| Command | Description |
|---------|-------------|
| `agents browser remote-control` | Print whether this machine accepts remote drives |
| `agents browser remote-control on` | Allow other fleet machines to drive this browser |
| `agents browser remote-control off` | Refuse remote drives (the default) |

Consent is a **per-device setting** (the `browser.remote-control` config key,
in this machine's `devices/<machine>/agents.yaml` `config:`) and **off by
default**: a `browser --device <this-machine>` request that would **open** a
browser is refused with a message naming how to enable it, until the owner runs
`agents browser remote-control on` here. The key is machine-local — only this
box can set it. Local drives (no `--device`) are never gated.

The gate lives in the browser service, at the top of `resolveOrCreateTask` — the
one chokepoint every task-scoped verb resolves through — plus `BrowserService.start`
for the task-less `browser start` command and `BrowserService.stopProfile` for the
task-less `browser stop --profile` command. It has to live in the daemon, not on
the `browser start` command: `navigate`, `click`, `screenshot`, `tab-add` and the
other page verbs launch *or attach to* a browser implicitly, so gating the one
command left every one of them ungated. Daemon/profile queries that resolve no
task — `status`, `profiles list` — are not gated, so a peer can still discover
what is running without consent.

The gate covers both **launching** and **attaching**. Whether a fleet-remote
request opens a new browser or resolves to a task that already exists —
`--task <name>`, or the single-match-by-caller-identity path — it is refused with
consent off (RUSH-3064). Earlier the two attach early-returns and `tabAdd`
bypassed a create-only gate, so a remote `tab-add --device <box> --task <name>`
could drive the owner's authenticated profile with consent off (`status` is
ungated by design, so task names are discoverable). That bypass is closed: with
`remote-control off`, any fleet-remote verb that resolves a task — drive
(`navigate`/`click`/`tab-add`), close (`done`/`stop <task>`), or observe
(`console`/`tab-list`) — is refused whether or not the task already exists,
because they all flow through `resolveOrCreateTask`. The one task-less mutation
that does not — `stop --profile <name>` (terminate a whole profile's browser,
`bindTask` short-circuits it before `resolveOrCreateTask` ever runs) — is gated
separately in `BrowserService.stopProfile` (PHNX-3317; previously a
pre-existing gap tracked in RUSH-3179). Local drives (no `--device`) remain
ungated.

The marker travels **on the request**, not in the daemon's environment. The
daemon is shared and long-lived, and one auto-started by a fleet-remote CLI
inherits `AGENTS_FLEET_REMOTE=1` for its whole life — a daemon that read its own
environment would refuse every later *local* drive on the machine.

### Navigation

| Command | Description |
|---------|-------------|
| `agents browser navigate [url]` | Navigate current tab (positional or `--url`; alias `goto`). Creates a task when none resolves for this caller. `--json` for machine output |
| `agents browser tabs` | List open tabs (`*` marks the current tab; `--json`) |
| `agents browser tab add --url <url>` | Open URL in a new tab. `--json` for machine output |
| `agents browser tab focus <tabId>` | Switch to tab by ID, prefix, or URL substring |
| `agents browser tab close [tabId]` | Close a tab; omit to close all |

#### Same-task page reopen (PHNX-2399)

Reopening a URL that is **already open in one of this task's own tabs** refreshes
that same tab in place instead of opening a duplicate — the tab-spam sibling of the
RUSH-2622 abandoned-tab pile-up, scoped to the task itself:

- `navigate <url>` and `tab add --url <url>` both look across **every tab the task
  owns** (borrowed Arc/user tabs excluded — those are never the task's to reload).
  When a tab's live document URL canonically equals the requested one, the service
  issues a real `Page.reload` on **that** tab, **keeps its tab id and CDP target**,
  marks it current (without stealing window focus), and returns `refreshed: true`
  with the note **`Tab already open—refreshed`**. The load counter on that tab
  advances; a sibling tab showing a different URL is left untouched.
- **No match keeps the old, intentional split:** `navigate` reuses the *current*
  tab (or creates one when the task has none), while `tab add` opens a *new* tab.
- A **stale** registered tab (closed out from under the task) or a **failed
  reload** never reports a phantom refresh — the stale tab is skipped and the
  normal create/navigate path runs, and a reload error surfaces rather than a false
  success.
- The lookup → reload/create → persist section is **serialized per task**, so two
  concurrent `navigate`/`tab add` requests for one URL converge on a single tab and
  the same id (one reports the open, the other the refresh) instead of racing into
  duplicates. First-use creation is likewise serialized per caller, so an implicit
  `navigate <url>` with no task open opens the page exactly once and reports it as a
  genuine open — never a first open disguised as a refresh.

`--json` on `navigate` / `tab add` carries `{ ok, task, tabId, url, created,
refreshed, message }` for machine callers.

### Interaction

| Command | Description |
|---------|-------------|
| `agents browser refs` | Get numbered refs for interactive DOM elements |
| `agents browser click <ref>` | Click element by ref |
| `agents browser type <ref> --text <text>` | Type text into element; `--clear` to empty first |
| `agents browser type <ref> --secret <bundle>/<KEY>` | Type a credential resolved in-process from a secrets bundle — the value never crosses stdout or the transcript (leak-free login) |
| `agents browser press <key>` | Press a key (Enter, Tab, Escape, etc.) |
| `agents browser hover <ref>` | Hover over element by ref |
| `agents browser scroll` | Scroll by pixels; `--dx` horizontal, `--dy` vertical, `--at-x/--at-y` origin |
| `agents browser upload` | Upload files; supports hidden inputs, drag-drop, OS chooser interception |
| `agents browser set viewport <W> <H>` | Set viewport size; `--mobile`, `--scale` |
| `agents browser set device <name>` | Emulate a device preset (iPhone 14, iPad, MacBook Pro) |
| `agents browser devices` | List available device presets |
| `agents browser download --path <dir>` | Set download directory for a task |
| `agents browser waitdownload` | Wait for a download to complete |

`upload` flags:

| Flag | Description |
|------|-------------|
| `-r, --ref <n>` | Ref of the upload target (file input or drop zone) |
| `--trigger <n>` | Ref of a button that opens the OS file chooser |
| `-f, --file <path...>` | Absolute path(s) to file(s) (repeatable) |
| `--drop` | Force drag-drop pattern |
| `--input` | Force file-input pattern |
| `--timeout <ms>` | Timeout for chooser interception |

### Observation

| Command | Description |
|---------|-------------|
| `agents browser screenshot` | Capture current tab; path printed to stdout |
| `agents browser evaluate [expr]` | Run JavaScript (positional, `-e`, or `--file`; alias `eval`) |
| `agents browser console` | Read console logs; `--level` (log/info/warn/error), `--clear` |
| `agents browser errors` | Read uncaught page errors; `--clear` |
| `agents browser requests` | Captured network requests; `--filter <text>` |
| `agents browser responsebody <url-pattern>` | Wait for and read a response body |
| `agents browser logs` | Read app JSONL logs; `--task` (or identity), `--source`, `--lines`, `--since`, `--until`, `--level`, `--message`, `--filter` |

`screenshot` flags:

| Flag | Description |
|------|-------------|
| `-t, --tab <tabId>` | Tab to capture (defaults to current) |
| `-o, --output <path>` | Specific output path; auto-saves under sessions/<task>/ if omitted |
| `-q, --quality <mode>` | `compressed` (JPEG, ~100 KB cap) or `raw` (PNG pixel-faithful) |

### Recording

| Command | Description |
|---------|-------------|
| `agents browser record start` | Start recording; auto-saved under sessions/<task>/recordings/ |
| `agents browser record stop` | Stop recording; prints output path to stdout |

`record start` flags: `--fps`, `--duration <sec>`, `--max-mb`.

### History and discovery

| Command | Description |
|---------|-------------|
| `agents browser history` | Recent task history; `--limit <n>` |
| `agents browser refs --all` | Include non-interactive elements; `--limit <n>` |
| `agents browser wait` | Wait for a condition: `--time`, `--selector`, `--url`, `--fn`, `--state` |
| `agents browser sessions` | Browse captured screenshots, PDFs, recordings, and downloads, grouped by task. `agents sessions --browser` is the same view. |

`agents browser sessions` flags: `--profile <name>` (default: every profile with
captures), `--open [selector]` (open `latest` or a filename match in the OS
default app), `--json`, `--no-interactive`.

On a real terminal (no `--json`/`--open`/`--no-interactive`), `sessions` opens an
interactive, **task-first** browser: one row per browser task, newest first —
not one row per screenshot. Each task records the agent session that started it
(`AGENT_SESSION_ID`, resolved in the calling CLI process — the shared browser
daemon cannot know it), plus `owner` and `launchId`. That identity is written
once at task start to a durable `browser_sessions` row in the local session DB
and is **never deleted**, so a task still links to its session after
`agents browser stop` and after a daemon restart. The preview pane then shows
the same digest as `agents sessions` (prompt, changes, tests, last response),
followed by that task's captures newest-first with filename/age/size.

A row shows **unresolved** when it recorded an identity this machine cannot
index (a rotated or peer-owned session), and **unlinked** when no identity was
recorded at all — captures taken before this shipped, whose identity was
discarded at stop and cannot be recovered. Either way the captures are still
listed and openable. Downloads sit in their own row, separate from any task.

The DB row is **metadata only** — task, profile, identity, timing, and the
capture directory path. The screenshots, PDFs and recordings themselves stay on
disk under `~/.agents/.cache/browser/<profile>/sessions/<task>/`; nothing copies
them into the database, and the listing counts captures by reading that
directory rather than trusting a stored tally.

**Known gap — `--device` drives record no session.** `agents browser start --device
<device>` runs the CLI on the remote box, and the SSH dispatch forwards only
`AGENTS_ACTOR*` and `AGENT_TERMINAL_ID` — not `AGENT_SESSION_ID`. A task started
that way therefore records no session and lists as `unlinked`. Local drives are
unaffected. Forwarding session identity across the SSH hop is tracked on
RUSH-2549 and is not fixed here. Search matches task name, profile, the
linked session's agent/topic, or an artifact filename; `enter` opens the
highlighted capture directly (or drills into a capture list first when a task
holds more than one). `--no-interactive` prints the flat per-artifact table
instead — the stable, scriptable surface `--json` also uses.

## Profile Schema

Profiles are stored in the `browser:` map of each declaring machine's
`~/.agents/devices/<machine>/agents.yaml`. The fleet registry is the read-time
union of those files. Use `agents browser profiles show <name> --json` to
inspect the full config, or `agents browser profiles list --json` to see which
devices declare each name.
The fields map to:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Lowercase alphanumeric with hyphens |
| `browser` | string | `chrome`, `comet`, `chromium`, `brave`, `edge`, `arc`, or `custom` (`arc` attaches to your running Arc — see [Arc](#arc-attach-to-your-running-window)) |
| `endpoints` | string[] or map | CDP URLs: `cdp://host:port`, `ssh://host?port=N`, or `wss://...` |
| `defaultEndpoint` | string | Key into `endpoints` map to use by default |
| `binary` | string | Absolute path; required for `browser: custom` |
| `electron` | boolean | Suppress `Target.createTarget`; bind to visible window |
| `targetFilter` | string | `url:<substring>` or `title:<substring>` for Electron window selection |
| `description` | string | Human-readable label |
| `secrets` | string | Secrets bundle name to inject at browser start |
| `chrome.headless` | boolean | Run headless |
| `viewport` | `{width, height, x?, y?}` | Initial window size in CSS pixels |
| `logDir` | string | Local path to source-side JSONL logs |
| `logHost` | string | SSH host where `logDir` lives |

## Recipes

### 1. Create a profile and log in manually

```bash
# Create the profile (auto-assigns a free port)
agents browser profiles create work --browser chrome

# Start a session and open the app
export AGENTS_BROWSER_TASK=$(agents browser start --profile work --url https://app.example.com)

# Complete the login in the browser window that opens.
# Then verify onboarding is done:
agents browser profiles doctor work

# On future runs, cookies are already there.
```

Logins persist across browser restarts, including sites that issue
memory-only session cookies (`expires=-1`, e.g. idealista): each launch pins
`session.restore_on_startup: 1` in the profile's Preferences, which stops
Chromium purging session cookies at startup, while `--no-startup-window`
keeps the visible side of session restore from ever happening — no tabs from
a previous task reopen. The only logouts left are server-side session
expiries, which no client can prevent.

### 2. Screenshot a logged-in page

```bash
export AGENTS_BROWSER_TASK=$(agents browser start --profile work --url https://dashboard.example.com)
# Wait for the page to load, then capture:
agents browser wait --state networkidle
P=$(agents browser screenshot)
# P is the path to the saved JPEG; pass it to your vision model.
agents browser done
```

### 3. Extract data with evaluate

```bash
export AGENTS_BROWSER_TASK=$(agents browser start --profile work --url https://app.example.com/orders)
agents browser wait --selector "table.orders"
agents browser evaluate --expression "
  Array.from(document.querySelectorAll('table.orders tr')).map(r =>
    Array.from(r.querySelectorAll('td')).map(c => c.innerText)
  )
"
agents browser done
```

### 4. Drive an Electron app (e.g. Slack)

```bash
# Create the profile once
agents browser profiles create slack \
  --browser custom \
  --binary "/Applications/Slack.app/Contents/MacOS/Slack" \
  --electron

# Then use it exactly like a web profile
export AGENTS_BROWSER_TASK=$(agents browser start --profile slack)
agents browser screenshot
agents browser refs
agents browser click 7
agents browser done
```

### 5. Attach to a remote Chrome via SSH

```bash
# The profile stores the SSH endpoint; the daemon opens the tunnel at start time
agents browser profiles create staging \
  --browser chrome \
  --endpoint "ssh://deploy@staging.example.com?port=9222"

export AGENTS_BROWSER_TASK=$(agents browser start --profile staging)
agents browser navigate --url https://internal.staging.example.com
agents browser screenshot
agents browser done
```

## Demo

<video autoplay loop muted playsinline width="100%" src="../assets/videos/browser.mp4"></video>

## See also

- [docs/pty.md](pty.md) — drive REPLs and TUI programs from an agent; part of the automation triad
- [docs/computer.md](computer.md) — drive native macOS apps via Accessibility; part of the automation triad
- [docs/concepts.md](concepts.md) — DotAgents repos, resource resolution model
