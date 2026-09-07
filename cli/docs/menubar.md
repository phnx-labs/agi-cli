<!-- guide -->
# Menu bar

A macOS status-bar item that surfaces live agent activity on the machine.

## Overview

The menu bar helper (`MenubarHelper.app`) is a no-Dock, `.accessory` status-bar
app. Its icon — the agents-cli `a` mark — sits in the menu bar and answers, at a
glance, "what are my agents doing right now, and does anything need me?"

The bundle folder keeps its historical name (`MenubarHelper.app`), but the
compiled executable inside it is **"AGI Menu"** (RUSH-3101) — that is what
System Settings > Privacy & Security > Accessibility and the "would like to
control this computer" prompt show, since launchd execs it directly and
bypasses LaunchServices name resolution.

It keeps menu state warm with one read-only `agents menubar snapshot --json`
subprocess every three minutes. That command reads indexed/cache state and never
re-indexes transcripts. Opening the menu uses the warm result; CLI actions remain
explicit controls (starting a session, running a routine).

The snapshot carries the same rows and lifecycle status as
`agents sessions --active --local --json`. After the warm snapshot loads, the
menu does not infer status again from terminal registries or attention files;
those cheap files are used only during cold start. The ACTIVE section therefore
uses the CLI words `working`, `waiting`, `idle`, `orphan`, `abandoned`, and
`unknown`, and routine sessions carry `routine:<name>` when the indexed name is
available.

