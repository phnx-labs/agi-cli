# agents-cli (the CLI)

`@phnx-labs/agents-cli` — the `agents` / `ag` CLI for managing AI coding-agent
versions, config, sessions, and cloud dispatch (Claude, Codex, Cursor,
OpenCode, OpenClaw, Grok, Droid, …).

> **New agent? Start with [`docs/README.md`](docs/README.md).** It links the
> compact architecture, concepts, execution, and subsystem decision documents.

This is the **internal architecture** map. The user-facing feature tour is
[README.md](README.md) (pin versions, run, sessions, hosts, teams, workflows,
plugins, browser, secrets, routines, pty). This file covers the design choices,
module map, build, and release mechanics the README does not.

> Phoenix Labs · FSL-1.1-Apache-2.0. Repo-wide policy (conventions, code review, security)
> lives in the root [AGENTS.md](../AGENTS.md).

`agents setup` is the re-runnable onboarding hub. It reports live readiness for
core, browser, computer, secrets, accounts, fleet, share, watchdog, and preferences, then
delegates each selected phase to its existing `agents setup <capability>` wizard.
`agents setup status --json` is the non-interactive view of the same probes.

`agents reminders` lists personal operating reminders kept in
`~/.agents/reminders/reminders.yaml` (each a `short`/`full` pair). They surface
succinctly in the Claude statusline — one per session, chosen deterministically
from the session id (`pickReminderForSession` in
[`src/lib/reminders.ts`](src/lib/reminders.ts)) so concurrent agents each show a
different one and it stays stable within a session. Presence of the file with at
least one entry is the opt-in; there is no flag. The render is Claude-only
([`renderClaudeStatusLine`](src/lib/claude-statusline.ts) appends the dimmed part
after the usage windows) because the statusline is a Claude Code surface; other
harnesses expose no equivalent always-visible line. The full line reads
`host · account · model · [delegate] · 5h n% · 7d n% · ◆ reminder`: the account is
the registered account NAME when the running login has one (`work`, `dev` — the
`agents accounts` row for that identity, via `findNativeAccountByIdentity`), else the
email it is signed into (plus the org name for a Team/Enterprise seat, via
`accountDisplayLabel`). The identity is read once per render (`readClaudeIdentity`,
shared with the usage ingest) from the `.claude.json` Claude is actually running with —
`$CLAUDE_CONFIG_DIR`'s home under the shim, else `$HOME` — so the 5h/7d figures next
to it are attributed at a glance. A malformed file is swallowed
by the statusline (a broken prompt is worse than a missing line) but surfaced by
`agents reminders`. The file syncs across the fleet via `agents repo push/pull`.

`agents artifacts share` publishes an artifact under a **single Phoenix ID**
identity (Google-only device-code OAuth via `agents auth login`,
`src/lib/identity/client.ts` `PhoenixSession` — there is no separate GetRush
account and no Supabase). The URL namespace is the signed-in email's local-part
(`handleFromEmail`, `src/lib/share/backend.ts`). A publish stamps one of five
visibility levels (`ShareVisibility`, `src/lib/storage/visibility.ts`): `public`
(gallery + OG card; the DEFAULT only for a BYO publish), `unlisted` (= `--private`; capability URL, `noindex`,
gallery-hidden — obscurity, **NOT** read-auth, so the CLI warns loudly), `private`
(= `--protected`; token-gated read auth, PHNX-3654 — the Worker serves it only to a
request whose `?k=`/`Bearer` key hashes to the stored `viewer-token-hash`, else
`404`; the raw key rides only in the emitted `…?k=<token>` URL, works for BYO too),
`me` (owner-only, Phoenix-gated — the DEFAULT for a signed-in/managed publish),
and `org` (anyone at the **sharer's** email
domain, Phoenix-gated). The no-flag default is backend-aware — `me` on managed,
`public` on BYO — resolved by the shared `publishVisibility`
(`src/lib/storage/visibility.ts`), which both `agents artifacts share` and the
`sessions` backup surface consume. Both `unlisted` and `private` force a 64-bit random slug
tail so the capability URL can't be guessed from the title. `org` is refused on a
public-inbox
domain (`PUBLIC_INBOX_DOMAINS` in `src/lib/share/worker-template.ts`), so it needs a
workspace-domain Google account, never a personal `gmail.com`. Managed publishes
are metered per user against a free-tier storage quota, object limit, per-file size
cap, and publish rate limit (a CAS ledger at `__usage/<owner>`; enforcement keys on
the real request body, fails loud with `413`/`429`), while a BYO `WRITE_TOKEN`
publish to the operator's own bucket skips all four (PHNX-3542). The full model is
[`docs/share.md`](docs/share.md); the publication boundary is
[`docs/observability.md`](docs/observability.md).

The managed OG renderer is a multipart module-Worker deployment: JavaScript and
font bytes live in the main bundle, while Yoga and resvg are uploaded as compiled
WASM modules (`renderWorkerBundle` → `deployWorker`). Do not inline WASM with
esbuild's `binary` loader: Node permits the resulting runtime compilation but
workerd rejects it. The real-workerd render in `worker-template.integration.test.ts`
is the contract test for this boundary.

`agents artifacts share list` mirrors the public gallery by default. Use
`--scope unlisted|private|me|org` or `--all` (alias for `--scope all`) to list the
authenticated owner's hidden pages; the CLI forwards the owner's bearer and a
`scope=mine` hint to the Worker's JSON listing route, which includes hidden pages
only after verifying that the bearer owns the requested namespace. The filter is
`--scope` (not `--visibility`) because the parent `share <file>` command owns
`--visibility`. `agents artifacts share visibility <target> <level>` re-scopes an
already-published page in place through the same `PATCH` metadata-edit route as
`share edit`: the slug/URL and body are preserved, so no revision is created; the
result flag is `--visibility-json` (the same ancestor-collision rename as
`--scope`/`--for-user`). `agents artifacts share open <target>` opens the owner's own
page **signed in**, so the served page's inline visibility chip is a live control and
not a static cue (PHNX-3370): the served chip is interactive only when `isOwner`
(`handleFromEmail(identity.email) === firstSeg`), and a browser gets that identity from
the `__share` cookie the Worker sets by redeeming a `?phoenix_ticket=`. Nothing minted
that ticket before, so `share open` has the Worker mint a short-lived, single-use,
self-signed one at `POST /__ticket` (authenticated by the caller's Phoenix bearer;
signed with the cookie's HMAC secret but domain-separated so neither can be replayed as
the other — `signSelfTicket`/`verifySelfTicket` in `worker-template.ts`) and appends it
to the opened URL. Managed-only; a pre-feature Worker 501s the mint into an
`agents artifacts share update` hint.

`agents feed watch --json` is the canonical thin-client operator stream: it
composes the existing session watcher with feed attention and activity, while
`agents sessions watch --json` remains the compatible session-only stream.
Answers go through `agents feed answer <attention-key>` so the CLI atomically
claims the first reply and routes it over the recorded session reply rail.

**It is designed to run for as long as a VS Code window is open, so every tick is
budgeted (PHNX-3939).** AGI EXT's elected leader spawns exactly ONE `feed watch
--json` child and fans it out to every window, so a per-tick cost here is paid for
the whole session, not per render. Three rules keep it flat and truthful, and a
change that breaks any of them is a regression, not a detail:

- **Activity is read incrementally, never re-scanned.**
  [`ActivityStream`](src/lib/feed/activity-stream.ts) holds a per-file cursor
  (inode, offset, mtime, ctime, a trailing partial line, and the bytes behind the
  cursor — ctime is what catches a same-length in-place rewrite, exactly as
  `activityStamp` keys the one-shot reader's cache)
  and reads only what was appended since the last tick, driven by an `fs.watch` on
  the activity dir with a 5 s stat sweep as the fallback. The opening scan opens
  no files at all — every log is registered past its own bytes, so history is
  never replayed. Do **not** put `readRecentActivity` back on the tick: it tails
  and parses every session log in the directory, which on a real operator box is
  1,437 files / 64 MB every 500 ms (measured 41.9% of a core over a 5-minute
  steady state; the cursor reader is 0.31%). `readRecentActivity` remains right for a one-shot `agents feed` render.
- **Attention is reconciled on change, not on the tick.** A reconcile pass reads
  each row's block and resolution and its PR status, so running it twice a second
  was two file reads per row per tick for a value that almost never moved. It runs
  when something announced a change — the feed dir and `feed/resolutions` are
  watched directly, which is how an external `agents feed post --blocked` still
  raises promptly — or when `PR_STATUS_TTL_MS` (45 s) has expired and the cached
  PR verdicts are stale. The only other time-dependent verdict in
  `reconcileAttention` is the 30-minute trust window on a permission block the
  session offers no transcript cursor to verify (`UNVERIFIED_PROMPT_AGE_MS`,
  PHNX-3999), and that 45 s cadence is what re-evaluates it — the reconciler
  takes `nowMs` as an input and owns no clock of its own.
- **A request is classified from explicit evidence, never from a hook having
  fired or from elapsed time (PHNX-3999, spec SES-40f).** Claude's `idle_prompt`
  is a finished turn, not a request: the feed-publish hook does not publish it,
  and the reconciler yields nothing for one an older hook left on disk. A
  `permission` needs a recorded `permission_prompt` subtype that the transcript
  corroborates via `ActiveSession.lastEventMs` (the harness stamp on the last
  meaningful event — the file mtime moves on every hook firing, so it cannot be
  the cursor). The state engine never infers `permission` from a quiet pending
  tool call, and `computeLiveSignals` memoizes the parsed tail on mtime but
  re-runs `inferSessionState` against the current clock every call, so the
  30-minute prose-question decay expires on schedule. Anything the CLI cannot
  confirm is `unverified`: no choices, an open-session action only, refused by
  `feed answer`.

The fleet fan-out has its own budget: both `watchFleetFeed` and
`watchFleetSessions` subscribe to peers through
[`streamFromPeer`](src/lib/session/remote/peer-stream.ts), which backs off per peer
(2 s doubling to a 60 s cap, reset on a healthy protocol event), captures the
child's stderr into the `unavailable` reason instead of discarding it, and parks a
peer after three consecutive failed spawns until the device registry changes.
`isDialableDevice` deliberately never excludes an unreachable box
([`devices/registry.ts`](src/lib/devices/registry.ts)), so backoff — not the
dialable set — is what keeps an offline peer from minting an ssh child every few
seconds. Add a third fan-out and it uses this helper; do not re-roll the loop.

### Session request + timeline on every row (PHNX-3939)

Every session row — `agents sessions --active --json`, `sessions watch --json`,
`feed watch --json`, history rows, and the fleet session mirror — carries three
optional fields the AGI EXT sidebar renders directly:

- **`request`** — the session's operative ask: the **latest** genuine user turn,
  tidied but **never rewritten**. `tidyRequest`
  ([`src/lib/session/prompt.ts`](src/lib/session/prompt.ts)) joins the user's
  prose verbatim and pulls everything that is not a sentence out beside it —
  screenshot and `host:/path` clip references and `@dir` mentions into
  `attachments`, shell echo and dispatch banners into `pastedLines`, a
  `<command-name>`/`/name <id>` invocation into `command` — so the card shows
  what the agent was actually told. A model paraphrase is the summarizer's
  `goal`, labeled as such; putting one here would be a violation
  ([spec SES-53](docs/specifications.md#sessions)).
- **`timeline`** — narration-anchored steps: **one step per line the agent
  said**, with the tool calls until the next line folded into per-verb counts,
  `failed` vs `blocked`, and milestones (`worktree created`, `PR opened`,
  `N files changed`). Last 8 in full plus an `earlier` counter. The headline is
  always the harness's own words; only a step where tools ran with nothing said
  is `derived`, and `now` — the label of the call RUNNING — rides only the `live`
  step. Pure fold in
  [`src/lib/session/timeline.ts`](src/lib/session/timeline.ts) — **no model**.
- **`files`** — what the session created / modified / deleted, from the harness's
  own ledger (Codex `FileChange`, OpenCode `patch`, Claude `file-history-delta`)
  where it keeps one, else from Edit/Write calls; `source` says which.

**Zero request-path cost, same shape as the summarizer.** `runTimelinePass`
([`src/lib/session/timeline-pass.ts`](src/lib/session/timeline-pass.ts)) runs
inside the daemon's existing reader-gated `SessionStateService` tick — gather,
fold, publish, in that order so the row written to the journal carries a current
timeline — at most 8 sessions per tick, and for the resumable harnesses (Claude,
Codex) reading only the bytes the transcript grew by. The result is cached in
the stamp-validated `session_timelines` table (`projection_json` for the display
merge, `state_json` for the resume state) and merged onto a row by
`mergeSessionTimeline` beside `mergeSessionSummary`. Only complete
newline-terminated records are folded, so the 973,963-byte record one live
transcript on this fleet carries can never be folded half-written. **Folding the
appended tail onto the prior state equals folding the whole file** — pinned
against the real transcripts in
[`timeline.test.ts`](src/lib/session/timeline.test.ts).

**The tick's byte budget is debited by bytes READ, and a session that does not
fit says so.** A non-resumable harness (everything but Claude and Codex) has no
resume offset, so its only option is a whole-file re-parse — charging it the
transcript's *growth delta* under-counted it by orders of magnitude, and gating
its eligibility on the 4 MiB per-session allowance meant a transcript in
(4 MiB, 16 MiB] could never qualify however idle the tick was. Both were the same
bug seen from two sides: real 5.9 MiB and 4.2 MiB grok transcripts on this fleet
got **no row at all** — not `ready`, not `partial`, not `unavailable` — while
being counted `reused`, so the daemon log read healthy forever. Eligibility is now
`min(remaining tick budget, TIMELINE_PASS_MAX_WHOLE_FILE_BYTES)`, the debit is
`fileSize` for a whole-file branch and the chunk length for a resumable one, and a
session that genuinely does not fit gets a `partial` row naming the budget with
its state left at offset 0 so a quieter tick upgrades it. A per-session fold that
throws is logged and counted `skipped`, never swallowed as "nothing new".

**Redaction and escape-stripping happen at the projection point, not per
consumer.** `projectTimeline` is the single place folded transcript text leaves
the fold, so it scrubs every string it ships — a step's `text`, its `now`, its
`marks`. Secrets go through `redactSecrets` (on by default; only the local-only
`sessions trace --no-redact` opts out) and terminal escapes are ALWAYS stripped.
This is load-bearing rather than defensive: `labelForEvent` falls back to raw
command text when a call wrote no `description`, and `mirror.ts` publishes the
resulting row into `~/.agents/devices/<device>/daemon-state.json`, which is
**git-tracked** in the user DotAgents repo — so an unscrubbed label is a credential
committed to history (root `AGENTS.md` §Security). Note `sanitizeEvents` does NOT
run on the fold's parse path (only `tail.ts` / `stream-render.ts` call it), so
nothing downstream may assume the events arrived pre-scrubbed.

**The parser keeps the per-tool label every harness writes.** `SessionEvent`
gains `label` (Claude Bash `input.description`, Kimi `tool.call.description`,
OpenCode `state.input.description`/`state.title`, Cursor `description` and Droid
`summary` — both on the shared Anthropic-message parser — and the Codex parsed
command),
`verbClass` (Codex `parsed_cmd.type`), `changes` (a harness file ledger), and
`phase` (Codex `AgentMessage`). Codex's typed `item_completed` stream has its own
reader, `parseCodexItemsContent` — deliberately NOT merged into
`parseCodexContent`, because a rollout writes the same turn twice (measured:
648 `custom_tool_call` + 60 `function_call` records AND 1,038 `CommandExecution`
items in one file), so folding both would double-count every call for every
consumer. `agents sessions trace <id> --steps` prints the same fold as text.

`extractSessionTopic` and `cleanFirstUserMessage` now consult **one** skip list,
which is what stops a `/model` echo (`<local-command-stdout>`) or a skill body
("Base directory for this skill:") from becoming a session's topic and then its
title. `SessionMeta.lastUserMessage` (schema v48) carries the latest genuine turn
beside `firstUserMessage`, and `deriveSessionRecap` classifies that raw turn —
with the row's attachments in hand — rather than the already-collapsed `topic`.

### Per-session summarizer (PHNX-3939)

Each session can carry a daemon-computed **`goal`** (1–2 lines), progress
**`checkpoints`** (`{text, at}`, newest last), and a detailed **`summaryChecklist`**
(`{text, done}`), plus a **`summaryState`** (`pending` | `ready` | `skipped`),
delivered on the `sessions watch` / `feed watch` stream so the AGI extension
sidebar can render them. The hard rule is **zero request-path cost**: the model
call runs **only** in the background `session-summarizer` daemon service
([`src/lib/daemon/session-summarizer-service.ts`](src/lib/daemon/session-summarizer-service.ts)
→ [`src/lib/summarizer/pass.ts`](src/lib/summarizer/pass.ts)), which is reader-gated
and bounded per tick, and the result is cached in the stamp-validated
`session_summaries` table (`db.ts`, keyed on `(session_id, file_mtime_ms,
file_size)` exactly like `session_preview_cache`) so it never recomputes on
unchanged transcript bytes. The display path only **reads** that cache — the merge
onto live rows rides `applyImmutableMemo`
([`src/lib/session/session-cache.ts`](src/lib/session/session-cache.ts)); history
rows project it in `toPreviousSessionWatchRow`
([`src/lib/session/remote/watch.ts`](src/lib/session/remote/watch.ts)); and the
fleet session mirror carries it so a peer's sessions show it too
([`src/lib/session/mirror.ts`](src/lib/session/mirror.ts)). It is **off by default**:
disabled or unconfigured, the service makes **zero** model calls and every row reads
`summaryState: "skipped"`. Configure it through `summarizer.enabled` /
`summarizer.baseUrl` / `summarizer.model` (see the Configuration surface below).
The one model call is a pure boundary over the Anthropic-wire client
([`src/lib/summarizer/summarize.ts`](src/lib/summarizer/summarize.ts)) — prompt input
is the cleaned first user turn (never the tool firehose), progress input is the
state engine's todos/plan/phase plus, when the timeline pass has folded any, the
last few narration headlines (§Session request + timeline above) — forcing strict
JSON and returning `undefined` (→ `skipped`) on any error.

Owner-addressed delivery is policy fan-out, not primary/fallback selection.
`agents send --to owner`, deprecated `agents notify`, and an important feed's
`channel: owner` sink resolve every addressable id in
`humans.yaml`'s `owner.policy.normal`, in policy order. Each destination is
attempted independently; a partial failure is reported alongside successful
deliveries. Rush-backed destinations that cannot deliver on the originating
worker forward their explicit channel and target to a capable macOS peer, so
the peer never re-expands the owner policy and duplicates another channel.
Legacy `notify.owner` and a humans file without `policy.normal` retain the
historical single-destination behavior.

Feed channel sinks may override their outbound body with a `message:` template
using the same placeholders as command sinks (`{message}`, `{ticket}`, `{ticket_url}`, `{project}`,
and the rest in `feed-broadcast.ts`). Placeholder resolution is fail-closed: if
the post lacks a referenced value, that sink is skipped. This is the semantic
routing primitive for destinations such as an engineering Slack channel: a
template that includes `{ticket}` receives ticket-backed posts without leaking
unrelated owner alerts into the team channel.
The shared `{message}` is built to be tappable **only where a destination can
render a link** (PHNX-3698, `composeBroadcastMessage` in `feed-broadcast.ts`).
`{message}` is one logical post; the *format* is decided **per destination**
(`sinkMessageFormat` in `sink-format.ts`, keyed on the destination's **resolved
provider** — the same `notify.transports` remap delivery uses, so an aliased Slack
sink still turns blue), and the body is re-rendered in that format. This is a
**per-destination** decision, not a per-sink one: the owner policy fan-out
(`sendToOwner`) resolves each of `owner.policy.normal`'s channels independently, so
a policy that lists both iMessage and Slack sends the plain sentence to iMessage and
the labeled-link variant to Slack from the **one** post — **never a trailing URL
line**:
- **Slack (any destination that resolves to the `slack` provider — a `channel:`
  sink OR a Slack channel in the owner policy) → mrkdwn labeled links**
  (`<url|label>`, blue tappable text). The `Sent from claude/6fc1db18 on zion` crumb
  becomes `<https://prix.dev/console/sessions/<full-id>|claude/6fc1db18>` (the 8-char
  crumb is upgraded to the full indexed id via `resolveFullSessionId`, `session/db.ts`,
  since a truncated id would 404), and every `TEAM-N` key the title or body *names*
  — not just the session's own `ticketId` — becomes
  `<https://linear.app/<ws>/issue/<KEY>|<KEY>>` in place
  (`linearIssueKeys`/`LINEAR_KEY_DENYLIST` in `session/linear.ts`, the same
  canonical detector `detectTicket` uses).
