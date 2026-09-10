# `lib/session` — the session subsystem

> **Audience: maintainers of this subsystem — not end users.** This is an internal
> contributor spec: the data model, the render contract, and the known gaps, written
> for whoever next changes this code. It is not user-facing CLI documentation (that
> lives in `--help` output and the user docs); nothing here is shown to a person
> running `agents sessions`.

This directory owns everything about an "agent session": discovering transcripts on
disk, parsing them per harness, detecting which are alive, indexing them for search,
and rendering them for the `agents sessions` command. If code reasons about a session
as a first-class object, it lives here or speaks the types defined here.

This README is the spec for two things that kept drifting and were never written down:

1. **The session data model** — what one session record carries (and what it does not).
2. **The session preview contract** — the fields the preview must show, why, and where
   each one comes from.

It also records the fleet-scale requirement for the `--active` fan-out so the next
rework does not silently regress it.

All file:line anchors below are against the tree this doc was committed with; treat
them as starting points, not guarantees.

## Pipeline

```
discover.ts   scan Claude/Codex/Gemini/OpenCode/OpenClaw roots  ->  raw transcript files
parse.ts      parse a transcript into SessionEvent[]            ->  normalized events
state.ts      derive durable signals (activity, awaiting, todos) ->  SessionState
active.ts     probe live processes (ps / tmux / teams / cloud)  ->  ActiveSession[]
db.ts         SQLite index + FTS over SessionMeta               ->  SessionRow
render.ts     summary + stats for `agents sessions <id>`        ->  text
```

`types.ts` is the source of truth for the shapes every stage speaks. Cross-machine
concerns live in `remote-active.ts` / `remote-list.ts` / `remote.ts` and the
`sync/` subdir.

## Canonical data model

`SessionMeta` (`types.ts:106`) is the normalized in-memory record used in every
listing and picker. `SessionRow` (`db.ts:143`) is its 1:1 SQLite persistence shape
(table `sessions`, `db.ts:50`). `SessionEvent` (`types.ts:26`) is one parsed event
inside a transcript; per-turn cost/model/token detail lives here, not on `SessionMeta`.

Live processes are a separate shape: `ActiveSession` (`active.ts:76`) with its
provenance (`provenance.ts:66`). `ActiveSession` carries runtime facts that no
persisted `SessionMeta` has — notably the origin device and a live fork/subagent
count — and those facts are lost the moment the process exits unless we persist them.

### Cross-surface active-session cache (RUSH-2062)

`session-cache.ts` is the daemon-warmed shared snapshot menubar / extension /
watchdog / CLI read so they do not each re-fan-out a full gather. Each canonical
snapshot write also appends only changed rows/removals to the active-session
journal. `agents sessions watch --json` reads one startup snapshot and then tails
that journal; watcher heartbeats never invoke another gather. Live status fields
(`status`, `activity`, `preview`, …) only ride the snapshot/journal — never the immutable memo. Immutable identity fields (topic,
label, cwd, …) are memoized by `(sessionId, transcriptMtimeMs)` so a transcript
rewrite invalidates them. `remote.ts` is also cache-first: a reachable host
skips SSH while its cache is fresh (it used to replay only on unreachable).

## The session preview contract

There are two distinct renders. Do not confuse them.

- **Preview panel** — `buildPreview` (`sessions-picker.ts:114`) -> `formatHeader`
  (`sessions-picker.ts:167`) + `formatCompactPreview` (`sessions-picker.ts:310`).
  This is what the interactive browser shows on `tab`, and what the non-interactive
  `--preview` flag prints (`sessions.ts:1085`). `agents sessions preview <id>` uses
  the same normalized preview digest after resolving full or displayed eight-character
  IDs across the selected fleet. It takes a `SessionMeta` plus, when available, the
  parsed `SessionEvent[]`. Transcript-derived facts are cached durably by the actual
  transcript mtime and size; live status is joined separately from the bounded 15-second
  active-session snapshot so a durable preview can never keep a stale running state.
- **Full summary** — `renderSession` summary mode (`sessions.ts:1769`) ->
  `renderSummaryHeader` (`render.ts:288`) + `renderSummary` (`render.ts:586`).
  This is `agents sessions <id>`. It already renders a **Subagents (N)** section
  (`render.ts:778`), counted from `Task`/agent tool calls (`render.ts:660`).

The preview is the high-value surface: it is what a human reads to decide "is this the
session I mean?" before resuming. It must answer, at a glance, **who ran this, where,
with what, and how big it got.** The nine fields below are that contract.

