/**
 * Session data model.
 *
 * Normalized types that unify the different session storage formats used by
 * Claude (JSONL), Codex (JSONL events), Gemini (single JSON), and OpenCode.
 * Everything in the session pipeline -- discovery, parsing, rendering --
 * speaks these types.
 */

/** Agents that store session data on disk and can be discovered by `agents sessions`. */
export type SessionAgentId = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode' | 'openclaw' | 'rush' | 'hermes' | 'grok' | 'kimi' | 'droid' | 'cursor' | 'muse';

/** Effective permissions mode used to launch a managed agent session. */
export type SessionRunMode = 'plan' | 'edit' | 'auto' | 'skip';

/** All agents with session discovery support, in display order. */
export const SESSION_AGENTS: SessionAgentId[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode', 'openclaw', 'rush', 'hermes', 'grok', 'kimi', 'droid', 'cursor', 'muse'];

/**
 * True when `agent` stores session data `agents sessions` can discover (a member
 * of {@link SESSION_AGENTS}). The single predicate every session-index writer
 * gates on, so "is this a trackable agent?" is decided in exactly one place.
 */
/**
 * The tmux session name the CLI mints for an agent run: `ag-<agent>-<shortid>`.
 *
 * ONE definition. This shape was independently re-written as a regex literal in
 * five places (focus's selector test, sessions-resume's direct-selector test,
 * active's name parsers, actor-sidecar, and the deeplink parser); they drifted —
 * focus accepted a 6+ hex suffix while the others required exactly 8 — which is
 * how the same alias could be an "identity" to one code path and a keyword query
 * to the next.
 */
export const AG_TMUX_NAME_RE = /^ag-([a-z][a-z0-9-]*?)-([0-9a-f]{8})$/i;

/** Whether `name` is an `ag-<agent>-<shortid>` tmux session name. */
export function isAgentTmuxAlias(name: string): boolean {
  return AG_TMUX_NAME_RE.test(name);
}

export function isSessionTrackedAgent(agent: string): agent is SessionAgentId {
  return (SESSION_AGENTS as string[]).includes(agent);
}

/**
 * The name `agents sessions` shows for a run. A custom harness launched via a
 * profile (`agents run deepseek`) keeps its host agent for transcript discovery
 * and parsing (`claude`) and stamps the profile name on `harness`. Display
 * prefers that stamp so a deepseek run is not listed as claude (PHNX-2935).
 */
export function sessionDisplayAgent(session: { agent: string; harness?: string | null }): string {
  const harness = session.harness?.trim();
  return harness || session.agent;
}

/** A single normalized event within a session (message, tool call, thinking, etc.). */
export interface SessionEvent {
  /**
   * `file_change` is the harness's own file ledger (Claude `file-history-delta`,
   * Codex `FileChange`, OpenCode `patch`) rather than a tool call. It is emitted
   * only on request (`includeFileHistory`) or by the Codex item reader, never in
   * the default published stream — see `ParseSessionOptions.includeFileHistory`.
   */
  type: 'message' | 'tool_use' | 'tool_result' | 'thinking' | 'error' | 'init' | 'result' | 'usage' | 'attachment' | 'hook' | 'interrupt' | 'file_change';
  agent: SessionAgentId;
  timestamp: string;
  role?: 'user' | 'assistant';
  content?: string;
  tool?: string;
  /** Harness-native call identity, used to correlate concurrent results. */
  callId?: string;
  args?: Record<string, any>;
  path?: string;
  command?: string;
  success?: boolean;
  /** Structured harness outcome; never inferred from free-text output. */
  outcome?: 'ok' | 'error' | 'unknown';
  /**
   * The call never RAN: a permission rule or hook denied it (Claude
   * `toolDenialKind`), or the turn was aborted. Distinct from a failure — a
   * blocked call says nothing about whether the work would have succeeded, so
   * the timeline counts the two separately.
   */
  blocked?: boolean;
  exitCode?: number;
  statusCode?: number;
  errorCode?: string;
  output?: string;
  /** Internal: marks tool_use events from local commands */
  _local?: boolean;
  /**
   * Internal: marks a `role=user` message that is harness-injected scaffolding
   * (Claude `<bash-input>`/`<bash-stdout>` from `!`-prefix runs, `<system-reminder>`,
   * `<task-notification>`, `<command-*>` wrappers, `[Request interrupted]`, skill
   * bodies, hook feedback) rather than a genuine user turn. Set centrally in
   * `parseSession` via `isSyntheticUserMessage`. Such events are excluded from
   * `--include user` and are not counted as turn starts by `--first`/`--last`,
   * but stay in the default full stream so `--markdown` keeps full fidelity.
   */
  _synthetic?: boolean;
  // Fields for usage events (type === 'usage')
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Fields for attachment events (type === 'attachment')
  name?: string;
  mediaType?: string;
  sizeBytes?: number;
  // Fields for hook events (type === 'hook') — a harness hook firing recorded in
  // the transcript (Claude hook_success/hook_additional_context/hook_error
  // attachments). Hook name as configured (e.g. "SessionStart:startup").
  hookName?: string;
  /** Lifecycle event the hook fired on (SessionStart, PreToolUse, …). */
  hookEvent?: string;
  /**
   * Slash-command invocation name (e.g. `/recap`, `/code:commit`), captured
   * two ways in a Claude transcript: a `role=user` message whose content is
   * the `<command-name>` wrapper Claude injects for a typed slash command
   * (`parseClaudeContent`, see `prompt.ts`'s `extractSlashCommandName`), or a
   * `tool_use` event for the `SlashCommand` tool (a command the MODEL invoked
   * programmatically, not the user). Undefined for every other event.
   */
  slashCommand?: string;
  /**
   * The label the HARNESS itself wrote for this call — Claude's Bash
   * `input.description` ("Locate the prior session transcript on disk"), Kimi's
   * `tool.call.description`, OpenCode's `state.title` / `state.input.description`,
   * Codex's `CommandExecution.command`. Human-written, one per call, and exactly
   * what a now-line needs; `summarizeToolUse` renders the mechanical form
   * instead, which is why this is kept separately rather than folded into it.
   */
  label?: string;
  /**
   * Verb class the HARNESS assigned (Codex `parsed_cmd.type`, a typed tool
   * name). Absent when the harness does not classify its own call — then the
   * consumer derives one from `command`.
   */
  verbClass?: SessionVerbClass;
  /**
   * Per-path file operations the harness recorded for this call (Codex
   * `FileChange.changes`, OpenCode `patch.files`). The exact edit ledger, as
   * opposed to inferring one from Edit/Write arguments.
   */
  changes?: Array<{ path: string; op: 'created' | 'modified' | 'deleted' }>;
  /**
   * Codex tags an `AgentMessage` with the role it played in the turn
   * (`commentary` is the narration between tool calls). Absent elsewhere.
   */
  phase?: string;
}

/** A displayable file attachment discovered in a session transcript. */
export interface SessionAttachment {
  path?: string;
  name?: string;
  mediaType: string;
  sizeBytes?: number;
}

/** One normalized checklist/task item emitted by any transcript harness. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Optional longer explanation supplied by task-based harnesses. */
  description?: string;
  /** Present-continuous label shown while this item is the active step. */
  activeForm?: string;
}

