# agi-cli — Specifications

> Status: **accepted** · Kind: **normative spec** · Scope: the top-level
> behavioral contracts for the agi-cli subsystems listed in the
> [coverage inventory](#coverage-inventory) — not every command group.

This is the **source-of-truth contract** for agi-cli: what a human, an agent,
or a downstream tool is entitled to rely on, stated as testable requirements —
one section per major functionality. It exists because features have regressed by
quietly deviating from an unwritten contract (a harness parser that throws on a
malformed line; a renderer that drops the preview; a `--json` shape change that
breaks fleet fan-out; a secret that materializes into an agent's transcript).
**When code and this spec disagree, one of them is a bug** — fixing the drift is
mandatory, not optional.

This doc holds the **contracts** (the guarantees). The per-feature reference docs
— [`sessions.md`](sessions.md), [`secrets.md`](secrets.md),
[`architecture.md`](architecture.md) and [`secrets.md`](secrets.md)
— hold the **implementation-level detail and how-to**. Read the spec for the
guarantee, the reference for the mechanism.

## Conventions of this document

- Requirement keywords **MUST / MUST NOT / SHOULD / SHOULD NOT / MAY** are used
  per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) /
  [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174), and only when capitalized.
- **Requirement id families are section-namespaced** so an id is globally unique.
  Each family is prefixed with its section (`SES` sessions, `SEC` secrets, `EXEC`
  agent execution):
  - `<SEC>-<n>` — a normative behavioral requirement (e.g. `SES-8`, `SEC-15`, `EXEC-1`).
  - `<SEC>-IF-<n>` — an interface / output / exit-code contract.
  - `<SEC>-CROSS-<n>` — a cross-platform parity requirement.
  - `<SEC>-COMPAT-<n>` — a compatibility / stability guarantee.
  - `<SEC>-GAP-<n>` — a known implemented-vs-intended gap (informative, non-normative).
- **Every requirement has a status.** Unmarked requirements describe **Current**
  behavior (what the code does today). A requirement the code does **not yet fully
  meet** carries a trailing `Status:` line tagging it **`[Intended]`** (the contract
  is the target; the shortfall is named in a `-GAP-`) or **`[Drift]`** (a named
  deviation from another requirement in this document). Normative `MUST`/`SHOULD`
  bodies state only the contract; the shortfall lives in the `-GAP-` entry. An entry
  that exists purely to record such a deviation carries no RFC-2119 keyword.
- Every requirement cites the implementing `file:line` under `cli/src/` unless
  noted, and SHOULD name the symbol/function/constant. **Line numbers drift as code
  moves — the cited symbol is the durable anchor, not the number.**
- Behavioral scenarios are written Given/When/Then so they map 1:1 to tests.
- Each section ends with **known gaps** (`-GAP-`). A new feature MUST NOT widen a
  gap and SHOULD close the one it touches. A gap that has been closed is marked
  `(resolved)` and kept, so the entry that a requirement points at never dangles.
  This document states standing status, not change history — a gap says what is or
  was true, never "fixed in this PR."

## Contents

- [Sessions](#sessions) — `agents sessions`: discovery, parsing, preview, metadata, lifecycle, export/import
- [Secrets](#secrets) — `agents secrets`: storage & materialization boundaries, sharing, no-noise
- [Agent execution](#agent-execution) — `agents run`: the one execution engine, env, isolation, fallback, dispatch
- [Scheduling & execution singularity](#scheduling--execution-singularity) — one scheduler, one executor for anything fleet-affecting; UIs are thin wrappers
- [Routine execution & readiness](#routine-execution--readiness) — `agents routines`: context resolution on the target, readiness/pause, single-fire, run history
- [Watchdog](#watchdog) — `agents watchdog`: detect idle agents, decide nudge/skip, deliver to the exact split

## Coverage inventory

**This document does not cover every command group, and silence here is not a
guarantee.** The CLI registers **100 top-level names** across **81 distinct
loaders** — the difference is aliases and multi-command modules (`ssh`/`devices`/`fleet`
share one; `add`/`use`/`remove`/`rm`/`purge` another) — in `COMMAND_LOADERS`
(`cli/command-registry.ts:146`, *"Parity is non-negotiable: the name -> loader
map below mirrors exactly which module registers which top-level command on `main`"*).
Five subsystems have a normative contract. Before relying on a behavior, check which
row its surface sits in.

| Coverage | Surfaces | What that means |
|---|---|---|
| **Specified here** | `sessions`, `secrets`, `run`, the scheduling/executor singularity, **routine execution & readiness**, `watchdog` | RFC-2119 requirements + Given/When/Then. A change that deviates is a bug in the code or in this doc. |
| **Governed in part** | `monitors`, `doctor`, `daemon` | One requirement reaches them, no command contract does. `monitors` is bound by [§Scheduling & execution singularity](#scheduling--execution-singularity) (SING-5, SING-8, SING-9) — who may schedule and execute it. `doctor` is bound by SEC-17 for one behavior only: warning on a credential-shaped var in a shell rc file. `daemon` is bound by SING-1 (it IS the singular scheduler/executor) and SING-4a (the `daemon.enabled` kill switch); per-service toggles (`agents daemon services enable|disable`) are an operational convenience with no normative contract. The daemon's status/health rendering (`agents daemon status`/`services`/`doctor`) carries no requirement of its own. Everything else these commands do is unspecified. |
| **Documented, not specified** | `hosts`, `teams`, `cloud`, `browser`, `computer`, `plugins`, `subagents`, `workflows`, `profiles`, `share`, `pty`, `menubar`, resource sync (`skills`/`rules`/`commands`/`hooks`/`mcp`/`permissions`), version management (`add`/`use`/`prune`/`import`/`export`) | The architecture spine describes these mechanisms in [fleet.md](fleet.md), [orchestration.md](orchestration.md), [execution.md](execution.md), [interfaces.md](interfaces.md), [resources.md](resources.md), and [distribution.md](distribution.md), but those decision records do not create RFC-2119 requirements. Treat them as explanation, never as a contract. |
| **Unspecified** | `wallet`, `helper`, `sync`/`apply`/`status`, `webhook`, `daemon funnel`, `mailboxes`, `feed`, `message`/`send`, `budget`, `audit`, and the remaining groups | Neither a spec nor a design doc. Behavior is whatever the code does today; nothing here entitles a caller to it. |

**Where the absence bites hardest.** These act on other machines, hold durable
state, or sit next to credentials, and have no normative contract today:

1. **`hosts` / `ssh` / `devices`** (`commands/hosts.ts`, `commands/ssh.ts`) — dispatches
   arbitrary agent runs to other machines over SSH. [fleet.md](fleet.md)
   describes the transport; no requirement pins it. Individual
   SSH guarantees are stated piecemeal inside the specified sections (SES-CROSS-1,
   SEC-CROSS-1, the `--device` requirements in [§Agent execution](#agent-execution)),
   which is exactly the fragmentation a `Hosts` section would resolve.
2. **`teams`** (`commands/teams.ts`) — parallel agents across worktrees and devices; the
   cross-teammate seam is unguarded by any requirement.
3. **`cloud`** (`commands/cloud.ts`) — dispatches to external infrastructure whose state
   lives off this machine entirely.
4. **`wallet`** (`commands/wallet.ts`) — a payment-card vault sitting directly
   against the credential boundary that [§Secrets](#secrets) specifies,
   without inheriting any of its requirements. (The signed keychain-broker
   helper this used to also name moved out of this repo entirely with the
   standalone `secrets` engine, PHNX-3989 — its own contract now lives in
   `phnx-labs/secrets-cli`.)
5. **`sync` / `apply` / `status`** — the fleet-reconciliation trio that mutates every
   installed version's config on every machine.

Adding a normative section to this document MUST move its surface into the
**Specified here** row of this table; adding a new command group SHOULD place it in
one of the other rows rather than leaving it unlisted.

---

## Sessions

This is the **contract** for `agents sessions`: what a human, an agent, or a
downstream tool is entitled to rely on, stated as testable requirements — not a
how-to (that is [sessions.md](sessions.md)). It exists because features
have regressed by quietly deviating from an unwritten contract (a new harness
parser that throws on a malformed line; a renderer that drops the preview; a
`--json` shape change that breaks fleet fan-out). When code and this spec
disagree, one of them is a bug; fixing the drift is mandatory.

Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Every requirement cites the
`file:line` that implements it, under `cli/src/` unless noted. Behavioral
scenarios are Given/When/Then so they map 1:1 to tests.

---

### 1. Purpose & scope

`agents sessions` is the unified read layer over agent conversation transcripts:
it **discovers and parses sessions from every session-capable harness**, indexes
them, **renders a preview by default**, exposes rich per-session **metadata**
(including where a session started), and makes all of it available **locally,
across the fleet, and cross-platform**.

**In scope:** discovery + harness parsing, the SQLite/FTS index, the preview and
metadata contract, the list/active/overview display, session lifecycle
(active/idle/waiting, detach/attach/fork/migrate), and cross-machine reach
(`--device` live query, export/import bundles).

**Out of scope (non-goals):** writing transcripts (that is the harnesses
themselves + `packages/session-tracker`); an identity/authorization layer beyond
SSH access (§7); rendering sessions that no harness produced.

---

### 2. Terminology

- **Harness** — an agent CLI whose transcripts we parse. The session-capable set
  is `SESSION_AGENTS` (`lib/session/types.ts:14`), a **subset** of the broader
  `AGENTS` capability registry.
- **`SessionMeta`** — the durable indexed row, one per transcript
  (`lib/session/types.ts:85-192`).
- **`ActiveSession`** — the live, in-process view of a currently-running agent
  (`lib/session/active.ts:75-207`).
- **Preview** — the one-line "what this session is/was doing" string shown in a
  list row; distinct from the multi-line **picker preview** (`--preview`, the
  interactive picker).
- **Provenance** — where a live agent *process* physically runs (host / SSH /
  tmux pane), for reply-routing (`lib/session/provenance.ts`).

---

### 3. Requirements

#### 3.1 Discovery & harness parsing

- **SES-1 (MUST).** The canonical session-capable harness set is
  `SESSION_AGENTS` — exactly these 13, in display order: `claude, codex, gemini,
  antigravity, opencode, openclaw, rush, hermes, grok, kimi, droid, cursor, muse`
  (`lib/session/types.ts:17`). Adding harness discovery MUST extend this set (and
  its parser + `dispatchAgentScan` arm), not special-case a caller.
- **SES-2 (MUST).** Each harness's transcript location + on-disk format is fixed
  and MUST be parsed from its native shape (JSONL / single-JSON / SQLite / CLI
  stdout) as tabled in [sessions.md](sessions.md#architecture) and
  `lib/session/discover.ts` / `lib/session/parse.ts`. Roots MUST include the live
  home, every version-home, and backup mirrors, deduped by realpath, **live root
  scanned first** (`lib/session/discover.ts:772-787,1092-1093`).
- **SES-3 (MUST).** A malformed JSONL **line** MUST be skipped, never thrown —
  for every harness (`lib/session/parse.ts:322-328,531-537,1004-1010,1151,1356-1362,1448-1454,1538-1544,1707-1713`).
- **SES-4 (MUST).** An unrecognized path MUST fail loudly
  (`Cannot detect agent type from path`), never be silently mis-indexed
  (`lib/session/parse.ts:143-147`); an unknown agent id in the scanner is a no-op,
  not a crash (`lib/session/discover.ts:340`). A *recognized* harness that has no
  file (OpenClaw) MAY parse to `[]` — distinct from unknown.
- **SES-5 (MUST).** Incremental re-scan of a grown transcript MUST produce an
  index row byte-identical to a full reparse: apply only newline-terminated
  lines, defer the unterminated tail. For **Claude and Codex** it MUST also
  re-derive first-event identity so an in-place rewrite at the same path forces a
  full reparse (`lib/session/discover.ts` Claude ~`:3355-3422`, Codex
  ~`:3870-3946`). **Kimi** needs no such re-check — its session dir is keyed by
  UUID and `wire.jsonl` is append-only, so a path can never change identity
  (`lib/session/discover.ts:4413-4415`); do not require it of Kimi.
- **SES-6 (MUST).** `normalizeCwd` MUST collapse `.`/`..`/dup separators and
  follow symlinks, and MUST NOT rebase a foreign absolute path onto the current
  drive on Windows (`lib/session/discover.ts:474-485,480`; test
  `discover.normalize-cwd.test.ts:52-60`). The index-time and query-time
  normalization MUST agree byte-for-byte (`discover.filter-parity.test.ts:62-135`).
- **SES-7 (MUST).** A parallel dotfile sweep MUST be bounded + staggered
  (concurrency 2, 15ms stagger) so it does not read like a ransomware bulk-enum to
  behavioral EDR (`lib/session/discover.ts:236-239,309-310`).

#### 3.2 The preview contract — **prefer to always show a preview**

- **SES-8 (MUST).** Every list-row renderer MUST show a non-empty preview cell.
  The fallback chain is: live preview (the current turn) → `label` → first-prompt
  `topic` → `'-'` (`buildSessionDescription`, `commands/sessions.ts:343-356`). A
  row MUST NOT render a blank preview cell.
  - `--active` rows satisfy this: `buildSessionDescription(s) || '-'`
    (`commands/sessions.ts:485`).
  - overview / tree rows satisfy this: `... session.topic) || '-'`
    (`commands/sessions.ts:1447`).
  - picker / `--preview <id>` satisfy this: fallback at every branch
    (`commands/sessions-picker.ts:348-350,85-100`).

  Status: `[Intended]` — two renderers do not yet meet it (`--flat` and the
  interactive picker share an unguarded `renderTopicCell`); the shortfall is
  SES-GAP-1.
- **SES-9 (MUST).** The preview MUST be deterministic and non-LLM: live rows use
  the state-engine's latest-turn string; static rows use the persisted
  first-prompt `topic`; the picker uses pure regex/heuristic digests
  (`lib/session/digest.ts:1-9`). No preview path may make a network/LLM call or
  block on async I/O.

- **SES-9a (MUST).** `sessions preview <id-or-prefix>` MUST resolve ID-shaped
  selectors through the SQLite ID index across the selected fleet. A full UUID
  MAY return on its first exact **locally-definitive** hit — one this box can
  actually answer for, meaning a transcript on this disk or a genuine non-self
  `machine` attribution (`isLocallyDefinitiveMatch`, `commands/sessions.ts`). A
  transcript-less local row whose `machine` merely DEFAULTED to this box MUST NOT
  short-circuit the fan-out; see the launcher-shim rule under §Active sessions
  (PHNX-3890). When the sweep has completed and some peer
  did not answer, a selector that is a complete id, or at least 8 hex characters
  wide (`SHORT_SESSION_ID_WIDTH`, the printed `shortId` width), MUST resolve if
  exactly one session on the reachable fleet matches it; a shorter or
  non-ID-shaped selector, and any label, MUST fail closed. Durable preview data
  MUST be invalidated by the transcript's actual mtime + size. Live status MUST
  NOT be stored in that durable digest and MUST expire within 15 seconds.

  *Accepted risk, amended 2026-08-10.* This requirement previously made every
  short prefix fail closed whenever any peer was unavailable. On a fleet with a
  permanently offline registered device that voids 100% of short-id lookups —
  measured at 9 offline devices — to guard a collision that must ALSO land
  specifically on a peer that did not answer. The collision rate is **not**
  uniform across id types, and the difference matters: a random UUIDv4 short id
  is unique in practice, but the first 48 bits of a **time-ordered** id
  (UUIDv7/ULID) are a millisecond timestamp, so sessions minted in one tight
  window — a `teams` fan-out, a swarm — share an 8-hex prefix far more readily.
  `session/db.ts` (`deriveShortId`, "only time-ordered ids ever collide") already
  treats that as expected and resolves it by most-recently-active. Collisions
  among peers that DID answer are still reported: they produce two candidates and
  surface through the `ambiguous` outcome, which is unchanged, so the residual
  risk is confined to a time-ordered collision hiding on the unanswered peer.
  RUSH-2203's early-exit rule (`isDefinitiveMatch`/`selectorAllowsEarlyExit`)
  cancels a sweep still IN FLIGHT, where a silent peer is still expected to
  answer — a stricter bar than the post-sweep rule above. It was full-UUID-only
  until PHNX-3292 widened it to also cover a live tmux alias and an EXACT
  8-hex short id (not a narrower prefix): both name at most one session per
  answering peer, the same width `SHORT_SESSION_ID_WIDTH` already treats as
  unique-enough post-sweep, so the first reachable hit is enough. PHNX-3292 also
  added a LOCAL-only gate ahead of any fleet call: a live tmux alias, or a bare
  8-hex naming exactly one live LOCAL pane, attaches with zero SSH
  (`lib/session/local-tmux-attach.ts`, `attachLocalLiveSelector`) before
  `sessions resume`/`sessions attach`/`sessions focus` ever reach this
  resolver.
- **SES-9b (MUST).** An ID-shaped selector that misses the local transcript index
  but names a session the LOCAL live registry (`getActiveSessions`, the source
  `--active` reads) currently reports as running MUST resolve to that session
  rather than "No session matching". Indexing is lazy (only `discoverSessions`
  writes the index), so a session started on THIS box is running before its
  transcript is indexed; the id resolver behind `preview`/`resume`/`focus` MUST
  union the indexed rows with the live registry on a cold id miss
  (`computeLocalMetadataMatches`, `commands/sessions.ts`). The synthesized row
  parses no transcript and renders nothing; when the transcript is on disk its
  path rides across so the downstream preview renders the real digest, else the
  header plus a live note. The peer answering a fan-out (`--resolve-safe-v1`,
  NO_FANOUT) uses the same union, so a running session resolves cross-device too.
  A genuine miss (no indexed row and no live row) still fails closed, and a
  degraded live-registry read yields no candidates rather than throwing.
  Status: landed (RUSH-2682).
- **SES-9d (MUST).** The transcript a live row carries MUST be that session's own.
  When the session id is known, it selects the transcript: Claude resolves
  `<id>.jsonl` straight off disk (`findClaudeSessionFile` → `pickSessionFile`),
  and every other tracked harness resolves the id against the session index
  (`indexedSessionFileForId`, `lib/session/active.ts`). Only an id-less process
  may fall back to the newest indexed transcript in its cwd, and an id neither
  path resolves MUST yield no transcript rather than a co-located sibling's. The
  cwd fallback answers `WHERE agent = ? AND cwd = ? ORDER BY last_activity DESC
  LIMIT 1` (`latestSessionFileForCwd`), so with two same-harness agents in one
  cwd it returns one stranger's transcript to all of them — which under SES-9b
  renders another session's digest under this session's header and caches it
  against the wrong id. A row whose indexed `agent` differs from the live
  process's harness is refused for the same reason.

  Consequence worth stating: because only Claude resolves off disk, a non-Claude
  live row carries no transcript until the index reaches it, so during that
  window `computeLiveSignals` returns `{}` and the row shows the
  `resolveFallbackStatus` `running` rather than a `working` / `waiting_input`
  distinction (SES-18 still holds — it never reads `unknown`). SES-9c's warm tick
  is what keeps that window short. This is the deliberate trade: a coarser status
  for seconds beats a confident render of someone else's conversation.
  Status: landed (RUSH-2691).
- **SES-9c (SHOULD).** A session started on a machine SHOULD reach that machine's
  transcript index within seconds, not on the next unrelated `agents sessions*`
  invocation. The daemon incrementally scans this host's transcript dirs into the
  local index on a bounded timer (`runSessionIndexWarmTick`,
  `SESSION_INDEX_WARM_TICK_MS`), single-flight with foreground scans via the DB
  scan claim. That tick MUST run the scan itself (`scanSessionsIncremental`) and
  MUST NOT route through `discoverSessions`, whose trailing listing query defaults
  its cwd filter to the daemon's cwd and so reports rows indexed rather than
  transcripts scanned (RUSH-2691). Every `SESSION_AGENTS` member MUST contribute
  to that count, including the store-backed harnesses whose scanners index a batch
  rather than per-file. The id cold-miss repair behind `preview`/`resume`/`focus`
  MUST wait (bounded) for an in-flight scan to finish before reading, not return
  the pre-scan snapshot (`discoverSessions({ waitForScan })` → `waitForScanToSettle`,
  `scanInProgressByLivePid`). Status: landed (RUSH-2682, RUSH-2691);
  see SES-GAP-9c for the repair paths that do not yet take the wait.
- **SES-10 (MUST).** A preview string MUST be cleaned of terminal/harness noise
  (OSC titles, CSI/SGR, harness tags, collapsed whitespace) before display
  (`cleanPreview`, `commands/sessions.ts:329-337`), and truncated width-aware
  (never splitting a wide glyph, reserving one cell for `…`)
  (`lib/session/width.ts:61-74`).
- **SES-11 (MUST).** `topic` extraction MUST fall through noise-only leading user
  messages to the first message that yields a real topic
  (`lib/session/prompt.ts:72-86`; test `prompt.test.ts:23-28`).

#### 3.3 Metadata

- **SES-12 (MUST).** `agents sessions <id> --json` and `--json` listing MUST emit
  the `SessionMeta` shape (`lib/session/types.ts:85-192`). The field set, its
  derivation, and whether each is always populated is the table in
  [sessions.md](sessions.md#sessionmeta-list-output) — that table is
  normative for field names.
- **SES-13 (MUST).** "Where the session started" is carried by **three distinct
  axes**, and consumers MUST NOT expect a single `origin` field to hold all of it:
  - `cwd` — the filesystem launch dir, read verbatim from the transcript
    (`lib/session/discover.ts:2892`); `project` is its basename.
  - `provenance` — where the live *process* runs: `host`, `transport`
    (`local`|`ssh`), `ssh` IPs, tmux `mux` pane — read from
    `/proc/<pid>/environ` or `ps eww`, **never guessed**
    (`lib/session/provenance.ts:66-79,225-230`), attached only to rows with a
    live pid (`lib/session/active.ts:1352-1358`). It is a field of
    `ActiveSession` (`lib/session/active.ts:231`), **not** of `SessionMeta` —
    which declares no `provenance` property at all — so on the archived listing
    path (`sessions --json` without `--active`, served from `discoverSessions`
    via `serializeSessionsJson`, `commands/sessions.ts:956-961`) the key is
    **absent from the JSON object entirely**. A consumer MUST test for the key's
    presence, not for `null`.
  - `context` — the launch context (`terminal`|`teams`|`cloud`|`headless`)
    (`lib/session/active.ts:76`).
  - The adjacent `SessionMeta.origin` (`cli`|`routine`,
    `lib/session/types.ts:90`) is *row provenance* (live scan vs archived routine
    run), not launch location; `isTeamOrigin` (`:170`) flags a teams-spawned
    session.
- **SES-14 (MUST).** `label` (the session name) MUST resolve by priority: agent
  title / `/rename` > `agents run --name` handle > unset (listing then falls back
  to `topic`); an empty incoming label MUST NOT clobber a stored non-empty one
  (`lib/session/db.ts:800-803,1098-1100`; test `db.names.test.ts:50-128`).
- **SES-14a (MUST).** A harness-generated session title MUST pass through
  `cleanGeneratedSessionLabel` (`lib/session/prompt.ts`) at the point the
  scanner composes `SessionMeta.label`, so injected skill scaffolding
  (`Base directory for this skill: …`) collapses to `/<skill>`. Today that is
  Claude `ai-title` (`finalizeClaudeScan` in `lib/session/discover.ts`) and
  Cursor `chatMeta.title` (`readCursorMeta`). A user `/rename` (`custom-title`)
  MUST NOT be rewritten. Codex / OpenCode / Kimi / Droid auto-titles land on
  `topic`, not `label`, and are out of this requirement.

  Given a Cursor `meta.json` whose `title` is the skill-basedir line, When
  `readCursorMeta` runs, Then `meta.label` is `/<skill>`.
  Tests: `lib/session/prompt.test.ts`, `lib/session/__tests__/parse-cursor.test.ts`,
  `lib/session/__tests__/discover.test.ts`.
- **SES-14b (MUST).** `SessionMeta.firstUserMessage` (PHNX-3621) MUST be the
  genuine, FULL first user turn — the verbatim text of the first user message
  that is NOT harness-injected scaffolding (`cleanFirstUserMessage` /
  `firstUserMessageFromEvents`, `lib/session/prompt.ts`) — captured at scan
  time. It MUST NOT be a one-line distillation (that is `topic`), an agent
  title (`label`), or the display-cleaned form (`ActiveSession.userPromptClean`).
  It is stored on the `sessions` table (`first_user_message`, `lib/session/db.ts`)
  and persisted first-wins in the Claude/Codex/Kimi resumable parse-state so an
  incremental resume never loses or overwrites it. Grok MUST recover it via a
  bounded prefix read of `chat_history.jsonl` (`readGrokFirstUserMessage` in
  `lib/session/discover.ts`) because its cheap scan otherwise reads only
  `summary.json`. OpenClaw is out of scope — its rows are live channel/cron
  entries, not user-prompt transcripts. It MUST be emitted on the
  `sessions --json` list and ride `ActiveSession` onto the `sessions watch --json`
  / `feed watch --json` streams (backfilled from the index by
  `backfillActiveRowsFromMeta`, `lib/session/active.ts`), and is deliberately NOT
  part of the minimal `--resolve` safe-metadata set (SES-IF-2a).
  Tests: `lib/session/prompt.test.ts`, `lib/session/discover.first-user-message.test.ts`,
  `lib/session/__tests__/db.test.ts`, `lib/session/discover.test.ts`,
  `lib/session/remote/watch.test.ts`, `commands/sessions.serialize.test.ts`.
- **SES-15 (MUST).** A timestamp-less source MUST fall back to file mtime and
  MUST NOT bind NULL into the `NOT NULL` timestamp column
  (`lib/session/discover.ts:4198-4202,1238-1243`).
- **SES-16 (SHOULD).** Cross-harness durable signals (todos/checklist, PR url,
  ticket id, created tickets) SHOULD be extracted by shared agent-agnostic
  extractors so a harness earns them by emitting the right event
  (`lib/session/state.ts:164-317`).

  Status: `[Intended]` — coverage is uneven today (the live path forces
  non-Codex→Claude, and no harness populates `costUsd`); the shortfall is
  SES-GAP-2.
- **SES-44 (MUST).** A Claude session MUST be attributed to the account that
  produced *it*, never to one account resolved once per process. Attribution is a
  pure function of the transcript's `file_path` and its recorded `version` — no
  per-file I/O, no dependence on the transcript still existing — resolved in
  `lib/session/claude-accounts.ts` (`buildClaudeAccountIndex`,
  `resolveClaudeAccount`) and stamped by `readClaudeMeta`
  (`lib/session/discover.ts`). Evidence tiers, strongest first: the path names a
  version home (including a retired `trash/` snapshot, which keeps its
  `.claude.json`); the path is under the mutable `~/.claude` symlink and the row
  records a version, which resolves to that version's own home (this covers the
  `runs/` routine archives too); neither. A path naming a home that exists but is
  signed out MUST resolve dark against that home rather than fall through to its
  recorded version — the file's location is what proves which config dir was used.
  Attribution is implemented for Claude only; other harnesses MUST report a NULL
  `account_key` rather than a guessed one.
- **SES-45 (MUST).** Grouping MUST key on the org-scoped `account_key`
  (`claude:org=<uuid>`), never on the email: two orgs under one email (a Team seat
  and a personal Max plan) are separate rate-limit buckets, the same invariant
  `candidateIdentity` enforces in `lib/rotate.ts`. `account` is display-only.
- **SES-46 (MUST).** A session whose account cannot be established MUST surface as
  `unattributed:<reason>`, with distinct reasons in distinct buckets, and MUST NOT
  be dropped or folded into a real account. This includes retired homes that are
  signed out, backup mirrors (no `.claude.json`), versions whose retired snapshots
  disagree, and — in `--by account` rollups — harnesses with no attribution support
  (`unattributed:<agent>`). The v33 backfill MUST also clear the pre-v33 `account`
  email on a row it cannot attribute, since that value is known-wrong.

#### 3.4 Lifecycle

- **SES-17 (MUST).** Liveness MUST be `process.kill(pid,0)` guarded against PID
  reuse by comparing recorded start-time within a 60s tolerance; Windows falls
  back to bare existence (`lib/session/active.ts:287,327-338`; test
  `active.liveness.test.ts:35-37`).
- **SES-18 (MUST).** Session status MUST be derived honestly, and a LIVE process
  MUST NEVER resolve to `unknown`. Every tracked harness (not only Claude/Codex)
  MUST be parsed into a real `working`/`waiting_input`/`idle` when its transcript
  is locatable + parseable (`computeLiveSignals` / `findSessionFileForKind`,
  `lib/session/active.ts`); an opaque/untracked kind or an unreadable transcript
  MUST fall back to `resolveFallbackStatus`, which reports `running` for any live
  process (never a blanket `unknown`, never a fabricated `idle`)
  (`lib/session/active.ts`). A dead process MUST report `closed`; a transcript not
  written for `ABANDONED_STALE_MS` MUST report `abandoned`, whether its PID is dead
  or still alive. `unknown` is reserved for the sole un-answerable case: no PID
  signal and no file signal; modern local scanners pass a definite PID-liveness
  boolean, but `unknown` remains valid input from older remote peers. A structural
  `AskUserQuestion` / `ExitPlanMode` as last event MUST report `waiting_input` and
  MUST NOT decay with the freshness window (`lib/session/state.ts`; test
  `state.test.ts`). A dead process whose OWNING HOST WINDOW also stopped
  republishing MUST report `crashed` rather than `closed` — see SES-18a, which
  narrows this clause.
- **SES-18a (MUST).** A session's **host link** — whether any client is still
  driving it — MUST be derived, never asserted, and MUST be folded on centrally
  (`foldHostLink`, `lib/session/active.ts`) from the pure classifier
  (`lib/session/host-link.ts`), never decided per source. A live agent with a
  tmux attached-client count of exactly zero, or whose owning IDE window has not
  republished its `live-terminals.json` slice within `HOST_HEARTBEAT_STALE_MS`,
  MUST classify as `no-client`; a dead agent under such a window MUST classify as
  `host-gone`. An ABSENT client count MUST read as unknown, never as zero. When
  NEITHER signal is available — no owning window and no client count, which is
  the case for a bare terminal, a team spawn, a cloud task, and any `--device`
  session whose pane lives on another machine — the link MUST classify as
  `unknown` and MUST NOT classify as `connected`: `connected` asserts an observed
  client, and no consumer may render `unknown` as healthy. `unknown` is not a
  loss signal, so it MUST NOT promote any status and MUST NOT clear a derived
  `attached` presence — only a positive `no-client`/`host-gone` may do that
  (test `host-link.test.ts`, `active.hostlink.test.ts`). A
  session whose `presence` is `background`/`parked` MUST NOT be classified as
  either — no client is the point of detaching. On the status column, `abandoned`
  MUST win outright, `host-gone` MUST replace `closed` with `crashed`, and
  `no-client` MUST replace `idle`/`input_required` with `orphaned`. A session
  still `running` MUST be promoted to `orphaned` ONLY when its owning IDE window
  was LOST — the window's registry slice went stale past `HOST_HEARTBEAT_STALE_MS`
  after having republished it, so the host died uncleanly and the agent outlived
  it (`hostWindowLost`, `lib/session/host-link.ts`). A `running` session that is
  merely clientless — a tmux attached-client count of zero with its window still
  fresh or absent — MUST keep `running`: since RUSH-3125 a detached remote pane
  (`agents run --device`) is the normal steady state between check-ins, so
  promoting it would relabel every unattended remote agent as orphaned (the
  over-report reverted in `6d973b823`). Mere client ABSENCE is never a running
  orphan; only a lost WINDOW is (test `active.hostlink.test.ts`,
  `host-link.test.ts`). A dead-pid registry entry whose window has gone stale MUST
  be RETAINED by `readLiveTerminals` so the session reaches the listing at all —
  dropping it made a crashed session indistinguishable from one that never ran
  (test `active.registry-retention.test.ts`). Every `tmux -F` format query MUST
  use a separator tmux cannot emit inside a field: it sanitizes non-printable
  characters out of format output, so a tab-separated format returns one
  unsplittable field, and a printable separator a session name MAY contain merely
  lowers the probability of the same bug. `:` is safe because tmux itself
  rewrites `:`/`.` in a session name; the one field that may contain it
  (`pane_current_path`) MUST be queried last (test `active.tmux-clients.test.ts`).
  Consumers that read `ActiveStatus` MUST handle `orphaned`/`crashed` rather than
  falling through to a stale `activity` — the `--waiting` filter reads the
  never-rewritten activity via `isAwaitingUser`, and the `--active` tally carries
  a bucket per status (test `active.hostlink.test.ts`).
- **SES-18b (MUST).** A bookmark MUST be stored outside `sessions.db`
  (`~/.agents/.history/bookmarks.json`, keyed by session id;
  `lib/session/bookmarks.ts`), because the index is a rebuildable cache and a
  bookmark is not derivable from a transcript. A malformed or absent store MUST
  degrade to "nothing is bookmarked", never throw into the listing path (test
  `bookmarks.test.ts`). Bookmarks are per-machine: the store is NOT carried in
  an export bundle or the import mirror (`lib/session/sync/agents.ts` defines
  the `.history/backups/` layout those write into), and any doc claiming
  otherwise is drift.
- **SES-18c (MUST).** Each user-visible live state MUST have a direct
  `agents sessions` flag: `working`, `idle`, `waiting`, `orphaned`, `crashed`,
  `closed`, `abandoned`, `queued`, and `unknown`. These flags MUST imply the live
  scan, MUST compose as a union, and MUST use the same predicates as the rendered
  status (`requestedLiveStatuses` / `matchesLiveStatus`,
  `commands/sessions.ts`; test `commands/sessions.cli-live.test.ts`). `--orphan` is the
  human-facing spelling and `--orphaned` remains its accepted alias. The live
  scan MUST fan out to registered online devices unless `--local` is present;
  `--all` MUST remain the historical directory/time widening flag, not a device
  switch.
- **SES-19 (MUST).** Detach/attach presence MUST be **derived, never asserted**:
  the record only says "this session was detached"; `background` vs `parked` is
  decided live from the recorded pid + start-time fingerprint
  (`lib/session/detached.ts:98-109`; test `detached.test.ts:117-137`).
- **SES-20 (MUST).** `migrate` MUST NOT kill the source before the transcript is
  on the target and its session is confirmed live
  (`commands/sessions-migrate.ts:590-593`; the invariant also stated at
  [sessions.md](sessions.md):476-477). A non-native-resumable harness MUST
  transparently fall back to rehydrate, never a silent skip
  ([sessions.md](sessions.md):471-474).
- **SES-21 (MUST).** `fork` MUST resolve the source session **across the fleet**
  (the same resolver `preview` uses — `commands/sessions.ts` `resolveSessionMetadataValue`,
  reached here via `sessions preview <id> --json`), then launch a **new same-harness
  session seeded with a recap** of the source (`agents run <harness> "<recap>" -i
  --strategy balanced`), leaving the original untouched. The recap is built from the
  source's preview digest (`buildForkRecap`, `lib/session/fork.ts`). Because the seed
  is plain text, fork MUST work for a source on any device and in any REPL harness (no
  transcript copy, no Claude-only gate). It MUST fail loud — never launch a
  context-less sibling — when the source cannot be resolved (`commands/fork.ts`
  `runFork`). Superseded the transcript-copy contract (fresh-UUID copy, Claude-only)
  in PHNX-3409; the old `forkSession`/`FORKABLE_AGENTS` mechanism is `(resolved)` —
  removed with its requirement.
- **SES-21a (MUST).** The tmux helper-process reaper MUST fail closed. A process
  carrying `AGENT_TMUX_SESSION_NAME` MAY be selected only when the corresponding
  tmux owner is present, its pane process is confirmed dead, and it has no
  attached client. An absent owner, including a reliable empty answer after a
  tmux server restart, MUST be treated as unknown and MUST NOT select the
  process. A harness-specific detached-helper rule MAY select a process only
  when its declared spawner pid is confirmed dead. (`lib/tmux/orphan-reap.ts`;
  regression tests in `lib/tmux/orphan-reap.test.ts`, RUSH-2603.)
- **SES-41 (MUST).** A direct lifecycle selector (full session id, unique id
  prefix, full `ag-<agent>-<8hex>` tmux alias, or unique alias prefix/suffix of at
  least six characters) MUST resolve to one canonical harness-native session id
  across the fleet. `sessions focus <selector>` and `sessions resume <selector>`
  MUST re-read live state after resolution: an alive tmux pane is attached, while
  `pane_dead=1`, `pidAlive=false`, `closed`, or `crashed` MUST take the native
  resume path on the owning device. Alias ambiguity MUST fail closed. Bare
  `sessions resume` remains the multi-select history picker
  (`commands/focus.ts`; `commands/sessions-resume.ts`;
  `lib/session/actor-sidecar.ts`; `lib/session/active.ts`).

#### 3.5 Remote & export/import

- **SES-22 (MUST).** `--device` MUST run the peer's **own**
  `agents sessions` over hardened SSH; transcripts stay on the origin machine and
  there is no identity layer beyond SSH access (`lib/session/remote/remote.ts:1-11`). A
  recursion guard (`AGENTS_SESSIONS_LOCAL=1`) MUST prevent re-fan-out
  (`lib/session/remote-active.ts:20`) and MUST also suppress the interactive
  browser, so a peer answering a fan-out can never open a TUI
  (`commands/sessions.ts` `isBareBrowserListing`).
  - **Streaming vs. merging.** A **non-interactive** invocation (`--json`, piped
    stdout, `--no-interactive`, a positional query, a render/filter flag,
    `--cloud`, or more than one host) MUST stream the peer's stdout back verbatim
    under a per-host banner. A **bare interactive** one-host listing instead folds
    the peer's `--json` rows into the local merged browser (`gatherRemoteList`),
    which renders and selects locally. Both keep transcripts on the origin.
  - **The `all`/`fleet` sentinel MUST reach the fleet on a historical query too
    (PHNX-2673).** `--device all` / `--device fleet` (and the `--devices` alias)
    is not a device name — it means "sweep every registered online peer." On
    `--active` and the interactive listing this is already the default, so the
    sentinel resolves to an empty host set. On the **historical `--json`** listing,
    which stays local-only by default (a deterministic slice for scripts), the
    empty host set MUST NOT silently drop the request: the sentinel MUST trigger
    the same `gatherRemoteList` peer sweep (whole-index per peer), merged
    machine-first into the local rows (`commands/sessions.ts`, guarded on the
    remembered sentinel; test `commands/sessions.fleet-json.test.ts`). A bare
    `--json` with no `--device` MUST stay local-only, and `--local` MUST still pin
    to this machine.
- **SES-23 (MUST).** Remote fan-out MUST degrade, never throw or blank: an
  unreachable host (ssh 255) falls back to offline cache, a slow host is killed
  to `[]`, and overall `process.exitCode=1` signals partial failure
  (`lib/session/remote/remote.ts:141-146,220-261`; `lib/session/remote/remote-list.ts:88-108`; test
  `lib/session/remote/remote.test.ts:167-181`).
  - **In the browser**, where the full-screen repaint hides the fan-out's stderr
    note and there is no exit code to read, the unreachable peers MUST be surfaced
    as data instead — `RemoteListResult.unreachable`, rendered in the browser
    header — so "that box is asleep" stays distinguishable from "that box has no
    matching sessions" (`lib/session/remote/remote-list.ts`; `commands/sessions-browser.ts`).
  - **A host scope MUST NOT widen.** An explicit `--device` naming only
    this machine leaves nothing remote to dial; the fan-out MUST be skipped rather
    than passing an empty list to `gatherRemoteList`, which reads `[]` as "no hosts
    given" and sweeps every online device.
- **SES-23a (MUST).** A `--device` scope on `--active` names **where the
  session runs**, not which box reported it. Every returned row MUST satisfy
  `machine ∈ scope` (`filterActiveSessionsByHostScope`,
  `commands/sessions.ts`), applied inside the single gather so the interactive
  browser and `--active --json` cannot disagree.
  - **The executing machine owns the row.** A host-dispatched run
    (`agents run --device <peer>`) leaves a live shim process on the DISPATCHING
    box carrying the remote run's session id, so choosing whom to ASK is not the
    same as deciding who OWNS the session. `machine` MUST be the execution host:
    `foldExecutionMachine` (`lib/session/active.ts`) folds the machine the
    dispatch recorded in the index (`lib/hosts/session-index.ts:55,134`) back
    onto the live row before it leaves the box, and the cross-machine fan-out
    MUST NOT overwrite a peer-reported `machine` that names a third box
    (`lib/session/remote-active.ts`).
  - **A peer's self-report outranks a local index copy.** A row the fan-out
    already attributed to a peer MUST be left alone. Enforced on the fan-out
    boundary (`lib/session/remote-active.ts`), where an `offloadedFrom` row keeps
    its own `machine` and every other row takes the dialed device name; the guard
    in `foldExecutionMachine` is the same rule stated locally.
  - **Transcript reads follow the file (PHNX-3481).** `_remote` is sufficient but
    not required to read from a peer. `transcriptOnPeerOf` MUST also return
    `machine` when it names another box and `filePath` is empty or absent on this
    disk. This covers the synthetic empty-file row from `registerHostSession` and
    the live-registry bridge used by full-UUID `preview <id>` without making a
    genuinely local unindexed live row remote. A synced mirror whose `filePath`
    exists MUST still preview locally even when `machine` names the owner.
    `buildPreview`, direct `preview <id>`, and `sessions <id>` MUST all use this
    predicate, so they fetch/hop to the peer rather than render "full transcript
    not indexed here". An unreachable owner MUST remain a loud `no-target` error.
  - **A launcher shim MUST NOT claim the transcript (PHNX-3890).** The rules above
    need a correct `machine`, and the dispatcher's own row is where it goes wrong:
    a box that LAUNCHED a session running on a peer holds a live registry row with
    no transcript on disk and a `machine` that defaulted to itself
    (`active.machine ?? self`, `lib/session/live-metadata.ts`;
    `machine || localMachine`, `commands/sessions.ts`). `foldExecutionMachine`
    cannot correct it — there is no local index row to fold from — so two
    independent paths MUST recover the true execution host:
    (a) the live bridge reconciles a self-attributed transcript-less row against
    the fleet-active snapshot, which already knows the owner
    (`fleetExecutionMachineById` / `reconcileLiveMetaMachine`), stamping `machine`
    + `_remote`; and (b) with no snapshot to read, the full-UUID resolver MUST
    consult the fleet (SES-9a) and MUST prefer the owning peer's answer over the
    shim (`preferOwnerAttribution`) — since candidates are grouped per machine and
    consumers read the first hit, fanning out without that preference still lets
    the launcher box win. A row that IS locally definitive is never displaced, so a
    local transcript or a synced mirror keeps rendering with no SSH hop, and a shim
    no peer answered for stays local rather than becoming a not-found (SES-9b).
    Only a snapshot entry naming a PEER may be trusted, and the asymmetry is
    deliberate: the fleet snapshot is a merge that INCLUDES this box's own rows,
    so for the very shape being corrected here — no index row to fold from — an
    entry naming THIS box may be nothing but an echo of the same self-default,
    recorded while the owning peer had not yet reported or was unreachable during
    that gather. Treating it as confirmation would skip the fan-out and dead-end
    on the local stub for a session genuinely running elsewhere, i.e. reintroduce
    this very defect. A peer entry is positive information; a self entry is not.
    The accepted cost is that a transcript-less row this box cannot vouch for
    pays a fleet sweep (measured ~13s on a 13-device fleet with 4 unreachable),
    which lands hardest on a fresh non-Claude session — only Claude resolves its
    transcript off disk (SES-9d), so every other harness has an empty `filePath`
    until the index catches up. Correctness over latency: the resolution is right
    either way, and only the fast path is lost. Tracked as PHNX-3900.
  - **`machine` is not "where the process is".** For an offloaded run the shim
    process, its tmux pane, and its terminal window remain on the dispatcher.
    Any caller reaching for a LOCAL pid/pane/window MUST ask
    `sessionProcessIsLocal(s, self)` (`lib/session/active.ts`) rather than
    comparing `machine` to this box — a local pane id (`%N`) sent to a peer's
    tmux server can resolve against an unrelated pane and attach the wrong
    session. The predicate MUST compare `offloadedFrom` to this machine, not
    merely test it: these rows travel (`--active --json` spreads them, the
    fan-out preserves their foreign `machine`), so a THIRD box sees a shim that
    is not its own. The box to reach for the process is `sessionProcessHost`
    (`offloadedFrom ?? machine`), never `machine` alone.
  - **Remote teams teammates are covered too.** A `teams add --device <peer>`
    teammate executes on `<peer>` but gets no host-dispatch index row, so the
    fold above cannot reach it. `listTeamsActive` (`lib/session/active.ts`)
    instead folds the teammate record's own `AgentProcess.hostName` into
    `machine = normalizeHost(hostName)` and `offloadedFrom = <orchestrator>`
    whenever the teammate runs on a box other than this one — the same shape a
    `run --device` row gets, so `--device <orchestrator>` no longer lists a
    teammate executing on a peer (was SES-GAP-10, RUSH-2486). A teammate pinned
    to this box (or an unpinned local one) is left unattributed for the
    self-stamp.
  - **The pool listing agrees with the live view.** `queryIndexedSessions`
    (`lib/session/discover.ts`) MUST keep the machine an offloaded run recorded
    on its empty-file index row (`registerHostSession`) rather than re-deriving
    it from the transcript path — `machineForSessionFile('')` falls back to THIS
    box, which re-attributed the dispatcher's own pool row to itself and split it
    from the executing peer's fan-out row, so `agents sessions <id>` read as
    "ambiguous (2 sessions)" for a live offloaded run (RUSH-2486 / criterion 2 of
    RUSH-2479). The path derivation still owns live-home files and synced
    mirrors, whose recorded machine already equals it.
- **SES-24 (MUST).** `agents sessions export --encrypt` MUST seal each
  transcript body client-side with AES-256-GCM (fresh IV) before it leaves the
  machine, and `agents sessions import` MUST decrypt before writing it to the
  mirror — the bundle only ever carries ciphertext when encryption is on
  (`lib/session/sync/transcript-crypto.ts:82-96,161-171`;
  `lib/session/bundle.ts:124,256,299`).
- **SES-25 (MUST).** For a local `--encrypt` bundle and the BYO backup target,
  the export encryption key MUST be the shared `R2_SYNC_ENC_KEY` from the
  `r2.backups` bundle when that bundle is configured (so any machine holding it
  can decrypt), else an ephemeral key MUST be minted and printed once and MUST
  NOT be persisted anywhere (`commands/sessions-export.ts:resolveExportKey`).
  `agents sessions import` MUST accept either the bundle key or an explicit
  `--decrypt <key>` for an ephemeral one
  (`commands/sessions-import.ts:resolveDecryptKey`). The MANAGED backup target
  (SES-50) does NOT take this path: its key is the mandatory per-account escrowed
  DEK of SES-51, never an ephemeral or absent key.
- **SES-26 (MUST).** Peer-controlled paths in a bundle MUST be
  containment-checked so a crafted `relKey`/machine name cannot escape the
  mirror root via `../` (`lib/session/sync/agents.ts:213-221`, shared by export
  and the mirror-placement path).
- **SES-27 (MUST).** The `R2_SYNC_ENC_KEY` / R2 credentials used by export and
  import MUST come only from the `r2.backups` keychain bundle, never env/disk
  (`lib/session/sync/config.ts:12,53`).
- **SES-27a (MUST).** The optional off-box backup target
  (`agents sessions export --to-r2` / `import --from-r2`, RUSH-2437) MUST be a
  pure on-demand backup — it MUST NOT revive the retired CRDT/background sync and
  MUST NOT run on a daemon cycle. On the BYO path it MUST fail loud (clear error,
  non-zero exit) when the `r2.backups` bundle is absent or locked, never a silent
  no-op (`commands/sessions-export.ts:r2ExportGateError`,
  `commands/sessions-import.ts:r2ImportGateError`); the MANAGED path (SES-50)
  requires no `r2.backups` bundle at all. Each session file MUST be stored as its
  own object under the shared key layout
  (`sessions/<machine>/<agent>/<sessionId>.jsonl`, or `.../<sessionId>/<relKey>`
  for dir-shaped agents) via `objectKey` (`lib/session/sync/agents.ts:objectKey`).
  The managed transport MUST prepend the verified `<userId>/` segment INSIDE its
  client (`lib/session/sync/net-client.ts`), so the BYO object layout is byte-for-
  byte unchanged. Restore MUST route through the same placement/decrypt path as a
  local bundle (`commands/sessions-import.ts:pullFromR2` →
  `planImport`/`writeImport`).
- **SES-50 (MUST).** The off-box backup target MUST be MANAGED-FIRST. A caller
  signed in to Phoenix (`readSession() != null`) with no explicit BYO override
  MUST resolve to the managed store (`sessions.agents-cli.sh`, per-user namespace
  = the verified userId), requiring NO `r2.backups` bucket. The mere PRESENCE of
  an `r2.backups` bundle MUST NOT be treated as a BYO override; only `--byo`,
  `AGENTS_SESSIONS_BACKEND=byo`, or a DI write token flips to BYO. The decision
  MUST go through the ONE shared policy (`selectStorageBackendKind`) that
  `agents artifacts share` and `agents traces sync` also use, resolved once so a
  logout cannot flip the principal mid-preflight
  (`lib/session/sync/backend.ts:resolveSessionsBackend`;
  `lib/session/sync/backend.test.ts`).
- **SES-51 (MUST).** A MANAGED backup MUST NEVER upload plaintext. The command
  MUST resolve a non-null 32-byte per-account DEK and seal every transcript body
  per SES-24 before upload. The DEK MUST be minted once, cached locally at
  `~/.agents/.cache/state/sessions-backup-key.json` (mode 0600, keyed by userId
  so multiple accounts stay isolated), and ESCROWED at the bearer-gated,
  conditional-create Worker key `<userId>/__key/backup-dek` so a fresh box signing
  in with the same account recovers it with zero setup. The escrow is
  authoritative: a present-but-corrupt or wrong-owner escrow MUST fail loud (never
  be replaced, which would orphan prior backups), and concurrent first-use devices
  MUST converge on one immutable escrow key
  (`lib/session/sync/managed-key.ts:resolveManagedBackupKey`;
  `lib/session/sync/managed-key.test.ts`). Trust boundary, stated honestly:
  managed backup is confidential vs a raw R2/Cloudflare bucket read (ciphertext at
  rest, SES-24 holds) but NOT zero-knowledge vs Phoenix (the DEK is escrowed on
  Phoenix-operated infrastructure, so the operator CAN recover it); `--byo` is the
  zero-knowledge path (the key stays only in the operator's own `r2.backups`
  bundle). The managed Worker MUST ALSO enforce this at the storage boundary: a
  PUT whose body is not an encrypted bundle (header claims encryption AND every
  record body is an AES-256-GCM transcript envelope) MUST be rejected with 422, so
  an older/buggy client cannot land readable plaintext; and a MANAGED restore MUST
  fail loud on any non-encrypted object rather than importing it
  (`lib/session/sync/worker-template.ts:isEncryptedManagedBundle`;
  `commands/sessions-import.ts`).
- **SES-52 (MUST).** The managed sessions Worker MUST authenticate EVERY route
  (PUT/GET/LIST/DELETE) with a Phoenix bearer, verified at
  `${PHOENIX_ID_BASE}/api/v1/auth/me`, and MUST enforce `segments[0] === verified
  userId` (missing bearer → 401, wrong owner → 403). There MUST be NO static-token
  principal: the zero-knowledge `--byo` path talks to the operator's own R2 bucket
  directly through `R2Client` and NEVER reaches this Worker, so a `WRITE_TOKEN`
  here would only be a Phoenix-and-quota bypass with no legitimate caller and MUST
  NOT be provisioned (PHNX-3726). There MUST be NO public GET and no public cache
  header. The reserved `__usage` (per-user CAS quota ledger, 413 over quota) and
  `__key` (escrowed DEK) prefixes MUST be owner-bearer only and MUST NEVER appear
  in a LIST. Unlike the traces Worker, there MUST be NO `/all` cross-device
  aggregate — encrypted session transcripts are opaque beyond their validated
  envelope shape and merging them server-side would corrupt them. Managed PUT
  and DELETE of one object MUST share a recoverable, expiring mutation lease.
  Every object mutation MUST be conditional on the prior object etag; DELETE is
  represented by an etag-conditioned, LIST-hidden tombstone (GET returns 404),
  never an unconditional delete that a stale predecessor could apply to a
  replacement. Before reclaiming an expired operation, the successor MUST fence
  that prior etag, then commit or roll back its accounting from the stored
  mutation token. The usage ledger MUST retain each in-flight delta by mutation
  token and persist the terminal generation for that path in the same CAS write,
  so a live predecessor cannot add a late delta after recovery. Before creating
  any persistent per-path lease/tombstone, the Worker MUST CAS-reserve that path
  against a hard historical-path cap. DELETE refunds live bytes/object count but
  MUST NOT refund the historical slot: terminal state cannot be time-GCed while
  an unbounded-duration predecessor may resume, so this cap bounds leases,
  tombstones, and settled-ledger entries under create/delete churn. Contention
  MUST fail loud; same-key PUT/DELETE races MUST NOT delete a replacement,
  double-refund, strand a path, or leave phantom quota
  (`lib/session/sync/worker-template.ts`;
  `lib/session/sync/worker-template.integration.test.ts`).

#### 3.6 Incremental consumer stream

- **SES-40a (MUST).** `agents feed watch --json` MUST compose the existing
  session watcher with the feed block/resolution and activity stores. Version 1
  envelopes carry `v`, `streamId`, strictly increasing `sequence`, and `scope`;
  the types are `reset`, `agent.upsert`, `attention.upsert`,
  `attention.remove`, `activity.append`, `scope`, and `heartbeat`. Fleet peers
  MUST be subscribed through `agents feed watch --json --local`, and an
  unavailable peer MUST retain its last rows until a reconnecting reset
  (`lib/feed/watch.ts`; `lib/feed/watch.test.ts`).
- **SES-40b (MUST).** `agents feed answer <attention-key>` MUST atomically claim
  the first answer before routing it through the recorded reply rail. A losing
  caller MUST return `already_answered` and MUST NOT inject or enqueue a second
  reply. High-consequence blocks MUST pass operator authorization before the
  claim (`lib/feed/answer.ts`; `lib/feed/answer.test.ts`).
- **SES-40c (MUST).** Pull-request status used by attention and PR-board
  projections MUST be sourced by the CLI on a bounded TTL and include
  `number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup`
  (`lib/feed/pr-status.ts`).
- **SES-40d (MUST).** The stream is long-lived — one child per VS Code leader —
  so its steady-state cost MUST NOT scale with the size of the activity corpus
  or with the number of rows on the stream. Activity MUST be read from a
  per-file cursor that reads only appended bytes, with a directory watcher and
  a bounded fallback sweep; the opening scan MUST NOT replay history onto the
  stream. A log that was replaced, truncated, or rewritten in place — including
  a rewrite that lands on its previous byte length — MUST be detected and
  re-read rather than retired at a cursor past unread content, and a log the
  stream is already tracking MUST NOT be re-registered as new work while it
  still exists (that would replay its tail as duplicate events). Attention MUST be reconciled on an announced change (a block or
  resolution write under the feed dir) or on the PR-status TTL, NOT on the
  activity tick. Emitted `activity.append` events MUST match what
  `readRecentActivity` would emit for the same appended lines, in the same
  order (`lib/feed/activity-stream.ts`, `lib/feed/watch.ts`;
  `lib/feed/activity-stream.test.ts`, `lib/feed/watch.reconcile.test.ts`).

  *Given* an activity dir of 1,437 logs / 64 MB and an idle fleet, *when*
  `agents feed watch --json --local` runs for five minutes, *then* it reads only
  the bytes appended in that window and holds under 1% of one core.
- **SES-40e (MUST).** A fleet fan-out (`watchFleetFeed`, `watchFleetSessions`)
  MUST NOT respawn a peer's subscription on a fixed short timer. Each peer MUST
  back off exponentially from 2 s to a 60 s cap, reset on a healthy protocol
  event; the child's stderr MUST be captured (bounded) and surfaced as the
  `scope: unavailable` reason; a peer failing three consecutive spawns MUST be
  parked until the device registry changes or the capped delay elapses. Abort
  listeners MUST NOT accumulate across reconnects
  (`lib/session/remote/peer-stream.ts`; `lib/session/remote/peer-stream.test.ts`).
- **SES-40f (MUST).** An attention item's `kind` MUST be classified from
  explicit harness evidence, never from the fact that a hook fired or from
  elapsed time (PHNX-3999). A `notification` block is a `permission` only when
  its recorded `notificationType` is `permission_prompt` (Claude's Notification
  event, or a Codex `PermissionRequest`); `elicitation_dialog` is a `question`
  with no invented choices; `idle_prompt` — "the turn ended and the operator has
  been idle" — MUST NOT be published by the feed-publish hook and, when an older
  hook left one on disk, MUST yield no request, so the session's lifecycle
  (a finished turn, or a trailing prose question) speaks for itself; a
  notification with no recorded subtype is `unverified`. The state engine MUST
  NOT report `awaitingReason: permission` from a transcript — a tool call with
  no result is `working` while the process is alive, however long it has run —
  and a lifecycle `permission` claim from an older peer MUST project as
  `unverified`. One unresolved record exists per `host/session/generation`; a
  hook-raised block MUST be resolved by later evidence — a transcript event
  (`lastEventMs`, the harness stamp on the last meaningful event, never the file
  mtime a hook firing advances) stamped after the block's `sourceCursor`, or a
  dead process — and a dismissed banner MUST NOT resolve it. A `permission`
  block the session offers no cursor to check MUST be trusted only for
  `UNVERIFIED_PROMPT_AGE_MS` (30 min), then read as `unverified`. An
  `unverified` item MUST carry no choices and no `safeDefault`; every consumer
  (the `feed watch` projection, the `attention-notify` daemon banner, `feed
  answer`) MUST render it as "could not verify request" with an open-session
  action only, and `feed answer` MUST refuse it. Time-based verdicts — the
  30-minute prose-question decay and the unverified age — MUST be recomputed
  against the current clock from cached parse output, never memoized with the
  transcript's mtime (`lib/feed/attention.ts`; `lib/session/state.ts`;
  `lib/session/active.ts` `computeLiveSignals`; `lib/feed/feed.ts`
  `FEED_PUBLISH_HOOK_SCRIPT`; tests `lib/feed/attention.truth.test.ts`,
  `lib/feed/attention.test.ts`, `lib/session/active.livesignals.test.ts`).

- **SES-41 (MUST).** `agents sessions watch --json` MUST emit newline-delimited,
  versioned envelopes carrying `streamId`, a strictly increasing `sequence`, and
  `capturedAt`. Version 1 defines `reset`, `upsert`, `remove`, `scope`, and
  `heartbeat`. A row's `rowKey` MUST be stable within its device
  scope and MUST be treated as opaque by consumers
  (`lib/session/remote/watch.ts:12-38,63-106`; `lib/session/remote/watch.test.ts:10-18`).
- **SES-42 (MUST).** The stream MUST include current sessions and retained recovery
  states. Each row MUST carry CLI-owned recovery/lifecycle metadata; an unavailable
  device scope MUST emit `scope: unavailable` without removing its retained rows,
  and a reconnect MUST replace only that scope through its next reset
  (`lib/session/remote/watch.ts:40-56,75-102,171-225`; `lib/session/remote/watch.test.ts:20-26`).
- **SES-42a (MUST).** Each row MUST carry a canonical `phase` — the coarse lifecycle
  bucket `running | waiting | failed | done | idle` — projected once at the source from
  the finalized `status` (`derivePhase`/`foldPhase` in `lib/session/active.ts`, folded
  after `foldHostLink` finalizes `status`). Consumers MUST read `phase` rather than
  re-deriving it from the status word; `orphaned` and `crashed` MUST bucket to `failed`,
  never `idle`, so a dead-but-dangling agent is never hidden (PHNX-2484;
  `lib/session/active.phase.test.ts`).
- **SES-53 (MUST).** Each row MUST carry the session's operative **`request`** —
  the LATEST genuine user turn, tidied but never rewritten. Prose is joined and
  whitespace-collapsed; screenshot / `host:/path` clip references, `@dir`
  mentions and pasted terminal echo are separated into `attachments` and
  `pastedLines` rather than deleted or left buried. A synthesized or
  model-paraphrased request is a violation: the card must show what the agent was
  actually told, and a model rewrite belongs in the summarizer's `goal`, labeled
  as such. `topic` and the row `title` MUST derive from the same raw turn, so
  harness scaffolding (`<local-command-stdout>`, a skill body, hook feedback)
  can never become a session's displayed name (PHNX-3939;
  `lib/session/prompt.ts` `tidyRequest`, `lib/session/active.ts`
  `deriveSessionRecap`; `lib/session/prompt.test.ts`,
  `lib/session/active.test.ts`).
- **SES-54 (MUST).** Each row MUST carry a **`timeline`**: narration-anchored
  steps, newest last, at most 8, plus an `earlier` counter for everything older
  and whole-session totals. A step's `text` MUST be the HARNESS's own words — the
  assistant's narration, a Codex `AgentMessage` with `phase: commentary`, a
  thinking block, the user's tidied turn, or (only when tools ran with nothing
  said) a `derived` line built from the call mix. Tool calls fold into per-verb
  counts with `failed` and `blocked` counted separately; a call denied by a
  permission rule or a hook is `blocked`, and a search that exits 1 with no match
  is neither. A harness that writes no parseable transcript MUST report
  `state: 'unavailable'` with a `reason`, and an event cap MUST report
  `state: 'partial'` — never an empty `ready` timeline presented as "nothing
  happened". `now` — the label of the call RUNNING — MUST appear only on the
  `live` step; a finished step carrying one makes a consumer render a now-line on
  completed work (PHNX-3939; `lib/session/timeline.ts`;
  `lib/session/timeline.test.ts`).
- **SES-54a (MUST).** Every projected string a row ships — a step's `text`, its
  `now`, its `marks` — MUST be scrubbed at the projection point, which is the
  single place folded transcript text leaves the fold. Secrets MUST be redacted
  through `redactSecrets` with the environment's known values (the local-only
  `sessions trace --no-redact` is the sole opt-out), and terminal escape
  sequences MUST ALWAYS be stripped, opt-out or not. A transcript is untrusted
  input, these labels are printed to a terminal, and the row is published to the
  git-tracked `~/.agents/devices/<device>/daemon-state.json` — so a label built
  by falling back to raw command text (a Bash call with no `description`) must
  never carry a credential there. `sanitizeEvents` does NOT run on the fold's
  parse path, so no consumer may assume the events were pre-scrubbed
  (PHNX-3939; `lib/session/timeline.ts` `projectTimeline`,
  `commands/sessions-trace.ts` `renderSessionSteps`;
  `lib/session/timeline.test.ts`, `commands/sessions-trace.test.ts`).
- **SES-55 (MUST).** The timeline MUST be computed ONLY by the daemon's
  reader-gated tick, bounded per tick, and cached in the stamp-validated
  `session_timelines` table; the display path MUST only read that cache. For a
  harness with a resumable line-delimited transcript (Claude, Codex) a pass MUST
  read only the bytes appended since the cached offset, and MUST fold only
  complete newline-terminated records — folding the appended tail onto the prior
  state MUST equal folding the whole file from zero. No transcript parse may
  enter the request path (PHNX-3939; `lib/session/timeline-pass.ts`,
  `lib/session/db.ts`; `lib/session/timeline-pass.test.ts`,
  `lib/session/db.timelines.test.ts`).
- **SES-55a (MUST).** The tick's byte budget MUST be debited by the bytes each
  fold ACTUALLY READS — the whole file for a non-resumable whole-file re-parse,
  the chunk length for a resumable one — never by the transcript's growth delta,
  which under-counts a whole-file re-parse by orders of magnitude and lets a tick
  overrun its stated bound. Whole-file eligibility MUST be gated on a budget that
  can reach a real transcript (the tick's remaining allowance, capped by the
  whole-file ceiling), never on the smaller per-session allowance, which no
  transcript above it could ever satisfy however idle the tick was. A session
  that genuinely exceeds the budget MUST get a row stating why — `partial` with a
  reason — and MUST NOT be counted `reused`, which claims a cached row that does
  not exist. A per-session fold that THROWS MUST be logged and counted `skipped`,
  never swallowed as "nothing new" (PHNX-3939; `lib/session/timeline-pass.ts`;
  `lib/session/timeline-pass.test.ts`).
- **SES-56 (SHOULD).** A row SHOULD carry **`files`** — the paths the session
  created, modified or deleted, bounded to 8 rows plus a real `total`.
  `source: 'harness'` means a harness file ledger contributed the path set —
  Codex `FileChange.changes`, which is the only one that also types the
  operation (`add`/`update`/`delete`); OpenCode `patch` and Claude
  `file-history-delta` record the paths a step wrote but NOT the verb, so those
  operations still come from the Edit/Write call that produced them.
  `source: 'tools'` means the whole projection was derived from tool arguments
  because the harness keeps no ledger at all. A `created` claim, once made,
  survives a later `modified` on the same path
  (`lib/session/timeline.ts` `projectSessionFiles`).
- **SES-43 (MUST).** The default stream MUST hold one long-lived local subscription
  and one long-lived SSH subscription per dialable compute device. `--local` MUST
  suppress peer subscriptions. Neither path may poll transcript history or invoke
  repeated live gathers: startup reads one reset snapshot, then steady state tails
  row deltas from the canonical snapshot writer's journal
  (`lib/session/session-cache.ts:190-230`; `lib/session/remote/watch.ts:141-211`;
  `lib/session/remote/watch.test.ts:30-61`; `commands/sessions-watch.ts:27-43`).
- **SES-44 (MUST).** A one-shot `agents sessions ... --json` listing is distinct
  from the incremental stream, but MUST expose the same picker-facing lifecycle,
  device, viewing, and recovery metadata in each durable row. Consumers MUST NOT
  need a second live-session join (`commands/sessions.ts:847-884,3168-3191`;
  `commands/sessions.test.ts:45-64`).

#### 3.7 Index / DB

- **SES-28 (MUST).** The index MUST open with WAL + `busy_timeout=30000` so
  multiple processes read concurrently, and use the built-in sqlite binding
  (`bun:sqlite`/`node:sqlite`), never `better-sqlite3` (`getDB()` in
  `lib/session/db.ts` — `journal_mode = WAL` ~`:442`, `busy_timeout = 30000`
  ~`:450`; binding selected in `lib/sqlite.ts:23-24`).
- **SES-29 (MUST).** Schema migrations MUST run on open, land a several-versions-old
  DB on the current `SCHEMA_VERSION` (**29** at time of writing,
  `lib/session/db.ts:28` — treat the constant as the source of truth, not this number) in
  one call, MUST NOT drop existing rows, and MUST bump the stamp only after the
  migration succeeds so a mid-migration crash re-enters cleanly
  (`lib/session/db.ts` around the `getDB` migration gate; tests `db.migrate-v10.test.ts:78-93`,
  `db.migrate-v14.test.ts:98-106`). A migration that changes derived data MUST
  invalidate the ledger for that data; it MUST NOT invalidate unrelated warm
  indexes.
- **SES-30 (MUST).** One malformed row's constraint failure MUST NOT roll back the
  batch and MUST NOT stamp that row's ledger entry, so it is retried next scan
  (self-healing) (`lib/session/db.ts:975-982,1035-1039`).
- **SES-47 (MUST).** The local index MUST be authoritative for a session's
  user-turn content: a session whose transcript file is gone from disk but whose
  `session_text` `content` still holds its user turns MUST remain listable and
  renderable, not dropped (RUSH-2436). `querySessions` and `topSessionsByCost`
  MUST keep such a row, flagged `archived` (persisted `sessions.archived_at`,
  schema v38, stamped once on the first confirmation the scanned file is gone);
  `agents sessions <id>` (the `findSessionsById` path) MUST resolve it, and the
  render + picker-preview paths MUST serve its user turns from the DB
  (`readSessionContent` / `readArchivedSessionPreview`) rather than falling back to
  a metadata-only note. A file-gone row with **no** cached content is a phantom (a
  stale/moved `file_path`) and MUST stay suppressed. Merely listing a file-gone
  session MUST NOT delete its redacted tool-call evidence — the destructive
  purge-on-read from the `querySessions` missing-file branch is removed. (The
  tool-index backfill still purges a session whose source file is gone mid-backfill,
  `tool-index.ts` `ensureToolIndex`; sparing an archived session there is out of the
  Layer-1 read-path scope, tracked as SES-GAP-9.)
  (`lib/session/db.ts` `querySessions`/`topSessionsByCost`/`readSessionContent`/`readArchivedSessionPreview`;
  `commands/sessions.ts` `renderArchivedSession`; `commands/sessions-picker.ts` `buildPreview`/`loadSessionPreviewDigest`).
  Because a moved-file phantom that a scan forgot to rewrite still carries content,
  it is now archived rather than dropped; in practice real harnesses derive the id
  from transcript content and rewrite `file_path` on the same row, so no such
  duplicate arises (Status: `[Landed]`; the content-vs-phantom discriminator is
  content presence, not supersession detection — SES-GAP-9).
- **SES-48 (MUST).** A keyword content query (`agents sessions "tmux pane"`,
  `filterSessionsByQuery`, `searchContentIndex`) MUST return every FTS5 hit
  whose `sessions` row still exists, not only hits that already sit in the
  in-memory listing pool. The pool is a page of the index (cwd-scoped,
  default-capped at 50) and is a minority of indexed transcripts, so
  intersecting FTS hits with it dropped grep-visible sessions the index already
  matched (PHNX-2767). Hits the pool missed MUST be hydrated from the index and
  unioned into the result. Explicit `--project` / `--agent` / `--routine`
  flags MUST still exclude a hydrated hit that fails them — those are filters,
  not a page of the index, and the union MUST NOT undo them (otherwise
  `sessions --project foo "phrase" --markdown` reports a multi-match ambiguity
  against a session the user already scoped out). An id-shaped query MUST still
  resolve by id only (SES-9a) and MUST NOT fall through to this content path.
  (`lib/session/discover.ts` `searchContentIndex`; `commands/sessions.ts`
  `filterSessionsByQuery`/`scopedContentIndex`; tests
  `discover.search-content.test.ts`, `commands/sessions.render.test.ts`).
- **SES-49 (MUST).** `session_text` MUST index the agent's own answer text
  (`assistant` column), not only the user's prompt text (`content`), so a
  content query matches a phrase that appears only in what the agent said.
  Every harness parser that accumulates `content` for FTS MUST accumulate
  `assistant` the same way, reusing that harness's existing meta/wrapper/
  interrupt filters. `assistant` MUST carry a lower BM25 weight than `content`
  (`BM25_WEIGHTS`) so an equivalent user-prompt match ranks above an
  assistant-only match for the same term. `ftsSearch`'s FTS5-tier result MUST
  include a short `snippet()` excerpt (auto-selected best-matching column) and
  `searchContentIndex` MUST carry it onto the hydrated `SessionMeta.snippet`;
  unlike `_matchedTerms`/`_bm25Score`, `snippet` MUST NOT be stripped from
  `--json` output. A stored `scan_ledger.extractor_version` below the current
  `CONTENT_INDEX_VERSION` MUST be treated as changed by the change-detector
  (`filterChangedEntries`) independent of (mtime, size), and a Claude/Codex
  resumable continuation recorded at an older extractor version MUST be
  refused (forcing one full re-parse) rather than resumed from — the lever
  that backfills `assistant` into every already-indexed session without a
  destructive `DELETE FROM scan_ledger`. A schema migration that changes
  `session_text`'s column set MUST preserve every existing row's
  label/topic/project/content across the rebuild, not discard the whole FTS
  index
  (`lib/session/db.ts` `CONTENT_INDEX_VERSION`, `BM25_WEIGHTS`, `ftsSearch`,
  `migrateSchema` v42, `upsertSessionsBatch`, `recordScans`;
  `lib/session/discover.ts` `filterChangedEntries`, `searchContentIndex`,
  `readClaudeMeta`, `readCodexMeta`; tests
  `discover.assistant-content.test.ts`).
- **SES-31 (MUST).** Tool-call evidence MUST be redacted before persistence and
  bounded to 16 KiB input, 1 KiB successful output, or 4 KiB error output.
  Raw evidence and shell source MUST be bounded to 64 KiB before redaction or
  AST parsing.
  The combined evidence payload MUST be capped at 5 MiB per session and MUST
  leave an explicit terminal row when additional calls are omitted.
  `--no-redact` MUST NOT disable index redaction. Outcomes and exit/status/error
  codes MUST come from structured harness fields, never free-text inference
  (`lib/session/tool-calls.ts:6-16,69-96,177-305,319-408,486-526`).
- **SES-32 (MUST).** A changed Claude/Codex transcript MUST derive tool calls in
  the same resumable reducer and preserve pending native call identity across an
  append. Adding accumulator state MUST bump the continuation version; a prior
  shape without tool-call state MUST force one full reparse before append-mode
  persistence. Each appended JSONL record MUST be processed within a fixed
  bound; a record over 1 MiB MUST be skipped without retaining the rest of the
  file in memory.
  Other harnesses MUST derive calls from the same normalized event parse
  used for metadata. A warm compatible ledger row MUST NOT reopen or Bash-parse
  the transcript
  (`lib/session/discover.ts:3042-3044,3270-3364,3434-3468,3568-3573`;
  `lib/session/discover.ts:3667-3669,3846-3926,3969-3992,4086-4091`;
  `lib/session/db.ts:1297-1307`; `lib/session/tool-index.ts:211-290`).
- **SES-33 (MUST).** Repeated tool query clauses MUST be satisfied by distinct
  call rows in the same session using polynomial bipartite matching. A request
  MUST be bounded to 32 clauses, 4 KiB per clause, and 50,000 materialized call
  rows. `--limit` MUST be bounded to 1–1,000 sessions and aggregate materialized
  call evidence MUST be bounded to 8 MiB. The JSON encoding MUST be bounded to
  15 MiB so a valid result remains below the fleet transport ceiling. Indexed
  program/status/exit columns and FTS5 MUST prefilter candidates
  before the exact assignment
  (`lib/session/tool-index.ts:30-36,386-578,682-755`).
- **SES-34 (MUST).** Schema v29's session-id-keyed `tool_scan_ledger` MUST be independent of the
  normal session ledgers. Migration MUST clear only the derived tool ledger and
  MUST NOT clear `scan_ledger` or `dir_ledger`. Historical parsing MUST run only
  through explicit `agents sessions backfill tools`, in internal batches bounded
  to 25 files or 16 MiB. Fleet backfill MUST advance devices concurrently in
  bounded rounds; a peer invocation MUST process at most one batch before
  returning its coverage. A tool query MUST read the SQLite snapshot and coverage
  rows without calling `ensureToolIndex`, statting a transcript, or parsing it.
  Oversized Claude/Codex JSONL MUST stream with a 1 MiB record
  cap up to a 64 MiB source ceiling; larger sources MUST persist an explicit
  limit row without reading the body. Other harness parsers MUST NOT materialize
  a source over 16 MiB. Append
  persistence MUST use ledger byte totals and read only changed ordinals
  (`lib/session/db.ts`; `lib/session/tool-store.ts`; `lib/session/tool-index.ts`;
  `commands/sessions-backfill.ts`; `commands/sessions.ts`).
- **SES-42 (MUST).** An `ensureToolIndex` pass over a Claude/Codex transcript that
  only grew MUST read only the bytes appended since the last pass (incremental
  discovery already appends via `toolIndexMode`; this is the backfill side).
  Schema v36's `tool_scan_ledger`
  carries a resume point — `parsed_offset`, the byte just past the last complete
  record consumed, and `parser_state`, the collector snapshot at that offset — and
  the scan MUST resume there and persist with `mode: 'append'`, leaving the
  session's already-stored call rows in place. The resume point MUST be refused,
  and the whole file re-read, when the extractor version differs, no resume point
  is recorded, the ledger's source path does not match, or the file is shorter
  than what was already parsed. A record with no trailing newline MUST be indexed
  but MUST NOT advance `parsed_offset`, so re-reading it next scan re-derives the
  same ordinals rather than duplicating the call. In the `ensureToolIndex`
  backfill path, harnesses parsed whole into memory record no resume point and
  stay full replaces.
  Every `tool_call_text` row MUST be addressed by the `rowid` of the `tool_calls`
  row it describes; its `call_key` is UNINDEXED, so a `call_key` predicate scans
  the entire index once per call.
  The scan path MUST also perform bounded, threshold-gated FTS compaction
  (`maintainSessionSearchIndex`) so index health does not depend on a human
  running `agents sessions optimize`
  (`lib/session/tool-index.ts`; `lib/session/tool-store.ts`; `lib/session/db.ts`).
- **SES-42b (MUST).** The daemon warm-tick indexer (`upsertSessionsBatch`) MUST NOT
  re-derive a changed full-file-harness session's whole tool history on every
  tick. A changed session is re-parsed for metadata, but its tool calls MUST be
  derived incrementally: the tool ledger records how many normalized events were
  folded (`parsed_offset`, reused as an EVENT COUNT for full-file harnesses, not a
  byte offset) plus the collector snapshot (`parser_state`), and a later scan of
  the same append-only stream MUST fold only events at or after that count and
  persist with `mode: 'append'` (`planEventToolResume` in `lib/session/tool-store.ts`,
  `scanEventToolCalls` in `lib/session/tool-calls.ts`). The resume point MUST be
  refused — forcing one full replace from event 0 — when the extractor version
  differs, no resume point is recorded, the ledger's source path does not match,
  the tool source shrank below the recorded size, or more events were folded than
  the file now yields (a rewrite, not an append). The incremental index MUST equal
  a full re-parse of the same final transcript. claude/codex are unaffected: their
  warm-tick resume rides the content-scan ledger's byte offset (SES-42), so they
  record no event-count resume point here. This closes the O(session)-per-tick
  synchronous cost that blocked the daemon event loop and starved browser IPC
  (PHNX-3411) (`lib/session/db.ts`; `lib/session/tool-store.ts`; `lib/session/tool-calls.ts`).
- **SES-35 (MUST).** Fleet tool search MUST cap each peer's stdout at 16 MiB,
  query at most six peers concurrently, and subtract the exact encoded local
  envelope plus 64 KiB of coordinator headroom from the 15 MiB aggregate receive
  ceiling before retaining peer bytes. Raw peer bytes and the validated,
  re-redacted envelope MUST each be charged against that remainder, because
  redaction may expand evidence. It MUST mark partial coverage when exhausted
  and MUST validate every versioned envelope field, strip terminal controls, and
  omit transcript paths before merging. A missing transcript MUST purge its call
  rows, program rows, FTS rows, and tool ledger when the source directory changes,
  without statting every indexed session.
  Fleet evidence queries MUST use a direct SSH connection and have a 60-second
  deadline. Queries MUST NOT perform remote indexing. Fleet counts MUST transfer
  only validated aggregate totals and per-machine coverage. During fleet
  fan-out, every peer MUST query only sessions whose recorded origin is that
  peer, so synced mirror transcripts cannot duplicate evidence or totals.
  Evidence MUST retain the recorded transcript origin across the SSH hop, and
  the coordinator MUST deduplicate the same origin/session pair. Direct local
  queries MAY include mirrored rows under their recorded origin machines.
  An unreachable or incompatible peer MUST also mark aggregate coverage partial
  (`lib/session/remote/remote-list.ts:50-53,78-96,193-240,337-541`;
  `lib/devices/resolve-target.ts:120-133`;
  `lib/session/tool-index.ts:73-97`; `lib/session/tool-store.ts:40-85`;
  `commands/sessions.ts:1937-1984`).
- **SES-36 (MUST).** The shell-command sampling script MUST accept 50–100
  sessions, read the current device directly, balance deterministic selection
  across available requested machines, retain only redacted shell-call origins
  and classifications, bound each candidate query to at most twice the requested
  sample size, retain successful candidate classes when another class exceeds
  its evidence envelope, retain the last successful partial pass when a later
  pass fails, report every failed class and source as partial coverage, cap its
  JSON artifact at 16 MiB, and record
  `sample_byte_limit` with partial coverage instead of silently dropping evidence
  (`scripts/sample-session-shell-commands.ts:17-25,82-136,149-256,308-402,404-479`).
- **SES-37 (MUST).** Static Bash extraction MUST retain every statically
  identifiable program site in transcript order, including repeated programs
  within one tool call. It MUST classify wrapper chains as `wrapper` and their
  final static target as `effective`; dynamic program names MUST be omitted.
  Harness wrappers that carry orchestration code MUST be parsed statically to
  select literal shell-command fields and MUST NOT be evaluated; unrelated
  wrapper tokens MUST NOT become program occurrences.
  `--count` MUST accept exactly one `program:<name>` clause and return occurrence,
  containing-call, and distinct-session totals over the full filtered scope.
  It MUST label incomplete coverage as a lower bound. Counting MUST query
  `tool_program_occurrences` and MUST NOT open or reparse transcripts. The
  implementation MUST use relational SQLite rows and literal FTS5 only; it MUST
  NOT use embeddings, a vector database, semantic search, or model calls
  (`lib/session/shell-programs.ts`; `lib/session/tool-store.ts`;
  `lib/session/tool-index.ts`; `commands/sessions.ts`).
- **SES-38 (MUST).** `sessions focus` MUST use the session browser's canonical
  candidate/filter pipeline for selector-driven focus. A unique session id or
  prefix MAY focus directly; an agent/version or text selector MUST show the
  preview picker even when exactly one row matches. Agent version aliases
  `latest` and `oldest` MUST resolve on each queried device, not on the caller.
  Device, project/time, team/routine, skill/plugin, bookmarks, and live-state
  flags MUST compose, and several live states MUST form the same OR-union as
  `sessions --active` (`commands/sessions-browser.ts` `BrowserFilter`,
  `collectSessionCandidates`, `applyFilters`; `commands/focus.ts` `focusAction`;
  tests `commands/sessions-browser.test.ts`, `commands/focus.test.ts`).
  Bare `--active` MUST exclude terminally-dead rows retained by the live registry;
  explicit `--closed` / `--crashed` filters MUST remain able to select those rows.
  A per-device `latest` / `oldest` query MUST NOT admit an unindexed live row whose
  version was not part of the peer's filtered result.
- **SES-38a (MUST).** In the shared interactive session browser, `*` MUST toggle
  the selected row's bookmark, `b` MUST toggle the bookmark-only filter, and `f`
  MUST submit the selected row through the same attach/recover decision as
  `sessions focus`. Enter MUST retain its resume behavior. These bindings MUST
  apply to every preview rendered by that browser: ordinary listings, active
  `--teams`, named `--in-team` views (with or without `--teams`), and routine
  listings. The bare grouped `--teams` report MUST remain non-interactive because
  its nested shape is not representable by the flat browser
  (`commands/sessions-browser.ts` `runSessionBrowser`; tests
  `lib/picker.test.ts`, `commands/sessions-browser.test.ts`,
  `commands/__tests__/sessions-team-lineage.test.ts`).
- **SES-39 (MUST).** Focus MUST query tmux `#{pane_dead}` immediately before
  attach. A dead or missing pane MUST NOT attach. Session recovery MUST run on
  the origin device and MUST choose native resume only for the exact healthy
  origin version when its active isolated home owns the indexed transcript.
  Claude native resume MUST launch from the earliest existing absolute cwd in
  that transcript, because it is the directory that selected
  `projects/<cwd-key>`; the later first-turn `SessionMeta.cwd` is not sufficient.
  When the origin version home is installed, native-capable, and still owns the
  transcript but its origin account is rate/usage-limited,
  recovery MUST first rotate to a healthy INJECTABLE (provider setup-token/API-key,
  RUSH-3182) account of the SAME harness and stay NATIVE in that origin home
  (`RecoveryAccount`, injected via `--account`); a native login in another
  isolated home MUST NOT be used for this, since it cannot authenticate a resume
  that reads the origin home's transcript. Only an absent, signed-out, revoked,
  non-native, trash-retained, backup-only, or same-number reinstalled origin — OR
  a limited origin whose transcript is not in the origin home, or that has no
  healthy injectable account — MUST select a healthy account of the same harness
  and use `/continue <id>` against the indexed transcript; it MUST NOT
  native-resume from another version home or choose another harness. When that
  `/continue` pick is a provider account, the target MUST carry `RecoveryAccount`
  and exec MUST inject it the same way native rotation does (PHNX-3674), so spawn
  MUST NOT authenticate as the exhausted origin login. The origin version MUST be recorded forward at launch
  (`AGENTS_RUN_VERSION` → SessionStart-hook sidecar → index via the row-build
  join `meta.version ?? actorRec.version` plus a write-once COALESCE, the same
  launch-metadata treatment as mode/harness/actor) so a transcript with no
  derivable version (codex's `.codex-homes/<version>/` home) still native-resumes. With no usable version it MUST fail with the device,
  origin version, and account-health reason
  (`commands/go.ts` `probeAttachRail`; `lib/tmux/session.ts` `paneExitStatus`;
  `lib/session/recovery.ts`; `commands/exec.ts`; tests
  `lib/session/recovery.test.ts`, `commands/focus.test.ts`).
- **SES-40 (MUST).** Focus, single and multi-session resume, attach, and both
  concrete-id and picker forms of `run --resume` MUST route through SES-39's one
  origin-device recovery decision, preferring the origin device. When that origin
  device is genuinely unreachable, single-session resume MAY fall back to a
  clearly-announced local `/continue` replay from the synced mirror
  (`resumeLocalFallbackSource` rewrites `machine` to self); it MUST NOT do so
  silently, and MUST NOT fall back while the origin is reachable (RUSH-2022). A
  host-dispatched session row MUST persist the dispatch host as `machine`. Cross-device attach MUST route before reading
  the detach record or stopping its headless PID, because both are local to the
  origin (`lib/hosts/session-index.ts`; `commands/attach.ts`; `commands/exec.ts`;
  tests `lib/hosts/session-index.test.ts`, `commands/attach.test.ts`).
- **SES-43 (MUST, RUSH-2336).** Every bare-active surface — the CLI's grouped
  table and `--json` (`renderActiveSessions`), the interactive browser's
  `--active` filter (`applyFilters`), `focus`'s attach gate
  (`isAttachableLiveSession`), and the menubar snapshot
  (`computeMenubarSnapshot`) — MUST share ONE canonical selector
  (`isRunningLiveSession`, `commands/sessions.ts`), refining SES-38's
  "terminally-dead rows" exclusion:
  - `queued`, `closed`, and `crashed` rows MUST be excluded — queued has not
    started, closed/crashed are unconditionally dead — reachable only through
    the explicit `--queued`/`--closed`/`--crashed` filter (`matchesLiveStatus`).
  - A `context: 'cloud'` row MUST be selected on the provider's own word alone
    (`cloudProvider` AND `cloudTaskId` both present), asserting no local `pid`.
  - Every other row (terminal/tmux/headless/team) MUST be selected only when it
    names its owning `machine`, carries a positive `pid`, AND has
    `pidAlive === true` — POSITIVELY verified liveness, not merely "not known
    dead". A live `orphaned` row and a live-but-stuck `abandoned` row remain
    selected under this rule (both carry a genuinely alive pid); a row of
    unknown liveness (an older peer's payload, or an unresolved pid) MUST NOT.
  - Every process-backed row the bare `--active` JSON emits MUST therefore
    carry `machine`, a positive `pid`, and `pidAlive: true`; the human CLI row
    MUST render a matching `machine:pid` locator (`locatorBadge`), or
    `provider · taskId` for a cloud row — width-safe at every terminal width.
  - The menubar snapshot reads the RAW active-session cache, which is never
    filtered at write time (it retains queued/dead rows for the CLI's explicit
    filters) and whose daemon warm-tick gather does not stamp `machine` on a
    local row; `computeMenubarSnapshot` MUST self-stamp `machine` (this scope
    IS the local machine by construction) before applying the selector, so a
    real local process is never dropped for a field only the CLI's own gather
    normally fills in.

  (`commands/sessions.ts` `isRunningLiveSession`, `locatorBadge`,
  `renderActiveRowLines`; `commands/sessions-browser.ts` `applyFilters`;
  `commands/focus.ts` `isAttachableLiveSession`; `lib/menubar/snapshot.ts`
  `computeMenubarSnapshot`; tests `commands/sessions.cli-live.test.ts`,
  `commands/sessions-browser.test.ts`, `commands/focus.test.ts`,
  `commands/sessions.active-row.test.ts`, `lib/menubar/snapshot.test.ts`).

---

### 4. Interface contract

#### 4.1 Command surface

The command surface (bare `sessions [query]`, `preview`, `tail`, `resume`, `detach`,
`inject`, `export`, `render`, `import`, `migrate`/`relocate`, `migrations`,
`backfill tools`/`backfill resources`, `fork`, `bookmark`, `stats`, `insights`,
`optimize`, `watch`) with flags is the reference in
[sessions.md](sessions.md); this spec governs the guarantees behind it.

#### 4.2 Machine-readable output (STABLE — agents depend on these)

- **SES-IF-1 (MUST).** `sessions --json` (listing) MUST emit a JSON **array** of
  `SessionMeta` (`serializeSessionsJson`, `commands/sessions.ts:695-701,1272`);
  `sessions <id> --json` MUST emit `{ session, events }` (a bare event array is
  the pre-1.20.51 shape — consumers read `output.events`,
  [sessions.md](sessions.md):142-147). The fleet browser itself shells peers
  with `sessions --all --json --limit 500` (`commands/sessions-browser.ts:219`),
  so the array shape is load-bearing across the fleet.
- **SES-IF-2 (MUST).** `sessions --active --json` MUST emit `ActiveSession[]` with
  `ticketId`/`project`/`prLink` always present as keys (test
  `sessions.serialize.test.ts:76-115`); `tail --json` MUST pass raw JSONL through
  one event per line (`commands/sessions-tail.ts:229-232`); `inject --json` and
  `migrations --json` emit their documented shapes.
- **SES-IF-2a (MUST).** `sessions --resolve <selector> --json` MUST resolve a full
  id, unique id prefix, or keyword query from indexed `SessionMeta` rows without
  parsing or rendering transcript events. It MUST search the online fleet unless
  `--local` is set; `--agent` and `--project` MUST narrow every peer. Exactly one
  logical session MUST emit a one-element safe metadata array containing only
  `id`, `shortId`, `agent`, `origin`, `timestamp`, `lastActivity`, `project`,
  `version`, `label`, `topic`, and `machine`; transcript-local fields including
  `filePath` and `plan` MUST NOT leave the owning machine. Synced copies sharing
  the same full id MUST count as one logical session. A missing selector or more
  than one logical match or an empty selector MUST emit no JSON, list the
  failure/ambiguity on stderr, and exit 1; ambiguity MUST include every matching
  full id and machine. Fleet peers MUST receive the versioned `--resolve-safe-v1`
  protocol so an older unsafe peer rejects before serializing a row. An incomplete
  peer sweep (including malformed successful output, device-registry failure, or an
  older peer rejecting that protocol) MUST emit no JSON, MUST NOT decide
  unique/no-match from partial rows, and MUST warn with the failed source(s) on
  stderr and exit 1 as a degraded not-found-on-the-reachable-fleet result, not a
  hard abort — **except** for the SES-9a case, where a selector that is a complete id
  or at least 8 hex characters wide and matches exactly one session on the
  reachable fleet MUST resolve and emit its row; a keyword, a shorter selector, or
  a label still MUST NOT be decided from partial rows
  (`commands/sessions.ts` `serializeResolvedSessionsJson`, `resolveSessionMetadata`,
  `metadataResolveOutcome`, `fleetCandidatesByQuery`,
  `metadataResolveForwardedArgs`; tests
  `commands/sessions.resolve.test.ts`, `commands/sessions.resolve-errors.test.ts`,
  `lib/session/remote/remote-list.test.ts`).

  *Amended 2026-08-10 (RUSH-2492).* This requirement previously mandated exit 2
  for an incomplete peer sweep, aborting `--resolve` outright whenever any peer
  was malformed, protocol-incompatible, or unreachable — even when the session in
  question lived on a perfectly reachable device. `attach`/`focus`/`resume`/`run
  --resume` hit the same abort through the shared resolver. It now degrades to a
  warning and exit 1, matching `sessions --resolve`'s existing not-found exit
  code, so a genuinely offline or misbehaving peer no longer blocks resolving a
  session that IS reachable.
- **SES-IF-2b (MUST).** A positional query that exactly names an installed
  `<agent>@<version>` MUST route to the same structured agent/version filter as
  `--agent <agent@version>`. An uninstalled, unknown, or malformed pair MUST
  remain ordinary free text. `--agent <agent> --version <version>` MUST be
  equivalent to `--agent <agent@version>`; `--version` without `--agent` MUST
  fail loudly (`commands/sessions.ts` `parseInstalledAgentVersionQuery`,
  `applyVersionFilters`; tests `commands/sessions.test.ts`,
  `commands/sessions.cli-list.test.ts`).
- **SES-IF-3 (MUST).** The export **bundle format** is NDJSON, `kind`
  `agents-session-bundle`, `version` 1; parse MUST reject a wrong kind/version;
  per-record `hash`/`size` are always over **plaintext** for byte-exact dedup;
  bundle files are written `0600` (`lib/session/bundle.ts:28-29,110-113,188-227`).
- **SES-IF-4 (MUST).** `SessionEvent.type` is a **closed union** of the 9 documented
  types (`lib/session/types.ts:17-41`); a parser MUST NOT introduce a tenth.
- **SES-IF-4a (MUST).** Broad `sessions --include tools --json` MUST emit the
  versioned tool-search envelope, while ordinary list JSON remains
  `SessionMeta[]` and exact-session JSON remains `{ session, events }`. Repeated
  `--query` clauses require distinct calls. `--fleet` MUST execute the query on
  each device's local index under the recursion guard and transfer compact
  evidence only. A fleet tool query MUST reject cost/duration sorting because
  the compact peer envelope carries no global sort key. `--markdown` and
  `--no-redact` MUST fail when combined with `--include tools` because the
  indexed evidence schema is always bounded and redacted. `--count` MUST emit
  the versioned `tool-program-count` aggregate with occurrence, call, session,
  coverage, and per-machine totals; it MUST NOT replace ordinary list/detail or
  tool-search envelopes
  (`commands/sessions.ts:1432-1463,1551-1559,1824-1879,1937-1984,3929-3970,4006-4013`;
  `lib/session/remote/remote-list.ts:98-115,337-541`).
- **SES-IF-4b (MUST).** `sessions stats --json` MUST emit its own versioned
  `sessions-stats` envelope (`{ schemaVersion, kind: 'sessions-stats', filters,
  signal, coverage, totals, order, ranked[], zeroInvoked[] }`), never the
  `SessionMeta[]` list or `{ session, events }` detail shape. `ranked` is the
  resource rollup ordered by invocation volume (`--bottom` reverses, `--top <n>`
  caps); `zeroInvoked` is the installed-but-never-invoked set. The rollup MUST
  count each resource identity (kind + name) once — merging source layers — and
  MUST record only EXPLICIT invocations (slash commands + `Skill` tool calls), so
  an auto-triggered skill reads as 0 (skill invocations come from Claude + Kimi,
  slash-commands from Claude only); the envelope's `signal` field states this and
  its `signal.recording` field names the recorded set so a zero is not over-read.
  The `coverage` object MUST distinguish SCAN coverage from with-usage coverage:
  `sessionsScanned` counts sessions carrying a `resource_scan_ledger` row at the
  current `RESOURCE_INDEX_VERSION` (the "has the backfill run" signal, which
  reaches ~`sessionsIndexed` after a full backfill because the ledger is stamped
  for every scanned session, incl. zero-usage ones), while `sessionsWithUsage`
  stays the ABSOLUTE count of sessions with ≥1 explicit invocation — the
  backfill hint keys on `sessionsScanned/sessionsIndexed`, never on
  `sessionsWithUsage`, which is sparse by nature and would nag forever (PHNX-2301).
  `sessions backfill resources --json` MUST emit the versioned
  `resources-backfill` envelope and populate `session_resource_usage` for
  historical sessions gated by `resource_scan_ledger`, never silently re-scanning
  a transcript already current at `RESOURCE_INDEX_VERSION`
  (`commands/sessions-stats.ts`; `commands/sessions-backfill.ts`;
  `lib/session/db.ts` `queryResourceUsageStats`/`backfillResourceUsage`).
- **SES-IF-4c (MUST).** `sessions insights` and top-level `insights` MUST invoke
  the same implementation. The default report MUST be deterministic and offline,
  MUST include friction, corrections, automatable repeats, harness split, and ranked
  evidence-backed actions, and MUST NOT emit raw transcript text or full local paths.
  `--agent` MUST be repeatable. `--narrative` MAY call a coach only with aggregate
  report data (`commands/insights.ts`; `lib/session/insights.ts`).
- **SES-IF-4d (MUST).** `sessions trace` and its top-level alias `trace` MUST invoke
  the same implementation (`commands/sessions-trace.ts` `configureTraceCommand`), and
  `--json` MUST emit its own versioned envelope
  (`{ schemaVersion, kind: 'sessions-trace', layout: 'single' | 'compare', sessions:
  SessionTrajectory[], diff? }`), never the `SessionMeta[]` list or the `{ session,
  events }` render detail shape. A `SessionTrajectory` MUST carry `spanMs`, `steps[]`,
  `gaps[]`, `programTimeShare`, `errorCount`, `stats`, and `redacted` — the last
  recording whether the model was built with redaction on, so a renderer states
  the true redaction status instead of asserting one; each `TrajectoryStep` MUST
  carry `startMs`, `durationMs`, and `durationEstimated`, where per-step `durationMs`
  is **derived** by pairing a `tool_use` with its `tool_result`/`error` on `callId`
  (never persisted onto `SessionEvent` or the `tool_calls` index), and
  `durationEstimated` MUST be `true` whenever the value is the next-event fallback
  rather than a measured pairing. Concurrent same-tool calls MUST correlate strictly
  by `callId`, never by arrival order (matching `ToolCallCollector.takePending`). With
  no `--html/--text/--json`, the rendering MUST be audience-selected: HTML on a TTY,
  compact text otherwise; the HTML MUST be self-contained (no external asset) and
  redacted by default. One resolved selector renders the single-session trajectory;
  exactly two render a **compare** (`diffTrajectories()`,
  `lib/session/trajectory-compare.ts`) — the two sessions' tool-step sequences
  aligned by tool name, the first divergence point, the steps each session ran with
  no counterpart in the other, and a per-session summary, in all three renderings.
  Three or more resolved selectors, or `--tree`, MUST fail loud, never silently trace
  or compare a subset (`commands/sessions-trace.ts`; `lib/session/trajectory.ts`;
  `lib/session/trajectory-compare.ts`). Lineage (a parent + its team, `--tree`) is not
  yet implemented.
  Status: `[Intended]` for lineage — see SES-GAP-11.
- **SES-IF-4e (MUST).** `sessions trace <id> --steps` MUST print the narration-anchored
  step list from the SAME fold the session row carries (`foldTimeline` over
  `parseTimelineEvents`, so the CLI door and the cached row can never disagree),
  one line per step with its offset, source, headline and counts, plus a totals
  footer. It MUST take exactly one selector and fail loud otherwise, and MUST say
  so plainly when a harness folds to no steps rather than printing an empty list
  as if the session did nothing (PHNX-3939; `commands/sessions-trace.ts`
  `renderSessionSteps`; `commands/sessions-trace.test.ts`).

#### 4.3 stdout / stderr / exit discipline

- **SES-IF-5 (MUST).** Machine-readable output (`--json`, `--markdown`, `tail`
  stream, bundle NDJSON) goes to **stdout**; human/diagnostic/skip notes go to
  **stderr**, so piping a session is never polluted.
- **SES-IF-6 (MUST).** Exit codes are a contract: `sessions --waiting` sets exit **1**
  to signal matching (waiting-on-you) sessions exist
  (`commands/sessions.ts:905,942`); `tail` uses **2** for usage/unsupported-agent
  vs **1** for no-match (`commands/sessions-tail.ts:185,192,196`); remote
  partial-failure sets exit **1** without throwing (SES-23).

---

### 5. Cross-platform parity matrix

Discovery is rooted at `os.homedir()` on every platform. The matrix below is
normative — a change that widens/narrows a cell is a spec change.

| Behavior | macOS | Linux | Windows |
|---|---|---|---|
| Discovery & parsing (all 12 harnesses) | yes | yes | yes |
| Process table source | `ps` | `ps` | `Get-CimInstance Win32_Process` (`active.ts:793-799`) |
| PID-reuse start-time guard | yes | yes | **no** — bare existence (`active.ts:299-300`) |
| Live-process provenance | `ps eww` | `/proc/<pid>/environ` | **none** (`provenance.ts:196-217`) |
| cwd of a live process | `lsof` | `lsof`/`/proc` | pid-registry only (no `lsof`, `active.ts:856-858`) |
| Codex home relocation (SUN_LEN socket) | yes (`lib/codex-home.ts` ~`:64-70`) | n/a | n/a |
| Foreign-absolute-cwd drive rebase | n/a | n/a | **prohibited** (SES-6) |
| Remote shell for `--device` | `bash -lc` | `bash -lc` | PowerShell (`lib/session/remote/remote.ts:117-121`) |

- **SES-CROSS-1 (MUST).** All three desktop platforms MUST be supported for discovery,
  parsing, listing, and `--device`. Windows-specific gaps (no provenance, no
  start-time reuse guard) are documented deviations, not silent behavior.

---

### 6. Compatibility & stability guarantees

- **SES-COMPAT-1 (MUST).** The `--json` listing array shape and `<id> --json`
  `{ session, events }` shape MUST NOT change incompatibly without a version note;
  additive fields are allowed (SES-IF-1).
- **SES-COMPAT-2 (MUST).** `SessionEvent.type` (the 9-value union) and the export
  bundle `kind`/`version` MUST remain backward-compatible; a bundle producer that
  bumps `version` MUST keep the parser rejecting unknown versions loudly (SES-IF-3/SES-IF-4).
- **SES-COMPAT-3 (MUST).** Schema migrations MUST be forward-only and lossless
  (SES-29), and a CLI that opens a DB written by a newer CLI MUST fail safe
  rather than proceed (`lib/session/db.ts` schema gate ~`:453-461`).

  Status: `[Intended]` — no `currentVersion > SCHEMA_VERSION` guard exists yet,
  so the fail-safe half is unenforced; the shortfall is SES-GAP-8.
- **SES-COMPAT-4 (MUST).** On the streaming path, `--device` forwards every other flag
  verbatim to the peer's same-version binary; the SSH target MUST stay validated
  against `SSH_TARGET_RE` to block argv-flag smuggling
  ([sessions.md](sessions.md):277). The interactive one-host browser
  (SES-22) is the documented exception: it asks each peer a fixed
  `sessions --all --json --limit 500` (plus `--since`/`--teams`), so `--limit`,
  `--unmanaged`, and `--no-live` do not reach the peer there
  (`commands/sessions-browser.ts` `fetchRawPool`).

---

### 7. Non-goals & known gaps

**Non-goals (by design):**
- Not a transcript **writer** — sessions are produced by the harnesses +
  `packages/session-tracker`; this tool only reads/indexes/renders.
- No identity layer beyond SSH: "if you can `ssh <host>`, you own the box"
  ([sessions.md](sessions.md):277-278).

**Known gaps (implemented-vs-intended drift to fix, not to hide):**
- **SES-GAP-9c.** SES-9c's bounded wait is taken by the id cold-miss repair
  (`commands/sessions.ts` ~`:2287`) and by nothing else. `richMetaById`
  (`commands/focus.ts` ~`:922`) is an id repair by its own docstring and does not
  take it, so a `focus <id>` that collides with the daemon's scan reads the
  pre-scan snapshot, misses, and falls back to a row carrying no `version` — a
  non-version-pinned resume. `openFocusTabs` (`commands/focus.ts` ~`:828`) is the
  same class. The selector paths in `renderOneSession` /
  `renderArtifactsGlobal` do not take it either. Widening the wait to those sites
  is **not** a drop-in: they are not gated on a miss, so the cost would be
  unconditional, and `WAIT_FOR_SCAN_TIMEOUT_MS` (2s, `session/discover.ts`) is
  below a measured real scan hold (~3s on a 1.07 GB index), so a collision can pay
  the full bound and still read the pre-scan snapshot —
  `waitForScanToSettle`'s `false` return is discarded. Closing this means gating
  on an actual miss AND either raising the bound past a realistic scan or acting
  on that `false`. Raised by the RUSH-2691 review.
- **SES-GAP-1.** `flatSessionRow` (`--flat`) and the picker's `formatPickerLabel`
  both feed `renderTopicCell` (~`commands/sessions.ts:1500`, `:2071` →
  `:1862`) without the `'-'` fallback the other renderers use, so a session with
  no live preview, no tag, and an empty `topic` renders a **blank** cell —
  untested. Directly contradicts "always show a preview" (SES-8).
- **SES-GAP-2.** Metadata coverage is uneven. PR/ticket extractors are agent-agnostic
  (`lib/session/state.ts` ~`:332-358`) but the live path forces non-Codex→Claude
  (`lib/session/active.ts` ~`:541-546`), so signals are effectively claude/codex
  only. And **`costUsd` is populated by no harness in the session pipeline** — it
  is an unset schema slot (`lib/session/db.ts` writes `meta.costUsd ?? null`;
  nothing sets it); real cost accounting lives in the separate budget ledger
  (`lib/budget/ledger.ts`). If per-harness metadata parity is the intended
  contract (SES-16), this is the break.
- **SES-GAP-3.** No `model` and no `repo`/git-remote field is persisted on
  `SessionMeta` — only transient `SessionEvent.model` and `gitBranch`/`worktreeSlug`
  (`lib/session/types.ts:32,105,135`). Surfacing either needs a schema addition.
- **SES-GAP-4.** `opencode` has a reserved `SYNC_AGENTS` slot but SQLite→JSONL export
  is **not implemented** (`lib/session/sync/agents.ts:130-138`) — opencode
  sessions are not included in `agents sessions export` today.
- **SES-GAP-5.** `dedupeBySession` runs only over local sources, never across the
  local↔remote seam; a session surfacing both locally and via a peer's self-report
  is not provably collapsed and is untested
  (`lib/session/active.ts:1324` vs `remote-active.ts:43-47`).
  - **Narrowed (RUSH-2479).** The one case that is now provably collapsed is the
    offloaded run, whose dispatcher shim and executing machine's own row share a
    `machine:sessionId` key once SES-23a attributes both to the execution host.
    `dedupeByMachineSession` MUST keep the row that is not an offload shim
    (`offloadedFrom` unset), so the merged fleet view never trades a real
    transcript for a `[host/<peer>]` placeholder. The general seam is still open.
- **SES-GAP-6.** Whole-**file** JSON parse failure is inconsistent: Gemini throws
  (and `parseSession` has no outer catch), while Hermes/Antigravity degrade to
  `[]` (`lib/session/parse.ts:143-169,691-696`). Standardize on degrade-to-empty.
- **SES-GAP-7 (resolved).** [sessions.md](sessions.md) once hardcoded schema
  version 13 while the code had moved on; it now cites the `SCHEMA_VERSION`
  constant directly ([sessions.md](sessions.md):1184), and
  `lib/session/db.ts`'s header comment carries the real path
  (`~/.agents/.history/sessions/sessions.db`). The standing rule is the point: any
  hardcoded schema number in prose drifts — cite the constant.
- **SES-GAP-8.** No `currentVersion > SCHEMA_VERSION` guard exists (SES-COMPAT-3): an
  older CLI opening a DB written by a newer one silently proceeds instead of
  failing safe (`lib/session/db.ts` schema gate). The "fail safe on newer DB"
  guarantee is aspirational until a guard is added.
- **SES-GAP-9.** The archived-vs-phantom discriminator (SES-47) is *content
  presence*, not supersession detection. A file-gone row keeps `archived` iff its
  `session_text` content is non-empty; there is no signal for "this session's
  content now lives under another current row." For real harnesses this is a
  non-issue (the id is content-derived, so a rename rewrites `file_path` on the one
  row), but a synthetic harness that keys the id off the filename would surface a
  renamed session's old id as an archived duplicate. Closing it needs a
  supersession signal from the scanner (out of the Layer-1 read-path scope).
  Relatedly, the tool-index **backfill** path still purges an archived session's
  evidence when its source file is gone mid-backfill (`tool-index.ts`
  `ensureToolIndex` on a `statSync` throw, reached via `agents sessions backfill`);
  SES-47 removed the purge only from the `querySessions` read path.
- **SES-GAP-10 (resolved, RUSH-2486).** SES-23a's execution-host attribution now
  covers **remote teams teammates** as well as host-dispatched runs. A
  `agents teams add … --device <peer>` teammate still gets no index row, so
  `listTeamsActive` (`lib/session/active.ts`) folds the teammate record's own
  `AgentProcess.hostName` into `machine` + `offloadedFrom` directly — the same
  shape `foldExecutionMachine` gives a `run --device` row — so the orchestrator's
  self-stamp no longer claims a teammate executing on a peer. The sibling
  false-ambiguous resume (the empty-file index row's recorded machine being
  clobbered by the path derivation in `queryIndexedSessions`) is fixed in the
  same change; see the SES-23a "pool listing agrees with the live view" bullet.
- **SES-GAP-11.** `sessions trace --tree` (lineage: a parent + its team, drawn as a
  node graph over `enrichTeamOrigins`/`groupSessionsByTeam`) is not implemented —
  passing `--tree`, or three or more resolved selectors, fails loud rather than
  rendering anything (SES-IF-4d). The single-session trajectory and the two-session
  compare are both implemented.
---

### 8. Given/When/Then scenarios

**GWT-1 — Codex transcript discovered with correct harness + metadata.**
Given a Codex JSONL at `~/.codex/sessions/**` with a `session_meta` line and
per-turn `turn_context` lines; When `agents sessions` runs; Then it appears with
`agent='codex'`, cwd/gitBranch from `session_meta`, `model` from `session_meta`
falling back to `turn_context`, and `tokenCount` from the last cumulative snapshot
priced once (`discover.ts:3477-3526`, `discover.ts:4242-4253`).

**GWT-2 — Live copy beats backup mirror.**
Given the same session id in the live root and a `backups/<agent>/<ts>/` mirror;
When both change in one scan; Then the indexed `file_path` is the live path
(`discover.ts:1122-1131`; test `discover.dir-ledger.test.ts:298-321`).

**GWT-3 — Malformed line tolerated.**
Given a Claude JSONL whose 3rd line is invalid JSON; When parsed; Then line 3 is
skipped, the rest still parse, and the scan does not throw (`parse.ts:292-298`).

**GWT-4 — Streaming append, no double-count.**
Given a Codex transcript whose last record is written bytes-then-newline across
two scans; When scanned mid-write then after the newline lands; Then the record
counts exactly once (`discover.ts:3705-3744`).

**GWT-5 — Live session shows its current turn as the preview.**
Given a running Claude session mid-checklist (6 of 8 done); When its row renders;
Then the preview shows `Plan 6/8: <in-progress step>` with a `●` glyph
(`parse.ts:226-235`; `commands/sessions.ts:394`) — not the static topic. (Note:
the live-row checklist string is `Plan N/M: <item>`, not `✓N/M`.)

**GWT-6 — Idle session falls back to first-prompt topic; never blank (except the
`--flat` gap).**
Given a non-live indexed session with no live preview; When rendered via
`--active` / overview / tree; Then the cell is `topic`, or `'-'` if topic is
absent (`commands/sessions.ts:355,485,1447`); **but** via `--flat` with a
noise-only first prompt the cell is blank today — the SES-GAP-1 violation.

**GWT-7 — "Where it started" spans three axes.**
Given a live SSH-launched session with a pid; When metadata is enriched; Then
`cwd` gives the launch dir, `provenance` gives `host`/`transport:'ssh'`/`ssh` IPs
from `/proc/<pid>/environ`, and `context` gives the launch context — no single
`origin` field carries all three (`discover.ts:2892`; `provenance.ts:225-230`;
`active.ts:76,1352-1358`).

**GWT-8 — An encrypted export round-trips on another machine.**
Given a machine with `R2_SYNC_ENC_KEY` set in its `r2.backups` bundle; When it
runs `agents sessions export --encrypt -o b.bundle`; Then every record body is
an AES-256-GCM envelope, and a peer holding the same `r2.backups` bundle can
`agents sessions import b.bundle` and decrypt without passing `--decrypt`
(`sessions-export.ts:431-444`; `bundle.ts:124`; `transcript-crypto.ts:82-96`).
A peer without that bundle must pass the printed ephemeral key explicitly
(`sessions-import.ts:294-315`).

**GWT-9 — Remote fan-out degrades, never blanks.**
Given 3 fleet hosts, one unreachable (ssh 255) and one slow past budget; When
`agents sessions --active` fans out; Then reachable hosts return, the unreachable
host replays offline cache, the slow host is killed to `[]`, and overall
`process.exitCode=1` — no throw, no empty result (`lib/session/remote/remote.ts:141-146,220-261`;
`lib/session/remote/remote-list.ts:88-108`).

**GWT-10 — Old DB auto-migrates without data loss.**
Given a v9 `sessions.db` with a `name` column and rows; When `getDB()` opens it;
Then schema reaches the current version, `name` folds into `label` then drops, and every prior row
survives searchable (`db.migrate-v10.test.ts:78-93`; `db.migrate-v14.test.ts:98-106`).

**GWT-11 — Two different calls satisfy one session query.**
Given one session where a `git merge` call ran and a later `gh` call returned
`CONFLICT`; When two `--query` clauses name those facts; Then the versioned
response contains that session and the two distinct call ids. Repeating the
`program:git` clause twice with only one matching call returns no session
(`lib/session/tool-index.test.ts`).

**GWT-12 — Tool query remains DB-only when the transcript is unavailable.**
Given a transcript was indexed and its source is then moved offline; When a tool
query runs; Then the ledger reports complete coverage and cached SQL/FTS evidence
answers it without opening the source (`lib/session/tool-index.test.ts`).

**GWT-13 — Repeated static sites count separately.**
Given one Bash call contains `git status; git diff`; When
`--query program:git --count` runs; Then it reports 2 occurrences, 1 containing
tool call, and 1 distinct session (`lib/session/tool-index.test.ts`;
`commands/sessions.cli-tools.test.ts`).

**GWT-14 — A retained dead pane recovers.**
Given a session whose tmux pane remains after the harness exited with status 0;
When `agents sessions focus <id>` runs; Then focus observes `pane_dead=1`, does
not attach the pane, and invokes centralized session recovery
(`commands/focus.test.ts`; `lib/tmux/session.test.ts`).

**GWT-15 — A removed origin version continues on the same harness.**
Given a Claude session from version 2.1.187, that version is absent, and healthy
Claude 2.1.218 is installed on the origin device; When the session recovers;
Then the target is `claude@2.1.218` in `/continue` mode, never native resume and
never another harness (`lib/session/recovery.test.ts`).

**GWT-16 — A cross-device attach stops the origin continuation.**
Given a detached session indexed on another device; When `agents sessions attach
<id>` runs; Then the whole attach command executes on the indexed origin before
it reads the detach record, stops the headless PID, or invokes recovery
(`commands/attach.ts`; `commands/attach.test.ts`).

**GWT-17 — Claude native resume uses the project-key cwd.**
Given a healthy Claude origin home owns a transcript whose attachment envelope
records cwd A before its first user turn records cwd B; When the session recovers;
Then native resume launches from A. Given the transcript is retained outside the
active origin home instead; Then the same healthy harness/version uses
`/continue`, never native resume (`lib/session/recovery.test.ts`).

**GWT-18 — Content search returns an FTS hit missing from the listing pool.**
Given an indexed transcript whose user turns contain `tmux pane` and a listing
pool that does not include that session (empty, or filled with an unrelated
recent row); When `searchContentIndex` / `filterSessionsByQuery` run that
phrase; Then the indexed session is in the result, with `_matchedTerms`
covering the query tokens (`lib/session/discover.search-content.test.ts`).

**GWT-19 — Content-search union does not undo `--project` / `--agent`.**
Given two indexed transcripts whose bodies both match `scoped search`, one in
project `agents-cli` and one in another project; When
`filterSessionsByQuery` / `sessions --project agents-cli "scoped search"`
runs; Then only the `agents-cli` session is in the result. The same holds for
`--agent` (`lib/session/discover.search-content.test.ts`;
`commands/sessions.render.test.ts`).

**GWT-20 — A phrase the agent said, but the user never typed, is findable.**
Given a Claude transcript whose only user turn is "why did the deploy fail"
and whose assistant reply contains "grombulator flux capacitor overheated";
When `agents sessions "grombulator flux capacitor overheated"` runs (or
`ftsSearch` is called directly); Then the session is returned — before SES-49
landed this returned zero hits despite the phrase being on disk
(`lib/session/discover.assistant-content.test.ts`).

**GWT-21 — Bumping the content extractor backfills existing sessions with no
file change.**
Given a session already indexed (its `scan_ledger` row at the current
`CONTENT_INDEX_VERSION`) whose `session_text.assistant` is then cleared and
whose ledger `extractor_version` is set back to an older value, with the
transcript file itself left byte-for-byte unchanged; When the next scan runs;
Then the session is re-extracted (same mtime/size, different stored version)
and its assistant text is searchable again, and the ledger's
`extractor_version` reads the current `CONTENT_INDEX_VERSION` afterward
(`lib/session/discover.assistant-content.test.ts`).

**GWT-22 — An idle reminder after a finished turn is not a permission request.**
Given a Claude transcript whose last meaningful event is the assistant's
"pong" to "reply with exactly: pong", followed a minute later by an
`idle_prompt` notification block the feed-publish hook wrote; When the row is
reconciled, the `attention-notify` daemon ticks, and `feed watch --json`
projects the row; Then the row reads `idle`, the reconciler yields no item, no
banner is posted, the notified ledger stays empty, and the stream emits
`attention.remove` (`lib/feed/attention.truth.test.ts`; fixtures
`lib/feed/testdata/claude-trivial-done.jsonl`, `block-idle-prompt.json`).

**GWT-23 — A real permission prompt is a permission with the harness choices
until the transcript moves past it.**
Given a Claude transcript ending in a `Bash` tool call with no result and a
`permission_prompt` block stamped 2 s after it; When reconciled; Then the item
is `permission`, keyed `<host>/<session>/<block ts>`, with `approve` /
`approve-session` / `deny`, the daemon posts exactly one such banner across two
ticks, and the stream emits `attention.upsert`. When the operator's approval
appends the tool result (stamped after the block) and the block file is left
untouched; Then the reconciler yields nothing and the stream emits
`attention.remove`; and When the operator merely dismisses the banner; Then the
record is still open ten minutes later (`lib/feed/attention.truth.test.ts`;
`claude-permission-pending.jsonl`, `block-permission-prompt.json`,
`claude-permission-approved-tail.jsonl`).

**GWT-24 — A time-based inference expires while the bytes sit still.**
Given a Claude transcript whose turn ended on a free-text question stamped
10:00:06 with the file mtime pinned just after it; When `computeLiveSignals`
runs at 10:10 and again at 10:31 with no change on disk; Then the first call is
`waiting_input` / `question` (an inferred ask with no choices) and the second is
`idle` with no item — the parsed tail is reused, the verdict is not
(`lib/session/active.livesignals.test.ts`; `lib/feed/attention.truth.test.ts`;
`claude-prose-question.jsonl`).

---

## Secrets

This is the **contract** for `agents secrets` and the boundary between
agents-cli and the standalone secrets engine (PHNX-3989) — what a human, an
agent, or a downstream tool is entitled to rely on, stated as testable
requirements — not a how-to (that is [secrets.md](secrets.md)). When code and
this spec disagree, one of them is a bug; fixing the drift is mandatory, not
optional.

Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Every requirement cites the
`file:line` that implements it, under `cli/src/` unless noted.

---

### 1. Purpose & scope, and the extraction boundary

`agents secrets` exists to **share credentials between humans and agents
safely and without noise**: a human (or agent) stashes a secret once; any
later agent run injects it into the child process that needs it, on any of
the user's machines, without the value ever landing on disk as plaintext, in
shell history, in the agent's context window, or in the session transcript —
and without a wall of prompts or output.

**The engine — storage backends, the bundle model, materialization
guarantees, prompt/noise suppression, and cross-machine transport — lives
entirely in the standalone [`phnx-labs/secrets-cli`](https://github.com/phnx-labs/secrets-cli)
repository.** That repository owns the normative contract for all of it (its
own `SEC-*`/`CTX-*`/`RPC-*` requirement families); this document does not
restate them. agents-cli reaches the engine **only** through the bounded
process client (`cli/src/lib/secrets-client.ts`, documented in
[secrets-client.md](secrets-client.md)) and never rebundles it:

- **DIST-1 (MUST).** agents-cli MUST NOT package the extracted engine. A
  missing or unreachable `secrets` executable MUST fail loud with install
  guidance (`resolveSecretsBin`, `secrets-client.ts`) — there is no fallback to
  an in-repo implementation, because none exists. Verified by a real `npm
  pack` + `tar tzf` of the produced tarball (`scripts/packed-tarball.test.ts`).
  The PATH lookup MUST NOT resolve to a `secrets` inside agents-cli's own shims
  dir (`findInPath` skips it): the pre-extraction command shim there `exec`s
  `agents secrets`, so taking it re-enters the passthrough without bound.
  Verified in `secrets-client.test.ts` (shim first on PATH, standalone after);
  the self-heal shim pass removes that legacy shim outright
  (`pruneOrphanedCommandShim`, `shims.drift.test.ts`).
- **RPC-1 (MUST).** The client MUST speak the standalone's private
  request/response protocol over inherited pipes (fd 3 in, fd 4 out),
  separate from the child's stdout, and MUST verify the protocol version via a
  handshake before the first real request (`secrets-client.ts`).
- **MIG-1 (MUST).** `SECRETS_HOME` MUST default to the user agents dir
  (`getUserAgentsDir()`, `~/.agents`) so the standalone adopts a user's
  pre-extraction store **in place** — no copy, no re-encryption. An explicit
  `SECRETS_HOME` in the caller's environment wins (`buildServeEnv`).
- **OWN-1 (MUST).** The agents-cli daemon MUST NOT host or take over the
  secrets broker. The standalone owns its own broker lifecycle exclusively;
  `agents daemon status`/`services` only probe its reachability
  (`probeSecretsBroker`, `commands/daemon.ts`) and report a health record of
  `null` for it, never a daemon-recorded one.
- **CTX-1 (MUST).** agents-cli MUST compute and forward its own access policy
  as an opaque `SecretsContext` on every bounded client call; the client
  itself only carries what the caller supplies, never computes policy
  (`secrets-client.ts`, `secrets-policy.ts`). See §3 below for what that
  policy is.

---

### 2. Terminology

- **Bundle** — a named container mapping env-var names to values or typed
  refs. Owned entirely by the standalone; agents-cli only re-declares the wire
  shape (`SecretsBundle`, `cli/src/lib/secrets-types.ts`).
- **Reserved store** — an agents-cli naming convention, not an engine concept:
  `__<harness>__` (one per `ALL_AGENT_IDS` entry) plus the legacy `auth` alias
  for Claude (`cli/src/lib/reserved-stores.ts`).
- **Materialize** — print a resolved plaintext value to this process's stdout
  (where an agent reader captures it into context + transcript). Governed
  entirely by the standalone now (its own `MAT-1`).
- **Inject** — place a resolved value only into a child process's environment
  (invisible to the agent reader).
- **Scope** — the opaque harness-name string agents-cli forwards on a
  `SecretsContext`, folded into the standalone's own resolution/audit.

---

### 3. Requirements agents-cli itself still owns

None of this is portable secret-storage behavior, so none of it lives in the
engine.

- **SEC-13 (MUST).** An **agent launch** MUST NOT raise an interactive OS
  prompt (e.g. Touch ID) on its own. agents-cli enforces this by always
  passing `agentOnly: true` on the run/exec injection path
  (`commands/exec.ts`, `lib/exec.ts`, `lib/browser/chrome.ts`,
  `commands/webhook.ts`) — the standalone resolves broker-only in that mode
  and fails loud (naming `agents secrets unlock <bundle>`) rather than
  prompting. **Given** an agent launch **When** it resolves a `hold`/`always`
  bundle the broker does not already hold **Then** the resolution throws
  instead of prompting, and the caller surfaces that as a clear error, never a
  hang.
- **SEC-17 (SHOULD).** `agents doctor` SHOULD warn (name + line only, never
  the value) when a credential-shaped var is exported from a shell rc file,
  and point the user at `agents secrets`. The scan itself is the standalone's
  `rc-hygiene.*` op family, reached through `scanUserRcFiles`/
  `masterPassphraseInEnv` (`secrets-client.ts`); the `rc-secret-export`
  finding (`lib/devices/doctor-findings.ts`) is what the user sees.
- **SEC-GAP-3 (MUST, closed).** The reserved `auth` bundle MUST be file-backed
  (headless, fleet-shareable — credential-management.md invariant 7).
  `cli/src/lib/reserved-stores.ts` asserts this on every read
  (`assertReservedAuthBackend`); the standalone enforces the same rule on its
  write path and answers `WRONG_BACKEND`. `isReservedBundleBackendError`
  recognizes the refusal in either shape. **Given** an `auth` bundle on the
  keychain or vault backend **When** anything reads it **Then** the read fails
  loud rather than being silently treated as absent.
- **Resource-profile scoping (CTX-1 concretely).** `agents run --secrets`
  computes `SecretsContext.allowedBundles` once per run
  (`resolveSecretsContextForRun`, `secrets-policy.ts`) from a fresh, unfiltered
  bundle listing filtered by the active resource profile
  (`resolveAllowedBundlesForActiveProfile`), and forwards it on every bundle
  resolution the run makes. No active profile MUST mean full trust
  (`allowedBundles` absent) — this is agents-cli's own gate; the standalone
  has no concept of a profile.
- **`bundle@host` is agents-cli's own flag syntax.** `--secrets
  <bundle>@<host>` is parsed and validated (`splitBundleRef`,
  `assertRemoteBundleFlagsUnsupported`, `secrets-policy.ts`) before the client
  is ever called; the standalone never sees the `@host` suffix.
- **Fleet sync of reserved credentials is agents-cli's own fleet model, not
  portable secret-storage behavior.** `syncReservedAuthBundle` /
  `syncReservedStores` / `reconcileLocalWorkerSlots` (`secrets-policy.ts`),
  run from the daemon's `auth-sync` service, publish only a
  `ready`/`missing`/`invalid` verdict to the owning device's tracked
  `~/.agents/devices/<device>/daemon-state.json` — never a credential — and a
  bounded, kill-deadlined Git exchange plus a targeted SSH push (through the
  client's `pushBundleToHostAsync`) deliver the real bundle only to a pinned,
  reachable, `role=worker` peer whose synced verdict says `missing`. **Given**
  a local file-backed `auth` bundle and a pinned worker peer reporting
  `missing` **When** this device is the one deterministically elected ready
  publisher **Then** the push is async, `--backend file`, and the destination
  auto-provisions its own machine-local key — no credential ever enters Git.

---

Everything else — the storage boundary, the materialization boundary, prompt
policy, bundle sync, cross-platform parity — is the standalone repository's
own normative contract now. Consult `phnx-labs/secrets-cli`'s own
specification for those guarantees; this document only speaks for the seam
and the policy layered on top of it in this repo.

---


## Agent execution

This is the **contract** for `agents run`: what a human, an agent, or a
downstream tool (`agents teams`, routines, `--device` dispatch) is entitled to
rely on when a run is dispatched, stated as testable requirements. It exists
because "one execution engine" is a real architectural claim
(`cli/AGENTS.md` / repo `CLAUDE.md`, §Core concepts) that code can
silently violate — a new agent added without env isolation, a bypass path that
skips the audit funnel, a flag that stops crossing the `--device` SSH boundary.
When code and this spec disagree, one of them is a bug; fixing the drift is
mandatory, not optional.

Credential account selection adds three requirements to that funnel:

- **EXEC-ACCOUNT-1 (MUST).** An account MUST have a stable id, name, provider,
  authentication kind, and secret reference. Raw credential bytes MUST remain
  in the device credential store and MUST NOT appear in `accounts.yaml`
  (`lib/account-registry.ts`).
- **EXEC-ACCOUNT-2 (MUST).** Accounts MUST be created from durable API keys,
  setup tokens, or bearer tokens. A harness version's native OAuth login MUST
  NOT be converted into a provider account or copied between devices; it remains
  a distinct, device-local native identity (`commands/accounts.ts`).
  Claude's shareable setup-token is minted by the mint step of
  `agents accounts add <harness> [name]` and re-minted by
  `agents accounts login <harness>#<name>` (`lib/auth-mint.ts`; the hidden
  `agents accounts mint` / `agents auth mint` alias still works this release):
  the command MUST capture only a well-formed `sk-ant-oat01-…` token (refusing
  a TTY-banner blob, #1767) and MUST seed both the named provider account and
  the reserved FILE-BASED `auth` bundle keyed per-account email
  (`claude-account-token.ts`). `--json` (including `--code --json`) MUST emit
  only the machine-readable result on stdout — no progress / Authorize lines,
  never the token (`commands/auth-mint.ts`, `lib/auth-mint.ts` `mintAndSeed` /
  `driveSetupTokenMint`). Interactive mint is Claude-only; any other harness
  MUST fail loud with the command that actually provisions it
  (`agents fleet login` or `agents accounts add`).
- **EXEC-ACCOUNT-3 (MUST).** `agents run --account <name>`, profile `account:`,
  and a routine `account:` that names a provider bundle MUST use the same provider
  adapter and fail before spawn when the provider cannot authenticate the host or
  the credential is absent on the execution device. A routine `account:` that
  names a harness-native identity MUST instead pin the installed version home that
  owns it and fail before spawn when that identity is unavailable; it MUST NOT
  rotate or forward the native identity through the provider-account path
  (`lib/account-registry.ts`; `commands/exec.ts`; `lib/profiles.ts`;
  `lib/daemon/runner.ts`). Explicit `--env` remains the final env override. Cloud and
  lease placement MUST reject device-local accounts.
- **EXEC-ACCOUNT-5 (MUST).** Unpinned version selection (`resolveRunVersion`) MUST
  consult **this device's** per-version auth state. A logged-out (or revoked)
  workspace/global default MUST yield to a signed-in sibling version on the
  execution device instead of spawning into a credential-less home; if no
  signed-in version exists, the run MUST fail loud naming each excluded
  version. An explicit `@version` pin is unchanged. `--strategy pinned` remains
  the escape hatch to force a *rate-limited* default, not a logged-out one
  (`lib/accounting/rotate.ts`; `commands/exec.ts`). Off macOS, a Claude home
  whose `.credentials.json` is missing (and which has no `.oauth_token`
  setup-token) MUST report signed out even when leftover `.claude.json`
  `oauthAccount` still names an email (`lib/agent-spec/agents.ts`
  `isClaudeCredentialFileBlank`).

Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are used per
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Every requirement cites the
`file:line` that implements it, under `cli/src/` unless noted. Behavioral
scenarios are written Given/When/Then so they map 1:1 to tests.

---

### 1. Purpose & scope

`agents run <agent> [prompt]` (`commands/exec.ts:502`) is the single funnel
every agent invocation passes through — interactive or headless, local or
`--device`-dispatched, single-shot or `--loop`, primary or a `--fallback` chain
entry. Its job: translate one `ExecOptions` into (a) an isolated child process
env and (b) the right CLI argv for whichever of the 16 registered agents is
being run, spawn it, and return one exit code.

**In scope:** env composition and merge order; per-version config isolation;
the buildExecEnv → execAgent/runWithFallback invariant and its one named
exception (`--acp`); rate-limit fallback/retry semantics; `--device` SSH
dispatch (what crosses the hop, what is refused); how `--secrets` reaches a
run's child env; POSIX/Windows spawn parity; the exit-code contract.

**Out of scope (non-goals, §7):** the secrets storage/materialization
boundary itself (see [Secrets](#secrets) — this spec only covers the call
site where a run consumes resolved secrets); a cross-agent JSON output
schema (`--json` passes through each agent's native stream format).

---

### 2. Terminology

- **`ExecOptions`** — the typed input to the engine: agent, version, prompt,
  mode, effort, cwd, env overrides, secrets, session id, etc.
  (`lib/exec.ts:211-294`).
- **Version home** — the isolated config directory for one installed agent
  version, `getVersionHomePath(agent, version)` = `<versionDir>/home`
  (`lib/installations/versions.ts:1054-1056`).
- **Chain / fallback entry** — one `{ agent, version?, envOverride? }` in a
  `--fallback` sequence tried in order on rate-limit failure
  (`lib/exec.ts:2272-2281`).
- **Actor** — the human or agent identity credited for a run, resolved by
  `resolveActor()` and exported via `actorEnv()` (`lib/actor.ts`).
- **Launch id** — `AGENT_LAUNCH_ID`, the correlation key that joins a spawned
  pid to the exact session its SessionStart hook records, and that a
  `--device` launcher forwards across the SSH hop to resolve a remote-coined
  session id (`lib/exec.ts:396-399`).
- **Governance chokepoint** — `recordDispatchedRun`, the one audit call every
  finalized run path makes (`commands/exec.ts:1571,2470,2628,2683`).

---

### 3. Requirements

#### 3.1 Env build & merge order

- **EXEC-1 (MUST).** Every run's child env starts from
  `sanitizeProcessEnv(process.env)` — the ambient env with dynamic-loader /
  interpreter-hijack vars stripped (`LD_*`, `DYLD_*`, `NODE_OPTIONS`,
  `PYTHONPATH`, `PYTHONSTARTUP`, `BASH_ENV`, `ENV`, `PERL5OPT`, `RUBYOPT`,
  `PROMPT_COMMAND`, `IFS`, `CDPATH`) (`lib/exec.ts:408`;
  `lib/secrets/bundles.ts:292-318`).
- **EXEC-2 (MUST).** `buildExecEnv` MUST pin a per-version config-dir var for
  claude/codex/copilot/kimi ONLY (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
  `COPILOT_HOME` / `KIMI_CODE_HOME`) and MUST delete the other three agents'
  vars on every branch, so a config pointer from a different agent's shell
  never leaks into this invocation (`buildExecEnv`'s per-agent branch, `lib/exec.ts:407-564`).
- **EXEC-2a (MUST).** For claude, `buildExecEnv` injects the reserved `auth`
  bundle's per-account setup-token into `CLAUDE_CODE_OAUTH_TOKEN` as a function of
  **DEVICE ROLE and run mode**, resolved in `claudeAdapter.applyExecConfigEnv`
  from `ctx.deviceRole` (`selfConfiguredDeviceRole()`, exec.ts) and
  `ctx.interactive` (`resolveInteractive(options)`). The token is a WORKER
  credential — it exists so an unattended box with no keychain login authenticates
  without the Touch-ID-gated login item (`lib/claude-account-token.ts:9-16`).
  Two run classes MUST instead be left on the per-version login (also the only
  credential carrying the `user:profile` scope usage reads require, RUSH-2392):
  - **any run on a headed device** — `personal` (the user's own interactive box,
    `config.role: personal`, e.g. zion) OR `desktop` (a headed always-on box,
    `config.role: desktop`, e.g. a Mac mini) — interactive TUI OR headless one-shot
    (`agents run claude "<prompt>"`) alike. Both hold a real per-version login
    (`isHeadedDeviceRole`), so they MUST authenticate from it for every run
    (RUSH-2395). Before this, gating on run mode alone routed a headless run on the
    laptop onto the setup-token and hijacked the login.
  - **an interactive run on any device.** **`resolveInteractive` means "this run
    opens a TUI", NOT "a human is present"** — do not read it as the latter.
    `watchdog/rotate.ts` builds `agents run auto --interactive` unattended, so the
    watchdog's rotate-relaunch resolves interactive and is deliberately NOT given
    the setup-token.

  So the setup-token is injected ONLY on a **headless run on a non-headed
  device** (worker / dispatched / provisioned; `!isHeadedDeviceRole(ctx.deviceRole)
  && ctx.interactive === false`). A device is "headed" when its role is `personal`
  OR `desktop` (both hold a real interactive login — `isHeadedDeviceRole`,
  `device-config.ts`); only `worker` and unmarked boxes take the setup-token. On
  that path it replaces any ambient inherited
  value, and when NO per-account token resolves it STRIPS the ambient
  `CLAUDE_CODE_OAUTH_TOKEN` (RUSH-2360 / RUSH-1822 fleet-logout hazard). On the
  login-deferring path (personal OR interactive) `buildExecEnv` MUST additionally
  delete an INHERITED `CLAUDE_CODE_OAUTH_TOKEN` whose value equals this account's
  resolved setup-token, so a launch from inside a headless agent's shell does not
  keep authenticating as it; a value the caller set itself MUST survive, and
  `options.env` still overrides last (EXEC-5). The routines path
  (`buildRoutineSpawnEnv`, `lib/daemon/runner.ts`) applies the SAME role gate: a
  routine on a headed device (personal or desktop) defers to the login, a worker
  routine keeps the setup-token. `undefined`/unmarked role is treated as non-headed
  (worker-equivalent) — an unmarked box has no login to defer to.
  Note this MUST NOT be read as "a login-deferring run never carries a token": no
  requirement yet strips an ambient value on that path when NO per-account token
  resolves, tracked as RUSH-2360.
- **EXEC-2b — usage-read credential (MUST), the same role gate as EXEC-2a.** A
  Claude *usage read* (`getClaudeUsageInfo` → `loadClaudeOauth` with
  `accessTokenCache: true`, `lib/accounting/usage.ts`) selects its credential by an
  explicit `allowInteractiveLogin` capability threaded from the caller, default
  **closed**:
  - When `allowInteractiveLogin` is unset/`false`, the read resolves the file-based
    setup-token via `resolveClaudeSetupToken(home)` and, if none exists, MUST
    `return null` — it MUST NOT read the interactive OAuth login (keychain /
    `.credentials.json`). This is the RUSH-1822 guarantee and the behavior for
    background callers other than the headed usage poller below (auth-health probe
    `auth-health.ts`, watchdog, `collectRunCandidates`).
  - **W3 exception (PHNX-3940):** the headed daemon usage poller (`usage-refresh.ts`
    `nativeFileLogin: true`) MAY read the file-based native rotating blob at
    `<home>/.claude/.credentials.json` (access + refresh token) so it can poll
    `/api/oauth/usage`, which the setup-token 403s on (RUSH-2392). It MUST NOT
    open the ACL keychain (Touch ID). A setup-token-only / worker box MUST NOT
    take this path (`buildLocalUsageAccounts` returns `[]` when
    `!isHeadedDeviceRole`). This is the one unattended writer that can keep
    idle-account snapshots inside the 15-minute sync trust window.
  - Only `agents view` sets the flag, and only for a **foreground human render on a
    headed device** (`personal` or `desktop`): `allowInteractiveUsageLogin(role, isTTY)`
    (`commands/view.ts`) returns true iff `isHeadedDeviceRole(selfConfiguredDeviceRole())`
    AND `process.stdout.isTTY`. A `--json`/piped reader (returns early via
    `collectAgentsJson`, or non-TTY) and any `worker`/unmarked device MUST leave it
    unset. Role alone is insufficient — a scripted refresh MUST NOT silently acquire
    the interactive credential.
  - With the flag set and no setup-token, `loadClaudeOauth` MUST fall through to the
    interactive OAuth login and return it when present, so `agents view --refresh`
    repopulates the session (5h) + week (7d) windows for every signed-in account. This
    is the ONLY credential carrying `user:profile` (RUSH-2392), mirroring why EXEC-2a
    defers a headed-device (personal/desktop) run to the login.
  - A usage read MUST NOT refresh an access token
    (`claudeUsageAccessTokenNoRefresh`): an expired interactive login reports
    `expired-credential`, never a silent refresh. Window freshness
    (`isCachedUsageWindowFresh`: session 300 min, week 10080 min) is unchanged — this
    contract only restores the credential that lets `--refresh` recapture an expired
    session window on a personal device.
- **EXEC-2c — a headed device MUST NOT fall back to the setup-token when its
  native login is dead (owner rule, non-negotiable).** The setup-token is a WORKER
  credential and is identity-blind; a `personal`/`desktop` box MUST authenticate
  from its native interactive OAuth login for every run, and a dead/expired/blank
  native login on such a box MUST be remedied by re-running the native OAuth flow
  (`claude` → `/login`, or `agents accounts login <harness>#<name>`), NEVER by injecting the
  long-term setup-token. A change that injects `CLAUDE_CODE_OAUTH_TOKEN` on a headed
  device on the grounds that the native login expired/blanked is a REGRESSION and
  MUST be rejected in review. The durable token is minted ON the headed device and
  synced OUT to workers; it never flows back in as that device's own runtime
  credential. Full statement: [`credential-management.md` invariant 7](credential-management.md#the-invariants-non-negotiable).
- **EXEC-3 (MUST).** `buildExecEnv` MUST set `AGENTS_MAILBOX_DIR` +
  `AGENT_SESSION_ID` + `AGENTS_SESSION_ID` when a valid session id is present
  (`lib/exec.ts:572-575`), `AGENTS_RUNTIME` to `terminal`/`headless` from
  `resolveInteractive` (`lib/exec.ts:587`), `AGENTS_AGENT_NAME`
  (`lib/exec.ts:602`), `AGENTS_CWD` when a cwd is given
  (`lib/exec.ts:605`), and `AGENT_SESSION_NAME` when `--name` is given
  (`lib/exec.ts:612`).
- **EXEC-4 (MUST).** `buildExecEnv` MUST assign actor-provenance env
  (`AGENTS_ACTOR`, `_KIND`, and when known `_NAME`/`_EMAIL`/`_GITHUB`/`_PHOENIX_ID`/`_AVATAR`, plus
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` for a resolved human) from
  `actorEnv(resolveActor())` (`lib/exec.ts:619`; `lib/actor.ts:180-196`), so
  the agent's own `git commit` credits the person, not the shared account.
- **EXEC-5 (MUST).** `buildExecEnv` MUST apply `options.env` LAST, overriding
  every var set above — the single caller-override seam:
  `return { ...result, ...options.env }` (`lib/exec.ts:621-624`).
- **EXEC-6 (MUST).** At the command layer, `agents run`'s `--secrets`/`--env`
  handling MUST compose `options.env` in the fixed order **profile env <
  auto-share token < secrets bundles < `--env K=V`**, later wins
  (`commands/exec.ts:2738`, comment: *"Merge order (later wins): profile
  env < auto share token < secrets bundles < --env K=V."*). `--secrets` is
  **repeatable** (a collect accumulator, `commands/exec.ts:720-725`), so the
  bundles slot has its own internal order: bundles resolve **in flag order,
  later bundle wins** a duplicate key — each is spread over the accumulator
  (`secretsEnv = { ...secretsEnv, ...bundleEnv }`, `commands/exec.ts:2704,2726`,
  comment: *"Later bundles override earlier ones."*). A resolution failure in
  any bundle MUST abort before spawn, so the child never sees a partial env.
- **EXEC-7 (MUST).** "Profile env" comes from `resolveProfileEnv(profile)` —
  a static `env` block plus, when the profile declares `auth`, a Keychain
  token read live at exec time and merged in under `auth.envVar`, so the
  profile YAML itself never carries a secret (`lib/profiles.ts:380-393`).
- **EXEC-8 (MUST).** The "auto share token" (`shareRuntimeEnv`) MUST be
  best-effort: it MUST NOT throw or block an unrelated run when the share
  bundle is missing or locked (`lib/share/config.ts:117-136`, wrapped in
  `try/catch`, doc comment: *"Never throws."*).
- **EXEC-9 (MUST).** `--secrets <bundle>` resolution MUST go through
  `readAndResolveBundleEnv`, which MUST fail atomically before spawn on any
  resolution error — no partial env is ever returned to the caller
  (`lib/secrets/bundles.ts:1301,1505-1563`).
- **EXEC-10 (MUST).** `--secrets-keys` MUST restrict injection to the named
  subset and MUST throw if a requested key is absent from the bundle — never
  a silent skip (`lib/secrets/bundles.ts:979-984,1469`).
- **EXEC-11 (MUST).** An expired secret MUST abort the run unless
  `--allow-expired` is passed (`lib/secrets/bundles.ts:1006,1470`).
- **EXEC-12 (MUST).** A headless/agent-launched run MUST NOT be able to
  trigger a Touch ID prompt for a keychain-backed bundle: `agentOnly`
  (from `isHeadlessSecretsContext`, `lib/secrets/bundles.ts:1260-1286`) makes
  `readAndResolveBundleEnv` throw, naming `agents secrets unlock <bundle>`,
  instead of raising the sheet (`lib/secrets/bundles.ts:1382-1391`).

#### 3.2 Version-home isolation

- **EXEC-13 (MUST).** Every installed agent version has an isolated home
  directory: `getVersionHomePath(agent, version)` =
  `<historyDir>/versions/<agent>/<version>/home` (`lib/installations/versions.ts:1050-1056`,
  doc comment: *"Each version has its own config isolation (like jobs
  sandbox)."*).
- **EXEC-14 (MUST, scoped).** `buildExecEnv` realizes that isolation ONLY for
  claude/codex/copilot/kimi, by pinning `CLAUDE_CONFIG_DIR` /
  `resolveCodexHome(...)` / `COPILOT_HOME` / `KIMI_CODE_HOME` at
  `<versionHome>/<configDir>` (`lib/exec.ts:424,482,497,511` — the four assignments inside `buildExecEnv` (`:407`)).
- **EXEC-15 (clarifying note).** `buildExecEnv` MUST NOT set the raw `HOME`
  var for any agent — no `result.HOME = …` exists anywhere in `lib/exec.ts`.
  Isolation is realized purely through the agent-specific config-dir vars in
  EXEC-14. This is narrower than `docs/concepts.md:87`'s framing ("sets
  `HOME` to the matching version home before exec-ing the binary") — that
  claim describes the generated **bash shim** script's own inline exports
  (`lib/installations/shims.ts:280-330`), a separate code path from `buildExecEnv`, and even
  there no literal `HOME=` assignment exists (verified: no `HOME="` writer in
  `lib/installations/shims.ts` — only `AGENTS_USER_DIR`/`GROK_DOWNLOADS` etc. *read* `$HOME`).
- **EXEC-16.** The remaining registered agents
  (gemini, opencode, openclaw, amp,  goose, antigravity, grok,
  droid, hermes, pi — the 16 in `AgentId`, `lib/types.ts:13`, minus the
  EXEC-14 isolates and the XDG-isolated agents below) get **no** per-version config-dir var from
  `buildExecEnv` itself — its per-agent branch has no arm for them
  (`buildExecEnv`'s per-agent branch, `lib/exec.ts:407-564`; the `else` at `:559-564` only deletes the four known vars).
  A separate mechanism — the generated default-name bash shim
  (`generateShimScript`, `lib/installations/shims.ts:271-330`) and the generated
  version-pinned alias shim (`lib/installations/shims.ts:940-1010`) — additionally exports
  `GROK_HOME` (grok, `lib/installations/shims.ts:315,982`) and `OPENCODE_CONFIG_DIR`
  (opencode, `lib/installations/shims.ts:322,989`) inline in bash, but only when the spawn
  target actually resolves to one of those shim scripts;
  `buildExecCommand`'s own version-resolution fallback
  (`lib/exec.ts:971-988`) can instead resolve straight to the real npm
  binary, bypassing that isolation entirely. Antigravity workflows and
  OpenCode auth are separately, explicitly documented as account-global —
  not per-version — by design (`cli/AGENTS.md:150`;
  `lib/agents.ts:1410-1425`, doc comment: *"account-global (not
  per-version)"*).

  Status: `[Drift]` — a named deviation from EXEC-13's per-version isolation
  contract, scoped (with the two ways to close it) in EXEC-GAP-1.
- **EXEC-16a (MUST).** Muse has no dedicated config-dir env var, so
  `buildExecEnv` isolates it via `XDG_CONFIG_HOME` and `XDG_DATA_HOME`. Cursor
  defaults to a machine-global OS-keychain store on macOS, so its exec boundary
  MUST set `AGENT_CLI_CREDENTIAL_STORE=file`. Current Cursor builds store that
  file credential at HOME-relative `~/.cursor/auth.json`; agents-cli swaps HOME
  to the selected version home at the same boundary, isolating it without XDG relocation. `~/.cursor/cli-config.json` is
  account metadata only, so each version home is
  a distinct Cursor account, authenticated from its own token, isolated per run
  (no global `~/.cursor` symlink swap — concurrent runs on different accounts do
  not clobber one another). `CREDENTIAL_FILE_SEGMENTS.cursor`
  (`lib/agents.ts`) verifies signed-in per home against that token, and
  `seedActiveCursorLoginPerVersion` (`lib/installations/migrate.ts`) migrates only the
  legacy misplaced `~/.config/cursor/auth.json` token into the active account's home on upgrade; it MUST NOT
  export or delete an OS-keychain login. The versioned-alias shim mirrors both
  HOME swap and file-store export (`CONFIG_ENV_ISOLATED_AGENTS` includes cursor).
  Because Cursor keeps `auth.json`, `cli-config.json`, chats, and preferences in
  the HOME-relative `~/.cursor` tree, that entire tree is version-local for
  managed runs and direct version aliases. Routine sandboxes are the deliberate
  exception: `prepareJobHome` creates a disposable HOME and
  `generateCursorConfig` links the daemon host's active `~/.cursor/auth.json`
  and `cli-config.json` into it. Routines therefore use the active host login by
  design; they do not select a managed version account through this overlay.
- **EXEC-17 (MUST).** The Windows `.cmd` shim delegate
  (`execShimPassthrough`) MUST route its env through the same `buildExecEnv`
  `agents run` uses (`lib/exec.ts:1348`) — so on Windows the isolated-agent
  set is identical to, never broader than, `agents run`'s (EXEC-14).

#### 3.3 The single execution engine

- **EXEC-18 (MUST).** Every non-ACP `agents run` invocation MUST resolve to
  `buildExecCommand` (argv, `lib/exec.ts:991-1301`) + `buildExecEnv` (env) +
  `spawn`, reached via `execAgent` (single-shot, `lib/exec.ts:1304-1307`) or
  `runWithFallback` (chain, `lib/exec.ts:2352-2455`) — the plain path
  (`commands/exec.ts:2657-2687`) and the `--loop` path
  (`commands/exec.ts:2591-2637`) both terminate in one of those two calls; a
  `--device` run re-execs `agents run` itself on the remote box (§3.5), so it
  is the same engine one hop further out, not a third path.
- **EXEC-19 (NAMED EXCEPTION).** `--acp` is the one documented bypass: it
  routes through `runAcpHeadless` (`lib/acp/run.ts`) instead of
  `buildExecEnv`/`execAgent`, calling `recordDispatchedRun` directly as its
  own finalize (`commands/exec.ts:2459-2470`, comment: *"Governance
  chokepoint (#347): the --acp path exits here, bypassing the normal
  finalize below."*).
- **EXEC-20.** The ACP child spawn passes `env: process.env` verbatim
  (`lib/acp/client.ts:65-69`) — it receives NONE of `buildExecEnv`'s
  guarantees: no `sanitizeProcessEnv` stripping, no per-version config-dir
  pin, no actor provenance, no mailbox/session wiring, no `AGENTS_RUNTIME`
  label.

  Status: `[Drift]` — EXEC-19 names `--acp` as a routing exception, but the env
  guarantees it forfeits (EXEC-1 sanitize, EXEC-3 mailbox/session + the
  `AGENTS_RUNTIME` label, EXEC-4 actor
  provenance, EXEC-14 per-version pin) are an undeclared consequence of that
  exception, not a scoped one; see EXEC-GAP-2.
- **EXEC-21 (MUST).** Every finalized run path (plain, fallback, loop, ACP)
  MUST call `recordDispatchedRun` exactly once as its audit funnel
  (`commands/exec.ts:1571,2470,2628,2683`, each commented *"Governance
  chokepoint (#347)"*).
- **EXEC-22 (MUST).** `buildExecCommand` MUST resolve the requested `Mode`
  against the target agent's declared capabilities before building flags:
  `resolveMode`/`resolveHeadlessMode` (`lib/exec.ts:108-177`) — `auto`
  degrades to `edit` when unsupported; `plan` degrades to
  `capabilities.modes[0]`, or (headless-only, e.g. kimi/grok) to `auto` with
  a stderr warning when the agent's plan mode is known to stall headless;
  `skip` on an unsupported agent throws naming the agent's real modes.
- **EXEC-22a (MUST).** Every native Codex launch MUST use the canonical named
  permission profiles from `lib/codex-policy.ts`. `agents-plan` extends
  `:read-only` and enables network access; `agents-edit` and `agents-auto` extend
  `:workspace`, enable network access, and grant `~/.agents`, regenerable
  toolchain caches, and caller-supplied `--add-dir` roots through
  `workspace_roots`. `agents-plan` and `agents-edit` MUST set
  `approval_policy="on-request"`; `agents-auto` MUST set
  `approval_policy="never"`, so a sandbox-denied command surfaces to the model as
  a command failure instead of an approval prompt no unattended caller can
  answer. Autonomy is the approval axis only: `auto` MUST NOT widen the sandbox
  beyond `edit`, and only explicit `skip` may emit
  `--dangerously-bypass-approvals-and-sandbox`. Fresh runs, native resumes,
  routines, POSIX shims, versioned aliases, and the Windows shim delegate MUST
  consume the same policy builder. Two paths deliberately pin `edit` -- the
  direct-binary launch (`lib/exec.ts` `execShimPassthrough`) and the shim launch
  args (`harness/adapters/codex.ts` `shimLaunchArgs`, consumed by the POSIX shim
  and the versioned alias). A bare `codex` invocation carries no mode at all and
  a human is at that terminal, so an approval prompt is the useful outcome there.
- **EXEC-22b (MUST).** When `--mode` is omitted and the selected or fallback
  harness is Codex, the mode MUST resolve to `edit`. Explicit `plan` MUST remain
  filesystem-read-only with network enabled; explicit/configured modes MUST not
  be replaced by the intrinsic Codex default.
- **EXEC-23 (MUST).** A prompt-less run inferred as interactive at a
  non-TTY MUST be refused before spawn rather than hang on dead stdin
  (`inferredInteractiveWithoutTty`, `lib/exec.ts:320-326`; enforced
  `commands/exec.ts:2645-2655`).
- **EXEC-23a (MUST).** An interactive tmux-wrapped run MUST either attach
  a confirmed-live pane to the user's terminal OR surface a legible failure
  banner on stderr, and MUST NEVER leave an orphan session behind (RUSH-2185).
  Three sub-rules enforce this:
  - **(F1) Harness gate.** `agents run auto` with no prompt MUST NOT pick a
    harness whose `capabilities.interactiveRepl` is `false`.  When all
    installed harnesses lack that capability the run MUST fail with a clear
    message naming the installed harnesses and instructing the user to pass
    `-p` or install a REPL-capable one (`commands/exec.ts` auto-picker block;
    `lib/agents.ts` per-agent capability; `lib/types.ts CapabilityName`).
  - **(F2) Dead-pane recap.** `surfacePaneFailure` MUST be called whenever a
    tmux pane is found dead — before or after attach — REGARDLESS of the
    pane's exit code when the run is interactive.  `shouldRecapDeadPane(status,
    interactive)` encodes this: `true` when `status !== 0` OR `interactive`
    (`lib/exec.ts: shouldRecapDeadPane`; applied in `runInTmux`).
  - **(F3) Positive-proof keep-session.** The "pane still alive → keep session"
    branch in `runInTmux` MUST only be taken when a direct `tmux
    display-message #{pane_dead}` query explicitly returns exit-0 with stdout
    "0".  `paneExitStatus` returning `{dead: false}` is NOT sufficient — it
    also returns that value on any query error (race with pane death).
    `isPaneKnownAliveFromQueryResult(code, stdout)` encodes the positive-proof
    test (`lib/exec.ts: isPaneKnownAliveFromQueryResult`).  An ambiguous
    result MUST `killSession` rather than keep the orphan.
- **EXEC-23b (MUST).** A tmux-wrapped run MUST resolve exit code `0` only for
  an outcome tmux actually reported: a pane confirmed alive (a clean user
  detach) or a dead pane whose `#{pane_dead_status}` tmux read as `0`. Every
  other case is UNKNOWN — the pane is unreadable because the server or session
  went away, or it is dead with no reported status — and MUST resolve to
  `UNKNOWN_OUTCOME_EXIT_CODE` (1) with a stderr banner, never silently.
  `tmuxRunExitCode(pane, knownAlive)` is the single decision
  (`lib/exec.ts: tmuxRunExitCode`); **every** `runInTmux` return path routes
  through it, so the banner and the returned code can never disagree.

  Two banners serve the two UNKNOWN causes, because they are not the same
  event and one message cannot honestly describe both. A pane tmux **cannot
  read at all** gets the dedicated `outcome unknown` banner naming the cause —
  the session went away, or the run never had a readable pane id
  (`lib/exec.ts: resolveAfterAttach`). A pane tmux **reports dead with no
  status** gets `surfacePaneFailure`'s recap (`agents: <agent> exited (exit
  1)`) plus the pane tail, which is the more useful output when there is a
  pane to quote; that recap is gated on `shouldRecapDeadPane` (F2), so a
  headless run keeps its quiet path.

  **A resume-attach is an attach and is bound by this too.** `runInTmux`'s
  native-resume branch re-attaches an existing live session
  (`prepareSessionForResume` → `attach`); it MUST resolve its outcome the same
  way rather than returning a literal `0`. `prepareSessionForResume` therefore
  returns the pane it positively resolved (`ResumePreparation`,
  `lib/tmux/session.ts`) — without that handle the caller has nothing to ask
  tmux about and can only assume success.

  This closes a drift, not a hypothetical: every path previously returned
  `status ?? 0` or a literal `0`, so an interactive run whose tmux server died
  mid-work (`[server exited unexpectedly]`, the agent stranded at an approval
  prompt) printed a failure banner reading `exit 1` and handed its caller `0`.
  The rule matches the `--device` follow path in the exit-code table below —
  "the remote's own exit code, or 1 if unknown".

  **Known cost (accepted).** The daemon reaps any session whose panes are all
  dead every `DEAD_PANE_REAP_TICK_MS` (5 min, `lib/daemon/daemon.ts`). A cleanly
  exited run is in that state between its pane dying and `paneExitStatus`
  reading it, so a tick landing inside that one-tmux-round-trip window leaves
  the pane unreadable and a genuinely successful run resolves `1`. Once the
  pane is gone the CLI has no other evidence of the outcome, so this direction
  of error is deliberate: EXEC-23b prefers a false unknown over a false
  success.

  **GWT-E9 — a tmux server that dies under an interactive run is not success.**
  Given an `agents run --interactive` wrapped in tmux; When the tmux server or
  session goes away before `paneExitStatus` can read the agent pane (so it
  returns `{found: false, dead: false}`); Then the run MUST tear the session
  down, print the unknown-outcome banner, and resolve `1` — never `0`
  (`lib/exec.test.ts`: "tmuxRunExitCode — an unknown outcome is never success",
  "paneExitStatus against a real tmux server that went away").
- **EXEC-24 (MUST).** A slash-command prompt run headless under the
  implicit default `plan` mode MUST be refused before spawn — it would hang
  forever at `ExitPlanMode` with no TTY to approve it
  (`headlessPlanStallCommand`, `lib/exec.ts:77-90`; enforced
  `commands/exec.ts:2205-2222`).

#### 3.4 Fallback & retry

- **EXEC-25 (MUST).** `runWithFallback` MUST run the primary first with the
  original prompt, and MUST cascade to the next chain entry ONLY when
  `detectRateLimit` matches the failed attempt's stderr OR its captured
  stdout tail (`lib/exec.ts:1977-1986`), cascading only when `detectRateLimit` matches (`lib/exec.ts:2441`); every other failure (auth failure,
  compile error, missing flag) MUST bubble up from whichever entry produced
  it, untouched — `runWithFallback` never inspects auth-failure detectors at
  all (`isAuthFailureFromLog` is not called from the cascade path).
- **EXEC-26 (MUST).** A same-host retry (identical agent+version to the
  previous chain entry — a profile `fallback_model` swap) MUST keep the
  original prompt; a genuine handoff to a different agent/version MUST
  rewrite it via `buildFallbackPrompt` — `/continue <id>` when the next
  agent is claude with a known prior session id, else an explicit
  retry-with-context note pointing at `agents sessions <id>`
  (`lib/exec.ts:2310-2336`).
- **EXEC-27 (MUST).** Workflow tool/MCP scoping (`--tools`/`--mcp-config`/
  `--strict-mcp-config`) is enforced on claude only; `runWithFallback` MUST
  warn loudly on stderr when scoping is active and the chain contains a
  non-claude agent, since a rate-limit handoff would otherwise run that
  fallback silently unscoped (`lib/exec.ts:2360-2376`).
- **EXEC-28 (SHOULD).** A non-primary (`i>0`) chain entry that fails to
  spawn with `ENOENT` MUST be skipped, not fatal, so an uninstalled fallback
  agent doesn't kill the whole chain (`lib/exec.ts:2429-2432`).
- **EXEC-29 (MUST).** The caller-supplied `dispatchSink` out-param MUST be
  updated to the agent+version actually attempted on every chain step, so
  the audit record (EXEC-21) reflects the fallback that really ran, not
  always the primary (`lib/exec.ts:2379,2389`).

#### 3.5 `--device` SSH dispatch

- **EXEC-30 (MUST).** A headless `--device` run MUST re-exec
  `agents run <agent> "<prompt>" --quiet …` on the remote box over SSH,
  detached, with the remote's stdout/stderr redirected to a log file and its
  exit code written to a sidecar `.exit` file (`lib/hosts/dispatch.ts`:
  `launchDetached`/`buildDetachedLaunchCommand`); an interactive `--device`
  run streams the same style invocation live via `sshStream` instead
  (`runInteractiveOnHost`). A trailing account-picker marker (`<agent>@`) MUST
  survive that interactive re-exec so the peer, not the launcher, lists and
  selects from its device-local versions/accounts. Picker-aware automatic
  placement MUST prefer signed-in devices while retaining reachable devices
  where the harness is installed but every account is signed out/revoked, so
  the peer's selectable `launch to sign in` path remains reachable; non-picker
  automatic placement MUST continue to require a healthy signed-in account.
- **EXEC-31 (MUST).** Actor-provenance env MUST cross the SSH hop:
  `withActorEnv()` prepends `actorEnv(resolveActor())` as shell exports
  ahead of the remote invocation, so the remote process is credited to the
  ORIGINATING actor rather than re-resolved from the remote's own
  `SSH_CONNECTION` (`lib/hosts/dispatch.ts`, RUSH-2028).
- **EXEC-32 (MUST).** A flag-classification table
  (`RUN_OPTION_FORWARDING`, `lib/hosts/remote-cmd.ts:86-144`) governs every
  `agents run` flag crossing the hop: `mode`/`effort`/`model`/`env`/
  `addDir`/`name`/`resume`/`sessionId`/`timeout`/`fallback`/`balanced`/
  `strategy`/loop flags/`json`/`verbose`/`yes`/`acp`/`autoSecrets`/
  `emitSessionId` all forward; `secrets`/`secretsKeys`/`allowExpired`/
  `resumeCheckpoint` are classified `'reject'` and MUST fail loud
  pre-dispatch rather than be silently dropped (`commands/exec.ts:1170-1173`).
- **EXEC-33 (MUST NOT).** `--secrets` bundle VALUES MUST NEVER be resolved
  locally and shipped to a `--device`-dispatched run — the dispatcher refuses
  outright (`RUN_OPTION_REJECT_MESSAGES.secrets`,
  `lib/hosts/remote-cmd.ts:148-151`: *"--secrets cannot cross the SSH
  boundary — Keychain values are never sent to a host implicitly."*).
  Workflow-frontmatter auto-secrets (`autoSecrets`, classified `'forward'`)
  instead resolve from the REMOTE host's own keychain, never the
  launcher's.
- **EXEC-34 (MUST NOT).** `--copy-creds` and lease placement MUST NOT resolve,
  serialize, or transfer native OAuth/session credentials. `--copy-creds` is a
  deprecated fail-loud flag. Portable provider credentials move only through
  explicit `agents accounts sync <account> --device <device>`, which requires an already
  pinned managed SSH host key and disables SSH multiplexing.
- **EXEC-35 (MUST).** A `~`/`$HOME`-anchored `--cwd` MUST be re-rooted onto
  the REMOTE user's home via an unquoted `"$HOME"` shell expansion
  evaluated on the remote side, never expanded locally (`/home/<me>` vs
  `/Users/<me>` — `lib/hosts/dispatch.ts` `remoteCdPrefix`/
  `toRemotePortable`); an explicit `--remote-cwd` is used byte-for-byte
  verbatim and is never re-rooted.
- **EXEC-36 (MUST).** `--no-follow` MUST return immediately with the local
  task record left `status: 'running'` and no known exit code, and the
  local process MUST exit 0 regardless of the eventual remote outcome
  (`commands/exec.ts:1469-1480`); a following dispatch MUST resolve the
  real remote exit code from the sidecar `.exit` file, and MUST map a
  follow-window-closed-but-still-running result to local exit 0 rather than
  a guessed outcome (`lib/hosts/dispatch.ts` `followHostTask`, `-1` sentinel;
  `commands/exec.ts:1484-1485`).
- **EXEC-37 (MUST).** The remote-coined session id (every agent except
  claude, whose id is forced up front via `--session-id`) MUST ride back to
  the launcher via a one-line stdout sentinel (`sessionIdMarkerLine`,
  `lib/hosts/session-marker.ts:21-22,32-34`) that the follower parses from
  the combined log, or — for the interactive path — a one-shot SSH lookup
  keyed on the shared `AGENT_LAUNCH_ID`; a lookup failure MUST leave the run
  unmapped rather than mismap it to the wrong session
  (`commands/exec.ts:1390-1397`, comment: *"best-effort ... leaves the run
  un-mapped rather than mis-mapped."*).

#### 3.6 Secrets injection into a run

(This subsection is the call site; the storage/materialization guarantees
themselves are normative in [§Secrets](#secrets) — SEC-6..SEC-14 govern.)

- **EXEC-38 (MUST).** `--secrets <bundle>@<host>` — a single bundle resolved
  from a PEER machine, independent of offloading the whole run via
  `--device` (§3.5) — MUST resolve over SSH via `remoteResolveEnv` and inject
  ephemerally, and MUST reject `--secrets-keys`/`--allow-expired` for a
  remote bundle ref, since those flags don't yet cross the SSH resolver
  (`commands/exec.ts:2247-2264`, `assertRemoteBundleFlagsUnsupported`).
- **EXEC-39 (MUST).** Resolved secret values MUST reach the child only
  through the env object passed to `spawn` — the same **Inject** boundary
  as SEC-7: `agents run --secrets` builds the child env and spawns with
  `stdio:'inherit'`; it never prints a resolved value to this process's own
  stdout (`commands/secrets.ts:369-376,2006-2009`; classification table
  §4.2 of [Secrets](#secrets): `run --secrets <b>` → **Inject**,
  `commands/exec.ts:2181`).

#### 3.7 Cross-platform

- **EXEC-40 (MUST).** On POSIX, `spawnAgent` MUST exec the resolved binary
  directly with `shell:false` — no shell interposition
  (`lib/exec.ts:1935-1944`, `useShell` gate).
- **EXEC-41 (MUST).** On Windows, when the target is a `.cmd` wrapper or a
  non-absolute name, `spawnAgent` MUST compose ONE fully-quoted command
  line via `composeWin32CommandLine` and pass an EMPTY args array, so Node
  never concatenates the caller-controlled args array — which carries the
  raw prompt — into the shell line unescaped: a DEP0190 +
  command-injection guard (`lib/exec.ts:1935-1944`; the same rule mirrored
  for shim dispatch by `resolveShimSpawn`, `lib/exec.ts:1319-1338`).
- **EXEC-42 (MUST).** The interactive tmux spawn-wrap MUST be POSIX-only —
  Windows always uses the bare/shell spawn path
  (`resolveTmuxWrap`, `lib/exec.ts`, `platform === 'win32'` excluded
  outright — it returns `bare`, never `undurable`, so a Windows peer is
  not refused, it is simply unwrapped).
- **EXEC-52 (MUST).** The reconnect loop MUST bound an unproductive streak by
  wall clock ({@link RECONNECT_WINDOW_MS}, `lib/hosts/reconnect.ts`), not by a
  fixed attempt count, and a reattach that reconnects and holds MUST reset it.
  *Given* a laptop lid closed for ten minutes; *When* it wakes; *Then* the loop
  is still retrying. The prior 6-attempt budget expired in ~90s — shorter than
  every ordinary outage it exists for — and suspended timers meant the whole
  backoff fired at once on wake.
- **EXEC-53 (MUST).** `SIGINT` during a reconnect wait MUST end the loop
  cleanly with 130 and state where the agent is, never kill the process
  mid-notice. The agent is detached on the peer, so an interrupt loses nothing
  and the user MUST be told how to return.
- **EXEC-54 (MUST).** After an interactive (`tty`) remote stream exits, the
  local terminal MUST be restored — termios from a pre-spawn `stty -g`
  snapshot, the DEC private modes a full-screen TUI arms reset, and the tty
  input buffer drained (`sshStream`, `lib/ssh-exec.ts`). ssh restores termios
  only on a clean exit; an abnormal one leaves the tty raw with the TUI's modes
  armed, and the terminal's answerback bytes stay queued and are delivered to
  the NEXT attach as if typed.
- **EXEC-48 (MUST).** An INTERACTIVE run dispatched onto this box over
  `--device` MUST be detached from the ssh session that carries it — the
  tmux spawn-wrap is required, independent of the peer's `tmux.enabled`
  (`resolveTmuxWrap`, `lib/exec.ts`, keyed on `REMOTE_INTERACTIVE_ENV`
  which `runInteractiveOnHost` exports via `remoteRunShellPrelude`,
  `lib/hosts/dispatch.ts`). `tmux.enabled` governs LOCAL addressability
  only. The explicit per-run opt-outs (`--raw`, `--no-tmux`,
  `AGENTS_NO_TMUX=1`) still win, and Windows is excluded by EXEC-42.
  *Given* a peer with `tmux.enabled` unset; *When* an interactive
  `--device` run lands there and the link then drops; *Then* the agent
  process survives in a detached pane and the reattach in
  `lib/hosts/reconnect.ts` rejoins it rather than resuming a copy.
  Rationale: that file's whole design assumes the agent outlived the
  client, and before RUSH-3125 the assumption was false on every
  default-configured box.
- **EXEC-49 (MUST).** When EXEC-48 requires the wrap and tmux is absent
  on the box, the run MUST be refused with a clear, actionable error
  (`resolveTmuxWrap` → `undurable`) rather than spawned bare. A bare
  remote spawn looks successful until the link blinks, at which point the
  work is unrecoverable — failing loud at the boundary is the repo rule.
- **EXEC-50 (MUST).** An interactive `--device` stream MUST NOT share the
  ssh `ControlMaster` (`runInteractiveOnHost` passes `multiplex: false`,
  `lib/hosts/dispatch.ts`). `ControlPath=cm-%C` (`lib/ssh-exec.ts`) hashes
  only local host / remote host / port / user, so every agent tab aimed at
  one peer would otherwise ride a single master, and OpenSSH closes every
  channel on it when that master dies. *Given* six agent tabs on one peer;
  *When* the link blinks; *Then* each tab fails and recovers
  independently, not all six at once. Short probes and fan-outs keep
  multiplexing, where the saved handshake is worth it.
- **EXEC-51 (MUST).** Auto-reconnect MUST NOT depend on a value that can
  only be learned over the link that dropped. The target is chosen by
  `pickReconnectTarget` (`lib/hosts/reconnect.ts`), which falls back to
  the launcher-minted `AGENT_LAUNCH_ID` — known before the connection
  existed — and the peer resolves it locally via
  `agents sessions focus --launch-id <id> --local`. *Given* a non-Claude
  harness whose real session id is coined remotely; *When* the link drops
  before `resolveRemoteSessionId` can read it back; *Then* the run still
  reconnects. Before this, only Claude (handed `--session-id` up front)
  ever reconnected, and every other harness exited straight to a shell.
- **EXEC-55 (MUST).** When an interactive remote connection to a session ends
  and the user is back at a local shell, the CLI MUST print the full session
  id and the resume command (`connectionEndedNotice`,
  `lib/hosts/reconnect.ts:351`).
  Auto-reconnect (exit 255 that the loop will retry) MUST NOT print it — the
  user is not at a shell yet. A clean detach, an agent exit, a drop that is
  not reconnecting — including `--raw` (no tmux, so no reconnect) — 
  `sessions focus` remote tmux attach, and `runOnPeer` TTY hops MUST. *Given* a remote TUI whose SSH ControlMaster closes; *When*
  the local client exits; *Then* the shell shows `Session <uuid>` and
  `agents sessions resume <uuid>` under OpenSSH's `Shared connection … closed.`
  line, not a bare prompt (RUSH-3227).
- **EXEC-56 (MUST).** When an interactive `--device` run whose real session id
  is known before the TTY is taken (Claude's forced id, or a resume) starts,
  the CLI MUST print that full id and a resume-later command
  (`connectionStartedNotice`, `lib/hosts/reconnect.ts`) so the id exists
  *while* the connection exists, not only after it dies. A launch id MUST
  NOT be printed as a session id. *Given* `agents run claude --device yosemite-m2`;
  *When* the SSH stream is about to start; *Then* stderr shows
  `Session <uuid> on yosemite-m2` and `agents sessions resume <uuid>`
  (RUSH-3227 plan B).
- **EXEC-43 (MUST).** A persisted tmux `SessionMeta.cmd`
  (`buildTmuxAgentCommand`) MUST redact env VALUES (`<redacted>`) while the
  live launched command keeps the real values, so a resolved secret never
  lands on disk via the informational `cmd` field
  (`lib/exec.ts:1530-1558`, RUSH-1758).

#### 3.8 Rules preset auto-apply

- **EXEC-44 (MUST).** `agents run` MUST re-apply the active rules preset
  (`getActiveRulesPreset(agent, version)`, `lib/state.ts:1167`) for the
  resolved (agent, version) into that version's home directory before
  dispatch, on every invocation — not only after an explicit
  `agents rules switch`/`agents add`/`agents use`
  (`applyActiveRulesPresetAtRun`, `lib/rules/run-sync.ts:90`; called from
  `commands/exec.ts:2323`, immediately after `defaultVersion` resolves and
  before the ACP/loop/fallback/plain dispatch branches, so every one of
  those paths for this agent+version sees a fresh rules file).
- **EXEC-45 (MUST).** The re-apply MUST be skip-fast: it MUST compare the
  resolved preset name AND the composed source-file fingerprints (mtime+size,
  sha256 on a stat miss — `staleness/fingerprint.ts:isFileStale`) against a
  small per-`(agent, version)` sentinel at
  `~/.agents/.cache/rules-run-sync/<agent>@<version>.json`, and MUST skip the
  version-home write when both match (`lib/rules/run-sync.ts:100-106`). The
  preset name is tracked in ADDITION to the file-fingerprint set because
  user/extra rules layers auto-append every un-named subrule
  (`lib/rules/compose.ts`, "auto-append"), so two differently-named presets
  can legitimately resolve to an IDENTICAL source-file set — a
  fingerprint-only comparison would miss that a preset switch happened.
- **EXEC-46 (MUST NOT block launch).** A missing `rules.yaml`, an unknown
  preset name, or an unsupported agent (`capabilities.rules === false`)
  MUST NOT throw out of `applyActiveRulesPresetAtRun` — every failure mode
  is caught and the function returns `false` (no write attempted), mirroring
  `syncResourcesToVersion`'s own catch-and-skip for rules
  (`lib/rules/run-sync.ts:95-98,108-112`; `lib/installations/versions.ts:2952-2960`).
- **EXEC-47 (scope, not a bug).** The auto-apply is VERSION-scoped only —
  keyed by `(agent, version)`, matching `getActiveRulesPreset`. Per-model
  preset scoping (a different active preset per `--model` within the same
  agent+version) is out of scope for EXEC-44..46 and is a separate,
  not-yet-built follow-up.

---

### 4. Interface contract

#### 4.1 Command surface

`agents run <agent> [prompt]` (`commands/exec.ts:502`) — ~50 `.option()`
declarations (`commands/exec.ts:500-627`) grouped into: mode/effort/model,
env/secrets\* (`--env`, `--secrets`, `--no-auto-secrets`, `--secrets-keys`,
`--allow-expired`), cwd/project/addDir, output (`--json`/`--quiet`/
`--verbose`), interactivity (`--headless`/`--interactive`/`--no-auth-check`),
resume (`--resume`/`--session-id`/`--name`), tmux (`--raw`/`--no-tmux`/
`--disable-tmux`), reliability (`--timeout`/`--fallback`/`--balanced`/
`--strategy`), `--acp`, budget (`--yes`), loop (`--loop`/
`--resume-checkpoint`/`--max-iterations`/`--budget`/`--until`/`--interval`),
and host/lease dispatch (`--device`/`--remote-cwd`/`--no-follow`/
`--any`/`--copy-creds`/`--lease`/`--box`/`--keep-box`/`--fresh`/`--reuse`/`--bare`/
`--tailscale`).

#### 4.2 Exit code contract (STABLE)

| Path | Exit code | Evidence |
|---|---|---|
| Plain run / fallback chain (no tmux wrapper) | the child's own exit code, verbatim | `commands/exec.ts:2687` |
| tmux-wrapped run (incl. `--interactive`, `--resume` attach) | the pane's exit status when tmux reported one; `0` for a confirmed-alive pane (clean detach); otherwise **1 if unknown** — there is no child exit code to read once the pane is unreadable (EXEC-23b) | `lib/exec.ts: tmuxRunExitCode`, `runInTmux` |
| `--acp` | `runAcpHeadless`'s own exit code, verbatim | `commands/exec.ts:2473` |
| `--loop` | `loopExitCode(stoppedBy)`: `condition-met`/`max`→0, `budget`→7, `signal`→130, `stalled`/`error`→1 | `commands/exec.ts:373-387` |
| Live budget hard-cap kill (non-loop) | 7 (`BUDGET_KILL_EXIT_CODE`) | `lib/exec.ts:2061,2048` |
| `--device`, followed to completion | the remote's own exit code (read from the sidecar `.exit` file), or 1 if unknown | `commands/exec.ts:1484-1485` |
| `--device`, `--no-follow` or follow window closed | 0 locally; the remote run continues untethered | `commands/exec.ts:1469-1485` |

- **EXEC-IF-1 (MUST).** Exit code 7 MUST mean "budget-killed," never overloaded
  for any other failure — shared between the live watcher's hard-cap kill
  and a loop's budget stop, so CI/headless callers can tell it apart from an
  ordinary failure (`lib/exec.ts:2048`; `commands/exec.ts:379`, comment:
  *"mirrors BUDGET_KILL_EXIT_CODE."*).
- **EXEC-IF-2 (MUST).** Fallback/retry/handoff banners MUST print to stderr,
  never stdout, so a piped `agents run … | jq` stays parseable
  (`lib/exec.ts:2370,2423,2449`).
- **EXEC-IF-3 (SHOULD).** `--json` streams the underlying agent's own event
  format per `AGENT_COMMANDS[agent].jsonFlags` (`lib/exec.ts:663-921`) — the
  run layer does not normalize a single cross-agent JSON schema (contrast
  [Sessions](#sessions) EXEC-IF-1..4, which do normalize their own output).

---

### 5. Cross-platform parity matrix

| Guarantee | POSIX (macOS/Linux) | Windows |
|---|---|---|
| Spawn method | direct exec, no shell | shell-composed single command line (DEP0190-safe) for `.cmd`/non-absolute targets |
| Interactive tmux wrap (`%pane` addressing, re-attach) | yes | **no** — excluded outright |
| Version-home isolation via `buildExecEnv` | claude/codex/copilot/kimi | same 4 (via `execShimPassthrough` → `buildExecEnv`, EXEC-17) |
| Version-home isolation via generated shim script | +grok, +opencode (inline bash `export`) | **not replicated** — the `.cmd` delegate routes through `buildExecEnv` only |
| Command-line injection guard | not applicable (no shell) | `composeWin32CommandLine`, empty `args[]` (EXEC-41) |

---

### 6. Compatibility & stability guarantees

- **EXEC-COMPAT-1 (MUST).** `AGENT_COMMANDS[agent].modeFlags` keys MUST agree
  with `AGENTS[agent].capabilities.modes` — a test asserts this
  (`lib/exec.ts:660-661`); `buildExecCommand` throws an "Internal error" as
  defense-in-depth if they ever drift (`lib/exec.ts:1108`).
- **EXEC-COMPAT-2 (MUST).** `AGENT_LAUNCH_ID`, once minted or adopted, MUST stay
  the stable join key threaded through `options.env` for the lifetime of one
  launch — the pid-registry / hook-session-index reconciliation depends on
  it never changing mid-launch (`lib/exec.ts:396-399,1407-1409`).
- **EXEC-COMPAT-3 (MUST).** The `full` mode spelling MUST continue to be accepted
  as a permanent silent alias for `skip` (`normalizeMode`,
  `lib/exec.ts:50-58`) — not a deprecation to remove.
- **EXEC-COMPAT-4 (MUST).** `BUDGET_KILL_EXIT_CODE` (7) MUST stay in sync with
  `loopExitCode`'s `budget` mapping (`commands/exec.ts:379`; `lib/exec.ts:2048`)
  — EXEC-IF-1 depends on the two never diverging.

---

### 7. Non-goals & known gaps

**Non-goals (by design):**
- Not a cross-agent JSON schema normalizer — `--json` passes through each
  agent's native stream format (EXEC-IF-3).
- Not the secrets storage/materialization boundary itself — that contract is
  [§Secrets](#secrets); this spec only covers the run-time call site (§3.6).

**Known gaps (implemented-vs-intended drift to fix, not to paper over):**
- **EXEC-GAP-1.** `buildExecEnv` isolates only 4 of 16 registered agents
  (EXEC-16). `docs/concepts.md:87` reads as if `HOME` itself were swapped
  for every shimmed launch ("sets HOME to the matching version home before
  exec-ing the binary"); no literal `HOME=` assignment exists anywhere in
  the run engine (EXEC-15), and the doc's own claim is imprecise even for
  the shim it describes. Either wire the remaining 12 agents into
  `buildExecEnv` (so `agents run` and the shim path agree) or narrow the doc.
- **EXEC-GAP-2.** `--acp` bypasses every `buildExecEnv` guarantee (EXEC-20) — no
  `sanitizeProcessEnv`, no per-version isolation, no actor provenance, no
  mailbox/session wiring. This is undocumented as an isolation exception
  anywhere outside this spec.
- **EXEC-GAP-3.** Antigravity workflows and OpenCode auth are explicitly
  account-global, not per-version (`cli/AGENTS.md:150`;
  `lib/agents.ts:1410-1425`) — a deliberate, named exception to "isolated
  version home" — but `buildExecEnv`'s own doc comment only claims
  "Pins CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex, and
  COPILOT_HOME for GitHub Copilot" (`lib/exec.ts:403-405`), silent on Kimi
  (which it also handles) and silent on the 12 agents it doesn't.
- **EXEC-GAP-4.** A detached (`--no-follow`) `--device` run skips the local
  `recordDispatchedRun` audit funnel entirely — no call site records it
  (EXEC-21's four sites are all reachable only from a path that knows the
  exit code). The launcher exits before an outcome is known, so a
  `--no-follow` dispatch produces no local audit trail unless later
  reconciled through `agents hosts ps`/`logs`.

---

### 8. Given/When/Then scenarios

**GWT-E1 — `--env` wins the merge, `--secrets` wins over a profile.**
Given a profile that sets `MODEL=x` and a `--secrets prod` bundle that also
sets `MODEL=y`, plus `--env MODEL=z`; When `agents run claude "..." --secrets
prod --env MODEL=z` runs; Then the child sees `MODEL=z` — `--env` is applied
last in both the command-layer merge (`commands/exec.ts:2296-2304`) and
`buildExecEnv`'s own final spread (`lib/exec.ts:621-624`).

**GWT-E2 — Version-home isolation holds for claude.**
Given claude versions `2.1.90` and `2.1.196` both installed; When
`agents run claude@2.1.90 "..."` then `agents run claude@2.1.196 "..."` run
back to back; Then each sees a distinct `CLAUDE_CONFIG_DIR` pointing at its
own `<versionDir>/home/.claude` (`lib/exec.ts:424`) — no config bleed between
versions.

**GWT-E3 — The same isolation does NOT hold for grok via `agents run`.**
Given grok versions `1.0.0` and `1.1.0` both installed with no version-pinned
alias shim materialized on disk; When `agents run grok@1.0.0 "..."` runs;
Then `buildExecEnv` sets no `GROK_HOME` (its per-agent branch has no grok
arm, `buildExecEnv`, `lib/exec.ts:407-564`) and `buildExecCommand` resolves the spawn target
straight to the real npm binary (`lib/exec.ts:971-988`) — the run is not
version-isolated the way EXEC-2 promises for claude (EXEC-GAP-1).

**GWT-E4 — Single engine, one named exception.**
Given a plain headless run and an `--acp` run of the same agent+prompt; When
both execute; Then the plain run's child env is `buildExecEnv`'s output
(sanitized, isolated, actor-stamped) while the ACP run's child env is raw
`process.env` (`lib/acp/client.ts:68`) — the only two shapes a run's child
env can take, and the divergence is exactly the documented "Governance
chokepoint" bypass (EXEC-19, EXEC-GAP-2).

**GWT-E5 — Fallback cascades on a rate limit, never on an auth failure.**
Given `--fallback codex` and a primary claude run that exits 1 with "Invalid
authentication credentials" on stderr; When `runWithFallback` evaluates the
result; Then it returns claude's exit code directly without ever spawning
codex, because `detectRateLimit` does not match auth-failure text
(`lib/exec.ts:1977-1986,1698-1706`) — contrast a "5-hour limit" stderr, which
does cascade.

**GWT-E5b — Unpinned dispatch skips a logged-out default (PHNX-2685 / EXEC-ACCOUNT-5).**
Given claude `2.1.219` is the pinned default and logged out on this device,
and claude `2.1.187` is signed in on the same device; When `agents run claude
"..."` (no `@version`) resolves a version; Then `resolveRunVersion` returns
`2.1.187` under `pinned`, `available`, and `balanced`, and does not spawn
`2.1.219`. Given every installed version is logged out; When the same unpinned
run resolves; Then it fails loud with `exhausted` naming each version as
`signed_out` rather than launching the default.

**GWT-E5c — Absence of a usage signal is NOT capacity (PHNX-3392).**
Given a `balanced` pool on a worker box where no account can read
`/api/oauth/usage` (setup-token scope gap, RUSH-2392); When
`pickBalancedCandidate` scores the pool; Then an account whose weekly window is
unknown MUST NOT be scored as full-capacity (`capacityWeight`'s null arm is
`UNVERIFIED_WEIGHT`, floored at 1 — `lib/accounting/capacity.ts:24,38-46`), so
an unverifiable account MUST NOT outrank a verified-healthy one in a mixed pool,
yet an all-*blind* pool (no snapshots at all) still draws a pick. An all-*stale*
pool is the exception — see GWT-E5d. The missing signal MUST be
supplied by the daemon (a sanctioned SING-1a collector): headed daemons publish
one snapshot into their owned per-device file in the fleet-synced user repo,
the daemon automatically commits only that file and exchanges the repo under a
cross-process lock plus a 45-second process-tree deadline, and workers read the
delivered local mirror newest-wins (`usage-sync`) — NOT by peer SSH or a
fetch on the launch path, which MUST stay cache-only (SING-1a). A run that HITS
its weekly limit MUST also persist a `rate_limited`
`week` window (`lib/claude-statusline.ts:96`) so the next
`collectRunCandidates` sees it and `hasUsageAvailable` excludes the account
(`lib/accounting/rotate.ts:226-247`).

**GWT-E5d — Entirely stale usage is never auto-picked (PHNX-2526 / W3).**
Given a `balanced`/`available` pool where EVERY eligible account carries a usage
snapshot older than its freshness bar and none is verified
(the yosemite-s1 failing-refresh incident); When `resolveRunVersion` resolves a
version; Then it MUST NOT auto-pick on the stale number — it returns
`version: null` with `noVerifiedUsage: true` (`lib/accounting/rotate.ts`,
`preferVerified` computing `verified.length === 0 && pool.some(hasStaleUsage)`).
The freshness bar is `USAGE_DECISION_MAX_AGE_MS` (5 min) for a locally
captured row (`poll` / `statusline`) and `USAGE_SYNC_TRUST_MS` (the 15-minute
usage-sync cadence) for a row whose `freshness.source` is `sync` — a worker
that only ever sees poller-pushed rows MUST still auto-pick (D8).
An INTERACTIVE run (TTY, not `--json`/`--headless`) MUST then show the account
picker; an UNATTENDED run MUST fail loud with an error containing the literal
`NO_VERIFIED_USAGE` (`formatNoVerifiedUsageError`), for both `agents run`
(`commands/exec.ts`) and a daemon routine (`lib/daemon/runner.ts`). The stale
candidates MUST remain in `rotation.healthy` so bounded post-rejection failover
(`rotationFailoverChain`) still cascades across them — refusing to PICK a stale
account and refusing to FAIL OVER to it after a real 429 are different calls.
A pool that is merely BLIND (no snapshot at all — GWT-E5c) is NOT stale and
still draws a pick; `hasStaleUsage` requires a present, dated, windowed snapshot.

**GWT-E6 — `--device` forwards actor env, refuses `--secrets`.**
Given `agents run claude "..." --device workbox --secrets prod`; When the
command is built; Then it fails loud pre-dispatch with
`RUN_OPTION_REJECT_MESSAGES.secrets` (`lib/hosts/remote-cmd.ts:148-151`)
rather than silently resolving `prod` locally and shipping the values; a
retry without `--secrets` instead prepends `actorEnv(resolveActor())` as
shell exports ahead of the remote `agents run` invocation (EXEC-31).

**GWT-E7 — Windows spawn never lets the prompt reach a shell unescaped.**
Given a prompt containing `"; rm -rf /` and a Windows `.cmd`-wrapped agent;
When `spawnAgent` builds the child process; Then it calls
`composeWin32CommandLine(executable, args)` and passes an EMPTY `args[]` to
`child_process.spawn` (`lib/exec.ts:1935-1944`) — the prompt is embedded in
the single quoted command line, never concatenated by Node into an
already-open shell invocation.

**GWT-E8 — Budget kill and loop-budget-stop share one exit code.**
Given a `--budget 1000` run whose live stream-json usage crosses the cap
mid-run; When the watcher fires; Then `spawnAgent` sends `SIGTERM`/`SIGKILL`
and resolves exit code 7 (`lib/exec.ts:2061,2048`); given instead a `--loop
--budget 1000` run whose cumulative iteration spend crosses the same cap;
Then the driver stops with `stoppedBy: 'budget'` and `loopExitCode` maps it
to the same 7 (`commands/exec.ts:379`) — a CI caller can `if exit==7` for
"budget," regardless of which path produced it.

**GWT-E9 — A preset switch takes effect on the next `agents run`, no
explicit sync needed.**
Given `claude@2.1.111` already synced with rules preset `default`, and code
that calls `setActiveRulesPreset('claude', '2.1.111', 'cautious')` directly
(bypassing `agents rules switch`, which would itself trigger
`syncResourcesToVersion`); When `agents run claude@2.1.111 "..."` executes
next; Then `applyActiveRulesPresetAtRun` (EXEC-44) detects the preset-name
mismatch against its sentinel, recomposes from the `cautious` preset, and
overwrites `<versionHome>/.claude/CLAUDE.md` before the agent spawns — the
harness never launches against the stale `default`-preset file. A THIRD run
with no further preset or subrule change instead skip-fasts (EXEC-45): the
file's mtime is left untouched.

---

## Scheduling & execution singularity

The normative contract for **who may schedule and execute work** across the repo:
the CLI daemon and the commands it drives — never a UI surface. Requirement keywords
**MUST / MUST NOT / SHOULD / MAY** are per RFC 2119; scenarios are Given/When/Then.

### 1. Purpose & scope

A fleet-affecting feature that runs on a timer or watcher in two places fires twice:
two resume-tabs for one exhausted session, two executions of one cron job, two
injected nudges racing the same agent. This section makes that class of bug
unrepresentable. In scope: every capability that can **act** — launch, resume, kill,
or rotate a session; fire a routine or monitor; inject into a terminal; dispatch to
a host or the cloud. Out of scope: read-only polling that renders state for a human
(panels refreshing, presence heartbeats), which MAY live anywhere provided it writes
nothing but its own view cache.

### 2. Terminology

- **Fleet-affecting action** — any operation that mutates state on this machine or
  another fleet device: spawning or killing processes/sessions, injecting keystrokes,
  writing shared state (sessions.db, the device registry, agents.yaml), firing a
  scheduled job, SSH dispatch.
- **Scheduler** — whatever decides *when* to act: a cron routine, a daemon tick, a
  `setInterval`, a file watcher, an event subscriber acting autonomously.
- **Executor** — whatever performs the action once decided.
- **Thin wrapper** — a UI surface whose only relationships to a fleet-affecting
  capability are (a) rendering its state, and (b) invoking the CLI command that
  controls it (`agi-ext/AGENTS.md`, the root `AGENTS.md` §Core concepts).

### 3. Requirements

- **SING-1 (MUST).** Every fleet-affecting capability MUST have exactly one scheduler
  and one executor: the agi-cli daemon (`agents __daemon-run`,
  `cli/src/lib/daemon/daemon.ts`) or a CLI command the daemon or the user drives.
  Status: **Current** for routines (`lib/scheduler.ts`) and rotate
  (`lib/watchdog/rotate.ts`). `agents daemon` is the user-facing runtime
  surface for this singular process (`start`/`stop`/`restart`/`reload`/
  `status`/`services`/`logs`/`doctor`, `commands/daemon.ts`) — it observes and
  controls the one daemon SING-1 requires, never a second one. Usage and
  authentication health are first-party account state and run as one supervised
  `PeriodicService` (`lib/daemon/account-state-daemon-service.ts`, PHNX-3608 —
  previously an un-deadlined dual-`setInterval` in `lib/account-state-service.ts`,
  now removed) with a real per-tick deadline + AbortSignal so a hung usage refresh
  is abandoned and restarted instead of latching forever; explicit CLI refreshes
  enter the same cross-process per-account lease (`lib/refresh-coordinator.ts`). The
  watchdog, device-probe, session-cache-warm, and auto-dispatch ticks
  (RUSH-2353) were briefly promoted to **daemon-owned built-in routines**
  (`lib/builtin-routines.ts`, RUSH-2465) — declarations injected as the lowest
  layer of `listJobs()` so `agents routines list`/`pause`/`devices` could manage
  them like any other routine, each `command:` invoking the migrated tick body
  via `agents __daemon-tick <name>`. That registry was **reverted** (RUSH-2495):
  `builtin-routines.ts`, the `__daemon-tick` entrypoint, and `JobConfig.builtin`
  are gone. `watchdog` and `device-probe` reverted to plain hardcoded
  `setInterval`s inside `runDaemon()` at the time, then moved onto
  `ServiceSupervisor` as `WatchdogService`/`DeviceProbeService`
  (`lib/daemon/watchdog-service.ts`, `device-probe-service.ts`, RUSH-3193 P3);
  `session-cache-warm` now runs as the supervised `session-state` service
  (`lib/daemon/session-state-service.ts`, PHNX-3265): it owns the 15-second
  publish cadence and the reader-presence edge that requests an immediate
  supervised tick. All three are invisible to `agents routines`, but still the
  single daemon-owned scheduler/executor SING-1 requires, since nothing else
  calls them. `auto-dispatch` and `launch-health`
  were deleted outright with no replacement. **`tmux-reconcile`** (the 5-minute
  poll that retrofitted a stale `pane-died` hook onto managed tmux sessions) was
  also deleted, but — unlike `auto-dispatch`/`launch-health` — its job is
  covered without a poll (RUSH-2435): the daemon repairs every managed session's
  hook once at startup, `ensureSessionHookRepaired` (`lib/tmux/session.ts`)
  repairs a single session right before each of `agents run
  --resume`/`focus`/`go`/`tmux attach` attaches to it, and `runMigration`
  (`lib/installations/migrate.ts`) repairs the fleet again at upgrade time as the
  version-skew one-shot.
- **SING-1a (MUST).** Ordinary usage/auth consumers MUST be cache-only. This
  includes routing (`agents run` and teams), `view`, `versions`, device
  inventory, and UI consumers. A missing snapshot MUST render as stale or
  unavailable and MUST NOT trigger provider HTTP, credential refresh, or a local
  transcript scan. The daemon and an explicit user refresh are the only
  collectors, and both MUST use the same device-wide account lease.
- **SING-1b (MUST NOT).** OAuth credential files and refresh tokens MUST NOT be
  copied between devices. Each device uses the harness-native login flow;
  cross-device state is limited to safe account labels, auth verdicts, and usage
  snapshots. Named API-key/setup-token/bearer accounts retain device-local secret
  material and synchronized metadata.
- **SING-2 (MUST NOT).** A UI surface (agi-ext, the menubar app, the iOS app)
  MUST NOT own a timer, watcher, or loop that detects a condition and performs a
  fleet-affecting action. Detection and decision MUST live in the CLI, which holds
  the first-party state (sessions.db, usage snapshots, the device registry).
  Canonical violation: the ext watchdog rotate loop (2026-08-03) racing the
  daemon's view of account health; canonical fix: PR #1914, which deleted it.
- **SING-3 (MUST).** Where an action needs a UI-owned surface (typing into an editor
  tab, opening a tab), the UI MUST expose a narrow endpoint the CLI drives — the
  trigger MUST stay in the CLI. Precedent: the extension's `/inject` URI verb over
  `live-terminals.json`, driven by `cli/src/lib/terminal/inject.ts`; the
  terminal engine's vscodium launch backend.
- **SING-4 (MUST).** A control in any UI that turns a fleet-affecting capability on
  or off MUST flip the CLI's own state (`agents watchdog enable|disable|rotate`,
  `agents routines`), so every surface observes one truth. A UI-local toggle that
  gates only the UI's view of an action MUST NOT exist.
- **SING-4a (MUST).** A device-local `daemon.enabled: false` (`lib/device-config.ts`,
  `agents daemon disable`) MUST prevent every AUTO-start surface from bringing the
  daemon up — `ensureDaemonStarted` (`lib/daemon/daemon.ts`), every `routines`
  auto-start call site (`add`, `start`, `catchup`, webhook triggers,
  `commands/routines.ts`), and `monitors add` (`commands/monitors.ts`). It MUST NOT
  stop an already-running daemon and MUST NOT block the explicit override
  (`agents daemon start`), mirroring `systemctl disable` — a disabled unit still
  starts on a direct `systemctl start`. This is the daemon-wide sibling of
  `scheduler.enabled`: `scheduler.enabled` gates only the routines `JobScheduler`
  inside a running daemon (SING-5), while `daemon.enabled` gates whether the
  daemon itself may be auto-started at all (browser IPC and the watchdog with
  it — never a secrets broker, which the standalone `secrets` CLI owns, OWN-1).
- **SING-5 (MUST).** Routines MUST fire only from the daemon's pid-claimed
  `JobScheduler` (`lib/daemon/daemon.ts` — the pid-file claim exists precisely so a second
  scheduler cannot double-fire). A UI MAY request an immediate run
  (`agents routines run <name>` or equivalent) but MUST NOT hold its own cron,
  countdown, or "run every N" for a routine.
- **SING-5a (MUST).** A routine definition MUST describe only what runs and when.
  Per-device activation MUST be represented by membership in the top-level
  `routines:` list at `~/.agents/devices/<hostname>/agents.yaml`; membership means
  enabled and absence means disabled. A host MUST mutate only its own manifest,
  and fleet controls MUST execute the mutation on the target host. Definitions
  introduced as replacements for previously always-on daemon work MUST be added
  once to an existing device activation manifest during the upgrade migration.
  Routine definitions MUST NOT carry mutable `enabled:` or `devices:` activation fields. The same
  definition MAY be active on multiple devices when its input is device-local;
  shared-input work still requires the single-executor safeguards in SING-7.
- **SING-5b (MUST).** Every scheduled occurrence MUST have a deterministic UTC
  slot identity and MUST be atomically claimed before dispatch. Redelivery of the
  same `(routine, scheduledFor)` slot MUST resolve to the existing attempt and
  MUST NOT spawn a second process. Catch-up claims protect missed-fire recovery;
  they do not replace the ordinary scheduled-slot claim.
- **SING-5c (MUST).** A routine MUST NOT overlap itself across any entry point,
  including manual foreground, detached, cron, catch-up, webhook, host, fleet,
  and cloud execution. A losing request MUST produce an inspectable skipped result
  linked to the active run and MUST NOT spawn.
- **SING-5d (MUST).** Routine execution context MUST be resolved on the eventual
  execution target from the singular project anchor and portable `cwd`. Plural
  `projects` metadata and external `repo` identity MUST NOT affect the working
  directory. A proven path, trust, write, authentication, reachability, or
  placement blocker MUST leave the definition paused rather than defer failure to
  its next schedule.
- **SING-5e (MUST).** Run metadata MUST be allocated before pre-spawn work so every
  blocked, skipped, failed, timed-out, missed, and completed attempt remains
  inspectable without requiring an archived session transcript.
- **SING-5f (MUST).** The routine activation manifest of SING-5a governs ROUTINES
  only. A job a monitor synthesizes for its `run` action (`lib/monitors/dispatch.ts`)
  has no definition and no manifest membership, so it MUST NOT be gated on that
  manifest; its exactly-once ownership is the monitor's own `device:` pin
  (`monitorRunsOnThisDevice`, `lib/monitors/config.ts`), resolved before dispatch.
  The exemption MUST be carried by an explicit marker on the dispatched job
  (`dispatchedBy: 'monitor'`, read by `jobRunsOnThisDevice`, `lib/routines.ts`) and
  MUST NOT be inferred from whether a routine of that name exists. Monitor names
  MUST NOT be written into a device's routine manifest. A monitor's `routine`
  action fires a real routine and MUST still honour SING-5a: a routine defined but
  not activated on the firing device is refused. Landed (RUSH-2681); before it,
  every monitor `run` action recorded `skipReason: "wrong_owner"` with an empty
  allowlist and no action ever executed.
- **SING-6 (MUST).** A new fleet-affecting feature MUST be implemented in
  `cli` (daemon routine and/or command) first; the UI PR adds rendering and
  control wiring only. If the feature seemingly requires UI-side execution, SING-3
  applies — the UI grows an endpoint, the CLI keeps the trigger.
- **SING-7 (SHOULD).** Multi-instance safety SHOULD be structural, not by
  convention: pid-claimed singletons for daemon loops (the daemon's claim), leader
  election with lease handoff for any remaining UI-side coordination protocol
  (agi-ext `src/monitor/leader.ts` — presence fan-out only, not task
  execution), and idempotent effects so a redelivery is a no-op.
- **SING-15 (MUST).** A single scheduled fire MUST launch a routine at most once,
  even when the same UTC occurrence is evaluated by more than one timer callback,
  a restart replays `loadAll()` (`lib/scheduler.ts`), or a manual `catchup` overlaps
  the daemon pass. Uniqueness MUST be a structural claim on the occurrence identity
  `(routine, scheduledFor)`, not a soft in-memory guard. The **landed** precedent is
  the catch-up path: `claimMissedFire` (`lib/catchup.ts`) creates the run directory
  with a non-recursive `mkdir` — an atomic test-and-set — so the losing caller reports
  `already claimed by the scheduler` and never spawns a second agent
  (see [`automation.md`](automation.md)). Status: **Current** (PHNX-3215). The
  forward-timer path now claims the same way: the scheduler floors croner's jittered
  `currentRun()` to the aligned occurrence boundary (`fireSlot` → `alignedSlotForFire`,
  `lib/scheduler.ts`, `lib/scheduling/routines.ts`) and `allocateRoutineAttempt`
  (`lib/daemon/runner.ts:334`) atomically claims the run dir via `claimRunSlot` keyed on
  that `(routine, scheduledFor)`. Forward dispatch and catch-up share one derivation
  (`alignedSlotForFire`, which `previousExpectedFire` also delegates to), so a live fire
  and its missed twin for one UTC slot collide by construction. Before the fix the
  forward key was the jittered fire instant, so two deliveries of one occurrence minted
  distinct ids and both launched.
- **SING-16 (MUST).** The slot claim (SING-15 — "may this occurrence dispatch?") and
  the active-run claim (SING-13 — "is an instance of this routine already running?")
  MUST be distinct guards: a routine that overlaps itself (a long run still executing
  when the next slot arrives) is a different condition from one occurrence firing
  twice, and collapsing them into one lock makes each failure mode mask the other.
  Status: **Current** (PHNX-3215). `allocateRoutineAttempt` (`lib/daemon/runner.ts`)
  evaluates the slot claim (`claimRunSlot`, `:334`) and the active-run claim
  (`activeRoutineRun`, `:123`/`:354`) as two sequential, distinct guards.
- **SING-13 (MUST).** A routine MUST NOT overlap itself: while one run of a routine is
  in a non-terminal state (`running`), a newly-arriving occurrence MUST record a
  terminal `skipped` run linked to the active run (its `activeRunId`) rather than
  spawning a concurrent second instance, across every placement (`local`, `host`,
  `fleet`, `cloud`). Status: **Current** (PHNX-3215). `allocateRoutineAttempt`
  (`lib/daemon/runner.ts:354`) records a `skipped` run with `skipReason: 'active_run'`
  and `activeRunId` when `activeRoutineRun` finds a live prior run, spawning nothing.

#### 3.1 Multi-device — parallel daemons are fine, shared queues are not

Every fleet device runs its own daemon, and that is by design: scheduling fans out
across devices whenever the *work* is partitioned by device. The duplication hazard
is not two daemons existing — it is two daemons consuming the **same** input.

- **SING-8 (MUST).** An unrestricted routine (no `devices` allowlist) fires on every
  device running the scheduler (`lib/routines.ts` `devices` doc) and therefore MUST
  be per-device in scope: its input MUST be the firing device's own state (its
  repos, sessions, caches, accounts). `git-hygiene` on each device's own checkout is
  the canonical legal shape; the watchdog rotating its own machine's sessions is
  another.
- **SING-9 (MUST).** A routine or monitor that consumes **shared** input — a ticket
  tracker, a PR queue, the feed, an R2/sync bucket, another device's sessions —
  MUST have exactly one executor per work item, achieved one of three ways:
  (a) **owner pin** — `devices: [<one>]`, so `routineOwnerDevice`
  (`lib/routines.ts`) names the single daemon allowed to fire (a multi-device pin
  is a misconfiguration that fires only on the owner with a fix hint,
  `lib/scheduler.ts`); or (b) **atomic claim** — each item is claimed with an
  atomic primitive before work begins (precedent: the feed's `O_EXCL` block claim,
  `lib/feed.ts` — two concurrent claimers cannot both succeed); or
  (c) **idempotency** — a concurrent second execution of the same item is a
  verified no-op. `dispatch: fleet` (one online device picked per run,
  `lib/routines.ts`) satisfies (a) for dispatch targets.
- **SING-10 (MUST).** Where (b) or (c) is chosen, the claim or idempotency check
  MUST be part of the implementation, not a comment — shared-queue consumers
  without an owner pin ship with a test that two concurrent fires cannot process
  the same item.
- **SING-9a (MUST).** A **system built-in monitor** ships enabled on every install
  (PHNX-2506), so enabled-by-default MUST NOT itself grant fleet-wide firing for a
  shared-input built-in. An UNPINNED built-in (no `device` / `devices`) is placed
  on a single owner **in code** — `requiresSingleOwner` / `monitorRunsOnThisDevice`
  (`lib/monitors/config.ts`) treat a `scope: 'system'` monitor as shared-input
  unless it sets `sharedInput: false`, and fire it only on `monitorSharedInputOwner()`
  (the configured `interactive.host`, else the sole box on a single-device fleet,
  else NOWHERE). This is defense-in-depth: even a built-in whose shipped YAML forgot
  a `device:` pin cannot fan out across the fleet and double-fire on a shared queue
  (`pr-merge-on-green` is the canonical case). A device-local built-in (input = the
  firing box's own state) opts back into fleet-wide firing with `sharedInput: false`;
  a user monitor keeps its fleet-wide default and opts INTO owner-only with
  `sharedInput: true`.

#### 3.2 One daemon per state dir — last-wins takeover, not first-wins refusal

Singularity is scoped to the **state dir** (the daemon dir under `AGENTS_DAEMON_DIR`
or `<HOME>/.agents/.cache/helpers/daemon`), NOT the machine: one `HOME` may legitimately
run many daemons under different state dirs (a developer's daemon, a vitest fixture's
own `HOME`), and none of them contend. One state dir maps 1:1 to one logical daemon for
one user/configuration. Consequently, the casual product phrase "one daemon per device"
means one daemon for the state dir a human normally uses on that device, not literally
one `__daemon-run` process across every user, installation, or test fixture on the
machine. Within ONE state dir, the pid-file claim in SING-5 guarantees one scheduler;
SING-11/SING-12 fix *which* daemon survives and how the loser is torn down, so a second
install sharing that state dir can never leave two daemons. (RUSH-2352 originally read
four `__daemon-run` on one box as four duplicate schedulers; adversarial verification
refuted that — three ran under separate `HOME`s and never shared state. Last-wins is the
owner's product decision that a restart replaces the previous daemon, deliberately NOT
a machine-wide process sweep.)

- **SING-11 (MUST).** At most one daemon MUST be alive per state dir, enforced by
  **last-wins takeover**: a second `agents __daemon-run` for the same state dir — from
  ANY install path sharing it, not only the same launch entry — MUST evict the incumbent,
  never defer to it. The takeover target is the live owner of THIS state dir's pid file
  (`resolveLiveDaemonPid`) whose process command ends in `__daemon-run`, and nothing
  else — a reused pid belonging to an unrelated process MUST never be signaled. A daemon serving a DIFFERENT state dir
  (its own `HOME`, a test fixture) MUST be left completely untouched.
  `claimDaemonInstance` (`lib/daemon/daemon.ts`) SIGTERMs the live pid-file owner and MUST
  wait for it to be provably dead — its graceful `handleShutdown` releasing the
  browser IPC binding (`await browserIPC.stop()`), or a `killTree` escalation
  (POSITIVE pid, so the kill never
  reaches the incumbent's detached job children) after the grace window —
  **before binding any of its own resources**. (The daemon no longer hosts a
  secrets broker socket to release — the standalone `secrets` CLI owns its own
  broker lifecycle, OWN-1; the historical two-brokers-on-one-socket takeover
  orphan this ordering guarded against can no longer occur.) The pid file MUST
  NOT be written until the prior owner is dead.
  `reapStrayDaemons` (`lib/daemon/daemon.ts`) reaps only registrants of THIS state dir's
  instance registry (`<daemonDir>/instances/`) — because the registry lives inside the
  daemon dir, a different state dir's daemons register elsewhere and are invisible, so
  the reaper is state-dir-scoped by construction, never `process.argv[1]`-scoped and
  never a machine-wide `ps` sweep. It MUST wait for SIGTERM death, escalate to
  `killTree` after the grace window, wait again, and retain the marker if the
  process still survives; signaling once and deleting the only marker is not a
  reap. This INVERTS the historical first-wins behavior, where
  the incoming daemon logged `Another daemon already owns the pid file` and exited,
  leaving the incumbent (however stale) running.
- **SING-11a (MUST).** In-flight detached routine children (`runner.ts`'s `unref`'d
  spawns, which run in their own process group and survive daemon death) MUST NOT
  be killed by takeover — severing a live agent mid-run is worse than a daemon
  restart. The evicting SIGTERM/`killTree` reaches only the incumbent daemon's pid,
  never those children, and the new daemon adopts them by construction: its
  `monitorRunningJobs` (`runner.ts`) reconciles every `running` on-disk run record
  by pid liveness (`isPidOurs`), never by which daemon spawned it, so a live child
  is picked back up on the next tick.
- **SING-11b (MUST).** Every daemon-owned process MUST be leak-free across every
  daemon death mode, including graceful shutdown, takeover, SIGKILL, OOM-kill, and
  machine restart. A later daemon invocation MUST either prove the recorded pid is
  still the intended live process and adopt it, or reap the dangling daemon, browser,
  tunnel, or keychain-helper process without targeting an unrelated or detached routine
  process. The recovery layers are the state-directory lifetime self-check
  (`lib/daemon/daemon.ts:925-957`), the state-directory-scoped daemon registry and
  `reapStrayDaemons` (`lib/daemon/daemon.ts:348-394`), browser/tunnel orphan reaping
  (`lib/daemon/daemon.ts:800-815`), the keychain helper reaper's pid/start-time identity
  checks (`lib/secrets/reaper.ts:20-40`, `lib/secrets/reaper.ts:68-101`), and the
  orphaned-`watch-lock` reaper (RUSH-2419) that recovers the one deliberately
  long-lived helper when its owning daemon is provably dead
  (`lib/secrets/reaper.ts:156-180`, wired into the reap tick at `lib/daemon/daemon.ts:911`).
  Every daemon-owned process class — daemon, browser, tunnel, and keychain helper
  including the `watch-lock` watcher — has a recovery layer.
- **SING-11c (MUST).** A daemon spawned by the test suite MUST NOT run its scheduler
  against the operator's real state. Where SING-11b reaps a leaked test daemon *after
  the fact*, this is the *boot-time* preventive guard for the same class (PHNX-2545,
  the routines suite leaving real `__daemon-run` processes alive on a fleet box): the
  test-daemon spawn sets `AGENTS_DAEMON_TEST_HOME` to the isolated home it provisioned,
  and `runDaemon` (`lib/daemon/daemon.ts`, `assertTestDaemonHome`) MUST — before it
  claims an instance, writes a pid, or fires any tick — refuse to boot when its resolved
  state dir does not sit under that home, i.e. when the isolated `HOME` override failed
  to reach the child and the daemon would otherwise schedule against the real host. The
  marker is never set in production, so the guard is a no-op there. The routines
  daemon-spawn helper (`commands/routines.test-fixture.ts`, `startIsolatedDaemon`) sets
  the marker, and the per-file leak detector it registers (`registerLeakDetector`)
  remains the after-the-fact backstop for a worker killed before its own `finally`.
- **SING-12 (MUST).** `stopDaemon` (`lib/daemon/daemon.ts`) MUST assert its postcondition,
  not assume it. The full read → signal → verify → cleanup transaction MUST hold the
  same `<daemonDir>/daemon.lock` used by start/claim, and every direct signal MUST
  revalidate that the pid is a live `__daemon-run`. After the SIGTERM → grace → `killTree` sequence it MUST verify the
  browser IPC binding was released and no `__daemon-run`
  registered for THIS state dir survives — reclaiming any stale socket an ungraceful
  exit left behind. (There is no secrets broker socket in this inventory — the
  standalone `secrets` CLI owns its own broker, OWN-1.) It MUST return a structured result naming what released, what
  survived, and any detached children (which survive deliberately per SING-11a and are
  reported, never killed). `agents daemon stop` MUST surface that result (human summary
  plus `--json`) and exit non-zero when a resource could not be released. It MUST NOT
  report success on an unverified stop (RUSH-2355). PID and socket cleanup is
  ownership-checked: a successor pid value or replacement socket inode is left
  untouched even if it appears during teardown. The stale-socket reclaim proof MUST
  NOT depend on a live pid resolving: the browser IPC binding's inode is captured
  independently of `resolveLiveDaemonPid`, so a daemon that dies between the CLI
  liveness precheck and the locked read — leaving `resolveLiveDaemonPid` null but its
  ungraceful binding on disk — still has that socket reclaimed once no live daemon
  (the signalled target OR any surviving successor for this state dir) is proven to
  own it, rather than being reported as ownership-unverifiable and leaked (PHNX-3618).
- **SING-12a (MUST).** A clean daemon shutdown MUST enumerate and release the full
  state-directory resource inventory: the browser IPC socket, the daemon pid
  registration, the lifetime marker file, the heartbeat file, and the daemon's
  instance-registry entry. (The secrets broker socket is no longer in this
  inventory — the standalone `secrets` CLI owns its own broker, OWN-1.) The
  shutdown postcondition MUST name any
  survivor and MUST NOT report success merely because the daemon process exited. The
  graceful path already attempts all five releases in `handleShutdown`;
  `stopDaemon` independently verifies the full inventory
  via `stopResidueArtifacts`, consumed on both the graceful and escalated `killTree` paths, and
  distinguishes residue from a provably dead owner (reclaimed) from state belonging to
  a live successor (left untouched) the same way the browser IPC socket branch does
  (RUSH-2421, SING-GAP-5 resolved).
- **SING-12b (MUST).** Only the explicit operator lifecycle surface
  (`agents daemon start|stop|restart`) MAY deliberately stop or restart the shared
  daemon. A short-lived client for one hosted capability MUST change only its own
  service state and signal reload; it MUST NOT call `stopDaemon` or restart the
  process to reconcile its client version, recover a socket, or implement a
  feature-scoped `start|stop`. Browser client/daemon skew is advisory, browser
  `stop --service` toggles only `browser-ipc`, and routines `start|stop` toggles
  only `scheduler`; each preserves the daemon PID and all sibling services
  (PHNX-3605).
- **SING-14 (MUST).** Supervised daemon restart MUST be bounded. A permanently failing
  daemon start MUST NOT cycle through unbounded rapid retries: the service manager MUST
  enforce a restart interval and burst limit, and `ensureDaemonStarted` MUST stop
  initiating starts after a bounded number of consecutive failures until the circuit
  breaker resets. `generateLaunchdPlist` sets `ThrottleInterval` (`lib/daemon/daemon.ts:1117`)
  and `generateSystemdUnit` sets `StartLimitIntervalSec`/`StartLimitBurst`
  (`lib/daemon/daemon.ts:1154-1155`); `isDaemonAutostartCircuitOpen` (`lib/daemon/daemon.ts:1253-1261`)
  is the `consecutiveFailures`-driven circuit breaker `ensureDaemonStarted` consults,
  and `index.ts:255-256` adds top-level `uncaughtException`/`unhandledRejection`
  handlers so a startup crash always reaches the now-throttled supervisor rather than
  hanging (RUSH-2418, SING-GAP-6 resolved).
- **SING-17 (MUST).** Public webhook ingress MUST be a `ServiceSupervisor`-managed daemon-hosted
  service, not an unsupervised process. The `webhook-receiver` service
  (`lib/daemon-services.ts`) binds one signed receiver per entry in
  `~/.agents/daemon/webhooks.yaml` (`lib/daemon-webhooks.ts`,
  `startHostedWebhookReceivers`), wrapped by `WebhookReceiverService`
  (`lib/daemon/webhook-receiver-service.ts`) so each
  receiver's signing secret resolves headlessly through the standalone `secrets`
  CLI (`resolveReceiverSecrets`, `agentOnly: true` per SEC-13, via
  `secrets-client.ts` — OWN-1, no daemon-hosted broker) — no
  `AGENTS_SECRETS_PASSPHRASE` and no `nohup`. Every receiver MUST be torn down on
  shutdown (`handleShutdown`, `lib/daemon/daemon.ts`). A box that declares no receiver
  MUST bind nothing. A receiver whose bundle is locked or carries neither
  `GITHUB_WEBHOOK_SECRET` nor `LINEAR_WEBHOOK_SECRET` MUST fail LOUD — logged and
  skipped, never bound with an unverifiable signature — and MUST NOT take the
  other receivers down with it. Declarations are per-box operational state and
  are managed with `agents daemon webhooks add|list|remove`
  (`commands/daemon.ts`), keyed by bind port (RUSH-2548).
- **SING-18 (MUST).** A webhook receiver MUST acknowledge a verified delivery
  BEFORE dispatching it. Once a delivery passes signature verification,
  freshness, dedup, and rate limiting, `startWebhookServer`
  (`lib/triggers/webhook.ts`) MUST write `202 {ok, accepted, deliveryId}` and
  dispatch afterwards: dispatch starts an agent run (15-20s) and MUST NOT hold
  the socket past a sender's delivery timeout. The dedup ledger MUST be
  unchanged by this — `<source>:<delivery-id>` remains the key, a settled
  delivery MUST still answer `200 {duplicate:true}`, per-job `markJob` MUST still
  let a retry finish only the matches that failed, and a delivery MUST be marked
  complete only after it settles. A retry arriving while the first is still
  settling MUST be answered as a duplicate. Because no HTTP status can carry a
  post-ack failure, one MUST be surfaced — `webhook.failed` plus the
  `onDeliveryError` hook the daemon host and `agents webhooks serve` both log
  (RUSH-2548).
  **A post-ack dispatch failure is terminal until a manual redelivery**, and the
  ack is what makes it so: the receiver used to answer 4xx on a dispatch failure,
  which is what made GitHub/Linear retry and let the per-job ledger finish the
  matches that failed. A sender does not retry a 202, so the ledger is intact but
  nothing triggers it on its own. This is the accepted cost of not timing out
  every delivery; the failure is loud in the log and the delivery stays unmarked,
  so re-sending it from the provider's UI still completes only what did not run.
  Closing this gap with an in-process retry of the unmarked jobs is
  **WEBHOOK-GAP-1**, below.

### 4. Given/When/Then scenarios

- **GIVEN** a box declares a receiver in `daemon/webhooks.yaml` whose secrets
  bundle is locked, **WHEN** the daemon starts, **THEN** that receiver is skipped
  with a WARN naming the bundle and does not bind, while any other declared
  receiver still binds (SING-17,
  `lib/daemon-webhooks.test.ts` "fails a receiver LOUD when its signing secret
  cannot be resolved").
- **GIVEN** a signed Linear delivery whose matched routine takes 15-20s to
  dispatch, **WHEN** it is received, **THEN** the `202` ack is written while the
  dispatch is provably still in flight, and a retry of the same delivery id in
  that window is answered as a duplicate rather than dispatched again (SING-18,
  `lib/triggers/webhook.test.ts` "acks a signed delivery before the agent
  dispatch completes").
- **GIVEN** a session hits its weekly account limit, **WHEN** the daemon watchdog
  tick detects it, **THEN** the daemon alone decides and executes the rotate (or the
  skip) — no UI surface fires a second rotate for the same session.
- **GIVEN** a daemon already owns the pid file, **WHEN** a second `agents __daemon-run`
  starts — from the same install or a different one — **THEN** last-wins takeover
  makes the newcomer the survivor: `claimDaemonInstance` SIGTERMs the incumbent,
  waits for it to be provably dead (releasing its broker + browser IPC), then binds,
  so exactly one daemon is ever alive and no two `JobScheduler`s run concurrently
  (`lib/daemon/daemon.ts`, SING-11). The first-wins path where the newcomer exited and left
  the incumbent running is gone.
- **GIVEN** the incumbent daemon has an in-flight detached routine child running,
  **WHEN** takeover evicts that daemon, **THEN** the child survives (a different
  process in its own group) and the new daemon adopts it via `monitorRunningJobs`
  pid-liveness reconciliation — takeover never kills a live agent mid-run
  (SING-11a).
- **GIVEN** a daemon is killed by SIGKILL or the OOM killer, or its machine restarts,
  **WHEN** the next daemon invocation starts, **THEN** SING-11b requires it to adopt
  live intended children and reap stale daemon, browser, tunnel, and keychain-helper
  processes by recorded identity, leaving no dangling pid or orphaned process.
- **GIVEN** a wedged daemon that ignores SIGTERM, **WHEN** `agents daemon stop` runs,
  **THEN** stop escalates to `killTree` after the grace window, then VERIFIES the
  browser IPC binding released and no `__daemon-run` survives, and
  returns a structured result (exit non-zero if any resource could not be released),
  reporting surviving detached children rather than pretending the tree is clean
  (SING-12).
- **GIVEN** a daemon owns all five state-directory resources, **WHEN** graceful shutdown
  completes, **THEN** the browser IPC socket, pid registration,
  lifetime marker, heartbeat, and instance-registry entry are all absent or released;
  any survivor is named and makes the stop fail (SING-12a).
- **GIVEN** the daemon exits immediately on every supervised start, **WHEN** launchd,
  systemd, or a background-adjacent caller attempts to restart it, **THEN** the
  service-manager burst limit and `ensureDaemonStarted` circuit breaker stop rapid
  retries after a bounded number of consecutive failures (SING-14).
- **GIVEN** a user disables a fleet-affecting capability from the ext's command palette,
  **WHEN** the command completes, **THEN** the CLI's config is the state that
  changed (`agents watchdog rotate off`), and the daemon, the menubar, and every
  other surface observe the same off state.
- **GIVEN** a limited session lives in an AGI EXT editor tab, **WHEN** the daemon
  rotates it, **THEN** the daemon drives the extension's `/inject` endpoint to act
  in that tab — the extension performs no detection or decision of its own.
- **GIVEN** a contributor adds a `setInterval` in agi-ext, **WHEN** the
  callback performs anything beyond read-only rendering, **THEN** code review MUST
  flag it under the root `AGENTS.md` §Code review conventions ("No second
  scheduler") and the action MUST move to the CLI before merge.
- **GIVEN** a routine like `git-hygiene` that sweeps each device's own checkout,
  **WHEN** it is left unrestricted, **THEN** every device's daemon fires it and
  each fire touches only its own machine — legal fan-out under SING-8, no
  coordination needed.
- **GIVEN** a routine that drains a shared tracker (e.g. `drain-linear-cli`),
  **WHEN** two devices' daemons both fire it, **THEN** SING-9 requires exactly one
  executor per item: the routine is owner-pinned to one device (the current
  configuration), or each ticket is claimed atomically before work, or processing
  the same ticket twice is a verified no-op — never "both daemons pick the same
  ticket and run it twice."

### 5. Known gaps

- **SING-GAP-2 (resolved, RUSH-2353).** `auto-dispatch` — the tick that polls Linear
  for delegated tickets and dispatches an agent — was a hardcoded daemon
  `setInterval` with no `devices` allowlist, so it violated SING-9: every daemon on
  a fleet running the same opted-in project independently polled and could dispatch
  the same ticket. It is now the shipped `auto-dispatch` system routine, which
  satisfies SING-9(a) via an owner pin: `agents routines devices auto-dispatch --set
  <device>`.
- **SING-GAP-1.** The AGI EXT monitor leader/follower protocol
  (agi-ext `src/monitor/`) still coordinates presence fan-out inside the
  extension with its own election. It performs no fleet-affecting action today
  (post-#1914 it broadcasts read-side snapshots only), so it satisfies SING-2, but
  it is a second coordination fabric where the daemon's presence tracking
  (`lib/session/presence.ts`) would be the singular home. Informative; a future
  consolidation SHOULD retire it in the daemon's favor.
- **SING-GAP-3 (resolved, PHNX-3215).** The primary scheduled-dispatch path now carries
  a durable per-occurrence claim of its own (SING-15 Current), the slot claim and the
  active-run claim are separated (SING-16 Current), and self-overlap records a `skipped`
  run (SING-13 Current). The forward-timer path floors croner's jittered `currentRun()`
  to the aligned boundary (`fireSlot` → `alignedSlotForFire`, `lib/scheduler.ts`) and
  claims the run dir atomically (`claimRunSlot`, `lib/daemon/runner.ts:334`) keyed on
  `(routine, scheduledFor)` — the same derivation catch-up's `missedRunId` uses (both via
  `alignedSlotForFire`), so a live fire and its missed twin for one UTC slot collide by
  construction. Before the fix, two timer callbacks for one occurrence — or a live fire
  and its catch-up twin — were keyed on the jittered instant and did not collide; the
  guard was in-memory only. The run-status contract for the `skipped` overlap record is
  RT-6/RT-7 below.
- **SING-GAP-4 (resolved, RUSH-2419).** SING-11b's leak-freedom guarantee once held for
  every recovery layer except the keychain `watch-lock` watcher (`lib/secrets/agent.ts:833`,
  `:915`): `isReapableHelperCommand` (`lib/secrets/reaper.ts:249-254`) permanently excludes
  it from the periodic keychain reaper, so an OOM-kill, a raw SIGKILL, or the daemon's own
  `killTree` escalation of a wedged daemon left it orphaned with no automatic recovery. The
  daemon now runs a separate orphaned-`watch-lock` reaper path (`planKeychainReap`,
  `lib/secrets/reaper.ts:156-180`, wired into the reap tick at `lib/daemon/daemon.ts:911`), gated
  by `isWatchLockHelperCommand` (`lib/secrets/reaper.ts:262`): it kills a `watch-lock` only
  when the owning daemon is provably absent from the `ps` snapshot (`ppid === 1`, or the
  parent pid missing), behind the `ORPHAN_GRACE_SEC` grace and a fail-closed start-time
  fingerprint. The live-daemon exclusion is re-asserted on that path
  (`lib/secrets/reaper.ts:170-172`), so auto-lock-on-sleep for a running daemon is
  untouched; `lib/secrets/reaper.test.ts:347-354` covers the predicate.
  (Historical: `lib/secrets/agent.ts` and `lib/secrets/reaper.ts` were deleted with the
  embedded engine (PHNX-3989); the standalone `secrets-cli` now owns its own broker's
  reap/leak-freedom guarantee — see `secrets-agent-process-model.md`.)
- **SING-GAP-5 (resolved, RUSH-2421).** SING-12a's shutdown postcondition once verified
  only the browser IPC socket, the secrets broker socket, and pid registration — not the
  lifetime marker, heartbeat file, or instance-registry entry, which `handleShutdown`'s
  graceful path releases but the escalated (`killTree`) path left stale with no
  postcondition check. `stopDaemon` now runs `stopResidueArtifacts`
  (`lib/daemon/daemon.ts:1596-1640`) unconditionally on both paths, reclaiming residue from a
  provably dead owner and leaving alone anything a live successor owns
  (`daemon.registry.test.ts` covers both the escalated-reclaim case and the
  live-owner-protection case). Both socket teardowns awaited the real `net.Server` `'close'` event instead of
  firing and forgetting: the secrets broker via `closeServerBounded` (now historical —
  `lib/secrets/agent.ts` was deleted with the embedded engine, PHNX-3989; the daemon no
  longer owns a broker socket to close) and the browser IPC server via
  `BrowserIPCServer.stop` (`lib/browser/ipc.ts:284-295`, bounded by
  `IPC_CLOSE_TIMEOUT_MS = 5_000` at `ipc.ts:19`, RUSH-2421, still current).
- **SING-GAP-6 (resolved, RUSH-2418).** SING-14's restart bound was previously
  unenforced: `generateLaunchdPlist` set `KeepAlive` with no `ThrottleInterval`,
  `generateSystemdUnit` set `Restart=always` with no `StartLimitIntervalSec`/
  `StartLimitBurst`, and `ensureDaemonStarted` had no circuit breaker reading
  `consecutiveFailures` — so a daemon that failed on every startup restarted in an
  unbounded ~10s cycle. `generateLaunchdPlist` now sets `ThrottleInterval`
  (`lib/daemon/daemon.ts:1117`), `generateSystemdUnit` sets `StartLimitIntervalSec`/
  `StartLimitBurst` (`lib/daemon/daemon.ts:1154-1155`), and `isDaemonAutostartCircuitOpen`
  (`lib/daemon/daemon.ts:1253-1261`) gates further auto-starts once
  `DAEMON_AUTOSTART_FAILURE_LIMIT` consecutive claims have failed, reported by
  `agents daemon doctor`/`status`. `index.ts:255-256` adds top-level
  `uncaughtException`/`unhandledRejection` handlers so a crash during startup always
  exits deterministically into the now-throttled supervisor instead of hanging.
- **WEBHOOK-GAP-1 (RUSH-2548).** SING-18's ack-before-dispatch removed the 4xx that
  used to make a sender retry a failed dispatch, and nothing replaced it. The
  per-delivery ledger still records exactly which matched jobs completed
  (`markJob`, `lib/triggers/webhook.ts`) and a failed settle leaves the delivery
  unmarked, so a retry would still finish only what did not run — but a sender does
  not retry a 202, so only a manual redelivery from the provider's UI reaches it. A
  routine whose `executeJobDetached` fails (missing agent binary, full disk) is
  therefore logged (`webhook.failed` + the host's WARN) and then simply does not
  run. Closing this needs an in-process retry of the unmarked jobs on the receiver
  side; the trade was taken deliberately because the alternative — holding the
  socket for the whole agent run — timed out every real delivery.

---

## Routine execution & readiness

The normative contract for **how a routine resolves its execution context, proves it
is runnable, and records what happened** — the reliability half of routines, distinct
from the scheduling-singularity half above (who may fire them). The how-it-works
companion is [automation.md](automation.md). Requirement keywords
**MUST / MUST NOT / SHOULD / MAY** are per RFC 2119; scenarios are Given/When/Then.

Most of this section is the target contract from the routine reliability plan
(RUSH-2290) and is marked **[Intended]** with a `-GAP-` reference; the landed
guarantees are marked **Current**. A routine's YAML today carries `agent`/`workflow`/
`command`, `schedule`/`trigger`, `projects` (grouping), `devices` (activation),
`source` (provenance), and `catchup` (`lib/routines.ts:151` `JobConfig`); it does
**not** yet carry a singular `project` anchor or a routine-level `cwd`, and `RunMeta`
(`lib/routines.ts:411`) does not yet carry `blocked`/`skipped` statuses or the
readiness/context fields RT-1..RT-8 describe.

### 1. Grouping vs anchor — two different `project` concepts

- **RT-1 (MUST).** `projects` (plural) is **grouping metadata only**: it organises a
  routine under a project group in `agents routines list` and the menu bar and MUST
  NOT affect scheduling or execution — the special value `["*"]` means "all defined
  projects" (`lib/routines.ts` `normalizeProjects`; see
  [`automation.md`](automation.md)). `projects[]` MUST NOT be silently promoted
  into an execution context. Status: **Current**.
- **RT-2 (MUST, [Intended]).** A routine's **execution anchor** is a distinct singular
  concept — a `project` field (one named `agents projects` entry) resolved to a base
  directory on the execution target, surfaced on the CLI as `--project-anchor <name>`
  so it can never be confused with the repeatable grouping flag `--project`. The
  plural grouping list and the singular anchor MUST remain separate fields with
  separate flags. Status: **[Intended]** (see RT-GAP-1); today only the `projects`
  grouping list and `--project`/`--all-projects` exist (`commands/routines.ts` `add`).

### 2. Context resolution happens on the execution target

- **RT-3 (MUST, [Intended]).** The working directory a routine's body runs in MUST be
  resolved **on the device that will execute it**, never from the daemon that fired it
  — a `fleet`/`host`/`cloud`-placed run resolves against the *target's* filesystem and
  `$HOME`, so a path that exists on the firing box but not the target is caught as a
  readiness blocker, not a silent wrong-directory launch. Resolution MUST follow this
  table, and a configuration with no usable directory MUST pause rather than fall back
  to an implicit home for an agent/workflow body (RT-5):

  | Configuration | Resolved directory | Readiness |
  |---|---|---|
  | `project` anchor with a usable base, no `cwd` | project base path | continue |
  | `project` anchor + relative `cwd` | base joined with `cwd`, if inside the base | continue |
  | Rootless `project` (e.g. a Linear-imported project with no local checkout) + relative `cwd` | target `$HOME` joined with `cwd`, if it exists | continue |
  | No `project` + relative `cwd` | target `$HOME` joined with `cwd`, if it exists | continue |
  | Absolute `cwd` outside `$HOME` | — | **pause** (`cwd_not_portable`) for portability |

  Status: **[Intended]** (see RT-GAP-1). The landed shape today is `remoteCwd` for
  `host`/`fleet` body placement only (`lib/routines.ts:238`, validated at
  `lib/routines.ts:1055`), with no anchor/readiness resolver.
- **RT-4 (MUST, [Intended]).** A **`command`** routine (a plain shell body, no agent,
  no sandbox — `lib/routines.ts:166`) MAY default to the target `$HOME` when it has no
  anchor or `cwd`: deterministic housekeeping (`git pull`, `npm i -g`, a notify) is
  home-relative by nature. An **`agent`** or **`workflow`** routine MUST NOT — see
  RT-5. Status: **[Intended]** (see RT-GAP-1; the `command` body is Current, the "may
  default to home" readiness rule is [Intended]).

### 3. Readiness — a proven blocker saves the routine paused

- **RT-5 (MUST, [Intended]).** `agents routines add` and `edit` MUST verify readiness
  before activating a routine, and a **proven** blocker MUST save the definition in the
  **paused** state carrying the exact failing check, rather than activating a routine
  that will fail at fire time. Readiness codes MUST be machine-readable and stable —
  at minimum `project_not_found`, `project_path_missing`, `cwd_missing`,
  `cwd_not_portable`, `codex_workspace_untrusted`, `agent_auth_failed`, and
  `execution_context_missing` (an `agent`/`workflow` routine with no anchor and no
  `cwd`). Auth readiness MUST be a real headless authenticated smoke, not a cache read
  (the cache-only check is why a dead account passed add-time and failed at fire —
  RUSH-2290 findings). A readiness check MUST NOT introduce a sandbox bypass or an
  automatic login. Status: **[Intended]** (see RT-GAP-1). Landed today: activation is
  already separate from the definition (a paused state is representable — SING-5a,
  device-manifest membership), and `--disabled` creates a routine paused
  (`commands/routines.ts` `add`); the readiness *verification* and the pause-on-blocker
  behaviour are not yet implemented.
- **RT-9 (MUST, [Intended]).** `agents routines resume <name>` MUST re-run the readiness
  checks and refuse to activate a routine whose blocker is still present — resume MUST
  NOT be a way to bypass readiness. Status: **[Intended]** (see RT-GAP-1); the `resume`
  command exists (`commands/routines.ts` `resume`) but performs no readiness recheck.
- **RT-10 (MUST, [Intended]).** A raw edit of the routine YAML (hand-editing the file,
  or `agents routines edit`) MUST be atomic against the live definition: parse and
  validate a temporary copy, then atomically replace, so an invalid edit leaves the
  prior bytes untouched and a valid-but-unready edit replaces the definition **and**
  pauses it. Status: **[Intended]** (see RT-GAP-1).
- **RT-12 (MUST).** At **fire** time, before spawning a routine's body, the daemon MUST
  preflight the resolved account's sign-in and, when it is **provably** signed out
  (auth-health verdict `revoked` or `unconfigured` for the rotation-resolved
  `(agent, version)`), record a terminal **`blocked`** run with readiness
  `agent_auth_failed` and a version-targeted re-login repair — never a spawned run that
  401s and lands as `failed` (RT-7: a dead account is a different operational state from
  a body that ran and threw). Unlike the add-time smoke (RT-5), the fire-time check is
  **cache-only** (the daemon-warmed auth-health cache, `readAuthHealth`): a live network
  smoke on every fire would risk a 429 storm and add latency to every tick. It MUST fail
  **open** on any non-blocking or missing verdict (`live`/`rate_limited`/`unverified`/
  `expired`/`error`/absent), so a stale or absent probe never wedges a routine.
  Implemented in `fireTimeAuthReadiness` (`lib/routine-readiness.ts`), called from
  `executeJob`/`executeJobDetached` after rotation resolves the account
  (`lib/daemon/runner.ts`). Status: **Current** (PHNX-3415).

### 4. Run history owns attempts; statuses distinguish outcomes

- **RT-6 (MUST).** Every routine attempt MUST be recorded as a `RunMeta` under
  `.history/runs/<routine>/<run>/` (`lib/routines.ts` `writeRunMeta`), and that run
  history — not the session transcript index — MUST be the canonical record of what a
  routine did. Sessions, logs, reports, and artifacts are **optional linked children**
  of a run: a routine that failed before any agent session started (bad placement,
  untrusted sandbox, dead account, dispatch failure) still owns a terminal run that is
  visible in `agents routines runs`, even though it has no session. Status: **Current**
  for run-first history (`missed`/`failed` runs exist with no session,
  see [`automation.md`](automation.md)); **[Intended]** for the pre-session
  readiness-failure runs (RT-5) and the menu History surface that renders them.
- **RT-7 (MUST).** `RunMeta.status` MUST distinguish, at minimum:
  `running`, `completed`, `failed` (the body ran and errored), `timeout`, `missed`
  (a scheduled fire the daemon never got to — SING-15), `blocked` (readiness failed,
  no body ran — RT-5), and `skipped` (the routine was already running, self-overlap —
  SING-13). `blocked` and `failed` MUST NOT be collapsed: a routine that never ran
  because its account was dead is a different operational state from one whose body
  ran and threw. Status: **Current** (PHNX-3215). The full union — including `blocked`
  and `skipped` (with `skipReason` ∈ `duplicate_slot`/`active_run`/`wrong_owner` and
  `activeRunId`) — is on `RunMeta` (`lib/scheduling/routines.ts:782`) and written by
  `allocateRoutineAttempt`/`writeTerminalRecord` (`lib/daemon/runner.ts`).
- **RT-8 (MUST).** `repo` on a routine is an **external identity** — the GitHub
  `owner/repo` a webhook trigger filters on (`JobConfig.repo`, `lib/routines.ts:174`)
  and the origin remote recorded as provenance when a routine is materialised from a
  project (`JobSource.repo`, `lib/routines.ts:57`) — and MUST NOT be treated as a local
  working directory. The local execution directory is the anchor/`cwd` of RT-3; the
  Git/cloud/webhook `repo` identity is separate and MUST stay separate. Status:
  **Current**.

### 5. Menu bar stays read-only for scheduling

- **RT-11 (MUST).** The menu-bar helper MUST consume routine and run state as JSON for
  display only and MUST NOT own any scheduling: it renders `agents routines`/run
  history and MAY offer a control that *requests* an immediate run or a pause
  (a user click invoking the CLI), but it MUST NOT hold a cron, countdown, or
  readiness loop of its own. This is SING-2/SING-5 applied to the menu bar; the timer
  bound in the helper is a cached *refresher* of read-only views, never an executor
  (`ChildProcess` cached refreshers in phnx-labs/agi-menu, the helper's own repo
  since PHNX-4036; `cli/docs/menubar.md` is the contract). Status: **Current**.

### 6. Given/When/Then scenarios

- **GIVEN** a routine tagged `projects: [myapp, billing]` and no `project` anchor,
  **WHEN** it fires, **THEN** the grouping list changes nothing about where it runs
  (RT-1) — placement follows `devices`/`hostStrategy`/anchor, never the grouping tags.
- **GIVEN** a Linear-imported (rootless) project anchor plus a relative `cwd` of
  `checkouts/app`, **WHEN** the routine is added on a target whose `$HOME/checkouts/app`
  exists, **THEN** readiness resolves the cwd under the target `$HOME` and activates;
  **WHEN** that directory does not exist, **THEN** add saves the routine **paused** with
  `cwd_missing` (RT-3, RT-5).
- **GIVEN** an `agent` routine with neither a `project` anchor nor a `cwd`, **WHEN** it
  is added, **THEN** it saves **paused** with `execution_context_missing` — there is no
  implicit home launch for an agent body (RT-4, RT-5). **GIVEN** the same shape as a
  `command` routine, **THEN** it activates and runs from the target `$HOME` (RT-4).
- **GIVEN** a routine whose pinned account is dead, **WHEN** it is added, **THEN** the
  headless auth smoke fails and it saves **paused** with `agent_auth_failed`, and a
  terminal `blocked` run is visible in `agents routines runs` before any session exists
  (RT-5, RT-6, RT-7).
- **GIVEN** an active routine whose rotation-resolved account is `revoked`/`unconfigured`
  in the auth-health cache, **WHEN** the daemon fires it, **THEN** it records a terminal
  `blocked`/`agent_auth_failed` run with the re-login repair and spawns nothing — not a
  `failed` run that burned a session (RT-12, RT-7); **GIVEN** the cache verdict is
  `rate_limited`/`unverified`/`expired`/`error` or absent, **THEN** the fire proceeds
  (fail open, RT-12).
- **GIVEN** a routine still executing when its next slot arrives, **WHEN** the slot
  fires, **THEN** exactly one instance runs and the new occurrence records a `skipped`
  run linked to the active run — not a second concurrent launch (SING-13, RT-7).
- **GIVEN** a hand-edit that makes the YAML invalid, **WHEN** it is written, **THEN**
  the prior definition bytes are untouched (RT-10); **GIVEN** a valid edit that
  introduces a blocker, **THEN** the definition is replaced and paused (RT-10, RT-5).

### 7. Known gaps

- **RT-GAP-1 (RUSH-2290).** The execution-context resolver (RT-2, RT-3), the readiness
  model and pause-on-blocker (RT-4, RT-5), resume recheck (RT-9), atomic raw edit
  (RT-10), and the menu History surface that renders pre-session runs (RT-6 [Intended]
  half) are the routine reliability plan's target contract and are **not yet
  implemented** on `main`. Today: `remoteCwd` covers only `host`/`fleet` body placement
  (`lib/routines.ts:238`); there is no singular `project` anchor, `--project-anchor`,
  `routines doctor`, readiness code, or `cwd` field. The `RunMeta.status` union is
  complete (PHNX-3215 landed the `blocked`/`skipped` statuses and their pre-session run
  records, RT-7 Current, `lib/scheduling/routines.ts:782`). The landed guarantees this
  section already pins are RT-1, RT-6 (run-first history), RT-7, RT-8, and RT-11. A
  change that lands any [Intended] requirement MUST flip its `Status:` to **Current** in
  the same PR and MUST NOT widen this gap.
- **RT-GAP-2 (RUSH-2719).** Launch-target readiness is validated on the LOCAL box
  only: a pinned `version:` absent locally saves the routine paused with
  `agent_unavailable` (`lib/routine-readiness.ts` probes `isVersionInstalled`),
  and `strategy:` resolution runs on the firing box. For a genuinely remote
  `host:`/`fleet` body target the pinned version and sign-in state on THAT box
  are not validated at add/enable time — that check needs the RT-GAP-1
  execution-context-on-target resolver and is deferred with it, not silently
  skipped: the fire fails loud on the target instead. `host: auto` placement
  (`--run-on auto`) does probe target health/install/sign-in at each fire via
  `resolveDeviceAuto` (`lib/routines-placement.ts`).

---

## Watchdog

The normative contract for `agents watchdog` — the daemon-owned service that detects **idle** agents
and steers them to completion. The architectural companion is [automation.md](automation.md).
Requirement keywords **MUST / MUST NOT / SHOULD / MAY** are per RFC 2119; scenarios are
Given/When/Then so they map 1:1 to tests.

### 1. Purpose & scope

The watchdog exists to get **idle** agents moving to completion. In scope: detecting a
stalled/idle session, deciding nudge-vs-skip, and delivering a steering message to the
exact terminal split. Out of scope: sessions that explicitly stopped for the human
(`waiting_input`) — those surface in the user's feed and are the feed's responsibility,
not the watchdog's.

### 2. Requirements

#### 2.1 Trigger & lifecycle

- **WD-1 (MUST).** The agents daemon MUST be the sole automatic watchdog scheduler and
  executor. When device-local `watchdog.enabled` is true it MUST run one bounded,
  non-overlapping pass every three minutes. UI surfaces MUST only render persisted state.
  The daemon fires this pass from `WatchdogService`, a `PeriodicService` registered on
  `ServiceSupervisor` (`lib/daemon/watchdog-service.ts`, RUSH-3193 P3 — previously a bare
  `setInterval(WATCHDOG_TICK_MS)` with a hand-rolled in-flight guard directly in
  `daemon.ts`), re-checking `watchdog.enabled` inside each tick — the daemon remains the
  sole scheduler/executor; the supervisor now also owns the per-tick deadline, error
  boundary, and park/backoff circuit breaker for this pass.
- **WD-2 (MUST).** Delivery MUST occur only when `--nudge` is set; without it a tick is a
  dry run that reports "would nudge" and delivers nothing (`lib/watchdog/runner.ts`).
- **WD-3 (MUST).** `on`/`off` MUST write the typed device-local `watchdog.enabled`
  setting, and `status` MUST reflect that setting (`commands/watchdog.ts`).

#### 2.2 Detection — idle is the target

- **WD-4 (MUST).** A candidate MUST be a session idle at least `WATCHDOG_STALL_MS` and less
  than `WATCHDOG_DORMANT_MS`, past its per-session cooldown (thresholds in
  `lib/watchdog/read.ts:19-21`; the gate `classifyTerminal` in `lib/watchdog/watchdog.ts:84`).
  Idle age is derived from the transcript's last-write time.
- **WD-5 (MUST).** A session whose inferred activity is `working` MUST NOT be nudged
  (`lib/session/state.ts`).
- **WD-6 (MUST NOT).** The watchdog MUST NOT fight the feed: a session in `waiting_input`
  (asked a question / permission prompt) is the feed's to surface; the agent decider MUST
  judge it (drive-forward vs leave-for-human) from its task + tail — never blind-nudge it
  as if idle.
- **WD-7 (SHOULD).** When several candidates exist, the watchdog SHOULD prioritize the ones
  active most recently (a warm session is likeliest to be steerable).
- **WD-8 (MUST).** A session whose transcript cannot be located (no timestamp) MUST be
  skipped, not guessed — and transcript resolution MUST search every version home, not just
  the live `~/.claude`. Both resolvers do so via `getAgentSessionDirs`: the status/timestamp
  path (`findClaudeSessionFile`, `lib/session/active.ts:412`, which sets the row's
  last-activity time) and the tail-read path (`resolveWatchdogSessionPath`,
  `lib/watchdog/read.ts:139`). So an agent-version upgrade does not blind the watchdog.

#### 2.3 Decision — nudge vs skip

- **WD-9 (MUST).** The per-tick decision MUST be made by an agent, not a heuristic script.
  Every idle candidate (its originating task + transcript tail) MUST be judged in a SINGLE
  `agents run … --mode plan` invocation per tick (`makeWatchdogAgentDecider`,
  `lib/watchdog/watchdog-agent.ts`) — never one subprocess per candidate. The agent decides
  idle-but-unfinished → nudge vs idle-and-done / needs-human → skip. A decider failure or a
  candidate with no returned verdict MUST resolve to a safe skip, never a blind nudge. The
  agent MUST NOT be invoked when nothing is idle.
- **WD-10 (MUST).** The agent MUST skip (leave for the human, `needsHuman: true`) on:
  credentials/auth, an irreversible or outward-facing action needing sign-off
  (publish/release, delete prod, spend, external message), a genuine product/intent
  decision, or an unreadable state; and MUST skip with `needsHuman: false` on a completed
  task, so a finished session is never poked (`WATCHDOG_SYSTEM_PROMPT`,
  `lib/watchdog/watchdog.ts`).
- **WD-11 (MUST).** A nudge message MUST carry context — restate the goal and name ONE
  concrete next step (the specific action, a forgotten tool, or the sensible default). A
  generic "use your judgment and finish" with no concrete step MUST NOT be emitted.
- **WD-12 (SHOULD).** When the blocker is resolvable by a tool the agent already has
  (`agents computer`, `agents browser`, `agents ssh <mac> "agents computer …"`), the nudge
  SHOULD name that tool rather than escalating to the human.
- **WD-13 (MAY).** A user playbook at `~/.agents/playbooks/watchdog.md` MAY be appended as
  House Rules to tune the nudge/skip line per fleet (`composePromptWithPlaybook`).

#### 2.4 Delivery

- **WD-14 (MUST).** A nudge MUST be delivered into the exact split the session lives in,
  resolved by the single canonical `resolveInjectTargetForSession`
  (`lib/terminal/resolve.ts`, precedence `tmux > iterm > vscodium > pty`) and injected by
  `injectIntoTerminal` (`lib/terminal/inject.ts`).
- **WD-15 (MUST).** `agents sessions inject` MUST resolve targets through the same
  `resolveInjectTargetForSession` as the watchdog, so the manual unblock path and the
  watchdog agree on which sessions are addressable (no duplicate weaker resolver).
- **WD-16 (MUST).** When no addressable split exists, the tick MUST fall back (mailbox or
  headless `--resume`) or refuse-and-flag — it MUST NOT silently claim delivery.
- **WD-17 (MUST).** Every decision MUST be appended to `watchdog.log` in the ext event
  shape, with persisted transcript context bounded so it cannot consume the audit window
  (`lib/watchdog/log.ts`).
- **WD-21 (MUST).** A nudge MUST be booked in the cooldown ledger (`nudges.json`) and
  logged as a `nudge` event ONLY when delivery is CONFIRMED. tmux / iterm / pty self-confirm
  (a successful transport IS delivery); vscodium's `--open-url` is fire-and-forget, so it is
  `confirmed: false` until the swarm-ext extension acks the verb (`backendConfirmsDelivery`,
  `lib/terminal/inject.ts`). An unconfirmed-but-dispatched delivery MUST be logged as an
  `undelivered` event and MUST NOT be reported as a landed nudge; it MAY still start the
  cooldown so a possibly-working session is not re-hit every tick.

#### 2.5 Per-session policy

- **WD-18 (MUST).** `agents watchdog policy <id> off|keep|handsoff` MUST be honored:
  `off` excludes the session; `handsoff` detects+flags but never delivers; `keep` is the
  default path (`readPolicySentinel`/`writePolicySentinel`, `lib/watchdog/runner.ts`).

#### 2.6 Audit history

- **WD-19 (MUST).** `agents watchdog history [sessionId]` MUST expose the persisted audit
  trail newest-first, including non-action session inspections, MUST support machine-readable output, and MUST NOT return raw
  transcript `tailLines` or message excerpts (`lib/watchdog/history.ts`, `commands/watchdog.ts`).
- **WD-20 (MUST).** The human one-shot tick output MUST show the tick timestamp and
  actionable session identity/location/activity metadata already present in the active
  snapshot. It MUST summarize healthy/non-actionable inspections by default and restore
  every row with `--verbose`, without performing another session scan
  (`lib/watchdog/runner.ts`, `commands/watchdog.ts`).

### 3. Given/When/Then scenarios

**GWT-W1 — Idle promise-without-toolcall is nudged with a concrete step.**
Given a session idle past `WATCHDOG_STALL_MS` whose tail shows an announced action and no
following tool call; When a `--nudge` tick runs; Then the brain returns `nudge` and the
message restates the goal and names the next step (WD-11), delivered into the session's
exact split (WD-14).

**GWT-W2 — A release ask is left for the human.**
Given an idle session whose last turn asks to publish/release; When the tick runs; Then the
brain returns `skip` (WD-10) and nothing is delivered.

**GWT-W3 — A working session is never nudged.**
Given a session whose inferred activity is `working` (fresh transcript writes); When the
tick runs; Then it is not a candidate and no nudge is sent (WD-5).

**GWT-W4 — VSCodium session is addressable by both paths.**
Given a live `codium`-hosted session with a session id; When either the watchdog or
`agents sessions inject <id>` resolves a target; Then both return an addressable `vscodium`
rail via `resolveInjectTargetForSession` (WD-14, WD-15).

**GWT-W5 — Upgrade does not blind the watchdog.**
Given a running session whose transcript lives under an earlier version home while
`~/.claude` points at a newer version; When the tick classifies it; Then the transcript is
found via `getAgentSessionDirs` and the session is evaluated, not skipped as "no activity
timestamp" (WD-8).

**GWT-W6 — Audit history is useful without disclosing transcript content.**
Given persisted decisions and heartbeat ticks; When an operator runs
`agents watchdog history <sessionId> --json`; Then matching decisions are returned newest
first alongside compact inspection results, without raw transcript tails or message excerpts,
and heartbeat rows appear only with `--all`
(WD-19).

**GWT-W7 — A dry tick explains what needs attention.**
Given a tick containing stalled and healthy sessions; When an operator runs `agents watchdog`;
Then the output names when the tick ran and identifies every actionable session with its
location/activity context, while healthy rows are summarized until `--verbose` is passed
(WD-20).

### 4. Known gaps

- **WD-GAP-1 (resolved).** The decider now sees every idle session at once: the tick
  batches all idle candidates (each with its originating task + tail) into one
  `agents run --mode plan` call, rather than judging a lone per-candidate tail
  (`makeWatchdogAgentDecider`, `lib/watchdog/watchdog-agent.ts`). It is scoped to the
  machine's idle set, not the entire fleet snapshot.
- **WD-GAP-2.** There is no distinct `done` state — a completed session is inferred as
  `idle` and the agent skips it with `needsHuman: false` rather than a first-class status.
  Planned.
- **WD-GAP-3.** Live status inference covers Claude/Codex; other harnesses fall to
  `unknown` and are not yet steered (`findSessionFileForKind`,
  `lib/session/active.ts`). Planned.
- **WD-GAP-4.** No default `watchdog/WORKFLOW.md` decider ships in this repo; absent
  one, the built-in `WATCHDOG_SYSTEM_PROMPT` runs.