| # | Field | Meaning | In preview today | In the data model |
|---|-------|---------|------------------|-------------------|
| 1 | owner / account | who ran it | yes — `sessions-picker.ts:178` | `SessionMeta.account` (`types.ts:136`) |
| 2 | harness (agent) | claude / codex / …, or a custom profile name | yes — `sessions-picker.ts` `formatHeader` via `sessionDisplayAgent` | `SessionMeta.agent` (host) + `SessionMeta.harness` (profile, PHNX-2935) |
| 3 | version | agents-cli version | yes — `sessions-picker.ts:175` | `SessionMeta.version` (`types.ts:135`) |
| 4 | model | model used | yes* — `sessions-picker.ts:177` | **not persisted** — only `SessionEvent.model` (`types.ts:51`), read via `extractModel` |
| 5 | tokens burned | total (and output) | yes — `sessions-picker.ts:201` | `SessionMeta.tokenCount` (`types.ts:128`), `outputTokens` (`types.ts:130`) |
| 6 | duration | how long it ran | yes — `sessions-picker.ts:194` ("lasted") | `SessionMeta.durationMs` (`types.ts:133`) |
| 7 | device it ran ON | the machine executing it | partial — remote-only note (`sessions-picker.ts:126`); not shown for local | `SessionMeta.machine` (`types.ts:205`); `ActiveSession.machine` (`active.ts:168`) |
| 8 | device STARTED FROM | ssh/origin device that launched it | **no** — not in the preview panel (it is in the list row via `sshOriginTagFor`, `sessions-browser.ts:367`) | **not persisted** — live-only `ActiveSession.provenance.origin.device` (`provenance.ts:79`) |
| 9 | fan-out left behind | sub-agents spawned + shells backgrounded | **yes** — both, on BOTH body paths (`sessions-picker.ts` `formatFanOut`) | `SessionMeta.subAgentCount` / `backgroundShellCount`, persisted as `sessions.sub_agent_count` / `background_shell_count` at scan time (schema v40) so a remote/unindexed row can render them |

`*` model silently disappears for remote/unindexed rows: `formatMetaOnlyBody`
(`sessions-picker.ts:233`) renders a `SessionMeta` with no events, and `model` is
derived from events, so it drops. This is the one field in the preview that is
genuinely lossy today.

### Highlight lines (shared by both renders)

Beyond the identity fields above, both renders show "what the session used and
produced", extracted by one shared module — `highlights.ts` — so the panes
never disagree:

| Line | Source | Notes |
|------|--------|-------|
| `Skills:` / `Skills (N)` | `extractSkills` — `Skill` tool calls (`args.skill`) | plugin skills ride the same tool |
| `Hooks:` / `Hooks (N)` | `extractHooks` — `hook` events from Claude's `hook_success`/`hook_error` attachments (`parse.ts`) | Claude-only: other harnesses don't record firings; the section doesn't render for them |
| `Links:` / `Links (N)` | `extractLinks` — URLs in messages, classified Linear/Jira/GitHub/GitLab | deduped by label, OSC-8 clickable, capped |
| `Artifacts:` / `Artifacts (N)` | `extractArtifacts` — created docs (`.agents/artifacts|plans|reports/`, other `*.md`/`*.html`) | clickable |
| `Repos:` (preview only) | `extractRepos` — bounded `.git` walk-up over touched paths | relative paths resolve against the session cwd ONLY; skipped when cwd is unknown |
| `Errors:` (preview) | `error` events | one-line tally, mirrors the summary's Errors section |

These are transcript-derived, so remote/unindexed rows (`formatMetaOnlyBody`)
don't show them — same constraint as `model` above. Rendering them remotely
means persisting the signals at scan time (the "Gaps to close" model below).

The live JSON/watch contract is richer than the terminal preview: indexed
`tokenCount`, `durationMs`, and `subAgentCount` are backfilled onto live rows,
while the bounded tail state engine emits `artifacts` and `planFile`. Thin
clients consume those fields from the stream; they do not reopen transcripts.

Path hygiene is standardized at the source: `digest.ts:isNoisePath` drops shell
junk (`2>&1`, unexpanded `$VAR` paths), `node_modules`, `.system`, and
`.agents/.history/` internal archives from every change/dir derivation, and
`render.ts:displayPath` collapses `.agents/worktrees/<slug>` prefixes to
`⧉ <slug>/…` after the session-cwd strip.


### Gaps to close (and how)

Six of the nine fields are already in the preview. The work is the other three plus
the one lossy field:

- **model (#4) for remote/unindexed rows.** Persist a per-session `model` (or a small
  `models[]`) onto `SessionMeta`/`SessionRow` at index time, so the preview does not
  depend on a live event parse. Today it is derived from events only.