- **iMessage / owner-scoped rush / `command:` / desktop / every other channel →
  plain.** They cannot render a labeled link and a dumped naked URL reads as noise,
  so the message stays the human sentence with **no URLs** (keys and crumb as text).

An **important** post (and every `--blocked` post) fires a best-effort background
`agents traces sync` (`fireTraceSyncInBackground`, `run-trace-sync.ts`, gated
exactly like the run-exit arm) so that console page exists when a Slack crumb is
tapped. **`agents notify` / `agents send --to owner` route through this same
composer** (`ownerMessageComposer`/`composeOwnerMessage`, `owner-message.ts`): the
owner fan-out re-renders the body per destination — plain for iMessage/rush, mrkdwn
for a Slack owner channel — rather than dumping the raw body or sending one plain
string to every channel (PHNX-3698). A non-owner `agents send` (explicit
`--channel`/`--to`) is delivered verbatim.

**`gh` is overloaded so the fleet's trained `gh pr checks` escapes the shared
GraphQL rate limit (PHNX-3501).** The whole fleet shares one GitHub token, and
`gh pr checks/view/list` are all GraphQL-backed, so the fleet drains GitHub's
5000-**point**/hr GraphQL budget while REST core (5000 req/hr) sits idle — then
every agent's `gh pr checks --watch` dies with `GraphQL: API rate limit already
exceeded`. A generated PATH shim (the `browser`-shim pattern,
`ensureGhOverloadShim` in [`src/lib/installations/shims.ts`](src/lib/installations/shims.ts),
installed on `agents sync`) intercepts **only** the agent's trained `gh pr checks`
and routes it to the hidden `agents __gh` verb
([`src/lib/github/gh-overload.ts`](src/lib/github/gh-overload.ts)), which answers
over REST ([`src/lib/github/rest.ts`](src/lib/github/rest.ts): `prHead` +
`rollupForSha` = `commits/{sha}/check-runs` ∪ `/status`, anchored to the PR's live
head SHA); every other verb execs the real gh byte-for-byte. `--watch` owns the
REST poll loop (head-SHA-anchored, so a superseded run's red is never reported —
closes PHNX-3042); a one-shot runs real gh first and falls back to REST only on the
exact rate-limit stderr. **Self-healing:** the shim execs real gh whenever
agents-cli is gone (`[ ! -x "$AGENTS_BIN" ]`) or the `AGENTS_GH_SHIM` sentinel is
already set (recursion), so a leftover/orphaned shim can never break `gh`, and
uninstalling restores plain `gh` immediately. It shadows via PATH precedence and
never touches the real binary. Tier-1 wraps only `pr checks` (clean REST mapping,
highest failure volume); `pr view`/`pr list` and a proactive `linear-rate-limit.ts`-style
budget are fast-follow. POSIX-only in v1. `reviewDecision` is deliberately never
REST-derived (it is a GraphQL-computed branch-protection/CODEOWNERS decision;
approximating it could let the merge loop bypass review).

`agents traces sync` publishes two redacted derived surfaces: a per-session
`SessionDetail` at `sessions/<id>.json` (a `meta` summary —
spanMs/**activeMs**/turns/tools/errorCount/tokens/cost/outcome/repo — plus a plain-language
`whereItWentWrong`, the shape the Phoenix Evals console consumes directly), and a
rich per-device `index.json`. `activeMs` is `spanMs` minus every idle gap > 120s
(PHNX-3457) so a session resumed after hours, or left idle mid-turn, reads as
effort rather than calendar span (the raw span stays available per session as
`SessionDetail.meta.spanMs`). **Every index statistic is computed over the AGENT
corpus ONLY (PHNX-3474):** each session is classified `kind` = `utility` when it is
internal machine plumbing — no tool call AND ≤2 messages (a single-shot call), or its
topic/label matches a known internal-prompt signature (title generation, watchdog,
commit-message writer, factory worker; `classifySessionKind` /
`UTILITY_PROMPT_SIGNATURES` in `traces/sync.ts`) — otherwise `agent`. Utility rows
(~68% of the raw corpus: title-gen, watchdog ticks, commit-message writes, factory
workers, all spawned under the `claude` harness by the Rush app) are **tagged and
excluded, never deleted** from `sessions.db`, so `sessionsImported` is the real agent
count, and the medians / needs-attention / tool-error-rate / topic-bucket counts all
measure agent work; a top-level **`utilityCount`** reports how many were dropped. Each
session ref (topic-tile `sessions[]`, `needsAttention`) carries `kind` and `harness`
(the producing agent) so the console can filter by both. The index contains duration/error statistics —
`medianMs`/`p90Ms` are now the ACTIVE-time percentiles (same keys, new value; the
fleet-aggregate worker keeps weighted-averaging them unchanged); those blended figures
sit alongside **segmented** active-time stats (PHNX-3472) — `agentMedianMs`/`agentP90Ms`
over AGENT runs (a session with any tool call OR more than 8 messages) and
`interactiveMedianMs` over the one-shot INTERACTIVE remainder, plus `measuredFraction`
(share of sessions carrying a non-null duration) — so the console can headline agent
runs (~15min median) instead of the corpus blend the 63%-one-shot tail pulls to ~15s;
every harness now
carries a non-null span (`resolveDurationMs` in `session/db.ts` derives it at upsert
for rush/grok/kimi/cursor/muse/antigravity, which previously left `duration_ms` NULL) —
ranked attention flags, metadata/tool-mix topic buckets — the human task taxonomy the
console treemap renders (Feature work · Bug fixes · Refactor · Debugging · Code review ·
Release · Blog & docs · Fleet / ops), an ordered rules table in `classify.ts`'s
`classifyTopic`, keyed within the five stable `TraceTopicGroup` groups, **each bucket
carrying up to 30 example `sessions` refs (`{id,title,kind,harness}`) so a treemap tile is
drillable into its session list (PHNX-3408)** — and structured tool
failure cause buckets (`real`, `guard`, `hook`, and `behavioral` — the last a
silent failure with no error code, see below), and a **rolling drift signal**.
The shard also carries a **per-session `sessions` roster (PHNX-3483)** — one flat
scalar `SessionRosterRow` per AGENT session (`id`, `title`, `harness`, `model`,
`repo`, `mode`, `projectType`, `startedAt`, `durationMs`, `toolCount`, `errorCount`,
`needsAttention`, best-effort `costUsd`), the raw material the Rush
console filters and re-aggregates client-side (a pre-rolled scalar can't yield a
filtered headline). `durationMs` reuses `sessionActiveMs` (the value behind
`stats.medianMs`; 0 when unmeasured) and `mode` encodes the AGENT-vs-INTERACTIVE
segmentation (`headless`/`interactive`) so a mode-split median over the MEASURED
rows reproduces `stats.agentMedianMs`/`interactiveMedianMs` — the segmented stats
skip null-duration rows, which the roster still carries at `durationMs: 0`; utility
rows are excluded, so the roster length equals `stats.sessionsImported`.

**`device=all` is synthesized, not stored:** each device syncs its own shard, and the
worker merges them on read (`worker-template.ts`). That merge re-projects field by
field — so a new per-device shard field reaches the default console view only if it is
also added to the merge, else it silently vanishes from `/all` while still present
per-device.

Group-by dimensions for the console insight bar are pure functions in
[`src/lib/traces/segments.ts`](src/lib/traces/segments.ts): `deriveAgent`
(model × harness), `classifyTaskType`, `failureTiming`, and `computeLatency`
(time-to-first-tool percentiles from `steps[0].startMs`). The sync integrator
wires them into the shard.

**Behavioral silent-failure patterns** (RUSH-2988) are the sibling of the
error-anchored clustering below, for failures with **no error code**: the agent
went idle after its last event and a human had to nudge it. `computeInsights`
only clusters `outcome === 'error'` tool calls, so a silent stall never reached
`failurePatterns` — it was only a `needsAttention` friction input.
`computeBehavioralPatterns` (`src/lib/traces/insights.ts`) promotes the
per-session `silent stall: <bucket>` friction that `computeInsightFacets`
(`src/lib/session/insights.ts`) already computes into cross-session
`FailurePattern`s with the `behavioral` cause (signature `tool: 'silent-stall'`,
`key: <bucket>`), estimating `wastedMs` from the bucket midpoint bounded by the
same 30-min `MAX_GAP_ATTRIBUTION_MS` cap. `buildIndexShard` passes them to
`computeInsights`, which ranks them into the one top-K `failurePatterns` by
wasted time and folds them into `wastedMsTotal`. `behavioral` is producer-derived,
never returned by `classifyCause`, so `failures.byCause` reports it as `0`.

**Cross-session failure clustering + wasted-time attribution** (PHNX-3141) is
[`src/lib/traces/insights.ts`](src/lib/traces/insights.ts)'s `computeInsights()` —
the piece that turns flat per-tool error counts into ranked, time-weighted
**failure patterns**: failed `tool_calls` rows are grouped by `(tool, cause,
normalized-error)` — volatile tokens (ids, counts, countdowns) stripped so 47
near-identical "rate limit exceeded for user N" errors fold into one pattern —
and each pattern accumulates `wastedMs` from two sources that sum. **(1) The
failed call's own blocking duration** — `end_timestamp - timestamp` in
`tool_calls` (PHNX-3437) — booked whenever the end time is known, independent of
whether another call follows: a call that hung for minutes and then failed wasted
that whole time even as the last call in its session, the case the gap heuristic
alone booked as ~0 (this is what makes a fail-fast fix like PHNX-3407 — a
user_location stdin hang cut from ~5.5m to <1s — measurable, dropping from ~5.5m
to ~0). **(2) The inter-call gap** (`ordinal`/`timestamp`, already indexed)
whenever the next call repeats the same signature (a retry loop) or the gap
itself is a stall (≥60s), measured from the call's END when known so (1) is never
double-counted. Both are bounded per contribution to `MAX_GAP_ATTRIBUTION_MS`
(30m) so one huge gap — or a corrupt/backwards end timestamp — can't be booked as
failure-loop waste; a real active loop is many short gaps that still sum large.
A NULL `end_timestamp` (rows an older extractor stored, before the paired
`TOOL_INDEX_VERSION` bump re-derives them; or a call still pending at scan end)
falls back to the original gap-from-START heuristic unchanged — no crash, no NaN.
Patterns are
**bounded top-K, ranked by wastedMs (impact) — never by raw occurrence count** —
so a single rare multi-hour loop still outranks a frequent but cheap one.
Cost stays proportional to this sync's row count (no transcript re-parsing of
already-classified sessions), so it stays incremental at 10k+ session scale.
Patterns also carry a **`phenotype`** dimension (false-termination /
premature-completion / out-of-order / failure-to-act,
[`phenotype.ts`](src/lib/traces/phenotype.ts)) folded into the group key
alongside `(tool, cause, normalized-error)` (PHNX-3327). That classification
needs the full derived trajectory, which flat `tool_calls` rows don't carry — so
it is computed per-session ONCE (parse → trajectory → `classifyPhenotype`) and
**persisted in the mtime+size-keyed `session_phenotypes` cache** (same shape as
`session_topics` / `session_insights`, `readSessionPhenotypes` /
`writeSessionPhenotypes` in [`db.ts`](src/lib/session/db.ts)), then read for the
**whole corpus** on every sync. Reading the cache for all rows — never just this
run's freshly-parsed batch — is what keeps two identically-signatured sessions in
ONE cluster regardless of which incremental sync first saw each; the `signature`
output itself (`{ tool, cause, key }`) is unchanged, phenotype rides alongside it.

| Field | Type | Description |
|---|---|---|
| `bucketHistory` | `BucketStats[][]` | 14-day rolling window. Each inner array is one day's per-bucket stats (errorRate = tool errors / total calls; stallRate = sessions with ≥1 stall / total sessions). |
| `driftSignals` | `DriftSignal[]` | Buckets whose error or stall rate crossed ±0.20 vs the 7-day average. `severity`: `degrading | stable | improving`. Sorted by errorDelta desc. Buckets with <3 historical days are skipped. |
| `failurePatterns` | `FailurePattern[]` | Top-25 cross-session failure clusters from `computeInsights()`, ranked by `wastedMs` desc. Each carries `signature` (tool/cause/normalized key), `phenotype` (the cluster's failure phenotype or `null`; folded into the group key + id so the same signature under two phenotypes is two clusters — PHNX-3327), `sessions`, `occurrences`, `wastedMs` (estimate — labeled, never presented as exact), `exampleSessionIds` (≤5), and `drift` vs the same pattern id in the previous shard. |
| `wastedMsTotal` | `number` | Sum of `wastedMs` across every cluster found this sync — not just the top-25 rows in `failurePatterns` above. |
| `latency` | `LatencyInsight` | `{ firstToolMs: { p50, p90, p99, max } }` — time-to-first-tool percentiles, reusing `segments.ts`'s `computeLatency()` over each session's earliest `tool_calls` row. |

Per-session `SessionDetail` also carries `surfacedToolFailures` — every failed
step, listed unconditionally regardless of the run's overall outcome, so a
session that ultimately succeeded (merged / tests-green) still shows the tool
failures it hit along the way instead of hiding them behind a green run-level
status (the failure this fixes: a coding-agent analogue of a monitoring tool
reporting 0% error rate while a run burned hours in a failed-tool retry loop).

`meta.outcome` is the **truthful** run outcome (PHNX-3387): a run with tool
errors reads `completed` ONLY when it *causally recovered* — a substantive,
non-human-facing tool step succeeded strictly after the last error AND resolved
the failed work (its **work signature** — the effective program for a shell step,
the tool identity otherwise — matches an errored step's), the exact predicate the
false-termination phenotype uses (`recoveredAfterErrors` in
[`phenotype.ts`](src/lib/traces/phenotype.ts), shared with `deriveRunOutcome` in
[`sync.ts`](src/lib/traces/sync.ts) so the console outcome and the phenotype can
never disagree about whether a run finished). A run whose last substantive step
is the error, whose only post-error steps are human-facing (a punt to
`AskUserQuestion`), or whose only post-error success is unrelated work (a failed
`bun test` followed by an incidental `ls`), stays `errored`. This is what makes
`surfacedToolFailures` on a `completed` run honest: those are failures the run
recovered from, not a green status hiding an unresolved one. It never flips a
genuinely-unresolved run to `completed` (no regression vs the old
`errorCount > 0 ? errored : completed`).

On live sync, the prior shard is fetched from R2 before the PUT to seed history; failures (404, parse error) fall back to empty history. `--dry-run --out <dir>` seeds from the previous `index.json` in the output directory. Topic classification is lazily
cached in the self-healing `session_topics` table by transcript mtime + size;
it is not part of the hot session scan or `SCHEMA_VERSION`. `agents traces sync
--dry-run --out <dir>` computes both surfaces from the local `sessions.db` and
writes them to a directory (no Phoenix auth, no worker, no upload) — a local
export for verifying the real signal before the hosted path is wired.

The sync gate is a per-device mtime **watermark** plus a **failure ledger**, both in
`traces-sync.json` (PHNX-3267). The watermark alone cannot retry a failure — a
later-mtime success advances it past an earlier failed row, which the next run then
skips forever — so the ledger also records each failed session's identity + typed,
redacted evidence and the row query unions those retry-worthy ids back in regardless
of the watermark. Failures are typed `transcript-unavailable` (the file is gone;
expected history, not re-read, aged out after 14 days), `parse-failed`, or
`upload-failed` (both retried until they resolve); `SyncResult` carries the per-kind
counts, `agents traces sync` prints the breakdown, and `agents traces status` lists
the outstanding retry set. A `--dry-run` never touches the ledger.

## Authentication — Phoenix ID

`agents auth login` signs in with **Phoenix ID** (`id.byphoenix.com`), the one family
identity shared with the Rush CLI and prix.dev — signing in here creates **no** Rush
account. It runs the RFC 8628 **device flow**: `startDeviceAuthorization()` →
`POST /api/v1/auth/device/authorization`, print the short `user_code` + verification URL
(works on any browser/phone, including SSH/headless hosts), then `pollDeviceToken()` polls
`POST /api/v1/auth/device/token` until approval (`src/lib/identity/index.ts`).

On approval the CLI **stores the opaque Phoenix bearer verbatim** — there is no exchange
step. `writeSession({ access_token, email, userId })` writes `phoenix-session.json` (mode
`0600`) in the runtime state dir (`src/lib/identity/client.ts`). Every backend call reuses
it as `Authorization: Bearer <access_token>` against Phoenix ID; `agents auth whoami`
resolves it at `GET /api/v1/auth/me`; `agents auth logout` deletes the file (local-only —
signs out nothing else).

- `PHOENIX_ID_BASE` (default `https://id.byphoenix.com`) points the CLI at a different
  account service for local/private backends.
- The CLI never reads another product's credentials (e.g. `~/.rush/user.yaml`); each surface
  holds its own copy of the same Phoenix bearer. Managed `agents artifacts share` publishes
  under this identity — the share Worker verifies the bearer at `${PHOENIX_ID_BASE}/api/v1/auth/me`.

## Core design choices (read this first)

Break these and downstream code drifts silently.

### 1. Three DotAgents repos, resolution is project > user > system

Resources AND `agents.yaml` resolve in that order. Same-name overrides, everything
else unions.

| Path | Role | Edited by |
|---|---|---|
| `<repo>/.agents/` | **Project repo** — project-pinned commands / skills / hooks / rules. | Project maintainers |
| `~/.agents/` | **User repo** — user resources + ALL operational state (versions, shims, sessions, `agents.yaml`, browser). | You / CLI |
| `~/.agents/.system/` | **System repo** — npm-shipped defaults ONLY. | Maintainers (`gh:phnx-labs/.agents-system`, GitHub rename target `phnx-labs/.agents`) |