/**
 * Live plan progress derived from the most recent checklist write in the transcript
 * (Claude `TodoWrite` / Codex `update_plan`, RUSH-1380). Lets consumers show "N/M
 * done" + the current step for any session — including remote / device-dispatched
 * agents that carry no local tool-call stream — instead of only a coarse
 * working/idle verb.
 */
export interface TodoProgress {
  items: TodoItem[];
  /** Count of completed items. */
  done: number;
  /** Total items. */
  total: number;
  /** The in-progress item's activeForm (falls back to its content). The live step. */
  activeForm?: string;
}

/**
 * One progress checkpoint in a daemon-computed session summary (PHNX-3939):
 * a short line of what happened, stamped with an ISO time. Newest last.
 */
export interface SessionCheckpoint {
  text: string;
  /** ISO timestamp for this checkpoint. */
  at: string;
}

/** One item in a daemon-computed session summary checklist (PHNX-3939). */
export interface SessionChecklistItem {
  text: string;
  done: boolean;
}

/**
 * Lifecycle of a session's daemon-computed summary (PHNX-3939):
 *   - `pending` — the summarizer is enabled and this session has no summary yet.
 *   - `ready`   — a summary was computed and merged onto the row.
 *   - `skipped` — the summarizer is disabled/unconfigured, or a compute error
 *                 left no summary; the row deliberately carries no goal/checkpoints.
 */