**Bare-active parity (RUSH-2336).** The snapshot applies the CLI's canonical
`isRunningLiveSession` selector before it ever reaches the menu: a `queued`
(dispatched, not started), `closed`, or `crashed` row the live registry retains
for `--queued`/`--closed`/`--crashed` recovery never shows in the ACTIVE
section, and a real OS process row (terminal/tmux/headless/team) surfaces only
once it is positively located — a known `machine`, a positive `pid`, AND
verified liveness (`pidAlive === true`, not merely "not known dead"). A cloud
row surfaces on the provider's own word (`cloudProvider` + `cloudTaskId`)
instead. Every session's detail submenu (the "Where" section) shows the exact
handle behind the row — `machine:pid` for a process, `provider · taskId` for
cloud — the same locator the CLI's own `--active` row renders. Because the raw
cache the daemon warm-tick writes is never filtered at write time and does not
stamp `machine` on a local row (unlike the CLI's own local gather), the
snapshot self-stamps this machine's id before filtering — see
`computeMenubarSnapshot` in `src/lib/menubar/snapshot.ts`.

**Header shows the installed version (RUSH-2688).** The dropdown's top row reads
`agents-cli <version>` — the version `agents --version` prints, carried on the
snapshot (`cliVersion`) and resolved at runtime, not compiled into the helper. A
helper that outlived an `agents` upgrade therefore shows the older version at a
glance. Until the first snapshot lands (and against a CLI too old to emit the
field) the row falls back to the bare `agents-cli`.

**Project grouping never leaks the harness or a machine (RUSH-2688).** The ACTIVE
section groups by project: a real working dir → its repo (worktree-aware, so a
`.agents/worktrees/<slug>` session groups under the enclosing repo). A session
with **no local cwd** — a cloud task — groups under its own repo when the provider
names one (reduced to the bare name, so a cloud task for `phnx-labs/agents-cli`
lands with local `agents-cli` work), else the explicit **`cloud`** bucket. It
never borrows the harness/provider name (`codex`) or a machine name as a group —
neither is a project. The one derivation is `activeSessionProjectKey`
(`src/commands/sessions.ts`) for the serialized rows and `LocalState.groupKey`
for the menu's cold-start reads.

macOS only. It is auto-enabled for every user (see [Lifecycle](#lifecycle)); opt
out with `agents menubar disable`.

## Clip paste (`Cmd-Shift-V`)

`Cmd-Shift-V` hands whatever is on the clipboard to the agent in the focused
terminal as a native scp-style reference — `<host>:<abs-path>` — instead of
pasting raw bytes that would mangle a terminal or an ssh'd session. A screenshot
that lives only on the clipboard is written to
`~/.agents/.history/attachments/`, a copied file is snapshotted there under an
scp-safe name, and a copied directory is referenced in place. The agent reads
the path directly when `host` is its own machine and `scp`s it otherwise, so the
same token works whether the session is local or on another box.

The paste synthesizes a `Cmd-V` keystroke, which needs an **Accessibility**
grant for "Agents Menu Bar" (System Settings > Privacy & Security >
Accessibility). Without it the helper copies the reference to the clipboard and
notifies you to paste it yourself, so the clip is never lost.

### Do not hand-launch the helper

TCC grants are keyed to a code identity, and `RegisterEventHotKey` is
first-come. A helper started **from an ssh session** therefore breaks the paste
twice over: macOS attributes its Accessibility request to the responsible
process, `/usr/libexec/sshd-keygen-wrapper`, so the prompt names a process whose
grant does nothing for the helper — and granting it would let anything an ssh
session spawns synthesize keystrokes — and, if it wins the chord, Cmd-Shift-V
stops reaching the launchd-managed helper that *is* trusted. Which of the two
wins comes down to which registered the chord first, so the outcome is
arbitrary.

The interactive mode refuses to start in that situation, and refuses
unrecognized arguments (an unknown flag used to fall through to the status-bar
app, leaving a permanent second helper). Start it through launchd instead:

```bash
agents menubar enable      # works over ssh — launchd starts it in the GUI session
```

If a chord stops working, `agents menubar status` lists any other live helper
process with its pid; end it and re-run `agents menubar enable`.

## Quick dispatch

`Cmd-Shift-O` opens the Spotlight-style capture panel. Type a short request,
optionally attach screenshots (from the strip, `Cmd-V`, or a drop), pick the
project to work in, then pick one agent for **Plan** or one or more agents for
**Run**. The helper constructs this panel at startup and orders it front with the
text field focused before loading projects, decoding thumbnails, or reading the
Linear cache. Those rows hydrate after the panel accepts typing; the hotkey never
waits for `agents projects list`, attachment-directory scans, or image decode.

- **Plan** sends the note and selected screenshots to the selected ticket agent,
  which investigates and returns ticket fields as JSON. The helper then runs
  `linear create` itself, appending `--image <path>` for every selected
  screenshot so the image bytes are uploaded at create time and embedded in the
  issue description — screenshot paths never pass through an LLM-authored shell
  string.
- The helper resolves the standalone `linear` executable before dispatching the
  ticket agent. It prefers `~/.local/bin/linear`, then checks standard Homebrew
  locations and the inherited `PATH`. A missing or non-executable CLI stops
  immediately with the install path instead of reporting a generic create
  failure after the agent has run.
- **Run** fans out to every selected agent with `agents run <agent> --mode auto
  --balanced --notify --name <slug-of-your-note>`, so the resulting sessions
  appear in normal `agents sessions` and menu-bar surfaces instead of as opaque
  background work.

### Picking where it runs

The **project** dropdown lists every `agents projects` definition, by name, with a
type-ahead **filter** beside it and the checkout root as each row's tooltip. Name
is the identity, not root: `prix` and `rush` both point at the same monorepo and
differ only by `defaultPath`, so a root-keyed list would silently collapse them
into one row. Dispatch passes `--project <name>`, which lets the CLI resolve the
project's own base path and bind its sibling repos
(`resolveProjectDirs`, `src/lib/project-root.ts`) — something a bare `--cwd`
cannot express. The last pick is remembered
(`menubar.quickDispatch.lastProject`).

Recent session working directories are still read, but only to **narrow** the
chosen project: the second dropdown offers the worktrees and subdirectories inside
it that you have actually been in, and picking one dispatches with `--cwd <dir>`
instead (no project name addresses a worktree). `$HOME` is never offered —
running an agent straight in the home directory is too broad a permission surface.

The list comes from `agents projects list --json`, memoized for 10 minutes and
persisted at `~/.agents/.history/menubar/projects.json`, refreshed on the same
tick as the menu-bar snapshot. A cold cache fetches on the first summon rather
than waiting up to three minutes for that tick.

**With no projects defined at all**, the palette degrades to the recent session
cwds this dropdown used to offer, and dispatches with `--cwd`. `agents projects`
is a separate, opt-in resource, so a box that has never run `agents projects add`
would otherwise have no scope to offer. With **neither** a project nor a recent
directory, the palette **refuses to dispatch** and says
`no project — agents projects add <name>` rather than running the agent
unscoped: `agents run` with no `--project`/`--cwd` inherits the spawning process's
working directory, and launchd starts this helper with none, so the agent would
land at `/` — broader than the `$HOME` this picker has always refused to offer.

This replaced a dropdown of the last eight session cwds (PHNX-4001), which could
not name a project you had not worked in recently, listed worktrees as if they
were projects, and carried no Linear binding to scope tickets by.

### Pin

The palette dismisses itself when another app takes focus. **Pin** it — the header
button, or press `Cmd-Shift-O` again while it is already focused — and it stays
put, keeping `.floating` level and joining all Spaces, so you can go copy
something and come back to the note you were typing. The pin is persisted
(`menubar.quickDispatch.pinned`). `Esc` still dismisses and keeps the draft.

### Screenshots: live, pasted, dropped

The thumbnail strip is **live**. FSEvents watches the real screenshot
directories — the system `screencapture` location, CleanShot X's export path, and
the clip attachments dir (`AgentsCLI.screenshotSourceDirs()`) — for as long as the
palette is visible, so a shot taken *while* the palette is open appears in about a
second with no re-summon. A closed palette watches nothing. This was a 30-second
freshness guard shared with the Linear cache parse, which meant the shot you had
just taken to describe a bug was not there when you looked (PHNX-4001); the guard
now applies to the Linear read alone.

`Cmd-V` with an image on the clipboard attaches it instead of pasting text, and
image files dropped anywhere on the panel do the same. Both go through one reader
(`AgentsCLI.imageAttachments(from:)`), which writes PNG bytes into the durable
attachments dir as `<yyyyMMdd-HHmmss>-<6hex>.png` — copied, never referenced in
place, because a shot on the Desktop can be swept away before the agent reads it.
A pasteboard with no image falls through to an ordinary text paste.

Clicking a thumbnail attaches or detaches it; `Backspace` on a focused one removes
it; double-click opens the full image. The newest shot is pre-selected when it is
under ten minutes old, and the hint line reports the attached count.

Attachments reach the agent as `<host>:<abs-path>` references — the same token
`Cmd-Shift-V` types into a terminal — so an agent on this box reads the path and
one dispatched to another device `scp`s it. A bare absolute path could only ever
be read locally.

`--notify` is what makes a dispatch report back. The run is launched **detached**
and posts its own "finished"/"failed" notification when it ends (see
[Notifications](#notifications)). Earlier the helper monitored the child and
posted from the process-termination callback — which lived in the helper, so a
helper that restarted mid-run (an upgrade replacing the bundle, a crash) took the
callback with it. The run carried on, reparented to launchd, and could never
report back. Nothing about the menu bar's lifetime affects the notice now.

Set `AGENTS_QUICK_DISPATCH_ROSTER=claude,codex` in the helper environment to
filter which agents appear in the picker, and
`AGENTS_QUICK_DISPATCH_AGENTS=claude,codex` to change which visible agents are
preselected. Without a roster override, the picker uses the same roster as the
menu bar's New Session submenu.

If another app steals focus while you are typing, the panel hides but keeps the
draft note plus the selected screenshots, action, and agents for the next
`Cmd-Shift-O` summon. Return submits and clears the draft; Escape clears it
without dispatching.

### The ticket list

The panel captures new work; the rows under it are the work that already exists —
the open Linear tickets of the project you picked, so you can pick one up instead
of filing a duplicate. The section starts **folded**; `Cmd-T` toggles it and the
choice is remembered (`menubar.quickDispatch.ticketsExpanded`).

Controls sit on **one compact row** of popups (same language as the project row —
not a chip grid or two-column block):

```
Tickets  [Agents CLI ▾]  [All open ▾]  [Urgent first ▾]  12/58 · urgent first · ⌘N
 ⌘1  P1  RUSH-1968  Doing  …
 ⌘2  …                                    ← scroll when there are more rows
```

- **The scope comes from the project's Linear BINDING.** Switching the project
  dropdown selects the Linear project that project is bound to — the `linear:`
  block in its `agents projects` definition, which `agents projects link <name>
  --linear` writes. There is no folder-name matching: the previous version reduced
  a repo directory name and a Linear project name to lowercase alphanumerics and
  compared them, so `agents-cli` found "Agents CLI" by luck of spelling while `agi`
  (bound to Linear **AGI**) found nothing, and `prix` vs `rush` could not be told
  apart at all (PHNX-4001). A project with **no** binding reads
  `No Linear project bound · agents projects link <name> --linear` rather than
  showing an empty list that looks like "no open tickets". An explicit pick in the
  Linear popup still overrides the binding and is remembered per project
  (`menubar.quickDispatch.project.<name>`).
- **Quick filter (dropdown).** One popup, not chips: All open · Todo · Doing ·
  Backlog · P1 only · P2 only · Overdue. The last pick is remembered.
- **Quick sort (dropdown).** Flat list only — no status group headers. Options:
  Urgent first (default: Linear priority, then overdue, then in progress, then
  newest) · Newest · Oldest · Due date · Priority. The last pick is remembered.
- **Scrollable rows.** The list viewport shows about five rows; more matches
  scroll inside the bar so the capture field stays put. Up to 40 rows are kept
  after filter+sort.
- **Typing also filters.** Every word you type has to appear in a row's
  identifier or title (AND with the filter), so an existing ticket surfaces
  before Return files a new one.
- **Click a row to dispatch it** to the selected agents in the picked project
  (`⌘1` … `⌘9` for the first nine listed). **Plan** posts an implementation plan
  as a comment on the ticket and changes no code; **Run** claims the ticket
  (moving it to whichever state `linear states` reports as `started`), implements
  it per the repo's `AGENTS.md`, and comments the result. Both are the same
  headless `agents run --mode auto --balanced --notify` dispatch as a quick Run,
  named after the ticket (`rush-2098`, `rush-2098-plan`) so it reads as that
  ticket in `agents sessions`. **`⌘`-click** opens the ticket in Linear instead.

A `linear tasks` round trip costs seconds, so the list renders from a warm cache
(`~/.agents/.history/menubar/linear-cache.json`) and refreshes in the background;
entries older than 90 seconds are re-fetched on the next summon.

## The dropdown

One rule shapes the menu: **attention floats up, context groups down.**

```
 a !                      icon + badge (red ! = needs you, green N = N running)
 ┌─ agents ──────────────────────────────────────┐
 │ ⚠ NEEDS YOU (3)                               │   triage strip: wait-time sorted
 │   ⚠ Claude · api — Apply rename?    ·  2h 25m ›│   across ALL projects, question
 │   ⚠ Claude · web — awaiting input   ·  3m     ›│   + how long it's waited
 │   ✕ 2 routines failing                        ›│
 ├────────────────────────────────────────────────┤
 │ New Task…                                  ⌘T │   opens the quick-dispatch bar
 │ New Session                                ⌘N │   submenu: one entry per agent
 ├────────────────────────────────────────────────┤
 │ ACTIVE · 3 run · 1 idle · 2 projects          │   projects collapsed by default
│   ▶ agents-cli  ●2 working ○1 idle  zion      │   accordion: ▶ folds agents open
│   ▼ web  ●1 working  zion                     │
 │     ● Codex · zion · 12m  ⌥ PR#42 — title   › │   › side submenu = full detail
 ├────────────────────────────────────────────────┤
 │ ROUTINES · 16 · next 7:00 PM · 2 paused       │   next few upcoming + failing
 │   ◔ triage-tickets  in 22m                  ›  │   inline; All routines… for
 │   ✕ crm-brief  failed                       ›  │   the rest
 │   All routines…                             ›  │
 ├────────────────────────────────────────────────┤
 │ RECENT TICKETS / RECENT                       │   dedicated, glanceable
 ├────────────────────────────────────────────────┤
 │ ◆ NEW DEVICES (2)                             │   pending tailnet nodes to approve
 │   ◆ ci-runner-fsn1 · linux                  ›  │   Register / Ignore
 ├────────────────────────────────────────────────┤
 │ ▶ DEVICES (12)                                │   full fleet roster, folded by default
 │   ◉ zion (this Mac) · macos · 14%           ›  │   ◉ = interactive host; load% when known
 ├────────────────────────────────────────────────┤
 │ System    2 critical · 1 warning · auto-nudge off ›│  doctor findings + watchdog
 ├────────────────────────────────────────────────┤
 │ Stop scheduler · Settings · Quit          ⌘Q  │
 └────────────────────────────────────────────────┘
```

- **⚠ NEEDS YOU** — the triage strip, pinned on top and never nested in a project
  group. Blocked sessions are grouped by (agent, repo): a group of 1 renders
  inline with the actual question it's waiting on (or bare when the Notification
  hook wrote no message); a group of 2+ collapses to one
  `<Agent> · <repo> · N waiting · oldest <elapsed> ›` row with a submenu that
  lists each session (oldest first). Groups themselves sort by their oldest
  wait. Failed / overdue routines and a stopped scheduler append here. Empty
  when nothing needs attention.
- **New Task…** — opens the quick-dispatch bar (the same panel as `Cmd-Shift-O`):
  type the task, pick agents and a repo, and it runs headless. One panel serves
  both entry points, so an interrupted capture is restored whichever way you come
  back to it. Use this when you want work *done*; use New Session when you want
  to sit in the TUI.
- **New Session** — shells `agents run <agent> --terminal`, which opens the agent
  in **the terminal you actually work in**. The CLI resolves that from your live
  sessions' host app (`agents sessions --active` → `host`), so a Ghostty user gets
  a Ghostty tab and an iTerm user an iTerm tab; Terminal.app is the fallback when
  nothing running names a terminal the engine can drive. See
  [terminal-engine.md → Choosing a terminal](terminal-engine.md#choosing-a-terminal-for-a-gui-caller).
  (It used to always open Terminal.app.)
- **ACTIVE** — **project accordion** + **session detail submenu**. Projects are
  **collapsed by default** as a status strip
  (`▶ agents-cli  ●8 working ◐1 waiting ○1 idle  zion`).
  Click `▶`/`▼` to fold the project open **inline** and list its agents.
  The project header is an embedded menu control, so expanding or collapsing
  mutates only that project's rows inside the current menu tracking session; it
  does not dismiss and synthetically reopen the dropdown.
  Focusing an agent row opens a **side submenu (›)** whose first item is
  **▶ Focus session** — it lands you in that session, attaching locally or SSHing
  to the box that owns it (`agents sessions focus`, the same call the ext's Focus
  button makes), so it works for a session here or on any fleet peer. Below it,
  richer detail and **linkable actions**: work title (and open URL if the title
  contains one), local/remote + surface, clickable cwd, Linear ticket, GitHub PR,
  duration, copy session id, optional preview snippet. Chips on the agent row
  itself (`🎫 RUSH-…`, `⌥ PR#N`) surface links at a glance. All of that comes from
  the warm `sessions --active --local` cache; expand never shells the CLI or
  re-indexes transcripts. Work titles prefer the session `topic` over a bare
  agent name.
- **ROUTINES** — kept glanceable: the next few upcoming plus any failed, timed-out,
  or overdue routine inline. Each submenu leads with a **last-run line** — a live
  `● running now · started 4m ago` when a run is in flight (server-verified, not a
  stale flag), else the last outcome (`✓ completed · ran 45s · 2h ago`,
  `✕ failed exit 1 · yesterday`, `⦸ missed`) — then the failure reason when there
  is one, then the next fire, above Run now / Pause / Logs. An **overdue** routine
  is tagged `⚠ overdue` on that line even when its previous run succeeded (overdue
  is independent of the last outcome — the daemon missed the next fire), so the
  submenu never contradicts the `overdue` flag shown up in NEEDS YOU. Logs opens
  the concise routine summary in a text viewer. All of it is read from the routine
  fields the snapshot already carries
  (`lastStatus`/`exitCode`/`overdue`/`lastRunStartedAt`/`CompletedAt`), so opening
  a submenu never shells a fresh fetch.
  When routines carry a `projectGroup` field (from `agents routines list --json`),
  both the inline rows and the "All routines…" submenu are grouped by that label.
  Routines with no `projectGroup` (cross-project or unassigned) appear last,
  ungrouped.
- **RECENT TICKETS / RECENT** — tickets filed via quick dispatch and recent
  sessions, unchanged dedicated sections.
- **NEW DEVICES** — newly-discovered tailnet nodes awaiting approval, each with a
  Register / Ignore submenu. Shown only when there are pending nodes, and it now
  sits just above the DEVICES roster at the bottom (previously it floated up under
  NEEDS YOU). Sentinels under `~/.agents/.cache/state/devices-pending/` are
  written by the daemon device-probe; the writer re-subtracts both the ignore-list
  and the registered roster so already-known or dismissed boxes never appear here
  (and soft-fail probe ticks still prune them).
- **DEVICES** — the full registered-fleet roster as **one collapsible block,
  folded by default** (the fleet is long, so `▶ DEVICES (N)` stays out of the way
  until you open it — same in-place accordion as ACTIVE, no CLI on toggle). Each
  row is `<name> · <platform>` — this Mac first, then alphabetical — with live
  **load%** merged in when the daemon-warmed fleet cache has a fresh reading; a
  row with no number is simply un-probed, never labelled offline (the roster
  carries no online/offline state, so the menu never claims one). `◉` marks the
  configured interactive host. The `›` submenu shows load/mem when known and a
  **Copy `agents ssh <name>`** action. The roster comes from the same 3-minute
  `menubar snapshot --json` poll (a cheap local registry read), not a new timer.
- **System** — setup health + the auto-nudge watchdog collapsed into one row.
  The health half of the summary is the doctor findings count, `N critical ·
  M warnings` (bare `all set` when there are none), sourced from `agents doctor
  --json`'s `findings` field on the 15-minute poll (`DoctorHealth.summary`,
  [`Models.swift`](../menubar/Sources/MenubarHelper/Models.swift)); it's
  followed by `auto-nudge on/off` from the watchdog toggle. The submenu lists
  up to 5 findings, in the order doctor emits them (already prioritized), each
  as two lines: `<severity> · <device> · <agent> @<version>` (or
  `<agent> (N versions)` when a finding collapses several versions) then
  `<message> → <remediation>` truncated to 96 chars. A
  `+N more — run \`agents doctor\`` row appears when more than 5 findings are
  actionable. **Legacy fallback (RUSH-2382):** an installed CLI older than the
  `findings` field returns `findings: null`, not an empty list — the menu bar
  then falls back to the pre-findings behavior: the summary counts
  not-installed / stale / never-synced agents (or `all set`), and the submenu
  lists "Not installed" / "Resources" sections instead of findings rows. Either
  way the submenu ends with Run agents doctor, Open ~/.agents, and the
  auto-nudge toggle.

The icon badges **red `!`** when anything needs you, **red `⏻`** when the
scheduler has been unreachable for ~30s (see
[Daemon-down watchdog](#daemon-down-watchdog) below — independent of the
dropdown ever opening), and **green with a count** when sessions are running;
otherwise it is the bare mark.

## Commands

```
agents menubar            # status (also: agents menubar status)
agents menubar setup      # configure end-to-end: one instance, started at login
agents menubar enable     # install + start the launchd login service
agents menubar disable    # stop + remove it (sticky opt-out)
agents menubar status     # installed / running, versions, staleness; --json
agents menubar doctor     # read-only: signing identity, stale-process check; --json
```

`setup` is the command to reach for when the menu bar is wrong — a duplicate
icon, a helper that did not come up, a machine that was never configured. It is
idempotent, and each concern is a reported step, so a partial failure names
itself instead of hiding behind "enabled":

```
$ agents menubar setup
Menu bar setup

  + duplicates      ended 2 running helpers (93048, 97417) — launchd restarts exactly one
  ✓ bundle          /Users/me/Library/Application Support/agents-cli/MenubarHelper.app (1.20.89)
  ✓ signature       valid
  ✓ login item      com.phnx-labs.agents-menubar — starts at login, restarts if it dies
  ✓ single instance pid 98566

Menu bar configured.  One agents mark, started at login.
```

It ends **every** live helper and lets launchd restart one, so the survivor is
always the login-managed copy — picking a survivor out of a process list cannot
guarantee that, and keeping the un-managed copy would re-create the duplicate at
the next login. It also clears a previous `agents menubar disable`, and exits
nonzero if it cannot reach the one-instance end state. `--check` reports the
current state without changing anything; `--json` emits the step list.

`status` reports the installed bundle version vs. the current CLI version and
whether the install is stale (see [Lifecycle](#lifecycle)). Live helper processes
are split two ways in `--json`: `instances` are copies of the **installed
bundle**, identified by resolved executable, and `foreignInstances` is every
other `"AGI Menu"` process. **More than one entry in `instances` is the
duplicate menu-bar icon** — see [One instance, always](#one-instance-always).
`RegisterEventHotKey` is first-come, so a second copy may be the one holding the
global chords — which of the two won is not answerable from a process list, so
status reports the conflict rather than a winner. See
[Do not hand-launch the helper](#do-not-hand-launch-the-helper).

`doctor` is read-only — it never installs, restarts, or resets anything.
It answers "why did Accessibility ask again after an update": the installed
bundle's signing identity (`ad-hoc` re-prompts on every update; `Developer ID`
is update-stable since 6fa36f73a), and whether a live helper pid started
**before** the installed bundle's on-disk mtime — the stale-process case where
the upgrade self-heal swapped the bundle but the running process is still the
binary that predates it. `agents menubar setup` is the fix for anything it
flags.

## One instance, always

The helper refuses to be the second status item. At launch it takes an
`flock(2)` on `~/.agents/.cache/state/menubar.lock` and holds the descriptor for
its whole life; a helper that cannot take the lock posts a distributed
notification that pops the **running** helper's menu open, then exits 0:

```
$ "…/MenubarHelper.app/Contents/MacOS/AGI Menu"
AGI Menu: already running (pid 6815) — surfaced it instead of adding a second status item.
```

Re-launching a menu-bar app means "show me the one I already have", so
surfacing the incumbent is the answer, and exiting 0 keeps launchd's `KeepAlive`
from reading the surrender as a crash.

An `flock` rather than a pid file: a helper `SIGKILL`ed by the code-signing
monitor leaves its pid behind, and every later launch would then read a stale
"already running" and never start. The kernel releases an `flock` when the holder
dies however it dies, so the state cannot go stale.

Two copies of the installed bundle used to be reachable through ordinary paths —
launchd's `KeepAlive` service plus a LaunchServices/`open` launch of the same
`.app` (a Finder open, a re-open after a crash, a second `agents menubar
enable`). Both ran the same executable, so status collapsed them to a healthy
`running: yes` while the user looked at two agents marks. Both halves are fixed:
the helper can no longer become the second, and `status` now lists every copy.

## Data sources

The helper assembles the menu from these cached/indexed sources through one snapshot
command every three minutes; the 10-second badge/liveness checks stay local:

| Source | Path | Gives |
|---|---|---|
| Terminals | `~/.agents/.cache/terminals/live-terminals.json` | extension-registered terminals (agent, cwd, pid, label) — cold start + 10s badge poll |
| Menu snapshot | `agents menubar snapshot --json` every three minutes | routines, 40 indexed recent sessions, daemon-warmed local active sessions with the exact `sessions --active` lifecycle status, the registered fleet-device roster (a cheap local registry read), and persisted watchdog status in one subprocess |
| Doctor | `agents doctor --json` every 15 minutes | install and configuration health; kept separate because it is substantially heavier |
| Teams | `~/.agents/.history/teams/agents/<id>/meta.json` | running teammate agents |
| Cloud | `~/.agents/.cache/cloud/tasks.db` (SQLite) | cloud tasks, incl. `input_required` or `needs_review` → "awaiting input" |
| Attention sentinels | `~/.agents/.cache/state/attention/<sessionId>` | terminal sessions awaiting input — mtime = wait start, content = the awaiting message (written by the Notification hook). On read, sentinels whose sessionId is not in the current live-terminals set are unlinked as orphans (defense against sessions killed hard, hookless Claude versions, or sessionId mismatches). |
| Installed agents | `~/.agents/.history/versions/<agent>/` | the agent roster |
| Projects | `agents projects list --json` (memoized 10 min, persisted) | the palette's project dropdown, its Linear binding, and `--project <name>` on dispatch |
| Linear tickets | `linear projects` / `linear tasks --all --project <p> --status open --cycle all` (warm cache, 90s TTL) | the quick-dispatch ticket list, scoped by the picked project's Linear binding |

Liveness is a `kill(pid, 0)` check; running-vs-idle is the transcript file's
mtime. The teams directory accumulates history, so the periodic badge refresh
skips it — the full teams scan runs only when the menu opens.

### Live feed + artifact index (PHNX-4002)

The dispatch-and-inbox surfaces (the Sessions window, the dropdown, the dispatch
form) do not poll the snapshot command per row. Instead a single long-lived data
layer projects the fleet:

- **`FeedStream`** owns exactly one `agents feed watch --json` child (no
  `--local`), spawned through `ChildProcess` so it is group-killed on quit and
  reaped by the next launch if the helper dies — the same durable-registry
  treatment the bounded pollers get. It parses NDJSON off the main thread into a
  pure reducer (`FeedState`, `FeedModels.swift`): `rows` (keyed by rowKey),
  `attention` (keyed by sessionId), per-device `deviceHeartbeat`, and
  `StreamHealth`. Each device's `reset` replaces only that device's slice; a
  `sequence` gap or a new `streamId` (a respawned coordinator) drops all rows and
  rebuilds from the next `reset`. Backoff is 1s doubling to 30s with a circuit
  breaker after 10 consecutive failures; a silent stream (no line for 45s) reads
  stale and (120s) restarts the child. It is a projection only — it never
  schedules a fleet-affecting action (spec SING-2). Observers get a
  `Diff { upserted, removed, attentionChanged }` on the main queue.
- **`ArtifactIndex`** joins the `~/.agents/artifacts/<date>/<slug>/.artifact.json`
  sidecars and the `~/.agents/artifact-history/<id>/manifest.json` render ledger
  into `artifacts(forSession:)` (matches a full UUID or an 8-char prefix) and a
  `recent` list, scanned once on a background queue and refreshed via FSEvents on
  both roots.

Both are headless-testable: `MENUBAR_FEED_TEST=1` replays a fixture NDJSON and
asserts row counts, attention keys, reset-on-gap, backoff, and the breaker;
`MENUBAR_ARTIFACT_TEST=1` scans a fixture tree and asserts the session map. Both
run in `scripts/test-menubar.sh` (a `build.sh` gate). `MENUBAR_FEED_SMOKE=1` runs
the real stream for 60s and prints row/attention/device counts + health — a live
check, not a gate, like `MENUBAR_DUMP`.

## Lifecycle

The helper is a launchd user service (`com.phnx-labs.agents-menubar`,
`RunAtLoad` + `KeepAlive`), installed to
`~/Library/Application Support/agents-cli/MenubarHelper.app`.

- **Auto-enable.** On every macOS CLI invocation a cheap self-heal installs the
  service if it is missing — so a fresh install brings the icon up without a
  manual step.
- **Upgrade refresh.** The installed bundle is stamped with the CLI version. When
  a newer release ships a newer helper (or the installed copy goes missing), the
  self-heal re-copies the bundle, rewrites the plist, and restarts it — so
  `npm update` actually moves users onto the new helper instead of leaving the
  old one running. `launchctl kickstart -k` against the GUI domain does not
  resolve from a shell with no Aqua session (an ordinary terminal/tmux/ssh
  invocation of `agents`), so a real content swap (a version bump, or the
  ad-hoc -> Developer ID identity migration below) falls back to ending the
  live helper pid directly — launchd's `KeepAlive` relaunches it from the
  swapped binary. Without this, a running helper could keep requesting
  Accessibility under the OLD code identity after an update, and the grant
  never stuck (RUSH-3019). A plist-only interpreter repoint (same version,
  same identity — RUSH-3005) does not trigger a restart on top of its own.
- **Ad-hoc -> Developer ID identity migration.** A machine whose install
  predates Developer ID signing (6fa36f73a) gets its bundle re-signed on the
  next heal; TCC keys the Accessibility grant to the signing identity, so the
  old ad-hoc grant is dead weight the user never sees removed. The heal runs
  `tccutil reset Accessibility com.phnx-labs.agents-menubar` exactly once per
  machine (stamped in `.menubar-tcc-migrated`, next to `.menubar-version`),
  clearing the stale row so the fresh Developer-ID prompt is a clean grant
  rather than a re-prompt fighting old TCC state.
- **One owner, when several installs coexist.** The helper lives at one path, but
  every agents-cli copy on the box runs the self-heal. The plist's `AGENTS_ENTRY`
  records the owner, and only the owner re-copies the bundle freely — otherwise
  each copy reads the others' marks as drift and reinstalls over them, killing the
  running helper every few seconds (#2109). A same-install `npm update` keeps its
  entry path, so upgrades are unaffected. Another install still gets there:
  immediately if the recorded owner is gone from disk, otherwise at most once an
  hour (`.menubar-last-heal`), and never on that timer if its own bundle is
  ad-hoc/dev-signed — recopying an un-notarized bundle over a good one gets it
  rejected as "damaged". Repairs (missing executable, Developer-ID heal) are never
  gated. `agents menubar setup` bypasses all of this and is the immediate fix.

  Two installs that are *both* invoked regularly will keep trading ownership at
  the cooldown, so the helper restarts about once an hour until one is removed —
  bounded and survivable, but the real fix is a single install.
- **Opt-out is sticky.** `agents menubar disable` writes
  `~/.agents/.cache/state/menubar.disabled`; the auto-enable honors it, so a
  disabled menu bar never silently returns on the next upgrade. Re-enable with
  `agents menubar setup` (or `agents menubar enable`), either of which clears the
  sentinel.
- **Recovery is one command.** When any of the above has gone wrong on a
  machine — never configured, helper down, duplicate icon —
  `agents menubar setup` re-establishes the whole intended state and says which
  parts it had to change.

## Notifications

The helper doubles as the branded desktop-notification channel for the daemon
(RUSH-2030) and for any `agents run --notify`. The caller fires a notification by
spawning the installed bundle in a one-shot mode:

### Daemon-down watchdog

The daemon's own overdue check (`notifyOverdue`, `src/lib/overdue.ts`) can only
ever fire from **inside** `runDaemon()` — so it is structurally blind to the one
outage that matters most: the daemon itself being down, at which point no
routine fires and nothing says so. The menu-bar helper closes that gap because it
is a **separate** launchd `KeepAlive` service — it stays alive exactly when the
daemon dies.

`StatusItemController.tick()` (the same 10s timer that refreshes the badge)
calls `checkDaemonLiveness()` on every fire, independent of whether the dropdown
is ever opened:

- Liveness combines the cheap `AgentsCLI.daemonPid()` probe with the daemon's
  one-minute heartbeat. A PID that remains alive while its heartbeat is stale
  for three daemon ticks is `wedged`, not healthy.
- A debounce of `daemonDownTickThreshold` (3) consecutive unhealthy ticks — about
  30 seconds — must elapse before alerting, so a routine restart (a version
  upgrade, an `agents doctor` self-heal, a crash-relaunch) never pages the user
  for a blip.
- A wedged daemon is restarted once through `agents daemon restart`; the helper
  fails closed when the heartbeat is missing, malformed, or belongs to another
  PID, so ambiguous state never terminates a live process.
- Once past the threshold it fires **one** notification per outage —
  `"Scheduler stopped — routines won't run"` — via `Notifier.post` directly
  (this persistent process's own `NSUserNotificationCenter` delivery, the same
  call site `AgentsCLI.swift`'s ticket-flow notices already use), not a spawned
  `--notify` child process. It also lights the always-visible menu-bar badge
  (`⏻`, ranked just under NEEDS-YOU attention) so the outage is glanceable
  without opening the dropdown at all. Both the notification flag and the badge
  clear the moment the daemon is observed alive again, so the next real outage
  alerts fresh.

The dropdown's own "Scheduler stopped" row (`addNeedsAttention`, rendered only
while the menu is open and only when routines exist) is unchanged and
complementary — the tick-driven watchdog is what makes the outage visible
*before* you think to open the menu.

```bash
"AGI Menu" --notify --title T --body B [--subtitle S] [--action A] [--agent claude]
```

Because the poster is the app bundle, macOS attributes the notification to the
agents-cli helper and shows its `AppIcon` (the agents-cli mark) instead of the
generic osascript icon. The one-shot delivers via `NSUserNotificationCenter`,
briefly spins the runloop so delivery flushes, then exits — it never starts the
status-bar UI. The persistent menu-bar instance registers the click delegate at
launch (`Notifier.wireClickHandler`), so clicking a notification runs its
`--action`: `open:<path>` opens a run report/log, `url:<https…>` opens a web
target (the PR or ticket a finished run produced — `http`/`https` only, so a
notification argument can never become an open-anything primitive), and
`routines:list` opens the runs folder. The Node side lives in
`src/lib/menubar/notify-desktop.ts` (routing), `src/lib/routine-notify.ts`
(routine start/finish content + anti-spam threshold; see
[routines.md](routines.md#desktop-notifications)), and `src/lib/run-notify.ts`
(the `agents run --notify` finish notice).

**Two images: the app on the left, the agent on the right.** macOS draws the
sending bundle's icon on the LEFT of a banner and its `contentImage` on the
RIGHT — the layout a YouTube notification uses for "YouTube" plus the channel's
avatar. The left slot is the agents-cli mark, resolved by LaunchServices from the
installed bundle (`refreshBundleIconRegistration` re-registers it at install, or
that slot renders blank). The right slot is `--agent`: the harness the
notification is *about*, drawn by `AgentAvatar` (`menubar/Sources/MenubarHelper/
AgentAvatar.swift`) as a brand-colored tile with the agent's two-letter mark —
`CL` for claude, `CX` for codex, `GK` for grok. The mark is drawn rather than
shipped as an image set: fifteen bundled logos would be fifteen more binaries to
code-sign each release, and the upstream marks are trademarks agents-cli does not
redistribute. An id with no brand entry falls back to its own initial on the
agents-cli lime, so a harness new to the registry still renders.

Omit `--agent` when no single harness owns the event — a daemon heal, an overdue
sweep, a command routine, a fan-out across several agents. The right slot then
stays empty rather than repeating the left one, which is what it did before
`--agent` existed (`contentImage` was the app icon, so both slots showed the same
lime `a`).

**A run notifies for itself.** `agents run --notify` arms the finish notification
on the run process's own `exit`, so it covers every dispatch path — local spawn,
`--device`, `--lease`, the error path — and, more importantly, does not depend on
whatever launched the run still being alive. That is the whole point: the menu
bar's quick dispatch used to post from its own process-termination callback and
lost it whenever the helper restarted. A run killed with SIGKILL never reaches an
exit handler and so never notifies; that is the documented limit.

**Bounded lifetime (no pile-up).** A one-shot posts and exits in well under a
second, but a stalled delivery — a locked screen, a WindowServer/XPC hiccup —
could otherwise leave a detached notifier hanging and duplicate "Agents"
instances accumulating in the menu bar. Two independent watchdogs bound it:
`runOneShot` arms a background-thread force-exit at 3s (it runs off the main
queue so a wedged main thread can't starve it, unlike the 0.6s runloop deadline
it backs up), and the Node spawner (`spawnDetachedQuiet`) SIGKILLs the child at
4s if it never self-exits. So a notifier can never linger indefinitely. Stale
helpers that predate `--notify` (and would ignore it and hang) are replaced by
the upgrade self-heal (`installMenubarLaunchAgentOnUpgrade`), which reinstalls
the current bundle on any version bump.

### Actionable notifications (PHNX-4004)

A banner is not just a "finished" toast — the ones that need a decision carry the
buttons that answer them. The CLI posts one actionable banner per new attention
item (a session asking a question, a permission prompt, a plan review) and per
finished/failed run, and the companion turns each into a
`UNUserNotificationCenter` category whose action buttons route the operator's
choice back through `agents feed answer`.

The one-shot argv extends the base `--notify` contract with four optional fields:

```bash
"AGI Menu" --notify --title T --body B [--subtitle S] [--action A] [--agent claude] \
  --category permission|question|plan_review|done|failure \
  --key <attention-key> \
  --session <session-id> \
  --choice approve=Approve --choice approve-session=Approve for session --choice deny=Deny
```

- **`--category`** picks the companion's action set: `permission` → Approve /
  Approve for session / Deny; `question` → the options plus a typed reply;
  `plan_review` → Approve / Send back; `done`/`failure` → open-report / open-pr /
  open-terminal.
- **`--key`** is the `AttentionItem.key` (`host/session/generation`) the companion
  hands to `agents feed answer <key> --choice <id>`. It is the stable handle the
  reply rail resolves against.
- **`--session`** is the session the banner belongs to, so the companion can open
  or focus it.
- **`--choice <id>=<label>`** repeats, once per ordered choice (≤ 6). The `id` is
  `[a-z0-9-]+` and is exactly what the companion echoes back to
  `agents feed answer --choice <id>`; the `label` is the plain-text button
  caption. Each field is its own argv entry — the child never sees a shell — so an
  `=` inside a label is inert (the companion splits on the FIRST `=`).

**Where the choices come from.** The attention reconciler
(`src/lib/feed/attention.ts`) owns them. Every `permission` item exposes exactly
`approve` / `approve-session` / `deny` (Claude Code's numbered permission prompt is
option 1 / option 2 "don't ask again for this session" / Esc; a harness with no
verified session-scoped option omits `approve-session`); a `plan_review` item
exposes `approve` / `send-back`; a `question` item carries the harness's own option
list, each choice slugging its label to an id and carrying the harness selection
key as its `deliveryKey`. A `done` banner (from `run-notify.ts`) carries
`open-report` when the run produced a report path and `open-pr` when a PR URL is
known; a stall/failure carries a single `open-terminal`.

**The answer path.** `agents feed answer <key> --choice <id>`
(`src/lib/feed/answer.ts`) resolves the id to the choice's `deliveryKey` (falling
back to the label), atomically claims the first answer, and routes it over the
session's recorded reply rail — a keystroke into the parked TUI (`1` selects
option 1, `2` selects "don't ask again this session"), a headless resume, or the
mailbox for a running agent between tool calls.

**Who posts, and once.** The `attention-notify` daemon service
(`src/lib/daemon/attention-notify-service.ts`, tick 5 s, deadline 10 s,
reader-independent) reconciles this host's live sessions each tick and posts one
banner per attention key not yet notified. Its idempotency truth is a filesystem
ledger — one sidecar file per key under `~/.agents/.history/feed/notified/`, pruned
with the feed's 14-day rule — so a daemon restart never re-posts a banner already
sent. `done` banners are the exception: they ride the run process's own exit
(`agents run --notify`), not this service.

## Files

| Path | Purpose |
|---|---|
| `~/Library/LaunchAgents/com.phnx-labs.agents-menubar.plist` | launchd service |
| `~/Library/Application Support/agents-cli/MenubarHelper.app` | installed helper bundle |
| `~/Library/Application Support/agents-cli/.menubar-version` | installed-version stamp |
| `~/Library/Application Support/agents-cli/.menubar-last-heal` | last self-heal reinstall, epoch ms — the non-owner takeover cooldown |
| `~/Library/Application Support/agents-cli/.menubar-tcc-migrated` | marks the one-time ad-hoc -> Developer ID `tccutil reset Accessibility` as done |
| `~/.agents/.cache/state/menubar.disabled` | sticky opt-out marker |
| `~/.agents/.cache/helpers/menubar/menubar.log` | helper stdout / stderr |
| `~/.agents/.history/menubar/projects.json` | last `agents projects list --json` result, so the palette's project dropdown fills on the first summon after a launch |
| `~/.agents/.history/feed/notified/<key>` | actionable-banner idempotency ledger — one sidecar per notified attention key, pruned at 14 days (`attention-notify` service) |
| `~/.agents/.history/menubar/recent-tickets.json` | tickets filed from the quick-dispatch panel (RECENT TICKETS) |
| `~/.agents/.history/menubar/linear-cache.json` | warm cache of Linear projects + each project's open tickets |