- **device it ran on (#7) for local rows.** Show `machine` unconditionally, not only
  when remote. The field exists; the render just gates it.
- **device started from (#8).** This is the biggest gap: the origin device is computed
  live from ssh provenance (`provenance.ts:79`) and never persisted, so it is gone once
  the process exits. To show it in the preview of a past session it must be captured at
  session start and stored on `SessionMeta`/`SessionRow` (a new `originDevice` /
  `startedFrom` column). Coordinate with the sessions.db `machine` work.
- ~~**sub-agent count (#9).**~~ **Closed** (RUSH-3091/3095). `sub_agent_count` and
  `background_shell_count` are persisted at scan time and rendered by `formatFanOut` on
  both body paths, so a remote row shows the same fan-out a local one does. Two
  invariants that keep it honest: the counts mean "started / left behind", never "still
  running" (a transcript records a start and never a death — the same trap
  `agents devices ps` documents); and `undefined` (not scanned / harness cannot report
  it) is distinct from `0` (scanned, none found), with the segment omitted for both, so
  the line can never assert "nothing is running". Background shells are per-harness —
  claude/kimi flag `Bash` with `run_in_background`, grok flags `run_terminal_command`
  with `background`; codex/droid record no such concept and cursor persists no tool
  calls locally, so all three render absence rather than a zero.

### On the "the rework dropped preview fields" report

This was investigated against full history (2842 commits, `git log --follow` on
`sessions-picker.ts` plus pickaxe on `subagent`, `provenance`, `session.machine`).
**No commit ever removed model, tokens, duration, owner, machine, ssh-origin, or a
sub-agent count from the preview panel.** The default-UX "interactive fleet-wide
browser" rework (`b5ca212f`) did not touch `sessions-picker.ts` at all; the largest
preview change (`dd2796a3`) *added* the current multi-line header, replacing a
one-line one. The three fields the operator expects and cannot find — device
started-from, sub-agent count, and local device-ran-on — were **never in the preview
panel**. So this is a never-had-it gap to fill (the list above), not a regression to
revert. The one thing that does silently vanish is model on remote/unindexed rows,
for the `formatMetaOnlyBody` reason above.

## Fleet `--active` behavior and the scale requirement

`agents sessions --active` splits on TTY (`sessions.ts:1157`): an interactive terminal
gets the browser (`sessions-browser.ts`), everything else gets the static
`renderActiveSessions` dump. Both funnel through one fleet sweep, `gatherActiveSessions`
(`sessions.ts:947`) = local `getActiveSessions()` + remote SSH fan-out
`gatherRemoteActive` (`remote-active.ts:62`), deduped by `${machine}:${sessionId}`
(`sessions.ts:711`).

The interactive running-filter live set is fleet-wide: the browser builds `live` from
the same `gatherActiveSessions` (`sessions-browser.ts:446`), not the old local-only
`getActiveSessions`, so the browser and the JSON dump can no longer disagree about what
is running. Keep it that way — the local-only intersection was a real bug (a host
showed 3 sessions while `--active --json` showed 30).

**Requirement: the fan-out must stay fast at 100–200 devices.** It does not today.
`gatherRemoteAgentsJson` (`remote-agents-json.ts:102`) is an unbounded
`Promise.all(targets.map(...))` that `spawn`s one `ssh` process per peer
(`remote-agents-json.ts:45`) with no concurrency cap, no batching, and no per-peer
streaming — the whole view blocks on the slowest peer up to the 12s app timeout
(`remote-agents-json.ts:18`). There is no result cache for the live view, and the
online pre-filter reads a possibly-stale `tailscale.online` snapshot
(`remote-agents-json.ts:81`), so sleeping hosts are still dialed and burn the full
timeout. Any rework of this path must preserve fleet-wide correctness while adding:
a bounded concurrency pool, incremental render as peers resolve (not
`await Promise.all`), and a fresher reachability gate. Treat "fast at 200 devices" as
an acceptance criterion, not a nice-to-have.

## Program / host detection (which app the agent runs in)

`detectHost` (`active.ts:882`) walks the process-ancestry chain and matches ancestor
`comm` strings against `HOST_MATCHERS` (`active.ts:738`); the match becomes the row's
`host` column. `undefined` falls through to `context: 'headless'` (`active.ts:1112`).

**Known bug — Linux VS Code / Codium is mislabeled `headless`.** The editor rows of
`HOST_MATCHERS` (`active.ts:740`) carry only macOS Electron-helper names and Windows
image names (`'Code Helper'`, `'VSCodium Helper'`, `'Code.exe'`, …). On Linux `ps`
reports the binary basename (`code`, `code-oss`, `node`), none of which match those
tokens, so `detectHost` returns `undefined` and a bare agent launched in a Linux
VS Code/Codium **Server** terminal (the common remote-dev case) is classified
`headless` — or `terminal` with host `-` when the extension published the terminal
(`active.ts:692`, which force-sets context but takes host only from `detectHost`).
macOS/Windows editors and native Linux terminals/multiplexers
(`alacritty`/`kitty`/`ghostty`/`tmux`, `active.ts:748`) detect correctly. Fix: add
lowercase Linux tokens (`code`, `code-oss`, `codium`, `cursor`, `windsurf`, plus a
`node`/`code-server` heuristic) to the editor rows.

## Status, idle, and hung-agent detection

An operator's most important question about the active view is often *"has this agent
hung?"* — agents frequently stop taking action and silently burn time. Here is exactly
what the current code can and cannot tell you.

**Classification (correct).** `inferActivity` (`state.ts:490`) is a hybrid of two live
signals: process liveness (`pidAlive`) and transcript-file mtime recency
(`fresh = now - mtimeMs < 2min`, `state.ts:492`). The coarse status maps
`working -> running`, `waiting_input -> input_required`, else `idle`
(`statusFromActivity`, `active.ts:520`). Crucially, every "working" branch requires
**both** `pidAlive` **and** `fresh` (`state.ts:559`), so a pid-alive-but-silent agent
can **never** falsely show `running` — the classic "hung reads as running" bug does not
occur. Thresholds: `ACTIVE_WINDOW_MS`/`ACTIVE_MTIME_WINDOW_MS` = 2 min
(`state.ts:150`, `active.ts:236`); prose-question decay 30 min (`state.ts:159`); stale
cutoff 24 h (`active.ts:245`).

**Gap 1 — "how long has it been idle" is not shown.** The value exists on every row
(`lastActivityMs` = file mtime, `state.ts:531`, `active.ts:648`), but the primary
`agents sessions --active` row (`printActiveRow`, `sessions.ts:543`) renders **no time
column at all** — only id, kind, host, the status word, badges, description. The
browser/picker listings do carry both ends of the session — `sessionAgeParts` renders
`<created> → <last activity>` (`relative-time.ts`, `timeCell` in `sessions.ts`), so the
span is readable off the row — but each half is still an **unlabeled "X ago"** that
renders identically for running and idle rows, not a called-out "idle for X" /
"stuck for X". There is no explicit idle/stuck duration string anywhere.

**Gap 2 — closed (PHNX-3999).** A pending tool call with a live process used to be
guessed as `waiting_input` / `awaitingReason: 'permission'` — a permission prompt
nobody had observed — so a wedged agent read as "waiting for you to approve." Since
PHNX-3999 `inferActivity` reports such a session as `working` while the process is
alive; a permission request exists only when the harness records one
(`permission_prompt` in `feed/attention.ts`), and a stale or uncorroborated record
surfaces as `unverified` with no approval controls. Every other hang still folds
into an undifferentiated `idle` (`state.ts`), and there is **no dedicated
`stuck`/`hung` status** — the signal that would reveal a hang, elapsed silence, is
exactly Gap 1.

**Other accuracy caveats:**
- **Stale cache + frozen clock.** The browser's default view (running filter off) reads
  activity from the SQLite index via `discoverSessions` (`sessions-browser.ts:213`), not
  a live scan; the live scan runs only under the running/`--active` filter and is fetched
  once into `liveCache` (`sessions-browser.ts:414`), never re-polled. There is no
  interval refresh, so the displayed "X ago" is frozen at load and does not tick up while
  you watch — the very cue a growing idle time would give.
- **`input_required` is Claude-only (Codex partial).** Structural waiting keys off
  Claude's `ExitPlanMode`/`AskUserQuestion` (`state.ts:162`, `:541`); non-Claude/Codex
  harnesses get an empty tail (`tail.ts:75`) and can never surface as "waiting."
- **Cross-machine clock skew.** `fresh` and "X ago" both use local `Date.now()` against a
  remote file's mtime with no skew correction (`state.ts:492`, `relative-time.ts:8`), so a
  clock offset on an SSH-fanned peer shifts both the label and the running/idle boundary.

**What "surface hung agents" needs (not built):** render an explicit idle/silence
duration in the `--active` row from `lastActivityMs`; add a `stuck` status (or badge)
for pid-alive + silent-beyond-threshold instead of guessing `permission`; and make the
"X ago" tick / auto-refresh so a growing idle time is visible without a manual reload.
