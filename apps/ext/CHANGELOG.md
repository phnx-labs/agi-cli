# Changelog

All notable changes to AGI EXT (the VS Code extension) are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); `scripts/release.sh` requires a
`## [<version>]` section for the version being published.

## [0.9.330] - 2026-08-21

- **Remote editor tabs replace provisional topics with the canonical session
  name (RUSH-3011).** A tab no longer locks onto an early `/continue …` title:
  the existing fleet session stream reconciles later harness-generated names
  into matching tabs, while user-set labels remain authoritative. Raw slash
  commands are no longer accepted as task-title topics. Source:
  `src/core/sessionTabLabelSync.ts`, `src/vscode/extension.ts`.

## [0.9.329] - 2026-08-20

- **New Agent separates placement from account choice (RUSH-2961).**
  `Agents: New <Harness>` lets agents-cli resolve the configured device target,
  then opens the version/account picker populated by that device. `(Pick Host)`
  asks for the device and then the account; `(Auto)` keeps choosing both.
  Source: `src/core/launchTarget.ts`, `src/core/agents.ts`,
  `src/vscode/extension.ts`.

## [0.9.328] - 2026-08-20

- **A "needs you" reply button on the Fleet feed no longer fails silently.**
  Clicking an option on a row whose agent has no reachable reply channel — a
  headless run with no terminal tab, or a session on a raw non-tmux TTY on another
  box — called `replyToAgent`, which set an inline error and returned. But
  `FeedItem` did not accept an `error` prop at all, so it rendered
  `StructuredReply` without one: the error existed and only the detail pane could
  show it. On the feed the click produced no visible change whatsoever, which
  reads as a dead button. `FeedItem` now takes `error` and forwards it, and all
  seven feed call sites pass it, so the row states why the reply could not be
  delivered ("Runs on <host> — open it there to reply"). Source:
  `ui/settings/components/mission-control/{FeedItem,UnifiedAgentsPane}.tsx`.

- **Agent prose renders as markdown on the Fleet feed, and a card stops restating
  its own title.** `AgentDecision.tsx` imported no markdown renderer at all, so an
  agent's response rendered raw — literal `**bold**` and backticks in an unbroken
  wall of text; `StructuredReply.tsx` rendered its question the same way. Both now
  go through the same `renderMarkdown` (marked + DOMPurify) every other surface
  uses. Separately, a card's title IS the first line of its prompt, and the TASK
  block below restated it: a single-line prompt rendered the identical string
  twice and cost the card ~120px, so the first card ran ~500px and roughly one and
  a half agents filled the pane. The block now renders only when the prompt has
  more than that first line — compared by line count, not by text, because
  `firstLine()` strips markdown and a text comparison leaves the duplicate in
  place for exactly the cards that read worst. Source:
  `ui/settings/components/mission-control/{FeedItem,AgentDecision,StructuredReply}.tsx`.

- **The session detail panel stops stalling once a workspace has ~20 agents open.**
  Resolving a Claude transcript meant stat-ing one filename under every project dir
  of every Claude version root, with no cache, and the floor rebuild did that once
  per agent terminal on every refresh. Measured on a real home (10 roots, 343
  project dirs): 20 agents whose transcripts sit in the last root cost **5,911
  `statx` + 1,192 `getdents64`, 726ms**; 20 agents with no transcript yet cost
  exactly 343 x 20 = **6,860 `statx`, 740ms**. Nothing debounces the rebuild, so
  those walks stacked and the panel — which has no fetch, spinner or timeout of its
  own — simply rendered empty until they drained. `getSessionPathBySessionId` now
  builds one shared filename index and memoises each resolved path. Measured with
  the real concurrent caller pattern over four refreshes, 20 resolvable agents drop
  from **15,196 to 1,478 `getdents64`** calls; 20 agents with no transcript drop
  from **58,516 to 3,644 `getdents64`**, and the miss refresh falls from **501ms to
  109ms**. A candidate from either cache is still confirmed with a single `stat`,
  so a transcript that was deleted or moved re-resolves instead of serving a dead
  path, and a session that starts writing after the index was built is picked up on
  the next lookup past a 500ms window. Source:
  `src/vscode/sessions.vscode.ts`.

- **The Fleet payload no longer waits on the cloud API, and rebuilds stop
  stacking.** `pushFloorUpdate` awaited `getFloorTerminalDetailsForWebview` and
  `swarm.fetchTasks` together before posting either, and `fetchTasks` ends in an
  HTTP request to the Prix API (`fetchCloudRuns`). The detail panel renders
  entirely from the `terminals` message, so a slow cloud API held back the one
  message it needs. The two now post independently. The rebuild is also wrapped
  in `cachedInFlight` with a zero TTL, so the rebuilds triggered by every
  session-stream fact coalesce instead of stacking — a zero TTL coalesces
  concurrent callers without ever re-serving a stale snapshot. Source:
  `src/vscode/settings.vscode.ts`, `src/core/cachedInFlight.ts`.

- **The Fleet feed stops re-deriving every agent once a second.** The list memo
  folded in a `useNow(1000)` ticker, so every second the whole feed was re-adapted
  — `derivePhase`, `splitActivity` and a per-agent question regex for each agent —
  cascading through the memos downstream. A comment above it claimed the ticker was
  "deliberately NOT a dependency of the agent adapters" while the dependency array
  two lines below always said otherwise. It now ticks at 5s, the interval
  `useNow`'s own docblock prescribes for a value folded into a list memo, and the
  comment states what the code does. The visible live age is unchanged: `FeedItem`
  keeps its own 1s leaf heartbeat and overrides `since` for running and stalled
  agents. Source: `ui/settings/components/mission-control/UnifiedAgentsPane.tsx`.

- **Every compact Fleet row now says what its agent is DOING, not just what it is
  called.** A compact row's title is the agent's name, and the one-line preview
  under it was gated on the full-card layout — so a compact row only ever showed
  prose if that agent happened to have produced a response. Every other row read
  `heartbeat-lastactivity  agents-cli  running` and nothing else. The preview now
  renders on compact rows too, falling back down `sessionTaskLine`'s existing chain
  (prompt -> summary -> response -> worktree slug) so a row is never contextless.
  It stays exactly one line: when the agent has produced a response, that response
  is the line rather than a second one being added beneath it. Full cards are
  unchanged. Source: `ui/settings/components/mission-control/FeedItem.tsx`.
- **The Fleet panel stops burying idle-but-unfinished work below running work
  (RUSH-2838).** The root `AGENTS.md` "Purpose" section makes idle-but-unfinished
  the highest-risk state — the one most likely to be silently abandoned — and says
  no status surface may rank it below running. Three sites did exactly that, and
  each had a passing test pinning the wrong order as correct. `PHASE_RANK` ranked
  `idle` dead last, below `done`, so `Sort: Needs you` put an abandoned session at
  the bottom of the list. `partitionFloorAgents` pushed idle sessions into the same
  `active` bucket as running ones, so the feed rendered them interleaved with agents
  that need nothing. And the Sessions surface's `Sort: Status` used a second,
  hand-maintained rank table that had drifted into the opposite order from the
  `Group: state` bands rendered fifty lines below it. Now: the feed grows an **IDLE**
  section above **RUNNING**; `Sort: Needs you` orders
  `waiting < failed < stalled < idle < running < done`; and `Sort: Status` defers to
  that one shared `PHASE_RANK` instead of a copy, so the sort and the band grouping
  can no longer disagree. No new field was needed to tell a finished idle session
  from an abandoned one — `derivePhase` already maps a finished agent to `done` and
  only an unfinished one to `idle`. Source:
  `ui/settings/components/mission-control/floorModel.ts`,
  `sessionsModel.ts`, `UnifiedAgentsPane.tsx`.

## [0.9.327] - 2026-08-17

- **The markdown Reader renders again instead of a blank pane.** The reader
  webview (`agents.markdownEditor`) loaded the Vite editor bundle with a
  classic `<script>` tag, but the bundle is an ES module carrying top-level
  const bindings — prosemirror-view's `const chrome` browser sniff — which in
  a classic script collide with the webview's global `chrome` binding and
  throw `SyntaxError: Identifier 'chrome' has already been declared` before
  React mounts. Every `.md` opened through Reader showed an empty page. The
  script tag now carries `type="module"` (matching the Fleet dashboard
  webview, which already did), the HTML shell moved to a pure
  `buildEditorWebviewHtml` in `src/core/editorHtml.ts`, and a regression test
  pins the module attribute. Source: `src/vscode/customEditor.ts`,
  `src/core/editorHtml.ts`.

- **Offloaded tabs get auto-labels again (`--device auto` / Pick Host).** Default
  `New Claude` emits `--device auto` and never records which box the CLI picked,
  so the label poller scanned this laptop's `~/.claude` for a transcript that
  lives on the worker. The fallback `agents sessions <id> --host` call has also
  been dead since RUSH-2494 removed `--host` (commander rejects the lookup). The
  watch stream already has `machine` + `topic`: we now stamp the host from that
  row, title the tab from its topic, and talk to the CLI with `--device`.
  Focusing a tab whose label arrived while it was unfocused also applies the
  title instead of leaving the bare `CC` chip.

## [0.9.326] - 2026-08-17