export type SummaryState = 'pending' | 'ready' | 'skipped';

/**
 * How a tool call is bucketed on a timeline step (PHNX-3939). Coarse on purpose
 * — a step renders as "6 run · 2 blocked", not as a tool histogram. Taken from
 * the harness when it classifies its own call (Codex `parsed_cmd.type`, a
 * harness tool name) and derived from the command otherwise.
 */
export type SessionVerbClass = 'read' | 'edit' | 'run' | 'git' | 'test' | 'browser' | 'agent' | 'other';

/**
 * One step of the narration-anchored timeline (PHNX-3939): the agent's own
 * short line about what it is doing, plus the tool calls that ran under it.
 *
 * The text is never model-written — it is the harness's own narration (Claude
 * assistant text, Codex `AgentMessage` commentary, Gemini thought subject), a
 * thinking block when there is no narration, the user's tidied turn, or a
 * mix-derived line when tools ran with nothing said. `source` says which.
 */
export interface SessionStep {
  /** Headline: the first sentence of the narration, capped. */
  text: string;
  /** ISO time this step opened. */
  at: string;
  /** ISO time of the last event folded into it. */
  endedAt?: string;
  source: 'narration' | 'thinking' | 'derived' | 'user';
  /** Tool calls attached to this step. */
  tools: number;
  /** Calls that RAN and failed (non-zero exit, `is_error`, harness error status). */
  failed: number;
  /** Calls that never ran: a permission rule, a hook denial, an aborted turn. */
  blocked: number;
  /** Per-verb-class tally of the attached calls. */
  mix?: Partial<Record<SessionVerbClass, number>>;
  /** Milestones recognized under this step ("worktree created", "PR opened", "files changed"). */
  marks?: string[];
  /** True on the newest step while the session is working. */
  live?: boolean;
  /** Harness label of the running tool on a live step — the now-line. */
  now?: string;
}

/**
 * The bounded projection of a session's timeline that rides the row (PHNX-3939).
 *
 * `steps` is the tail; everything before it collapses into `earlier` so the
 * payload stays flat as a session grows. `state` is honest about harnesses that
 * cannot supply one: `partial` when an event cap was hit, `unavailable` with a
 * `reason` when the harness writes no parseable transcript (OpenClaw) — never
 * an empty step list presented as "nothing happened".
 */
export interface SessionTimeline {
  /** Newest last, at most `keep` (8). */
  steps: SessionStep[];
  earlier: { steps: number; tools: number; failed: number };
  /** Totals across the WHOLE session, not just `steps`. */
  tools: number;
  failed: number;
  blocked: number;
  spanMs: number;
  state: 'ready' | 'partial' | 'unavailable';
  reason?: string;
}

/**
 * The session's operative request: the latest genuine user turn, tidied but
 * never rewritten (PHNX-3939). `turns` counts every genuine user turn so a
 * consumer can say "latest of 6"; `continues` names the session a `/continue`
 * picked up.
 */
export type SessionRequest = import('./prompt.js').TidyRequest & {
  /**
   * Genuine user turns in the session so far, so a consumer can say "latest of
   * 6". Present only when the daemon's timeline fold counted them; a request
   * tidied inline from the indexed turn alone does not know the count and says
   * nothing rather than claiming 1.
   */
  turns?: number;
  continues?: { id: string; label?: string };
};