The system repo was renamed `phnx-labs/.agents-system` → `phnx-labs/.agents` on
GitHub (PHNX-3394): the `-system` suffix was redundant once the layering itself
is the role. `DEFAULT_SYSTEM_REPO` still clones the pre-rename slug — GitHub's
own redirect makes that resolve fine, so there is no forced cutover — and both
names are recognized as the system origin everywhere a remote is compared, via
`isSystemRepoRemote` in [`src/lib/git.ts`](src/lib/git.ts).

**The system repo ships hooks that run as shell, so its auto-pull is
origin-verified (PHNX-2957).** Both fast-forward paths — `agents use`
(foreground) and the opt-in `AGENTS_AUTO_PULL=1` background worker — route
through `tryAutoPullSystemRepo`, which pulls **only** when `origin` passes
`isExpectedSystemRepoRemote`: the canonical `isSystemRepoRemote`, or the exact
`AGENTS_SYSTEM_REPO` the operator pointed at. A repointed/unexpected origin is
**refused** (never fast-forwarded), since a pull from an attacker's fork would be
remote code execution on the next command that loads a system hook. Never widen a
system-repo pull to bypass this guard; a legitimate alternate upstream is
expressed through `AGENTS_SYSTEM_REPO`, not an unverified pull.

Extra repos register via `agents repo add <source>` → clone into `~/.agents-<alias>/`
and participate after the user repo. The companion extras repo
`phnx-labs/.agents-extras` keeps its name but is now **private and opt-in**: it is
not cloned by default and is added explicitly with `agents repo add`.

### 2. `AGENTS.md` is the canonical memory file

`CLAUDE.md` and legacy `GEMINI.md` are symlinks. **Edit `AGENTS.md` only** —
editing a symlink target directly gets stomped on the next sync. The sync writes
the right file name per supported agent (`OPENCODE.md`, `.cursorrules`, etc.).

**"Memory" names three distinct, unrelated mechanisms — don't conflate them.**
Besides the rules file above, `agents memory` ([`src/lib/memory.ts`](src/lib/memory.ts))
is a layered resource — `~/.agents/memory/*.md` facts fanned out into each
capable version home (`.claude/memory/`, `.codex/memories/`, …) by
`syncMemoryToVersionHome`. Separately, Claude Code's own **native** per-project
auto-memory — `.claude/projects/<project-key>/memory/*.md`, freeform notes
Claude writes into itself during a session — is neither a `ResourceKind` nor
populated by agents-cli at all. Because `getVersionHomePath` gives every
installed version its own isolated HOME, that native dir used to be a THIRD,
unmanaged, per-version copy: a note written under one Claude version was
invisible under another (PHNX-2817). `syncClaudeProjectMemoryDir`
(`src/lib/memory.ts`, wired into `syncResourcesToVersion`,
[`src/lib/installations/versions.ts`](src/lib/installations/versions.ts))
fixes this the same way project-level rules are version-independent: every
version home's copy is a symlink into one canonical dir
(`~/.agents/.cache/state/claude-project-memory/<project-key>/`, keyed by the
same cwd-to-dash-name encoding Claude Code itself uses,
`claudeProjectDirName` in [`src/lib/project-key.ts`](src/lib/project-key.ts)) —
no merge/copy step, no drift, a pre-existing real directory's content is
migrated into the canonical dir once rather than discarded.

### 3. Capability table gates per-agent writes

`supports(agent, cap, version?)` in [`src/lib/capabilities.ts`](src/lib/capabilities.ts)
is the only place that decides whether an agent+version can receive a resource.
Out-of-range versions are **skipped silently** — do not add per-call agent checks
elsewhere; route through `supports()`.

### 4. No fallback logic for legacy layouts

[`src/lib/installations/migrate.ts`](src/lib/installations/migrate.ts) folds legacy paths ONCE at install time.
The bootstrap gate that invokes `runMigration()` then writes the `.migrated` sentinel
(`MIGRATED_SENTINEL_FILE`, [`src/lib/state.ts`](src/lib/state.ts)), keyed to the
migration SCHEMA version, so the scan short-circuits next run — `runMigration()` itself
only relocates a legacy sentinel via `moveFileOnce`, never writes one. Downstream code
assumes the post-fold layout. "Just-in-case" branches re-introduce drift bugs; the
migrator is the single source of truth for legacy handling.

### 5. Hooks live in a single layered `hooks.yaml`

System + user `hooks.yaml` merged, user wins on same name. Per-entry `matches:`
predicates (`prompt_contains`, `prompt_matches`, `tool_name`, `tool_args_match`,
`cwd_includes`, `project_has`, `git_dirty`, `permission_mode`,
`permission_mode_not`) AND together at fire time — the two mode predicates are
fail-open on absence, since only some harnesses report the live mode in hook
input. Use `permission_mode_not` to gate a hook **off** in one mode:
`permission_mode` is an allowlist, so expressing "everywhere except plan" through
it means enumerating every other mode, and that enumeration silently stops
matching when a harness adds or renames one — which for a guard means it quietly
stops guarding. Per-entry
`enabled: false` disables a system-shipped hook from the user side. The `agents:`
field in `ManifestHook` is `@deprecated` — the capability table decides which
agents register a hook.

### 6. Multi-agent work → `agents teams`

DAG-style, boundary contracts, `--watch` supervisor, `--worktree` isolation, optional
`--cloud` dispatch. The old `mcp__Swarm__*` surface was folded into teams
(`migrateLegacySwarmToTeams()` in `src/lib/installations/migrate.ts`). Don't reach for Swarm — gone.

