# Sessions and session history

A session is a harness-native conversation. agents-cli does not replace the harness's
transcript format; it discovers those transcripts and builds a normalized, searchable
history across harnesses and devices. The transcript remains durable truth. SQLite,
live-process state, summaries, and UI streams are derived views that can be rebuilt.

> **Where the reader lives (PHNX-4118).** The pure parse→render→analyze pipeline —
> the parsers, the normalized event/step/meta types, and every rendered/redacted view
> (`--json`, `--markdown`, `trace`, `timeline`, `insights`, share HTML) — is imported
> from the published [`@phnx-labs/sessions-cli/reader`](https://www.npmjs.com/package/@phnx-labs/sessions-cli)
> package (the same code the standalone `sessions` bin runs), not kept as an in-repo
> copy. It is imported **in-process** (a normal node_modules import, never a subprocess),
> so the indexer, the eval loop, and live-state parse transcripts without shelling out.
> The CLI still owns the writer/indexer (SQLite, tool index, timelines), the live pid
> registry, and the discovery/sync/remote code under `cli/src/lib/session/`.

> **Who reads transcripts (PHNX-4227).** `agents sessions` was removed with no alias.
> Listing, search, reading, `tail`, `trace` as text, export, import, render, share, and
> bookmarks are the standalone `sessions` CLI (`sessions --help`). agents-cli keeps the
> index writer, live identity (`agents ps`), resume and recovery, and the fleet peer
> protocol described below. A moved verb typed under the old group exits 1 with one line
> naming its new home, for example `agents sessions stop` → `agents ps stop`
> (`removedToolGroupMessage` in `src/lib/startup/command-registry.ts`).

```mermaid
flowchart LR
  H1[Claude transcript] --> D[Discovery and parsers]
  H2[Codex transcript] --> D
  H3[Other harness transcripts] --> D
  D --> E[Normalized events]
  E --> I[(Session index)]
  E --> V[Rendered/redacted view]
  I --> Q[Search and filters]
  I --> W[Versioned watch stream]
  L[Live pid registry] --> W
  W --> UI[CLI, AGI EXT, menu bar]
```

## Live roster: `agents ps`

`agents ps` lists the sessions running right now on this machine and every reachable
device. It is the home of the verbs that act on a session: `ps stop`, `ps focus`,
`ps detach`, `ps migrate`, `ps migrations` (the migration ledger), `ps preview <id>`
(the detail card), and `ps watch --json` (the session-only NDJSON stream; the operator
stream is `agents feed watch --json`). Typing into a running agent is
`agents send --channel session --to <id> --text <text>` (or `--pane <%id> [--socket <path>]`
for a known tmux pane, with `--no-enter` and `--combined`). Resuming an ended one is
`agents run auto --resume <id>` (auto resumes in the session's own harness), or
`agents run <agent> --resume` with no id for the picker. Forking a session into a new
sibling is `agents fork <session>`.

| Flag | Effect |
|---|---|
| `--json` | One row per live session |
| `--local` | This machine only; no SSH fan-out |
| `-D, --device <name...>` | Only these devices. Peers answer `agents ps --local --json`, so each peer needs agents 1.22.121 or newer |
| `--status <state...>` | `working`, `idle`, `waiting`, `orphaned`, `crashed`, `closed`, `abandoned`, `queued`, `unknown`; `waiting` exits 1 when any session waits |
| `--bookmarks` | Only bookmarked sessions (bookmark one with `sessions bookmark <id>`) |
| `--no-interactive` | Print instead of opening the picker on a TTY |

On a TTY with no `--status`, `ps` opens the session picker seeded running-only; `r`
toggles that filter. The roster renderer lives in `src/commands/ps-roster.ts`
(`renderActiveSessions`, `runLiveRoster`); the fleet sweep behind it is
`gatherActiveSessions` in `src/lib/session/active.ts`.

The local snapshot the daemon publishes (`publishLocalActiveSessions`) stamps every
row with this machine's id. A row without `machine` fails `isRunningLiveSession`, so
before this the roster read empty whenever the newest snapshot came from the daemon,
which on a box with a running daemon was nearly always.

## Two identities with different lifetimes

The durable session identifier belongs to the harness transcript. The live identity
maps a currently running process to the session it owns. Live identity is ephemeral and
machine-local; it disappears when the process exits. Harnesses reveal conversation IDs
at different points, so the launch ID is the cross-harness correlation seam during
startup rather than a fabricated universal session ID.

Two writers may contribute live identity: launch-time process registration and harness
hooks that learn the native ID. Readers reconcile them into one view. They must tolerate
arrival order without overwriting richer identity with an earlier partial record.

## History pipeline

Discovery locates harness-native transcripts and records their origin device, harness,
version, project, timestamps, and format. Parsers emit a shared event model for messages,
tool calls, results, usage, and lifecycle signals. The index stores searchable text and
metadata, not a second authoritative transcript.

Incremental scans append or enrich known sessions. Enrichment may fill missing actor,
lineage, cost, or resource-usage fields, but must not erase previously known provenance.
Schema migrations preserve the stable machine-readable envelope described in the
[normative session specification](specifications.md#sessions).

```mermaid
sequenceDiagram
  participant Harness
  participant Scanner
  participant Index
  participant Consumer
  Harness->>Harness: append native transcript
  Scanner->>Harness: discover changed content
  Scanner->>Index: upsert normalized events and metadata
  Index-->>Consumer: reset snapshot with stream version
  Index-->>Consumer: monotonic increments
  Note over Consumer: replace on reset; apply newer increments only
```

## Progress and attention

Session state describes progress, not merely whether a PID exists. Running work is
healthy. Waiting for explicit input, idle unfinished work, crashes, and orphaned remote
work require different recovery actions. Finished work is terminal and must remain
distinct from idle work; otherwise a quiet completed session and silently abandoned work
become indistinguishable.

The live registry contributes liveness, while transcript tails, execution records, and
explicit completion markers contribute progress. A reader that lacks one signal reports
degraded or unknown rather than manufacturing certainty.

Orphaned work — a live agent nobody is driving — is derived, not asserted, and centrally
folded (`foldHostLink` over the pure classifier in `host-link.ts`). An idle or
input-waiting session with no client attached becomes `orphaned` on any client loss. A
still-`running` agent is treated more conservatively: zero tmux clients is the normal
steady state for a detached remote pane (`agents run --device` wraps every remote
interactive run in a detached tmux session), so that alone never flags it. The one signal
that promotes a running agent is a LOST WINDOW — its owning IDE window stopped
republishing its heartbeat, so the host died uncleanly and the agent outlived it. That is
the genuinely-stranded case (a remote agent still alive after its laptop rebooted), and
`hostWindowLost` is the predicate that names it. Mere absence of a client is not a running
orphan; only a window that was there and is now gone.

## Cross-device history

Each transcript has an origin device. Fleet search unions indexed metadata without
pretending remote files are local. Detail reads, resume, migration, and export route to
the owning device through explicit transport. Migration transfers the conversation and
its provenance, then records the new origin; it does not create two independent owners.

Routing a read to the owner depends on the row naming the device the agent actually
runs on, and the box that *launched* a dispatched session is the one that gets this
wrong: it keeps a live shim process carrying the session's id, so the session looks
local there even though the conversation is on a peer. Process locality is not
transcript locality. A read therefore only stays local when this box can genuinely
answer for it — the transcript is on this disk, or the row names another device
outright. Otherwise the owner is recovered from the fleet's own view of who is
running what, and the read follows it. A session that is readable locally never
takes a needless hop, and an owner that cannot be reached is an error rather than an
empty local card.

Transcript reads are the standalone `sessions` CLI. agents-cli execs its bin only for
its own surfaces: `agents events logs -f <id>` runs `sessions tail <id>`, and the
session picker opens a peer's transcript with `sessions <id> --markdown --host
ssh://<peer>`. The bin is resolved by `resolveSessionsBin` (`src/lib/sessions-client.ts`):
a non-empty `$SESSIONS_BIN` wins, otherwise the `@phnx-labs/sessions-cli` dependency this
CLI installs, otherwise a `sessions` on `PATH` (an empty `$SESSIONS_BIN` skips the
dependency). With none resolving, the command fails with an error naming
`npm i -g @phnx-labs/sessions-cli`; there is no in-process read.

Remote reads are the standalone's too: `sessions <query> --host <target>` reads one
box's index over SSH. agents-cli no longer resolves a `--device` name for a read.

Tool-call search is `sessions --include tools --query 'program:git input:merge'
[--count] [--host <target>] --json`. It reads the tool index agents-cli writes, and
`agents daemon index backfill tools` fills that index for historical transcripts.

### Peer protocol

Fleet features that need another box's live or indexed state ask that box's agents-cli
over SSH with `--local`, so the peer answers from its own state without fanning out again:

| Question | Peer argv |
|---|---|
| Live roster | `agents ps --local --json` |
| Live session stream | `agents ps watch --json --local` |
| Detail card | `agents ps preview <id> --local --json` |
| Stop or detach a session | `agents ps stop <id> --local`, `agents ps detach <id> --local` |
| Selector resolution (hidden) | `agents ps resolve <selector> --json --local` |
| Launch-id lookup (hidden) | `agents ps resolve --launch-id <id> --json --local` |
| Tool-index backfill | `agents daemon index backfill tools --json --local` |
| History pool for the picker | the peer's standalone `sessions --all --json --local …` |

A peer on a release older than PHNX-4227 answers the `agents ps` and `agents daemon
index` forms with an unknown-command error, which the caller reads as unreachable. There
is no fallback to the old `agents sessions` spellings.

## Off-box backup

`sessions export --to-r2` and `sessions import --from-r2` are
on-demand backup and restore operations. They do not enable the retired background
R2/CRDT sync cycle.

A signed-in Phoenix user gets the managed backend by default:

```bash
sessions export --since 30d --to-r2
sessions import --from-r2 --dry-run
sessions import --from-r2
```

No personal Cloudflare bucket or `r2.backups` bundle is required. The CLI encrypts
every transcript body locally with AES-256-GCM under a per-account data-encryption
key, and the managed Worker stores only encrypted bundle objects. The key is cached
locally with mode `0600` and escrowed in the account's bearer-protected namespace so
a fresh device signed in to the same Phoenix account can recover it.

That escrow defines the trust boundary: managed backup is confidential against a
raw R2/Cloudflare bucket read, but it is not zero-knowledge against Phoenix because
Phoenix-operated infrastructure can recover the escrowed key. Users who require a
key Phoenix cannot access can force their own bucket:

```bash
sessions export --since 30d --to-r2 --byo
sessions import --from-r2 --byo
```

The BYO path requires the `r2.backups` secrets bundle. Its `R2_SYNC_ENC_KEY` is the
shared restore key across the user's devices, and the existing
`sessions/<machine>/<agent>/<session>` object layout is unchanged.

The managed endpoint itself (`sessions.agents-cli.sh` — the Worker + R2 bucket) is
provisioned once, by an operator, with `agents setup session-backup` (it was
`agents sessions backup-setup`; Cloudflare credentials come from the `cloudflare`
secrets bundle, e.g. `secrets exec cloudflare -- agents setup session-backup`). It is
idempotent: re-running redeploys the current Worker template in place. This is not a
per-user step. A signed-in user backs up with zero setup, and the BYO path never
touches the endpoint.

## Derived capabilities

- Search and ranking operate over normalized messages and metadata. A keyword
  content query unions FTS5 hits with the listing page so an indexed transcript
  is returned even when it missed the default cwd/limit window. `--project`
  and `--agent` still filter that union — a content hit in another
  project does not leak back in. The index covers both sides of the
  conversation: user prompts (`content`) and the agent's own answers
  (`assistant`, weighted lower in ranking), so a phrase that only ever
  appeared in what the agent said is still findable, not just what was asked.
  A `--json` content-search hit carries a short highlighted `snippet` excerpt
  from whichever column matched. `CONTENT_INDEX_VERSION` (`lib/session/db.ts`)
  gates re-extraction independently of file mtime/size, so a future content
  extractor improvement can backfill every already-indexed session on its next
  scan without a destructive reset.
- Each indexed session carries the genuine **full first user turn** as
  `firstUserMessage` — the verbatim originating request, captured at scan time
  and skipping harness-injected scaffolding. It is distinct from `topic` (a
  one-line distillation), `label` / an agent title, and the live row's cleaned
  `userPromptClean`, and it is emitted on `sessions --json` and on the
  `agents ps watch --json` / `agents feed watch --json` streams. Grok
  recovers it via a bounded prefix read of `chat_history.jsonl` so the cheap
  summary-only scan does not open the full log. Its sibling **`lastUserMessage`**
  (schema v48) carries the LATEST genuine turn, which is the operative request of
  a `/continue`d, redirected, or interrupted-and-restated session — and is what
  the row title and the sidebar's Request card are derived from (PHNX-3939).
- Every session row also carries **`request`**, **`timeline`** and **`files`**
  (PHNX-3939). `request` is the latest genuine turn tidied but never rewritten —
  the user's prose joined verbatim, with screenshot / `host:/path` clip
  references and `@dir` mentions split into `attachments`, pasted terminal echo
  counted as `pastedLines`, and a `/name <id>` invocation kept as `command`.
  `timeline` is the narration-anchored step list: one step per line the agent
  SAID, with the tool calls under it folded into per-verb counts plus `failed`
  and `blocked`, and milestones (`worktree created`, `PR opened`); the last 8
  steps ride the row with an `earlier` counter for the rest. `files` is what the
  session created / modified / deleted, from the harness's own ledger where one
  exists. All three are computed by the daemon's reader-gated tick and cached in
  `session_timelines` — never on the request path. `agents trace <id>
  --steps` prints the same fold as text, redacted by default like every other
  derived-label surface. A tool the operator cut short with Ctrl-C counts as
  `blocked`, not `failed`, alongside one a permission rule or hook denied.
  Every string the timeline ships is scrubbed where it is projected — secrets
  redacted (only `--no-redact` opts out) and terminal escapes always stripped —
  because the row is also published into the git-tracked fleet mirror
  (SES-54a).
- A session's **`label` has one resolver**, `resolveSessionName`
  (`lib/session/title.ts`, PHNX-4387): a user rename (Claude's live
  `nameSource: "user"` name, then the transcript's `custom-title`), then
  Claude's other current name for the running process
  (`<config>/sessions/<pid>.json`, read from every config home), then the label
  already stored in the index, then the `agents run --name` launch name (passed
  to Claude as `claude --name` on a new launch), then Claude's `ai-title`. The
  index and the live roster both call it, so `agents ps`, the extension's tab,
  sidebar card and status bar show the same name. Live rows also carry
  `startedAs`: the first prompt the session was started with, `/goal` and
  harness-injected turns stripped (SES-14d).
- A live Claude row carries **`recap`**, `{ text, at }`: the newest recap
  Claude Code wrote into the transcript (`{"type":"system","subtype":"away_summary"}`),
  with its trailing "(disable recaps in /config)" hint removed, and `at` the
  entry's ISO timestamp. The index scan keeps it in the resumable parse state and
  `applySessionNames` puts it on the row, so it rides `agents ps --json`,
  `agents ps watch --json` and `agents feed watch --json`. A session with no recap
  has no field; durable history rows do not carry it.
- A live Claude row carries what the session **acted on but did not create**,
  newest first, the last action per item winning, at most 50 of each, and no
  field when there are none:
  - **`touchedPrs`**, `[{ url, number, repo, action }]`, `action` one of
    `merged | reviewed | commented | checked out | edited | closed`, from
    `gh pr merge|review|comment|checkout|edit|close` and
    `agents projects prs merge|review|comment --repo R --number N`.
  - **`touchedTickets`**, `[{ id, action }]`, from `linear update <ID>...`:
    `done` (`--done`), `started` (`--pickup`), `moved to Todo` (`--todo`),
    `moved to <state>` (`--status`), else `commented` (`--comment`/`--proof`),
    else `updated`. `linear tasks <ID>` is a read and does not count.

  Only a Bash call whose `tool_result` came back without `is_error` counts: a
  mention in prose, a failed call, a `run_in_background` call (its result is
  the launch, not the command), `gh pr merge --auto`, `echo "gh pr merge 5"`
  and a quoted heredoc body do not. Commands are split with sessions-cli's
  `tokenizeBash`, so `cd x && gh pr merge 12`, `VAR=1 gh ...` and `a; b | tail`
  each yield their own command. The repo is `--repo`/`-R`/`--repo=`, or the
  owner/repo of a PR URL argument; for a bare number with neither, it is the
  `remote.origin.url` of the directory the call ran in (a leading `cd <dir>`,
  else the transcript line's `cwd`, walking up to the nearest directory that
  exists), resolved once at scan time; a non-GitHub or missing remote drops the
  entry. A PR in the session's own `prUrls` and a ticket in `createdTickets`
  are left out. The scan keeps both lists in the resumable Claude parse state
  (`v: 7`; a `v: 6` checkpoint re-parses its transcript from the start on its
  next change) and `applySessionNames` puts them on the row beside `recap`.
  Codex sessions do not carry them yet: their newer rollouts run commands
  inside `exec` scripts the index scan does not read.
- A row's **`title` is its one display name**, drawn verbatim by AGI EXT. It is
  never Claude's `<folder>-<n>` placeholder ("agents-92", "agents-1f", matched
  against the row's own cwd so "RUSH-2058" stays) nor the `[host/<device>]`
  fallback (`isPlaceholderSessionName`), never an injected envelope, another
  session's note, a sub-agent hand-back or a bare slash command
  (`cleanDisplayTitle`), and it falls through every rung (label, fork source,
  generated title, request, topic, `startedAs`) before it is left empty. A
  session started by `agents fork` carries **`forkOf`**, the source session id
  read back from the recap `buildForkRecap` wrote (`forkSourceOf`,
  `lib/session/fork.ts`); until the fork has a name of its own its `title` is
  the source's name, and an unnamed fork is no longer launched with
  `--name "fork of …"`, so Claude's own title takes over when it writes one.
- Every session row's **headline is a user-anchored name, never the agent's latest
  message** (PHNX-3797). One ladder decides it everywhere — `label` →
  `generatedTitle` → the first-prompt `topic` — implemented once in
  `deriveSessionRecap` (`lib/session/active.ts`) for live and history stream rows and
  `sessionHeadline` (`lib/session/title.ts`) for indexed rows, so the CLI list,
  the picker, `agents ps watch --json`, and AGI EXT can never disagree about a
  session's name. `generatedTitle` is a short, descriptive **action + object
  headline** ("Triage the AGI board", not just "Triage") produced by the daemon's
  `session-title` service through a swappable `SessionTitleProvider` — the shipped
  default is the cheap cloud model (`--model cheap`, read-only plan mode), and a
  local model backend can be dropped in later without touching the tick. It is
  generated **once** per session and persisted in the index against a hash of the
  user text it came from — so a titled session costs no further model calls, and
  it regenerates only when that first user message changes or on an explicit
  `agents daemon index backfill titles --refresh`. Until it runs, the row honestly
  shows the user's own first message. The agent's rolling last line stays where a
  live status belongs: `lastAgentLine` / the preview pane. Each box titles its own
  sessions and publishes them on the fleet session mirror, so a peer's rows carry
  the same headline with no per-row SSH.
- Beside the headline, a live row carries a ranked **secondary line**
  (`importantMessage`): the single most important recent agent message — a pending
  question, then a needs-you block (plan review / permission / input-required),
  then the current activity. It rides the same watch/mirror feed as the title, so
  a client renders a bold title over a dim secondary line without a second query.
- Rendering and sharing redact credential-shaped values and local identity by default.
- Export/import preserves provenance and stable IDs while treating indexes as rebuildable.
- Off-box backup (`sessions export --to-r2` / `import --from-r2`) is **managed-first**:
  a signed-in user backs up to the managed Phoenix store with no bucket to provision,
  every transcript body sealed under a mandatory per-account key that is escrowed for
  zero-setup cross-device recovery but is NOT hidden from Phoenix. `--byo` keeps the
  own-bucket, zero-knowledge path. It is a pure on-demand backup, never a background
  sync (SES-50, SES-51, SES-52).
- Insights and resource-usage analysis are projections; they never mutate transcripts.
- Execution records link to sessions when a conversation exists, but remain independently
queryable when a run failed before session creation.

Raw transcripts are private machine state and are never committed as documentation or
attached directly to public work.


### Remote stream ownership

Fleet `agents ps watch --json` and `agents feed watch --json` publish one row per exact
session id, harness and execution device. `sourceDevice` and `machine` identify
the execution owner. The worker's state and preview win over the origin launcher,
even when that launcher is newer or has more fields. Observer-local terminal ids,
viewing information and reply provenance live in `observerTerminals`; they do not
replace the worker's execution metadata. A run dispatched from another desktop's
tab (`agents run --device`) also lists that tab: the launcher forwards
`AGENTS_ORIGIN_DEVICE` with `AGENTS_ORIGIN_TERMINAL_ID`, the worker stores both as
the row's `originTerminal`, and the projection adds
`{device, terminalId, launchId}` for the origin desktop when it differs from the
owner. This works for every harness, including those with no pre-minted session
id (Codex, Grok). A `live-terminals.json` entry may omit `sessionId` (or carry
`""`); it is keyed by `terminalId` alone, so a reloaded window does not duplicate
it. A sessionless agent tab yields a terminal row with no session id. It is never
joined to a transcript by cwd. A non-agent tab (`kind: "shell"`) yields no row
unless a recorded agent with a session id runs under it. Disconnect retains the last owner state;
reconnect resets it. Once an owner has answered, stale launcher/history copies
cannot resurrect a session that the owner removed. `--local` remains the raw
observation stream used by the fleet coordinator.

### Process namespace ownership

On Linux, PID-keyed session state belongs to the recorded boot, PID namespace and
init process start time. The init stamp distinguishes recycled namespace inodes.
A foreign observer reads the existing host snapshot without gathering, pruning,
or replacing it. An invisible process is not evidence that it died; each record's
kernel start time also protects against PID reuse.

Legacy migration and reboot recovery require the initial host namespace or a
live canonical daemon verified through kernel socket credentials. A fresh private
HOME can enroll its own namespace. Automatic reuse of a private-container HOME
across namespaces is unsupported, including after the prior namespace exits.
CLI writers are refused with a diagnostic; hooks withhold PID writes and retain
their session-context output. Run in the owning namespace or use a fresh HOME.
There is no automatic namespace takeover or container lifecycle helper.