/** One file the session created, modified or deleted. */
export interface SessionFileChange {
  path: string;
  op: 'created' | 'modified' | 'deleted';
  /** How many times the session touched it. */
  edits: number;
  /** ISO time of the last touch. */
  at: string;
}

/**
 * The files a session changed (PHNX-3939). `source: 'harness'` means the
 * harness recorded the change itself (Codex `FileChange`, OpenCode `patch`,
 * Claude `file-history-delta`); `'tools'` means it was derived from Edit/Write
 * calls because the harness records no file ledger. `changes` is bounded to 8
 * rows; `total` is the real count.
 */
export interface SessionFiles {
  changes: SessionFileChange[];
  total: number;
  source: 'harness' | 'tools';
}

/** Metadata attached when a session was spawned by `agents teams`. */
export interface TeamOrigin {
  /** Teammate name if set, otherwise first 8 chars of the agent UUID. */
  handle?: string;
  /** Agent mode: 'plan', 'edit', 'auto', or 'skip' ('full' accepted as legacy alias for 'skip'). */
  mode?: string;
  /** The team this teammate belongs to (`task_name` in its meta.json). */
  team?: string;
  /**
   * The orchestrator session that spawned this teammate (`parent_session_id`).
   * Absent for a team started outside any agent session, and for teammates whose
   * meta dir has aged past the teams cleanup window.
   */
  parentSessionId?: string;
  /**
   * Spawn time (`started_at` in the teammate meta.json) — when `agents teams`
   * launched this teammate. Distinct from the session's own `timestamp` (first
   * transcript line), and present even before the harness writes a transcript.
   * Absent for the entrypoint-only fallback (no meta record).
   */
  startedAt?: string;
  /**
   * How this origin was established, which is what separates a real
   * `agents teams` teammate from a plain SDK sub-agent (a `Task` / `Agent()`
   * spawn). Both carry the `sdk-cli` entrypoint that sets `isTeamOrigin`, so the
   * entrypoint flag alone cannot tell them apart — only a teammate has a
   * `meta.json` under the teams agents dir.
   *   - `'meta'`     — a teammate: read from its `meta.json` record.
   *   - `'entrypoint'` — an SDK spawn with no team record (a sub-agent, or a
   *                      teammate whose meta dir aged past the cleanup window).
   */
  source?: 'meta' | 'entrypoint';
}