**A teammate opens PRs but MUST NOT merge its OWN PR without a posted non-author
verdict (PHNX-3236).** A write-capable teammate has `gh pr merge` and authenticates
as the repo owner, so nothing about being a teammate stops it from merging its own
PR straight past the required non-author review — which is exactly what happened in
the RUSH-2988 wave-1 dispatch (PRs #1817, #1820 self-merged with `reviews: []`). The
boundary is enforced in two layers, and neither is per-brief prompt wording (the
failure mode: only one teammate in that batch was *told* not to merge, and its
siblings weren't):

- **Hard enforcement — `merge-guard.sh`.** The PreToolUse Bash guard the teammate
  inherits from the shared version home blocks `gh pr merge` on a PR that has no
  non-author verdict on it. Its verdict check (`pr-verdict.py`) **excludes any
  review/comment authored by the PR's own author** (landed in the same ticket,
  `phnx-labs/.agents` #395), so a teammate posting `VERDICT: APPROVE` on its own PR
  — every fleet agent shares one GitHub identity — no longer clears the gate.
- **Dispatch default — `TEAMMATE_PR_POLICY`.** One helper,
  `withTeammatePrPolicy(prompt, mode)`
  ([`src/lib/teams/agents.ts`](src/lib/teams/agents.ts)), appends the boundary to the
  prompt of every **write-capable** (non-plan) teammate, fresh or resumed, applied at
  **all three** dispatch surfaces so they can't drift: the local launch and the
  `--device` remote launch (both through `buildRunArgv`), and the `--cloud` launch
  (`cloudDispatchOptions` in [`src/commands/teams.ts`](src/commands/teams.ts)). It is
  the harness-independent layer — it reaches every entry in `TEAM_AGENT_TYPES`, not
  just the hook-capable ones — rather than depending on each dispatch remembering to
  say it. Pinned by
  [`agents.pr-policy.test.ts`](src/lib/teams/agents.pr-policy.test.ts).

**Coverage, and the residual gap (stated per §Surface parity).** The two layers do
not overlap everywhere, so name where each reaches:

- **Hook-capable local / `--device` remote teammates** get **both** layers — the
  hard `merge-guard.sh` block plus the prompt. This is the common case.
- **Cloud teammates (`--cloud`)** get **only** the prompt: a cloud teammate runs in
  the provider's sandbox, not the shared local version home, so it never inherits
  `merge-guard.sh`. Wiring the prompt into `cloudDispatchOptions` is what keeps this
  surface covered at all.
- **Hook-incapable harnesses** (e.g. Warp/`oz` — `hooks: OFF` and no allowlist in the
  capability table above, yet present in `TEAM_AGENT_TYPES`) get **only** the prompt,
  local or remote, because there is no hook surface for `merge-guard.sh` to occupy
  and no allowlist to express a `Bash(gh pr merge:*)` deny.

So for the cloud and hook-incapable cases the prompt is a **soft** control an agent
can ignore under pressure — the exact reliability limit the ticket names. That
residual is accepted deliberately: there is no code-level merge interception point on
those surfaces short of provider-side branch protection (cloud) or a per-harness
enforcement mechanism those harnesses don't expose. **Enable server-side GitHub branch
protection requiring a review** to close it uniformly regardless of harness or
dispatch surface — that is the only guard that does not depend on the client.

agents-cli itself never merges a teammate's PR (`pr-watch` only opens follow-up
fixers or escalates to a human — there is no merge action); the teammate's own
`gh pr merge` is the only merge path, which is why both layers target that call.

### 7. Every agent conversation is a session; execution ledgers link to it

**An agent conversation from a session-capable harness MUST remain a session,
whether launched interactively, headlessly, as a teammate, or by a routine.** A
caller MUST preserve the harness transcript and make it discoverable by `agents
sessions`; it MUST NOT replace or hide that conversation record with its own
execution metadata. This applies to `SESSION_AGENTS`, not a harness such as Warp
that exposes no local transcript. The indexed session row carries the relationship
when the harness and launch path provide one:

| Launch surface | Session relationship | Separate execution state |
|---|---|---|
| `agents run`, including headless and `--device` | Ordinary indexed session for a session-capable harness; when its SessionStart hook records an id, the launch id joins a remotely coined session back to the dispatch. A hookless run remains unmapped rather than receiving a fabricated id. | Dispatch/audit events |
| `agents teams` teammate | Its **own** session id plus `teamOrigin`; `parentSessionId` links the orchestrator when the teammate was spawned inside an identified agent session | Team registry + teammate `meta.json` own DAG/task/process state |
| Agent/workflow routine | The transcript is archived under the run; supported archive readers index it with `origin: routine`, `routineName`, and `routineRunId` | `.history/runs/<routine>/<run>/meta.json` owns the attempt outcome |
| Command-only, `missed`, `blocked`, or `skipped` routine | No session is synthesized because no agent conversation occurred | The routine run record is the complete canonical record |

Source of truth: `buildExecEnv` / `emitResolvedSessionId` in
[`src/lib/exec.ts`](src/lib/exec.ts), `listTeamsActive` in
[`src/lib/session/active.ts`](src/lib/session/active.ts),
`archiveRoutineTranscripts` in [`src/lib/daemon/runner.ts`](src/lib/daemon/runner.ts), and
`decorateRoutineSession` in [`src/lib/session/discover.ts`](src/lib/session/discover.ts).
Enforced by [`src/lib/session/team-filter.test.ts`](src/lib/session/team-filter.test.ts)
(`--teams includes team sessions with teamOrigin populated`),
[`src/lib/daemon/runner.test.ts`](src/lib/daemon/runner.test.ts) (routine transcript archival), and
[`src/commands/sessions.test.ts`](src/commands/sessions.test.ts) +
[`src/commands/sessions.cli-live.test.ts`](src/commands/sessions.cli-live.test.ts)
(routine run history plus linked sessions, with no fake session for command-only runs).

Team-origin sessions are durable session rows but are excluded from the ordinary
historical listing by default to keep an orchestrator's fan-out from flooding it;
`agents sessions --teams` includes them, while live teammates appear in
`agents sessions --active` with `context: teams`. That is a presentation filter,
never permission to omit the transcript from the session index.

**Current routine-archive gap:** `readRoutineArchiveMeta` indexes Claude, Codex,
and Cursor routine archives. Kimi's `state.json` + `wire.jsonl` are archived by
`archiveRoutineTranscripts` but do not yet have a routine-archive reader, so they
are not session rows today. Treat that as named drift from the invariant, never as
precedent for a second run-only conversation model; adding another routine harness
requires both archival and a parser in `readRoutineArchiveMeta` plus an indexing
test.

### 8. Routine definitions and device activation are separate

Routine YAML under project, user, or system `routines/` describes what runs and
when. Whether it runs on one host is membership in that host's top-level
`devices/<hostname>/agents.yaml` `routines:` list. Pause/resume and setup MUST
write only the target host's device file; they MUST NOT rewrite a definition with
`enabled`, `devices`, or runtime metadata. Run history belongs in
`.history/runs/<routine>/<run>/`, and that run history — not the session index — is
the canonical record of an attempt; sessions/logs/reports are optional children of a
run (so a `missed`/`blocked`/`skipped` attempt is visible with no session).

**`projects` (plural) is grouping metadata only; the singular `project` anchor is a
separate concept.** The plural list organises a routine in `list`/the menu bar and
MUST NOT affect execution; the (planned) singular `project`/`--project-anchor` plus a
routine-level `cwd` is the execution anchor, resolved on the *execution target*. A
routine's `repo` is an external Git/cloud/webhook identity, never a local cwd. The
reliability contract — context resolution, readiness/pause-on-blocker, single-fire
`(routine, scheduledFor)` claim distinct from the active-run claim, and the
`blocked`/`skipped` run statuses — is normative in
[`docs/specifications.md` §Routine execution & readiness](docs/specifications.md#routine-execution--readiness)
(RT-1..RT-11) and §Scheduling & execution singularity (SING-13, SING-15, SING-16); much of it
is `[Intended]` (RUSH-2290), and each requirement marks landed vs intended.

Routine execution context is separate from grouping and repository identity.
Plural `projects` is metadata-only; singular `project` selects one `ProjectDef`
execution base; `cwd` is resolved on the eventual execution device. A rootless
Linear project may still use a relative `cwd`, which anchors at that target user's
home. `repo` remains GitHub/cloud/webhook identity and MUST NOT be used to infer a
local checkout. Readiness failures save valid definitions paused through device
activation; they never write mutable activation into routine YAML.

### 9. Self-updating agents are ONE binary, not fictional version-homes

Some harnesses (droid, grok, antigravity, cursor, hermes, muse, goose) install
via an official `curl … | sh` / `brew install` script that carries no version token —
the installer only ever fetches the *current* release and the binary self-updates in
place. `isSelfUpdatingAgent()` ([`src/lib/agents.ts`](src/lib/agents.ts)) is the single
predicate for "no pinnable semver"; route every such decision through it, never a
scattered `=== 'droid'`. Its narrower cousin `isGlobalBinaryAgent()`
([`src/lib/installations/store.ts`](src/lib/installations/store.ts)) — computed by probing whether
`getBinaryPath` ignores the version arg — is true only when the agent resolves to ONE
global binary (droid). For those, `listInstalledVersions` collapses the phantom
per-version dirs to a single canonical entry, `reconcileStaleLatestForAgent` folds the
stale dirs into the survivor, `agents view` shows the live `--version`, and
`agents add droid@1.2.3` gracefully installs the current release instead of erroring.
grok is self-updating but stores a real per-version binary under each version-home, so
it is NOT a global-binary agent and is left uncollapsed. (RUSH-1321)

For a concrete self-updating spec, the requested token is the stable installation
label/account slot even when the vendor installer can only fetch today's release.
`installation.json.releaseVersion` records the probed vendor release separately.
This identity/release split is load-bearing: two Cursor or Grok account slots
may share the same managed release while retaining different native credentials,
and removing an isolated installation must never target the managed install merely
because their releases match. `@latest` keeps the probed release as its convenient label; concrete labels stay
exactly addressable.

### 10. Diagnostic command taxonomy — `doctor` is the umbrella (RUSH-2027)

Three diagnostics, distinct scopes. Don't blur them — each answers a different
question, and a new health check goes in the one whose scope it matches.

| Command | Scope | Answers |
|---|---|---|
| `agents fleet status` | Coarse **device** health across the fleet | Are devices online, do they have the agent CLIs installed, are they signed in, what is the agents-cli **version skew**, how many agents are running on each box. NOT fine-grained resource divergence. Publish-own/read-union: each daemon publishes only its own row (no N² ssh probe, RUSH-2061); the reader unions peers on demand (`--local --json` is the per-host publish endpoint). |
| `agents inspect <agent>[@version]` | Deep **single-harness** diagnosis | Per-resource diff between one version home and its resolved sources; manifest staleness; orphans. One harness, one machine. |
| `agents doctor` | **Umbrella** — overall fleet + harness health | Local diagnostics (CLI presence, per-version sign-in, per-version sync, orphans) **and** cross-device divergence, rendered as the prioritized critical-at-top + per-computer hybrid below. The single command a user runs to discover problems before runtime. |

**The per-version resource diff is content-aware for EVERY kind `syncResourcesToVersion` writes (PHNX-3504).** `diffVersionResources` ([`src/lib/doctor-diff.ts`](src/lib/doctor-diff.ts)) — the engine behind `agents doctor` and `agents inspect` — no longer name-compares mcp/permissions/subagents or skip workflows/memory. `DOCTOR_ALL_KINDS` = commands, skills, hooks, rules, mcp, permissions, subagents, plugins, **workflows**, **memory** (`promptcuts` is dropped — it is a single version-unscoped file, not per-home). A byte change under an unchanged name is `diff`, never a false `ok`: mcp structurally compares the parsed home server def vs the resolved source (no `claude mcp add` shell-out); subagents re-render the source through the `SUBAGENT_TARGETS` transform and byte-compare; workflows compare layout-aware per harness (Claude's copied WORKFLOW.md tree vs the transformed Kimi/Antigravity/OpenClaw/Grok file vs the Goose recipe; antigravity's is the shared HOME-global dir); memory diffs the knowledge facts (`~/.agents/memory/*.md`, bounded by the `.agents-cli-memory.json` manifest — NOT the rules-preset list that overloads `AvailableResources.memory`); permissions compare per-rule in the harness's native vocabulary for the **representable** harnesses (claude/opencode/cursor/droid/openclaw) and stay presence-only with `detail: 'format cannot verify content'` for the lossy TOML/flag harnesses (codex/grok/kimi/antigravity/hermes/copilot) rather than faking `ok`. The shared byte compare (`filesContentMatch`/`dirsContentMatch`, [`src/lib/resource-content-diff.ts`](src/lib/resource-content-diff.ts)) is reused by skills and the plugin-drift describer. A completeness test in `doctor-diff.test.ts` binds `DOCTOR_ALL_KINDS` to the writer set so a future synced kind cannot silently become a doctor blind spot, and `agents doctor --fix` (`src/lib/heal.ts`) reaches the newly-covered kinds.

**`agents doctor <agent>[@qualifier]` accepts symbolic qualifiers** — `@latest`, `@oldest`, `@default`/`@pinned`, `@all`, or an exact version — resolved through the shared agent-spec engine (`lib/agent-spec/index.ts`, `resolveAgentTargets`). Bare `agents doctor <agent>` (no qualifier) sweeps every installed version without setting `versionExplicit`; `--fix` then excludes isolated copies. Any explicit qualifier sets `versionExplicit: true`, scoping `--fix` to the resolved version set (including isolated copies for `@all`). `AgentSpecError` from the engine is surfaced as a user-facing error. Routing flags (`--device`/`--remote-cwd`) are stripped via `stripRoutingFlags` before target parsing, so `agents doctor claude@latest --device remotebox` resolves correctly on the remote. (issue #2058, `src/commands/doctor.ts:parseTargetArg`)

**`agents doctor` is a prioritized, comprehensive-by-default hybrid (RUSH-2069).**
There is no `--verbose`. A top `✗ CRITICAL — needs you now (N)` section lists every
critical across the whole fleet worst-first; a `─── by computer ───` section then
gives each device its warnings plus a compact accounts/versions line (every
installed version + its account, provable ✓ / ✗). Single-machine `agents doctor`
collapses to the CRITICAL section plus one `▸ <machine>` block. Severity:
**critical** is `logged-out` (provable), `missing-hook`, `missing-plugin`,
`unwired-hook`, `hook-runtime-broken`, `cli-missing`, `ssh-key-enrollment` and `owner-sink-unreachable` (the feed/notify
owner-delivery lane can't reach the owner from this box, RUSH-2262); **warning**
is `logout-unprovable`,
`missing-resource`, `content-drift`, `never-synced`, `stale`, `repo-behind`,
`repo-drift`, `version-skew`, `fleet-resource-gap`, `hook-runtime-visibility-unavailable`, `orphan`, `duplicate-hook`,
`duplicate-hook-drift`, `host-cli-missing`, `host-cli-invalid`,
`rc-secret-export`, `env-secret-export`, `auth-bundle-wrong-backend`, `exec-policy`, `stale-cli` and `binary-shadow`. (RUSH-2162 moved
`never-synced` and `duplicate-hook-drift` to warning — both are stale-sync states
one `agents sync` resolves.)

`FINDING_SEVERITY` in
[`src/lib/devices/doctor-findings.ts`](src/lib/devices/doctor-findings.ts) is the
single source of truth: the builders read their severity from it, and a test
asserts this list and the module docblock assign every kind to the **same bucket**
it does. Change a severity there and the test names the docs to move with it. The findings model,
builders, `remediationFor`, and the pure `renderFindings` live in
[`src/lib/devices/doctor-findings.ts`](src/lib/devices/doctor-findings.ts).

**One root cause is one line.** A readout the user cannot scan is as useless as no
readout, so the builders de-duplicate before rendering — on a real machine this
takes ~57 rows down to ~16, and the rules are unit-pinned in
`doctor-findings.test.ts`:

- **Per version, per kind, one row.** `emitGroup` names a lone resource in full
  (`hook 'git-guard' missing`) and otherwise emits a count plus two examples
  (`32 hooks missing (incl. 'a', 'b')`). Never one row per resource.
- **Per agent, one row across versions.** `collapseAcrossVersions` folds findings
  with the same `(device, agent, kind, severity, account, message)` into a single
  row carrying `versions`, rendered `claude (5 versions)`, and widens the
  remediation to the agent-wide sweep. Three exclusions, each because the widened
  remediation would be wrong: **isolated copies** (`runFix` skips them, so the
  sweep would leave one broken — the caller passes `isolatedVersions` from
  `isVersionIsolated`); **findings with no agent** (their `version` is a repo
  alias); and **logouts** (`NEVER_COLLAPSED`) — a login is inherently per-version,
  there is no `@all` for it, and dropping the version falls back to the bare
  native hint, which the shim points at the *default* version.
- **Orphans are one line per machine.** They are cleanup-only and
  `agents prune cleanup --all` fixes every version at once — **`--all` is load
  bearing**: without it cleanup sweeps only each agent's default version
  (`commands/prune.ts:351`).
- **Duplicate version-home hooks are one line per (agent, severity).**
  `agents sync <agent>@all --yes` reconciles every copy at once, and a
  machine with five installed claudes otherwise emits two dozen identical rows.
- **No vaguer restatement.** A version that just listed its drifted/missing
  resources gets no `sources changed since last sync` row on top, and a
  never-synced version reports one warning (`agents sync <agent>@<version>
  --yes`) instead of one row per absent resource.

**Every check the old overview printed is a finding now.** `renderOverviewText`
was the ONLY text renderer for several independent checks, so deleting it dropped
each of them from the command — the top defect this redesign had to answer for, and
it recurred three times during review. They all enter `buildLocalFindings` as
plain **inputs** (never probes, so the module stays pure and every branch is
testable without a shell, PowerShell, or an installed CLI):

| Check | Input | Finding kind |
|---|---|---|
| Credential-shaped shell-rc exports (RUSH-1968) | `rcSecrets` | `rc-secret-export` |
| The file-store master key live in the process env (RUSH-1968) | `masterPassphraseInEnv` | `env-secret-export` |
| Windows exec policy blocking `agents.ps1` | `execPolicy` | `exec-policy` |
| Windows OpenSSH key path/content/ACL invalid | `windowsSshEnrollment` | `ssh-key-enrollment` |
| Hooks duplicated across version homes | `duplicateHooks` | `duplicate-hook{,-drift}` |
| Declared host CLIs not on PATH | `hostClis.statuses` | `host-cli-missing` |
| Host-CLI manifests the loader rejected | `hostClis.errors` | `host-cli-invalid` |

**Before deleting any renderer here, enumerate what it called.**

**A remediation must fix EVERY version in its row, and must be a command that
exists.** Three separate rounds of review here found remediations naming a command
form that does not do what the row claims — `agents sync <agent>` (default version
only), `agents repo pull` (skips the system repo), `agents prune cleanup` (default
versions only), `agents clis install <a> <b>` (takes one name), and
`agents run <agent>@<v>, then <cli> login` (the second command resolves through the
shim to the *default* version, not the one that is logged out). **A named account
logs back in with `agents accounts login <harness>#<name>` on a headed device**
(never a token fallback; never a worker-side OAuth). The version-targeted
`agents run <agent>@<v> -- login` form is only for leftover pre-migration
installations that still isolate a login per home — `--` forwards verbatim into
that home. **Open the command definition and check arity, flags, and scope before
writing a remediation string.** `agents sync <agent>` targets
only the default/sole installed version (`commands/sync.ts:8`), so a row collapsed
across versions uses the `@all` selector — `agents sync <agent>@all --yes`. A fleet
resource gap is absent from that box's *central repos*, so the central-to-home
`agents doctor --fix` cannot close it — and neither `agents repo pull` nor the sync
umbrella touches the **system** repo (`commands/repo.ts:1186`,
`lib/sync-umbrella.ts:104`), which moves with the npm package instead, so that row
names both paths rather than one command that quietly covers half the cases. A
`repo-drift` row carries the repo alias (`user` / `system`) rather than hardcoding
one.

**Sign-in is per ACCOUNT (a slot), and a logged-out claim must be provable.**
A slot's STATE is derived from the slot itself, never from a version home its
label happens to match: `loadAccountCatalog` reads the slot's own credential live
(`getAccountInfo(agent, slot.slotDir)`) and the daemon's `probeLocalFleetAuth`
enumerates every registered slot on the box (`enumerateSlotInstalls`, rows keyed
`slot:<accountId>`) alongside `listInstalledVersions`. The slot record's
`verdict: unconfigured` is `ensureSlot`'s DEFAULT, not a probe result — the daemon
never publishes `unconfigured` — so it maps to `unverified` when the slot is signed
in and `missing` only when it is not. Before this, a slot re-materialized as
`unconfigured` while the device doc was unreadable stayed MISSING forever while
`agents run` used its login without complaint.
[`credentialPresence(agent, versionHome)`](src/lib/agents.ts) splits a credential's
existence into the per-version home and the active/global HOME; a logged-out
critical is emitted only when BOTH are absent (`provable = !perVersion && !active`).
A version sharing the global login is signed in, not out; an agent with no
inspectable identity (`!supportsAccountInspection`) never yields a logout finding,
not even the hedged warning. **Do not enumerate that set here or in tests** —
`ACCOUNT_INSPECTION_AGENT_IDS` and `CREDENTIAL_FILE_SEGMENTS`
([`src/lib/agents.ts`](src/lib/agents.ts)) are the source of truth and agents move
between them (antigravity and cursor both did, mid-review, each time turning a
hardcoded list into a false doc claim or a red test). Derive it:
`ALL_AGENT_IDS.filter(supportsAccountInspection)`. Login remediation for a
**named account** is `agents accounts login <harness>#<name>` on a headed
device. The leftover per-version form (`agents run <agent>@<version>` +
`loginHint`) remains the repair for pre-migration homes until they fold into
slots — and ONLY for the per-version-isolated set (claude/codex/grok/kimi/opencode/copilot);
gemini/antigravity/droid/cursor share their login, so the fix says so instead of
faking a per-version repair. Per-version sign-in rides the device inventory
(`FleetInventory.signIn`, populated by `collectLocalFleetSignIn` in
[`src/lib/devices/fleet-inventory.ts`](src/lib/devices/fleet-inventory.ts)); an
older remote CLI that omits it degrades to an "older agents-cli — upgrade" warning.

**Cross-device divergence lives in `agents doctor --devices`.** It compares each
device's self-reported harness inventory against the local baseline and flags a
resource / agent-version / config-repo present on one box but missing on another
(e.g. the `swarm` plugin on `zion` but not `yosemite-s0`). The data path:

- Every device's **top-level `agents doctor --json`** emits a `fleet` inventory
  field ([`src/lib/devices/fleet-inventory.ts`](src/lib/devices/fleet-inventory.ts) →
  `collectLocalFleetInventory`): installed resource names per kind, installed
  version ids per agent, and `.agents`/`.system` repo state (`readRepoState` in
  [`src/lib/git.ts`](src/lib/git.ts)).
- `runDevicesDoctor` ([`src/commands/doctor.ts`](src/commands/doctor.ts)) fans that
  payload out per device and runs the **pure comparator**
  [`compareFleetInventories`](src/lib/devices/fleet-divergence.ts) — SSH-free, so
  it's unit-tested against fixtures with no live fleet — then maps the divergences
  and each box's per-version sign-in into the hybrid via `fleetDivergenceToFindings`
  / `signInToFindings` / `renderFindings`
  ([`src/lib/devices/doctor-findings.ts`](src/lib/devices/doctor-findings.ts)).
- `agents fleet status` reuses the same comparator inside `buildFleetHealthReport`
  ([`src/lib/devices/health-report.ts`](src/lib/devices/health-report.ts)) to add a
  per-device `divergence` warning to its rollup.

Read-only by default — divergence detection never installs or syncs. `--json`
carries a stable `fleet` divergence block for the VS Code extension / Agency.

**Per-device harness/account readiness lives in `agents devices harnesses` /
`agents devices accounts` (RUSH-2003).** A fourth fleet lens, distinct from the
three diagnostics above: not "is the fleet healthy?" (`fleet status`) or "is a
token live?" (`fleet ping`), but "what can each box actually *run* right now?" —
per installed `agent@version`, its account, signed-in, quota, and a single `ready`
verdict (signed in AND not rate-limited). `harnesses` is the per-install view;
`accounts` collapses installs that share one account. The collector
([`collectLocalHarnessInventory`](src/lib/devices/harness-inventory.ts)) reuses
`getAccountInfo` (identity), the daemon-warmed usage cache via
`getUsageInfoByIdentity({ readOnly })` (quota — never blocks on a per-account
network fetch unless `--refresh`), and `deriveUsageStatusFromSnapshot` (throttle
state). Claude's managed status-line command also writes the native five-hour
and seven-day rate limits from normal interactive responses into that same
identity-keyed cache; it never reads or refreshes OAuth credentials. Two
invariants ride on that writer (PHNX-3392, spec GWT-E5c): a run that hits its
weekly limit persists a `rate_limited` `week` window
([`claude-statusline.ts`](src/lib/claude-statusline.ts) →
`mergeClaudeUsageCacheWindows`), so the next `collectRunCandidates` excludes
the account; and a MISSING snapshot is treated as unknown, never as headroom —
`capacityWeight(null, …)` draws `UNVERIFIED_WEIGHT` (1), not full capacity, so
a blind account on a worker box (usage 403s, RUSH-2392) can't outrank a
verified-healthy one, while an all-*blind* pool (no snapshots at all) still
draws a pick. An all-*stale* pool does NOT (PHNX-2526): when every account
carries a snapshot older than `USAGE_DECISION_MAX_AGE_MS` and none is verified,
`balanced`/`available` refuse to auto-pick on a plausible-but-wrong number —
`resolveRunVersion` returns `noVerifiedUsage`, an interactive run shows the
account picker and an unattended one fails loud with `NO_VERIFIED_USAGE`
(`formatNoVerifiedUsageError`); the stale candidates survive only in
`rotation.healthy` for bounded post-rejection failover. The distinction is
`hasStaleUsage` (a present-but-old number) vs blind (no number to be misled by).
The fan-out mirrors `fleet ping` (probe self in process, SSH each peer's
`devices harnesses --local --json` worker, same per-device + overall deadlines).
Everything but the collector is pure and unit-tested
([`harness-inventory.test.ts`](src/lib/devices/harness-inventory.test.ts)). Agent
coverage is `ALL_AGENT_IDS`-driven, so a new harness is included automatically.

**Usage is a per-account fact, fleet-synced from headed boxes (PHNX-3392).** A
Claude rate limit is metered per ACCOUNT, so the 5h/weekly numbers are identical
on every box — but only a headed device (`personal`/`desktop`) can READ them: the
usage endpoint needs the `user:profile` scope only the interactive login carries
(RUSH-2392), and the status-line writer above only fires on a box that runs Claude
interactively. A headless `worker` has just the `user:inference` setup-token,
which the endpoint 403s, so its `claude-usage.json` stays blank and `agents view`
shows no S:/W: bars. The `usage-sync` daemon service closes the gap without a
device-to-device SSH mesh: each headed daemon publishes one identity-keyed
snapshot to its owned tracked file at
`~/.agents/devices/<device>/daemon-state.json`; each tick automatically commits
only that owned file, fetches/rebases, and pushes the user repo under one
cross-process lock and a 45-second hard process-tree deadline. Each worker daemon
therefore receives the file without an operator running `agents repo sync user`,
then reads its local checkout and merges every headed snapshot
NEWEST-WINS (`ingestPeerClaudeUsageRows`, `src/lib/accounting/usage.ts`). Both
sides need not be online together, a tick opens no device-to-device SSH mesh, and two
headed publishers converge per identity regardless of order. The reserved-auth
readiness verdict (`ready`/`missing`/`invalid` metadata only; credentials never
enter Git) rides this **same** envelope and is published by the **same**
usage-sync tick, not a second committer (PHNX-4051 — see below). **The credential push is per KEY and per ROLE, not bundle-coarse
(PHNX-3940 T6).** Each portable account resolves to one reserved-store key
`<ENV>_<accountId>` in `__<harness>__` (a claude row predating T1 falls back to the
legacy `auth` alias keyed by email); the elected single publisher (`syncReservedStores`,
[`secrets-policy.ts`](src/lib/secrets-policy.ts)) pushes a reserved store to a
peer whenever that peer is missing **any** of its keys — so a newly-added account
propagates within one tick instead of hiding behind a coarse "already has the bundle"
verdict. **The publisher is a ready HEADED device** (`electPublisher`: `personal`/
`desktop` first — where tokens are minted — then by name to break ties); a worker is
elected only when no headed box is ready. Pushes target `role=worker` peers only: a
headed (`personal`/`desktop`) peer
receives the account **row** through the normal repo sync but **never a durable key**
(`isHeadedDeviceRole`, invariant 7). On a worker, `reconcileLocalWorkerSlots` →
`provisionWorkerSlot` materializes a slot for **every** registered account whose key
is on the box — a v2 row through its reserved key, a pre-v2 claude row through the
email-keyed `auth` token (both via `reservedSyncTargets`, so the push plan and the
materialization can never disagree) — and it runs **first** in the tick so a failed
shared-state git exchange cannot postpone it;
a native OAuth/session file is never transported (`fleet/auth-sync.ts`
`isCredentialSafeToPropagate` stays `false`). Each exceptional push is async with a
hard deadline that kills the direct SSH client and remote connection. The store path
and newest-wins flow have real-file tests
([`fleet-shared-state.test.ts`](src/lib/fleet-shared-state.test.ts),
[`usage-sync.test.ts`](src/lib/accounting/usage-sync.test.ts)); a real two-checkout
bare-remote test proves the automatic Git delivery
([`fleet-shared-repo-sync.test.ts`](src/lib/fleet-shared-repo-sync.test.ts)). The legacy hidden
`__usage-ingest`/`__usage-export` verbs remain compatible with older installed
peers and retain real-file / real-CLI coverage. A synced row reads as `last_seen`
(cached), never a live fetch, so a worker's bar is honest about being propagated.

**One committer per tick — usage-sync (PHNX-3792 session mirror, PHNX-4051 auth
verdict).** There is exactly one caller of `syncFleetSharedStateRepo` on the
periodic path: the `usage-sync` service. It publishes every owned conflict-free
field into its `devices/<device>/daemon-state.json` — the usage snapshot, EVERY
box's lightweight per-session preview/metadata (the `sessions` field), and the
reserved-auth readiness verdict — BEFORE the single commit/rebase/push, so all
three ride one exchange. `auth-sync` no longer runs its own exchange: it keeps
only its non-git duties (worker-slot reconcile + the credential SSH pushes,
under its own deadline and circuit breaker) and acts on the peer verdicts the
usage-sync exchange last delivered into the local checkout. Before PHNX-4051 both
ticks committed 30 s apart and contended for the one `proper-lockfile` lock
(20×100 ms of retries vs a multi-second real fetch/rebase/push), so the usage
tick logged "Lock file is already being held", workers never got a fresh usage
snapshot, and the 40-min placement gate (`viewAgentAccountEligibility`) turned
every worker into "no ready device". Every box except a marked `worker` folds
peers' digests into its local `sessions` index as mirror rows. Only topic/label,
a first-user-message snippet, last-activity, agent+version, cwd, ticket, and PR
ride — never a transcript — and the mirror is bounded (200 recent sessions per
box) and pruned by age (14 days). This is what lets the picker / `agents sessions`
/ `focus` render a remote-host row's topic and preview INLINE (no per-row SSH),
and keep showing the last-synced preview when the peer is offline. Publish/consume
+ prune live in [`src/lib/session/mirror.ts`](src/lib/session/mirror.ts), the DB
mirror writer/pruner in [`src/lib/session/db.ts`](src/lib/session/db.ts)
(`upsertMirrorSession` / `pruneMirrorSessions`, guarded so a mirror never
overwrites a genuine local transcript row), and the inline render in
`buildPreview` ([`src/commands/sessions-picker.ts`](src/commands/sessions-picker.ts)),
which still falls back to the live SSH digest fetch for a never-synced session.

### 11. Session recovery is one decision on the origin device

`resolveSessionRecovery` in `src/lib/session/recovery.ts` is the only place that
chooses native resume versus `/continue`. `sessions resume` and
`run --resume` route through it — as do the retired `focus`/`attach`/`reconnect`
spellings, which are hidden aliases that still run the same bodies. Native resume is valid only in the exact origin version's isolated home when
that home still owns the indexed transcript AND some injectable credential for
this harness is healthy (the origin login, or a provider rotated in on a usage
limit). A removed, signed-out, revoked, trashed, backup-only, or same-number
reinstalled origin — or a limited origin whose transcript is no longer in that
home — uses a healthy account of the same harness and reads the indexed
transcript with `/continue`. Claude native resume uses the earliest
recorded transcript cwd, which selected `projects/<cwd-key>`, not the later cwd
stored from its first user turn. Never add a caller-local fallback that
native-resumes another version home, and never let `run auto` change harnesses
during recovery.

**Native-first with same-harness account rotation (PHNX-3626).** An
exhausted/rate-limited origin does NOT drop straight to `/continue`. When the
origin version home is installed, native-resume-capable, and still owns the
transcript, recovery first rotates to a healthy **injectable** account of the
SAME harness — a durable provider setup-token/API-key account (RUSH-3182), the
only kind that can authenticate a resume that must read the origin home's
transcript, since a native login lives in its own isolated home and cannot be
forwarded — and stays NATIVE in that same home (`RecoveryAccount`, injected via
the `--account` spawn path). `resolveSessionRecovery` reads the provider-inclusive
pool (`collectRunCandidatesForRun`) for exactly this. `/continue` is last-resort:
a signed-out, revoked, trashed, backup-only, or same-number-reinstalled origin,
or a limited origin whose transcript is no longer in that home. When that
continue pick is a provider account, the target still carries `RecoveryAccount`
and exec injects it the same way native does (PHNX-3674) — otherwise spawn would
authenticate as the version home's native login, which is the exhausted origin
when no healthy native sibling exists. The balanced picker (`--strategy
balanced`) is the same weighted-by-headroom selector dispatch uses; there is no
second scheduler.

**The origin version is recorded forward at launch.** `buildExecEnv` exports
`AGENTS_RUN_VERSION`, the SessionStart hook joins it to the harness's real session
id in the `by-session/<id>.json` sidecar (like `mode`), the scan joins it at row
build (`meta.version ?? actorRec.version` in `upsertSession`), and the db upsert
COALESCEs it — the same write-once launch-metadata treatment as `mode`/`harness`/
`actor`. So a session whose transcript carries no derivable version (codex's
`.codex-homes/<version>/` home, which `extractVersionFromManagedPath` also now
reads) still native-resumes instead of degrading to `/continue` for a missing
recorded origin. Because version is now launch metadata rather than a purely
transcript-derived field, it is excluded from the incremental-scan parity check
(alongside `actor`/`harness`/`mode`), since an incremental row legitimately
preserves a recorded origin a from-scratch reparse of rewritten content cannot
re-derive. This is what fixed the "origin version was not recorded" fallback.

**Prefer-device, fall back to local.** Resume runs on the recorded owning device;
when that device is genuinely unreachable it falls back to a LOUD local
`/continue` replay from the synced mirror rather than dead-ending
(`resumeLocalFallbackSource` rewrites `machine` to self so the delegated run
resolves locally). Both unreachable shapes trigger it: `runOnPeer` → `no-target`
(the device is not a dialable registered device) and `runOnPeer` → `unreachable`
(a registered device whose SSH connection failed — asleep/offline, ssh exit 255,
classified by `peerHopOutcome`). Resolving `ok` on a connect failure was the bug
that silently no-op'd resume against an offline registered box. Safe against the
RUSH-2022 silent-fork hazard by precondition: the owner was proven unreachable,
so there is no live process to fork.

## Configuration surface

All persistent configuration that affects how agents run — default model, mode,
effort, tier overrides, interactive host, browser profile, and per-device limits —
lives under one command barrel:

```bash
agents config list
agents config get <key>
agents config set <key> <value>
agents config unset <key>
```

Keys use `agent@version` as the canonical harness identifier. Examples:

```bash
agents config set run.claude@*.model best
agents config set run.claude@*.tier.best claude-opus-4-8
agents config set run.claude@2.1.45.model claude-opus-4-8
agents config set run.claude@*.mode auto
agents config set run.claude@*.effort high
agents config set interactive.host zion
agents browser use work
agents config set auto.pool workers
agents config set devices.mac-mini.role worker
agents config set devices.mac-mini.max-agents 4
agents config set devices.mac-mini.scheduler off
agents config set devices.mac-mini.tmux off
agents config set summarizer.enabled on
agents config set summarizer.baseUrl http://localhost:11434
agents config set summarizer.model qwen2.5:3b
```

The new command is a **facade over the existing YAML storage**
(`run.defaults`, `model.tiers`, `config.interactiveHost`,
`defaultBrowserProfile`, and `deviceConfig`). Fleet sync behavior is unchanged.

`summarizer.*` (user-scope, central `agents.yaml`, syncs fleet-wide) gates the
**per-session summarizer** (PHNX-3939): `summarizer.enabled` (default **false**),
`summarizer.baseUrl` (an Anthropic-wire endpoint — Ollama/vLLM/LiteLLM), and
`summarizer.model`, each overridable per-process by `AGENTS_SUMMARIZER_ENABLED` /
`AGENTS_SUMMARIZER_BASEURL` / `AGENTS_SUMMARIZER_MODEL`. See
[§Per-session summarizer](#per-session-summarizer-phnx-3939).

`devices.<name>.tmux` (stored as `tmux.enabled`) defaults off, so a LOCAL
interactive `agents run` launch spawns the agent directly. Turn it on for a
device to wrap eligible local launches in the shared-socket tmux session and give
each agent an exact `%pane` address for `agents message`, injection, and
`agents focus`. The setting is machine-local and cannot be set for a peer.

**It does not govern a run dispatched here over `--device` (RUSH-3125).** That
run's stdio is an ssh link, so without the wrap a blink SIGHUPs the agent and the
in-flight turn is lost — and `lib/hosts/reconnect.ts` re-attaches on the premise
that it survived. Durability is not the local operator's mouse/clipboard/
scrollback preference, so the two are separate concerns: the interactive
dispatcher exports `AGENTS_REMOTE_INTERACTIVE=1` (`REMOTE_INTERACTIVE_ENV`,
[`src/lib/types.ts`](src/lib/types.ts)) and the peer wraps on it regardless of
`tmux.enabled`. A remote interactive run on a box with **no tmux installed** is
refused (`undurable`) rather than started as something a blink would kill.

`--no-tmux`, `--raw`, and `AGENTS_NO_TMUX=1` remain per-run opt-outs and beat the
durability rule too, so the escape hatch keeps working over `--device`. The gate
is `resolveTmuxWrap` ([`src/lib/exec.ts`](src/lib/exec.ts)) — three outcomes
(`wrap` / `bare` / `undurable`), reading `isTmuxEnabled()` and the marker.

`devices.<name>.role` (stored as `role`) says what a device is for fleet-wide —
`worker` (agents run here) or `personal` (a machine you sit at).
`agents devices role <name> <role>` is the task-shaped spelling. Marking any
device `worker` turns automatic placement into an allowlist: `--device auto` then
picks only from the marked workers, in every caller (`run`, `teams`, `ssh auto`,
the generic `--device auto` passthrough, and the AGI EXT launch commands, which
resolve placement through the CLI rather than scoring devices themselves); a
`personal` or `desktop` box is never picked automatically. The rule is one function —
`filterAutoPool` in [`src/lib/devices/pool.ts`](src/lib/devices/pool.ts) — read by
`listOnlineDeviceNames`, and `auto.pool` (`workers` by default, or `all`) turns
the allowlist off. When roles leave the pool empty, **both** resolvers throw
(`formatEmptyAutoPoolError`): a `null` host means "run locally", which on a
`personal`/`desktop` box is the outcome the mark exists to prevent. Unlike the machine-local
keys, `role` is **shared**: it lives in that device's tracked
`devices/<name>/agents.yaml` `config.role` and syncs with `agents repo
push/pull`, because every box has to agree on where agents may land. The
vocabulary is `worker | personal | desktop`. `desktop` is a headed always-on box
— the release/credential home, e.g. a Mac mini: it is NOT headless fan-out
capacity, so like `personal` it is excluded from `--device auto` (both are in
`NEVER_AUTO`), but it IS a headed box with a real interactive login, so for the
Claude auth strategy it sits in the SAME "headed" bucket as `personal`
(`isHeadedDeviceRole`, `device-config.ts`) — it authenticates from its own
per-version login, never the worker setup-token. **Which credential a run injects
is keyed on DEVICE ROLE, not run mode** (`isHeadedDeviceRole`, not `ctx.interactive`,
in `applyExecConfigEnv`): a worker authenticates EVERY run — interactive dispatched
TUI or headless — from its `user:inference` setup-token (the non-interactive worker
credential, minted via `agents accounts add claude <name>`), while a headed box uses its native
`user:profile` login for both. Keying on run mode instead is the PHNX-3502 (worker
`--interactive --device` → login screen, the setup-token sitting unused) / RUSH-2395
(headless laptop run → hijacked the human's login) bug pair. Full model:
[`cli/docs/credential-management.md` §Which credential a run injects](docs/credential-management.md).

**Owner rule — never regress (credential-management.md invariant 7).** A headed
box (`personal`/`desktop`, e.g. `zion`) authenticates ONLY with its native
interactive OAuth login, never the long-term setup-token — the token is
identity-blind, and the headed box is where the token is minted. A dead/expired
native login on a headed box is fixed by re-running the native OAuth flow
(`claude` → `/login`, or `agents accounts login claude#<name>`), NOT by falling back to
the injected setup-token. Do not add a "native login expired, use the token
instead" fallback on a headed device — that inverts the rule.
`agents accounts add` is headed-only: on a worker it refuses before allocating
a slot, installing, or opening a browser. Add the account on a personal/desktop
device; workers are provisioned from the durable credential the add mints
(claude: a `setup-token` driven in the account's slot; api-key harnesses:
`--api-key` or a prompt; `fleet login` for a token-less harness). `accounts
login <harness>#<name>` re-auths into the same slot and re-mints; `accounts
default <harness> [name]` is the one default write path.

The one display consequence:
because a `personal` box is by definition the interactive seat, `agents devices
list` folds the `★ interactive` star INTO the `personal` role rather than
printing both (the star still shows for a non-personal box pinned as
`interactive.host`).

`auto-launch.enabled` / `auto-launch.preferred` are the per-device switches that
modulate that SAME `filterAutoPool` pool — one placement rule, not a second one.
`agents devices disable <name>` sets `auto-launch.enabled` = false and drops the
box from the pool the same way a `personal`/`desktop` role does, so it leaves
EVERY automatic-placement path (`run`, `teams`, `ssh auto`, the AGI EXT launch
commands) at once; `agents devices enable <name>` (the default) restores it.
`agents devices prefer <name>` sets `auto-launch.preferred` = true, which does NOT
narrow the pool — it BOOSTS the box in the ranker: `autoLaunchPreferredSet`
(`pool.ts`) feeds `pickBestDevice` (`teams/scheduler.ts`), which ranks a preferred
device ahead of its load-equal peers, after the signed-in tier and before load, so
the boost overrides load-based ordering without overriding hard health;
`agents devices unprefer <name>` removes it. Both flags are **shared** device-scope
keys living in `devices/<name>/agents.yaml` `config.autoLaunch{Enabled,Preferred}`
(a fleet-wide default rides `fleet.defaults.config`, set with `--fleet`), so they
sync with `agents repo push/pull`. The four verbs are task-shaped forwarding
spellings for `agents devices config <name> auto-launch.{enabled,preferred}
<on|off>` — the one canonical per-device settings surface — so they print a
deprecation-style "running that for you" notice and defer to it. The **menu bar**
surfaces `auto-launch.preferred` as a per-device **★ Favorite / Unfavorite**
toggle (writing that same canonical `devices config … auto-launch.preferred
on|off`, no separate store): a favorited device shows a ★ and sorts directly below
the current machine, above the rest, in the DEVICES section (PHNX-2376).

`devices.<name>.description` (stored as `description`) is the free-text sibling
of `role`: one line saying what the box is FOR — "gpu box — cuda 12.4", "release
runner" — where `role` is the two-value placement switch. Like `role` it is
**shared**: it lives in the device's tracked `devices/<name>/agents.yaml`
`config.description` and syncs with `agents repo push/pull`, and any box may set
it for any device. `agents devices describe <name> <text>` is the task-shaped
spelling (thin sugar over `agents devices config <name> description` — one
store, two names), and the default `agents devices list` renders it as the tail
column next to a `spec` cell (cores / total RAM / total disk) and `load`, `mem`,
`disk` used columns (RUSH-3062). It is validated as a single
line capped at 80 characters — a newline or an over-long value is rejected
loudly, never truncated. It is NOT `notes`: `notes` stays an appended list of
long-form operator scratch that is never shown in device listings.

`agents devices ignored` lists the tailnet nodes dismissed from auto-discovery —
each with when it was dismissed and which machine dismissed it, read from the
tracked `fleet.ignored` block that `agents devices ignore` writes and
`agents repo push/pull` syncs. The `agents devices list` footer names how many
are hidden so a dismissed box is never silently absent; `agents devices unignore
<name>` puts one back (RUSH-3062).

Native-account names (set at `agents accounts add <harness> <name>`; the hidden
`accounts label` still writes them) are the same kind of fleet-wide
fact: they bind to a stable `(agent, identityKey)` (email / org key), not a
device or a version. They live on the central `accounts.native` rows in
`~/.agents/agents.yaml` — already classified `central` and synced by
`agents repo push/pull` — so `codex#personal` selects the same login on every
box. A git merge of two independently labeled boxes can union two UUID rows for
one identity; `accounts remove` / `rename` / `label` operate on every matching
row so a sibling cannot silently survive.

**A label name is unique per HARNESS, not globally (PHNX-3887).** One human
identity is routinely signed into several harnesses — the same email is a claude
login AND a codex login AND a grok login — so a global namespace let whichever
harness was labelled first squat the good name and forced prefixed junk
(`cxicloud`, `gkicloud`) on the rest. `assertUniqueUnifiedName`
([`src/lib/account-registry.ts`](src/lib/account-registry.ts)) scopes the check by
`agent`, so `claude#icloud` / `codex#icloud` / `grok#icloud` each resolve to that
harness's own row. Nothing is ambiguous at the point of use: the selector already
names the harness, and `findUnifiedAccount`'s `preferAgent` already disambiguated
on the read side. A duplicate label WITHIN one harness is still refused, and
**provider** (non-native) accounts stay globally unique — they are selected by bare
name via `--account`, with no harness to scope them by. `accounts rename` /
`remove` / `view` accept `<harness>#<name>` and refuse a bare name that spans several
harnesses rather than guessing (PHNX-3988).

**Writing a label commits `agents.yaml`.** Version-scoped rows land in the central
`agents.yaml` via a plain file write, while the daemon's shared-state tick committed
only `devices/<device>/daemon-state.json` and then rebased `--autostash` over the
dirty central file — so every box silently lost its account labels on its next
publish. The publish stages `agents.yaml` alongside the device doc
([`src/lib/fleet-shared-repo-sync.ts`](src/lib/fleet-shared-repo-sync.ts)) so the
rebase carries the rows instead of stashing them.

`interactive.host` is a **user-level** preference: it lives in central
`~/.agents/agents.yaml` under `config.interactiveHost`, syncs fleet-wide via
`agents repo push/pull`, and answers "which device shows me artifacts?" It is
intentionally not a per-device key. To see it in the per-device view, use
`agents devices config <name> --inherited`.

The old commands still work but are deprecated and print a warning pointing to
`agents config`:

- `agents models tier` → `agents config set run.<agent@version>.tier.<tier>`
- `agents devices set-interactive` → `agents config set interactive.host <name>`
- `agents devices configure` → `agents config set devices.<name>.<key>`
- `agents browser profiles set-default` → `agents browser use <name>`

Implementation: [`src/commands/config.ts`](src/commands/config.ts) with key
parsing in [`src/lib/config-keys.ts`](src/lib/config-keys.ts). Per-device config
helpers live in [`src/lib/device-config.ts`](src/lib/device-config.ts).

## Supported harnesses

The supported harnesses are the entries in the `AGENTS` registry
([`src/lib/agents.ts`](src/lib/agents.ts)) — the canonical list, gated through
`supports()`; the full id union is `AgentId` ([`src/lib/types.ts`](src/lib/types.ts)).
The table below is a snapshot of their per-harness capabilities — keep it in sync
with the registry. **Prioritized (first-class):** Claude Code, Codex CLI, Kimi CLI,
Antigravity CLI, Grok CLI, OpenCode — features target these six first.

| Harness | `id` | hooks | mcp | allowlist | skills | commands | plugins | subagents | workflows |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| ★ Claude Code | `claude` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ★ Codex CLI | `codex` | ≥0.116 | ✓ | — | ✓ | <0.117 | ≥0.128 | ≥0.117 | — |
| ★ Kimi CLI | `kimi` | ✓ | ✓ | ✓ | ✓ | — | ✓ | ≥0.29.0 | ✓ |
| ★ Antigravity CLI | `antigravity` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥1.0.16 | ≥1.0.6 |
| ★ Grok CLI | `grok` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥0.2.111 |
| ★ OpenCode | `opencode` | ≥0.3.130 | ✓ | ≥1.1.1 | ✓ | ✓ | ✓ | — | — |
| Cursor | `cursor` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥2026.1.22 | — |
| OpenClaw | `openclaw` | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Copilot | `copilot` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ≥0.0.353 | — |
| Amp | `amp` | — | ✓ | — | ✓ | ✓ | — | — | — |
| Goose | `goose` | ≥1.34 | ✓ | — | ≥1.25 | — | ✓ | — | ✓ |
| Droid | `droid` | ✓ | ✓ | ≥0.57.5 | ≥0.26 | ✓ | ✓ | ✓ | — |
| Hermes | `hermes` | ≥0.11 | ✓ | — | ✓ | — | — | — | — |
| Muse Code | `muse` | ✓ | ✓ | — | ✓ | — | ✓ | — | — |
| Warp Agent CLI | `warp` | — | ✓ | — | ✓ | — | — | — | — |

✓ = supported · — = not · version cell = only within that range (out-of-range =
skipped silently). [`src/lib/agents.ts`](src/lib/agents.ts) is canonical — keep this
snapshot in sync. `workflows` is `claude`/`kimi`/`goose`/`antigravity` (≥1.0.6, written to the
shared HOME-global `~/.gemini/config/global_workflows/`, not a per-version home), `openclaw` (Lobster `.lobster` files under `.openclaw/workflows/`), and `grok` (≥0.2.111, native Rhai under `.grok/workflows/`); `mcp` is universal; `allowlist` is
`claude`/`cursor`/`opencode`/`antigravity`/`grok`/`kimi`/`droid`/`openclaw`/`copilot` (Copilot writes per-location approvals to `~/.copilot/permissions-config.json`; **Goose is deliberately NOT allowlist-capable** — its `permission.yaml` gates whole tools (`developer__shell`, `developer__text_editor`), so a canonical rule set could not be expressed or read back faithfully; OpenClaw is tool-level only —
blanket rules map to `~/.openclaw/openclaw.json` `tools.alsoAllow`/`tools.deny`, sub-command patterns skipped); `subagents` is `claude`/`codex`/`kimi` (≥0.29.0, Claude-shaped `<name>.md` in `~/.kimi-code/agents/`; older kimi-code compiles its agent profiles into the bundle with no filesystem loader)/`grok`/`openclaw`/`droid`/`copilot`/`antigravity`/`cursor` (≥2026.1.22). **Warp Agent CLI (`oz`)** is the coding-agent CLI on Warp's Oz platform (the shared Warp binary invoked via the `oz` symlink). Install is self-updating via `brew install --cask oz` (macOS) / the `oz-stable` apt|yum|pacman package (Linux); config lives under `~/.warp/`, the rules/context file is `AGENTS.md`, and auth is `oz login` (browser OAuth) or a `WARP_API_KEY` token for headless/CI (`oz api-key create`). Headless run is `oz agent run --prompt "<task>" [--model <id>]`; autonomy is governed by the selected agent profile (`--profile`), not a per-run permission flag, so the single `edit` mode maps to no flags (mirrors Hermes). `mcp` covers stdio + http + headers via the Claude `.mcp.json` schema at `~/.warp/.mcp.json` (project `<root>/.warp/.mcp.json`); `skills` come from `--skill` + `oz agent skills`. `hooks`/`allowlist`/`commands`/`plugins`/`subagents`/`workflows`/`memory` are OFF: Oz has no event→shell hook registration, its permissions are profile-based (not a Claude tool allow/deny list), slash-commands are native/server-managed, and cloud agents/profiles are server-side (no installable subagent dir). Warp is intentionally **absent from `SESSION_AGENTS`** — Oz stores conversations server-side (retrieved with auth via `oz run conversation get <id>`), so there is no local transcript for `agents sessions` to index — and it exposes no usage/limits endpoint, so `agents view` shows no usage bar for it.
**Gemini is hard-deprecated.** Keep the legacy `gemini` id only for parsing old
sessions/config; `agents add gemini`, `agents import gemini`, and
`agents sync gemini` fail and point users to Antigravity.

**Account capabilities are a separate axis (PHNX-3940).** The table above gates
*resource* writes; whether a harness's native login can be **named/attached** and
what **durable worker credential** it can mint are governed by two other canonical
tables, not this one — do not fold them in. Native naming lives in
[`account-capabilities.ts`](src/lib/account-capabilities.ts)
(`NATIVE_ACCOUNT_CAPABILITIES`): claude/codex/grok/cursor/kimi are **supported**,
muse is **conditional** (email-only), the device-scoped opaque harnesses
(antigravity/droid/opencode) are **unsupported** until a device-id discriminator
exists, and the rest are discovery-only/unsupported. The worker credential kind lives in
[`harness-auth-capabilities.ts`](src/lib/harness-auth-capabilities.ts)
(`HARNESS_AUTH`); the reserved store that holds it is
[`reserved-stores.ts`](src/lib/reserved-stores.ts) (see
[`docs/credential-management.md` §Slots and reserved stores](docs/credential-management.md#slots-and-reserved-stores-phnx-3940)):
claude mints a `setup-token`; codex/grok/cursor/opencode/droid carry a provider
API key; kimi and antigravity have no portable credential and log in per box
(`agents fleet login`). `agents accounts add <harness> [name]` is the one
onboarding verb across all of them — headed devices only; workers are provisioned
automatically from the minted credential.

### Codex's Linux sandbox needs unprivileged user namespaces (PHNX-3285)

Codex ≥0.146 is the **only** harness that sandboxes its own tool calls on Linux
with a bundled **bubblewrap** — it extracts `codex-linux-sandbox` + `bwrap` per run
and sets up mounts inside a fresh unprivileged **user namespace** (`--unshare-user`,
then a `/proc/self/uid_map` write) for both `read-only` and `workspace-write` modes
(only `skip` = `--dangerously-bypass-approvals-and-sandbox` uses no bwrap). The
legacy Landlock backend is gone (`use_linux_sandbox_bwrap` is `removed`,
`use_legacy_landlock` panics under the permission-profile model), so bwrap is the
only Linux sandbox path. grok/kimi/cursor/etc. do **not** sandbox this way, so this
is codex-specific.

Ubuntu 23.10+ ships `kernel.apparmor_restrict_unprivileged_userns=1`, which denies
that userns to an unconfined binary — bwrap then dies with `bwrap: setting up uid
map: Permission denied`, and a **headless** codex run (an `agents teams` codex
teammate, or `agents run codex` — always headless + sandboxed) lands **zero tools**
while still reporting a completed turn. `spawnAgent` preflights this before the
spawn (`codexSandboxPreflight` in [`src/lib/exec.ts`](src/lib/exec.ts), probing
[`src/lib/linux-userns.ts`](src/lib/linux-userns.ts)) and **fails loud** with the
one-time fix instead of silently under-delivering. Scope is deliberate: codex +
Linux + headless + a sandboxed (non-`skip`) mode only — an interactive TUI surfaces
the bwrap error itself, `--mode skip` uses no sandbox, and macOS/Windows never hit
it. The intended `auto` = workspace-write + `approval_policy=never` config is never
weakened.

The one-time fix keeps the sandbox intact — re-enable unprivileged userns per box:
[`scripts/enable-codex-sandbox.sh`](scripts/enable-codex-sandbox.sh) writes the
`kernel.apparmor_restrict_unprivileged_userns=0` sysctl drop-in, applies it, and
re-probes to confirm it took. Run it once per fleet worker
(`sudo bash cli/scripts/enable-codex-sandbox.sh`, or fan out with
`agents ssh <box> 'sudo bash -s' < cli/scripts/enable-codex-sandbox.sh`).

## Source layout

```
src/
  index.ts             # CLI entry (commander.js)
  commands/            # User-facing subcommands (one file — or a `<cmd>-*.ts` family, e.g. the `sessions*.ts` family — per `agents <cmd>`)
  lib/
    state.ts           # Path constants; agents.yaml read/write (serializeCentral preserves comments)
    manifest.ts        # Project/user agents.yaml Manifest read/write (comment-preserving Document round-trip; used by mcp add, etc.)
    resources.ts       # resolveResource() / listResources() — layered resolution
    capabilities.ts    # supports() — the per-agent write gate
    agents.ts          # re-exports agent-spec/agents.ts (per-agent capability table)
    agent-spec/        # version-resolution engine + AGENTS table
    subagents-registry.ts  # SUBAGENT_TARGETS — declarative per-agent subagent shape (dir/layout/transform); generic install/list/remove engine
    workflows-registry.ts  # WORKFLOW_TARGETS — declarative per-agent workflow shape (dir/layout/transform/marker); generic sync/list/remove/drift engine the staleness detector also reads
    installations/     # versions.ts (install, remove, syncResourcesToVersion), migrate.ts (one-shot idempotent migrations), store/resolve/strategies, shims.ts (shim generation, config symlink switching)
    hooks/             # hooks.yaml parser + per-agent registrar (install.ts), `matches:` evaluator (match.ts), cache/profile adapters
    browser/           # browser IPC service hosted by the shared daemon + existing CDP connection pool; browser clients may enable/disable this service but never stop/restart the shared daemon; registry.ts is the leaf (who declared what — never whether this machine should); resolve-target.ts is three outcomes (local / tunnel / loud undeclared); task-index.ts binds --device at start so later verbs resolve the task; ipc.ts owns one-shot and persistent socket clients, stream.ts owns the NDJSON action loop; hygiene.ts is the abandoned-task reaper (session-dead + idle, RUSH-2622) the daemon's 5-min tick and `agents browser prune` (alias `gc`) both call
    monitors/          # event-triggered watchers; architecture in docs/automation.md
    projects.ts        # named multi-repo definitions and status projection; domain model in docs/concepts.md
    project-pull.ts    # fleet pull with fast-forward, clean-tree, branch, and repository-identity guards
    session/           # `agents sessions` READER — discovery/parse/render of agent transcripts; also `migrate-targets.ts` (the `sessions migrate` target scorer); `db.ts` `queryResourceUsageStats`/`backfillResourceUsage` back `agents sessions stats` + `sessions backfill resources` (skill/command usage rollup, session_resource_usage + resource_scan_ledger); `claude-accounts.ts` attributes each Claude transcript to the account that produced it (account_key) and `insights.ts` extracts the cached multi-harness friction/correction/automation facets behind `agents sessions insights` (`agents insights` alias) — including a shell-command-by-binary breakdown (`bashCommands`/`bashCommandFailures`, keyed by `bash-command.ts`'s `bucketKey`) that splits the flat `Bash` tool count into `git commit`/`gh pr`/`agents ssh`/… so the tool mix and failed-tool loops name the actual command, not just the harness tool
    terminal/          # Terminal launch engine — tab/split in iTerm/Ghostty/tmux/Terminal.app, local or --device;
                       #   preferred.ts resolves WHICH terminal for a GUI caller (from live sessions' host app)
    cloud/             # Provider registry (Rush / Codex / Factory / Antigravity)
    teams/             # `agents teams` orchestration
    computer/          # `agents computer` client (computer-rpc.ts openComputerClient() transport switch → native/computer-mac Unix socket / native/computer-win TCP over ssh -L / rfb-client.ts RFB-VNC desktop; des.ts is the pure-JS DES for VNC auth) plus dispatch/download/loop
    menubar/           # AGI Menu installer/downloader/snapshot (the helper's SOURCE is phnx-labs/agi-menu, PHNX-4036)
    profiles.ts        # Host CLI + endpoint + model bundles
```

Note: `src/lib/session/` here is the transcript **reader**. The live-session
**writer** is a separate package, [`packages/session-tracker`](../../packages/session-tracker)
— different data, different consumer; see its AGENTS.md.

### `agents sessions` preview architecture (map before you touch it)

The interactive UI is three picker variants in `src/lib/picker.ts`: `itemPicker`
(single-select, `space` toggles preview), `dynamicPicker` (async data source, used
by the session browser, `tab` toggles preview), and a multi-select variant. All
render a right/bottom **preview pane** built by `buildPreview(session)` in
`src/commands/sessions-picker.ts` — a header (title/agent/model/cwd/ticket/PR) plus
`formatCompactPreview`'s verb-led rows (RUSH-2757): `Asked` (originating prompt),
`Doing` (checklist/team/sub-agents), `Made` (file deltas, artifacts, plan, PR),
`Health` (errors + test verdict), `Cost` (msgs/tokens + tool mix), `Latest` (the
full last message, wrapped), and one width-capped `Details ▸` fold (session id,
skills, plugins, hooks, links, dirs, repos).
`agents sessions preview <uuid-or-prefix>` uses the same card without the picker.
ID-shaped selectors go through the indexed fleet resolver, remote cards render on
their owning peer, and the normalized digest is cached in SQLite against the
transcript's actual mtime + size. Live status is deliberately outside that durable
digest and expires after 15 seconds through `session-cache.ts`. A remote-host row
whose lightweight digest was fleet-synced (a `mirrorSyncedAt` row — see §10 the
session mirror, PHNX-3792) renders its topic + first-user preview INLINE from that
local mirror with no per-row SSH; only a never-synced remote row still triggers the
live `sessions preview <id> --local --json` fetch over SSH.

Indexing is lazy — only `discoverSessions` writes the index — so a session THIS
box just started is "running" in `--active` before it is indexed. The id resolver
(`computeLocalMetadataMatches` in `sessions.ts`) therefore unions the indexed
rows with the LIVE registry on a cold id miss, so `preview`/`resume`/`focus`
resolve a running session with no transcript row yet (the fan-out peer answers
from the same union, so it works cross-device too — SES-9b). The daemon keeps the
index current within seconds via `runSessionIndexWarmTick`, and the cold-miss
repair waits for a concurrent scan rather than returning a stale read
(`discoverSessions({ waitForScan })` — SES-9c). This is why a running session no
longer reads "No session matching" during the index-lag window (RUSH-2682).

**A unioned live row is not automatically a LOCAL answer (PHNX-3890).** The box
that *launched* a session running on a peer holds a live row for it with no
transcript on disk and a `machine` that defaulted to itself — the launch process is
here, the conversation is not. So the full-UUID short-circuit only skips the fleet
fan-out for a row this box can actually answer for (`isLocallyDefinitiveMatch`: a
real `filePath`, or a `machine` that is genuinely attributed), and the live bridge
first re-attributes such a row against the fleet-active snapshot
(`reconcileLiveMetaMachine`). When the fan-out does run, the owning peer's answer
displaces the shim (`preferOwnerAttribution`) — candidates are grouped per machine
and consumers read the first hit, so fanning out alone would still let the launcher
box win. Read the launcher-shim rule in
[`docs/specifications.md` §Active sessions](docs/specifications.md#sessions) before
touching any of it.

Routing lives in `src/commands/sessions.ts`: `isBareBrowserListing`
(+`hasNoBrowserDisqualifyingFlags`) gates the bare fleet-wide listing to the rich
`runSessionBrowser` ([`src/commands/sessions-browser.ts`](src/commands/sessions-browser.ts));
a query/filter falls through to `pickSessionInteractive` → `sessionPicker`.
`--flat`/`--tree`/`--json`/`--no-interactive` print non-interactive views with no
preview. `PICKER_RECENT_COUNT = 15` caps the picker's list rows.

Gotcha: the preview pane has **no guaranteed height** — `availablePreviewRows =
terminalRows() - fixedRows` (`picker.ts`), and `limitPreviewHeight` returns `''` when
that collapses, so the preview can silently vanish on a full/short terminal (the
RUSH-2198 bug). See the [§Contracts §Sessions spec](docs/specifications.md#sessions)
for the non-empty-preview invariant (SES-8).

### Resume is machine-bound — check the owner before you start a harness

**Reading and resuming follow different machines, and conflating them is the bug.**
Reading follows the FILE — a synced mirror with a readable `filePath` is on this
disk and previews locally, even when `machine` names its owner. Otherwise, a row
whose `machine` names another box must be read on that peer. `_remote` is one
explicit signal, not the gate: host-dispatch index rows and live-registry rows can
name a peer without carrying it. `transcriptOnPeerOf` in `sessions-picker.ts` is
the one predicate used by picker previews, direct `preview <id>`, and `sessions
<id>`. Resuming follows the HARNESS STATE, which is on the owning machine whatever
the transcript's location. A mirror is therefore readable and NOT resumable, and
that is the trap: nothing fails until the agent is asked to continue a conversation
it has never seen, and `sessions-resume.ts`'s `fs.existsSync(cwd)` fallback then
quietly resumed in `process.cwd()` (RUSH-2022, PHNX-3481).

`sessionOwnerDevice`
([`src/lib/session/resume-owner.ts`](src/lib/session/resume-owner.ts)) is the one
answer to "may this resume run here?". Every path that starts a harness from a picked
row consults it first: `agents sessions resume` and the `agents sessions` picker hop to the
owner, and `sessions attach` hops as an **attach** (its detach record and the
headless process it stops are both on the owner — hopping as a bare resume would
skip the stop and leave two processes on one transcript). The batch
`sessions resume` mostly inherits it for free: every TAB it opens runs the
canonical `agents sessions resume <id>` (`lib/session/resume-command.ts`), whose docblock
already promised source-device routing — this is what makes that true. Its
no-tab-backend path (`inplace`, which any Linux box in a plain ssh shell lands on)
never runs that command, so it routes explicitly via `resumeOnOwnerIfRemote`.
`resumeSessionInPlace` is the LOCAL takeover and **fails loud** if it is handed a
peer-owned session, since reaching it with one means a caller skipped its routing
step.

The hop uses `runOnPeer` ([`src/lib/session/remote/remote-list.ts`](src/lib/session/remote/remote-list.ts)),
not the `--device` passthrough. Two reasons: the passthrough re-discovers locally and
dead-ends for a session that exists only on the peer, and it marks the run
`AGENTS_FLEET_REMOTE` — a one-shot command may carry that consent marker, but a
resumed session would inherit it for its whole life and `agents browser start` inside
it would be refused as a cross-machine drive.

The signal is only as good as what wrote it: `machine` on a host-dispatched run is
stamped by [`src/lib/hosts/session-index.ts`](src/lib/hosts/session-index.ts) from
the dispatch host. Any new writer of an `agents run --device`-shaped row must set it,
or the index will claim the dispatching box.

## Native helpers (downloaded on demand, never bundled)

**No native binary ships inside this package's npm tarball** (RUSH-3100). Every helper
is a signed + notarized GitHub release asset on its OWN tag, downloaded and verified on
demand — see `src/lib/helper-versions.ts` for the per-helper version floors. That is what
lets an ordinary CLI release be produced without a signing Mac.

A third helper used to live in this table — the keychain broker
(`Agents CLI.app`) behind the old in-repo secrets engine. It moved out of this
repo entirely with the standalone `secrets` engine (PHNX-3989): the standalone
downloads, verifies, and manages its own signed helper release now, off
`helper-versions.ts` and off this CLI's tarball/release path completely.

| Helper | Source | Ships in tarball? | Resolver |
|---|---|---|---|
| Menu-bar helper (AGI Menu) | [phnx-labs/agi-menu](https://github.com/phnx-labs/agi-menu) (own repo, PHNX-4036) — never built here; `scripts/stage-menubar-helper.sh` stages the published build at `bin/MenubarHelper.app` | **No** (RUSH-3100) — signed + notarized `MenubarHelper.app.zip` GitHub **release asset** on the helper's own `menubar/v<x.y.z>` tag, downloaded on demand | `src/lib/menubar/install-menubar.ts`, `src/lib/menubar/download-menubar.ts` (shared machinery in `src/lib/helper-download.ts`) |
| Standalone CLI binary | `src/` → `bun build --compile` → `bin/agents-macos` | **No** — dropped from the tarball (RUSH-3026); macOS installs fall back to the JS entrypoint until it returns as a per-release GitHub asset | `scripts/postinstall.js` |
| computer-mac | [`../../native/computer-mac`](../../native/computer-mac) | No — signed + notarized GitHub **release asset** on its own `computer-mac/v<x.y.z>` tag, downloaded on demand | `src/lib/computer/computer-rpc.ts`, `src/lib/computer/download.ts` (shared machinery in `src/lib/helper-download.ts`) |
| computer-win | [`../../native/computer-win`](../../native/computer-win) | No — `computer-helper-win.exe` GitHub **release asset** on its own `computer-win/v<x.y.z>` tag, downloaded on demand | `src/lib/computer/ssh-tunnel.ts` |

Path math: compiled resolvers run from `cli/dist/lib/…`. Files still in `dist/lib/`
reach repo-root `native/` in **4 hops** (`../../../../native/…`); files in
`dist/lib/computer/` need **5 hops**; the menu-bar installer reaches the staged
`cli/bin/MenubarHelper.app` in **3 hops** (`../../../bin/…`). Recompute depth if
you move files — don't blind-replace.

## Build, test, dev

```bash
bun install && bun run build && bun test
```

Tests are `*.test.ts` next to source; integration in `tests/`. Every PR to `main`
runs the real suite cheaply on Linux — `test`
([`../../.github/workflows/tests.yml`](../../.github/workflows/tests.yml)) plus
`gitleaks`; those two are the required checks. The full cross-platform matrix
(ubuntu + macOS + Windows × Node 22/24, `ci.yml`) runs **nightly** plus manual
`workflow_dispatch` — deliberately **off** the release path. It used to fire on
`release/**` branches, but that was 16-53 min of macOS/Windows-billed work on
every release while gating nothing (it is not a required check, and `release.sh`
gates on the exact-tree attestation, never this matrix). Cross-platform
regressions are caught on the nightly lane instead; a risky release can still run
it on demand via `workflow_dispatch`. CI runs from `cli` via
`defaults.run.working-directory`.

**Live Windows `--device` e2e (opt-in):** `src/lib/computer/ssh-tunnel.e2e.test.ts` and
`src/lib/browser/drivers/ssh.e2e.test.ts` drive a real Windows box end-to-end
(exe push + LOGON task, tunnel + RPC, screenshot, type/get-text round-trip,
remote browser launch/stop). Gated on `AGENTS_TEST_WIN_HOST=<registered device>`;
both suites skip cleanly when the var is unset, so CI needs no Windows runner.

**Local dev build:** `scripts/install.sh --skip-tests` builds the working tree,
installs it at `$HOME/.local/agents-cli-dev/`, and exposes it as
`$HOME/.local/bin/agents-dev` (plus `ag-dev`). Drive it by name — `agents-dev
sessions --active`. Version stamps as `0.0.0-dev.<sha>[-dirty]`.

The production command is never created or overwritten: the script must not write
`$HOME/.local/bin/{agents,ag,browser}`, and it deletes any such link an older
revision of itself left pointing into the dev prefix (including a dangling one,
which is what a cleaned dev prefix leaves behind). A dev build that answered to
`agents` made PATH order decide which code ran — see the root
[AGENTS.md](../../AGENTS.md) §Never install a dev build over the user's `agents`.

The routines daemon is **shared** (browser IPC, scheduler, and more), so
the install leaves it on production code. `--bounce-daemon` restarts it onto the
dev build when you need that, and says plainly that it changes what the user's
everyday `agents` talks to. (The secrets broker is a separate process the
standalone `secrets` CLI owns, PHNX-3989 — this daemon never hosts it.)

**Bin entrypoints need `chmod 755`.** [`scripts/build.sh`](scripts/build.sh) chmods
every `package.json#bin` entry after `tsc` emits. Newer npm preserves tarball file
mode and does NOT auto-chmod — 644 surfaces as `zsh: permission denied: agents`.

The `files` allowlist in [`package.json`](package.json) is a **whitelist** — only
`dist/**` (JS/d.ts/JSON/sh) and the postinstall scripts + README/LICENSE ship. No native
binary is in it (RUSH-3100).
Nothing from `apps/`, `native/`, or sibling `packages/` can leak into the tarball.

## Releasing

**Self-routing, zero-config.** Run it from ANY fleet box and ANY checkout state —
no variables to set, no Touch ID, no hand-moved credentials, and no requirement
that the caller be on a clean `main`:

```bash
scripts/release.sh <version>                      # dry-run: bump, type-check, tarball preview, detected state
scripts/release.sh <version> --apply              # tests on an auto-picked fleet worker -> PR + CI -> merge + tag -> build/sign/publish on the home base (mac-mini)
scripts/release.sh <version> --apply --device <mac>  # sign/publish on <mac> when mac-mini is down -- <mac> must ALREADY be a provisioned signing home base (see below)
scripts/release.sh <version> --apply --deploy-worker off  # publish only; skip the post-publish share-Worker redeploy
```

The release has **three self-selected homes** and prints a `[n/6]` phase tracker,
each phase labeled with the box it runs on and a ✓/✗ result:

| Work | Runs on | How it's chosen |
|---|---|---|
| Orchestrate: bump, changelog, PR, tag | a detached worktree on the box you invoked it on | fresh `origin/<default>` under `.agents/worktrees/release-v<version>-<pid>` |
| CI / tests (Linux) | an **auto-picked fleet worker** | [`scripts/test.sh`](scripts/test.sh) resolves it through `agents devices pick` — the least-loaded reachable POSIX box in the same auto pool `agents run --device auto` uses, so `role=worker`/`role=personal` marks govern it. `--test-device <box>` pins one; `--crabbox` still routes to a disposable [`sandbox.sh`](scripts/sandbox.sh) workspace. **`--shard <n>` fans the suite across n workers** (minimum 2 — for one worker use `--device auto`), and `--devices a,b,c` names them explicitly instead of auto-picking. The minimum-2 floor applies to **both**: a single-name `--devices` is refused the same way, since a one-shard fan-out is `--device auto` through far more machinery. Sharding is what meets the release latency target: the suite is throughput-bound, so wall time is CPU/workers. **Dynamic either way, never a hardcoded or release-exclusive instance** |
| Promote attested tgz + npm publish (+ computer-helper re-attach **only with `--with-helpers`**) | the **home base** (any OS — promote-only, RUSH-3026) | `--device <name>` in `release.sh`, defaulting to `mac-mini`; the script detects if it's already there (`scutil --get LocalHostName` / `hostname -s`), else reaches it over `ssh` |

The home base holds the npm publish token + gh auth. It defaults to `mac-mini`
and is overridable with **`--device <name>`**. Not an env var: a flag with a
default. Since RUSH-3026 the home-base phase is **promote-only** (download the
attested tarball, verify, install-smoke, `npm publish`) — nothing on it signs or
notarizes, so **any OS works as the home base**, Linux included. Re-attaching the
reused helper zip and verifying the helper input-digest manifest are **opt-in**
(`--with-helpers`): an ordinary release publishes the CLI and nothing else, since
helpers resolve from their own tags
([`src/lib/helper-versions.ts`](src/lib/helper-versions.ts)) and a manifest check
would otherwise abort a good CLI release whenever a helper's sources moved. `assert_promote_home_base` preflights it (tools + gh
auth + a headlessly readable `npmjs.com` `NPM_TOKEN`) before the release's
first mutation. Helper signing is a separate, source-change-only path and still
needs a provisioned Mac. The test worker is **not** hardcoded.

**A release redeploys the managed share OG-cover Worker so prod can't drift from
the shipped template (PHNX-3403).** The Worker that renders share preview cards
was deployed only by a manual `agents artifacts share update` run, decoupled from
release — so a release could ship a `worker-template.ts` change while the deployed
Worker stayed stale (the gap that made PHNX-2835 look shipped while every new share
still 404'd its cover). `--deploy-worker <auto|on|off>` (default `auto`) closes it:
after publish, in the home-base phase, `deploy_share_worker` runs the
**just-published** `@phnx-labs/agents-cli@<version>` (via a pinned `npx`, never the
box's installed `agents`, so the deployed Worker matches the released source) as
`agents artifacts share update --bundle cloudflare.com`. `auto` first runs
`share update --check` — a pure local render+hash that needs **no** Cloudflare
credentials — and deploys only when the shipped template differs from what the
endpoint deployed; `on` always redeploys; `off` opts out. The deploy uses bundle
`cloudflare.com` (the name the home base holds, not the CLI default `cloudflare`),
`agents secrets exec` resolves it headlessly like the npm token, and the promote
preflight verifies the share endpoint + that token on the home base **before**
publishing (so a Worker-touching release can't publish then fail to deploy). A
deploy failure fails the release loud with the exact manual fallback. It is
idempotent — the already-published early return redeploys too — so a re-run after a
publish/deploy split finishes the deploy.

**A `--device` fallback must ALREADY be a provisioned signing home base — it is
not turnkey.** Signing + notarizing + publishing needs, on that box: the
`Developer ID Application` identity in a *headless-unlockable* keychain
(`rush-signing.keychain-db` + `~/Library/Application Support/rush/signing.kcpass`,
the pass file that lets a headless SSH release unlock it — a cert that only appears
after an interactive login does **not** count), and the `apple.com` (notarytool)
and `npmjs.com` (publish token) secrets bundles. A box like `zion` typically has a
Developer ID cert in its *login* keychain but none of the headless plumbing, so it
cannot sign a release. **Verify with the probe rather than assuming from this prose** — `bash cli/scripts/signing-home-base-probe.sh` is the authoritative test, and a box that has since been provisioned (dedicated keychain + `signing.kcpass` + the `apple.com` bundle) returns `OK` and can sign, whatever this paragraph says about it. Passing `--device <unprovisioned>` used to run the whole flow —
merge the PR, push the tag — and only fail at the sign step, leaving a
tagged-but-**unpublished** release (RUSH-2535; npm stuck at 1.22.35 with `v1.22.36`
tagged). `release.sh` now **preflights the resolved home base BEFORE any mutation**
([`scripts/signing-home-base-probe.sh`](scripts/signing-home-base-probe.sh), run on
that box over `agents ssh`): an unprovisioned `--device` aborts at the preflight,
before the test/PR/merge/tag phases, naming the exact gap, so a mac-mini outage
no longer risks a half-finished release. `cli/bin/embedded.provisionprofile` is a
committed input (commit 2567004b4) that self-heals — the preflight and the
home-base phase both recover it from a freshly fetched `origin/<default>` ref when
the box's own on-disk checkout predates that commit, so a brand-new home base
never needs the profile hand-copied over (RUSH-2541). The keychain (Developer ID
identity in a headless-unlockable keychain) and the `apple.com`/`npmjs.com`
secrets bundles remain genuinely manual, per-machine provisioning steps — seed
those first, then `--device <that-mac>` works.

**The caller checkout is never mutated or gated.** `release.sh` immediately
fetches origin and re-enters the release from a detached, release-owned worktree
at fresh `origin/<default>`. Version bumps, changelog folding, release-branch
construction, CI orchestration, merging, and tagging happen there. The worktree
is removed on every exit path, so a dirty shared `main`, an agent feature branch,
or another branch already checking out `main` cannot block or contaminate a
release. The isolated tree installs dependencies from its pinned lockfile; it
does not borrow `node_modules` or staged files from the caller.

**One releaser at a time — the lease.** Because the script runs from any box, two
agents on two machines could enter it at once; they then clobber the same release
branch, tag, and publish, and the collision only surfaces after one of them has
already created irreversible release state.
[`scripts/release-lease.sh`](scripts/release-lease.sh) holds exclusivity on
`origin` — the only thing every box can agree on — by pushing an **orphan commit**
to `refs/release-lock/held` with `--force-with-lease=<ref>:` (expected absent).
That explicit compare-and-swap is load-bearing: custom refs allow ordinary
non-fast-forward pushes, so orphan ancestry alone is not a mutex. Stale takeover
replaces the inspected sha with the new lease in one expected-sha push. Every
lease commit carries a per-invocation claim ID, so shared Git identity plus a
same-second claim cannot make two commits identical and turn the loser into an
"up to date" success.

```bash
scripts/release-lease.sh status     # unheld | held version=… holder=… age=…min holder-alive=yes|no|unknown
scripts/release-lease.sh claim <v>  # 0 = acquired, 1 = someone else is releasing
scripts/release-lease.sh renew      # prove this run is still alive
scripts/release-lease.sh verify     # 0 = still ours; fails CLOSED on any doubt
scripts/release-lease.sh release    # drop the lease this checkout claimed
scripts/release-lease.sh clear      # drop a lease with no live holder (any checkout)
```

`release.sh` claims it right after the confirmation (before the first mutation)
and drops it from `cleanup_all`'s trap on every exit path. Ownership is the lease
**commit sha**, recorded in `.git/release-lease.token` — not the pid, so a release
resumed by a second invocation can still drop its own lease, and a third agent can
never drop one it did not claim.

**The TTL is not "how long a release takes".** It is "how long since the holder
last proved it was alive" — a distinction that matters because a healthy release
routinely outlives any sane TTL: the CI matrix alone has run **57 minutes**, and
release 1.20.77 took **186 minutes** wall clock. So two things hold the invariant
together:

- **Renewal.** `release.sh` runs a background renewer for the whole release
  (`renew` every 10 minutes), so a live run's lease is never older than 10 minutes
  and cannot be reclaimed out from under it. The renewer is killed before the
  lease is dropped, so it can never re-push a lease that is being deleted.
- **`verify` before every irreversible step.** `require_lease` gates the
  squash-merge, the tag, and the publish routing. It fails **closed** — no token,
  no ref, unreachable origin all mean "we cannot prove this is ours", so the
  release stops rather than merging alongside whoever holds it now.

A lease abandoned by a killed run stops being renewed, so it becomes reclaimable
after `RELEASE_LEASE_TTL` minutes (default 30); reclaiming names the dead holder
rather than silently overwriting it.

**An externally killed run is detected, not just waited out (RUSH-2274).** The TTL
alone made a killed release indistinguishable from a healthy long one: for up to 30
minutes `status` read `held` while nothing was releasing. So the lease also records
**which process** holds it — `host`, `pid`, and that pid's start time — and
`claim`/`clear`/`status` probe it, reporting `holder-alive=yes|no|unknown`:

| Probe | When | What it licenses |
|---|---|---|
| `dead` | we are on the holder's box and that process is gone | reclaim **immediately**, no TTL wait |
| `alive` | the recorded pid runs here with the recorded start time | **never** taken, at any age — stop that release instead |
| `unknown` | the holder is another box, or the lease predates these fields | the TTL, exactly as before |

`release.sh` exports `RELEASE_LEASE_HOLDER_PID=$$` so the recorded pid is the
orchestrating release, not the 10-minutely `renew` shell (whose `$$` is dead a
second later — recording that would make every renewed lease read as abandoned).
A lease with no recorded pid stays `unknown`, so a missing export degrades to the
old TTL behaviour rather than to "instantly reclaimable". The start time is what
makes `dead` safe to act on: a recycled pid would otherwise read as a live release
forever. A **zombie** counts as dead — a SIGKILLed release whose parent never
reaped it is still listed by `ps`, which is precisely the case this detects.

`scripts/release-lease.sh clear` drops such a lease without starting a release —
the operator's unwedge path, since `release` only drops a lease *this checkout*
claimed. It shares one predicate with `claim`, so it can never take a live holder's
lease either.

**Finish a stuck release before cutting a new one — with one exemption.** `release.sh`
refuses to start when an older `v*` tag exists that npm never received, and prints
the re-run that finishes it. The single carve-out is a **`patch-from-main` bump
stepping over main's own version**, because that stuck release cannot be finished
at all: `release.sh`'s catch-up guard rejects it and points at "cut the next patch",
so without the exemption the two guards deadlock and *nothing* publishes (2026-08-10,
npm at 1.22.35 with `v1.22.36` tagged — its CI-tested tree predated the prepack
version-gate fix, so its own `npm publish` rejected a correct binary). Only main's
own version is dropped from the candidate set, and `stuck-release.sh` says so on
stderr; any other stuck tag still blocks, under every bump kind. Without the guard,
a release that died between tag and publish left the
next run validating its bump against a registry that was behind, so it cut the
*next* version and the gap widened by one every time — that is how npm sat at
1.20.78 while `main` carried 1.20.81.

**Catch-up publishes the attested release PR head, not a rebased merge tree.** If
the deferred bump PR merged but npm publication failed, a retry validates that
`main` and the recorded PR head both carry the target version, re-fetches that
exact recorded head, requires its exact-tree attestation, and tags/promotes it.
A rebase or squash merge may have a different tree; that merged commit proves the
version landed on `main`, while the recorded PR head is the artifact CI proved.

**A stuck EARLIER bump PR blocks the changelog fold, not just a stuck tag
(PHNX-3084).** The stuck-*tag* guard above is registry-vs-tag; this is its
PR-side twin. The version-bump PR merges async/best-effort after publish
(RUSH-2395), so a bump PR wedged on a CHANGELOG conflict leaves that version's
`.changelog/next/*` fragments still queued on `main` — the drain only landed
inside the unmerged branch commit. A *later* version releasing then re-reads those
fragments and folds an earlier version's notes under the new version. The
same-target `STUCK_BUMP_PR` retry only lands `release/v<current-target>`, so it
never sees an OTHER version's PR. Before folding, `release.sh` detects any other
open `release/v*` bump PR (`scripts/release-other-bump-prs.sh`, unit-tested) and
**fails loud** with the exact `gh pr merge` to run first, rather than silently
re-attributing the earlier version's release notes.

**The privileged phase runs on the home base, always — from the TAGGED script.**
After the invoking box merges + tags (git + gh, which need that box's auth),
`release.sh` routes build + sign + notarize + `npm publish` + computer-helper to
`mac-mini`. Whether inline (you invoked it there) or over ssh, it first checks out
`v<version>` into a throwaway worktree under `.agents/worktrees/`, then runs **that
worktree's** `cli/scripts/release.sh <version> --home-base-phase` — so the
script that publishes is the one carried by the release tag (with
`--home-base-phase` + `headless-sign-context.sh`), never the home base's possibly-
stale on-disk checkout. The worktree is removed on exit whether the phase succeeds
or fails. `--home-base-phase` runs inside that worktree: it verifies the checked-
out version == `<version>`, enters the headless context
([`scripts/headless-sign-context.sh`](scripts/headless-sign-context.sh) — unlocks
`rush-signing.keychain-db` + exports `AGENTS_SECRETS_PASSPHRASE` from the on-disk
pass files, so codesign/notarytool and every `agents secrets exec` run with **no
Touch ID**), builds + signs the artifacts, resolves the **npm token on the home
base** (never borrowed to the trigger box), publishes, and pushes the computer-
helper release asset. `bun run build` copies the signed helpers into `dist/` on a
presence gate (`[ -d bin/… ]`); `prepack`'s sha gate is sha-tool-portable.

**Tests: an auto-picked fleet worker for Linux; cross-platform runs nightly.** The
`--apply` flow runs the full suite on a worker before opening the PR; a failure prints the failing tests +
the captured log path and **halts before any PR/publish**. That covers the Linux
suite, and the exact-tree attestation is the functional proof the publish gates
on. The cross-platform (macOS/Windows) matrix (`ci.yml`) is **not** on the release
path — it runs nightly, not on the release PR, so a release no longer waits on it.
Run it on demand via `workflow_dispatch` before a risky release. `--skip-tests`
skips only the Linux suite run.

**The attestation producer shards by default.** `release-attestation-produce.sh`
(the suite run that mints the attestation) now fans the ~13k-test suite across the
fleet via `test.sh --shard N` instead of pinning one box — the suite is
throughput-bound, so this is ~1/N the wall time (~269s on one box → ~31s on nine).
N is resolved from the eligible workers `agents devices pick` reports, capped, and
falls back to a single auto-picked box when fewer than two are eligible (`test.sh
--shard` has no silent fallback, so the count is resolved before the call rather
than demanded of a possibly-thin fleet). Each shard still runs vitest at
`--maxWorkers=2 --retry=2`, so the RUSH-3015 per-box flake mitigation is unchanged —
sharding adds machines, not per-box concurrency. Override with `--test-shard <n>` /
`--test-devices a,b,c`, or pin one box with `--test-device <box>` / `--test-here`.

**A release-tree attestation can inherit the suite instead of re-running it
(PHNX-3237).** A release runs the full suite twice — once for the default-branch
tree, once for the `chore(release)` commit tree — even though the second differs
from the first only by the version bump, the folded changelog, and the
regenerated command-index. `release-attestation-produce.sh --inherit-suite-from
<base-attestation.json>` mints the release-tree record from an already-green base
**without re-running the suite**: it still `bun run build` + `npm pack`s (so the
recorded tarball is the real release tree's, carrying the new version), but the
expensive suite run is inherited. The soundness gate is
`release-attestation.sh derive` — it fails **closed** unless the tree diff between
base and release touches only `package.json`, `.changelog/**`, `CHANGELOG.md`, and
`docs/command-index.{md,json}` (the exact set `release.sh` stages), so a code
change can never ride a stale pass. The derived record inherits the base's
lockfile/policy/toolchain/suite identity, which the allowlist proves are byte-
identical to the release tree's, so `release.sh`'s `require()` still keys to it
exactly. Inherit mode is incompatible with any `--test-*` flag (there is no suite
to route). **`release.sh` now calls this itself** (`derive_release_attestation`,
PHNX-3696): before the release-tree gate it mints the record from the attested
default-branch base, so an ordinary release needs no operator step. Before that, the
gate landed in RUSH-2666 with NO producer of any kind, and every `release.sh --apply`
from 2026-08-15 onward stopped at `missing exact attestation key` waiting for a human
to hand-run `release-attestation-produce.sh`. The derive is best-effort by contract —
any failure returns non-zero and the call site guards it with `|| true` (load-bearing:
`release.sh` runs under `set -euo pipefail`, where a BARE call to a function returning
non-zero aborts the whole release before the fallback poll can run), so it falls
through to the previous poll-then-`require`, which still fails loud — and `derive`'s allowlist remains the
soundness gate, so a code change can never inherit a stale pass. Run the producer by
hand only to mint a record out of band (a backfill, or a box with no attested base).

**Idempotent re-runs.** The script's git-scope reads use `<ref>:cli/package.json`
(not root) since the package moved under `cli`. If a publish fails after the PR
merges, rerun the same command: registry-truth short-circuits skip an
already-published version, tag creation is idempotent against the verified release
commit, and the catch-up guards (CI-tested-head match + merged-tree match + version
match) refuse an unverified publish so later commits on `main` cannot leak into the
already-versioned package.

**`scripts/remote-sign-mac.sh` is no longer on the release path.** The privileged
phase builds signed artifacts directly on the home base. The script remains only
for the narrow case of producing + pulling back JUST the macOS artifacts from
another Mac (no publish): it signs the standalone CLI binary there and **stages the
published menu-bar helper** (`scripts/stage-menubar-helper.sh`, no build — see
below); it takes the same `--device <name>` flag as `release.sh` (default
`mac-mini`), with no other env knobs or fleet discovery.

**Provisioning the `apple.com` bundle on a headless sign host.** A Linux-driven
release offloads macOS signing to a sign host over SSH, which needs the `apple.com`
secrets bundle *on that host*. Push it with the **file backend** —
`agents secrets export apple.com --device <signer> --remote-backend file` (**no
passphrase required** — the remote keys it under a machine-local key it
auto-provisions and reads it headlessly; `AGENTS_SECRETS_PASSPHRASE` is never
forwarded) — **not** the default
keychain backend: a
macOS login keychain is locked under headless SSH, so a keychain-backed push lands
the bundle metadata but no readable secret items (`secrets export --device` now
read-back-verifies a keychain push and fails loudly if it didn't persist, pointing
at this fix). `--device` / `-D` is the fleet routing flag (legacy `--host` is stripped but not registered) on the secrets remote
commands. See [`docs/secrets.md`](docs/secrets.md) → *Pushing to a headless sign host*.

**Why the tarball no longer needs a Mac (RUSH-3100).** It used to bundle
`dist/lib/secrets/Agents CLI.app` — a `swiftc`-compiled keychain helper, Developer-ID
codesigned and notarized — and `prepack` (`scripts/verify-keychain-helper.sh`,
since deleted with the engine — PHNX-3989) refused to pack unless that signed
binary matched a pinned sha. Since CI runners are Linux and cannot produce it,
**that gate, not the code, is what chained an ordinary release to a signing
Mac.** The bundle is gone from the tarball, and the keychain helper itself
moved out of this repo entirely with the standalone `secrets` engine — it is
no longer built, signed, or verified anywhere here.
[`scripts/verify-menubar-helper.sh`](scripts/verify-menubar-helper.sh) remains
the gate for a staged `bin/MenubarHelper.app` (`stage-menubar-helper.sh` runs it
after extraction); it never blocked the CLI tarball. A helper is re-recorded only
when its own input changes; the input digest in
[`scripts/release-manifest.sh`](scripts/release-manifest.sh) is what decides that.

**computer-mac records itself from its published release, not a local rebuild
(PHNX-2943).** `computer-mac` is signed on the separate
[`scripts/publish-computer-helper-mac.sh`](scripts/publish-computer-helper-mac.sh)
path and is never rebuilt in `release-attestation-produce.sh`. When its source
drifts, the producer records the **published** `computer-mac/v<floor>` binary — but
only after proving that binary was built from the current source: the publish
script uploads a `computer-mac-input-digest.txt` sidecar naming the source it built
from, and the producer records the row only when that equals the current source
digest, verifying the downloaded zip against its `.sha256` first. A mismatch, a
missing sidecar (a pre-PHNX-2943 release), or an undownloadable release **fails
closed** with the exact `publish-computer-helper-mac.sh` command — never binding a
new source digest to an unproven binary. Before this, the producer just died on
drift and the publish script recorded nothing, so the "republish then re-run"
advice looped forever (hit live cutting 1.22.43).

**Menu-bar helper (AGI Menu) — consumed from its published release, never built
here (PHNX-4036).** The helper's source moved to
[phnx-labs/agi-menu](https://github.com/phnx-labs/agi-menu) (private,
history-preserving split of the old `cli/menubar/`), the same shape as the AGI EXT
split (RUSH-3189). The cross-repo contract is short and lives in
[`docs/menubar.md`](docs/menubar.md):

- **Asset + address.** agi-menu's `scripts/release.sh <x.y.z>` builds, Developer-ID
  signs, notarizes + staples the bundle and uploads `MenubarHelper.app.zip`,
  `MenubarHelper.app.zip.sha256`, and a `menubar-source.txt` provenance sidecar
  (`repo=`/`commit=`/`tag=`/`version=`) to the release tag **`menubar/v<x.y.z>`
  on THIS public repo** — exactly the URL `src/lib/helper-download.ts`
  (`HELPER_RELEASE_REPO`) + `src/lib/menubar/download-menubar.ts` resolve. That
  address, the bundle folder name `MenubarHelper.app`, the executable name
  `"AGI Menu"`, the bundle id `com.phnx-labs.agents-menubar`, and the Team
  `2HTP252L87` are the contract; changing any of them on either side breaks
  every installed CLI or revokes every user's Accessibility grant.
- **The floor is the pin.** `menubar` in
  [`src/lib/helper-versions.ts`](src/lib/helper-versions.ts) names the build this
  CLI was tested against; bump it after agi-menu publishes. It is also the
  helper's manifest **input** (`release-manifest.sh` hashes that file for
  `menubar`), so a floor bump is what makes `release-attestation-produce.sh
  --with-helpers` re-record the row — from the published asset, sha256-verified,
  with the sidecar's provenance as `source` — and a missing or corrupt release
  fails closed naming the agi-menu publish step. Nothing rebuilds.
- **Staging.** [`scripts/stage-menubar-helper.sh`](scripts/stage-menubar-helper.sh)
  downloads `menubar/v<floor>`, verifies the sha256, and on macOS extracts it to
  `bin/MenubarHelper.app` behind `codesign --verify --deep --strict`,
  `spctl --assess --type execute`, and
  [`scripts/verify-menubar-helper.sh`](scripts/verify-menubar-helper.sh)
  (**designated-requirement pin** + universal binary + stapled ticket).
  `--fetch-only` downloads + sha-verifies on any OS (what the producer uses);
  `--json` reports `{floor, tag, assetUrl, zip, sha256, source, app}`.
  `remote-sign-mac.sh` runs it on the home base. `bin/MenubarHelper.app` is the
  installer's working-tree source (`sourceAppPath()` in `install-menubar.ts`);
  an agi-menu developer copies a local build there to test it with this CLI.
- **The DR pin is what keeps the Accessibility grant alive across upgrades.**
  macOS re-validates each new version against the requirement stored with the
  grant (`identifier "com.phnx-labs.agents-menubar" … certificate
  leaf[subject.OU] = "2HTP252L87"`), not the CDHash — so every re-signed release
  still satisfies it. The gate hard-fails a bundle whose DR drops the pinned
  bundle id or Team ID (a wrong/absent team, an ad-hoc signature, a CDHash-pinned
  DR), because that would silently revoke every user's grant and re-prompt them
  on the next paste. Gatekeeper on macOS 26+ rejects an un-notarized `.app` as
  "damaged", so the launch guards verify Gatekeeper acceptance and fail loud
  (RUSH-2134) — there is no per-machine re-sign.
- **What stays here** is the CLI side only: install/heal/status/setup
  (`src/lib/menubar/install-menubar.ts`), download + verification
  (`download-menubar.ts`, `helper-download.ts`), the read-only snapshot the helper
  polls (`agents menubar snapshot --json`, `src/lib/menubar/snapshot.ts`), and
  desktop notification delivery (`notify-desktop.ts`). Helper behavior — the
  single-instance `flock`, the bounded `ChildProcess` spawner, the self-tests
  that gate its build — is documented in agi-menu's `docs/menubar.md`.

**Exactly one status item is an invariant, enforced in the helper.** The bundle
can be started from more than one place — launchd's `KeepAlive` service, a
LaunchServices/`open` launch, a second `agents menubar enable` — so the helper
takes an `flock` on `~/.agents/.cache/state/menubar.lock` at launch (agi-menu's
`SingleInstance.swift`) and holds the descriptor for its lifetime; a loser
surfaces the incumbent's menu and exits 0. Do NOT re-derive liveness from a pid
file or a `ps` scan — the kernel releases an `flock` however the holder dies,
which a pid cannot express, and a process list cannot say which copy launchd will
keep alive. On the CLI side, `classifyMenubarProcesses` returns live copies of
the installed bundle as a LIST (`own`), never a boolean: collapsing them is what
let a duplicate icon read as a healthy `running: yes`. `agents menubar setup` is
the recovery path — it ends every live helper and re-kickstarts the service so
the survivor is always launchd's.

**Only the install that OWNS the helper may reinstall it.** The startup self-heal
(`installMenubarLaunchAgentOnUpgrade`, every darwin invocation) reinstalls when the
version stamp drifted or the plist's baked entry names another install. Both of
those record *whichever copy acted last*, so on a box with several agents-cli
copies each one read the others' marks as drift and recopied the bundle over them —
and recopying replaces the executable under the running helper, killing it, after
which `KeepAlive` restarts it and the next copy repeats it. Observed: a new pid
every 5-15s, 578 launches in one helper log, a status item that never stayed
visible, and `agents menubar status` still saying `running: yes` because a pid
always existed (#2109). `mayInstallMenubarHelper` gates it: the plist's
`AGENTS_ENTRY` names the owner, and only the owner reinstalls freely. A same-install
upgrade keeps its entry path, so `npm update` still lands normally.

Three escapes keep the gate from becoming a **stuck state**, which is how the first
version of it regressed: (1) **repairs are never gated** — a missing helper
executable or a Developer-ID heal proceeds from any install, since a bundle that
isn't there cannot be contested and blocking it leaves the menu bar dead with no
automatic recovery; (2) a non-owner takes over once the recorded owner is **gone
from disk** — but, like escape (3), only a **Developer-ID** source may seize a
*healthy* helper this way (an ad-hoc/dev build is refused, see caveat (a)); (3)
otherwise a non-owner may still take over **once per
`MENUBAR_TAKEOVER_COOLDOWN_MS`** (1h, stamped in `.menubar-last-heal`). Without (3)
a stale-but-present copy — an old nvm node dir nobody runs — owns the plist forever
while the user's actual daily driver upgrades and never heals again. The cooldown
turns an every-invocation storm into at most one restart per hour while leaving
every install able to make progress. `agents menubar setup` bypasses the gate
entirely and stays the immediate manual fix.

Two caveats worth knowing before you tune any of this. **(a)** Escapes (2) AND (3)
are both refused to a source bundle that is not Developer-ID signed:
`scripts/install.sh` puts an ad-hoc dev build beside the npm global, and letting it
recopy an un-notarized bundle over a good one both makes Gatekeeper reject the
result as "damaged" (RUSH-2134) AND poisons the shipped helper's Accessibility
grant — an ad-hoc signature carrying the production bundle id fails the code
requirement macOS stored with the grant, so it revokes the grant and re-prompts on
the next paste. This is why a dev build ALSO signs under a distinct
`com.phnx-labs.agents-menubar.dev` id (agi-menu's `scripts/build.sh`), so even a
running dev helper registers its own TCC entry rather than the production one.
Refusing an ad-hoc healthy-helper takeover strands nothing: escape (1) still heals
a genuinely broken (missing / ad-hoc-installed) helper from any source, which is
the only real deadlock. **(b)** The cooldown bounds the loop but does not converge it: two
installs that are *both* invoked regularly trade ownership every cooldown, so the
helper restarts roughly hourly until one is removed. That is deliberate — the
alternative is stranding one of them — and the real fix is a single install
(#2147 expanded the multi-install banner beyond `PATH` to NVM, fnm, Volta, Bun,
common npm prefixes, and the npm `_npx` cache). The banner also checks each
copy for `dist/lib/app-bundle-install.js`; a copy without it is labelled an
unsafe legacy helper installer and must be removed, because current code cannot
make an older executable use the atomic installer it predates.

**Do NOT "improve" this by comparing bundle content.** It looks like the obvious
gate and it does not work: the helper is rebuilt, re-signed and re-notarized on
every helper release (agi-menu's `scripts/release.sh`), so consecutive releases
ship byte-different bundles from identical Swift source. Measured on
1.22.20/21/22 — same 2876288-byte executable, three different sha256s, and three
different **CDHashes** (so stripping the CMS/timestamp blob doesn't rescue it
either). Any digest gate reports "changed" for precisely the skew case it was
meant to exempt. Ownership is the only signal here that is stable across
independently-signed builds. Related: the secrets broker hit the same
multi-install failure and answered it differently, by keeping a *hot* broker alive
across version skew (`shouldTeardownVersionSkewedBroker`, the standalone `secrets` engine's own agent.ts;
#435, PR #909) — same disease, and a third `KeepAlive` helper will need one of
these two answers rather than a fresh rediscovery.

**Standalone `agents` binary (#315) — no longer in the tarball (RUSH-3026).**
The signed arm64 Mach-O (`bun build --compile` → Developer ID + hardened runtime +
the JIT entitlement in `scripts/bun-jit-entitlements.plist`, notarized via
[`scripts/sign-cli-binary.sh`](scripts/sign-cli-binary.sh)) embeds the release
version, so shipping it inside the npm tarball forced a Mac rebuild + sign on
**every** release — the single artifact that chained publishing to a provisioned
Mac even when nothing native changed. It is dropped from `package.json` `files`
and from the `prepack` gates; `postinstall`'s existing run-probe falls back to
the JS entrypoint when `dist/bin/agents` is absent, so macOS installs keep
working (the pre-#315 status quo, at the cost of the EDR mitigation until the
binary returns as a per-release GitHub asset — tracked in RUSH-3026).
[`scripts/verify-cli-binary.sh`](scripts/verify-cli-binary.sh) and the signing
machinery are retained for that asset path; a Mac producer still builds + signs
the binary locally, it just no longer ships in the tarball.

**The `@swarmify/agents-cli` shim is frozen at 1.19.x — do NOT "catch it up."** It's a
legacy re-export not published since v1.20.0; `release.sh` publishes only `@phnx-labs`.
Bumping it would un-deprecate a retired package.

## Conventions

- Real services only — no mocking. Tests exercise the actual critical path.
- `agents repo push` / `pull` operates on `~/.agents/` only. System updates ride
  `npm update -g @phnx-labs/agents-cli`.
- No sensitive data in any DotAgents repo — use `agents secrets` (Keychain-backed).

## Contracts (source-of-truth spec — read before touching sessions/secrets)

The major subsystems carry a **normative contract** in
[`docs/specifications.md`](docs/specifications.md) — what a human, an agent, or a
downstream tool may rely on, written because features have regressed by quietly
deviating from an unwritten contract. When code and the spec disagree, one is a
bug; fix the drift. It uses RFC-2119 MUST/SHOULD language, cites the implementing
`file:line`, and carries Given/When/Then scenarios that map to tests. Sections:

- **[`docs/specifications.md` §Sessions](docs/specifications.md#sessions)** — the `agents sessions`
  contract. Load-bearing invariants: discovery MUST parse **every** harness in
  `SESSION_AGENTS` (all 12) and a malformed line MUST be skipped, never thrown
  (SES-1, SES-3); every list row MUST show a **non-empty preview** — live turn →
  `label` → first-prompt `topic` → `'-'` (SES-8; `--flat` and the interactive
  picker share the one unguarded renderer, SES-GAP-1); "where a session started"
  spans three fields (`cwd` + `provenance` + `context`), not one `origin`
  (SES-13); the `--json` shapes and `SessionEvent` union are a stability contract
  (SES-IF-1, SES-IF-4); tool-call evidence is always redacted/bounded, repeated
  clauses match distinct calls, tool queries never parse transcripts, and exact
  static program counts retain repeated sites with wrapper/effective roles;
  versioned tool envelopes do not replace the list/detail JSON contracts
  (SES-31..SES-37, SES-IF-4a); `agents sessions insights` emits aggregate-only
  actions and keeps `agents insights` as its top-level alias (SES-IF-4c); `agents sessions stats` emits its own versioned
  `sessions-stats` rollup of skill/command usage and never the list/detail shape
  (SES-IF-4b); `agents sessions
  export --encrypt` seals every transcript
  body client-side with AES-256-GCM under the shared `r2.backups` bundle key, or
  an ephemeral one when unconfigured (SES-24, SES-25); the off-box backup target
  (`export --to-r2` / `import --from-r2`) is **managed-first** — a signed-in user
  backs up to the managed `sessions.agents-cli.sh` Worker with **no `r2.backups`
  bucket to set up**, every body sealed under a mandatory per-account escrowed DEK
  (never plaintext), while `--byo` keeps the zero-knowledge own-bucket path
  (SES-50, SES-51, SES-52).
- **[`docs/specifications.md` §Secrets](docs/specifications.md#secrets)** — the `agents secrets`
  contract. Load-bearing invariants: **inject into the child, never materialize
  to the agent** — every command is on one side of the boundary by construction
  (SEC-6, SEC-7); the master passphrase MUST be stripped from the child env
  (SEC-8); the "no-noise" rules — silent value-free `list`, batched single-prompt
  reads, silent broker miss, no `console.*` in the lib layer, no shell-rc
  pollution (SEC-11..SEC-17); all three desktop platforms are supported and the
  parity matrix names where guarantees are weaker (SEC-CROSS-1, SEC-CROSS-3).

Requirement ids are section-namespaced — `SES-*` / `SEC-*` / `EXEC-*`, with the
`-IF-` (interface), `-CROSS-` (platform parity), `-COMPAT-` (stability) and
`-GAP-` (known gap) families — and a requirement the code does not yet fully meet
carries a trailing `Status: [Intended]` or `[Drift]` line naming its `-GAP-`.

Beyond the two above, the document also specifies **§Agent execution**,
**§Scheduling & execution singularity**, and **§Watchdog**. It does **not** cover
every command group — `hosts`, `teams`, and `cloud` have design docs but zero
RFC-2119 requirements, and surfaces like `wallet` and `sync`/`apply`
have neither. The
[coverage inventory](docs/specifications.md#coverage-inventory) says which row a
surface sits in; check it before treating a behavior as guaranteed.

Every section enumerates **known gaps** (implemented-vs-intended drift) — a new
feature MUST NOT widen them and SHOULD close the one it touches. A gap that has
been closed stays as a `(resolved)` entry so references never dangle.

## Detailed design

[`docs/`](docs/README.md) is the source-grounded reference. Start with
[`architecture.md`](docs/architecture.md) for CLI ownership boundaries and the
session mechanisms, then [`concepts.md`](docs/concepts.md) for the resource
model. Extension-owned presentation design lives in the
[AGI EXT architecture](https://github.com/phnx-labs/agi-ext/tree/main/docs).
The normative contract
([`specifications.md`](docs/specifications.md)) sits
alongside the reference docs ([sessions.md](docs/sessions.md),
[secrets.md](docs/secrets.md)) — read the spec for the guarantee, the reference
for the how-to.