- **Device auto-launch reads the two-layer device-config store (PR #2622).**
  `deviceAutoLaunch.ts` now resolves per-device operator config from the tracked
  `devices/<name>/agents.yaml` `config:` blocks plus the central
  `fleet.defaults.config` fleet-wide defaults layer (written by
  `agents devices config --fleet …`), with a per-device entry winning over the
  defaults — replacing the retired single `fleet.devices.<name>.config` map. A
  corrupt config file still degrades to the documented defaults (every device
  enabled, none preferred, uncapped) with a note on the extension log.

## [0.9.325] - 2026-08-15

- **A release no longer claims "All running windows are live" without checking any window
  (RUSH-2724).** `activate.sh` picked the newest editor logs dir, but every
  `code`/`codium --install-extension` and `--list-extensions` call mints its own logs dir
  containing no windows — and a release run makes several of those *after* installing. The
  newest dir was therefore a decoy: the `window*/exthost/exthost.log` glob matched nothing,
  every window loop iterated zero times, and the script concluded all windows were live
  having inspected none, while the open Fleet panel still ran the previous bundle. It now
  picks the newest logs dir that actually holds windows, and reports UNVERIFIED rather than
  live when it inspects zero. Source: `apps/ext/scripts/activate.sh`.

## [0.9.324] - 2026-08-15

- **The Fleet panel no longer reports 0 sessions in a second editor window (RUSH-2733).**
  One window per machine wins the monitor lease and owns the single `agents sessions watch
  --json` child; that stream emits a `reset` once at startup and only deltas afterwards, so
  every other window depends on the host replaying a synthetic `reset` when it reports in.
  The host registered its request handler as `(payload) => handleRequest(payload)`, dropping
  the `socket` the broadcast server passes — and the replay is guarded by `if (socket)`, so
  it silently never ran. Follower windows were ACKed, received only deltas for rows they
  never had, and rendered "0 agents running" while agents were running. Source:
  `apps/ext/src/monitor/host.ts`.

## [0.9.323] - 2026-08-15

- **The Foreman orb no longer covers the Fleet session detail.** The orb, its speaker
  chip and its composer are a `position: fixed` bottom-right overlay, so the newest
  Activity line in the session detail column rendered underneath them and could not be
  scrolled clear (measured: 48-71px of the live `Bash:` line covered at a 430px column).
  The detail column now reserves the overlay's footprint. The composer's placeholder is
  also shortened to `Ask Foreman… (Enter to send)` — the old hint wrapped to a second
  line that the one-row input clipped (measured 17px). Source:
  `apps/ext/ui/settings/components/mission-control/floor.css`, `index.css`,
  `components/foreman/ForemanOrb.tsx`.

- **Fleet sessions list ranks by progress — idle work no longer hides below running.**
  The state-grouped Sessions list now surfaces a **Needs attention** band (live sessions
  that have stopped progressing — waiting on input, stalled, idle, or failed) *above* the
  **Running** band, ordered most-stuck-first so the highest-abandonment-risk session sits
  at the top. Detached/crashed work still leads in **Needs reconnecting**; finished
  sessions fold into **Recently finished**. Presentation-only grouping of the CLI's
  existing session states (no new lifecycle logic in the extension). Source:
  `apps/ext/ui/settings/components/mission-control/floorModel.ts`, `sessionsModel.ts`.

## [0.9.321] - 2026-08-14

- **`Agents: Attach` finds your backgrounded agents again (RUSH-2670).** A
  detached session's stream row names its terminal app in `host` — for a
  backgrounded agent that is the bare tmux server, so the presentation store
  (which fell back to `host` when the row had no `machine`) presented it as
  living on a machine called "tmux". The Attach command's this-machine filter
  then never matched, and `Agents: Attach` always reported "No backgrounded
  agents to bring forward" even seconds after a successful Detach. The store
  now takes device identity from `machine` (offloaded rows) or `sourceDevice`
  (everything else) and never from the terminal-app `host`. Source:
  `apps/ext/src/core/sessionPresentationStore.ts`.

## [0.9.320] - 2026-08-14

- **Crash-restart no longer reopens every tab in a thundering herd (RUSH-2477).**
  `restoreAgentTerminals` reopened each persisted tab and fired its resume with no
  cap or stagger, so N crashed tabs became N near-simultaneous resume processes
  within seconds of boot — the trigger that overwhelmed the resume path (DB-lock
  crashes, boot-time fleet fan-out). Restore is now bounded and staggered through a
  new pure `runStaggered` helper (`src/core/restoreThrottle.ts`): at most
  `RESTORE_MAX_CONCURRENCY` (2) tabs restore at once, and each start after the first
  is spaced by `RESTORE_STAGGER_MS` (300ms). A tab that fails to restore no longer
  strands the rest of the batch. Source: `apps/ext/src/core/restoreThrottle.ts`,
  `apps/ext/src/vscode/extension.ts`.

- **A failed agent launch no longer closes the terminal before you can read
  why (RUSH-2593).** Native-mode tabs prefixed the launch command with `exec`
  (RUSH-2026) so the shell process was replaced by the agent runner — closing
  the tab automatically once the runner exited. That was right for a clean
  exit, but a *launch failure* (an unreachable `--host`, an `agents run`
  rejection) killed the exec'd process just as fast, and the tab closed before
  the error text on screen could be read. `wrapNativeAgentCommand` now runs the
  launch command normally and checks its exit status: 0 still closes the tab
  (unchanged clean-exit behavior); nonzero prints
  `Agent exited with status <n> — terminal kept open so you can read the error
  above.` and leaves the interactive shell running instead of exiting. Source:
  `apps/ext/src/core/agents.ts` (`wrapNativeAgentCommand`).

- **`Agents: New <Harness>` runs where you say — and defaults to the fleet's worker
  boxes.** The per-harness New commands were hardcoded to this machine. New setting
  `agents.launch.defaultTarget`: `auto` (the default — the CLI picks a device), `local`
  (previous behavior), or `ask` (prompt for the host each time). Device choice stays with
  the CLI, so `auto` emits `--device auto` and lands on whatever the fleet's
  automatic-placement pool allows: mark boxes with `agents devices role <name> worker` and
  new agents rotate over those only. The `(Pick Host)` and `(Auto)` command variants are
  unchanged.

## [0.9.319] - 2026-08-10

- **Marketplace icon is now the agents-cli brand mark.** The listing used a
  pink/orange gradient "A" on white, which matched nothing on
  [agents-cli.sh](https://agents-cli.sh). It is now the site's own mark — the
  lime `#a3e635` tile with the near-black lowercase `a`, rendered from the same
  `favicon.svg` the website ships — as `assets/logo.png`. `assets/agents.png` is
  unchanged and still backs the shell/custom-agent tab chips, so no in-editor
  icon moved.

- **`New <Agent>` tabs get their identity back — logo, chip, session id, labels,
  and the commands that depend on them.** `launchAgent` had been rewritten to a
  bare `createTerminal`, which dropped the whole post-create sequence: every
  New-Agent tab showed the generic terminal glyph labelled `Agents claude`, the
  status bar read `Agents: Terminal`, auto-labels never armed, and the tab was
  never registered — so Copy Session ID, Copy Session Trace, Resume, Resume in
  Best Profile, Handoff, Continue in New Session and Fork all answered *"Active
  terminal is not an agent terminal"*, and a window reload lost the tab entirely
  because nothing scheduled its persistence. The per-agent Default Model
  (`--model`) and a workspace's bound project (`--project`) were silently
  dropped from the launch command too. Registration now lives in one
  `registerAgentTerminal` that both creation paths call, and the command is
  built by the existing `buildAgentLaunchCommand` rather than a second
  hand-rolled string. `Agents: New Agent` (the automatic launch, which has no
  harness until the CLI picks one) registers against the `shell` def and lets
  adoption re-key it, so it is a tracked tab from the first frame.

- **`New <Agent> (Auto)` now actually offloads.** Behavior change, surfaced by
  the above: `autoHost` has never been read — it is declared and passed by every
  `…Auto` command but nothing consumed it — and because those commands set an
  agent key, the old local/device test was false, so `(Auto)` emitted no device
  flag and quietly ran on this machine. It now emits `--device auto` and lets
  the CLI pick, which is what the command name promises. Device selection stays
  in the CLI rather than being scored in the extension. `New <Agent> (Pick Host)`
  answered with **This Mac** stays local, as it always should have.

- **Tab icons + status bar for Grok/Kimi/Droid/Antigravity and resumed sessions.**
  Shell-adoption only recognised the original five harnesses (`claude`/`codex`/
  `gemini`/`cursor`/`opencode`), so a New Grok tab (or any focus/resume that
  landed via the `/spawn` URI) stayed a generic terminal: wrong icon and status
  bar stuck on `Agents: Terminal`. The detector now covers every built-in runner
  (including `agy` for Antigravity). The `/spawn` payload also carries
  `agent`/`sessionId`/`title` so remote `ssh … tmux attach` resumes set the chip
  without process-tree sniffing (#2478). Process-title forms like `Agents grok`
  are parsed so a reloaded window rebinds the tab.

- **AGI EXT now delegates session recovery to agents-cli.** Opening the Resume
  picker performs one bounded `agents sessions --all --json --no-interactive
  --limit 60` read, and selected sessions execute `agents sessions resume <id>
  --vscodium`. The extension no longer joins a second active-session query or
  maintains a stale resume-candidate cache.

- **Fleet controls now use canonical CLI nouns.** Fork calls `agents sessions
  fork`, watchdog controls use `watchdog on|off` and `watchdog history --json`,
  and device reachability/load/session counts use `devices list/status --json`.
  The extension no longer SSH-probes CPU/memory, counts remote sessions itself,
  reads the watchdog JSONL/playbook, or maintains those policy implementations.

- **Task and panel acquisition are CLI-backed.** Unified tasks come from one
  `agents tickets list --json` response, session browsing uses the same bounded
  on-demand history command as Resume, and dashboard refreshes are driven by the
  elected session stream. Direct Linear/GitHub aggregation and session/team file
  watchers were removed.

## [0.9.315] - 2026-08-10

- **Launch Warp with the right command.** The Warp agent's `cliCommand` was still the
  legacy `oz`; it now matches the CLI's canonical `warp` (with `oz` kept as an alias),
  so launching Warp from the extension resolves correctly.

- **Launch-health sweep no longer pins the machine.** The 60s fleet health sweep used to
  spawn one `agents view <agent> --host <box>` subprocess for **every (agent × host) pair**
  — on a ~12-device fleet that is ~120 concurrent node + SSH probes per tick — with no
  concurrency cap and no guard against a fire-and-forget sweep stacking on a still-draining
  one, which drove CPU to a runaway load (100–447) and starved the UI. The sweep now makes
  **one batched `agents view --host <box> --json` call per host** (deriving every agent's
  usable-version flag from that single payload, the remote analog of the existing local
  batching), **bounds the per-device fan-out** to a small concurrency pool, and
  **singleflights** so overlapping ticks can't pile a second full sweep on top. A
  ~120-process burst becomes ~12 pooled, deduped calls. Fixes phnx-labs/agents-cli#2469.

- **Renamed to AGI EXT; the dashboard is now Fleet.** The editor tab and the navbar
  wordmark read **AGI EXT**, and the agent-status view formerly called "Factory Floor"
  is **Fleet** (the tab label, the command-palette entry "Go to Fleet", and the page
  title). A dashboard tab restored from a pre-rename build is reclaimed rather than left
  open beside the new one. Marketplace identity is unchanged (publisher `swarmify`, name
  `swarm-ext`), so existing installs and the `swarm-ext://` URI keep working. The
  extension's source also moved from `apps/factory` to `apps/ext` in the monorepo.
  Unrelated surfaces that share the word keep their names: the Factory.ai/`droid`
  integration, the `factory` cloud provider, and the beta-gated `agents factory`
  Software Factory command.

- **New Sessions tab — see and recover every session you own.** A dense, virtualized
  Sessions surface is now the first subtab on the Floor (before Agents). It lists every
  session across projects — local and remote, active and **orphaned** — and its whole
  reason for being is the reboot case: when your machine sleeps or drops off the network,
  the sessions that got detached (orphaned) or crashed float to a **Needs reconnecting**
  band with one-click **Resume** (and a Resume-all), each routed to the session's owning
  machine. **Star** any session (☆) to pin it to the top. Filter by All / Active /
  Orphaned / Starred, project, host, or free-text search; **group** by State / Project /
  Host / Flat and **sort** by Last active / Started / Status / Name / Tokens. It reads the
  roster Factory already polls and does all filtering/sorting/grouping client-side, and
  the list is virtualized, so hundreds of sessions stay instant. Under the hood the CLI's
  real lifecycle status (`orphaned`/`crashed`/`abandoned`) is now preserved end-to-end
  (`FloorAgent.liveStatus`/`pidAlive`) instead of being collapsed to `idle`.

- **Factory no longer maps a new Codex tab to an older same-folder session (RUSH-2430).** Newly-created tabs wait for their own rollout across managed Codex version homes, restored tabs retain recovery, and local or picked-host tabs replace a stored UUID when that device's live `AGENT_TERMINAL_ID` map proves it stale. Picked-host identity hydration now runs even when automatic tab labels are disabled.

- **Picked-host Codex tabs auto-label after remote ID hydration (RUSH-2411).** A
  `New Codex (Pick Host)` tab launches idless — only Claude's session id is minted
  up front — so its canonical UUID arrived later through the shared
  `agents sessions --active --host <device>` join, but the auto-label lifecycle was
  never started and the tab kept the bare `CX` chip. The moment a tab gains its
  canonical id (from the remote join or the local SessionStart watcher) it now arms
  the same auto-label lifecycle, so a remote Codex goes bare `CX` -> canonical UUID
  -> topic-derived title without a refocus. The id is resolved through the existing
  coalesced per-host active map (no per-tab SSH poll), and every hydrated sibling
  tab on that host enters labeling from the one fetch. Local Codex and Claude tabs
  are unchanged.

## [0.9.314] - 2026-08-07

- **`Agents: Fork (Recap)` now recaps the active tab without asking for a session.**
  The command starts a fresh sibling on the active session's host with the same
  harness and balanced account selection, queues `/recap <full-id>`, and records
  fork lineage. `Agents: Fork (Pick Session)` remains the explicit session browser.

## [0.9.313] - 2026-08-05

- **Resume delegates session lifecycle to agents-cli.** The picker keeps its
  cross-device session list but starts with no rows selected. A chosen row sends
  only `agents sessions resume <canonical-id>`; the CLI decides whether to attach
  a live pane or resume an inactive session on its owner. Closed/crashed retained
  panes are shown as inactive, and Factory waits for readiness before reporting a
  reopened terminal as successful.

## [0.9.312] - 2026-08-05

- **`New X (Auto)` offloads to the fleet on a cold cache (was: silently local).**
  `New Claude (Auto)` — and every `New <Agent> (Auto)` — resolved its launch host only
  from the warm health-cache snapshot. On a cold or >5-min-stale miss, `launchAgent` bailed
  straight to a local launch: the live favorites-aware `resolveBalancedHost` sweep was
  guarded out by `!opts.autoHost`, and `local: true` also suppressed the CLI `--device
  auto`, so the enable/prefer ranking never ran. Fix: on a cache miss, fall through to the
  same live `resolveBalancedHost` sweep the default New-agent path uses (honors
  enable/prefer, drops hosts with no usable version); it runs local only when no fleet
  device is genuinely eligible. Source: `src/vscode/extension.ts` (`launchAgent`),
  `src/core/launchHistory.test.ts` (regression), `AGENTS.md` launch contract.

- **Status bar session id: CLI join by `AGENT_TERMINAL_ID`, no per-tab poll thrash (RUSH-2192).**
  Grok / Codex / other non-Claude tabs often showed a bare `Agents: Grok` (no id) or a
  Codex `rollout-<timestamp>-<uuid>` stem instead of the real UUID. Root causes: only
  Claude mints an id at launch; the file watcher never tracks Grok; offloaded
  `--device`/`--host` tabs skipped live hydrate entirely; and when a Codex file *was*
  adopted, the full basename was used as the id.
  Fix: resolve the id from `agents sessions --active --json` (local: `--local`; offload:
  `--host <device>` — never `--where`) joined on this tab's `AGENT_TERMINAL_ID`, with
  **one subprocess per host** shared across all tabs (in-flight coalesce + TTL cache +
  hard timeout). Same-machine `--device <this-host>` still uses the local SessionStart
  state path. Status bar / clipboard always show the canonical UUID. Codex file-stem
  adoption also extracts the UUID only. Source: `src/core/canonicalSessionId.ts`,
  `src/core/sessionIdJoin.ts`, `src/core/sessionIdHydrate.ts`, `src/vscode/extension.ts`,
  `src/monitor/sessionParse.ts`, `src/core/remoteSessions.ts`.

## [0.9.311] - 2026-08-05

- **Extension no longer orchestrates tmux.** The Factory VS Code extension previously
  wrapped agent terminals in a local tmux session so it could reattach after window
  crashes or SSH drops. That layer is removed: every agent now opens in a plain
  native VS Code terminal running `agents run <agent> --interactive` directly. This
  fixes the long tmux init chain that could overflow the tty input queue and leave
  the agent unstarted. Reconnect/reattach responsibility moves entirely to the
  agents CLI. Deletes `src/vscode/tmux.ts`, `src/vscode/reconnect.ts`, tmux
  coordinate tracking in `src/vscode/terminals.vscode.ts`, and the tmux fields in
  `src/core/sessions.persist.ts`. Tests in `src/core/agents.test.ts` and
  `src/core/prewarm.test.ts` assert a new spawn sends only the `agents run`
  command and that a Claude resume with the original session id sends no tmux
  wrapper or extra input. Source: `src/vscode/extension.ts`, `src/core/spawn.ts`,
  `src/vscode/terminals.vscode.ts`, `src/core/sessions.persist.ts`.

- **Floor data pipeline: last-good snapshot, no recurring fleet fan-out.** The
  extension host persists the last successful Floor host/sessions, device-registry,
  and agent-inventory snapshots in `globalState` and returns them immediately. Activation
  (panel wire) seeds at most one `agents devices list --json` and one
  `agents sessions --active --local --json`. Remote fleet refresh is user-triggered
  only (`fetchHostSessions` with `force: true` → one bare `agents sessions --active
  --json`); failures keep last-good rows and record per-host freshness. Dispatch
  opens from cached inventory + last-good sessions and no longer probes per-device
  CPU/memory; sidebar/Dispatch device messages reuse the activation registry
  cache instead of rerunning `devices list`. SnapshotDetector's 4s tick no
  longer runs `agents view --json` (inventory is a persisted 60s SWR cache
  shared only by panel/dispatch). Protocol adds
  optional `force` / `hostFreshness` / `fromCache` fields on floor host/local
  session messages. Source: `apps/factory/src/core/floorSnapshot.ts`,
  `apps/factory/src/vscode/remoteSessions.vscode.ts`,
  `apps/factory/src/vscode/settings.vscode.ts`,
  `apps/factory/src/monitor/snapshotDetector.ts`.


- **Resume / restore always routes through `agents run --resume`.** Removed the
  per-harness raw binary fallback (`claude -r`, `codex resume`, `cursor-agent
  --resume=`, etc.) from `buildVersionedResumeCommand`. Every resumed session now
  emits `agents run <agent> --interactive --resume <id>`; offloaded sessions get
  `--host '<device>'`. `agents run --resume` resolves the originating version, so
  Factory no longer pins an explicit `@version` on resume. Source:
  `apps/factory/src/core/prewarm.ts`, `apps/factory/src/core/prewarm.test.ts`.

- **Remote session host survives a VS Code: window restart.** `scanExisting`
  rehydrates `EditorTerminal.host` from the persisted session when VS Code:
  restores a terminal before the extension activates. Without this, the restore
  path built a local raw resume for a session whose transcript lives on another
  device. Source: `apps/factory/src/vscode/terminals.vscode.ts`.

- **Resume payload is never typed when the agent fails to start.** The
  `launchResumeTerminal` "send anyway" rejection handler that typed `Continue.`
  into a dead shell prompt now surfaces a `showErrorMessage` and leaves the
  terminal alone. Source: `apps/factory/src/vscode/extension.ts`.

- **Resume picker: selection no longer clears, and rows say what differs.** The
  batch picker announced "N detached sessions pre-selected" while showing `0 Selected`
  and empty checkboxes. Two causes: the refresh swap filtered defaults by "was rendered
  before", which on the first background revalidation matched every default and dropped
  the whole selection; and `picked` on an item does not populate `quickPick.selectedItems`,
  which is what accept and the counter read. Pre-ticking now tracks the ids the user
  explicitly unticked, and `selectedItems` is assigned explicitly. Row labels also drop
  boilerplate that recurs across the visible rows (`Resume previous work: …`, `## Apps`)
  and fall through to project → cwd leaf when nothing distinctive is left, so a row reads
  as its device, id, and the part that actually differs instead of `(no topic)`. Measured
  on a real 222-session listing: 29 rows de-boilerplated, 117 that showed `(no topic)`
  now name their project. Selection bookkeeping lives in `nextPreselection`, which
  only treats a previously-ticked DEFAULT as user-unticked — marking every rendered
  row instead silently skipped a session that went idle -> detached mid-refresh. A
  topic that is entirely a shared phrase keeps its text rather than blanking, since a
  longer topic can mint a prefix equal to a shorter one's whole text, and only
  whitespace is trimmed after a prefix so content like `-1 open issue` survives.

- **Reader association fix + HTML artifacts + command titles.** Factory wrote
  `workbench.editorAssociations` as a legacy array (`[{ viewType, filenamePattern }]`).
  VS Code only accepts the object map (`{ "*.md": "agents.markdownEditor" }`), so the
  toggle saved but files kept opening as raw text. Now writes the object shape,
  migrates the old array on read, and pins patterns to `default` when disabled.
  Commands are renamed to `Agents: Reader (Enable)` / `Agents: Reader (Disable)`
  (same style as Watchdog). Reader also owns `*.html` / `*.htm` via a sandboxed
  HTML preview (`agents.htmlReader`) so artifacts-cli pages render instead of
  showing source. Floor/plan open paths no longer shell HTML out to the system
  browser — `openPlanPreview` and file clicks use `vscode.openWith` for the
  Reader, so `.agents/artifacts/**/*.html` (and plans/reports) open in-editor.
  Source: `src/core/editorAssociations.ts`, `src/vscode/workbench.vscode.ts`,
  `src/vscode/htmlReader.ts`, `src/vscode/settings.vscode.ts`, `package.json`.
- **Status bar no longer shows a stale/stranger identity for a tab (fixes a Kimi
  tab displaying a Claude `2.1.218` and a wrong `session_…` id).** Two independent
  defects. (1) The live-session-id lookup resolves a tab's session by reading the
  SessionStart hook's pid-keyed `<pid>.json` files across the tab's process tree;
  those files are never pruned, so the OS eventually recycles a dead agent's pid
  onto a live process under a different tab and the stale file binds. The
  terminal-age guard couldn't separate a ~30h-old stale file from a same-age
  long-running tab in the same repo — `liveSessionIdForShell` now also rejects any
  candidate pid whose CURRENT process (from `ps` ELAPSED) started after the record
  was written. (2) The status bar rendered whatever version/account were cached on
  the entry even when they were resolved for a *different* session left over in the
  same terminal; it now shows only the identity resolved for the session id it
  displays (`displayIdentity`, gated on a new `identityAppliedSessionId` distinct
  from the both-fields retry gate so a version-only harness still shows its
  version), and clears a field
  the current session doesn't carry (Grok/Cursor/Droid have a version but no
  account; Kimi has neither). Source: `src/core/liveSession.ts`,
  `src/core/statusIdentity.ts`, `src/vscode/extension.ts`,
  `src/vscode/terminals.vscode.ts`.
- **Removed the `agents.terminalMode` setting.**
  The extension no longer exposes an `auto` / `tmux` / `native` "terminal mode".
  The setting and the `src/core/terminalMode.ts` module are deleted, along with
  the mode reads at the launch / URI-spawn / split sites. Source:
  `src/vscode/extension.ts`, `package.json`.
- **Fleet health probes no longer stack duplicate `agents` subprocesses (fixes
  CPU thrash on a loaded box).** `countRunningAgents` — the per-host running-agent
  count behind the Dispatch panel's device health and the launch-health refresh —
  spawned a fresh `agents sessions --active --json --host <box>` subprocess per
  fleet device on every call, with no cache and no in-flight dedup (unlike its
  sibling `fetchDeviceStats`). Several uncoordinated callers each fanned out over
  the whole fleet, and on a loaded box where an `agents` cold-start alone exceeds
  8s the batches piled up into dozens of concurrent duplicate processes. Both
  probes now share one `cachedInFlight` guard: concurrent calls for a host
  coalesce into a single in-flight run, and repeats within 6s serve the cache.
  Source: `src/core/cachedInFlight.ts`, `src/vscode/deviceHealth.vscode.ts`.

- **Menu bar warns when a device is under high load.** A new `NEEDS YOU` row
  surfaces overloaded machines — local (`getloadavg()`, a native libc call, zero
  subprocess) and remote fleet peers (read from the daemon-warmed
  `.fleet-stats.json` cache with a 10-min freshness guard). The row reads
  `⚠ <device> — high load N%` (`✕` red when critical: load ≥150% or mem ≥90%);
  it counts into the header `⚠ N needs you` badge and tips the menu-bar icon.
  Action-required rows are bolded so items that need attention stand out. Never
  touches `agents doctor` (measured ~136s cold-start) — the load signal is
  `getloadavg` + one cache read on the badge tick. Source:
  `apps/menubar/src/loadedDevices.ts`, `apps/menubar/src/index.ts`.

## [0.9.310] - 2026-08-04

- **Every New-agent launch is balanced — `agents run <agent> --interactive
  --strategy balanced --mode auto`, with no per-harness exception (#1908).** Local
  **Grok, Kimi, and Droid** used to launch as raw binaries (`grok` / `kimi` /
  `droid`) with no account rotation and no `--mode`, because three disagreeing
  allowlists (`STRATEGY_LAUNCH_AGENTS`, `LAUNCHABLE`, `usesManagedAgentLaunch`)
  gated whether an agent got `--strategy balanced` and whether it even routed
  through `agents run`. Those lists are collapsed into one predicate,
  `isAgentRunner(key)` = `key !== 'shell'`. Local New-agent launches also pass
  `local: true` into the launch builder so they do not accidentally emit
  `--device auto` and leave this Mac. Source: `src/core/agents.ts`,
  `src/vscode/extension.ts`.

- **grok / kimi / droid / antigravity tabs now restore, reopen, and reload like the prewarm agents (#1747).**
  Resume past the picker was still gated on `supportsPrewarming` (claude/codex/gemini/cursor/opencode),
  so a grok/kimi/droid/antigravity tab did not come back after a window reload, a reopen-last, or a
  reload-active-terminal — even though its transcript exists and `agents run --resume` can resume it. The
  three surfaces now gate on the same registry check the picker uses (`agentKeyFromSession`), reload falls
  back to a generic Ctrl+C-twice exit sequence for agents without a `PREWARM_CONFIGS` entry, and the
  `openSingleAgent` launch path now tracks + polls those harnesses too so there is a persisted session to
  come back to.
- **Removed the `Agents: Enable Tmux` / `Agents: Disable Tmux` palette commands.**
  They were back-compat aliases that just flipped the `agents.terminalMode`
  setting, and the extension no longer needs its own tmux "mode" toggle — the
  `agents` CLI wraps interactive launches in tmux itself. The `agents.terminalMode`
  setting stays (set it to `native` in settings.json if you want VS Code editor
  terminals instead of tmux), and tmux-backed reconnect resilience is unchanged.
  Removes the two commands, their command-palette menu entries, and the now-unused
  `agents.tmuxEnabled` context key. Source: `src/vscode/extension.ts`,
  `package.json`.
- **BREAKING (settings): the extension's watchdog loop is deleted — the CLI daemon watchdog is the only watchdog.**
  `agents watchdog enable` (the `agents __daemon-run` routine) now owns
  rotate-on-exhaustion in addition to stall nudging: it injects the harness
  exit sequence, `agents run auto --interactive`, and the `/continue` replay
  into the SAME vscodium tab via the extension's `/inject` URI verb over
  live-terminals.json, and writes `rotate` events to the shared
  `~/.agents/.cache/logs/watchdog.log` (a skip is a `kind: 'rotate'` entry with
  a `rotate skipped:` message prefix — there is no separate skip kind) — the
  Factory Floor status card keeps
  working unchanged. Deleted: the `startWatchdog` tick + config listener, the
  no-healthy suppression machinery, `src/core/autoRotate.ts`,
  `rotateTerminalToBestVersion`/`RotateOutcome`, and the dormant monitor
  watchdog broadcast lane (`src/monitor/watchdogDetector.ts`, follower
  `setWatchdogWatches`, host broadcast, the `watchdog-watch` /
  `watchdog-versions` protocol types). **The `agents.watchdog.enabled`,
  `agents.watchdog.autoRotate`, `agents.watchdog.rotateCooldownSeconds`, and
  `agents.watchdog.tickSeconds` settings are removed** — the on/off now lives
  in the CLI (`agents watchdog enable|disable|status`); an explicit
  `autoRotate: false` is migrated once per user via the CLI's rotate-only switch
  (`agents watchdog rotate off`) on activation — nudging is untouched; on an
  older CLI without the subcommand the migration retries next activation.
  Source: `src/vscode/watchdog.vscode.ts`, `src/vscode/extension.ts`,
  `src/vscode/settings.vscode.ts`, `src/monitor/`, `package.json`.

- **`Agents: Watchdog (Enable)` / `Agents: Watchdog (Disable)` replace `Agents: Toggle Watchdog Auto-Rotate`.**
  Two honest static palette titles shelling out (execFile argv, no shell
  string) to the CLI's `agents watchdog enable|disable`, with a status-bar
  confirmation or an error toast quoting the CLI's stderr. The settings
  panel's watchdog toggle reads/writes the same CLI state
  (`agents watchdog status --json`).
  Source: `src/vscode/watchdog.vscode.ts`, `src/vscode/settings.vscode.ts`,
  `package.json`.

- **Manual resume commands keep working without the rotate machinery.**
  `Agents: Resume in Best Profile` now shares the Pick-Harness launch flow
  (`launchResumeTerminal`) and builds its `agents run auto --interactive
  --session-id <uuid>` command via `buildAutoRunLaunchCommand` in
  `src/core/resumeInBest.ts`; a `no healthy` failure surfaces in the fresh
  terminal itself (the CLI fails loud there).
  Source: `src/vscode/extension.ts`, `src/core/resumeInBest.ts`.

## [0.9.309] - 2026-08-03

- **Watchdog auto-rotate delegates to `agents run auto` — no more rotate loops into exhausted accounts.**
  The rotate path no longer re-implements account selection (`pickBestVersion`
  was blind to weekly-limit windows and had a "better somewhere than nowhere"
  fallback, so on 2026-08-03 it looped a resume-tab into the same exhausted
  account every 120s, plus a Keychain prompt per tick from the `agents view
  --json` probe). The watchdog now decides from the terminal's own tail
  (agent-reported rate-limit text — no probing, no Keychain prompts) and the
  rotate launches `agents run auto --interactive`, letting the CLI resolve
  host (affinity) → harness (cross-harness headroom) → account (balanced).
  When the CLI fails loud with `no healthy … resets <time>` — read off the
  launch's shell-integration output stream — rotation on that host is
  suppressed until the parsed reset, one `rotate` skip event is logged per
  suppression window, and the tick keeps evaluating without spawning. The
  version/account/harness labels are read back from the CLI session feed
  (`agents sessions <id> --json`, now including the harness the CLI picked).
  The dead picker (`pickBestVersion`, `buildLaunchCommand`,
  `buildHostLaunchCommand`, `isVersionStillUsable`, `rotatableVersionOf`) and
  the per-tick `agents view` probe are deleted. Requires agents-cli with
  `agents run auto` (RUSH-2132).
  Source: `src/vscode/extension.ts`, `src/vscode/watchdog.vscode.ts`,
  `src/core/autoRotate.ts`, `src/core/resumeInBest.ts`,
  `src/core/remoteSessions.ts`.

- **`Agents: Toggle Watchdog Auto-Rotate` — the off switch that didn't exist during the incident.**
  New palette command flipping `agents.watchdog.autoRotate` (global) with a
  status-bar confirmation; the running loop picks the change up via its
  configuration listener.
  Source: `src/vscode/watchdog.vscode.ts`, `package.json`.

- **The `(Pick Host)` host list shows every device instantly, even on a busy machine.**
  The picker's snapshot is now warmed at extension startup (the cheap `devices
  list` registry read, no fleet SSH sweep), so the first `New <Agent> (Pick Host)`
  in a window renders every host immediately instead of showing only *This Mac* +
  *Balanced* while a cold snapshot loads. When the snapshot is stale, the refresh
  runs in two phases: the device rows swap in as soon as the registry read lands,
  and the recent-usage annotations fill in afterward from the fleet sweep — so the
  host list never waits on the fleet fan-out, which is where the seconds went on a
  loaded laptop (an interactive box under heavy agent load turned a 0.4s registry
  read into a multi-second wait).
  Source: `src/vscode/extension.ts`, `src/core/hostPickerCache.ts`,
  `src/vscode/remoteSessions.vscode.ts`.

- **The host picker never goes empty again: a failed refresh keeps the rows you last saw.**
  (Landed after the 0.9.308 build was cut, so it ships in 0.9.309 despite the
  entry living under that heading before.) The 0.9.307 stale-while-revalidate
  picker persisted whatever the background refresh returned — and on a loaded
  box, `agents devices list --json` exceeded the extension's 8s spawn timeout,
  the catch returned `[]`, and that empty result was written straight into
  `agents.hostPicker.v1`. The menu then opened instantly (the cache did its
  job) showing only "This Mac" and "Balanced". An empty device list is a
  failed registry read, never a real empty fleet, so the refresh now folds
  through `mergeHostPickerSnapshot`: an empty fetch keeps the previous rows
  and scores, and with no confident data at all nothing is persisted (the
  picker stays in cold-start mode and retries next open), and the snapshot
  keeps its true age so the rows' `updated Xm ago` label never claims a failed
  refresh was fresh. The registry read's timeout also goes 8s → 20s — the host
  picker's render path never waits on it (cold-start callers like the
  browse-device switcher still do, bounded). Source:
  `apps/factory/src/core/hostPickerCache.ts` (`mergeHostPickerSnapshot`),
  `apps/factory/src/vscode/extension.ts` (`refreshHostPickerCache`),
  `apps/factory/src/vscode/deviceHealth.vscode.ts`.

## [0.9.308] - 2026-08-03

- **`Agents: Fork (Recap)` starts a new sibling with context from a session you pick.**
  It reuses `Agents: Fork (Pick Session)`'s device-aware browser and launches on
  the selected session's exact host, directory, and harness, but queues only
  `/recap <full-id>`. The public `.agents-system` command produces the recap in an
  isolated read-only subagent. Factory never resumes, attaches to, injects, or
  inherits the historical session, so the user can ask a different question in a
  small new session after the recap appears.
  Source: `src/vscode/sessionBrowser.vscode.ts`, `src/vscode/extension.ts`.

## [0.9.307] - 2026-08-03

- **`Agents: Fork (Pick Host)` forks the session you are in onto a device you choose.**
  Same fork as `Agents: Fork` — same harness, same `--strategy balanced` account
  rotation — with the device picked first, from the same picker the
  `New <Agent> (Pick Host)` commands use. A fork that moves machines gets a
  `--device <source machine>` suffix on its `/continue` prompt, because a single-id
  lookup does not fan out across the fleet and the transcript stays where it was
  written. The sibling tab opens *beside* its parent instead of on top of it.
  Source: `src/core/forkSession.ts`, `src/vscode/extension.ts`.
- **Recap shows a fork next to the session it came from.** A fork shares no id with
  its parent, so the ledger used to show two unrelated rows. The fork edge is now
  recorded at launch and the two render as one side-by-side row — parent left, fork
  right, each with its own machine, duration, cost and PR. Day rollups are counted
  before pairing, so the numbers still describe both sessions, and a parent that
  finished on an earlier day keeps its own row.
  Source: `src/core/forkLineage.ts`, `ui/settings/components/mission-control/recapModel.ts`,
  `ui/settings/components/mission-control/RecapPane.tsx`.

- **Three new resume commands, and a shorter name for an old one.**
  `Agents: Resume (Pick Session)` lists only abandoned sessions — detached,
  background, parked, or idle; anything already open in a terminal somewhere is
  left to plain `Agents: Resume` — and resumes each pick on the device the
  session was created on. `Agents: Resume (Pick Host)` reopens the ACTIVE tab's
  session on a device you pick, keeping the harness and its pinned version.
  `Agents: Resume (Pick Harness)` continues the active tab's session in a
  different harness on the same device: the new harness launches via
  `agents run <harness> --interactive` (balanced account rotation) and loads the
  old transcript through the universal `/continue` replay, so any harness can
  pick up any other harness's session. `Agents: Resume Current Session in Best
  Profile` is now titled `Agents: Resume (Best Profile)` — command id and the
  ⌘⇧J keybinding unchanged. Source: `apps/factory/src/core/resumePicker.ts`
  (`abandonedCandidates`), `apps/factory/src/core/resumeTarget.ts`
  (`buildHarnessOptions`), `apps/factory/src/core/resumeInBest.ts`
  (`buildAgentRunLaunchCommand`), `apps/factory/src/vscode/extension.ts`
  (`resumeCurrentPickHost`, `resumeCurrentPickHarness`, `launchResumeInHarness`).

- **Four palette commands that could never run are gone.** `Agents: Enable View`,
  `Agents: Disable View`, `Agents: Run Setup`, and `Agents: Enable Warming` were
  declared in `package.json` but registered nowhere in `src/`, so picking any of them
  from the palette failed with "command not found". `Enable Warming` was the worst of
  them: its `when` clause is `!agents.warmingEnabled` and that context was hardcoded to
  `false`, so the broken entry was **always** visible. Its partner
  `Agents: Disable Warming` was registered but only to say warming no longer exists, and
  its `when` clause meant it was never visible — both are removed along with the dead
  `agents.warmingEnabled` / `agents.viewEnabled` context keys nothing else read.

- **⌘⇧J no longer resolves to two different commands.** It was bound to both
  `Agents: Spawn with Prompt` and `Agents: Resume Current Session in Best Profile`, so
  which one fired was down to registration order. Spawn-with-Prompt keeps ⌘⇧J (it pairs
  with Spawn-with-Context on ⌘⇧K); Resume-in-Best-Profile moves to ⌘⇧⌥J.

- **Removed dead Floor code.** `handleNewAgent` in `UnifiedAgentsPane.tsx` was never
  called from any JSX, and had rotted: it mapped `agents.newGemini` (deprecated, never
  registered) and `agents.newOpencode` (the real id is `agents.newOpenCode`), so it would
  have failed had anything wired it up.

- **Floor no longer collapses distinct sessions that arrive without an id.** A remote
  session row was keyed `remote-<host>-<sessionId>`; when the CLI could not attribute a
  tmux pane (empty id), every such row collided on `remote-<host>-`, a React key clash
  that let distinct panes overwrite each other in the grid. Rows now fall back to the
  tmux pane / pid / cloud-task handle when the id is empty, so each session stays its own
  card. Pairs with the CLI fix that now attributes those panes in the first place.
  Source: `ui/settings/components/mission-control/floorAdapter.ts`.

- **The host picker opens instantly — stale-while-revalidate instead of blocking on
  the fleet sweep.** Every `(Pick Host)` menu used to await two serial
  `agents devices list --json` spawns plus a fleet-wide per-host SSH fan-out
  (`agents sessions --json --host <device>`, 10s timeout each, dead boxes included)
  before rendering a single row — 30–40s whenever the old 60s in-memory cache had
  lapsed. The picker now renders immediately from a snapshot persisted in
  `globalState` (`agents.hostPicker.v1`), marks the rows with their age
  (`updated 8m ago`), fires ONE background refresh, and swaps the items in place
  when it lands, preserving the row you had highlighted; a pick made before the
  refresh lands is honored as-is. The refresh itself is cheaper too: the registry
  read happens once and is threaded into the usage sweep (no second
  `devices list` spawn), and hosts the launch-health sweep already found
  unreachable are skipped instead of dialed into a timeout. Once you have opened
  a picker, the existing 60s background timer pre-warms the snapshot so later
  opens are usually fresh as well as instant. `Agents: Resume` gets the same
  treatment (renders the last candidate list instantly, swaps in the live fleet
  read with your checks carried across, `agents.resumePicker.v1`), and the fork
  browser's device switcher renders from the same snapshot. Source:
  `apps/factory/src/core/hostPickerCache.ts`,
  `apps/factory/src/vscode/extension.ts` (`pickLaunchHost`, `resumeSessionsBatch`,
  `pickBrowseDevice`), `apps/factory/src/vscode/remoteSessions.vscode.ts`
  (`discoverHosts`/`fetchRecapSessions` accept a pre-fetched device list).

## [0.9.306] - 2026-08-03

- **`Agents: Fork Current Session` is now `Agents: Fork`, and a second command forks
  a session you pick from a browser.** The rename is title-only — same command id,
  same behavior (fork the tab you are in). The new `Agents: Fork (Pick Session)`
  opens a session browser instead: recent transcripts from one browsed device,
  newest first, with the session you invoked from pinned to the top, filterable by
  topic / project / harness / id. A title-bar button switches
  the listing to any registered device (`agents sessions --all --json --host <device>`),
  so sessions on a fleet box are browsable from here. Picking one forks it **where it
  lives**: a row on this machine launches locally, a row on a device launches over
  `agents run --host <device> --remote-cwd <session cwd>`, so the sibling agent starts on the
  box that actually holds the transcript, in the same repo. This exact remote path
  is deliberately distinct from ordinary target-host launches, which keep passing
  the local workspace through portable `--cwd` for agents-cli to re-root. Source:
  `apps/factory/src/core/sessionBrowser.ts`, `apps/factory/src/vscode/extension.ts`
  (`pickSessionToFork`, `forkPickedSession`, `openSingleAgentWithQueue`'s new
  `remoteCwd`, emitted as the CLI's exact `--remote-cwd`), `apps/factory/package.json`.

## [0.9.305] - 2026-08-03

- **Session resume was broken everywhere, and `Agents: Resume` now batch-reopens
  crashed sessions.** Every session picker in the extension shelled out to
  `agents sessions list --all --json`; `sessions` has no `list` subcommand, so
  commander read the word "list" as a search query, matched nothing, and each
  picker reported "No sessions found". The call now passes the query positionally.
  On top of that fix, the new **`Agents: Resume`** command multi-selects sessions
  and opens each in its own editor tab with that agent's icon. It joins the
  durable listing with `agents sessions --active --json` and leads with sessions
  that are still running with **no terminal attached** — the tmux-hosted agent
  whose window closed or crashed — grouped under a `Detached` header and
  pre-ticked, since those are the ones the command exists to rescue. Then
  background (headless via `agents sessions detach`), parked, recent, and last
  the ones already open somewhere. A live session is listed even when it falls
  outside the recent-transcript cap, each session resumes in its own `cwd`, and a
  session stranded on another fleet box resumes over SSH against the machine that
  holds its transcript. Resume now covers every harness Factory presents — grok,
  kimi, droid and antigravity go through `agents run --resume` instead of being
  refused as "cannot resume". Source: `apps/factory/src/core/resumePicker.ts`,
  `apps/factory/src/core/prewarm.ts` (`buildVersionedResumeCommand`),
  `apps/factory/src/vscode/extension.ts` (`resumeSessionsBatch`,
  `openResumedSessionTerminal`, `listSessionsViaCli`).

- **Fix: the status bar showed a wrong version + account and no session id for a session it didn't spawn (e.g. under Remote-SSH).** Two separate defects. (1) Version/account were resolved from `agents view --json` — the box-wide *default installed* version and its signed-in account — which has nothing to do with which version/account a `--strategy balanced` launch actually selected for the running session; on a Remote-SSH box whose default differs from the session's, the bar read e.g. `Claude 2.1.220 <someone@gmail.com>` while the session was really `2.1.207 <the-real-account>`. The bar now sources version + account from `agents sessions <id> --json` (`SessionMeta.version`/`.account`), host-aware for offloaded `--host` tabs, and no longer substitutes a misleading machine default when no session id is known. The resolved identity is keyed to the session id that produced it and re-fetched when the terminal's live id changes, so a rerun or `/clear` in the same terminal (which can land on a different balanced version/account) can't leave the previous session's identity stuck on the bar. (2) The live-session-id lookup read `~/.agents/.cache/terminals/sessions/` — the `@agents/session-tracker` package's directory, which is not deployed on the fleet and stays empty — so it never resolved an id and the bar showed none. It now reads the actually-deployed SessionStart hook path `~/.agents/.cache/state/sessions/<pid>.json` — and, since that directory is owned by agents-cli and kept as an intentional unpruned graveyard, the extension no longer prunes it (it does targeted per-pid reads only, like the CLI). Regression tests parse `parseSessionIdentity` against both payload shapes and a captured live remote payload. Source: `apps/factory/src/core/liveSession.ts`, `apps/factory/src/core/remoteSessions.ts` (`parseSessionIdentity`), `apps/factory/src/vscode/remoteSessions.vscode.ts` (`fetchSessionIdentity`), `apps/factory/src/vscode/extension.ts` (`tryHydrateSessionIdentity`, `updateStatusBarForTerminal`, `tryHydrateLiveSessionId`).

- **`…/spawn` URI tabs now honour `agents.terminalMode`.** A session reopened as
  an editor tab — the path `agents sessions resume --vscodium` drives — was
  hardwired to a plain VS Code terminal regardless of the setting, so it ran
  outside tmux, died with the window, and left no tmux coords for the reconnect
  pass to re-attach. It was the only launch path opted out of the crash
  resilience every other spawn has. It now takes the same tmux-backed tab as
  `launchAgent`; a split lands inside the parent's tmux session rather than
  splitting the VS Code tab, which would strand the pane outside that session.
  Users on `agents.terminalMode: native` are unaffected.
  Source: `apps/factory/src/core/spawn.ts` (`resolveSpawnSurface`),
  `apps/factory/src/vscode/extension.ts` (`spawnCommandTerminal`).

## [0.9.304] - 2026-08-02

- **Respect per-device auto-launch preferences from the CLI (RUSH-2092).**
  Devices disabled with `agents devices disable <name>` are excluded from
  `New <Agent>` auto launches; devices preferred with `agents devices prefer
  <name>` get a ranking boost worth two running agents in the host score, so a
  preference wins ties but never sends work to a genuinely swamped machine.
  Disabled devices remain available through `New <Agent> (Pick Host)`.
  Preferences are read from `~/.agents/.history/devices/auto-launch.json`.
  Source: `apps/factory/src/core/deviceAutoLaunch.ts`,
  `apps/factory/src/core/launchHost.ts`,
  `apps/factory/src/core/launchHistory.ts`,
  `apps/factory/src/vscode/extension.ts`.

## [0.9.303] - 2026-08-02

- **Remove deprecated Gemini launch commands from the Factory palette (RUSH-2089).** Gemini is no longer supported; Antigravity is its replacement. The command palette no longer shows `Agents: New Gemini`, `Agents: New Gemini (Pick Host)`, `Agents: New Gemini (Auto)`, or `Agents: Setup Gemini`. Existing Gemini session parsing and transcript watching remain in place so old sessions are still readable. Source: `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.

## [0.9.302] - 2026-08-02

- **Every built-in harness now has a fast `New <Harness> (Auto)` launch command.** Auto launch ranks a persisted warm cache by successful recent device history plus cached load, memory, and running-agent count; it excludes offline, SSH-unreachable, signed-out, and throttled devices without performing SSH on the command path. Every launch updates per-device history, a cold/no-match cache warns and launches locally, and Droid explains that account health is unavailable before opening the host picker. Auto-supported harnesses launch with balanced account rotation. Source: `apps/factory/src/core/launchHistory.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.
- **Remote Factory launches explicitly forward the active workspace or isolated worktree cwd.** `openSingleAgent` now passes the resolved local cwd to `agents run --cwd` whenever it emits `--host`, allowing agents-cli's existing `toRemotePortable()` rewrite to re-root home-relative paths on the selected device. Local launches still emit no cwd flag. Source: `apps/factory/src/core/agents.ts`, `apps/factory/src/vscode/extension.ts`.
- **`Agents: Fork Current Session` starts a sibling agent with the active session's context (RUSH-2058).** The command keeps the source terminal running, reuses its harness and persisted launch device, asks agents-cli to balance the target account when that harness supports rotation, and queues `/continue <session-id>` into the new terminal. Non-rotating harnesses keep their normal account strategy. Source: `apps/factory/src/core/forkSession.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.
- **Fix: an offloaded tab's title still never resolved — the remote session payload is a different shape than the local one.** `agents sessions <id> --json` renders the detail view and emits `{ session, events }`; the same lookup with `--host` is routed to the peer and comes back as the FLAT array of `SessionMeta` records instead. `parseSessionLabelSource` only understood the envelope, so it returned `null` for exactly the offloaded tabs it exists to label, and the tab kept the bare agent prefix. Both shapes are now handled, with the session id disambiguating a multi-record payload so a tab can never be labelled from someone else's session. Caught by running the real command instead of trusting the fixtures — the original tests were written from the local shape, so they passed against a parser that could not read the wire. The regression test is driven by a captured live payload (`src/core/testdata/sessions-by-id-remote.json`). Source: `apps/factory/src/core/remoteSessions.ts`, `apps/factory/src/vscode/remoteSessions.vscode.ts`.

## [0.9.301] - 2026-08-02

- **`scripts/release.sh` now finds the machine that can publish instead of failing on the one you happen to be on.** The marketplace PATs live in the `vs-marketplace` secrets bundle on a single box, and tokens are never copied between hosts, so a release invoked from anywhere else died at `Error: vsce not installed` (or later, at the token check) with no path forward. The script now probes for that bundle — this box first, then `zion`, then `mac-mini` — and when it is elsewhere, re-invokes itself there over `agents ssh` against a **clean clone of the same commit**, so no host's working tree is touched and the vsix can't pick up local edits. `vsce`/`ovsx` are treated as tools rather than blockers and installed on demand. New flags: `--host <name>` pins the publish box, `--here` refuses to route (fails loudly instead). Source: `apps/factory/scripts/release.sh`.
- **The Harness Roster's run-strategy control now reads and writes the config the CLI actually uses.** `agentInventory.ts` pointed at `~/.agents-system/agents.yaml` — a directory that was folded into `~/.agents/.system/` and no longer holds `agents.yaml` (the CLI reads `run.<agent>.strategy` from `~/.agents/agents.yaml`, `apps/cli/src/lib/state.ts`). Every read returned `{}`, so the roster showed the same fallback for every agent and every toggle wrote to a file nothing reads. The fallback was also wrong: it reported `pinned`, while a bare `agents run <agent>` with no configured strategy is `balanced` (`getConfiguredRunStrategy`, `apps/cli/src/lib/rotate.ts`). On a machine with a `run.codex.strategy: available` override set, the roster reported `pinned` for all five managed harnesses; it now reports whatever `getConfiguredRunStrategy` resolves per agent, matching the CLI exactly. Source: `apps/factory/src/core/agentInventory.ts`.
- **An agent that hits its limit rotates to another account again — and does it on its own machine.** Auto-rotate had gone dead: the gate required a *pinned* version, and launches stopped pinning once balanced rotation took over account selection, so every terminal was skipped and an agent that hit `You've hit your session limit` simply sat there until someone noticed. The gate now reads the version actually running (`rotatableVersionOf` — the pin when there is one, else the version resolved from agents-cli metadata after spawn). It is also per machine end to end: account headroom is a property of the device, so an offloaded terminal is checked against `agents view --host <device>` rather than this box's quota, the view cache is keyed by `agent@host`, and the replacement launches with `agents run <agent>@<version> --interactive --host <device>` instead of a bare local binary — a rotate used to silently move the work onto the laptop. The continuation is inlined rather than sent as `/continue` for a remote rotate, since whether that slash command is synced is a fact about the device's filesystem, not this one's. Source: `apps/factory/src/vscode/watchdog.vscode.ts`, `apps/factory/src/core/resumeInBest.ts` (`rotatableVersionOf`, `buildHostLaunchCommand`), `apps/factory/src/vscode/extension.ts` (`rotateTerminalToBestVersion`, `fetchAgentsViewJson`).
- **The host picker leads with the machines you actually use.** It sorted only by online/offline, so with a dozen registered devices the two boxes you work on daily landed in an arbitrary spot in the list. Rows are now ranked by recency-weighted session history per machine (`rankHostsByUsage`, sharing the exact scorer behind the agent ranking so the two cannot drift), with online still outranking usage — an offline box can't take the launch however familiar it is — and each row shows its recent session count so the order is legible. The fleet sweep is cached for a minute and a failure falls back to sorting by name, so the picker never hangs behind it. Also fixes a literal NUL byte in the `BALANCE_ID` sentinel, which worked at runtime (the sentinel is only compared with itself) but made `grep` classify `extension.ts` as a binary file and skip it. Source: `apps/factory/src/core/agentUsage.ts`, `apps/factory/src/vscode/extension.ts` (`pickLaunchHost`, `fetchHostUsageScores`).
- **An agent launched on another device is no longer a second-class tab: it gets a session id, an auto-generated title, and a resume that goes back to its own machine.** A "Pick Host" launch deliberately skipped minting a Claude session id and let the remote coin its own, so the extension never learned it. Everything downstream keys off that id, and all of it silently did nothing for offloaded tabs: the status bar stayed on the placeholder "Agents" with no id to copy, the auto-label poller returned early on the missing id so the tab title never advanced past the bare agent name, and Session Resume / Trace / Fork / Continue-in-New had nothing to act on. The id is now minted for local and remote alike and passed as `--session-id`, which `agents run --host` adopts for the remote session (`resolveHostSessionId`), so the id the tab shows is the id the session actually has. Offloaded tabs also record their device (`EditorTerminal.host`, persisted across reloads and reopens): the label poller resolves its title over `agents sessions <id> --host <device> --json` — the transcript lives on that machine, so the local session-file scan and jsonl preview it used before had nothing to read — and a restore or "Reopen Last Session" resumes through `agents run --host … --resume` instead of running `claude -r <id>` locally against an id this box has never seen. Source: `apps/factory/src/vscode/extension.ts` (`openSingleAgent`, `fetchRemoteAutoLabel`), `src/vscode/terminals.vscode.ts`, `src/vscode/remoteSessions.vscode.ts` (`fetchRemoteSessionLabelSource`), `src/core/remoteSessions.ts` (`parseSessionLabelSource`), `src/core/prewarm.ts` (`buildVersionedResumeCommand`), `src/core/sessions.persist.ts`.
- **A remote agent opens in the project you launched it from.** Requires agents-cli ≥ 1.20.82: a `--host` run with no explicit `--cwd` now mirrors the launching workspace's home-relative path onto the device, so a Pick Host tab starts in the repo instead of the remote home. No extension change beyond inheriting the CLI behavior — the spawned `agents run` already runs in the workspace directory.

## [0.9.300] - 2026-08-02

- **Launch is now one engine, and balanced is the default — the per-harness command sprawl is gone.** Every "New agent" command used to re-implement the same resolve-host → resolve-harness → resolve-version pipeline inline, which spawned ~40 palette commands (per harness: `(Pinned)`, `(Latest)`, `(Balanced)`, `(Pick Version & Host)`, `(Auto Host)`, `(Auto)`, plus two global version pickers) and a QuickPick that asked you to pick the *agent first, then* the host. Now a single `launchAgent(context, {agentKey?, host?, pickHost?, local?})` engine owns it: it resolves the **host** (explicit, device-first, or least-busy healthy), the **harness** (explicit, or auto from what's installed + has headroom *on the chosen host* via `hostHasUsableVersion`, ranked by recent usage), and the **version/account** — which is **always balanced** (token-usage-aware rotation that skips signed-out / rate-limited accounts). Manual version picking is gone entirely: no `(Pinned)`, no `(Latest)`, no version pickers. The surface per harness collapses to two — `New <Harness>` (balanced, local) and `New <Harness> (Pick Host)` — plus the global `New Agent` (auto everything) and `New Agent (Pick Host)`, which is now **device-first**: you pick the host, and the harness is auto-selected from what's available there. Short codes (`(CC)`, `(CX)`, …) are dropped from the command titles. 41 commands removed; keybindings unaffected. Source: `apps/factory/src/vscode/extension.ts` (`launchAgent`, `resolveAutoAgentKey`), `apps/factory/package.json`.
- **Host selection is now agent-aware, and a new "New Claude (Auto)" command picks host + strategy in one step (RUSH-2025).** "New Claude (Pick Host)" / "(Auto Host)" could land on a device with no signed-in, usable Claude — the host picker only ranked by running-agent count. Now, when picking or auto-selecting a host for a specific agent, the balancer probes each candidate's version health (via `agents view <agent> --host <device> --json`) and hardware load/memory (via `fetchDeviceStats`), **drops devices with no signed-in, non-throttled version**, and ranks the rest by a composite score (running agents dominate; load and memory pressure break ties so a crashing/thrashing box is deprioritized). If no fleet device has a usable version, it falls back to a local launch with a clear warning instead of launching into a broken agent. Pick Host and Auto Host now also launch with `--strategy balanced`, so the CLI's account rotation routes around a signed-out / throttled version on the chosen device. (This agent-aware host ranking is retained; the separate per-agent "Auto" / "Auto Host" commands it introduced have since been folded into the single launch engine above — balanced host + version selection is now the default for every launch, so those commands were removed.) Pure ranking logic (`deviceHasUsableVersion`, `hostScore`, `pickBestHost`) lives in `src/core/launchHost.ts` and is unit-tested without live SSH. Source: `apps/factory/src/core/launchHost.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/package.json`.
- **`Agents: New Agent` (⌘⇧A) is now a smart three-tier launch instead of always
  Claude (RUSH-2029).** The generic New Agent command previously hard-coded the
  configured default agent. It now (1) picks the agent TYPE by recent/frequent
  usage — aggregating fleet-wide session history (`fetchRecapSessions`) into a
  per-agent preference that weights the last 24 hours heavily while still counting
  longer-term frequency, and falling back to the configured default when there is
  no usable history; (2) launches with `--strategy balanced` so the version/account
  is load-balanced across healthy signed-in accounts; and (3) auto-picks the
  least-busy healthy device via `resolveBalancedHost`. Uninstalled or signed-out
  agents are excluded from selection, and a status-bar note reports the choice
  (e.g. `New Agent: Codex (balanced on yosemite-s0)`). The explicit per-agent
  commands (`New Claude …`, `New Codex …`) are unchanged. New pure selector
  `src/core/agentUsage.ts` (`rankAgentsByUsage` / `pickAgentByUsage`) is unit-tested
  against fixture history. Source: `apps/factory/src/core/agentUsage.ts`,
  `apps/factory/src/vscode/extension.ts`.
- **Native-mode agent terminal tabs now close automatically when the agent exits (RUSH-2026).** In native (non-tmux) terminal mode, the launch command is now prefixed with `exec` so the shell process replaces itself with the agent runner. When the agent exits the terminal process exits too and VS Code closes the tab automatically — no manual close needed. This mirrors the existing tmux pane-died behaviour. Shell tabs (the SH agent type) and tmux-mode terminals are unaffected. Remote `--host` launches get the same treatment: the local SSH wrapper exits with the remote session. Source: `apps/factory/src/core/agents.ts` (`wrapNativeAgentCommand`), `apps/factory/src/vscode/extension.ts` (`openSingleAgent`).

- **Interactive agent launches now default to `--mode auto` instead of stalling in read-only plan mode (RUSH-2038).** Launching Codex, Claude, Gemini, Cursor, OpenCode, or Antigravity from Factory without explicitly choosing a mode now runs in `auto` (writable-but-gated), so the agent can edit files immediately. Previously the CLI default of `plan` was inherited, causing Codex to start with `--sandbox read-only` and wait indefinitely for approval. `buildAgentLaunchCommand` is now in `src/core/agents.ts` so it is unit-testable without a VS Code harness. Source: `apps/factory/src/core/agents.ts`, `apps/factory/src/vscode/extension.ts`.
- **A reloaded terminal tab no longer gets bound to the wrong session (wrong id,
  account, and version).** On a window reload — especially a Remote-SSH
  reconnect, where VS Code drops `terminal.creationOptions.env` — `scanExisting`
  lost the tab's `AGENT_SESSION_ID` and its name chunk, then fell back to
  matching the persisted store by agent prefix + "most recently created". That
  heuristic has no tie to the pane, so a Claude tab actually running one session
  could be shown as a sibling session that merely looked newest (observed: status
  bar read `ffa1f432… 2.1.220 <gmail>` while `/status` in the same pane reported
  `e2030c92… 2.1.186 <getrush>`). Reload now first asks the process actually
  running in the pane: it walks the tab's live process tree (`findAgentInTree`),
  gated to the tab's own agent, and reads the running agent's own
  `--session-id`/`--resume` arg, which wins over every env/name/persisted
  heuristic. `extractSessionIdFromArgs` also learned to recognize
  `--resume <uuid>` (claude's native resume form) — previously only
  `--session-id` was parsed, so a resumed pane's live id was invisible and the
  shell-adoption path fell to a mtime-nearest session-file guess. Source:
  `apps/factory/src/vscode/terminals.vscode.ts` (`scanExisting`),
  `apps/factory/src/monitor/readinessDetector.ts` (`findAgentInTree`,
  `selectAgentFromCandidates`),
  `apps/factory/src/core/terminalReadiness.ts` (`extractSessionIdFromArgs`).

- **Stuck Claude tab labels self-heal, and an existing session name is reused
  before summarizing.** Two follow-ups to the derived-label fix: (1) On reload,
  a tab already reading `CC - muqsitnawaz-91` had that derived placeholder
  re-adopted as a sticky manual label, which blocked the auto-label poller
  forever. The label paths (poller-arm and focus) now detect a label that is
  EXACTLY the session's own derived name and clear it so a real name/topic
  resolves — matched against the session file, so a genuine label (e.g.
  "Daemon Creds") or an old-CLI name is never touched. It only clears a label +
  its store entry; the tmux session and agent are never affected. (2) The
  auto-label path now reuses Claude's persisted `/status` title as soon as one
  exists — even before a first user message is captured — and only summarizes
  with the LLM when there is no existing name. New `readClaudeSessionNameInfo`
  exposes the session's name + source for the heal check.

## [0.9.299] - 2026-08-01

- **The extension no longer runs its own stall-detection/nudge injector — the
  agents-cli daemon watchdog is the sole injector.** The extension's autonomous
  watchdog tick used to `fs.stat` each agent session file, call a Claude Haiku
  headless instance to decide whether an agent was stalled, and inject a nudge
  by typing into the terminal. In real setups (agent terminals in VS Codium) it
  fired the wrong message at the wrong time and double-nudged against the CLI
  daemon watchdog, so its active poking is retired: the nudge injection, the
  headless/smart-agent stall decision, the per-terminal opt-out command
  (`agents.watchdog.toggleTerminal`), and the monitor's centralized stall
  broadcast are all removed, along with the `stallNudge`, `stallSeconds`,
  `cooldownSeconds`, and `useSmartAgent` settings. The extension keeps the one
  capability the CLI lacks — **version auto-rotate**: when a version-pinned
  Claude terminal exhausts its quad it still spawns a fresh terminal on the best
  signed-in version and replays `/continue` (`agents.watchdog.autoRotate`,
  `rotateCooldownSeconds`, `tickSeconds`; the `enabled` master switch now gates
  auto-rotate). The Factory Floor **watchdog status card stays**, now rendering
  the `~/.agents/.cache/logs/watchdog.log` feed the CLI daemon writes. The
  on-demand MCP peer-nudge path (`send_nudge`/`send_to_agent`) is unchanged.

- **Claude terminal tabs get a real topic label again, not the repo name.**
  Claude 2.1.207+ auto-derives a placeholder session name `<dirname>-<n>`
  (e.g. `agents-cli-55`, tagged `nameSource: "derived"`). The extension used it
  verbatim as the tab label and, worse, it short-circuited the LLM topic path —
  so every Claude tab read `CC - agents-cli-55` instead of what the agent was
  working on, while non-Claude tabs (which skip that path) showed real topics
  like `KM - Create Tickets`. A derived name is now treated as no name, so the
  tab falls through to the LLM-generated topic. Genuine titles are still used.
  The auto-label poller also refreshes the tab title itself (not just the status
  bar) when a label resolves on the active tab, so it no longer takes a focus
  change to appear.
- **A dropped SSH connection no longer destroys running agents (reconnect
  resilience).** Agents run in detached tmux sessions on the shared socket, so
  they survive a network drop — but on a Remote-SSH teardown VS Code fires
  `onDidCloseTerminal` for every editor terminal, and the old cleanup
  unconditionally ran `agents tmux kill`, killing healthy agents just because
  the client blinked. `cleanupTmuxTerminal` now queries the shared server first
  and kills ONLY on a true agent exit (session gone or every pane dead); a live
  pane is treated as a client/network detach and left alive for re-attach. The
  liveness probe fails SAFE: when no tmux binary is reachable (an install outside
  the probed paths — asdf, mise, Nix, Linuxbrew, a container prefix) the probe
  reports "couldn't confirm" rather than "gone", and the kill decision declines
  to kill, so a non-standard tmux location can no longer silently destroy live
  agents on every detach. The
  terminal↔tmux mapping (session/socket/pane/pid) is persisted so it survives an
  extension reload, and on reconnect (window regains focus, or the extension
  reactivates) every mapped session that is still live but has no attached
  client is re-attached via `agents tmux attach` — never a new session, so the
  agent is never restarted — with bounded-backoff retry on transient SSH
  failures. On a real extension-host reload, tmux-backed sessions are now the
  exclusive responsibility of the reconnect pass: `restoreAgentTerminals` skips
  any persisted session carrying a tmux mapping (it no longer recreates a plain
  terminal and resumes it from the CLI session file, which would restart the
  agent) and preserves that mapping on disk instead of wiping it, so the pass can
  `agents tmux attach` the still-live session and a subsequent reload still has
  the mapping to recover from. On a network drop that does NOT reload the
  extension host (the common Remote-SSH case), a single `onDidCloseTerminal`
  handler now decides the whole close from one detach-vs-exit classification: on a
  live detach it marks the entry detached and preserves its durable mapping (so
  the reconnect pass can re-attach even a session spawned in the current window),
  instead of unconditionally unregistering it and overwriting the on-disk mapping
  to exclude it — the previous behavior orphaned freshly-spawned agents. A
  permanent reattach failure (an unknown agent prefix) is now non-retryable, so it
  no longer burns the backoff budget on every window-focus event. The Factory
  Floor grid re-arms its polling on reconnect so it no longer looks frozen.
  Source: `apps/factory/src/vscode/tmux.ts`,
  `apps/factory/src/vscode/reconnect.ts`, `apps/factory/src/vscode/extension.ts`,
  `apps/factory/src/vscode/terminals.vscode.ts`,
  `apps/factory/src/core/sessions.persist.ts`,
  `apps/factory/src/vscode/settings.vscode.ts`.

- **Detach / Attach — send a running agent to the background from the editor.**
  Two commands: **Agents: Detach (Send to Background)** (`agents.detach`,
  `cmd+k cmd+b` on a focused agent terminal, also in the terminal right-click menu)
  sends the active agent's session to the background via `agents sessions detach <id>` —
  the interactive process stops, the tab closes, and the agent keeps working
  headless. **Agents: Attach (Bring to Foreground)** (`agents.attach`,
  `cmd+k cmd+a`) picks a backgrounded/parked agent and resumes it interactively in
  a new terminal via `agents sessions attach <id>`. The Floor session model now carries the
  CLI's `presence` (`attached` / `background` / `parked`). Source:
  `apps/factory/src/vscode/extension.ts`, `apps/factory/src/core/remoteSessions.ts`,
  `apps/factory/package.json`.
- **agents-dbg now has a 0.1.0 Mac release pipeline (RUSH-1015).** The standalone
  Electron app packages as `agents-dbg.app` with the `com.phnxlabs.agents-dbg`
  bundle id, hardened-runtime entitlements, Developer ID signing, and
  electron-builder notarization when Apple credentials are present. The new
  root `scripts/release.sh` dry-runs by default, builds and verifies the
  notarized app on `--confirm`, uploads GitHub release assets, and updates
  `muqsitnawaz/tap` formula/cask entries through `scripts/bottle.sh`, while
  `scripts/install-agents-dbg.sh` provides the public curl installer. Source:
  `apps/factory/app/package.json`, `apps/factory/app/scripts/build.sh`,
  `.github/workflows/agents-dbg-release.yml`, `scripts/release.sh`,
  `scripts/bottle.sh`, `scripts/install-agents-dbg.sh`.

## [0.9.295] - 2026-07-21

- **Fleet-aware Launch Matrix — spawn a Quick Launch agent on a specific device or balanced across the fleet.** Each Quick Launch slot (⌘⇧0–9) gains a **Run on** target: this Mac (default, unchanged), a registered device (offloaded over SSH via `agents run --host`), or ⚖ Balanced — auto-pick the least-busy online device, with an optional pool restriction. The collapsed row shows the target (`↗ <device>` / `⚖ balanced`); a new optional chord **⌘⌥⇧0–9** fires a slot but prompts for the host once. Every non-shell agent (Claude, Codex, Gemini, OpenCode, Cursor, Antigravity, Grok, Kimi, Droid) also gains palette commands mirroring the version triad on a host axis — **(Pick Host)**, **(Pick Version & Host)**, **(Auto Host)** — plus generic `New Agent (Pick Host)` / `(Pick Version & Host)`; a host target routes ANY agent through `agents run --host` so grok/kimi/droid (raw-binary local launches) get parity. Balanced picks by fewest running agents, excluding the local interactive machine. Source: `apps/factory/src/core/settings.ts`, `apps/factory/src/core/launchHost.ts`, `apps/factory/src/vscode/extension.ts`, `apps/factory/ui/settings/components/panel/LaunchMatrix.tsx`, `apps/factory/package.json`.
- **"Open Terminal" now works for a session running on a remote device.** A Floor card's terminal button already carried the agent's `host`, but the `focusSession` handler dropped it and always ran `agents sessions focus <id>` detached on the local machine — so for a session living on another device (`host !== this-mac`) the `ssh -tt` resume had no TTY to land in and nothing appeared. It now branches on host like the sibling `focusRemoteSession` (tmux) path: local stays a detached native-tab spawn; a remote host opens a VS Code terminal running `ssh -t <host> agents sessions focus <id> --local`, which attaches the live tmux pane or resumes it in the ssh TTY on the peer that owns it. Reuses the CLI's existing `--host`/cross-host focus engine rather than reimplementing SSH. Source: `apps/factory/src/core/remoteSessions.ts` (`buildRemoteFocusCommand`), `apps/factory/src/vscode/settings.vscode.ts` (`case 'focusSession'`), `apps/factory/src/core/remoteSessions.test.ts`.
- **Agent panel checklist now consumes the CLI's computed `session.todos` instead of re-parsing the transcript (RUSH-1503).** The per-terminal panel derived its checklist by re-implementing the CLI's session engine — a `TodoWrite`/`update_plan` transcript parser (`extractTodoProgress` + helpers in `core/session.activity.ts`). That parser is deleted; the panel now reads `session.todos` off the same `agents sessions <id> --json` call it already makes for tool stats (`getSessionToolStatsViaAgentsCli`), mapped into the panel shape by `todoProgressFromCli`. One source of truth for checklist state, no extra subprocess, and Codex plan progress is now covered by the CLI (so the panel no longer regresses for Codex). Source: `apps/factory/src/core/session.activity.ts`, `apps/factory/src/core/handoff.ts` (`SessionToolStats.todos`), `apps/factory/src/vscode/agentPanel.vscode.ts`, `apps/factory/src/core/session.activity.test.ts`.
- **Cloud agent activity feed no longer freezes on the first streamed event (RUSH-1558).**
  `parseCloudSummaryIncremental` was returning its internal mutable cache array by
  reference; React's `useMemo` in `CloudActivityFeed` keyed off that reference and
  never saw it change as new events were pushed in place, so the detail pane's
  live feed rendered only the first commit and stopped advancing. It now always
  returns a fresh array. Source: `ui/settings/components/mission-control/cloudActivity.ts`.
- **Grok, Kimi, Antigravity, and Droid are now first-class launchable agents with real brand logos.** They were already in the CLI registry snapshot but only Claude/Codex/Gemini/OpenCode/Cursor were surfaced in the extension. New terminal-spawn commands `agents.newKimi` / `agents.newDroid` (Grok/Antigravity already existed) join the presentation registry with chips **AG / GK / KM / DR** and prefixes `ag / gk / km / dr`; each carries a real brand mark that renders in the terminal tab bar and the dashboard roster/dispatch/launch surfaces. Grok's and Droid's monochrome marks ship dark+light variants (`grok-light.png`, `droid-light.png`) registered in `theme.vscode.ts` so they stay legible on the light/cream tab bar. Gemini is unchanged (kept alongside Antigravity, not deprecated). Source: `apps/factory/src/core/agents.ts`, `apps/factory/src/core/utils.ts`, `apps/factory/src/core/settings.ts`, `apps/factory/src/vscode/settings.vscode.ts`, `apps/factory/src/vscode/theme.vscode.ts`, `apps/factory/package.json`, `apps/factory/assets/{grok,grok-light,kimi,antigravity,droid,droid-light}.png`, `apps/factory/ui/settings/constants/index.ts`, `apps/factory/ui/settings/types/index.ts`, `apps/factory/ui/settings/components/mission-control/{AgentAvatar,floorAdapter,floorModel}.ts*`, `apps/factory/ui/settings/components/panel/HarnessRoster.tsx`.

- **Security: hardened the webview→host trust boundary — untrusted webview messages can no longer open arbitrary-scheme URLs, run arbitrary VS Code commands, inject shell, or write outside the asset dir.** Webview messages are untrusted input, but several host handlers forwarded webview-supplied values straight into privileged APIs with only a `typeof` guard. Fixed at the source via a shared `webviewSecurity` module: (1) `openExternal` now goes through `openExternalUrl`, which allowlists `https`/`http`/`mailto` and refuses `file:`/`command:`/`vscode:`/`javascript:`/`data:` (6 call sites across `agentPanel`, `issuesPanel`, `settings`); (2) the generic `executeCommand` message is gated by `isAllowedWebviewCommand` to the theme-toggle + `agents.new*` set the UI actually dispatches, not any command id; (3) `factoryAnswer` now single-quote-quotes both `teamId` and `text` via `shq` instead of an incomplete double-quote escape that left `teamId` open to shell injection; (4) the custom markdown editor's `saveAsset` runs the webview filename through `path.basename` so a `../../` name can't escape the `.assets` dir. The pure allowlist predicates live in `src/core/webviewSecurity.ts` with unit tests. Source: `apps/factory/src/core/webviewSecurity.ts`, `apps/factory/src/core/webviewSecurity.test.ts`, `apps/factory/src/vscode/webviewSecurity.ts`, `apps/factory/src/vscode/{agentPanel,issuesPanel,settings,customEditor}.vscode.ts`.
- **Custom markdown editor can now play embedded videos (RUSH-1437).** The editor's TipTap VideoBlock inserts videos as `data:` URLs, but the webview CSP had `default-src 'none'` and no `media-src`, so the `<video>` element was blocked from loading. Added a scoped `media-src data:` directive (only `data:`, not a wildcard). Source: `apps/factory/src/vscode/customEditor.ts`.

## [0.9.294] - 2026-07-15

- **Fix: extension failed to activate — every `agents.*` command reported "command not found" (e.g. `agents.dispatchTask`, `agents.configure`).** The published `0.9.293` VSIX shipped without its `node_modules`, so `require("yaml")` (in `core/agentInventory`, `sessions.persist`, `swarmifyConfig`) threw during `activate()`, aborting before any command registered. This release is a clean rebuild that bundles the runtime deps. To prevent recurrence, `scripts/build.sh` now unzips the freshly-packaged VSIX and hard-fails the build if `yaml`, `node-pty` (incl. its `darwin-arm64` native prebuild), `sql.js`, or `ws` are absent — a dependency-less package can no longer reach the marketplace. Source: `scripts/build.sh`.

- **Factory Floor shows live plan progress for remote / device-dispatched agents (RUSH-1380).** The CLI now carries each session's latest `TodoWrite` on `ActiveSession.todos`; the remote adapter maps it onto the feed's checklist (previously hardcoded empty for status-only remote sessions), so a headless agent on another machine now renders an N/M pill in its header, the `CardChecklist` in its feed card, and a `TodoChecklist` in its detail pane. When there's no live tool action, the now-line falls back to the in-progress step. Source: `apps/factory/src/core/remoteSessions.ts` (`RemoteSession.todos`, `normalizeTodos`), `ui/settings/components/mission-control/floorAdapter.ts` (`toFloorAgentFromRemote`), `FeedItem.tsx`, `UnifiedAgentsPane.tsx`, `floor.css`.

## [0.9.292] - 2026-07-13

- **Factory recognizes every current agents-cli harness.** The checked-in CLI
  registry snapshot now includes Hermes and ForgeCode, keeping Factory's agent
  metadata aligned with the canonical `AgentId` union. Source:
  `src/core/agents.cli.ts`.
- **Remote plan previews are isolated by source path (RUSH-1631).** Cache key is `host/sha1(path)/basename` so two worktrees sharing a plan basename no longer clobber each other. Source: `src/vscode/settings.vscode.ts`.
- **Windows remote dispatch uses distinct PowerShell stdout/stderr log paths (RUSH-1622).** `Start-Process -RedirectStandardOutput` and `-RedirectStandardError` cannot share a file; use `.out.log` / `.err.log`. Source: `src/vscode/settings.vscode.ts`.

- **Factory Floor group controls now support Subgroup (RUSH-1544).**
  The live feed and Backlog controls can render a second grouping axis, excluding
  the primary axis to avoid duplicate grouping. Nested section headers make
  combinations like Project -> Host and Project -> Source visible without
  switching views. Source: `ui/settings/components/mission-control/FloorControls.tsx`,
  `UnifiedAgentsPane.tsx`, `BacklogCenter.tsx`.
- **Factory Floor backlog refreshes while the view stays open (RUSH-1578).**
  The Floor and Bench tabs now re-fetch unified Linear/GitHub tasks on a
  30-second active-view cadence, so external ticket status changes no longer
  require closing and reopening Factory. Source: `ui/settings/App.tsx`.
- **Factory Floor surfaces agent-created tickets as clickable Linear artifacts (RUSH-1547).**
  Session cards and detail panes now render linked Linear badges for carried/created
  ticket refs and include commit chips in the produced-artifacts row, so PRs,
  tickets, teams, plans, and commits are visible without reading the transcript.
  Source: `ui/settings/components/mission-control/FeedItem.tsx`,
  `UnifiedAgentsPane.tsx`.
- **Factory tmux tabs close when their top-level pane exits (RUSH-1543).**
  Tmux-backed agent tabs now install a guarded pane-death hook: exiting a user
  split still closes only that split, but when the last remaining pane dies,
  Factory detaches, kills the tmux session, and lets the VS Code
  terminal close instead of lingering on a "Pane is dead" banner. Source:
  `src/vscode/tmux.ts`.
- **Factory Floor's full sidebar is now resizable (RUSH-1539).** Drag the right
  edge to widen or narrow the project/host sidebar; the chosen width persists
  with the existing Floor preferences. Source:
  `ui/settings/components/mission-control/FloorSidebar.tsx`,
  `UnifiedAgentsPane.tsx`, `floor.css`.
- **Per-session rate-limit badge on feed cards (RUSH-1523).** Sessions whose transcript shows a rate/usage limit render a distinct **rate limited** pill so they no longer look like healthy running agents. Source: `floorModel.ts` (`rateLimited`), `floorAdapter.ts` (`detectSessionRateLimited`), `FeedItem.tsx`.
- **Feed cards get an Open/Resume-in-terminal action (RUSH-1520).** Each card shows a Terminal button that focuses an open tab, attaches a tmux rail, or runs `agents sessions focus <id>` — so the operator jumps into the session instead of only opening the side panel. Source: `ui/settings/components/mission-control/FeedItem.tsx`, `UnifiedAgentsPane.tsx` (`openTerminalForAgent`).
- **Filter + group-by controls live in the feed header bar next to Save view (RUSH-1526).** The feed's own header (`SavedViews` / `feed-header-bar`) now carries Group + status chips (Needs you / Running / Idle / Failed) + agent-abbr chips, so operators filter and group where they are looking — not only from the top FloorControls bar. Source: `ui/settings/components/mission-control/SavedViewsBar.tsx`, `UnifiedAgentsPane.tsx`, `floor.css`.
- **Floor Group defaults to Outcome (ticket/PR/worktree) instead of Project (RUSH-1479).** Fleet-scale floors collapse agents under the deliverable they serve so the operator sees initiatives, not ~1,100 processes. Source: `ui/settings/components/mission-control/floorModel.ts` (`outcomeLabel`, `FloorGroupBy`), `FloorControls.tsx`, `UnifiedAgentsPane.tsx`.
- **The extension's parallel session stack is gone — live-session state now comes from the CLI (#741).**
  Activity, waiting-for-input, awaiting reason, and tokens/sec ride the
  `agents sessions --active --json` payload (`ActiveSession.activity` /
  `awaitingReason` / `tokPerSec`) instead of being re-derived from per-agent
  transcript-tail parsers; the Recent Sessions picker is backed by
  `agents sessions --json` (fixing the stale `~/.gemini/sessions` scan — the CLI
  scans the real `~/.gemini/tmp`); the machine-wide session watcher configures
  its roots from `agents sessions --roots --json`; and the agent registry
  (`BUILT_IN_AGENTS` launch commands, `.agents` config agent ids) derives from a
  CLI-registry snapshot validated against `apps/cli` source in tests — which
  also fixes antigravity launching a nonexistent `antigravity` binary instead of
  `agy`, and `.agents` files silently dropping newer agents (grok, droid, …).
  Source: `apps/factory/src/core/{session.activity,remoteSessions,agents,agents.cli,swarmifyConfig}.ts`,
  `apps/factory/src/vscode/{remoteSessions,terminals,watchdog,settings,sessions}.vscode.ts`,
  `apps/factory/src/monitor/{sessionParse,sessionWatcher}.ts`.
- **Internal: `foreman.vscode.ts` reuses the shared `humanElapsed` helper (#753).** Deleted the identical private `humanElapsedFromMs` copy and imported the exported `humanElapsed` from `core/foreman.digest.ts`. No behavior change. Source: `apps/factory/src/vscode/foreman.vscode.ts`.
- **Windows device dispatch no longer hardcodes `bash -lc`.** `dispatchToDevice` selects the remote shell from the device registry platform (PowerShell `-EncodedCommand` on windows; bash on POSIX), so Dispatch v2 works on win-mini. Source: `apps/factory/src/core/deviceDispatchShell.ts`, `apps/factory/src/vscode/settings.vscode.ts`. (RUSH-1481)

### Fixed

- **Factory watchdog logs now use the canonical cache path documented by AGENTS.** The
  watchdog bridge, watchdog tick writer, and Factory Floor log reader share one
  `WATCHDOG_LOG_PATH` at `~/.agents/.cache/logs/watchdog.log`, matching the
  post-restructure docs and CLI migration target. (RUSH-1516)
- **Factory Floor cards now use human session names instead of UUID slices (RUSH-1532).**
  Remote sessions preserve explicit labels separately from task topics, and the Floor
  card header prefers label, topic, branch, ticket, and worktree metadata before falling
  back to a generic agent title. Cloud single-agent rows now use their configured name
  or prompt line instead of `agent-019e30a2`-style identifiers.
- **NEEDS YOU precision — finished/stopped agents no longer masquerade as needing
  input (RUSH-1522).** Two gates tightened. (1) `derivePhase` now checks terminal
  statuses first: a `completed`/`stopped`/`failed` agent can no longer be lifted
  into the `waiting` phase by a stale `waitingForInput` flag — it lands in
  DONE/idle/FAILED where it belongs. (2) The prose trailing-"?" waiting heuristic
  now decays: past 30 minutes with no session writes (`PROSE_QUESTION_FRESH_MS`),
  a session that signed off with "anything else?" stops classifying as waiting —
  previously such sessions sat in NEEDS YOU indefinitely (the reported card was 13
  days stale). Structural signals are exempt: a genuinely pending
  `AskUserQuestion`/`ExitPlanMode` still lands in NEEDS YOU at any age. Source:
  `ui/settings/components/mission-control/floorModel.ts` (`derivePhase`),
  `src/core/session.activity.ts` (`detectWaitingForInput`),
  `src/core/remoteSessions.ts` (`enrichWithSessionContent`),
  `src/vscode/terminals.vscode.ts`.

### Added

- **Factory Floor cards now show session screenshots and attachments as previewable artifacts (RUSH-1524).**
  Session parsers carry structured attachment metadata from prompt image/document
  blocks through the CLI JSON, remote session bridge, VS Code webview resource
  roots, and Floor cards. Image attachments render as thumbnails; any attachment
  opens through the host preview bridge.
- **Factory Floor cards now surface plan artifacts for preview (RUSH-1525).**
  Session output, recent worktree files, and attachment refs are scanned for
  `.html` and `ref-*.md` plan files; matching cards show plan chips that open HTML
  plans externally and Markdown plans in the editor preview.
- **Project rollups — one glance answers "what's happening in this project".** The
  rail's Projects flyout rows now carry dim sub-counts (open backlog tickets and
  distinct open PRs) next to the live agent count, and each card in the Projects
  pane gains an activity line — "3 running · 1 waiting · 4 backlog · 2 PRs ·
  active 40m ago" (or "quiet") — all derived in one pass from the live feed and
  backlog the Floor already holds.
- **PR board — every open PR the floor's agents produced, in one actionable list.**
  A new PRs center tab aggregates the live feed's PR URLs and shows, per PR: CI
  state, review decision (approved / changes requested / review required), merge
  conflicts, a chip for the agent that owns it (jumps to its card), and a **Merge**
  button that appears only when the PR is open, not draft, approved, CI-green, and
  conflict-free. Rows are ranked for action: ready-to-merge first, then red CI /
  conflicts, then changes-requested. Merge runs plain `gh pr merge --rebase` (never
  `--admin` — branch protection stays in force); refusals surface inline on the row.
- **Recap — a work ledger for "what happened while I was away".** A new Recap center
  (clock button on the rail, Recap tab in the strip) lists finished sessions across the
  whole fleet, grouped by day, each with its task line, project · host · branch, ticket,
  a PR link, and the session's real duration and cost. Day headers roll up sessions,
  spend, and PRs (e.g. "Today — 12 sessions · $18.40 · 3 PRs"). No new bookkeeping: the
  CLI's `agents sessions` metrics (`durationMs`, `costUsd`, `tokenCount`) were already
  computed per session and are now carried through instead of dropped. Live sessions are
  excluded — the feed owns what's running, the ledger owns what finished.
- **The backlog now shows who is already working each ticket.** A ticket an agent
  carries gets an in-flight chip on its row (phase dot + agent abbr, `+N` when several
  are on it; hover for the full roster), and the ticket detail pane gains an **In
  flight** section — one row per worker with phase, host, and PR, each jumping to that
  agent's card. Dispatching onto a ticket that's already in flight is guarded: the
  button turns amber, reads "Dispatch anyway", and names the agent already on it, so a
  second agent is a deliberate choice instead of an accident.

### Changed

- **Plan-watch now reads from the CLI's canonical `session.plan` field instead of re-parsing
  raw JSONL.** `watchForPlan` previously read the session `.jsonl` file and re-implemented the
  `ExitPlanMode` scanner (`parsePlanFromClaudeJsonl`) — a duplicate of the CLI's session state
  engine. The CLI now carries `plan` on `SessionMeta` (surfaced via `agents sessions <id>
  --json`), so the extension polls the CLI directly and `parsePlanFromClaudeJsonl` is deleted.
  No behavior change for the Floor's plan-ready surface. (RUSH-1505)

- **The collapsed Floor rail's Projects and Hosts buttons are now flyout menus instead of
  three buttons that all expanded the sidebar.** Click Projects for the curated project
  list (live agent count + amber waiting count per project, plus any uncurated project
  that has agents running) and jump straight to that scope; click Hosts for the fleet
  roster with health dots and per-host counts. The Hosts button carries a red dot whenever
  any host is offline, a lime **Dispatch** button now sits at the top of the rail, and the
  `»` chevron is the single expand affordance. Active states are fixed across the board
  (Backlog lights when the backlog center is showing; a project/host scope lights its
  button), and the rail-vs-sidebar choice is remembered across reloads.

### Fixed

- **"Needs you" in the rail and sidebar now actually filters the feed.** It used to clear
  all filters — identical to "All agents" — despite the amber badge. It now toggles the
  same `needs` status chip the controls bar drives, and "All agents" clears it.

## [0.9.291] - 2026-07-09

### Fixed

- **NEEDS-YOU cards no longer show a doubled, contextless "Thinking…".** A paused/idle
  card rendered the live-activity fallback string `"Thinking..."` twice — once as the card
  body and again as the green now-line — because `resp` fell back to the live-activity
  string when the agent had no last message. `resp` is now strictly the agent's last real
  message (empty when there is none), and the now-line renders only while an agent is
  actively working (`running`/`stalled`), so a paused card that's waiting on you shows just
  its task, progress timeline, and reply box.

### Added

- **The NEEDS-YOU detail panel now shows why an agent is blocked, the task, and the real
  question with one-click answers.** A blocked card used to surface only a status word and
  a "Thinking…" line — you had to open the terminal to find out what it wanted. The
  decision block at the top of the right pane now renders a **why-blocked chip** (Question
  / Plan review / Permission — permission in red), the **original task** for context, and
  the **real question with its option chips**, sourced from the CLI's structured decision
  (`sessions --json` `question`) rather than a regex over prose. Extracted into
  `<AgentDecision>` so the preview harness renders the exact markup (`?view=decision`).
  (RUSH-1521, RUSH-1546)
- **Inline approve/deny for interactive prompts.** When an option maps to a select-list
  keystroke — a permission prompt (Approve=`1` / Deny=`esc`), a plan review, or an
  `AskUserQuestion` — clicking it now sends that **keystroke** through the existing
  terminal/tmux reply rail (the proven Ink text-then-CR and `tmux send-keys` paths)
  instead of a label the TUI would ignore, so you can unblock without opening the
  terminal. Cloud/team replies stay label-based (semantic-message APIs). (RUSH-453)

### Fixed

- **Cloud status + latest-activity now render identically across hosts.** The Electron app
  and the VS Code extension carried two divergent `mapCloudStatus` tables — the extension
  missed `error` / `in_progress` / `queued` and matched case-sensitively, the app missed
  `allocating` / `needs_review` — so the same cloud run could show a different status per
  host. Both now import one shared `mapCloudStatus` (`src/core/cloudStatus.ts`) whose
  case-insensitive switch is the union of the two tables. The standalone app's
  "latest activity" also sorted ISO timestamps lexically (wrong on mixed offsets); it now
  compares on `Date.getTime()`, matching the extension. (RUSH-1512)
- **The standalone Factory app now pauses its floor poll when the floor is hidden.** The
  Electron host handled `subscribeFloor` but dropped `unsubscribeFloor`, so its 5s poll —
  which shells out to read agent state and hit the cloud-runs API — kept running even when
  no floor was visible. It now stops on `unsubscribeFloor` and resumes on `subscribeFloor`,
  mirroring the VS Code host's `cleanupFloorWatchers` lifecycle. (RUSH-1509)

## [0.9.290] - 2026-07-08

### Added

- **Structured questions render on the card** — when an agent calls `AskUserQuestion`,
  the question text and its option labels now surface on the NEEDS-YOU card as clickable
  reply buttons. The data lived in the tool-call input all along; the card only read the
  agent's prose, so the question was invisible. Clicking an option delivers the answer
  back to the agent over its existing reply channel (terminal / tmux / cloud / team).
  (RUSH-453, RUSH-1521)

### Changed

- **Terminal detail pane now matches the headless/cloud panes** — the flat "Recent tools"
  list is replaced by the vertical progress timeline (oldest → now) plus a streaming
  "Latest" message rendered as markdown, so every agent's detail pane reads identically.
  Recent files span the full width. (RUSH-1519, RUSH-1546)

## [0.9.289] - 2026-07-08

### Fixed

- **0.9.288 failed to activate** — it was packaged without `node_modules`, so the
  extension host threw on `require()` of runtime deps (`ws`, `yaml`, MCP SDK, …) and
  no commands registered (`command 'agents.configure' not found`). Repackaged with
  dependencies included. The 0.9.288 card redesign is unchanged; this only restores
  the shipped dependencies.

## [0.9.288] - 2026-07-08

### Added

- **Readable agent cards on the Factory Floor.** Cards now lead with the agent's
  original **task** (not its last message), render **markdown** in message bodies,
  add a live **progress timeline** of recent tool calls plus a **streaming activity
  feed** of the agent's messages, keep the **todo checklist** from silently
  vanishing, and show a clean **worktree chip** instead of a raw `WT=/…/path`. The
  detail pane is reordered for legibility: Task → Progress timeline → Todos →
  Activity → PR/CI.

### Fixed

- **Shell (`SH`) tabs now load your full interactive shell environment.** Every
  tracked terminal — agent CLIs *and* bare shell tabs — carries `AGENT_TERMINAL_ID`,
  which rc files commonly use to take a minimal fast-path (skip oh-my-zsh, themes,
  plugins) for agent terminals no human types in. That mis-fired on the `SH` tab,
  which *is* an interactive shell you drive: it came up with a bare prompt, no theme,
  and missing aliases/tools. Factory now also exports **`AGENT_TERMINAL_KIND`**
  (`shell` for a bare shell tab, `agent` for an agent CLI terminal) so your rc file
  can tell them apart. Gate your fast-path on it, e.g. `zsh`:
  `if [[ -n "$AGENT_TERMINAL_ID" && "$AGENT_TERMINAL_KIND" != "shell" ]]; then …`.

## [0.9.286] - 2026-07-08

### Added

- **Factory Floor redesign — matches the approved prototype.** A cohesive pass over
  the whole dashboard:
  - **Icon rail** — compact left nav of icon buttons with count/needs badges
    (Agents · Needs · Backlog · Projects · Hosts); expands to the full text sidebar.
  - **Proper sub-tab strip** — the Floor's views (Agents / Backlog / Projects / Hosts)
    are now first-class tabs with count/needs badges, active-lime; Dispatch lives on the
    strip.
  - **One contextual controls bar** — the Group/Sort/filter controls swap to the active
    tab's set (agents Group/Sort vs backlog Group/Sort/LN/GH), so there's no more
    duplicated control bar. The old cluttered Status/Agent chip strip is gone — filtering
    lives in saved views + search.
  - **Double-click a task → its own closeable tab** — opens the full detail (rendered
    markdown, comments, images) with Dispatch right there; multiple task tabs at once.
  - **Human session labels** (`terminal-race-fix`, not `claude-596c4c07`) + a compact
    `<agent>·<id>` provenance chip; **project-link group headers** (`N agents` + Linear
    project pill).
  - **Detail-pane artifacts row** — the selected agent's PR / CI / spawned-team / created
    tickets as color-coded chips.
  - **Foreman corner FAB** — the voice orb is smaller and tucked into the corner.
  - **Grouped by project by default**, **checklist expanded by default** with the current
    step highlighted, **one-click PR link**, **created-ticket / spawned-team chips** on
    cards (backed by session scanning).

### Fixed

- **Markdown now renders in the ticket/task detail** instead of showing raw `##` /
  code-fences / `**bold**` (reuses the shared `renderTodoDescription` renderer).

## [0.9.284] - 2026-07-07

### Added

- **Factory Floor redesign — the card now shows the agent's outputs at a glance.**
  A cohesive pass over the live feed:
  - **Checklist expanded by default** on each card (still collapsible), with the
    current step highlighted so progress reads without a click.
  - **Feed grouped by project by default** (NEEDS YOU stays pinned above the groups).
  - **One-click PR link** — the `PR #N` pill is now a real link to the pull request.
  - **One unified search** — the TopBar center is the single live-feed filter; the
    duplicate search box in the Floor controls bar is gone (⌘K still opens the palette).
  - **Artifact chips** — cards surface the tracker refs the agent *created* (Linear
    `create_issue` / `gh issue create`) and any team it *spawned* (`agents teams
    create/add`), distinct from the injected/worked-on ticket. Backed by new session
    scanning (`createdTickets` / `spawnedTeam` on both the indexed scan and live
    session state).

### Fixed

- **Editor "Send to Agent" (slash-command + keyboard shortcut) silently did nothing.** The markdown editor webview may call VS Code's one-shot `acquireVsCodeApi()` only once per load, but `App.tsx` consumed it at startup while the Tiptap `KeyboardShortcuts` (`Mod-Shift-a` / `Mod-Shift-i`) and `SlashCommands` ("Send to Agent" / "Ask Agent") extensions each re-called `acquireVsCodeApi()` on use — a second acquisition that throws / yields `undefined`, so their `if (vscode)` guard fell through and the `postMessage` never fired. All four call sites plus `App.tsx` now share a single cached handle via a new `ui/editor/vscodeApi.ts` (`getVsCodeApi()`), acquired at most once. Regression test (`vscodeApi.test.ts`) simulates the single-acquire contract. Source: `apps/factory/ui/editor/vscodeApi.ts`, `App.tsx`, `extensions/KeyboardShortcuts.ts`, `extensions/SlashCommands.ts`.

## [0.9.283] - 2026-07-07

### Fixed

- **GitHub links pointed at a retired repo.** `package.json` `repository`, the
  settings "Open GitHub" action, and the Guide tab's "Learn More" link now all point
  to `github.com/phnx-labs/agents-cli` (`apps/factory`). Publish identity — publisher
  `swarmify`, name `swarm-ext`, appId — is unchanged.
- **Factory Floor feed showed identical, contextless cards for co-located sessions.**
  Ported the swarmify/extension feed fixes: fan-out remote-session enrichment now
  attributes each row to the correct device (`machine`), surfaces the worktree slug,
  live preview, structured ticket id, and real branch, and caches `startedAtMs` by
  PID so a terminal's start time no longer drifts to `Date.now()` on every republish.
  Consolidated the duplicated feed model into a single `@shared` implementation with
  a `MISSING_EXPORT` build-time drift guard.

### Added

- **tmux terminals by default** (`agents.terminalMode: auto | tmux | native`) with each
  agent terminal publishing its tmux pane (`%N`) and editor-tab index, surfaced as the
  pane handle and "viewing in <tab>" on Factory Floor cards. Gives same-cwd agents
  distinct, addressable identities.
- **tmux pane border now shows the live session label.** The border was seeded once with
  the bare agent code (e.g. `0: CC`) and never updated. It now tracks the same auto-label
  as the editor tab — the moment the session topic resolves (auto-label poller / focus
  fetch / manual rename), the border re-renders to `0: CC - <topic>` on the shared socket,
  even when the terminal isn't focused. This matters most when a session is reattached
  from a plain terminal outside the editor, where the border is the only label surface.