/** Lightweight metadata for a discovered session, used in listings and pickers. */
export interface SessionMeta {
  id: string;
  shortId: string;
  agent: SessionAgentId;
  /**
   * Custom harness / profile name when this session was launched via
   * `agents run <profile>` (e.g. `deepseek`). `agent` stays the HOST
   * harness that produced the transcript (`claude`, …) so discovery and
   * parsing keep working. Display surfaces this when set (PHNX-2935).
   */
  harness?: string;
  /** Where the indexed transcript came from. Routine rows are archived from a run directory. */
  origin?: 'cli' | 'routine';
  /** Routine name for transcripts archived from ~/.agents/.history/runs/<name>/<runId>/. */
  routineName?: string;
  /** Routine run id for transcripts archived from ~/.agents/.history/runs/<name>/<runId>/. */
  routineRunId?: string;
  timestamp: string;
  /**
   * Last-activity time (ISO): the last message timestamp when a parser computed
   * it, else file mtime, else `timestamp`. This is the recency signal the
   * listing sorts and labels by; `timestamp` stays the creation time.
   */
  lastActivity?: string;
  project?: string;
  cwd?: string;
  filePath: string;
  gitBranch?: string;
  messageCount?: number;
  tokenCount?: number;
  /** Real generated (output) tokens — excludes cache-read/-write context (issue: `agents insights output`). */
  outputTokens?: number;
  /**
   * Uncached input tokens, cache-read tokens, and cache-write (cache-creation)
   * tokens — the burn split `agents insights output` reports, kept only for harnesses that
   * record a per-message cache split (Claude/Codex/Gemini/Droid). Undefined for
   * harnesses that expose no split (RUSH-2287).
   */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Total USD cost, computed at scan time from per-model token usage (issue #323). */
  costUsd?: number;
  /**
   * USD cost priced as if caching were off — cache read/write billed at the full
   * input rate. Backs `agents insights output --pricing no-cache` (RUSH-2287). Undefined
   * when the harness records no cache split (then no-cache == actual by definition).
   */
  costUsdNoCache?: number;
  /** Wall-clock duration in ms (lastTs − firstTs), persisted at scan time. */
  durationMs?: number;
  /** Underlying LLM model observed in the transcript, when the agent records one. */
  model?: string;
  toolCallCount?: number;
  version?: string;
  /**
   * Email of the account that produced the session. Display-only: two orgs can share
   * one email, so never group on this — group on `accountKey`.
   */
  account?: string;
  /**
   * Org-scoped identity of the producing account (`claude:org=<uuid>`), or
   * `unattributed:<reason>` when it cannot be established. The correct grouping key:
   * a Team seat and a personal Max plan under one email are separate quota buckets.
   * See lib/session/claude-accounts.ts for how a transcript is attributed.
   */
  accountKey?: string;
  /** Stable credential account recorded at launch; independent of organization quota and binary release. */
  accountId?: string;
  /** Organization display name of the producing account, when known. */
  accountOrg?: string;
  /** Effective normalized launch mode captured by the SessionStart hook. */
  mode?: SessionRunMode;
  topic?: string;
  /** Full, cleaned first genuine user turn; distinct from the one-line topic. */
  firstUserMessage?: string;
  /**
   * Full, cleaned LATEST genuine user turn. For a `/continue`, a redirect, or an
   * interrupted-and-restated session the operative request is the last thing the
   * user said, not the first — which is what the session row and the sidebar's
   * Request card show (PHNX-3939). Equal to {@link firstUserMessage} for a
   * single-turn session; absent for rows indexed before this field shipped.
   */
  lastUserMessage?: string;
  /**
   * The session's human-readable name — one field, several sources with a plain
   * priority: an agent-generated title / Claude `/rename` wins; else the launch
   * handle seeded from `agents run --name <slug>` (interactive, headless, remote
   * host, or a teams teammate); else it stays unset and the listing falls back to
   * `topic`. Searchable via `agents sessions <label>`. (Before v10 the launch
   * handle lived in a separate immutable `name` column; `--name` now just seeds
   * this label.)
   */
  label?: string;
  /** Set when this session was spawned by `agents teams`. */
  teamOrigin?: TeamOrigin;
  /** Durable state signals extracted at scan time by the session-state engine. */
  /** PR URL, if the session opened one (`gh pr create`). */
  prUrl?: string;
  /** PR number parsed from prUrl, for compact display. */
  prNumber?: number;
  /** Worktree slug when cwd is under `.agents/worktrees/<slug>/`. */
  worktreeSlug?: string;
  /** Tracker ticket ref (e.g. RUSH-1234) from the prompt or branch. */
  ticketId?: string;
  /**
   * Tracker refs the session CREATED during its run — Linear `create_issue` MCP
   * calls or `gh issue create` shell commands — read from the tool result. Distinct
   * from `ticketId` (the injected/worked-on ticket from the prompt or branch).
   */
  createdTickets?: string[];
  /**
   * Team name this session SPAWNED via `agents teams create/add`. The inverse of
   * `isTeamOrigin` (which marks sessions spawned BY a team).
   */
  spawnedTeam?: string;
  /**
   * Fan-out this session left behind, captured at scan time so the preview can
   * show it WITHOUT re-parsing the transcript — which is the only way a remote
   * or unindexed row (rendered from `SessionMeta` alone) can show it at all.
   *
   * `undefined` and `0` are different claims and must render the same way (the
   * segment omitted): `undefined` means the row predates the field or the
   * harness cannot report it, `0` means scanned and none found. Rendering a
   * literal "0 background shells" for a harness that cannot report them would
   * assert "none running" where the truth is "unknown".
   *
   * Counts are "started", never "still running" — see `extractBackgroundShells`.
   */
  subAgentCount?: number;
  backgroundShellCount?: number;
  /**
   * The plan markdown from the LAST `ExitPlanMode` tool call in the transcript
   * (Claude sessions only), captured at scan time. Present whenever the session
   * ever entered plan-review; consumers can pair it with a live
   * `awaitingReason === 'plan_review'` to decide whether it is still pending.
   * Fills the gap that forced AGI EXT to re-read raw JSONL to
   * recover the plan text — the CLI now carries it on the metadata row.
   */
  plan?: string;
  /**
   * Live plan progress from the most recent checklist write (Claude `TodoWrite`
   * / Codex `update_plan`, RUSH-1503). Populated on `agents sessions <id> --json`
   * from the state engine so the Factory panel reads the CLI's computed checklist
   * instead of re-parsing the transcript. Absent when the session wrote no list.
   */
  todos?: TodoProgress;
  /** Most-recent unique directories changed or used as a shell working directory. */
  recentDirectoriesTouched?: string[];
  /**
   * Skills invoked during the session (structurally identical to
   * session/highlights.ts's SkillUse — declared inline here rather than
   * imported, to avoid a circular import: highlights.ts imports SessionEvent
   * from this file). Populated by discover.ts's incremental Claude
   * accumulator (ClaudeParseState.skillEvents, run through extractSkills at
   * finalize) so session/db.ts's upsertSessionsBatch can write
   * session_resource_usage rows WITHOUT re-parsing the whole transcript —
   * the same reason meta.todos/recentDirectoriesTouched are pre-computed by
   * the caller for claude/codex instead of left to db.ts's re-parse path.
   */
  skillsUsed?: Array<{ name: string; count: number }>;
  /** Sibling of {@link skillsUsed} for slash-command invocations (SessionEvent.slashCommand). */
  slashCommandsUsed?: Array<{ name: string; count: number }>;
  /**
   * Whether this session emitted at least one `browser.navigate` /
   * `browser.screenshot` event, computed at scan time from a sessionId-scoped
   * read of the events log (events.ts `query({ sessionId })`) rather than a
   * transcript re-scan — see `detectToolUsage` in session/db.ts. `undefined`
   * means a legacy row this scanner hasn't computed the field for yet (never
   * collapsed to `false`, so a consumer — e.g. sessions-picker.ts's
   * `classifySessionTool` — knows to fall back to a transcript-derived guess
   * instead of trusting a false negative).
   */
  usedBrowser?: boolean;
  /** Sibling of {@link usedBrowser} for `computer.action` events. */
  usedComputer?: boolean;
  /** Linear project containing ticketId, resolved lazily and cached in SQLite. */
  linearProject?: string;
  /** Browser URL for linearProject. */
  linearProjectUrl?: string;
  /**
   * True when the session was spawned programmatically (SDK entrypoint) rather
   * than by a human at the Claude CLI. Captured at scan time from the JSONL
   * `entrypoint` field ('sdk-cli' for team spawns, 'cli' for real sessions).
   */
  isTeamOrigin?: boolean;
  /**
   * The machine (normalized hostname) this session's transcript originated on:
   * the local machine for live-home sessions, or the origin machine parsed from
   * the cross-machine mirror path (backups/<agent>/<machine>/…, see
   * sync/agents.ts). Populated by discoverSessions for the listing/picker;
   * undefined for sessions obtained outside that path.
   */
  machine?: string;
  /**
   * Resolved actor id (`resolveActor().id`) who initiated this session — a
   * tailnet login/email for a resolved human, or `UNRESOLVED@<host>`. Persisted
   * write-once at session creation and preserved across content rescans (kept
   * out of the DB upsert's ON CONFLICT set). Undefined for rows created before
   * actor stamping. RUSH-2018.
   */
  actor?: string;
  /**
   * The actor's kind (`resolveActor().kind`): `'human'` for a person-initiated
   * run, `'agent'` for one an agent spawned. Pairs with {@link actor}, same
   * split as `AGENTS_ACTOR` / `AGENTS_ACTOR_KIND` on the exec env. RUSH-2018.
   */
  initiatedBy?: 'human' | 'agent';
  /**
   * Phoenix id of the actor who initiated this session (`resolveActor().phoenixId`)
   * — the tailnet human's stable Phoenix identity, resolved from the `actors:` map
   * at spawn. Pairs with {@link actor}, persisted write-once at session creation
   * and joined from the actor sidecar at scan time (kept out of the DB upsert's
   * ON CONFLICT set), so `agents sessions --json` can surface the Phoenix id.
   * Undefined for rows created before Phoenix-id stamping. PHNX-3798.
   */
  phoenixId?: string;
  /**
   * True only for rows pulled from another machine over the live cross-machine
   * fan-out (`remote-list.ts`) — their transcript is on that peer's disk, so
   * reading/resuming has to hop back over SSH. Distinct from `machine`, which is
   * also set on locally-readable synced mirrors: a mirror is machine-tagged but
   * its `filePath` is a local path, so it must NOT be treated as remote. Set by
   * `parseRemoteList`; transient (never persisted, stripped from --json).
   */
  _remote?: boolean;
  /**
   * Epoch ms this row was last written from a PEER's fleet-synced session mirror
   * (PHNX-3792); absent for a genuine local or host-dispatch row. When set, the
   * picker renders the peer session's topic/preview INLINE from this mirror
   * (no per-row SSH) and stamps a "synced <ago>" / stale marker. `mirrorSource`
   * names the publishing device. Backed by the `mirror_synced_at` column.
   */
  mirrorSyncedAt?: number;
  mirrorSource?: string;
  /**
   * True when the transcript file is gone from disk but the session's user turns
   * still live in the local DB (session_text), so the row is served and rendered
   * from the DB instead of vanishing (RUSH-2436). Absent for a live session whose
   * file is present. Backed by the persisted `archived_at` column.
   */
  archived?: boolean;
  /** Epoch ms the transcript file was first confirmed gone (pairs with {@link archived}). */
  archivedAt?: number;
  /**
   * Daemon-computed 1–2 line goal extracted from the session's first user turn
   * (PHNX-3939). Never on the request path — produced by the background
   * `SessionSummarizerService` and merged from the `session_summaries` cache.
   */
  goal?: string;
  /** Daemon-computed progress checkpoints, newest last (PHNX-3939). */
  checkpoints?: SessionCheckpoint[];
  /** Daemon-computed detailed checklist for the session (PHNX-3939). */
  summaryChecklist?: SessionChecklistItem[];
  /** Lifecycle of the daemon-computed summary; `skipped` when disabled (PHNX-3939). */
  summaryState?: SummaryState;
  /** Terms that matched the current search query */
  _matchedTerms?: string[];
  /** BM25 relevance score from the most recent content-index search */
  _bm25Score?: number;
  /**
   * A short highlighted excerpt (`**term**`) around the best-matching FTS5
   * column (label/topic/project/user content/assistant answer) for the most
   * recent content-index search. Unlike `_matchedTerms`/`_bm25Score` this is
   * NOT stripped from `--json` output — it's the searchable-context payload a
   * content-search result carries, not internal ranking bookkeeping.
   */
  snippet?: string;
}

/** Output format for rendering a session's content. */
export type ViewMode = 'summary' | 'markdown' | 'json';

/** A file created or modified during a session, discovered from tool_use events. */
export interface SessionArtifact {
  path: string;
  tool: string;
  timestamp: string;
  exists: boolean;
  sizeBytes?: number;
  sessionId: string;
}
