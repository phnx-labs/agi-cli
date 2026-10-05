/** SQLite-backed session index and full-text search in a WAL-mode db at
 * ~/.agents/.history/sessions/sessions.db: incremental upsert, a scan-stamp ledger (mtime/size) to
 * skip unchanged files, FTS5 BM25 search, and label-first search for /rename'd sessions. */

import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import type { SessionAgentId, SessionCheckpoint, SessionChecklistItem, SessionEvent, SessionFiles, SessionMeta, SessionRequest, SessionRunMode, SessionTimeline, SummaryState } from '@phnx-labs/sessions-cli/reader';
import { parseSession, sessionFilePathContainer } from '@phnx-labs/sessions-cli/reader';
import { extractRecentDirectoriesTouched, extractTodoProgressFromEvents } from '@phnx-labs/sessions-cli/reader';
import { getSessionsDir, getSessionsDbPath } from '../state.js';
import { query as queryEvents, queryToolUsageForSessions } from '../feed/events.js';
import { machineForSessionFile } from '../origin-machine.js';
import { loadSessionActorIndex, readSessionActorRecord } from './actor-sidecar.js';
import { scanEventToolCalls, type IndexedToolCall } from '@phnx-labs/sessions-cli/reader';
import { persistToolCalls, planEventToolResume, purgeToolCalls, toolEvidenceSourcePath, type ToolScanResumePoint } from './tool-store.js';
import { buildClaudeAccountIndex, resolveClaudeAccount } from './claude-accounts.js';
import {
  extractBackgroundShells,
  extractSkills,
  extractSlashCommands,
  harnessTracksBackgroundShells,
  isSubAgentTool,
} from '@phnx-labs/sessions-cli/reader';
import { resolveResource } from '../resources.js';
import { discoverPlugins } from '../plugins/plugins.js';
import { machineId } from '../machine-id.js';
import type { DiscoveredPlugin } from '../types.js';
import { firstUserMessageFromEvents, lastUserMessageFromEvents } from '@phnx-labs/sessions-cli/reader';
import { emptyTimelineState, TIMELINE_EXTRACTOR_VERSION, type TimelineState } from '@phnx-labs/sessions-cli/reader';

const SESSIONS_DIR = getSessionsDir();
const DB_PATH = getSessionsDbPath();

/** Current schema version; bumped when migrations are added. Exported so tests
 * assert against the constant instead of hardcoding a number that every bump
 * then has to chase (docs/sessions.md calls the constant the source of truth). */
export const SCHEMA_VERSION = 51;

/** Bump to force the content extractor to re-derive on every session's next scan.
 * `filterChangedEntries` reads it via `scan_ledger.extractor_version`, so no ledger wipe is
 * needed. v3 OpenCode; v4 Grok; v5 Codex forks; v6 (PHNX-3999) scaffolding labels. */
export const CONTENT_INDEX_VERSION = 6;

/** Bump to force `agents sessions backfill resources` to re-derive every session's
 * skill/slash-command tallies (lower-version resource_scan_ledger rows are stale, as
 * TOOL_INDEX_VERSION does for tools). */
const RESOURCE_INDEX_VERSION = 1;

/** Canonicalize a file path for use as a scan_ledger key. One session file is reachable via aliases
 * (`~/.claude` symlinked to a versioned home), and keying by the raw path forced a full re-parse
 * when switching (e.g. `agents use`). Realpath collapses them to one key. */
function canonicalLedgerKey(filePath: string): string {
  if (!filePath) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

// BM25 column weights for session_text: label > topic > project > content > assistant. `assistant`
// (the agent's answers) ranks below `content` (the user's prompts): the user's words better signal
// "the session I meant", so an assistant-only match surfaces but ranks lower.
/** BM25 column weights for FTS5: label > topic > project > content > assistant. */
const BM25_WEIGHTS = [5.0, 2.0, 1.5, 1.0, 0.5] as const;

/** DDL for the sessions database (tables, indexes, FTS5 virtual table). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  harness TEXT,
  origin TEXT DEFAULT 'cli',
  routine_name TEXT,
  routine_run_id TEXT,
  version TEXT,
  account TEXT,
  account_key TEXT,
  account_id TEXT,
  account_org TEXT,
  mode TEXT,
  timestamp TEXT NOT NULL,
  last_activity TEXT,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  topic TEXT,
  first_user_message TEXT,
  last_user_message TEXT,
  label TEXT,
  message_count INTEGER,
  token_count INTEGER,
  output_tokens INTEGER,
  input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  cost_usd_nocache REAL,
  duration_ms INTEGER,
  model TEXT,
  tool_call_count INTEGER,
  file_path TEXT NOT NULL,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  scanned_at INTEGER,
  is_team_origin INTEGER DEFAULT 0,
  pr_url TEXT,
  pr_number INTEGER,
  worktree_slug TEXT,
  ticket_id TEXT,
  spawned_team TEXT,
  sub_agent_count INTEGER,
  background_shell_count INTEGER,
  plan TEXT,
  machine TEXT,
  todos TEXT,
  recent_directories_touched TEXT,
  linear_project TEXT,
  linear_project_url TEXT,
  actor TEXT,
  initiated_by TEXT,
  phoenix_id TEXT,
  used_browser INTEGER,
  used_computer INTEGER,
  -- Epoch ms of the first time a previously-scanned transcript was confirmed
  -- gone from disk while its user-turn content still lives in session_text
  -- (RUSH-2436). Non-NULL means "archived": the row is served/rendered from the
  -- DB and flagged, instead of being dropped when the file vanishes. A row whose
  -- file is missing but which has NO cached content is a phantom (a stale/moved
  -- file_path), never stamped, still suppressed — see querySessions.
  archived_at INTEGER,
  -- Epoch ms this row was last written from a PEER's synced session mirror
  -- (PHNX-3792), NULL for a genuine local/host-dispatch row. Non-NULL marks a
  -- row created/enriched purely from a fleet-synced digest so it can be pruned
  -- by age without touching real rows; mirror_source names the publishing
  -- device. A row keeps a NULL mirror_synced_at once it gains a real transcript.
  mirror_synced_at INTEGER,
  mirror_source TEXT,
  -- Daemon-generated session TITLE (PHNX-3797): a short technical label for what
  -- the session worked on, produced once by the session-title daemon service and
  -- read by every headline surface. Deliberately NOT transcript-derived, so the
  -- scanner's upsert omits these columns entirely (an omitted column keeps its
  -- prior value) and only the titler writes them. generated_title_key is the
  -- hash of the user text the title was derived from, so the titler can tell
  -- "already titled" from "the first user message changed"; generated_title_at
  -- is when it was produced.
  generated_title TEXT,
  generated_title_key TEXT,
  generated_title_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_file_path ON sessions(file_path);
CREATE INDEX IF NOT EXISTS idx_sessions_short_id ON sessions(short_id);
-- idx_sessions_machine_ts / idx_sessions_agent_ts are created after migration
-- v17 guarantees the machine column exists (same pattern as last_activity);
-- idx_sessions_mirror_synced likewise waits for migration v46's column add.

-- A row sits at the rowid of the sessions row it describes (v51) and is
-- addressed by that rowid, never by session_id: an UNINDEXED FTS5 column cannot
-- be seeked, so a session_id predicate scans every row's content — the same
-- rule tool_call_text follows against tool_calls.rowid (v36).
CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
  session_id UNINDEXED,
  label,
  topic,
  project,
  content,
  assistant,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Tracks every file we've stat'd during a scan, regardless of whether it
-- produced a session row. Decouples "did we already look at this?" from
-- "do we have a session from it?" — essential for files that don't parse
-- into a session (no id) or session rows whose file_path is synthetic.
CREATE TABLE IF NOT EXISTS scan_ledger (
  file_path TEXT PRIMARY KEY,
  file_mtime_ms INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL,
  -- Resumable-parse cursor + continuation (B-1). parser_state is a JSON
  -- ClaudeParserState blob (offset + accumulator snapshot) so a scan can pick
  -- up where the last one stopped; content_text caches the accumulated user
  -- doc so detectTicket + FTS can rebuild on append without re-reading the file.
  -- Written by B-2; B-1 only defines + round-trips them.
  parser_state TEXT,
  content_text TEXT,
  -- CONTENT_INDEX_VERSION this row's session_text content was last extracted
  -- at. NULL (a pre-v42 row) never equals the current constant, so the
  -- change-detector (filterChangedEntries) treats it as changed even when
  -- (mtime, size) match — the lever that backfills assistant text into
  -- existing sessions without wiping scan_ledger outright.
  extractor_version INTEGER
);

-- Tracks the mtime + entry-count of every LEAF directory that directly holds
-- transcripts (a Claude project dir, a Gemini chats dir). A dir's mtime bumps
-- on create/delete/rename of its entries but NOT on an in-place append, so a
-- match here means the dir gained/lost/renamed no files: we can skip the
-- readdir + per-file stat and serve unchanged files from the DB (append-safety
-- is preserved by re-stat'ing only the "hot set" — see discover.ts). Keyed by
-- canonicalLedgerKey, same as scan_ledger.
CREATE TABLE IF NOT EXISTS dir_ledger (
  dir_path TEXT PRIMARY KEY,
  dir_mtime_ms INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL
);

-- One redacted evidence row per tool call. The ordinal is assigned in
-- transcript order and is stable across incremental appends.
CREATE TABLE IF NOT EXISTS tool_calls (
  call_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  source_call_id TEXT,
  timestamp TEXT NOT NULL,
  -- When the call's RESULT record arrived (its own end time). end_timestamp
  -- minus timestamp is the call's own blocking duration, which the traces
  -- insight engine attributes as a failed call's wasted time (PHNX-3437). NULL
  -- for a call that never produced a result and for rows an older extractor stored.
  end_timestamp TEXT,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  outcome TEXT NOT NULL,
  exit_code INTEGER,
  status_code INTEGER,
  error_code TEXT,
  output TEXT,
  error TEXT,
  parse_error TEXT,
  evidence_bytes INTEGER NOT NULL,
  UNIQUE(session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON tool_calls(outcome);

CREATE TABLE IF NOT EXISTS tool_call_programs (
  call_key TEXT NOT NULL,
  program TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY(call_key, program)
);
CREATE INDEX IF NOT EXISTS idx_tool_call_programs_program ON tool_call_programs(program, call_key);

-- Ordered static program sites retain repeated commands within one Bash call.
-- The complete redacted command stays on tool_calls.input; these rows contain
-- only the normalized program and whether it is a wrapper or effective target.
CREATE TABLE IF NOT EXISTS tool_program_occurrences (
  call_key TEXT NOT NULL,
  occurrence_ordinal INTEGER NOT NULL,
  program TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('wrapper', 'effective')),
  PRIMARY KEY(call_key, occurrence_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_tool_program_occurrences_program
  ON tool_program_occurrences(program, call_key);

-- Derived search index over tool_calls. call_key is UNINDEXED -- it is carried
-- for display, NOT for lookup: an FTS5 table has no index on an ordinary column,
-- so DELETE ... WHERE call_key = ? scans the whole index once per call, which is
-- quadratic in a session's call count. Every write here therefore addresses a
-- row by rowid, mirroring the tool_calls.rowid of the call it describes, so a
-- delete is a single rowid seek (tool-store.ts persistToolCalls/deleteSessionCalls).
CREATE VIRTUAL TABLE IF NOT EXISTS tool_call_text USING fts5(
  call_key UNINDEXED,
  tool,
  input,
  output,
  error,
  tokenize = 'trigram'
);

-- Independent of scan_ledger: schema migration never forces the normal
-- session index to reread history. Existing transcripts are backfilled only
-- by the explicit, bounded agents sessions backfill tools command.
CREATE TABLE IF NOT EXISTS tool_scan_ledger (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_mtime_ms INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  extractor_version INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  call_count INTEGER NOT NULL,
  evidence_bytes INTEGER NOT NULL,
  -- Resume point for the incremental tool scan. parsed_offset is the byte
  -- offset just past the last COMPLETE newline-terminated record consumed, and
  -- parser_state is the serialized ToolCallCollector snapshot at that offset
  -- (next ordinal + still-unresolved calls). Together they let the next scan of
  -- a session that only grew read the appended bytes instead of the whole file.
  -- NULL means "no resume point" — the next scan re-reads from byte 0.
  parser_state TEXT,
  parsed_offset INTEGER
);

-- Skill/slash-command usage per session (#12), computed from a session's
-- parsed transcript (extractSkills / extractSlashCommands, session/highlights.ts)
-- and joined at write time against the currently-installed resource/plugin
-- (resolveResource / discoverPlugins) for provenance — repo_root + snapshot_sha
-- answer "which repo, which commit installed this skill/command", plugin/source
-- answer "which plugin, which DotAgents layer". A resource renamed or uninstalled
-- since the session ran leaves plugin/source/repo_root/snapshot_sha NULL rather
-- than a stale guess. One row per (session, kind, name); count is how many
-- times that skill/command fired in the session.
CREATE TABLE IF NOT EXISTS session_resource_usage (
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  plugin TEXT,
  source TEXT,
  repo_root TEXT,
  snapshot_sha TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_session_resource_usage_kind_name ON session_resource_usage(kind, name);
CREATE INDEX IF NOT EXISTS idx_session_resource_usage_plugin ON session_resource_usage(plugin);

-- One-shot historical backfill bookkeeping for session_resource_usage, mirroring
-- tool_scan_ledger. The normal incremental scan writes resource usage for every
-- session it (re)parses, but a session indexed before #12 shipped keeps a fresh
-- scan_ledger row and is never re-derived — so its skill/slash-command tallies
-- were never recorded. The "agents sessions backfill resources" command walks
-- history, re-parses each transcript from byte 0, and stamps coverage here
-- (mtime + size + extractor_version) so reruns skip completed transcripts. This
-- is a SCAN LEDGER, not a second copy of the usage data — the usage itself lives
-- only in session_resource_usage.
CREATE TABLE IF NOT EXISTS resource_scan_ledger (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_mtime_ms INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  extractor_version INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  resource_count INTEGER NOT NULL
);

-- Behavioural facets per session, for "agents insights". Deliberately its own table
-- and deliberately NOT tied to SCHEMA_VERSION: it is created by CREATE TABLE IF NOT
-- EXISTS and keyed on (file_mtime_ms, file_size), so it self-heals after any future
-- migration that flushes a ledger, and adding it costs the hot "sessions" table
-- nothing. Populated lazily by the insights command, never by a normal scan --
-- parsing every transcript is far too expensive for the common listing path.
-- file_mtime_ms / file_size are NULLABLE because they are nullable on the sessions
-- table too (a source with no statable file indexes them as NULL). NOT NULL here made
-- a legitimate null-stat session throw a constraint error that took the whole batch
-- transaction down with it.
CREATE TABLE IF NOT EXISTS session_insights (
  session_id TEXT PRIMARY KEY,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  extractor_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  facets TEXT NOT NULL
);

-- Derived topic classification for traces sync. Like session_insights, this is
-- a lazy, stamp-validated cache and is intentionally independent of SCHEMA_VERSION.
CREATE TABLE IF NOT EXISTS session_topics (
  session_id TEXT PRIMARY KEY,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  extractor_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  topic_json TEXT NOT NULL
);

-- Derived failure phenotype for traces sync (PHNX-3327). Like session_topics /
-- session_insights, this is a lazy, stamp-validated cache keyed on
-- (file_mtime_ms, file_size) and intentionally independent of SCHEMA_VERSION.
-- Classifying a phenotype needs the full derived SessionTrajectory (ordered
-- steps, gaps), which buildIndexShard does NOT have from flat tool_calls rows —
-- so it is computed per-session ONCE (parse -> trajectory -> classify) and cached
-- here, then read for the WHOLE corpus on every sync. That is what lets the
-- phenotype grouping dimension fold two identically-signatured sessions into one
-- cluster regardless of which incremental batch each was first synced in, without
-- re-parsing transcripts at 10k+ session scale. phenotype_json holds
-- { phenotype: FailurePhenotype | null } (null = no failure phenotype matched).
CREATE TABLE IF NOT EXISTS session_phenotypes (
  session_id TEXT PRIMARY KEY,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  extractor_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  phenotype_json TEXT NOT NULL
);

-- Normalized data behind sessions preview. Like session_insights this is a
-- lazy, stamp-validated cache: opening one session parses only that transcript,
-- while subsequent processes reuse the derived preview until its bytes change.
CREATE TABLE IF NOT EXISTS session_preview_cache (
  session_id TEXT PRIMARY KEY,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  extractor_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  preview_json TEXT NOT NULL
);

-- Daemon-computed per-session summary (goal / checkpoints / checklist), PHNX-3939.
-- Modeled exactly on session_preview_cache: a lazy, stamp-validated cache keyed on
-- (session_id, file_mtime_ms, file_size) so a row is reused verbatim until the
-- transcript bytes change. Written ONLY by the background SessionSummarizerService
-- (or consumed from a peer's fleet mirror); the display/merge path reads it, never
-- computes. Independent of SCHEMA_VERSION, like the other lazy caches above.
CREATE TABLE IF NOT EXISTS session_summaries (
  session_id TEXT PRIMARY KEY,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  extractor_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

-- Daemon-computed narration-anchored timeline (PHNX-3939). Same lazy,
-- stamp-validated cache shape as session_summaries, with one addition: the fold
-- is INCREMENTAL, so the row carries both the bounded projection the display
-- path reads and the resume state the pass folds the next appended bytes onto.
--
-- Two columns rather than one on purpose. projection_json is small and bounded
-- (8 steps + counters + the tidied request + 8 file rows) and is what a session
-- row merges on the read path; state_json holds the whole TimelineState (byte
-- offset, open step, pending call ids, per-path file ledger) and is read ONLY by
-- the daemon pass. Folding one blob would make every row merge parse the resume
-- state it has no use for.
CREATE TABLE IF NOT EXISTS session_timelines (
  session_id TEXT PRIMARY KEY,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  extractor_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  projection_json TEXT NOT NULL,
  state_json TEXT NOT NULL
);

-- Durable metadata for one browser task (RUSH-2549). The browser daemon's
-- tasks.json is LIVE state: saveTaskState writes the in-memory task map, so
-- stopping a task drops its entry and a daemon restart empties the file. That is
-- correct for live state and useless as history, which is why every finished task
-- listed as "unlinked". This row is written once at task start and is never
-- deleted, so the link from a capture back to the agent session that drove it
-- survives the task, the daemon, and a reboot.
--
-- METADATA ONLY: capture bytes are never stored here. capture_dir points at the
-- on-disk directory (.cache/browser/<profile>/sessions/<task>/) that already holds
-- them, and the per-kind counts are what a listing needs to render a row without
-- walking that tree. captures_remote is set only when the optional offload has
-- copied them through the existing encrypted r2.backups sync.
--
-- session_id is the agent session (AGENT_SESSION_ID, which every agent carries);
-- launch_id stays as the secondary join key for a caller that has only that. actor
-- is the HUMAN/tailnet identity and is deliberately NOT an agent id -- resolveActor
-- answers UNRESOLVED@<host> for any local run by design (lib/actor.ts).
CREATE TABLE IF NOT EXISTS browser_sessions (
  task TEXT NOT NULL,
  profile TEXT NOT NULL,
  session_id TEXT,
  launch_id TEXT,
  actor TEXT,
  machine TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity INTEGER,
  screenshot_count INTEGER NOT NULL DEFAULT 0,
  pdf_count INTEGER NOT NULL DEFAULT 0,
  recording_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  capture_dir TEXT,
  captures_remote TEXT,
  PRIMARY KEY (profile, task)
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_session ON browser_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_started ON browser_sessions(started_at DESC);

-- Durable metadata for one "agents computer" invocation (RUSH-2549). Computer-use
-- already resolves identity correctly -- stampProvenance stamps AGENT_SESSION_ID
-- straight onto each computer.action event -- but those events live in the bounded
-- audit ledger, which prunes at 7 days / 50 MiB (events.ts). So a run's history
-- silently vanished on day 8. This row carries the same identity into the durable
-- store; the ledger is untouched and remains the audit log, with no second pruner.
--
-- Keyed on invocation_id, the id recordComputerAction stamps once per emitting CLI
-- process: one explicit verb is one row, and a whole "computer run" observe/act
-- loop is also one row. task_preview is already bounded by events.ts truncate()
-- before it is ever written, and typed-text content is never captured at all.
CREATE TABLE IF NOT EXISTS computer_sessions (
  invocation_id TEXT PRIMARY KEY,
  session_id TEXT,
  launch_id TEXT,
  actor TEXT,
  machine TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity INTEGER,
  action_count INTEGER NOT NULL DEFAULT 0,
  task_preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_computer_sessions_session ON computer_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_computer_sessions_started ON computer_sessions(started_at DESC);

-- Durable requester-side cache for a REMOTE session's preview envelope
-- (PHNX-3999). Keyed on (normalized owning device, full session id, schema
-- version) rather than transcript bytes, since this box never reads the peer's
-- transcript directly -- it only holds the last envelope one bounded
-- 'sessions preview <id> --local --json' hop returned FROM that device. Content
-- freshness (this row) is deliberately independent of live status, which is
-- never cached here and always re-read from the live registry when available.
-- ok=1 rows carry the last successful envelope_json; ok=0 rows carry no payload,
-- only a failure_reason, so a session that was resolvable once but is now
-- offline still degrades to the last GOOD payload (read separately, ok=1 only)
-- annotated stale rather than losing it to a later failed attempt overwriting it.
CREATE TABLE IF NOT EXISTS session_remote_preview_cache (
  device TEXT NOT NULL,
  session_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  envelope_json TEXT,
  envelope_bytes INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  -- The caller's OWN last-supplied --revision cursor (opaque: an epoch-ms
  -- string, an ISO stamp, whatever the caller's own activity feed hands us) --
  -- deliberately NOT compared to the envelope's own details.sourceRevision,
  -- since a caller's revision format (e.g. a feed's lastActivityMs) need not
  -- match the envelope's own (an ISO session.lastActivity). Equality is
  -- against THIS column only: same value back => caller has independently
  -- confirmed nothing changed.
  last_caller_revision TEXT,
  PRIMARY KEY (device, session_id, schema_version)
);
CREATE INDEX IF NOT EXISTS idx_remote_preview_cache_fetched ON session_remote_preview_cache(fetched_at DESC);
`;

/** Bumping this invalidates every cached facet row without a schema change, so changed extraction
 * logic re-derives on the next `agents insights` instead of mixing stale and fresh numbers. Same
 * role as RESOURCE_INDEX_VERSION. */
/** Bump when facet extraction changes so cached rows recompute (shell-command-by-binary v7). */
export const INSIGHTS_EXTRACTOR_VERSION = 7;
/** Bump when classifyTopic's output changes so cached topics recompute (human task taxonomy v2). */
export const SESSION_TOPIC_EXTRACTOR_VERSION = 2;
// Bumped to 2 (PHNX-2973): the digest now carries `changedFiles` (per-file
// paths). Bumping invalidates v1 cache rows so a fresh recompute populates the
// new field instead of serving a stale digest that predates it.
const PREVIEW_EXTRACTOR_VERSION = 3;
/** Bump when classifyPhenotype's output changes so cached phenotypes recompute (PHNX-3327 v1). */
export const SESSION_PHENOTYPE_EXTRACTOR_VERSION = 1;
/** Bump when the summarizer output shape changes so cached summaries recompute (PHNX-3939 v1). */
export const SESSION_SUMMARY_EXTRACTOR_VERSION = 1;

/** Raw row shape returned from the sessions table. */
interface SessionRow {
  id: string;
  short_id: string;
  agent: string;
  /** Custom harness/profile name; NULL for a native host run (PHNX-2935). */
  harness: string | null;
  origin: string | null;
  routine_name: string | null;
  routine_run_id: string | null;
  version: string | null;
  account: string | null;
  account_key: string | null;
  account_id: string | null;
  account_org: string | null;
  mode: string | null;
  timestamp: string;
  last_activity: string | null;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  topic: string | null;
  first_user_message: string | null;
  last_user_message: string | null;
  label: string | null;
  message_count: number | null;
  token_count: number | null;
  output_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_usd_nocache: number | null;
  duration_ms: number | null;
  model: string | null;
  tool_call_count: number | null;
  file_path: string;
  file_mtime_ms: number | null;
  file_size: number | null;
  scanned_at: number | null;
  is_team_origin: number;
  pr_url: string | null;
  pr_number: number | null;
  worktree_slug: string | null;
  ticket_id: string | null;
  spawned_team: string | null;
  /** Fan-out the session left behind. NULL is distinct from 0: NULL means the row predates the
   * column or the harness cannot report it; 0 means scanned, none found. Renders omit the segment
   * for both so neither reads as "nothing is running". */
  sub_agent_count: number | null;
  background_shell_count: number | null;
  plan: string | null;
  machine: string | null;
  todos: string | null;
  recent_directories_touched: string | null;
  linear_project: string | null;
  linear_project_url: string | null;
  actor: string | null;
  initiated_by: string | null;
  /** Phoenix id of the actor, joined write-once from the actor sidecar (PHNX-3798). */
  phoenix_id: string | null;
  /** NULL means "not yet computed" (a row scanned before this field existed) — see rowToMeta. */
  used_browser: number | null;
  used_computer: number | null;
  /** Epoch ms the transcript file was first confirmed gone while content survived (RUSH-2436); NULL
   * = live. Optional: the scanner upsert omits it so a rescan preserves the sticky stamp; only
   * querySessions writes it. */
  archived_at?: number | null;
  /** Epoch ms last written from a peer's fleet session mirror (PHNX-3792); NULL for a local row. */
  mirror_synced_at?: number | null;
  mirror_source?: string | null;
  /** Daemon-generated title (PHNX-3797) and the {@link sessionTitleSourceKey} of the user text it
   * came from. Optional like `archived_at`: the scanner's upsert never names them, so a rescan
   * preserves them and only the titler writes them. */
  generated_title?: string | null;
  generated_title_key?: string | null;
  generated_title_at?: number | null;
}

/** File stat snapshot used to detect changes between scan runs. */
export interface ScanStamp {
  fileMtimeMs: number;
  fileSize: number;
  scannedAt?: number;
  /** `scan_ledger.extractor_version` as of the last scan when read from the ledger (undefined for
   * an unpersisted stamp). `filterChangedEntries` compares it to {@link CONTENT_INDEX_VERSION} to
   * force a re-extract independent of (mtime, size). */
  extractorVersion?: number | null;
}

/** Filter and pagination options for querying the sessions table. */
export interface QueryOptions {
  agent?: SessionAgentId;
  agents?: SessionAgentId[];
  origin?: 'cli' | 'routine';
  version?: string;
  cwd?: string;
  /** Match any session whose cwd equals this or is a descendant of it. */
  cwdPrefix?: string;
  project?: string;
  /** Only sessions recorded on this machine (host), case-insensitive. */
  machine?: string;
  /** Match the full session id or short id, case-insensitively (exact). */
  idExact?: string;
  /** Match sessions whose id or short id begins with this (case-insensitive prefix). */
  idPrefix?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  /** Drop rows flagged as team-origin before LIMIT is applied. */
  excludeTeamOrigin?: boolean;
  /** Keep only team-origin rows (for hidden-count queries). */
  onlyTeamOrigin?: boolean;
  /** Column to order by, all descending. 'timestamp' (default) is newest first; 'cost' and
   * 'duration' put the priciest/longest on top, with NULLs last so unpriced rows never crowd out
   * real data. */
  sortBy?: 'timestamp' | 'cost' | 'duration';
  /** Internal warm-cache path; callers must validate the small final result set. */
  skipExistenceCheck?: boolean;
  /** Only sessions that invoked this skill (#12), joined on session_resource_usage.kind='skill'.
   * Matches the full stored name (bare or `plugin:name`) or the short name after the colon, so
   * `--skill design` finds `rush:design`. */
  skill?: string;
  /** Only sessions that used a skill or slash-command owned by this plugin (#12), joined on
   * session_resource_usage.plugin. */
  plugin?: string;
}

let dbInstance: Database.Database | null = null;

/** Apply schema migrations from `fromVersion` to SCHEMA_VERSION. SCHEMA's `CREATE IF NOT EXISTS`
 * does not help when column sets or FTS column definitions change; those need explicit migration
 * here. */
function migrateSchema(db: Database.Database, fromVersion: number): void {
  if (fromVersion < 2) {
    // v1 → v2: add `label` column to sessions and switch session_text from
    // single `content` column to multi-column (label, topic, project, content).
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'label')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`);
    }
    // FTS5 virtual tables can't be ALTERed — drop and recreate. Scan ledger
    // is cleared so every file gets re-parsed on next run, repopulating FTS5.
    db.exec(`
      DROP TABLE IF EXISTS session_text;
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        label,
        topic,
        project,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      DELETE FROM scan_ledger;
    `);
  }
  if (fromVersion < 3) {
    // v2 → v3: topic extraction now strips team-spawn wrapper prompts
    // (HEADLESS PLAN MODE prefix + summary suffix). Force a rescan so cached
    // topics like "You are running in HEADLESS PLAN MODE..." get re-extracted.
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 4) {
    // v3 → v4: team-origin is now captured structurally from the JSONL
    // `entrypoint` field at scan time. Add the column and force a rescan so
    // every existing Claude session gets its flag populated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'is_team_origin')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN is_team_origin INTEGER DEFAULT 0`);
    }
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 5) {
    // v4 -> v5: the ledger is keyed by realpath instead of the as-discovered path, so aliases of
    // one physical file collapse to one row. Old aliased rows are dropped; the next scan
    // repopulates under canonical keys.
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 6) {
    // v5 → v6: cost ($) and wall-clock duration are now computed at scan time
    // from raw per-model token usage. Add the columns and force a full rescan
    // so every existing session gets its cost_usd / duration_ms populated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'cost_usd')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN cost_usd REAL`);
    }
    if (!cols.some(c => c.name === 'duration_ms')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN duration_ms INTEGER`);
    }
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 7) {
    // v6 → v7: the session-state engine now persists durable signals (PR opened,
    // worktree, tracker ticket) at scan time. Add the columns and force a full
    // rescan so every existing session gets them populated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'pr_url')) db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
    if (!cols.some(c => c.name === 'pr_number')) db.exec(`ALTER TABLE sessions ADD COLUMN pr_number INTEGER`);
    if (!cols.some(c => c.name === 'worktree_slug')) db.exec(`ALTER TABLE sessions ADD COLUMN worktree_slug TEXT`);
    if (!cols.some(c => c.name === 'ticket_id')) db.exec(`ALTER TABLE sessions ADD COLUMN ticket_id TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 8) {
    // v7 -> v8: the listing sorts and labels by last-activity instead of creation time. Add the
    // column seeded to `timestamp` so no row sorts as NULL, then force a full rescan to populate
    // the true last_activity (lastTsMs).
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'last_activity')) db.exec(`ALTER TABLE sessions ADD COLUMN last_activity TEXT`);
    db.exec(`UPDATE sessions SET last_activity = timestamp WHERE last_activity IS NULL`);
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 9) {
    // v8 -> v9: `agents run --name <slug>` gives a run a durable handle (`agents sessions
    // <name>`). Additive column, no rescan: the name is set at run time (sidecars), not parsed
    // from transcripts.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'name')) db.exec(`ALTER TABLE sessions ADD COLUMN name TEXT`);
  }
  if (fromVersion < 10) {
    // v9 -> v10: `name` and `label` unify into `label`; `--name` now seeds the label at launch.
    // Fold any existing name into an empty label, mirror it into the FTS row, drop the column.
    // Seeds re-apply every scan (seedLabelsFromNames), so no rescan.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (cols.some(c => c.name === 'name')) {
      db.exec(`UPDATE sessions SET label = name
               WHERE (label IS NULL OR label = '') AND name IS NOT NULL AND name != ''`);
      db.exec(`UPDATE session_text SET label = COALESCE(
                 (SELECT label FROM sessions WHERE sessions.id = session_text.session_id), '')`);
      db.exec(`ALTER TABLE sessions DROP COLUMN name`);
    }
  }
  if (fromVersion < 11) {
    // v10 -> v11: the Claude scanner captures the ExitPlanMode plan markdown at scan time so
    // `agents sessions --json` can surface it without consumers (Factory NEEDS-YOU panel)
    // re-reading raw JSONL. Additive; rescan to backfill.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'plan')) db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 12) {
    // v11 -> v12: `output_tokens`, the real generated-token count, separate from `token_count`
    // (which sums cache reads/writes and is dominated by re-counted context). Powers `agents
    // insights output`. Additive; rescan to backfill.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'output_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN output_tokens INTEGER`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 13) {
    // v12 → v13: routine runs archive their sandboxed transcript into the run
    // directory and get indexed as origin='routine', linked by routine_name and
    // routine_run_id. Existing rows are normal CLI-origin sessions.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'origin')) db.exec(`ALTER TABLE sessions ADD COLUMN origin TEXT DEFAULT 'cli'`);
    if (!cols.some(c => c.name === 'routine_name')) db.exec(`ALTER TABLE sessions ADD COLUMN routine_name TEXT`);
    if (!cols.some(c => c.name === 'routine_run_id')) db.exec(`ALTER TABLE sessions ADD COLUMN routine_run_id TEXT`);
    db.exec(`UPDATE sessions SET origin = 'cli' WHERE origin IS NULL OR origin = ''`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 14) {
    // v13 -> v14: discovery short-circuits readdir + per-file stat of leaf transcript dirs whose
    // (mtime, entry_count) is unchanged, cached in the new `dir_ledger`. Clear scan_ledger so the
    // first scan does a full walk that seeds both ledgers.
    db.exec(`
      CREATE TABLE IF NOT EXISTS dir_ledger (
        dir_path TEXT PRIMARY KEY,
        dir_mtime_ms INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        scanned_at INTEGER NOT NULL
      );
      DELETE FROM scan_ledger;
    `);
  }

  if (fromVersion < 15) {
    // v14 -> v15: the Claude scan becomes resumable (B-1). scan_ledger gains a `parser_state`
    // continuation blob and a `content_text` cache. Add both and clear scan_ledger so the first
    // scan reseeds the cursor from byte 0.
    const cols = db.prepare(`PRAGMA table_info(scan_ledger)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'parser_state')) db.exec(`ALTER TABLE scan_ledger ADD COLUMN parser_state TEXT`);
    if (!cols.some(c => c.name === 'content_text')) db.exec(`ALTER TABLE scan_ledger ADD COLUMN content_text TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 16) {
    // v15 -> v16: repair rows poisoned by the empty-shortId bug (fixed in deriveShortId): an id
    // that was only a known prefix derived to '', matching nothing in `short_id LIKE ?`. Rows
    // don't self-heal, so repair in place with `substr(id, 1, 8)`. No rescan.
    db.exec(`UPDATE sessions SET short_id = substr(id, 1, 8) WHERE short_id IS NULL OR short_id = ''`);
  }

  if (fromVersion < 17) {
    // v16 → v17 (main): todos / recent dirs / linear project metadata.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'todos')) db.exec(`ALTER TABLE sessions ADD COLUMN todos TEXT`);
    if (!cols.some(c => c.name === 'recent_directories_touched')) db.exec(`ALTER TABLE sessions ADD COLUMN recent_directories_touched TEXT`);
    if (!cols.some(c => c.name === 'linear_project')) db.exec(`ALTER TABLE sessions ADD COLUMN linear_project TEXT`);
    if (!cols.some(c => c.name === 'linear_project_url')) db.exec(`ALTER TABLE sessions ADD COLUMN linear_project_url TEXT`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 18) {
    // v17 → v18: persist origin machine for smart-launch affinity GROUP BY machine.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'machine')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN machine TEXT`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_machine_ts ON sessions(machine, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_ts ON sessions(agent, timestamp DESC);
    `);
    const rows = db
      .prepare(`SELECT id, agent, file_path FROM sessions WHERE machine IS NULL OR machine = ''`)
      .all() as Array<{ id: string; agent: string; file_path: string }>;
    const upd = db.prepare(`UPDATE sessions SET machine = ? WHERE id = ?`);
    // migrateSchema runs inside getDB's schema transaction, so these writes
    // deliberately share that transaction instead of opening a nested one.
    for (const row of rows) {
      upd.run(machineForSessionFile(row.file_path, row.agent), row.id);
    }
  }

  if (fromVersion < 19) {
    // v18 -> v19: actor provenance (RUSH-2018): who initiated the session and the actor's kind.
    // Populated at write time from the resolved actor, not derivable from the transcript, so no
    // ledger wipe; existing rows stay NULL.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'actor')) db.exec(`ALTER TABLE sessions ADD COLUMN actor TEXT`);
    if (!cols.some(c => c.name === 'initiated_by')) db.exec(`ALTER TABLE sessions ADD COLUMN initiated_by TEXT`);
  }

  if (fromVersion < 20) {
    // v19 → v20: persist the transcript's model for the static session list.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'model')) db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 21) {
    // v20 -> v21: persist the team a session spawned (`agents teams create/add`), derived at scan
    // time but dropped for lack of a column. Wipe BOTH ledgers: with dir_ledger intact, archived
    // dirs are treated as unchanged and would stay NULL forever.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'spawned_team')) db.exec(`ALTER TABLE sessions ADD COLUMN spawned_team TEXT`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 22) {
    // v21 → v22: persist the transcript's aggregate tool-call count.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'tool_call_count')) db.exec(`ALTER TABLE sessions ADD COLUMN tool_call_count INTEGER`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 23) {
    // v22 -> v23: persist usedBrowser/usedComputer (#11) so the picker preview need not regex the
    // transcript per render. Derived from the events log, so no ledger wipe. No DEFAULT on
    // purpose: NULL means not yet computed, distinct from false.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'used_browser')) db.exec(`ALTER TABLE sessions ADD COLUMN used_browser INTEGER`);
    if (!cols.some(c => c.name === 'used_computer')) db.exec(`ALTER TABLE sessions ADD COLUMN used_computer INTEGER`);
  }

  if (fromVersion < 24) {
    // v23 → v24: session_resource_usage (#12) — skill/slash-command usage per
    // session, joined against the currently-installed resource/plugin for
    // provenance. No ledger wipe: writeResourceUsage() owns this table.
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_resource_usage (
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        plugin TEXT,
        source TEXT,
        repo_root TEXT,
        snapshot_sha TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (session_id, kind, name)
      );
      CREATE INDEX IF NOT EXISTS idx_session_resource_usage_kind_name ON session_resource_usage(kind, name);
      CREATE INDEX IF NOT EXISTS idx_session_resource_usage_plugin ON session_resource_usage(plugin);
    `);
  }

  if (fromVersion < 25) {
    // v24 → v25: tool-call evidence uses an independent ledger. Do not clear
    // scan_ledger or dir_ledger: normal session listing stays warm, while tool
    // history is filled once on demand.
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        call_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        source_call_id TEXT,
        timestamp TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        outcome TEXT NOT NULL,
        exit_code INTEGER,
        status_code INTEGER,
        error_code TEXT,
        output TEXT,
        error TEXT,
        parse_error TEXT,
        evidence_bytes INTEGER NOT NULL,
        UNIQUE(session_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON tool_calls(outcome);
      CREATE TABLE IF NOT EXISTS tool_call_programs (
        call_key TEXT NOT NULL,
        program TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY(call_key, program)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_call_programs_program ON tool_call_programs(program, call_key);
      CREATE VIRTUAL TABLE IF NOT EXISTS tool_call_text USING fts5(
        call_key UNINDEXED,
        tool,
        input,
        output,
        error,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS tool_scan_ledger (
        file_path TEXT PRIMARY KEY,
        file_mtime_ms INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        extractor_version INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        call_count INTEGER NOT NULL,
        evidence_bytes INTEGER NOT NULL
      );
    `);
  }

  if (fromVersion < 26) {
    // v25 → v26: make append accounting O(changed calls), including empty
    // deltas, instead of reading every historical evidence row per append.
    const callCols = db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>;
    if (!callCols.some((column) => column.name === 'evidence_bytes')) {
      db.exec(`ALTER TABLE tool_calls ADD COLUMN evidence_bytes INTEGER NOT NULL DEFAULT 0`);
    }
    const ledgerCols = db.prepare(`PRAGMA table_info(tool_scan_ledger)`).all() as Array<{ name: string }>;
    if (!ledgerCols.some((column) => column.name === 'evidence_bytes')) {
      db.exec(`ALTER TABLE tool_scan_ledger ADD COLUMN evidence_bytes INTEGER NOT NULL DEFAULT 0`);
    }
    // The first tool schema existed only in prerelease development builds. Force its tool
    // evidence through one bounded rebuild rather than trusting zeroed totals.
    db.exec(`DELETE FROM tool_scan_ledger`);
  }

  if (fromVersion < 27) {
    // v26 -> v27: the original unicode word tokenizer could not prefilter the substring semantics
    // of input/output/error queries. Rebuild only the derived FTS table from already-redacted call
    // rows; transcripts and both ledgers stay warm.
    db.exec(`
      DROP TABLE IF EXISTS tool_call_text;
      CREATE VIRTUAL TABLE tool_call_text USING fts5(
        call_key UNINDEXED,
        tool,
        input,
        output,
        error,
        tokenize = 'trigram'
      );
      INSERT INTO tool_call_text (call_key, tool, input, output, error)
      SELECT call_key, tool, input, coalesce(output, ''), coalesce(error, '')
      FROM tool_calls;
    `);
  }

  if (fromVersion < 28) {
    // v27 → v28: retain every static program occurrence instead of only the
    // distinct program set. The source transcript is rebuilt only by the
    // explicit tools backfill; normal session and directory ledgers stay warm.
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_program_occurrences (
        call_key TEXT NOT NULL,
        occurrence_ordinal INTEGER NOT NULL,
        program TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL CHECK(role IN ('wrapper', 'effective')),
        PRIMARY KEY(call_key, occurrence_ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_program_occurrences_program
        ON tool_program_occurrences(program, call_key);
      DELETE FROM tool_scan_ledger;
    `);
  }

  if (fromVersion < 29) {
    // v28 → v29: coverage and query planning address the independent tool
    // ledger by session id. Rebuild only this derived ledger so a tool query
    // never has to resolve or stat transcript paths.
    db.exec(`
      DROP TABLE tool_scan_ledger;
      CREATE TABLE tool_scan_ledger (
        session_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        file_mtime_ms INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        extractor_version INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        call_count INTEGER NOT NULL,
        evidence_bytes INTEGER NOT NULL
      );
    `);
  }

  if (fromVersion < 30) {
    // v29 → v30: prerelease tool-index builds temporarily used schema versions
    // later owned by independent main migrations. Repair from the physical
    // schema because a v29 marker alone cannot prove these columns are present.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!cols.has('tool_call_count')) {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN tool_call_count INTEGER;
        DELETE FROM scan_ledger;
        DELETE FROM dir_ledger;
      `);
    }
    if (!cols.has('used_browser')) db.exec(`ALTER TABLE sessions ADD COLUMN used_browser INTEGER`);
    if (!cols.has('used_computer')) db.exec(`ALTER TABLE sessions ADD COLUMN used_computer INTEGER`);
  }

  if (fromVersion < 31) {
    // v30 -> v31: independent ledger for the explicit resource-usage backfill (`agents sessions
    // backfill resources`). Do NOT wipe scan_ledger: listing stays warm, and historical rows fill
    // once on demand like the tool-index ledger (v25).
    db.exec(`
      CREATE TABLE IF NOT EXISTS resource_scan_ledger (
        session_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        file_mtime_ms INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        extractor_version INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        resource_count INTEGER NOT NULL
      );
    `);
  }

  if (fromVersion < 32) {
    // v31 → v32: persist the effective managed launch mode so resume can
    // restore the same permission boundary instead of falling back to a CLI
    // default that may be more or less permissive.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!cols.has('mode')) db.exec(`ALTER TABLE sessions ADD COLUMN mode TEXT`);
  }

  if (fromVersion < 33) {
    // v32 -> v33: attribute each Claude session to the account that produced it; `account` held
    // one process-global email stamped on every row. Do NOT wipe scan_ledger: attribution is a
    // pure function of the stored (file_path, version), so rows are repaired in place (as v31).
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!cols.has('account_key')) db.exec(`ALTER TABLE sessions ADD COLUMN account_key TEXT`);
    if (!cols.has('account_org')) db.exec(`ALTER TABLE sessions ADD COLUMN account_org TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_account_key ON sessions(account_key)`);
    backfillClaudeAccounts(db);
  }

  if (fromVersion < 34) {
    // v33 -> v34: claude-opus-5 and claude-sonnet-5 were missing from the pricing table, so both
    // priced to $0 silently (526 sessions on one index). Flush ONLY the affected transcripts from
    // scan_ledger; a blanket delete breaks the warm-ledger contract.
    db.exec(`
      DELETE FROM scan_ledger
      WHERE file_path IN (
        SELECT file_path FROM sessions
        WHERE cost_usd IS NULL
          AND file_path IS NOT NULL AND file_path <> ''
          AND (model LIKE 'claude-opus-5%' OR model LIKE 'claude-sonnet-5%')
      );
    `);
  }

  if (fromVersion < 35) {
    // v34 -> v35 (RUSH-2211): `ORDER BY IFNULL(last_activity, timestamp)` could not use
    // idx_sessions_last_activity, so every list query did a full sort. Only pre-v8 rows or test
    // seeds can be NULL; backfill so the column is NOT NULL and sorts on the bare column.
    db.exec(`UPDATE sessions SET last_activity = timestamp WHERE last_activity IS NULL`);
  }

  if (fromVersion < 36) {
    // v35 -> v36: make the tool index incremental and stop a full FTS scan per deleted call. (a)
    // tool_scan_ledger gains a resume point (NULL: re-read once from byte 0). (b) tool_call_text
    // is rebuilt so its rowid mirrors tool_calls.rowid.
    const ledgerCols = new Set(
      (db.prepare(`PRAGMA table_info(tool_scan_ledger)`).all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!ledgerCols.has('parser_state')) db.exec(`ALTER TABLE tool_scan_ledger ADD COLUMN parser_state TEXT`);
    if (!ledgerCols.has('parsed_offset')) db.exec(`ALTER TABLE tool_scan_ledger ADD COLUMN parsed_offset INTEGER`);
    db.exec(`
      DROP TABLE IF EXISTS tool_call_text;
      CREATE VIRTUAL TABLE tool_call_text USING fts5(
        call_key UNINDEXED,
        tool,
        input,
        output,
        error,
        tokenize = 'trigram'
      );
      INSERT INTO tool_call_text (rowid, call_key, tool, input, output, error)
      SELECT rowid, call_key, tool, input, coalesce(output, ''), coalesce(error, '')
      FROM tool_calls;
    `);
  }

  if (fromVersion < 37) {
    // v36 -> v37: persist the burn split (uncached input / cache-read / cache-write) and a
    // no-cache cost for `agents insights output` (RUSH-2287). Nullable columns, no ledger flush.
    // Old rows stay NULL until re-scanned; an absent split reads as "not available", never zero.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('input_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER`);
    if (!cols.has('cache_read_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER`);
    if (!cols.has('cache_write_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER`);
    if (!cols.has('cost_usd_nocache')) db.exec(`ALTER TABLE sessions ADD COLUMN cost_usd_nocache REAL`);
  }

  if (fromVersion < 38) {
    // v37 -> v38: archived_at (RUSH-2436). The local DB is authoritative for content: a session
    // whose file is gone but whose user turns live in session_text is kept (flagged archived).
    // Nullable, no ledger flush; querySessions fills it lazily.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'archived_at')) db.exec(`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`);
  }

  if (fromVersion < 39) {
    // v38 -> v39: durable tool-session metadata (RUSH-2549). Browser task identity lived in the
    // daemon's tasks.json (stopping a task erased the session link) and computer-use history
    // expired from the 7-day event ledger. Pure additions, no ledger flush.
    db.exec(`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        task TEXT NOT NULL,
        profile TEXT NOT NULL,
        session_id TEXT,
        launch_id TEXT,
        actor TEXT,
        machine TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity INTEGER,
        screenshot_count INTEGER NOT NULL DEFAULT 0,
        pdf_count INTEGER NOT NULL DEFAULT 0,
        recording_count INTEGER NOT NULL DEFAULT 0,
        download_count INTEGER NOT NULL DEFAULT 0,
        capture_dir TEXT,
        captures_remote TEXT,
        PRIMARY KEY (profile, task)
      );
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_session ON browser_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_started ON browser_sessions(started_at DESC);

      CREATE TABLE IF NOT EXISTS computer_sessions (
        invocation_id TEXT PRIMARY KEY,
        session_id TEXT,
        launch_id TEXT,
        actor TEXT,
        machine TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity INTEGER,
        action_count INTEGER NOT NULL DEFAULT 0,
        task_preview TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_computer_sessions_session ON computer_sessions(session_id);
      CREATE INDEX IF NOT EXISTS idx_computer_sessions_started ON computer_sessions(started_at DESC);
    `);
  }

  if (fromVersion < 40) {
    // v39 -> v40: persist the fan-out a session left (sub-agents, backgrounded shells;
    // RUSH-3091/3095), so remote/unindexed rows (formatMetaOnlyBody) can render them. Nullable, no
    // ledger flush. NULL (not computed) is distinct from 0 (none found).
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('sub_agent_count')) db.exec(`ALTER TABLE sessions ADD COLUMN sub_agent_count INTEGER`);
    if (!cols.has('background_shell_count')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN background_shell_count INTEGER`);
    }
  }

  if (fromVersion < 41) {
    // v40 -> v41: persist the custom-harness/profile name (PHNX-2935). Discovery keys `agent` on
    // the host, so `agents sessions` could not tell `agents run deepseek` from native claude.
    // Additive, no ledger flush: it is launch metadata from the actor sidecar.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('harness')) db.exec(`ALTER TABLE sessions ADD COLUMN harness TEXT`);
  }

  if (fromVersion < 42) {
    // v41 -> v42: index the agent's answers too: session_text gains an `assistant` column (own
    // FTS5 column, lower BM25 weight); scan_ledger gains `extractor_version`. FTS5 can't ALTER, so
    // rename, recreate and copy rows back; search never blacks out.
    db.exec(`ALTER TABLE session_text RENAME TO session_text_v41`);
    db.exec(`
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        label,
        topic,
        project,
        content,
        assistant,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.exec(`
      INSERT INTO session_text (session_id, label, topic, project, content, assistant)
      SELECT session_id, label, topic, project, content, '' FROM session_text_v41
    `);
    db.exec(`DROP TABLE session_text_v41`);

    const ledgerCols = db.prepare(`PRAGMA table_info(scan_ledger)`).all() as Array<{ name: string }>;
    if (!ledgerCols.some(c => c.name === 'extractor_version')) {
      db.exec(`ALTER TABLE scan_ledger ADD COLUMN extractor_version INTEGER`);
    }
    // No `DELETE FROM scan_ledger`: the new column is NULL on every row, which never equals
    // CONTENT_INDEX_VERSION, so every session re-extracts on its next scan while Claude/Codex
    // parser_state/content_text stay intact.
  }

  if (fromVersion < 43) {
    // v42 -> v43: persist a per-tool-call END timestamp (PHNX-3437). Waste was booked from the gap
    // to the next call, so a long-blocking last call registered ~0. Additive, no ledger flush;
    // NULL degrades to the gap heuristic. TOOL_INDEX_VERSION 7 -> 8 re-derives it.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('end_timestamp')) db.exec(`ALTER TABLE tool_calls ADD COLUMN end_timestamp TEXT`);
  }

  if (fromVersion < 44) {
    // v43 -> v44: backfill duration_ms for harnesses whose extractor never derived it (PHNX-3457;
    // 52% of the corpus), skewing the console median short. Repair in place from stored timestamps
    // in JS (julianday rejects 'Z'). Unresolvable NULLs stay NULL.
    const nullDurationRows = db.prepare(
      `SELECT id, timestamp, last_activity FROM sessions
       WHERE duration_ms IS NULL AND last_activity IS NOT NULL`,
    ).all() as Array<{ id: string; timestamp: string; last_activity: string }>;
    // Runs inside migrateSchema's own transaction (db.ts:1468), so no nested
    // db.transaction() here — that would raise "transaction within a transaction".
    const update = db.prepare(`UPDATE sessions SET duration_ms = ? WHERE id = ?`);
    for (const row of nullDurationRows) {
      const startMs = Date.parse(row.timestamp);
      const lastMs = Date.parse(row.last_activity);
      if (Number.isFinite(startMs) && Number.isFinite(lastMs) && lastMs > startMs) {
        update.run(lastMs - startMs, row.id);
      }
    }
  }

  if (fromVersion < 45) {
    // v44 -> v45: retain the full first genuine user turn apart from the one-line topic. The
    // CONTENT_INDEX_VERSION bump re-parses transcripts through the normal incremental scan, so
    // existing rows backfill without a second transcript reader.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('first_user_message')) db.exec(`ALTER TABLE sessions ADD COLUMN first_user_message TEXT`);
  }

  if (fromVersion < 46) {
    // v45 -> v46: mirror provenance for fleet-synced peer session digests (PHNX-3792). Additive,
    // no ledger wipe: written only by the session-mirror consume path, never a transcript scan, so
    // a local row keeps them NULL.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('mirror_synced_at')) db.exec(`ALTER TABLE sessions ADD COLUMN mirror_synced_at INTEGER`);
    if (!cols.has('mirror_source')) db.exec(`ALTER TABLE sessions ADD COLUMN mirror_source TEXT`);
    // The idx_sessions_mirror_synced index is created unconditionally after this
    // block (fresh DBs skip migrations), alongside idx_sessions_last_activity.
  }

  if (fromVersion < 47) {
    // v46 -> v47: the actor's Phoenix id (PHNX-3798). Additive write-once launch metadata joined
    // from the actor sidecar, like actor/initiated_by (v19), so no ledger wipe; rows stay NULL
    // until the sidecar join fills them.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('phoenix_id')) db.exec(`ALTER TABLE sessions ADD COLUMN phoenix_id TEXT`);
  }

  if (fromVersion < 48) {
    // v47 -> v48: retain the latest genuine user turn beside the first (PHNX-3939): after
    // /continue or a redirect it is the operative request. No CONTENT_INDEX_VERSION bump (unlike
    // v45): a full re-parse pinned the daemon. The incremental scan fills it.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('last_user_message')) db.exec(`ALTER TABLE sessions ADD COLUMN last_user_message TEXT`);
  }

  if (fromVersion < 49) {
    // v48 -> v49: account-first storage (PHNX-3940).
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name),
    );
    if (!cols.has('account_id')) db.exec(`ALTER TABLE sessions ADD COLUMN account_id TEXT`);
  }

  if (fromVersion < 50) {
    // v49 -> v50: the daemon-generated session title (PHNX-3797). Additive, no ledger wipe: only
    // the session-title service writes these (the scanner's upsert never names them). Rows stay
    // NULL until titled; the recap ladder falls back to the first user message.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('generated_title')) db.exec(`ALTER TABLE sessions ADD COLUMN generated_title TEXT`);
    if (!cols.has('generated_title_key')) db.exec(`ALTER TABLE sessions ADD COLUMN generated_title_key TEXT`);
    if (!cols.has('generated_title_at')) db.exec(`ALTER TABLE sessions ADD COLUMN generated_title_at INTEGER`);
  }

  if (fromVersion < 51) {
    // v50 -> v51: session_text rows move to their sessions row's rowid (PHNX-4154). Keyed only by
    // UNINDEXED session_id, each delete scanned 669 MB, and mirror ingest issued one per row in a
    // daemon tick, freezing the event loop. Same shape as v42: rename, recreate, copy back, drop.
    db.exec(`ALTER TABLE session_text RENAME TO session_text_v50`);
    db.exec(`
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        label,
        topic,
        project,
        content,
        assistant,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.exec(`
      INSERT OR REPLACE INTO session_text (rowid, session_id, label, topic, project, content, assistant)
      SELECT s.rowid, t.session_id, t.label, t.topic, t.project, t.content, t.assistant
      FROM session_text_v50 t JOIN sessions s ON s.id = t.session_id
      ORDER BY t.rowid
    `);
    db.exec(`DROP TABLE session_text_v50`);
  }

}

/** Stamp `account_key` / `account_org` / `account` on every Claude row from its `file_path` and
 * recorded `version`. Used by the v33 migration; idempotent. */
function backfillClaudeAccounts(
  db: Database.Database,
  scope: 'all' | 'unresolved' = 'all',
): void {
  // 'unresolved' exists so the getDB repair touches only broken rows: re-resolving every Claude
  // row would downgrade a correct row whose version home was since uninstalled and pruned. The
  // migration wants 'all'.
  const where = scope === 'all'
    ? `agent = 'claude'`
    : `agent = 'claude' AND (account_key IS NULL
         OR (account_key LIKE 'unattributed:%' AND account IS NOT NULL))`;
  const index = buildClaudeAccountIndex();
  const rows = db.prepare(
    `SELECT id, file_path, version FROM sessions WHERE ${where}`,
  ).all() as Array<{ id: string; file_path: string; version: string | null }>;
  if (rows.length === 0) return;

  // `account` is overwritten, not COALESCEd: pre-v33 rows carry a wrong globally-resolved email,
  // and keeping it on an unattributable row would show a known-false address and disagree with the
  // scan path. A dark row reads NULL.
  const update = db.prepare(
    `UPDATE sessions SET account_key = ?, account_org = ?, account = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const bucket = resolveClaudeAccount(index, row.file_path ?? '', row.version, readSessionActorRecord(row.id)?.accountId);
    update.run(bucket.key, bucket.orgName, bucket.email, row.id);
  }
}

/** Open (or return the cached) sessions database, applying migrations as needed. */
export function getDB(initialBusyTimeoutMs = 30_000): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  // Wait up to 30s on SQLITE_BUSY, installed before journal_mode since concurrent first opens can
  // race for its schema lock. Many agents open this DB at once and a first scan can exceed 10s;
  // the ledger recheck in upsertSessionsBatch makes later writers fast.
  try {
    db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(initialBusyTimeoutMs))}`);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.exec(SCHEMA);

    // `session_remote_preview_cache` is a lazy cache table (like the others
    // below), independent of SCHEMA_VERSION — but it shipped once already
    // without `last_caller_revision` before this column was added, so a DB
    // that already ran that earlier version has the table WITHOUT the column,
    // and `CREATE TABLE IF NOT EXISTS` above is a no-op against it. Guard with
    // the same PRAGMA-table_info pattern the versioned `sessions` migrations
    // use, so an existing cache DB gains the column instead of every read/write
    // throwing "no such column".
    const remotePreviewCacheCols = db.prepare(`PRAGMA table_info(session_remote_preview_cache)`).all() as Array<{ name: string }>;
    if (!remotePreviewCacheCols.some(c => c.name === 'last_caller_revision')) {
      db.exec(`ALTER TABLE session_remote_preview_cache ADD COLUMN last_caller_revision TEXT`);
    }

    const readSchemaVersion = (): number | undefined => {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
      return row ? parseInt(row.value, 10) : undefined;
    };
    const currentVersion = readSchemaVersion();

    if (currentVersion === undefined) {
      db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
    } else if (currentVersion < SCHEMA_VERSION) {
      // Re-read after BEGIN IMMEDIATE acquires the writer lock. A second process
      // may have completed the migration while this connection was waiting.
      const migrate = db.transaction(() => {
        const lockedVersion = readSchemaVersion();
        if (lockedVersion === undefined || lockedVersion >= SCHEMA_VERSION) return;
        migrateSchema(db, lockedVersion);
        db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
      });
      migrate();
    }

    // Index last_activity only after the column is guaranteed to exist (fresh DBs from CREATE
    // TABLE, pre-v8 DBs from the migration). It must not live in SCHEMA, which runs before
    // migration.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_origin ON sessions(origin)`);
    // Same fresh-vs-migrated rule: the column is guaranteed above (fresh from
    // CREATE TABLE, existing from migration v46), so index the mirror pruner's
    // scan column here rather than in SCHEMA (PHNX-3792).
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_mirror_synced ON sessions(mirror_synced_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_routine_run_id ON sessions(routine_run_id)`);
    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (['account_id', 'phoenix_id'].some(name => !sessionColumns.some(column => column.name === name))) {
      // Partial upgrades can stamp the current version before every column exists.
      // Recheck under the writer lock so concurrent openers cannot add it twice.
      db.transaction(() => {
        const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'account_id')) db.exec('ALTER TABLE sessions ADD COLUMN account_id TEXT');
        if (!columns.some(column => column.name === 'phoenix_id')) db.exec('ALTER TABLE sessions ADD COLUMN phoenix_id TEXT');
      })();
    }

    // Account attribution repair: an older CLI's INSERT writes NULL, and a DB migrated before the
    // "clear the stale email" fix keeps a wrong address. The v33 migration never reruns, so repair
    // here, with a cheap guard first. Same shape as the `machine` repair.
    {
      // Column guard first, like the `machine` repair: schema_version can be stamped without the
      // column (getDB writes the marker for a DB with no meta row and migrateSchema never runs),
      // and an unguarded account_key query would throw.
      const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
      if (cols.some((c) => c.name === 'account_key') && cols.some((c) => c.name === 'account_org')) {
        const needsRepair = db.prepare(`
          SELECT 1 FROM sessions
          WHERE agent = 'claude'
            AND (account_key IS NULL
                 OR (account_key LIKE 'unattributed:%' AND account IS NOT NULL))
          LIMIT 1
        `).get();
        if (needsRepair) db.transaction(() => backfillClaudeAccounts(db, 'unresolved'))();
      }
    }

    // machine column + indexes: only after the column is guaranteed present.
    // Fresh SCHEMA (v17) includes the column; older DBs get it from migrate v17.
    // If a partial upgrade left schema_version ahead of the column, repair here.
    {
      const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'machine')) {
        db.exec(`ALTER TABLE sessions ADD COLUMN machine TEXT`);
        const rows = db
          .prepare(`SELECT id, agent, file_path FROM sessions WHERE machine IS NULL OR machine = ''`)
          .all() as Array<{ id: string; agent: string; file_path: string }>;
        const upd = db.prepare(`UPDATE sessions SET machine = ? WHERE id = ?`);
        const txn = db.transaction((items: typeof rows) => {
          for (const r of items) {
            upd.run(machineForSessionFile(r.file_path, r.agent), r.id);
          }
        });
        txn(rows);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_machine_ts ON sessions(machine, timestamp DESC)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent_ts ON sessions(agent, timestamp DESC)`);
    }

    // harness column: only after it is guaranteed present. schema_version can be stamped ahead of
    // the column (`currentVersion === undefined` skips migrateSchema), so repair here so the next
    // upsert naming `harness` does not throw (PHNX-2935). Same shape as the `machine` repair.
    {
      const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'harness')) {
        db.exec(`ALTER TABLE sessions ADD COLUMN harness TEXT`);
      }
    }

    // One-shot cleanup of the pre-SQLite JSONL indexes. Safe — nothing reads
    // them anymore. Guarded by a meta flag so we only try once.
    const cleaned = db.prepare(`SELECT value FROM meta WHERE key = 'legacy_indexes_removed'`).get() as { value: string } | undefined;
    if (!cleaned) {
      for (const p of [
        path.join(SESSIONS_DIR, 'index.jsonl'),
        path.join(SESSIONS_DIR, 'content_index.jsonl'),
        path.join(SESSIONS_DIR, 'index.jsonl.bak'),
      ]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
      }
      db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('legacy_indexes_removed', '1')`).run();
    }

    db.pragma('busy_timeout = 30000');
    dbInstance = db;
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Bound synchronous cache contention without changing other database callers. */
export function withSessionDBTimeout<T>(timeoutMs: number, operation: () => T): T {
  const db = getDB(timeoutMs);
  const previous = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
  try { return operation(); }
  finally { db.pragma(`busy_timeout = ${previous}`); }
}

/** Close the cached database connection. */
export function closeDB(): void {
  clearSessionExistenceCache();
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    // Closing the connection finalizes its prepared statements, so drop the cached upsert/FTS
    // statements too and rebuild against the fresh connection (else "statement has been finalized"
    // on the first upsert).
    cachedStmts = {};
  }
}

interface FtsOptimizeResult {
  table: string;
  segmentsBefore: number;
  segmentsAfter: number;
}

/** Compact the session + tool-call FTS indexes. FTS5 appends a segment per insert and a tombstone
 * per delete, so rescans grew them to gigabytes of unmerged segments. `'optimize'` merges to one
 * segment non-destructively; VACUUM (daemon stopped) returns space. */
export function optimizeSessionSearchIndex(): FtsOptimizeResult[] {
  const db = getDB();
  // Hardcoded literals — never interpolate caller input into an identifier.
  const tables = ['tool_call_text', 'session_text'];
  const segments = (table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}_data`).get() as { n: number }).n;
  return tables.map((table) => {
    const segmentsBefore = segments(table);
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('optimize')`).run();
    return { table, segmentsBefore, segmentsAfter: segments(table) };
  });
}

/** Segment count above which a scan pays for a slice of merge work. Below it the index is small
 * enough that merging is pure overhead. */
const FTS_MAINTENANCE_SEGMENT_THRESHOLD = 512;

/** Page budget for one incremental merge. FTS5's `'merge'` stops after this much work (unlike the
 * unbounded `'optimize'`), so the cost per scan is fixed and repeated scans converge the index. */
const FTS_MAINTENANCE_MERGE_PAGES = 64;

/** Keep the FTS indexes healthy on the scan path. `optimizeSessionSearchIndex` (`agents sessions
 * optimize`) was the only compaction, so indexes grew until a human ran it. This counterpart is
 * bounded, threshold-gated and non-destructive. */
export function maintainSessionSearchIndex(
  db: Database.Database = getDB(),
  options: { segmentThreshold?: number; mergePages?: number } = {},
): FtsOptimizeResult[] {
  const threshold = options.segmentThreshold ?? FTS_MAINTENANCE_SEGMENT_THRESHOLD;
  const pages = options.mergePages ?? FTS_MAINTENANCE_MERGE_PAGES;
  // Hardcoded literals — never interpolate caller input into an identifier.
  const tables = ['tool_call_text', 'session_text'];
  const segments = (table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}_data`).get() as { n: number }).n;
  const results: FtsOptimizeResult[] = [];
  for (const table of tables) {
    const segmentsBefore = segments(table);
    if (segmentsBefore < threshold) continue;
    db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', ?)`).run(pages);
    results.push({ table, segmentsBefore, segmentsAfter: segments(table) });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Scan coordinator — prevents concurrent full scans across processes
// ---------------------------------------------------------------------------

/** How long a scan claim is trusted before it's considered stale (ms). */
const SCAN_CLAIM_TTL_MS = 120_000; // 2 minutes

function isProcessAlive(pid: number): boolean {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Try to claim the right to run the incremental scan; false means another live process is
 * scanning. Uses the `meta` table so it survives crashes (dead PIDs via process.kill(pid, 0),
 * stale entries via TTL). Runs in BEGIN IMMEDIATE: bare WAL DML can hit SQLITE_BUSY_SNAPSHOT. */
export function tryClaimScan(pid: number): boolean {
  const db = getDB();

  const txn = db.transaction((): boolean => {
    const existing = db
      .prepare(`SELECT value FROM meta WHERE key = 'scan_in_progress'`)
      .get() as { value: string } | undefined;

    if (existing) {
      const parts = existing.value.split(':');
      const existingPid = parseInt(parts[0], 10);
      const existingTs = parseInt(parts[1], 10);
      const ageMs = Date.now() - existingTs;
      if (isProcessAlive(existingPid) && ageMs < SCAN_CLAIM_TTL_MS) {
        return false; // another live process is scanning — skip
      }
      // Dead PID or expired TTL — take over below
    }

    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('scan_in_progress', ?)`)
      .run(`${pid}:${Date.now()}`);
    return true;
  });

  return txn();
}

/** Read-only probe: is a scan in progress, held by a LIVE process within the TTL? (RUSH-2682).
 * Unlike {@link tryClaimScan} it never writes, so a caller that lost the claim can wait instead of
 * returning the pre-scan snapshot. */
export function scanInProgressByLivePid(): boolean {
  const db = getDB();
  const existing = db
    .prepare(`SELECT value FROM meta WHERE key = 'scan_in_progress'`)
    .get() as { value: string } | undefined;
  if (!existing) return false;
  const parts = existing.value.split(':');
  const pid = parseInt(parts[0], 10);
  const ts = parseInt(parts[1], 10);
  return isProcessAlive(pid) && Date.now() - ts < SCAN_CLAIM_TTL_MS;
}

/** Release the scan claim written by tryClaimScan, only if it still belongs to this process (guards
 * against TTL takeovers). */
export function releaseScan(pid: number): void {
  const db = getDB();
  const txn = db.transaction((): void => {
    const existing = db
      .prepare(`SELECT value FROM meta WHERE key = 'scan_in_progress'`)
      .get() as { value: string } | undefined;
    if (!existing) return;
    const claimPid = parseInt(existing.value.split(':')[0], 10);
    if (claimPid === pid) {
      db.prepare(`DELETE FROM meta WHERE key = 'scan_in_progress'`).run();
    }
  });
  txn();
}

/** Return the absolute path to the sessions database file. */
export function getDBPath(): string {
  return DB_PATH;
}

/** The file stat stamp stored at the last scan of a file path; callers compare it to the current
 * fs.stat to decide whether to rescan. */
export function getScanStampByPath(filePath: string): ScanStamp | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT file_mtime_ms, file_size, scanned_at, extractor_version FROM scan_ledger WHERE file_path = ? LIMIT 1`)
    .get(canonicalLedgerKey(filePath)) as { file_mtime_ms: number; file_size: number; scanned_at: number; extractor_version: number | null } | undefined;
  return row
    ? { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, scannedAt: row.scanned_at, extractorVersion: row.extractor_version }
    : null;
}

/** Bulk-load the stamp ledger for a set of file paths in one SQL query: the incremental scanner's
 * fast path, avoiding N+1 queries. */
export function getScanStampsForPaths(filePaths: string[]): Map<string, ScanStamp> {
  const result = new Map<string, ScanStamp>();
  if (filePaths.length === 0) return result;
  const db = getDB();

  // Multiple input paths can resolve to one canonical key (a session JSONL via `~/.claude/...` and
  // `~/.agents/versions/...`). Query by canonical key, then fan results back out to every original
  // alias.
  const canonicalToOriginals = new Map<string, string[]>();
  for (const fp of filePaths) {
    const canonical = canonicalLedgerKey(fp);
    const aliases = canonicalToOriginals.get(canonical);
    if (aliases) aliases.push(fp);
    else canonicalToOriginals.set(canonical, [fp]);
  }

  const canonicalKeys = [...canonicalToOriginals.keys()];

  // SQLite parameter limit is typically 999 / 32766 — chunk defensively.
  const CHUNK = 500;
  for (let i = 0; i < canonicalKeys.length; i += CHUNK) {
    const chunk = canonicalKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT file_path, file_mtime_ms, file_size, scanned_at, extractor_version
        FROM scan_ledger
        WHERE file_path IN (${placeholders})
      `)
      .all(...chunk) as Array<{
        file_path: string;
        file_mtime_ms: number;
        file_size: number;
        scanned_at: number;
        extractor_version: number | null;
      }>;

    for (const row of rows) {
      const stamp = {
        fileMtimeMs: row.file_mtime_ms,
        fileSize: row.file_size,
        scannedAt: row.scanned_at,
        extractorVersion: row.extractor_version,
      };
      for (const original of canonicalToOriginals.get(row.file_path) || []) {
        result.set(original, stamp);
      }
    }
  }
  return result;
}

/** A file's persisted resumable-parse continuation from scan_ledger: `parserState` is the
 * serialized {@link ClaudeParserState} (offset + accumulator) and `contentText` the accumulated
 * user doc, used to choose full vs incremental and to hydrate the resume. */
interface ParserStateRow {
  parserState: string | null;
  contentText: string | null;
  fileMtimeMs: number;
  fileSize: number;
  scannedAt: number;
  /** See {@link ScanStamp.extractorVersion}. A mismatch vs CONTENT_INDEX_VERSION
   *  means this continuation predates the current content extractor and MUST
   *  be treated as absent (forcing a full re-parse) rather than resumed from. */
  extractorVersion: number | null;
}

/** Bulk-load the resumable-parse continuation (parser_state + content_text) plus stamp for a set of
 * file paths in one chunked query, mirroring {@link getScanStampsForPaths} (canonical keys, fanned
 * back to aliases). Avoids an N+1 of {@link getScanStampByPath}. */
export function getParserStatesForPaths(filePaths: string[]): Map<string, ParserStateRow> {
  const result = new Map<string, ParserStateRow>();
  if (filePaths.length === 0) return result;
  const db = getDB();

  const canonicalToOriginals = new Map<string, string[]>();
  for (const fp of filePaths) {
    const canonical = canonicalLedgerKey(fp);
    const aliases = canonicalToOriginals.get(canonical);
    if (aliases) aliases.push(fp);
    else canonicalToOriginals.set(canonical, [fp]);
  }

  const canonicalKeys = [...canonicalToOriginals.keys()];
  const CHUNK = 500;
  for (let i = 0; i < canonicalKeys.length; i += CHUNK) {
    const chunk = canonicalKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT file_path, file_mtime_ms, file_size, scanned_at, parser_state, content_text, extractor_version
        FROM scan_ledger
        WHERE file_path IN (${placeholders})
      `)
      .all(...chunk) as Array<{
        file_path: string;
        file_mtime_ms: number;
        file_size: number;
        scanned_at: number;
        parser_state: string | null;
        content_text: string | null;
        extractor_version: number | null;
      }>;

    for (const row of rows) {
      const state: ParserStateRow = {
        parserState: row.parser_state,
        contentText: row.content_text,
        fileMtimeMs: row.file_mtime_ms,
        fileSize: row.file_size,
        scannedAt: row.scanned_at,
        extractorVersion: row.extractor_version,
      };
      for (const original of canonicalToOriginals.get(row.file_path) || []) {
        result.set(original, state);
      }
    }
  }
  return result;
}

/** Record scan stamps for files we looked at, including ones we chose not to index (e.g.
 * malformed). */
export function recordScans(entries: Array<{ filePath: string; scan: ScanStamp }>): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at, extractor_version)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at,
      extractor_version = excluded.extractor_version
  `);
  const now = Date.now();
  const txn = db.transaction((items: typeof entries) => {
    for (const { filePath, scan } of items) {
      // Stamp the CURRENT content extractor version even for a file that yielded no session:
      // today's extractor ran and produced nothing, so it is current; else an unparseable file
      // would re-trigger "changed" on every scan after a CONTENT_INDEX_VERSION bump.
      stmt.run(canonicalLedgerKey(filePath), scan.fileMtimeMs, scan.fileSize, now, CONTENT_INDEX_VERSION);
    }
  });
  txn(entries);
}

/** Snapshot of a leaf transcript directory used to detect create/delete/rename. */
export interface DirStamp {
  dirMtimeMs: number;
  entryCount: number;
}

/** Bulk-load the dir ledger for a set of leaf directories in one SQL query, mirroring {@link
 * getScanStampsForPaths}: keyed by canonical path (symlinked version home and realpath collapse)
 * and fanned back to every alias. */
export function getDirLedgerForPaths(dirs: string[]): Map<string, DirStamp> {
  const result = new Map<string, DirStamp>();
  if (dirs.length === 0) return result;
  const db = getDB();

  const canonicalToOriginals = new Map<string, string[]>();
  for (const d of dirs) {
    const canonical = canonicalLedgerKey(d);
    const aliases = canonicalToOriginals.get(canonical);
    if (aliases) aliases.push(d);
    else canonicalToOriginals.set(canonical, [d]);
  }

  const canonicalKeys = [...canonicalToOriginals.keys()];
  const CHUNK = 500;
  for (let i = 0; i < canonicalKeys.length; i += CHUNK) {
    const chunk = canonicalKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT dir_path, dir_mtime_ms, entry_count
        FROM dir_ledger
        WHERE dir_path IN (${placeholders})
      `)
      .all(...chunk) as Array<{ dir_path: string; dir_mtime_ms: number; entry_count: number }>;

    for (const row of rows) {
      const stamp: DirStamp = { dirMtimeMs: row.dir_mtime_ms, entryCount: row.entry_count };
      for (const original of canonicalToOriginals.get(row.dir_path) || []) {
        result.set(original, stamp);
      }
    }
  }
  return result;
}

/** Upsert dir-scan stamps after a full readdir of a leaf transcript dir, so the next scan can skip
 * it when (mtime, entry_count) is unchanged. Mirrors {@link recordScans}. */
export function recordDirScans(
  entries: Array<{ dirPath: string; dirMtimeMs: number; entryCount: number }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO dir_ledger (dir_path, dir_mtime_ms, entry_count, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(dir_path) DO UPDATE SET
      dir_mtime_ms = excluded.dir_mtime_ms,
      entry_count = excluded.entry_count,
      scanned_at = excluded.scanned_at
  `);
  const now = Date.now();
  const txn = db.transaction((items: typeof entries) => {
    for (const { dirPath, dirMtimeMs, entryCount } of items) {
      stmt.run(canonicalLedgerKey(dirPath), dirMtimeMs, entryCount, now);
    }
  });
  txn(entries);
}

const upsertSessionStmt = (db: Database.Database) => db.prepare(`
  INSERT INTO sessions (
    id, short_id, agent, harness, origin, routine_name, routine_run_id,
    version, account, account_key, account_id, account_org, mode, timestamp, last_activity,
    project, cwd, git_branch, topic, first_user_message, last_user_message, label, message_count, token_count,
    output_tokens, input_tokens, cache_read_tokens, cache_write_tokens,
    cost_usd, cost_usd_nocache, duration_ms, model, tool_call_count,
    file_path, file_mtime_ms, file_size, scanned_at, is_team_origin,
    pr_url, pr_number, worktree_slug, ticket_id, spawned_team,
    sub_agent_count, background_shell_count, plan, todos,
    recent_directories_touched, linear_project, linear_project_url, machine,
    actor, initiated_by, phoenix_id, used_browser, used_computer
  ) VALUES (
    @id, @short_id, @agent, @harness, @origin, @routine_name, @routine_run_id,
    @version, @account, @account_key, @account_id, @account_org, @mode, @timestamp, @last_activity,
    @project, @cwd, @git_branch, @topic, @first_user_message, @last_user_message, @label, @message_count, @token_count,
    @output_tokens, @input_tokens, @cache_read_tokens, @cache_write_tokens,
    @cost_usd, @cost_usd_nocache, @duration_ms, @model, @tool_call_count,
    @file_path, @file_mtime_ms, @file_size, @scanned_at, @is_team_origin,
    @pr_url, @pr_number, @worktree_slug, @ticket_id, @spawned_team,
    @sub_agent_count, @background_shell_count, @plan, @todos,
    @recent_directories_touched, @linear_project, @linear_project_url, @machine,
    @actor, @initiated_by, @phoenix_id, @used_browser, @used_computer
  )
  ON CONFLICT(id) DO UPDATE SET
    short_id = excluded.short_id,
    agent = excluded.agent,
    -- Custom harness/profile name is launch metadata, not transcript-derived.
    -- COALESCE(existing, incoming) keeps a stored stamp on rescan (the scanner
    -- carries none) and backfills a NULL-first row once the sidecar lands —
    -- the same write-once pattern as actor/initiated_by (PHNX-2935).
    harness = COALESCE(sessions.harness, excluded.harness),
    origin = excluded.origin,
    routine_name = excluded.routine_name,
    routine_run_id = excluded.routine_run_id,
    -- Origin version is write-once launch metadata, like mode/harness/actor:
    -- backfill a NULL-first row once the launch sidecar lands, and keep the
    -- recorded version across a rescan that cannot re-derive it (a codex
    -- transcript outside a versions/agent/ path, or the durable sidecar aged
    -- out) — the same COALESCE the launch-metadata columns use, so native resume
    -- stops falling back for a missing recorded origin (PHNX-3626).
    version = COALESCE(excluded.version, sessions.version),
    account = excluded.account,
    account_key = excluded.account_key,
    account_org = excluded.account_org,
    account_id = COALESCE(sessions.account_id, excluded.account_id),
    mode = COALESCE(excluded.mode, sessions.mode),
    timestamp = excluded.timestamp,
    last_activity = excluded.last_activity,
    project = excluded.project,
    cwd = excluded.cwd,
    git_branch = excluded.git_branch,
    topic = excluded.topic,
    first_user_message = COALESCE(excluded.first_user_message, sessions.first_user_message),
    -- Unlike the first turn, the LATEST one moves: a new turn must replace the
    -- stored value, so this is excluded-wins with a COALESCE only to keep a
    -- known value when a rescan cannot re-derive one.
    last_user_message = COALESCE(excluded.last_user_message, sessions.last_user_message),
    -- Never let an empty/placeholder incoming label clobber a good stored one.
    -- A real incoming label (non-empty after trim) still wins; a blank one keeps
    -- the label seeded by --name (seedLabelsFromNames) or refined by an agent
    -- title / rename (syncLabels). A bare rescan carries no label, so it must
    -- preserve, not erase, the good one already stored.
    label = CASE
      WHEN excluded.label IS NULL OR trim(excluded.label) = '' THEN sessions.label
      ELSE excluded.label
    END,
    message_count = excluded.message_count,
    token_count = excluded.token_count,
    output_tokens = excluded.output_tokens,
    input_tokens = excluded.input_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    cost_usd = excluded.cost_usd,
    cost_usd_nocache = excluded.cost_usd_nocache,
    duration_ms = excluded.duration_ms,
    model = excluded.model,
    tool_call_count = excluded.tool_call_count,
    file_path = excluded.file_path,
    file_mtime_ms = excluded.file_mtime_ms,
    file_size = excluded.file_size,
    scanned_at = excluded.scanned_at,
    is_team_origin = excluded.is_team_origin,
    pr_url = excluded.pr_url,
    pr_number = excluded.pr_number,
    worktree_slug = excluded.worktree_slug,
    ticket_id = excluded.ticket_id,
    spawned_team = excluded.spawned_team,
    sub_agent_count = COALESCE(excluded.sub_agent_count, sessions.sub_agent_count),
    background_shell_count = COALESCE(excluded.background_shell_count, sessions.background_shell_count),
    plan = excluded.plan,
    todos = excluded.todos,
    recent_directories_touched = excluded.recent_directories_touched,
    used_browser = excluded.used_browser,
    used_computer = excluded.used_computer,
    linear_project = CASE
      WHEN excluded.ticket_id IS NOT sessions.ticket_id THEN excluded.linear_project
      ELSE COALESCE(excluded.linear_project, sessions.linear_project)
    END,
    linear_project_url = CASE
      WHEN excluded.ticket_id IS NOT sessions.ticket_id THEN excluded.linear_project_url
      ELSE COALESCE(excluded.linear_project_url, sessions.linear_project_url)
    END,
    machine = excluded.machine,
    -- actor / initiated_by record who launched the session. COALESCE(existing,
    -- incoming) keeps a stored owner (a rescan carries no actor -> excluded.actor
    -- is NULL -> the stored value wins, never clobbered) BUT backfills a row that
    -- was inserted NULL-first — e.g. an older scanner, or any scan that ran before
    -- the actor sidecar landed — once the sidecar-join finally provides one. Plain
    -- exclusion locked those rows to NULL forever (RUSH-2018/2019 fix).
    actor = COALESCE(sessions.actor, excluded.actor),
    initiated_by = COALESCE(sessions.initiated_by, excluded.initiated_by),
    -- Phoenix id rides the same write-once join as actor/initiated_by: a rescan
    -- carries none (excluded.phoenix_id is NULL -> stored value wins), but a row
    -- indexed NULL-first backfills once the sidecar-join finally provides one.
    phoenix_id = COALESCE(sessions.phoenix_id, excluded.phoenix_id),
    -- A genuine local transcript write (the scanner always carries a non-empty
    -- file_path) reclaims a row that was first seeded as a peer mirror: clear the
    -- mirror provenance so pruneMirrorSessions (which deletes mirror_synced_at IS
    -- NOT NULL rows past the age cutoff) can never delete real local content, and
    -- so queryLocalOriginSessionsForMirror (mirror_synced_at IS NULL) re-publishes
    -- it. Without this the stamp set by upsertMirrorSession survived a later real
    -- scan, since an omitted column keeps its prior value on upsert (PHNX-3792).
    -- An empty-file write (a host-dispatch stub) is NOT a real transcript, so it
    -- leaves the stamp intact — matching the mirror guard's own file_path test.
    mirror_synced_at = CASE
      WHEN excluded.file_path IS NOT NULL AND excluded.file_path <> '' THEN NULL
      ELSE sessions.mirror_synced_at
    END,
    mirror_source = CASE
      WHEN excluded.file_path IS NOT NULL AND excluded.file_path <> '' THEN NULL
      ELSE sessions.mirror_source
    END
`);

/** Did this session emit a browser/computer-automation event? A sessionId-filtered read of the
 * events log (stamped with AGENT_SESSION_ID at emit), not a transcript re-scan. Independent of
 * {@link enrichCachedSessionMeta}, which skips claude/codex, so it must run for every agent. */
function detectToolUsage(sessionId: string): { usedBrowser: boolean; usedComputer: boolean } {
  const usedBrowser = queryEvents({ sessionId, eventTypes: ['browser.navigate', 'browser.screenshot'], limit: 1 }).length > 0;
  const usedComputer = queryEvents({ sessionId, eventTypes: ['computer.action'], limit: 1 }).length > 0;
  return { usedBrowser, usedComputer };
}

const deleteResourceUsageStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_resource_usage WHERE session_id = ?`);
/** Named-bind shape for {@link insertResourceUsageStmt}. Declared so both call sites are
 * type-checked: bun binds named parameters strictly and a MISSING key throws (node binds NULL),
 * which would abort the whole batch on the shipped binary's runtime. */
interface ResourceUsageBind {
  session_id: string;
  kind: 'skill' | 'command';
  name: string;
  count: number;
  plugin: string | null;
  source: string | null;
  repo_root: string | null;
  snapshot_sha: string | null;
}

const insertResourceUsageStmt = (db: Database.Database) => db.prepare(`
  INSERT INTO session_resource_usage (session_id, kind, name, plugin, source, repo_root, snapshot_sha, count)
  VALUES (@session_id, @kind, @name, @plugin, @source, @repo_root, @snapshot_sha, @count)
`);

/** Resolve a skill/slash-command's provenance for `session_resource_usage` (#12). Flat resources
 * use resolveResource(); namespaced ones (`rush:design`) are plugin-owned, so resolve against the
 * plugin list. Neither found returns all-undefined. */
function resolveResourceProvenance(
  kind: 'skills' | 'commands',
  name: string,
  cwd: string | undefined,
  plugins: DiscoveredPlugin[],
): { plugin?: string; source?: string; repoRoot?: string; snapshotSha?: string } {
  const listOf = (p: DiscoveredPlugin) => (kind === 'skills' ? p.skills : p.commands);
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0) {
    const pluginName = name.slice(0, colonIdx);
    const shortName = name.slice(colonIdx + 1);
    const plugin = plugins.find((p) => p.name === pluginName && listOf(p).includes(shortName));
    if (!plugin) return {};
    return { plugin: plugin.name, source: plugin.marketplace, repoRoot: plugin.repoRoot, snapshotSha: plugin.snapshotSha };
  }
  const resolved = resolveResource(kind, name, cwd);
  if (resolved) return { source: resolved.source, repoRoot: resolved.repoRoot, snapshotSha: resolved.snapshotSha };
  const plugin = plugins.find((p) => listOf(p).includes(name));
  if (!plugin) return {};
  return { plugin: plugin.name, source: plugin.marketplace, repoRoot: plugin.repoRoot, snapshotSha: plugin.snapshotSha };
}

/** Persist already-computed skill/slash-command tallies into `session_resource_usage`, replacing
 * prior rows. `discoverPlugins()` (real I/O) runs only when there is something to resolve. No own
 * transaction: nested ones are unsupported and `upsertSessionsBatch` calls this inside its own. */
function writeResourceUsageFromTallies(
  sessionId: string,
  skills: Array<{ name: string; count: number }>,
  commands: Array<{ name: string; count: number }>,
  cwd: string | undefined,
): void {
  const db = getDB();
  const del = deleteResourceUsageStmt(db);
  const ins = insertResourceUsageStmt(db);
  del.run(sessionId);
  if (skills.length === 0 && commands.length === 0) return;
  const plugins = discoverPlugins({ cwd });
  for (const { name, count } of skills) {
    const prov = resolveResourceProvenance('skills', name, cwd, plugins);
    const bind: ResourceUsageBind = {
      session_id: sessionId, kind: 'skill', name, count,
      plugin: prov.plugin ?? null, source: prov.source ?? null,
      repo_root: prov.repoRoot ?? null, snapshot_sha: prov.snapshotSha ?? null,
    };
    ins.run(bind);
  }
  for (const { name, count } of commands) {
    const bare = name.replace(/^\//, '');
    const prov = resolveResourceProvenance('commands', bare, cwd, plugins);
    const bind: ResourceUsageBind = {
      session_id: sessionId, kind: 'command', name: bare, count,
      plugin: prov.plugin ?? null, source: prov.source ?? null,
      repo_root: prov.repoRoot ?? null, snapshot_sha: prov.snapshotSha ?? null,
    };
    ins.run(bind);
  }
}

/** Persist skill/slash-command usage by deriving tallies from a full parsed transcript. Used by
 * {@link enrichCachedSessionMeta} for every harness except claude/codex, which pre-compute them
 * incrementally (see writeResourceUsageFromTallies). */
function writeResourceUsage(sessionId: string, events: SessionEvent[], cwd: string | undefined): void {
  writeResourceUsageFromTallies(sessionId, extractSkills(events), extractSlashCommands(events), cwd);
}

/** Fan-out the session left behind, from an already-parsed transcript (never a re-parse).
 * `backgroundShellCount` is `undefined`, not 0, for a harness that cannot report it: 0 asserts
 * "none started", undefined "not recorded", and renders omit both. */
function fanOutCounts(
  events: SessionEvent[],
  agent: SessionAgentId,
): { subAgentCount: number; backgroundShellCount: number | undefined } {
  let subAgentCount = 0;
  for (const e of events) {
    if (e.type !== 'tool_use' || e._local) continue;
    if (isSubAgentTool(e.tool || '', e.command || '')) subAgentCount++;
  }
  return {
    subAgentCount,
    backgroundShellCount: harnessTracksBackgroundShells(agent)
      ? extractBackgroundShells(events).length
      : undefined,
  };
}

/** Fold transcript-derived metadata that every parser can supply uniformly. */
function enrichMetaFromEvents(meta: SessionMeta, events: SessionEvent[]): SessionMeta {
  return {
    ...meta,
    firstUserMessage: meta.firstUserMessage ?? firstUserMessageFromEvents(events),
    lastUserMessage: meta.lastUserMessage ?? lastUserMessageFromEvents(events),
    todos: extractTodoProgressFromEvents(events),
    recentDirectoriesTouched: extractRecentDirectoriesTouched(events, meta.cwd),
    ...fanOutCounts(events, meta.agent),
  };
}

function enrichCachedSessionMeta(meta: SessionMeta): SessionMeta {
  if (!meta.filePath) return meta;
  try {
    const events = parseSession(meta.filePath, meta.agent);
    writeResourceUsage(meta.id, events, meta.cwd);
    return enrichMetaFromEvents(meta, events);
  } catch {
    // Synthetic/cloud rows can intentionally name a transcript that is not local.
    return meta;
  }
}

/** The one way to address a session's FTS row: its rowid is the sessions rowid. A `session_id = ?`
 * predicate scans the whole index (the PHNX-4154 daemon freeze). */
const SESSION_TEXT_ROWID = `(SELECT rowid FROM sessions WHERE id = ?)`;

const deleteTextStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`);
// Binds the session id twice: once for the rowid lookup, once for the column.
const insertTextStmt = (db: Database.Database) =>
  db.prepare(`INSERT INTO session_text (rowid, session_id, label, topic, project, content, assistant) VALUES (${SESSION_TEXT_ROWID}, ?, ?, ?, ?, ?, ?)`);
// Read back the label the upsert actually stored (which may be the preserved
// one, not the incoming blank) so the FTS label column stays consistent with
// sessions.label after a bare rescan.
const readLabelStmt = (db: Database.Database) =>
  db.prepare(`SELECT label FROM sessions WHERE id = ?`);

let cachedStmts: {
  upsert?: Database.Statement<SessionRow>;
  delText?: Database.Statement<unknown[]>;
  insText?: Database.Statement<unknown[]>;
  readLabel?: Database.Statement<unknown[]>;
} = {};

function stmts(db: Database.Database) {
  if (!cachedStmts.upsert) {
    cachedStmts = {
      upsert: upsertSessionStmt(db) as Database.Statement<SessionRow>,
      delText: deleteTextStmt(db),
      insText: insertTextStmt(db),
      readLabel: readLabelStmt(db),
    };
  }
  return cachedStmts as Required<typeof cachedStmts>;
}

/** The label stored for a session, as FTS text (never NULL). Called inside the upsert transaction
 * after the row upsert, so it reflects the ON CONFLICT preserve-non-empty-label rule, not the raw
 * incoming label. */
function storedFtsLabel(readLabel: Database.Statement<unknown[]>, id: string): string {
  const row = readLabel.get(id) as { label: string | null } | undefined;
  return row?.label ?? '';
}

/** Resolve origin machine for a row: prefer caller-stamped meta, else path. */
function resolveMachine(meta: SessionMeta): string {
  if (meta.machine && meta.machine.trim()) return meta.machine.trim();
  return machineForSessionFile(meta.filePath, meta.agent);
}

/** Upsert a session row and replace its FTS5 content in one transaction. `content` is the
 * tokenizable user-prompt text; '' leaves the row unsearchable. */
export function upsertSession(meta: SessionMeta, content: string, scan?: ScanStamp, assistantContent = ''): void {
  meta = enrichCachedSessionMeta(meta);
  // Join the durable sessionId -> actor sidecar (RUSH-2019) when the caller carries no actor. ON
  // CONFLICT COALESCEs actor/initiated_by, so this fills a fresh row and backfills a null-first
  // one, while an actor-less rescan keeps the stored owner.
  const actorRec = meta.actor && meta.accountId ? undefined : readSessionActorRecord(meta.id);
  const toolUsage = detectToolUsage(meta.id);
  const db = getDB();
  const { upsert, delText, insText, readLabel } = stmts(db);
  const row: SessionRow = {
    id: meta.id,
    short_id: meta.shortId,
    agent: meta.agent,
    harness: meta.harness ?? actorRec?.harness ?? null,
    origin: meta.origin ?? 'cli',
    routine_name: meta.routineName ?? null,
    routine_run_id: meta.routineRunId ?? null,
    // Backfill the origin version from the launch-time sidecar when the scan can't derive one
    // (codex's `.codex-homes/<version>/`), the same write-once join as mode/harness, so native
    // resume stops falling back to `/continue` (PHNX-3626).
    version: meta.version ?? actorRec?.version ?? null,
    account: meta.account ?? null,
    account_key: meta.accountKey ?? null,
    account_id: meta.accountId ?? actorRec?.accountId ?? null,
    account_org: meta.accountOrg ?? null,
    mode: meta.mode ?? actorRec?.mode ?? null,
    timestamp: meta.timestamp,
    last_activity: resolveLastActivity(meta, scan),
    project: meta.project ?? null,
    cwd: meta.cwd ?? null,
    git_branch: meta.gitBranch ?? null,
    topic: meta.topic ?? null,
    first_user_message: meta.firstUserMessage ?? null,
    last_user_message: meta.lastUserMessage ?? null,
    label: meta.label ?? null,
    message_count: meta.messageCount ?? null,
    token_count: meta.tokenCount ?? null,
    output_tokens: meta.outputTokens ?? null,
    input_tokens: meta.inputTokens ?? null,
    cache_read_tokens: meta.cacheReadTokens ?? null,
    cache_write_tokens: meta.cacheWriteTokens ?? null,
    cost_usd: meta.costUsd ?? null,
    cost_usd_nocache: meta.costUsdNoCache ?? null,
    duration_ms: resolveDurationMs(meta, scan),
    model: meta.model ?? null,
    tool_call_count: meta.toolCallCount ?? null,
    file_path: meta.filePath,
    file_mtime_ms: scan?.fileMtimeMs ?? null,
    file_size: scan?.fileSize ?? null,
    scanned_at: Date.now(),
    is_team_origin: meta.isTeamOrigin ? 1 : 0,
    pr_url: meta.prUrl ?? null,
    pr_number: meta.prNumber ?? null,
    worktree_slug: meta.worktreeSlug ?? null,
    ticket_id: meta.ticketId ?? null,
    spawned_team: meta.spawnedTeam ?? null,
    sub_agent_count: meta.subAgentCount ?? null,
    background_shell_count: meta.backgroundShellCount ?? null,
    plan: meta.plan ?? null,
    todos: meta.todos ? JSON.stringify(meta.todos) : null,
    recent_directories_touched: meta.recentDirectoriesTouched ? JSON.stringify(meta.recentDirectoriesTouched) : null,
    linear_project: meta.linearProject ?? null,
    linear_project_url: meta.linearProjectUrl ?? null,
    machine: resolveMachine(meta),
    actor: meta.actor ?? actorRec?.actor ?? null,
    initiated_by: meta.initiatedBy ?? actorRec?.initiatedBy ?? null,
    phoenix_id: meta.phoenixId ?? actorRec?.phoenixId ?? null,
    used_browser: toolUsage.usedBrowser ? 1 : 0,
    used_computer: toolUsage.usedComputer ? 1 : 0,
  };

  const txn = db.transaction(() => {
    upsert.run(row);
    delText.run(meta.id);
    insText.run(
      meta.id,
      meta.id,
      // Use the label the upsert actually stored (preserve-non-empty rule),
      // not the raw incoming one, so FTS label ranking survives a bare rescan.
      storedFtsLabel(readLabel, meta.id),
      meta.topic ?? '',
      meta.project ?? '',
      content ?? '',
      assistantContent ?? '',
    );
  });
  txn();
}

/** A verified Codex rollout has one native owner; an older last-meta scan may have indexed its
 * child bytes under the parent id. Reconcile only successfully written paths after the whole
 * batch, so a real parent repaired in the same transaction keeps its row. */
function reconcileCodexFileOwners(db: Database.Database, metas: SessionMeta[]): void {
  const owners = new Map(metas.filter(meta => meta.agent === 'codex' && meta.filePath).map(meta => [meta.filePath, meta.id]));
  const paths = [...owners.keys()];
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const rows = db.prepare(`SELECT id, file_path FROM sessions WHERE agent = 'codex' AND file_path IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as Array<{ id: string; file_path: string }>;
    for (const row of rows) {
      if (owners.get(row.file_path) === row.id) continue;
      // The text row is keyed by the sessions rowid, so it goes before the row.
      db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`).run(row.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      for (const table of ['session_preview_cache', 'session_summaries', 'session_insights', 'session_topics', 'session_phenotypes', 'session_resource_usage', 'resource_scan_ledger']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(row.id);
      }
      // The tool ledger has a unique file path too; release the wrong binding
      // before the child evidence is persisted below. Transcript files stay put.
      purgeToolCalls(db, row.id);
    }
  }
}

/** Batch-upsert sessions with their FTS5 content and scan stamps in a single transaction. */
export function upsertSessionsBatch(
  entries: Array<{
    meta: SessionMeta;
    content: string;
    /** Assistant-answer text, accumulated the same way as `content` (the
     *  user-prompt text) but stored in session_text's own `assistant` column
     *  with a lower BM25 weight — see BM25_WEIGHTS. */
    assistantContent?: string;
    scan?: ScanStamp;
    parserState?: string;
    contentText?: string;
    events?: SessionEvent[];
    toolCalls?: IndexedToolCall[];
    toolScan?: ScanStamp;
    toolIndexMode?: 'replace' | 'append';
    /** Where the next scan of this full-file-harness session may resume its tool index (PHNX-3411).
     * Computed internally, not supplied by callers; persisted with the tool ledger so an active
     * session re-derives only newly appended calls. */
    toolResume?: ToolScanResumePoint | null;
  }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const { upsert, delText, insText, readLabel } = stmts(db);
  const now = Date.now();
  // One directory read for the whole batch: join the actor sidecar (RUSH-2019) for entries whose
  // meta carries no actor. ON CONFLICT COALESCEs the column, so it fills fresh and null-first rows
  // without clobbering a stored owner.
  const actorIndex = loadSessionActorIndex();
  // Persist the Claude resumable-parse continuation (parser_state + content_text) with the stamp
  // and the current extractor version, so the next scan can resume from the persisted offset
  // (B-2). Other scanners pass neither and leave both columns NULL.
  const ledger = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at, parser_state, content_text, extractor_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at,
      parser_state = excluded.parser_state,
      content_text = excluded.content_text,
      extractor_version = excluded.extractor_version
  `);

  // Lookup from canonical path to entry for re-checking the ledger after taking the lock: if a
  // concurrent process already committed the same files, matching (mtime, size) rows are skipped,
  // making the second writer near-instant.
  const byPath = new Map(
    entries
      .filter(e => e.scan && e.meta.filePath)
      .map(e => [canonicalLedgerKey(e.meta.filePath), e]),
  );
  const enrichedEntries = entries.map(entry => {
    if (entry.meta.agent === 'claude' || entry.meta.agent === 'codex' || !entry.meta.filePath) {
      // claude/codex keep their resumable-parse optimization (no transcript read here). If their
      // scanner handed normalized events, the counts are free; otherwise leave them undefined
      // (persists NULL, "not computed"). Never collapse to 0: see fanOutCounts.
      return entry.events
        ? { ...entry, meta: enrichMetaFromEvents(entry.meta, entry.events) }
        : entry;
    }
    // Harnesses whose scanners produce no events and whose parseSession reads a large flat
    // transcript. Parsing on the warm tick wedges the event loop (PHNX-3411), so defer to
    // runDeferredToolIndex. Not opencode: parseOpenCode is a fast targeted SQLite query.
    const LARGE_TRANSCRIPT_AGENTS: ReadonlySet<string> = new Set(['kimi', 'grok']);
    if (!entry.events && LARGE_TRANSCRIPT_AGENTS.has(entry.meta.agent)) {
      return entry;
    }
    // Enrich the entry from the scanner's events if present (no transcript re-read); else, e.g.
    // OpenCode whose scanner emits only metadata, fall back to parseSession (a fast SQLite query).
    // Expensive flat-file harnesses returned above.
    try {
      const toolSourcePath = toolEvidenceSourcePath(entry.meta.filePath, entry.meta.agent);
      const toolScan = toolSourcePath === entry.meta.filePath
        ? entry.scan
        : (() => {
            const stat = fs.statSync(toolSourcePath);
            return { fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
          })();
      const events = entry.events ?? parseSession(entry.meta.filePath, entry.meta.agent);
      writeResourceUsage(entry.meta.id, events, entry.meta.cwd);
      // Resume the tool index from the last scan when safe (PHNX-3411); a full re-derive
      // re-sanitized the whole history each tick and wedged the daemon. Only a pure append
      // resumes. No tool stamp means no size guard: full-scan.
      const prior = toolScan
        ? planEventToolResume(db, entry.meta.id, toolSourcePath, toolScan, events.length)
        : null;
      const scanned = scanEventToolCalls(events, prior ?? undefined);
      return {
        ...entry,
        meta: enrichMetaFromEvents(entry.meta, events),
        // The CHANGED calls only. On a resume these are the newly appended tail
        // (append-safe upsert); on a full scan they are the whole history.
        toolCalls: scanned.calls,
        toolScan,
        toolIndexMode: (prior ? 'append' : 'replace') as 'replace' | 'append',
        // Persist where the NEXT scan resumes: the collector snapshot + how many
        // events this scan folded.
        toolResume: { parserState: JSON.stringify(scanned.snapshot), parsedOffset: scanned.eventCount },
      };
    } catch {
      return entry;
    }
  });
  const writtenEntries: typeof enrichedEntries = [];

  // Pre-compute browser/computer usage for all sessions outside the write transaction:
  // detectToolUsage scans all event log files (O(files) per call), and holding the write lock
  // during that causes "DB locked" errors (RUSH-2006). One pass costs O(files) total.
  const toolUsageBySession = queryToolUsageForSessions(
    new Set(enrichedEntries.map(e => e.meta.id)),
  );

  const txn = db.transaction((items: typeof entries) => {
    // Re-read the ledger now that we hold the write lock. Any file committed
    // by a concurrent process since our pre-scan is visible here.
    const CHUNK = 500; // stay under SQLite's 999-variable limit
    const alreadyIndexed = new Set<string>();
    const paths = [...byPath.keys()];
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      const phs = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT file_path, file_mtime_ms, file_size, extractor_version FROM scan_ledger WHERE file_path IN (${phs})`)
        .all(...chunk) as Array<{ file_path: string; file_mtime_ms: number; file_size: number; extractor_version: number | null }>;
      for (const row of rows) {
        const entry = byPath.get(row.file_path);
        // A concurrent writer's row makes this entry redundant only if it is also current at
        // CONTENT_INDEX_VERSION; otherwise a (mtime, size) match would make the version lever a
        // no-op and skip the very batch a stale extractor_version scheduled.
        if (
          entry &&
          row.file_mtime_ms === entry.scan!.fileMtimeMs &&
          row.file_size === entry.scan!.fileSize &&
          row.extractor_version === CONTENT_INDEX_VERSION
        ) {
          alreadyIndexed.add(entry.meta.id);
        }
      }
    }

    for (const entry of items) {
      const { meta, content, assistantContent, scan, parserState, contentText } = entry;
      if (alreadyIndexed.has(meta.id)) continue;
      // Per-row guard: one malformed session must not abort the batch and break `agents sessions`.
      // A constraint error reverts only its statement, so skipping keeps the txn committable. The
      // ledger is not stamped for a skipped row, so the next scan retries it.
      const toolUsage = toolUsageBySession.get(meta.id) ?? { usedBrowser: false, usedComputer: false };
      // claude/codex skip enrichCachedSessionMeta above (to keep their resumable-parse
      // optimization), so write their pre-computed skillsUsed/slashCommandsUsed (folded by
      // discover.ts's accumulator) here; other harnesses got this from enrichCachedSessionMeta().
      if (meta.agent === 'claude' || meta.agent === 'codex') {
        writeResourceUsageFromTallies(meta.id, meta.skillsUsed ?? [], meta.slashCommandsUsed ?? [], meta.cwd);
      }
      try {
      // Typed, not a bare literal: bun binds named parameters strictly, where a MISSING key throws
      // (node binds NULL), and the per-row catch below swallows it, which is how account_key
      // shipped unbound. Annotating against SessionRow makes tsc reject the next omission.
      const row: SessionRow = {
        id: meta.id,
        short_id: meta.shortId,
        agent: meta.agent,
        harness: meta.harness ?? actorIndex.get(meta.id)?.harness ?? null,
        origin: meta.origin ?? 'cli',
        routine_name: meta.routineName ?? null,
        routine_run_id: meta.routineRunId ?? null,
        // Backfill the origin version from the launch-time sidecar when the scan
        // couldn't derive one — see the single-row upsert above (PHNX-3626).
        version: meta.version ?? actorIndex.get(meta.id)?.version ?? null,
        account: meta.account ?? null,
        account_key: meta.accountKey ?? null,
        account_id: meta.accountId ?? actorIndex.get(meta.id)?.accountId ?? null,
        account_org: meta.accountOrg ?? null,
        mode: meta.mode ?? actorIndex.get(meta.id)?.mode ?? null,
        timestamp: meta.timestamp,
        last_activity: resolveLastActivity(meta, scan),
        project: meta.project ?? null,
        cwd: meta.cwd ?? null,
        git_branch: meta.gitBranch ?? null,
        topic: meta.topic ?? null,
        first_user_message: meta.firstUserMessage ?? null,
        last_user_message: meta.lastUserMessage ?? null,
        label: meta.label ?? null,
        message_count: meta.messageCount ?? null,
        token_count: meta.tokenCount ?? null,
        output_tokens: meta.outputTokens ?? null,
        input_tokens: meta.inputTokens ?? null,
        cache_read_tokens: meta.cacheReadTokens ?? null,
        cache_write_tokens: meta.cacheWriteTokens ?? null,
        cost_usd: meta.costUsd ?? null,
        cost_usd_nocache: meta.costUsdNoCache ?? null,
        duration_ms: resolveDurationMs(meta, scan),
        model: meta.model ?? null,
        tool_call_count: meta.toolCallCount ?? null,
        file_path: meta.filePath,
        file_mtime_ms: scan?.fileMtimeMs ?? null,
        file_size: scan?.fileSize ?? null,
        scanned_at: now,
        is_team_origin: meta.isTeamOrigin ? 1 : 0,
        pr_url: meta.prUrl ?? null,
        pr_number: meta.prNumber ?? null,
        worktree_slug: meta.worktreeSlug ?? null,
        ticket_id: meta.ticketId ?? null,
        spawned_team: meta.spawnedTeam ?? null,
        sub_agent_count: meta.subAgentCount ?? null,
        background_shell_count: meta.backgroundShellCount ?? null,
        plan: meta.plan ?? null,
        todos: meta.todos ? JSON.stringify(meta.todos) : null,
        recent_directories_touched: meta.recentDirectoriesTouched ? JSON.stringify(meta.recentDirectoriesTouched) : null,
        linear_project: meta.linearProject ?? null,
        linear_project_url: meta.linearProjectUrl ?? null,
    machine: resolveMachine(meta),
        actor: meta.actor ?? actorIndex.get(meta.id)?.actor ?? null,
        initiated_by: meta.initiatedBy ?? actorIndex.get(meta.id)?.initiatedBy ?? null,
        phoenix_id: meta.phoenixId ?? actorIndex.get(meta.id)?.phoenixId ?? null,
        used_browser: toolUsage.usedBrowser ? 1 : 0,
        used_computer: toolUsage.usedComputer ? 1 : 0,
      };
      upsert.run(row);
      delText.run(meta.id);
      insText.run(
        meta.id,
        meta.id,
        // Mirror upsertSession: index the label the upsert actually stored
        // (preserve-non-empty rule), not the raw incoming one.
        storedFtsLabel(readLabel, meta.id),
        meta.topic ?? '',
        meta.project ?? '',
        content ?? '',
        assistantContent ?? '',
      );
      if (scan && meta.filePath) {
        ledger.run(
          canonicalLedgerKey(meta.filePath),
          scan.fileMtimeMs,
          scan.fileSize,
          now,
          parserState ?? null,
          contentText ?? null,
          CONTENT_INDEX_VERSION,
        );
      }
      writtenEntries.push(entry);
      } catch (err) {
        if (process.stderr.isTTY) {
          console.error(`Warning: skipped unindexable session ${meta.id}: ${(err as Error).message}`);
        }
      }
    }
    reconcileCodexFileOwners(db, writtenEntries.map(entry => entry.meta));
  });
  txn(enrichedEntries);
  // Tool evidence shares the transcript parse above but owns an independent
  // transaction/ledger. If this write fails, the normal session row remains
  // valid and ensureToolIndex retries from the missing tool ledger later.
  for (const entry of writtenEntries) {
    const toolScan = entry.toolScan ?? entry.scan;
    if (!toolScan || !entry.toolCalls) continue;
    try {
      // `resume` is set only by the full-file harness path above; claude/codex
      // pass none, so their tool ledger keeps carrying no event-offset resume
      // point (their resume rides the content-scan ledger instead) — unchanged.
      persistToolCalls(db, entry.meta, entry.toolCalls, toolScan, {
        mode: entry.toolIndexMode ?? 'replace',
        resume: entry.toolResume,
      });
    } catch {
      // Boundary is intentionally retryable via tool_scan_ledger.
    }
  }
  // Every batch appends FTS segments, so pay a bounded slice of the merge here and keep the scan
  // path's index healthy rather than leaving compaction to `agents sessions optimize` (RUSH-2208).
  // Threshold-gated: a small index costs two counts.
  maintainSessionSearchIndex(db);
}

/** Sync labels for a set of sessions: where the stored label differs, update `sessions.label` and
 * the FTS5 label column, leaving content/topic/project untouched. Cheap to call every run. */
export function syncLabels(labelMap: Map<string, string | null>): number {
  if (labelMap.size === 0) return 0;
  const db = getDB();
  const ids = [...labelMap.keys()];
  const CHUNK = 500;
  const updates: Array<{ id: string; label: string | null }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, label FROM sessions WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; label: string | null }>;
    for (const row of rows) {
      const live = labelMap.get(row.id)?.trim() || null;
      // A missing/empty live label means "no refinement yet", not "erase the
      // generated title or launch handle already stored for this session".
      if (live && live !== (row.label ?? '')) {
        updates.push({ id: row.id, label: live });
      }
    }
  }
  if (updates.length === 0) return 0;

  const updSessions = db.prepare(`UPDATE sessions SET label = ? WHERE id = ?`);
  const updFts = db.prepare(`UPDATE session_text SET label = ? WHERE rowid = ${SESSION_TEXT_ROWID}`);

  const txn = db.transaction((items: typeof updates) => {
    for (const { id, label } of items) {
      updSessions.run(label, id);
      updFts.run(label ?? '', id);
    }
  });
  txn(updates);
  return updates.length;
}

/** Seed session labels from `agents run --name` handles by session id, re-applied every scan since
 * the source is outside the transcript. It fills only an EMPTY label, so an agent-generated title
 * always wins. Runs after the per-agent scans; writes `sessions.label` and the FTS5 label column. */
export function seedLabelsFromNames(nameMap: Map<string, string | null>): number {
  if (nameMap.size === 0) return 0;
  const db = getDB();
  const ids = [...nameMap.keys()];
  const CHUNK = 500;
  const updates: Array<{ id: string; label: string }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, label FROM sessions WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; label: string | null }>;
    for (const row of rows) {
      const seed = nameMap.get(row.id);
      // Only fill an empty label; a real agent title (non-empty) always wins.
      if (seed && !(row.label ?? '').trim()) {
        updates.push({ id: row.id, label: seed });
      }
    }
  }
  if (updates.length === 0) return 0;

  const updSessions = db.prepare(`UPDATE sessions SET label = ? WHERE id = ?`);
  const updFts = db.prepare(`UPDATE session_text SET label = ? WHERE rowid = ${SESSION_TEXT_ROWID}`);
  const txn = db.transaction((items: typeof updates) => {
    for (const { id, label } of items) {
      updSessions.run(label, id);
      updFts.run(label, id);
    }
  });
  txn(updates);
  return updates.length;
}

/** Sync topics (session titles) by id for agents whose title lives in a side index updating
 * independently of the transcript (Codex `session_index.jsonl`). Updates `sessions.topic` and the
 * FTS5 topic column, only to a non-empty title that differs. Returns rows updated. */
export function syncTopics(topicMap: Map<string, string>): number {
  if (topicMap.size === 0) return 0;
  const db = getDB();
  const ids = [...topicMap.keys()];
  const CHUNK = 500;
  const updates: Array<{ id: string; topic: string }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, topic FROM sessions WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; topic: string | null }>;
    for (const row of rows) {
      const live = topicMap.get(row.id) ?? '';
      if (live && live !== (row.topic ?? '')) {
        updates.push({ id: row.id, topic: live });
      }
    }
  }
  if (updates.length === 0) return 0;

  const updSessions = db.prepare(`UPDATE sessions SET topic = ? WHERE id = ?`);
  const updFts = db.prepare(`UPDATE session_text SET topic = ? WHERE rowid = ${SESSION_TEXT_ROWID}`);

  const txn = db.transaction((items: typeof updates) => {
    for (const { id, topic } of items) {
      updSessions.run(topic, id);
      updFts.run(topic, id);
    }
  });
  txn(updates);
  return updates.length;
}

/** Convert a raw database row into a SessionMeta object. */
function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    shortId: row.short_id,
    agent: row.agent as SessionAgentId,
    harness: row.harness ?? undefined,
    origin: (row.origin === 'routine' ? 'routine' : 'cli'),
    routineName: row.routine_name ?? undefined,
    routineRunId: row.routine_run_id ?? undefined,
    timestamp: row.timestamp,
    lastActivity: row.last_activity ?? undefined,
    project: row.project ?? undefined,
    cwd: row.cwd ?? undefined,
    filePath: row.file_path,
    gitBranch: row.git_branch ?? undefined,
    messageCount: row.message_count ?? undefined,
    tokenCount: row.token_count ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    costUsdNoCache: row.cost_usd_nocache ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    model: row.model ?? undefined,
    toolCallCount: row.tool_call_count ?? undefined,
    version: row.version ?? undefined,
    account: row.account ?? undefined,
    accountKey: row.account_key ?? undefined,
    accountId: row.account_id ?? undefined,
    accountOrg: row.account_org ?? undefined,
    mode: isSessionRunMode(row.mode) ? row.mode : undefined,
    topic: row.topic ?? undefined,
    firstUserMessage: row.first_user_message ?? undefined,
    lastUserMessage: row.last_user_message ?? undefined,
    generatedTitle: row.generated_title ?? undefined,
    label: row.label ?? undefined,
    isTeamOrigin: row.is_team_origin === 1,
    prUrl: row.pr_url ?? undefined,
    prNumber: row.pr_number ?? undefined,
    worktreeSlug: row.worktree_slug ?? undefined,
    ticketId: row.ticket_id ?? undefined,
    spawnedTeam: row.spawned_team ?? undefined,
    subAgentCount: row.sub_agent_count ?? undefined,
    backgroundShellCount: row.background_shell_count ?? undefined,
    plan: row.plan ?? undefined,
    todos: parseJsonColumn(row.todos),
    recentDirectoriesTouched: parseJsonColumn(row.recent_directories_touched),
    linearProject: row.linear_project ?? undefined,
    linearProjectUrl: row.linear_project_url ?? undefined,
    machine: row.machine ?? undefined,
    actor: row.actor ?? undefined,
    // Narrow the free-text column to the known kinds; an unexpected value maps
    // to undefined rather than being asserted as a valid kind.
    initiatedBy: row.initiated_by === 'human' || row.initiated_by === 'agent' ? row.initiated_by : undefined,
    phoenixId: row.phoenix_id ?? undefined,
    // NULL = never computed by this scanner (legacy row) — leave undefined so
    // the sessions picker knows to fall back to the transcript-regex detection
    // instead of trusting a false "never used browser/computer".
    usedBrowser: row.used_browser === null ? undefined : row.used_browser === 1,
    usedComputer: row.used_computer === null ? undefined : row.used_computer === 1,
    // A stamped archived_at means the transcript file is gone but the session's
    // user turns still live in session_text — the row is served from the DB and
    // flagged, never dropped (RUSH-2436). NULL leaves both undefined (live row).
    archivedAt: row.archived_at ?? undefined,
    archived: row.archived_at != null ? true : undefined,
    mirrorSyncedAt: row.mirror_synced_at ?? undefined,
    mirrorSource: row.mirror_source ?? undefined,
  };
}

function isSessionRunMode(value: string | null): value is SessionRunMode {
  return value === 'plan' || value === 'edit' || value === 'auto' || value === 'skip';
}

function parseJsonColumn<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

/** The recency signal for sorting and labelling the listing: last-message time if a parser computed
 * it, else file mtime, else creation time. Guarded on `filePath` so synthetic/cloud rows use
 * creation time, not a bogus scan-time mtime. Always ISO, so it sorts against `timestamp`. */
function resolveLastActivity(meta: SessionMeta, scan?: ScanStamp): string {
  if (meta.lastActivity) return meta.lastActivity;
  if (scan?.fileMtimeMs && meta.filePath) return new Date(scan.fileMtimeMs).toISOString();
  return meta.timestamp;
}

/** The persisted wall-clock span (PHNX-3457), `lastTs - firstTs`. Extractors for
 * rush/grok/kimi/cursor/muse/antigravity never derived it (NULL for 52% of the corpus), skewing
 * the console median. Derived at the write boundary when absent; null if no positive span. */
function resolveDurationMs(meta: SessionMeta, scan?: ScanStamp): number | null {
  if (meta.durationMs != null) return meta.durationMs;
  const startMs = Date.parse(meta.timestamp);
  const lastMs = Date.parse(resolveLastActivity(meta, scan));
  if (Number.isFinite(startMs) && Number.isFinite(lastMs) && lastMs > startMs) {
    return lastMs - startMs;
  }
  return null;
}

export function isSessionActivityFresh(
  row: { last_activity: string | null; timestamp: string; file_mtime_ms: number | null },
  maxAgeMs: number,
  nowMs: number,
): boolean {
  const parsedActivityMs = Date.parse(row.last_activity ?? row.timestamp);
  const activityMs = Number.isFinite(parsedActivityMs) ? parsedActivityMs : row.file_mtime_ms ?? undefined;
  return activityMs != null && nowMs - activityMs <= maxAgeMs;
}

/** Persist a lazily resolved Linear project without reparsing the transcript. */
export function cacheLinearProject(sessionId: string, project: string, projectUrl: string): void {
  getDB().prepare(`UPDATE sessions SET linear_project = ?, linear_project_url = ? WHERE id = ?`)
    .run(project, projectUrl, sessionId);
}

/** Newest indexed session file for an agent in `cwd`, so the live `--active` scanner can locate a
 * Codex transcript (date-partitioned, not cwd-keyed) via the index. Undefined if not yet scanned;
 * the caller degrades to no live state. */
export function latestSessionFileForCwd(agent: SessionAgentId, cwd: string, options?: { maxAgeMs?: number; nowMs?: number }): string | undefined {
  if (!cwd) return undefined;
  let normalized = cwd;
  try { normalized = fs.realpathSync(cwd); } catch { /* use as-is */ }
  const db = getDB();
  const row = db
    .prepare(`SELECT file_path, last_activity, timestamp, file_mtime_ms
              FROM sessions
              WHERE agent = ? AND cwd = ?
              ORDER BY COALESCE(last_activity, timestamp) DESC
              LIMIT 1`)
    .get(agent, normalized) as { file_path: string; last_activity: string | null; timestamp: string; file_mtime_ms: number | null } | undefined;
  if (!row) return undefined;
  if (options?.maxAgeMs != null) {
    if (!isSessionActivityFresh(row, options.maxAgeMs, options.nowMs ?? Date.now())) return undefined;
  }
  return row.file_path;
}

/** Build a parameterized WHERE clause from query options. */
function buildSessionWhere(options: QueryOptions): { clause: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];

  if (options.agent) {
    where.push('agent = ?');
    params.push(options.agent);
  } else if (options.agents && options.agents.length > 0) {
    where.push(`agent IN (${options.agents.map(() => '?').join(',')})`);
    params.push(...options.agents);
  }

  if (options.version) {
    where.push('version = ?');
    params.push(options.version);
  }

  if (options.origin) {
    where.push("IFNULL(origin, 'cli') = ?");
    params.push(options.origin);
  }

  if (options.cwd) {
    where.push('cwd = ?');
    params.push(options.cwd);
  }

  if (options.cwdPrefix) {
    // A local stored cwd uses the host path separator (normalizeCwd), so the subdir wildcard must
    // too: a hardcoded '/' never matches a Windows `C:\a\b` subpath. A cwd from another machine
    // keeps its own separators, so the exact `cwd = ?` still holds.
    where.push('(cwd = ? OR cwd LIKE ?)');
    params.push(options.cwdPrefix, options.cwdPrefix + path.sep + '%');
  }

  if (options.project) {
    where.push('LOWER(IFNULL(project, \'\')) LIKE ?');
    params.push(`%${options.project.toLowerCase()}%`);
  }

  if (options.machine) {
    where.push('machine = ? COLLATE NOCASE');
    params.push(options.machine);
  }

  // id lookup: SQLite's LIKE is case-insensitive for ASCII, so a lowercased pattern matches
  // mixed-case ids; `=` adds COLLATE NOCASE for the same reason. short_id has its own index; id is
  // the PRIMARY KEY.
  if (options.idExact) {
    where.push('(id = ? COLLATE NOCASE OR short_id = ? COLLATE NOCASE OR routine_run_id = ? COLLATE NOCASE)');
    params.push(options.idExact, options.idExact, options.idExact);
  }
  if (options.idPrefix) {
    where.push('(id LIKE ? OR short_id LIKE ? OR routine_run_id LIKE ?)');
    params.push(`${options.idPrefix}%`, `${options.idPrefix}%`, `${options.idPrefix}%`);
  }

  if (typeof options.sinceMs === 'number') {
    // Compare as strings; ISO 8601 timestamps sort lexicographically.
    where.push('timestamp >= ?');
    params.push(new Date(options.sinceMs).toISOString());
  }

  if (typeof options.untilMs === 'number') {
    where.push('timestamp <= ?');
    params.push(new Date(options.untilMs).toISOString());
  }

  if (options.excludeTeamOrigin) {
    where.push('IFNULL(is_team_origin, 0) = 0');
  }
  if (options.onlyTeamOrigin) {
    where.push('IFNULL(is_team_origin, 0) = 1');
  }

  // #12: join against session_resource_usage via a subquery IN, not a JOIN on the base SELECT, so
  // `SELECT * FROM sessions` stays untouched for other buildSessionWhere() callers (countSessions,
  // the usage rollup).
  if (options.skill) {
    where.push(`id IN (
      SELECT session_id FROM session_resource_usage
      WHERE kind = 'skill' AND (name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE)
    )`);
    params.push(options.skill, `%:${options.skill}`);
  }
  if (options.plugin) {
    where.push(`id IN (SELECT session_id FROM session_resource_usage WHERE plugin = ? COLLATE NOCASE)`);
    params.push(options.plugin);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return { clause, params };
}

/** Resolve which file paths no longer exist, batching per directory (one `readdirSync` plus a Set
 * test instead of a stat per file; RUSH-2211). Membership sets are cached by directory mtime+size
 * (RUSH-2318). Falls back to per-file existsSync if a directory cannot be listed. */
interface DirectoryMembershipCacheEntry {
  mtimeMs: number;
  size: number;
  cachedAtMs: number;
  entries: Set<string>;
}

const directoryMembershipCache = new Map<string, DirectoryMembershipCacheEntry>();
let directoryMembershipSweepCount = 0;
const DIRECTORY_MTIME_SETTLE_MS = 2_000;

/** Process-local diagnostics for the real-filesystem existence-cache tests. */
export function getSessionExistenceCacheStats(): { sweeps: number } {
  return { sweeps: directoryMembershipSweepCount };
}

/** Clear process-local directory membership state when the session DB closes. */
function clearSessionExistenceCache(): void {
  directoryMembershipCache.clear();
  directoryMembershipSweepCount = 0;
}

function findMissingFilePaths(filePaths: string[]): Set<string> {
  // Existence is decided on the container file, not the raw path: a composite `file_path`
  // (`<container>#<id>`, e.g. OpenCode's `opencode.db#ses_...`) names a row inside a shared file,
  // so a basename check pruned every such row (RUSH-2357).
  const byDir = new Map<string, Map<string, string[]>>();
  for (const p of filePaths) {
    const container = sessionFilePathContainer(p);
    const dir = path.dirname(container);
    const base = path.basename(container);
    let bases = byDir.get(dir);
    if (!bases) {
      bases = new Map();
      byDir.set(dir, bases);
    }
    let originals = bases.get(base);
    if (!originals) {
      originals = [];
      bases.set(base, originals);
    }
    originals.push(p);
  }

  const missing = new Set<string>();
  const markMissing = (originals: string[]) => {
    for (const original of originals) missing.add(original);
  };
  for (const [dir, bases] of byDir) {
    let entries: Set<string>;
    try {
      const stat = fs.statSync(dir);
      const cached = directoryMembershipCache.get(dir);
      const now = Date.now();
      const settled = now - stat.mtimeMs > DIRECTORY_MTIME_SETTLE_MS;
      const fresh = cached && now - cached.cachedAtMs <= DIRECTORY_MTIME_SETTLE_MS;
      if (settled && fresh && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        entries = cached.entries;
      } else {
        entries = new Set(fs.readdirSync(dir));
        directoryMembershipCache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, cachedAtMs: now, entries });
        directoryMembershipSweepCount++;
      }
    } catch {
      directoryMembershipCache.delete(dir);
      // Directory itself is gone (or unreadable) — every file in it is missing.
      // Also covers the race where readdir loses to a concurrent delete: fall
      // back to a direct stat rather than assuming existence.
      for (const [base, originals] of bases) {
        const filePath = path.join(dir, base);
        if (!fs.existsSync(filePath)) markMissing(originals);
      }
      continue;
    }
    for (const [base, originals] of bases) {
      if (!entries.has(base)) markMissing(originals);
    }
  }
  return missing;
}

/** Query sessions from the database, applying filters and ordering by last-activity descending (default). */
export function querySessions(options: QueryOptions = {}): SessionMeta[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  // When a LIMIT is in play, we still need to filter stale rows AFTER the query,
  // so over-fetch a small buffer. Without this, a page of 50 rows where the first
  // 5 are stale would return only 45 to the caller even when there are more.
  const limitClause = options.limit
    ? `LIMIT ${Math.max(1, Math.floor(options.limit)) + 16}`
    : '';
  // NULLs last so unpriced/duration-less rows never crowd out real data. The default sort is the
  // bare `last_activity` column (v35 backfills every row, upserts keep it non-NULL), because
  // IFNULL() defeats idx_sessions_last_activity and forces a full sort (RUSH-2211).
  const orderClause =
    options.sortBy === 'cost'
      ? 'ORDER BY cost_usd IS NULL, cost_usd DESC, timestamp DESC'
      : options.sortBy === 'duration'
        ? 'ORDER BY duration_ms IS NULL, duration_ms DESC, timestamp DESC'
        : 'ORDER BY last_activity DESC, timestamp DESC';
  const sql = `SELECT * FROM sessions ${clause} ${orderClause} ${limitClause}`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
  if (options.skipExistenceCheck) {
    const trimmed = options.limit ? rows.slice(0, options.limit) : rows;
    return trimmed.map(rowToMeta);
  }
  // A row whose transcript is gone is ARCHIVED if user turns remain in session_text (kept, stamped
  // `archived`) or a PHANTOM (stale file_path, no content, #136), which stays suppressed
  // (RUSH-2436). Listing no longer purges tool-call evidence.
  const missingPaths = findMissingFilePaths(rows.map(r => r.file_path).filter((p): p is string => !!p));
  const missing = rows.filter(r => r.file_path && missingPaths.has(r.file_path));
  const missingIds = new Set(missing.map(r => r.id));
  const phantomIds = new Set<string>();
  if (missing.length > 0) {
    const readContent = db.prepare(`SELECT content FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`);
    const markArchived = db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL`);
    const now = Date.now();
    const classify = db.transaction(() => {
      for (const row of missing) {
        const content = (readContent.get(row.id) as { content: string } | undefined)?.content;
        if (content && content.trim() !== '') {
          // Genuine archived session: stamp archived_at the first time we confirm
          // the file is gone, and reflect it on the in-memory row we return.
          if (row.archived_at == null) {
            markArchived.run(now, row.id);
            row.archived_at = now;
          }
        } else {
          phantomIds.add(row.id);
        }
      }
    });
    classify();
  }
  // Un-archive a row whose file came back (trash restore, re-sync) so it stops reporting
  // `archived` to --json consumers. Rare, so the write fires only when such a row exists
  // (RUSH-2436).
  const resurrected = rows.filter(r => r.archived_at != null && !missingIds.has(r.id));
  if (resurrected.length > 0) {
    const clearArchived = db.prepare(`UPDATE sessions SET archived_at = NULL WHERE id = ?`);
    const clear = db.transaction(() => {
      for (const row of resurrected) {
        clearArchived.run(row.id);
        row.archived_at = null;
      }
    });
    clear();
  }
  const live = rows.filter(r => !phantomIds.has(r.id));
  const trimmed = options.limit ? live.slice(0, options.limit) : live;
  return trimmed.map(rowToMeta);
}

/** Cheap query for the daemon's deferred tool-index pass (PHNX-3411): the most recently active
 * sessions whose parseSession reads a large flat transcript (kimi, grok). The warm tick skips
 * them; ensureToolIndex uses tool_scan_ledger stamps and byte/file budget caps. */
export function querySessionsForDeferredToolIndex(limit: number): SessionMeta[] {
  const db = getDB();
  const rows = db.prepare(`
    SELECT * FROM sessions
    WHERE file_path IS NOT NULL
      AND agent IN ('kimi', 'grok')
    ORDER BY last_activity DESC, timestamp DESC
    LIMIT ?
  `).all(limit) as SessionRow[];
  return rows.map(rowToMeta);
}

/** Count sessions matching the given filter options. */
export function countSessions(options: QueryOptions = {}): number {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const sql = `SELECT COUNT(*) AS n FROM sessions ${clause}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? row.n : 0;
}

/** One grouped row in a cost/duration rollup. */
interface UsageRollupRow {
  /** Grouping key value: the agent id, project name, shortened model id, ISO date (YYYY-MM-DD), or
   * account identity (`claude:org=<uuid>` / `unattributed:<reason>`). */
  key: string;
  /** Human label for the key when it is not itself readable (an org uuid is an identity, not
   * display text). Absent when `key` reads fine. */
  label?: string;
  costUsd: number;
  /** USD cost priced as if caching were off (cache read/write at the input rate), summed from
   * `cost_usd_nocache`; backs `agents insights output --pricing no-cache`. Equals `costUsd` for
   * rows with no cache split (RUSH-2287). */
  costUsdNoCache: number;
  durationMs: number;
  sessionCount: number;
  tokenCount: number;
  /** Real generated (output) tokens — excludes cache-read/-write context. */
  outputTokens: number;
  /** Uncached input tokens summed across the group (0 where no harness recorded a split). */
  inputTokens: number;
  /** Cache-read tokens summed across the group. */
  cacheReadTokens: number;
  /** Cache-write (cache-creation) tokens summed across the group. */
  cacheWriteTokens: number;
}

/** What to group a usage rollup by. */
/** Read cached facets for the given sessions, dropping stale rows. Staleness is decided in SQL
 * against the session's own `file_mtime_ms`/`file_size`; `IS` rather than `=` makes a source with
 * no statable file (NULL both sides) a cache hit, not a permanent miss. */
export function readSessionInsights<T>(ids: string[]): Map<string, T> {
  const db = getDB();
  const out = new Map<string, T>();
  if (ids.length === 0) return out;
  const CHUNK = 400; // chunk.length + 1 binds, well under SQLite's 999-variable limit
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const phs = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT si.session_id AS id, si.facets AS facets
      FROM session_insights si
      JOIN sessions s ON s.id = si.session_id
      WHERE si.session_id IN (${phs})
        AND si.extractor_version = ?
        AND si.file_mtime_ms IS s.file_mtime_ms
        AND si.file_size IS s.file_size
    `).all(...chunk, INSIGHTS_EXTRACTOR_VERSION) as Array<{ id: string; facets: string }>;
    for (const row of rows) {
      try {
        out.set(row.id, JSON.parse(row.facets) as T);
      } catch {
        // A corrupt cache row is not a reason to fail the report; recompute it.
      }
    }
  }
  return out;
}

/** Persist facets against the stamp of the bytes actually parsed. Re-reading the stamp inside the
 * INSERT would race a concurrent rescan (batches flush over minutes) and stamp NEW bytes onto OLD
 * facets, a permanent false hit. The caller passes its observed stat, as tool-index.ts does. */
export function writeSessionInsights<T>(
  entries: Array<{ id: string; fileMtimeMs: number | null; fileSize: number | null; facets: T }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO session_insights
      (session_id, file_mtime_ms, file_size, extractor_version, computed_at, facets)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      computed_at = excluded.computed_at,
      facets = excluded.facets
  `);
  const now = Date.now();
  db.transaction(() => {
    for (const e of entries) {
      stmt.run(e.id, e.fileMtimeMs, e.fileSize, INSIGHTS_EXTRACTOR_VERSION, now, JSON.stringify(e.facets));
    }
  })();
}

/** Drop every cached facet row. Backs `agents insights --refresh`. */
export function clearSessionInsights(): void {
  getDB().exec(`DELETE FROM session_insights`);
}

/** Read cached trace topics only when their transcript byte stamps still match. */
export function readSessionTopics<T>(ids: string[]): Map<string, T> {
  const db = getDB();
  const out = new Map<string, T>();
  if (ids.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT st.session_id AS id, st.topic_json AS topicJson
      FROM session_topics st
      JOIN sessions s ON s.id = st.session_id
      WHERE st.session_id IN (${placeholders})
        AND st.extractor_version = ?
        AND st.file_mtime_ms IS s.file_mtime_ms
        AND st.file_size IS s.file_size
    `).all(...chunk, SESSION_TOPIC_EXTRACTOR_VERSION) as Array<{ id: string; topicJson: string }>;
    for (const row of rows) {
      try {
        out.set(row.id, JSON.parse(row.topicJson) as T);
      } catch {
        // Invalid derived cache data is a miss and self-heals on the next write.
      }
    }
  }
  return out;
}

/** Persist trace topics against the exact transcript bytes used to classify them. */
export function writeSessionTopics<T>(
  entries: Array<{ id: string; fileMtimeMs: number | null; fileSize: number | null; topic: T }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO session_topics
      (session_id, file_mtime_ms, file_size, extractor_version, computed_at, topic_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      computed_at = excluded.computed_at,
      topic_json = excluded.topic_json
  `);
  const now = Date.now();
  db.transaction(() => {
    for (const entry of entries) {
      stmt.run(
        entry.id,
        entry.fileMtimeMs,
        entry.fileSize,
        SESSION_TOPIC_EXTRACTOR_VERSION,
        now,
        JSON.stringify(entry.topic),
      );
    }
  })();
}

/** Read cached failure phenotypes only when their transcript byte stamps still match. */
export function readSessionPhenotypes<T>(ids: string[]): Map<string, T> {
  const db = getDB();
  const out = new Map<string, T>();
  if (ids.length === 0) return out;
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT sp.session_id AS id, sp.phenotype_json AS phenotypeJson
      FROM session_phenotypes sp
      JOIN sessions s ON s.id = sp.session_id
      WHERE sp.session_id IN (${placeholders})
        AND sp.extractor_version = ?
        AND sp.file_mtime_ms IS s.file_mtime_ms
        AND sp.file_size IS s.file_size
    `).all(...chunk, SESSION_PHENOTYPE_EXTRACTOR_VERSION) as Array<{ id: string; phenotypeJson: string }>;
    for (const row of rows) {
      try {
        out.set(row.id, JSON.parse(row.phenotypeJson) as T);
      } catch {
        // Invalid derived cache data is a miss and self-heals on the next write.
      }
    }
  }
  return out;
}

/** Persist failure phenotypes against the exact transcript bytes used to classify them. */
export function writeSessionPhenotypes<T>(
  entries: Array<{ id: string; fileMtimeMs: number | null; fileSize: number | null; phenotype: T }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO session_phenotypes
      (session_id, file_mtime_ms, file_size, extractor_version, computed_at, phenotype_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      computed_at = excluded.computed_at,
      phenotype_json = excluded.phenotype_json
  `);
  const now = Date.now();
  db.transaction(() => {
    for (const entry of entries) {
      stmt.run(
        entry.id,
        entry.fileMtimeMs,
        entry.fileSize,
        SESSION_PHENOTYPE_EXTRACTOR_VERSION,
        now,
        JSON.stringify(entry.phenotype),
      );
    }
  })();
}

/** Read one derived preview only when it matches the transcript bytes on disk. */
export function readSessionPreviewCache<T>(
  id: string,
  sourceStamp: { fileMtimeMs: number | null; fileSize: number | null },
): T | undefined {
  const row = getDB().prepare(`
    SELECT pc.preview_json AS previewJson
    FROM session_preview_cache pc
    WHERE pc.session_id = ?
      AND pc.extractor_version = ?
      AND pc.file_mtime_ms IS ?
      AND pc.file_size IS ?
  `).get(
    id,
    PREVIEW_EXTRACTOR_VERSION,
    sourceStamp.fileMtimeMs,
    sourceStamp.fileSize,
  ) as { previewJson: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.previewJson) as T;
  } catch {
    return undefined;
  }
}

/** Persist normalized preview data against the exact transcript bytes parsed. */
export function writeSessionPreviewCache<T>(entry: {
  id: string;
  fileMtimeMs: number | null;
  fileSize: number | null;
  preview: T;
}): void {
  getDB().prepare(`
    INSERT INTO session_preview_cache
      (session_id, file_mtime_ms, file_size, extractor_version, computed_at, preview_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      computed_at = excluded.computed_at,
      preview_json = excluded.preview_json
  `).run(
    entry.id,
    entry.fileMtimeMs,
    entry.fileSize,
    PREVIEW_EXTRACTOR_VERSION,
    Date.now(),
    JSON.stringify(entry.preview),
  );
}

/** Bump when the cached remote preview envelope shape changes so cached rows recompute (PHNX-3999 v1). */
export const REMOTE_PREVIEW_SCHEMA_VERSION = 1;

/** Cap on distinct (device, sessionId) rows in this cache, bounding growth as the fleet session
 * mirror's 200-row cap does (PHNX-3792); oldest-by-last-fetch is evicted first. A row count alone
 * is not a bound on bytes, so it is paired with a total-byte budget below. */
const REMOTE_PREVIEW_CACHE_MAX_ROWS = 500;

/** Total on-disk budget for `envelope_json` across all cached rows, enforced alongside the row cap
 * (whichever evicts more wins). About 32 KiB/row at 500 rows; a single row above {@link
 * REMOTE_PREVIEW_ENVELOPE_MAX_BYTES} is refused rather than consuming the budget. */
const REMOTE_PREVIEW_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Per-envelope cache-write cap, to refuse an outlier (a version-skewed peer, a field that forgot
 * to bound itself) rather than let one session blow the budget. A refused write is not an error:
 * the caller still has the live envelope, it just is not persisted. */
export const REMOTE_PREVIEW_ENVELOPE_MAX_BYTES = 512 * 1024;

export interface RemotePreviewCacheRow {
  /** When the envelope currently stored here (if `ok`) was fetched. */
  fetchedAt: number;
  /** Whether `envelope` is a real, successfully-fetched payload. */
  ok: boolean;
  envelope?: unknown;
  failureReason?: string;
  consecutiveFailures: number;
  /** Epoch ms before which a fresh fetch attempt should be skipped (negative backoff). */
  nextAttemptAt: number;
  /** The caller's own last-observed `--revision` cursor, or undefined if no
   * caller has ever supplied one for this (device, sessionId) pair. */
  lastCallerRevision?: string;
}

/** Read the durable cached remote preview row for one (device, sessionId) pair,
 * regardless of whether it currently holds a successful envelope. Undefined
 * means this box has never attempted (or recorded) a fetch for that pair. */
export function readRemotePreviewCache(device: string, sessionId: string): RemotePreviewCacheRow | undefined {
  const row = getDB().prepare(`
    SELECT fetched_at AS fetchedAt, ok, envelope_json AS envelopeJson, failure_reason AS failureReason,
           consecutive_failures AS consecutiveFailures, next_attempt_at AS nextAttemptAt,
           last_caller_revision AS lastCallerRevision
    FROM session_remote_preview_cache
    WHERE device = ? AND session_id = ? AND schema_version = ?
  `).get(device, sessionId, REMOTE_PREVIEW_SCHEMA_VERSION) as {
    fetchedAt: number;
    ok: number;
    envelopeJson: string | null;
    failureReason: string | null;
    consecutiveFailures: number;
    nextAttemptAt: number;
    lastCallerRevision: string | null;
  } | undefined;
  if (!row) return undefined;
  let envelope: unknown;
  if (row.envelopeJson) {
    try {
      envelope = JSON.parse(row.envelopeJson);
    } catch {
      // Corrupt cache row: treat as no payload rather than throwing.
    }
  }
  return {
    fetchedAt: row.fetchedAt,
    ok: row.ok === 1 && envelope !== undefined,
    envelope,
    failureReason: row.failureReason ?? undefined,
    consecutiveFailures: row.consecutiveFailures,
    nextAttemptAt: row.nextAttemptAt,
    lastCallerRevision: row.lastCallerRevision ?? undefined,
  };
}

/** Record the caller's own `--revision` cursor for one (device, sessionId) pair, independent of any
 * fetch; a no-op if no row exists. "Same revision as last time" then serves the cache with zero
 * SSH, compared against this value, never the envelope's own `details.sourceRevision`. */
export function writeRemotePreviewCallerRevision(device: string, sessionId: string, revision: string): void {
  getDB().prepare(`
    UPDATE session_remote_preview_cache
    SET last_caller_revision = ?
    WHERE device = ? AND session_id = ? AND schema_version = ?
  `).run(revision, device, sessionId, REMOTE_PREVIEW_SCHEMA_VERSION);
}

function pruneRemotePreviewCache(maxRows: number = REMOTE_PREVIEW_CACHE_MAX_ROWS): void {
  const db = getDB();
  db.prepare(`
    DELETE FROM session_remote_preview_cache
    WHERE rowid NOT IN (
      SELECT rowid FROM session_remote_preview_cache ORDER BY fetched_at DESC LIMIT ?
    )
  `).run(maxRows);
  // Total-byte budget, independent of row count: walk newest-first, keep
  // rows until the running total would exceed the budget, drop the rest.
  const rows = db.prepare(`
    SELECT rowid AS rowid,
           envelope_bytes + length(CAST(COALESCE(failure_reason, '') AS BLOB))
             + length(CAST(COALESCE(last_caller_revision, '') AS BLOB)) AS envelopeBytes
    FROM session_remote_preview_cache
    ORDER BY fetched_at DESC
  `).all() as Array<{ rowid: number; envelopeBytes: number }>;
  let total = 0;
  const evict: number[] = [];
  for (const row of rows) {
    total += row.envelopeBytes;
    if (total > REMOTE_PREVIEW_CACHE_MAX_TOTAL_BYTES) evict.push(row.rowid);
  }
  if (evict.length > 0) {
    const placeholders = evict.map(() => '?').join(',');
    db.prepare(`DELETE FROM session_remote_preview_cache WHERE rowid IN (${placeholders})`).run(...evict);
  }
}

/** Record a successful remote fetch: replaces the payload and resets backoff. An envelope over
 * {@link REMOTE_PREVIEW_ENVELOPE_MAX_BYTES} is refused as a write-path bound; the caller already
 * has the live envelope. */
export function writeRemotePreviewCacheSuccess(
  device: string,
  sessionId: string,
  envelope: unknown,
  fetchedAt: number = Date.now(),
  revision?: string,
): void {
  const envelopeJson = JSON.stringify(envelope);
  const envelopeBytes = Buffer.byteLength(envelopeJson, 'utf8');
  if (envelopeBytes > REMOTE_PREVIEW_ENVELOPE_MAX_BYTES) return;
  const db = getDB();
  const write = db.transaction(() => {
    db.prepare(`
      INSERT INTO session_remote_preview_cache
        (device, session_id, schema_version, fetched_at, ok, envelope_json, envelope_bytes, failure_reason, consecutive_failures, next_attempt_at, last_caller_revision)
      VALUES (?, ?, ?, ?, 1, ?, ?, NULL, 0, 0, ?)
      ON CONFLICT(device, session_id, schema_version) DO UPDATE SET
        fetched_at = excluded.fetched_at,
        ok = 1,
        envelope_json = excluded.envelope_json,
        envelope_bytes = excluded.envelope_bytes,
        failure_reason = NULL,
        consecutive_failures = 0,
        next_attempt_at = 0,
        last_caller_revision = excluded.last_caller_revision
    `).run(device, sessionId, REMOTE_PREVIEW_SCHEMA_VERSION, fetchedAt, envelopeJson, envelopeBytes, revision ?? null);
    pruneRemotePreviewCache();
  });
  write();
}

/** Cap on a stored `failure_reason`: some reasons interpolate peer-controlled content
 * (`validateEnvelope`'s mismatched-id message embeds the peer's claimed session id), so a
 * malicious peer cannot inflate a row's text. */
const REMOTE_PREVIEW_FAILURE_REASON_MAX_CHARS = 300;

function boundFailureReason(reason: string): string {
  return reason.length > REMOTE_PREVIEW_FAILURE_REASON_MAX_CHARS
    ? reason.slice(0, REMOTE_PREVIEW_FAILURE_REASON_MAX_CHARS) + '…'
    : reason;
}

/** Record a failed remote fetch with exponential backoff WITHOUT discarding a prior good envelope:
 * a session that answered once and is now offline still degrades to its last-good payload (read
 * via {@link readRemotePreviewCache}), annotated stale by the caller. */
export function writeRemotePreviewCacheFailure(
  device: string,
  sessionId: string,
  reason: string,
  backoffMs: (consecutiveFailures: number) => number,
  now: number = Date.now(),
): void {
  const boundedReason = boundFailureReason(reason);
  const db = getDB();
  const write = db.transaction(() => {
    const existing = readRemotePreviewCache(device, sessionId);
    const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
    const nextAttemptAt = now + backoffMs(consecutiveFailures);
    const keepOk = existing?.ok ? 1 : 0;
    const envelopeJson = existing?.ok ? JSON.stringify(existing.envelope) : null;
    const envelopeBytes = envelopeJson ? Buffer.byteLength(envelopeJson, 'utf8') : 0;
    db.prepare(`
      INSERT INTO session_remote_preview_cache
        (device, session_id, schema_version, fetched_at, ok, envelope_json, envelope_bytes, failure_reason, consecutive_failures, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device, session_id, schema_version) DO UPDATE SET
        ok = excluded.ok,
        envelope_json = excluded.envelope_json,
        envelope_bytes = excluded.envelope_bytes,
        failure_reason = excluded.failure_reason,
        consecutive_failures = excluded.consecutive_failures,
        next_attempt_at = excluded.next_attempt_at
    `).run(
      device,
      sessionId,
      REMOTE_PREVIEW_SCHEMA_VERSION,
      existing?.fetchedAt ?? now,
      keepOk,
      envelopeJson,
      envelopeBytes,
      boundedReason,
      consecutiveFailures,
      nextAttemptAt,
    );
    // A failure-only row still occupies a slot in the row/byte-bounded cache, so prune on it too,
    // or a persistently-offline peer's failure rows accumulate without bound (they were previously
    // exempt).
    pruneRemotePreviewCache();
  });
  write();
}

/** The durable user-turn text from the `session_text` `content` column, which survives transcript
 * deletion (RUSH-2436): file-gone sessions render from it, and querySessions uses it to tell
 * archived from phantom. Undefined if no row; empty string if the row has no content. */
export function readSessionContent(id: string): string | undefined {
  const row = getDB().prepare(
    `SELECT content FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`,
  ).get(id) as { content: string } | undefined;
  return row?.content;
}

/** Read the last-computed preview digest by id, validated against the session row's own stored file
 * stamp, not a live `fs.stat` (the file is gone; the cache used the same mtime/size the row still
 * records). Backs the file-gone preview path (RUSH-2436). Undefined if no digest survives. */
export function readArchivedSessionPreview<T>(id: string): T | undefined {
  const row = getDB().prepare(`
    SELECT pc.preview_json AS previewJson
    FROM session_preview_cache pc
    JOIN sessions s ON s.id = pc.session_id
    WHERE pc.session_id = ?
      AND pc.extractor_version = ?
      AND pc.file_mtime_ms IS s.file_mtime_ms
      AND pc.file_size IS s.file_size
  `).get(id, PREVIEW_EXTRACTOR_VERSION) as { previewJson: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.previewJson) as T;
  } catch {
    return undefined;
  }
}

/** The daemon-computed summary stored in `session_summaries` (PHNX-3939). */
export interface SessionSummaryEntry {
  goal?: string;
  checkpoints?: SessionCheckpoint[];
  summaryChecklist?: SessionChecklistItem[];
  summaryState: SummaryState;
}

/** Read one summary only when it matches the transcript bytes on disk (the stamp the
 * SessionSummarizerService gates recompute on). Mirrors {@link readSessionPreviewCache}. */
export function readSessionSummary(
  id: string,
  sourceStamp: { fileMtimeMs: number | null; fileSize: number | null },
): SessionSummaryEntry | undefined {
  const row = getDB().prepare(`
    SELECT summary_json AS summaryJson
    FROM session_summaries
    WHERE session_id = ?
      AND extractor_version = ?
      AND file_mtime_ms IS ?
      AND file_size IS ?
  `).get(
    id,
    SESSION_SUMMARY_EXTRACTOR_VERSION,
    sourceStamp.fileMtimeMs,
    sourceStamp.fileSize,
  ) as { summaryJson: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.summaryJson) as SessionSummaryEntry;
  } catch {
    return undefined;
  }
}

/** Read the latest stored summary by session id regardless of transcript stamp: the cheap
 * display-path merge read ({@link applyImmutableMemo}, history/mirror rows) with no model call.
 * The service itself uses the stamped {@link readSessionSummary} to decide recompute. */
export function readSessionSummaryAny(id: string): SessionSummaryEntry | undefined {
  const row = getDB().prepare(`
    SELECT summary_json AS summaryJson
    FROM session_summaries
    WHERE session_id = ? AND extractor_version = ?
  `).get(id, SESSION_SUMMARY_EXTRACTOR_VERSION) as { summaryJson: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.summaryJson) as SessionSummaryEntry;
  } catch {
    return undefined;
  }
}

/** Persist a computed summary against the exact transcript bytes it was derived from. */
export function writeSessionSummary(entry: {
  id: string;
  fileMtimeMs: number | null;
  fileSize: number | null;
  summary: SessionSummaryEntry;
}): void {
  getDB().prepare(`
    INSERT INTO session_summaries
      (session_id, file_mtime_ms, file_size, extractor_version, computed_at, summary_json)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      computed_at = excluded.computed_at,
      summary_json = excluded.summary_json
  `).run(
    entry.id,
    entry.fileMtimeMs,
    entry.fileSize,
    SESSION_SUMMARY_EXTRACTOR_VERSION,
    Date.now(),
    JSON.stringify(entry.summary),
  );
}

/** The daemon-computed timeline stored in `session_timelines` (PHNX-3939): the bounded projection a
 * row merges, plus the request and files derived in the same fold. */
export interface SessionTimelineProjection {
  timeline: SessionTimeline;
  request?: SessionRequest;
  files?: SessionFiles;
}

/** One folded timeline, as the pass produces it for writing. */
export interface SessionTimelineEntry extends SessionTimelineProjection {
  state: TimelineState;
}

/** One cached row as READ back: the folded entry plus when it was folded. */
export interface SessionTimelineCacheRow extends SessionTimelineEntry {
  /** Epoch ms this row was folded — the pass's re-parse rate limit reads it. */
  computedAt: number;
}

function parseTimelineProjection(json: string): SessionTimelineProjection | undefined {
  try {
    return JSON.parse(json) as SessionTimelineProjection;
  } catch {
    return undefined;
  }
}

/** Read the projection and the resume state for one session regardless of transcript stamp: the
 * daemon pass's read, which needs the state to continue from and re-stats the file itself. */
export function readSessionTimelineEntry(id: string): SessionTimelineCacheRow | undefined {
  const row = getDB().prepare(`
    SELECT projection_json AS projectionJson, state_json AS stateJson, computed_at AS computedAt
    FROM session_timelines
    WHERE session_id = ? AND extractor_version = ?
  `).get(id, TIMELINE_EXTRACTOR_VERSION) as
    { projectionJson: string; stateJson: string; computedAt: number } | undefined;
  if (!row) return undefined;
  const projection = parseTimelineProjection(row.projectionJson);
  if (!projection) return undefined;
  try {
    return { ...projection, state: JSON.parse(row.stateJson) as TimelineState, computedAt: row.computedAt };
  } catch {
    return undefined;
  }
}

/** Read only the bounded projection for one session (the display merge on the read path).
 * Deliberately skips the resume state: a live row needs the 8 steps and the request, not the
 * fold's bookkeeping. */
export function readSessionTimelineAny(
  id: string,
  stamp?: { fileMtimeMs: number; fileSize: number },
): SessionTimelineProjection | undefined {
  const row = getDB().prepare(`
    SELECT projection_json AS projectionJson
    FROM session_timelines
    WHERE session_id = ? AND extractor_version = ?
      AND (? IS NULL OR (file_mtime_ms = ? AND file_size = ?))
  `).get(id, TIMELINE_EXTRACTOR_VERSION, stamp?.fileMtimeMs ?? null,
    stamp?.fileMtimeMs ?? null, stamp?.fileSize ?? null) as { projectionJson: string } | undefined;
  if (!row) return undefined;
  return parseTimelineProjection(row.projectionJson);
}

/** Persist a folded timeline against the exact transcript bytes it was folded to. */
export function writeSessionTimeline(entry: {
  id: string;
  fileMtimeMs: number | null;
  fileSize: number | null;
  timeline: SessionTimelineEntry;
  /** Fold time. Injected by the pass so its re-parse interval is testable without the wall clock. */
  computedAtMs?: number;
}): void {
  const { state, ...projection } = entry.timeline;
  getDB().prepare(`
    INSERT INTO session_timelines
      (session_id, file_mtime_ms, file_size, extractor_version, computed_at, projection_json, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      computed_at = excluded.computed_at,
      projection_json = excluded.projection_json,
      state_json = excluded.state_json
  `).run(
    entry.id,
    entry.fileMtimeMs,
    entry.fileSize,
    TIMELINE_EXTRACTOR_VERSION,
    entry.computedAtMs ?? Date.now(),
    JSON.stringify(projection),
    JSON.stringify(state),
  );
}

/** A local-origin session, projected to the compact fields the fleet mirror publishes. */
export interface LocalMirrorSource {
  id: string;
  shortId: string;
  agent: string;
  version: string | null;
  machine: string | null;
  cwd: string | null;
  topic: string | null;
  firstUserMessage: string | null;
  label: string | null;
  /** The daemon-generated headline (PHNX-3797), so a peer row shows the same title. */
  generatedTitle: string | null;
  lastActivity: string | null;
  timestamp: string;
  ticketId: string | null;
  prUrl: string | null;
  /** Daemon-computed summary (PHNX-3939), so peers carry it without a transcript. */
  summary: SessionSummaryEntry | null;
  /** Daemon-folded request/timeline/files (PHNX-3939), same reason as {@link summary}. */
  timeline: SessionTimelineProjection | null;
}

/** The most recently active sessions whose transcript is local to this box (a real `file_path`, not
 * a peer mirror), for the fleet session mirror (PHNX-3792). Bounded and team-origin-excluded;
 * never a row this box mirrors from a peer (`mirror_synced_at IS NULL`). */
export function queryLocalOriginSessionsForMirror(self: string, limit: number): LocalMirrorSource[] {
  const rows = getDB().prepare(`
    SELECT id, short_id, agent, version, machine, cwd, topic, first_user_message,
           label, generated_title, last_activity, timestamp, ticket_id, pr_url
    FROM sessions
    WHERE mirror_synced_at IS NULL
      AND file_path IS NOT NULL AND file_path <> ''
      AND machine = ?
      AND is_team_origin = 0
      AND (topic IS NOT NULL OR first_user_message IS NOT NULL OR label IS NOT NULL)
    ORDER BY last_activity DESC, timestamp DESC
    LIMIT ?
  `).all(self, limit) as Array<{
    id: string; short_id: string; agent: string; version: string | null; machine: string | null;
    cwd: string | null; topic: string | null; first_user_message: string | null; label: string | null;
    generated_title: string | null;
    last_activity: string | null; timestamp: string; ticket_id: string | null; pr_url: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id, shortId: r.short_id, agent: r.agent, version: r.version, machine: r.machine,
    cwd: r.cwd, topic: r.topic, firstUserMessage: r.first_user_message, label: r.label,
    generatedTitle: r.generated_title,
    lastActivity: r.last_activity, timestamp: r.timestamp, ticketId: r.ticket_id, prUrl: r.pr_url,
    // Ride the daemon-computed summary alongside the digest so a peer renders it
    // without a transcript (PHNX-3939); only a summarized session carries one.
    summary: readSessionSummaryAny(r.id) ?? null,
    timeline: readSessionTimelineAny(r.id) ?? null,
  }));
}

/** One peer session digest to write into this box's local mirror. */
export interface MirrorSessionUpsert {
  id: string;
  shortId: string;
  agent: string;
  version?: string | null;
  machine: string;
  cwd?: string | null;
  topic?: string | null;
  firstUser?: string | null;
  label?: string | null;
  /** The publisher's daemon-generated headline (PHNX-3797); undefined when it has none yet. */
  generatedTitle?: string | null;
  lastActivity?: string | null;
  timestamp: string;
  ticketId?: string | null;
  prUrl?: string | null;
  /** Daemon-computed summary carried from the publishing peer (PHNX-3939). */
  summary?: SessionSummaryEntry | null;
  /** Daemon-folded request/timeline/files carried from the publishing peer (PHNX-3939). */
  timeline?: SessionTimelineProjection | null;
}

/** Write a peer session's digest into the local `sessions` index as a mirror row (PHNX-3792) so
 * pickers render it with no per-row SSH. GUARDED: never overwrites a genuine local transcript row.
 * True when written. */
export function upsertMirrorSession(row: MirrorSessionUpsert, source: string, syncedAt: number): boolean {
  const db = getDB();
  const lastActivity = row.lastActivity ?? row.timestamp;
  const result = db.prepare(`
    INSERT INTO sessions (
      id, short_id, agent, origin, version, timestamp, last_activity, cwd,
      topic, first_user_message, label, generated_title, message_count, file_path, scanned_at,
      is_team_origin, ticket_id, pr_url, machine, mirror_synced_at, mirror_source
    ) VALUES (
      @id, @short_id, @agent, 'cli', @version, @timestamp, @last_activity, @cwd,
      @topic, @first_user, @label, @generated_title, NULL, '', @scanned_at,
      0, @ticket_id, @pr_url, @machine, @synced_at, @source
    )
    ON CONFLICT(id) DO UPDATE SET
      short_id = excluded.short_id,
      agent = excluded.agent,
      version = COALESCE(excluded.version, sessions.version),
      timestamp = excluded.timestamp,
      last_activity = excluded.last_activity,
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      topic = COALESCE(excluded.topic, sessions.topic),
      first_user_message = COALESCE(excluded.first_user_message, sessions.first_user_message),
      -- The peer is authoritative for the session's real name, so OVERWRITE (not
      -- COALESCE) the label: a host-dispatch stub carries the [host/peer]
      -- placeholder, and coalescing would keep it forever — the exact bare-row
      -- symptom this feature fixes. A null peer label clears it so the list falls
      -- back to the synced topic.
      label = excluded.label,
      -- Same rule for the generated headline (PHNX-3797): the publishing box owns
      -- its sessions' titles, and this box's titler never generates for a mirror
      -- row, so the peer's value wins outright and a peer that has not titled the
      -- session yet clears it (the ladder then falls back to the synced first
      -- user message, never to an agent line).
      generated_title = excluded.generated_title,
      ticket_id = COALESCE(excluded.ticket_id, sessions.ticket_id),
      pr_url = COALESCE(excluded.pr_url, sessions.pr_url),
      machine = excluded.machine,
      mirror_synced_at = excluded.mirror_synced_at,
      mirror_source = excluded.mirror_source
    WHERE sessions.file_path IS NULL OR sessions.file_path = '' OR sessions.mirror_synced_at IS NOT NULL
  `).run({
    id: row.id,
    short_id: row.shortId,
    agent: row.agent,
    version: row.version ?? null,
    timestamp: row.timestamp,
    last_activity: lastActivity,
    cwd: row.cwd ?? null,
    topic: row.topic ?? null,
    first_user: row.firstUser ?? null,
    label: row.label ?? null,
    generated_title: row.generatedTitle ?? null,
    ticket_id: row.ticketId ?? null,
    pr_url: row.prUrl ?? null,
    machine: row.machine,
    scanned_at: syncedAt,
    synced_at: syncedAt,
    source,
  });
  if (result.changes === 0) return false;
  // Keep the mirror row searchable by topic + first user turn, like a local row.
  db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`).run(row.id);
  db.prepare(`
    INSERT INTO session_text (rowid, session_id, label, topic, project, content, assistant)
    VALUES (${SESSION_TEXT_ROWID}, ?, ?, ?, '', ?, '')
  `).run(row.id, row.id, row.label ?? '', row.topic ?? '', row.firstUser ?? '');
  // Carry the peer's daemon-computed summary into the session_summaries cache the local merge
  // reads (PHNX-3939), so a peer session renders inline with no transcript. Stamp is null: display
  // reads by id, and this box's summarizer only recomputes local live sessions.
  if (row.summary) {
    writeSessionSummary({ id: row.id, fileMtimeMs: null, fileSize: null, summary: row.summary });
  }
  // Same for the peer's folded timeline (PHNX-3939): the projection is what a row renders; the
  // resume state is deliberately EMPTY, since a foreign byte offset would point into a file that
  // is not here.
  if (row.timeline) {
    writeSessionTimeline({
      id: row.id,
      fileMtimeMs: null,
      fileSize: null,
      timeline: { ...row.timeline, state: emptyTimelineState() },
    });
  }
  return true;
}

/** One indexed session the daemon titler may generate a headline for (PHNX-3797). */
export interface SessionTitleCandidateRow {
  id: string;
  agent: string;
  cwd: string | null;
  project: string | null;
  topic: string | null;
  firstUserMessage: string | null;
  label: string | null;
  ticketId: string | null;
  gitBranch: string | null;
  generatedTitle: string | null;
  generatedTitleKey: string | null;
}

/** The most recently active LOCAL sessions the titler may consider (PHNX-3797). The caller compares
 * each row's `generatedTitleKey` to its user text, so a changed first message re-titles. Excluded:
 * peer mirror rows, rows with no user text, rows with a `/rename`-style `label`. */
export function querySessionTitleCandidates(
  limit: number,
  opts: { sinceMs?: number; id?: string } = {},
): SessionTitleCandidateRow[] {
  const clauses = [
    `mirror_synced_at IS NULL`,
    `(first_user_message IS NOT NULL OR topic IS NOT NULL)`,
  ];
  const params: unknown[] = [];
  if (opts.id) {
    clauses.push(`(id = ? OR short_id = ?)`);
    params.push(opts.id, opts.id);
  } else {
    // An explicitly requested session is titled even when it carries a label or
    // is older than the window; the periodic sweep honours both bounds.
    clauses.push(`(label IS NULL OR trim(label) = '')`);
    if (opts.sinceMs != null) {
      clauses.push(`COALESCE(last_activity, timestamp) >= ?`);
      params.push(new Date(opts.sinceMs).toISOString());
    }
  }
  const rows = getDB().prepare(`
    SELECT id, agent, cwd, project, topic, first_user_message, label, ticket_id,
           git_branch, generated_title, generated_title_key
    FROM sessions
    WHERE ${clauses.join(' AND ')}
    ORDER BY COALESCE(last_activity, timestamp) DESC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: string; agent: string; cwd: string | null; project: string | null;
    topic: string | null; first_user_message: string | null; label: string | null;
    ticket_id: string | null; git_branch: string | null;
    generated_title: string | null; generated_title_key: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    cwd: r.cwd,
    project: r.project,
    topic: r.topic,
    firstUserMessage: r.first_user_message,
    label: r.label,
    ticketId: r.ticket_id,
    gitBranch: r.git_branch,
    generatedTitle: r.generated_title,
    generatedTitleKey: r.generated_title_key,
  }));
}

/** Persist one generated title against the source key it came from (PHNX-3797). `sourceKey` makes
 * generation once-per-session: the next sweep skips a row whose stored key matches its current
 * user text. Never touches a mirror row; the publishing box owns those titles. */
export function setSessionGeneratedTitle(
  id: string,
  title: string,
  sourceKey: string,
  now: number = Date.now(),
): boolean {
  const result = getDB().prepare(`
    UPDATE sessions
    SET generated_title = ?, generated_title_key = ?, generated_title_at = ?
    WHERE id = ? AND mirror_synced_at IS NULL
  `).run(title, sourceKey, now, id);
  return result.changes > 0;
}

/** Drop peer mirror rows (and cached digests) whose last sync predates the cutoff: the
 * staleness/size pruner for the fleet session mirror (PHNX-3792). Touches only mirror rows
 * (`mirror_synced_at IS NOT NULL`), never local or host-dispatch rows. Returns rows pruned. */
export function pruneMirrorSessions(cutoffMs: number): number {
  const db = getDB();
  const stale = db.prepare(
    `SELECT id FROM sessions WHERE mirror_synced_at IS NOT NULL AND mirror_synced_at < ?`,
  ).all(cutoffMs) as Array<{ id: string }>;
  if (stale.length === 0) return 0;
  const delRow = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  const delText = db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`);
  const delPreview = db.prepare(`DELETE FROM session_preview_cache WHERE session_id = ?`);
  const delSummary = db.prepare(`DELETE FROM session_summaries WHERE session_id = ?`);
  const delTimeline = db.prepare(`DELETE FROM session_timelines WHERE session_id = ?`);
  const txn = db.transaction(() => {
    for (const { id } of stale) {
      // Text first: its rowid lookup needs the sessions row still present.
      delText.run(id);
      delRow.run(id);
      delPreview.run(id);
      delSummary.run(id);
      delTimeline.run(id);
    }
  });
  txn();
  return stale.length;
}

/** Plugin provenance already indexed for resources used by one session. */
export function getSessionPlugins(id: string): string[] {
  const rows = getDB().prepare(`
    SELECT DISTINCT plugin
    FROM session_resource_usage
    WHERE session_id = ? AND plugin IS NOT NULL AND plugin <> ''
    ORDER BY plugin COLLATE NOCASE
  `).all(id) as Array<{ plugin: string }>;
  return rows.map(row => row.plugin);
}

export type UsageRollupGroup = 'agent' | 'project' | 'day' | 'model' | 'account';

/** Smart-launch affinity priors: group cli-origin, non-team sessions by origin machine, harness, or
 * both, by launch count desc. Account rotation is not done here; it stays on live rate-limit
 * windows (`--strategy balanced`, rotate.ts). */
type AffinityGroup = 'machine' | 'agent' | 'machine_agent';

export interface AffinityRow {
  /** Group key: machine name, agent id, or "machine\\tagent". */
  key: string;
  machine?: string;
  agent?: string;
  launches: number;
  durationMs: number;
  tokenCount: number;
  costUsd: number;
}

export function queryAffinityRollup(options: {
  groupBy: AffinityGroup;
  /** ISO cutoff or ms; defaults to 14 days ago when omitted. */
  sinceMs?: number;
  /** Restrict to these harnesses (e.g. claude/codex/kimi). */
  agents?: SessionAgentId[];
  /** Default true: only origin=cli rows. */
  onlyCli?: boolean;
  /** Default true: drop team-spawned sessions. */
  excludeTeamOrigin?: boolean;
  project?: string;
}): AffinityRow[] {
  const db = getDB();
  const where: string[] = [];
  const params: unknown[] = [];

  const sinceMs = options.sinceMs ?? (Date.now() - 14 * 24 * 60 * 60 * 1000);
  // ISO timestamps sort lexicographically; compare as string prefix of datetime.
  where.push(`timestamp >= ?`);
  params.push(new Date(sinceMs).toISOString());

  if (options.onlyCli !== false) {
    where.push(`IFNULL(origin, 'cli') = 'cli'`);
  }
  if (options.excludeTeamOrigin !== false) {
    where.push(`IFNULL(is_team_origin, 0) = 0`);
  }
  if (options.agents && options.agents.length > 0) {
    where.push(`agent IN (${options.agents.map(() => '?').join(',')})`);
    params.push(...options.agents);
  }
  if (options.project) {
    where.push(`LOWER(IFNULL(project, '')) LIKE ?`);
    params.push(`%${options.project.toLowerCase()}%`);
  }

  let keyExpr: string;
  let selectExtra: string;
  if (options.groupBy === 'machine') {
    keyExpr = `IFNULL(NULLIF(machine, ''), '(unknown)')`;
    selectExtra = `${keyExpr} AS key, ${keyExpr} AS machine, NULL AS agent`;
  } else if (options.groupBy === 'agent') {
    keyExpr = `agent`;
    selectExtra = `agent AS key, NULL AS machine, agent AS agent`;
  } else {
    keyExpr = `IFNULL(NULLIF(machine, ''), '(unknown)') || char(9) || agent`;
    selectExtra = `${keyExpr} AS key, IFNULL(NULLIF(machine, ''), '(unknown)') AS machine, agent AS agent`;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT
      ${selectExtra},
      COUNT(*) AS launches,
      IFNULL(SUM(duration_ms), 0) AS durationMs,
      IFNULL(SUM(token_count), 0) AS tokenCount,
      IFNULL(SUM(cost_usd), 0) AS costUsd
    FROM sessions
    ${clause}
    GROUP BY key
    ORDER BY launches DESC, key ASC
  `;
  return db.prepare(sql).all(...params) as AffinityRow[];
}

/** Aggregate cost/duration/tokens by agent, project, shortened model id, account, or day, with the
 * same filter shape as querySessions (agent, since/until, team-origin) so `agents insights cost`
 * matches `agents sessions`. Ordered by cost desc. */
export function queryUsageRollup(
  options: QueryOptions & { groupBy: UsageRollupGroup },
): UsageRollupRow[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const keyExpr =
    options.groupBy === 'agent'
      ? 'agent'
      : options.groupBy === 'project'
        ? `IFNULL(NULLIF(project, ''), '(no project)')`
        : options.groupBy === 'model'
          // Match shortenModel(): remove Claude's redundant harness prefix and
          // an optional eight-digit release-date suffix before grouping.
          ? `IFNULL(NULLIF(CASE
              WHEN substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, -9, 1) = '-'
                AND length(substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, -8)) = 8
                AND substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, -8) NOT GLOB '*[^0-9]*'
              THEN substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, 1,
                          length(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END) - 9)
              ELSE CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END
            END, ''), '(unknown)')`
        : options.groupBy === 'account'
          // A NULL account_key means the harness has no account attribution yet (Claude-only
          // mechanism, lib/session/claude-accounts.ts). Bucket per agent so rows are named
          // honestly, not called "not indexed" or joined to a real account.
          ? `IFNULL(NULLIF(account_key, ''), 'unattributed:' || agent)`
          // ISO timestamps are lexicographically date-sortable; the date is the
          // first 10 chars (YYYY-MM-DD).
          : `substr(timestamp, 1, 10)`;

  const sql = `
    SELECT
      ${keyExpr} AS key,
      ${options.groupBy === 'account'
        // One label per account_key by construction, so MAX just picks it out.
        ? `MAX(CASE WHEN account_org IS NOT NULL AND account IS NOT NULL
                    THEN account_org || ' <' || account || '>' END) AS label,`
        : ''}
      IFNULL(SUM(cost_usd), 0) AS costUsd,
      -- A session with a cost but no persisted no-cache figure records no cache
      -- split, so its no-cache cost equals its actual cost — fall back to cost_usd
      -- so it still contributes to the scenario total rather than dropping to 0.
      IFNULL(SUM(COALESCE(cost_usd_nocache, cost_usd)), 0) AS costUsdNoCache,
      IFNULL(SUM(duration_ms), 0) AS durationMs,
      COUNT(*) AS sessionCount,
      IFNULL(SUM(token_count), 0) AS tokenCount,
      IFNULL(SUM(output_tokens), 0) AS outputTokens,
      IFNULL(SUM(input_tokens), 0) AS inputTokens,
      IFNULL(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      IFNULL(SUM(cache_write_tokens), 0) AS cacheWriteTokens
    FROM sessions
    ${clause}
    GROUP BY key
    ORDER BY costUsd DESC, key ASC
  `;
  return db.prepare(sql).all(...params) as UsageRollupRow[];
}

/** One aggregated resource (skill or slash-command) in a usage-stats rollup. */
export interface ResourceStatRow {
  /** 'skill' or 'command' (singular, as stored in session_resource_usage.kind). */
  kind: string;
  /** Stored resource name — bare, or `plugin:short` for a plugin-owned resource. */
  name: string;
  /** Owning plugin, or null for a flat (non-namespaced) resource. */
  plugin: string | null;
  /** DotAgents layer or plugin marketplace the resource resolved to at write time. */
  source: string | null;
  /** Distinct sessions that invoked this resource within the filter window. */
  sessions: number;
  /** Total invocations (sum of per-session counts) within the window. */
  invocations: number;
}

/** Roll up skill/slash-command usage from session_resource_usage, joined to `sessions` so
 * querySessions filters apply, ordered by volume; `order: 'bottom'` is least-used first. Only
 * explicit invocations count, so an auto-triggered skill reads 0. */
export function queryResourceUsageStats(
  options: QueryOptions & {
    kind?: 'skill' | 'command';
    pluginFilter?: string;
    order?: 'top' | 'bottom';
    limit?: number;
  },
): ResourceStatRow[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  // buildSessionWhere emits bare column names and `id IN (...)` subqueries that resolve
  // unambiguously to `sessions` here (session_resource_usage has none of those columns; its key is
  // session_id). Strip the leading WHERE so resource predicates append.
  const base = clause.replace(/^WHERE\s+/, '');
  const preds: string[] = base ? [base] : [];
  const allParams: any[] = [...params];
  if (options.kind) {
    preds.push('r.kind = ?');
    allParams.push(options.kind);
  }
  if (options.pluginFilter) {
    preds.push('r.plugin = ? COLLATE NOCASE');
    allParams.push(options.pluginFilter);
  }
  const whereClause = preds.length ? `WHERE ${preds.join(' AND ')}` : '';
  const direction = options.order === 'bottom' ? 'ASC' : 'DESC';
  const limitClause = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';
  // Group by resource identity (kind, name) only, per SES-IF-4b: name already embeds
  // `plugin:short`. plugin and source are provenance that drift per session, so grouping on them
  // would split one resource into fractional rows; aggregate both with MAX.
  const sql = `
    SELECT
      r.kind AS kind,
      r.name AS name,
      MAX(r.plugin) AS plugin,
      MAX(r.source) AS source,
      COUNT(DISTINCT r.session_id) AS sessions,
      SUM(r.count) AS invocations
    FROM session_resource_usage r
    JOIN sessions s ON s.id = r.session_id
    ${whereClause}
    GROUP BY r.kind, r.name
    ORDER BY invocations ${direction}, sessions ${direction}, r.name ASC
    ${limitClause}
  `;
  return db.prepare(sql).all(...allParams) as ResourceStatRow[];
}

/** Coverage of the resource-usage signal: `scanned` = sessions with a `resource_scan_ledger` row at
 * the current RESOURCE_INDEX_VERSION (the true "backfill has run" signal); `covered` = sessions
 * with at least one usage row; `total` = indexed. The hint keys on `scanned/total` (PHNX-2301). */
export function resourceUsageCoverage(): { covered: number; scanned: number; total: number } {
  const db = getDB();
  const covered = (db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM session_resource_usage`).get() as { n: number }).n;
  // JOIN sessions so a ledger row for a vanished transcript cannot inflate scan coverage past the
  // indexed set. Only rows at the current extractor version count; a stale-version row is
  // re-derived on the next backfill.
  const scanned = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM resource_scan_ledger l
    JOIN sessions s ON s.id = l.session_id
    WHERE l.extractor_version = ?
  `).get(RESOURCE_INDEX_VERSION) as { n: number }).n;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  return { covered, scanned, total };
}

/** Has this session's resource usage been derived at the current extractor version for this exact file? */
function needsResourceIndex(
  db: Database.Database,
  sessionId: string,
  stamp: { fileMtimeMs: number; fileSize: number },
): boolean {
  const row = db
    .prepare(`SELECT file_mtime_ms, file_size, extractor_version FROM resource_scan_ledger WHERE session_id = ?`)
    .get(sessionId) as { file_mtime_ms: number; file_size: number; extractor_version: number } | undefined;
  return !row
    || row.file_mtime_ms !== stamp.fileMtimeMs
    || row.file_size !== stamp.fileSize
    || row.extractor_version !== RESOURCE_INDEX_VERSION;
}

/** Record that a session's resource usage is current at RESOURCE_INDEX_VERSION for this file stamp. */
function stampResourceLedger(
  db: Database.Database,
  sessionId: string,
  filePath: string,
  stamp: { fileMtimeMs: number; fileSize: number },
  resourceCount: number,
): void {
  db.prepare(`
    INSERT INTO resource_scan_ledger
      (session_id, file_path, file_mtime_ms, file_size, extractor_version, indexed_at, resource_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      file_path = excluded.file_path,
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      extractor_version = excluded.extractor_version,
      indexed_at = excluded.indexed_at,
      resource_count = excluded.resource_count
  `).run(sessionId, filePath, stamp.fileMtimeMs, stamp.fileSize, RESOURCE_INDEX_VERSION, Date.now(), resourceCount);
}

/** Outcome of a resource-usage backfill run. */
interface ResourceBackfillResult {
  /** Sessions considered (matched the filter, had a real transcript). */
  scanned: number;
  /** Sessions (re)parsed and written this run. */
  updated: number;
  /** Sessions already current at this extractor version, skipped. */
  skipped: number;
  /** Sessions whose transcript could not be stat'd or parsed. */
  failed: number;
  /** Total session_resource_usage rows written across updated sessions. */
  resourceRows: number;
}

/** One-shot historical backfill of session_resource_usage (#12): the incremental scan writes usage
 * only for transcripts it re-parses. Re-parses each from byte 0 and stamps resource_scan_ledger so
 * reruns skip completed ones. Harness-agnostic; synthetic rows without a transcript are skipped. */
export function backfillResourceUsage(
  filter: QueryOptions = {},
  onProgress?: (done: number, total: number) => void,
): ResourceBackfillResult {
  const db = getDB();
  // No LIMIT: the backfill covers the whole matching history. skipExistenceCheck
  // stays off so vanished transcripts are dropped, matching querySessions.
  const sessions = querySessions({ ...filter, limit: undefined });
  const result: ResourceBackfillResult = { scanned: 0, updated: 0, skipped: 0, failed: 0, resourceRows: 0 };
  let done = 0;
  for (const meta of sessions) {
    if (!meta.filePath) { done++; onProgress?.(done, sessions.length); continue; }
    result.scanned++;
    let stamp: { fileMtimeMs: number; fileSize: number };
    try {
      // Composite rows (`<container>#<id>`) stat their container file — the
      // per-session bytes/mtime stamp is derived during discovery, not here.
      const st = fs.statSync(sessionFilePathContainer(meta.filePath));
      stamp = { fileMtimeMs: st.mtimeMs, fileSize: st.size };
    } catch {
      result.failed++;
      done++; onProgress?.(done, sessions.length);
      continue;
    }
    if (!needsResourceIndex(db, meta.id, stamp)) {
      result.skipped++;
      done++; onProgress?.(done, sessions.length);
      continue;
    }
    try {
      const events = parseSession(meta.filePath, meta.agent);
      // Fail loud on a bad read: writeResourceUsage DELETEs before re-inserting, so a truncated
      // transcript parsing to zero events would wipe real usage and stamp the ledger current.
      // Empty means unreadable: count as failed, leave the ledger unstamped.
      if (events.length === 0) {
        result.failed++;
        done++; onProgress?.(done, sessions.length);
        continue;
      }
      writeResourceUsage(meta.id, events, meta.cwd);
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM session_resource_usage WHERE session_id = ?`).get(meta.id) as { n: number }).n;
      stampResourceLedger(db, meta.id, meta.filePath, stamp, rows);
      result.updated++;
      result.resourceRows += rows;
    } catch {
      result.failed++;
    }
    done++; onProgress?.(done, sessions.length);
  }
  return result;
}

/** Who spawned a team: the orchestrator session, from its transcript. */
export interface TeamSpawner {
  sessionId: string;
  shortId: string;
  /** The human the orchestrator ran as, when the row carries actor provenance. */
  actor?: string;
}

/** Map every team name to the session that ran `agents teams create/add` for it, in one scan over
 * rows with a `spawned_team` (no index; `agents teams list` needs the whole map). When two
 * sessions spawned the same team name (re-created after a disband), the most recent wins. */
export function teamSpawners(): Map<string, TeamSpawner> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT spawned_team, id, short_id, actor FROM sessions
       WHERE spawned_team IS NOT NULL AND spawned_team != ''
       ORDER BY timestamp ASC`
    )
    .all() as Array<{ spawned_team: string; id: string; short_id: string; actor: string | null }>;

  const out = new Map<string, TeamSpawner>();
  for (const r of rows) {
    out.set(r.spawned_team, { sessionId: r.id, shortId: r.short_id, actor: r.actor ?? undefined });
  }
  return out;
}

/** A session with its cost, for the top-N-by-cost listing. */
interface TopCostSession {
  meta: SessionMeta;
  costUsd: number;
  durationMs: number;
}

/** The N most expensive sessions (cost_usd DESC, NULLs excluded) with querySessions's filter shape.
 * Drops rows whose JSONL vanished, mirroring querySessions' liveness filter. */
export function topSessionsByCost(
  n: number,
  options: QueryOptions = {},
): TopCostSession[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const whereCost = clause ? `${clause} AND cost_usd IS NOT NULL` : 'WHERE cost_usd IS NOT NULL';
  const limit = Math.max(1, Math.floor(n));
  // Over-fetch a small buffer to survive the on-disk liveness filter below.
  const sql = `SELECT * FROM sessions ${whereCost} ORDER BY cost_usd DESC, timestamp DESC LIMIT ${limit + 16}`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
  // Keep a row whose file is present or whose transcript is archived: an expensive real session
  // must not drop out of the cost rollup because its file was removed (RUSH-2436). A phantom is
  // excluded. Stamp archived_at once so it agrees with the listing.
  const readContent = db.prepare(`SELECT content FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`);
  const markArchived = db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ? AND archived_at IS NULL`);
  const now = Date.now();
  const toStamp: SessionRow[] = [];
  const live = rows.filter(r => {
    if (!r.file_path || fs.existsSync(sessionFilePathContainer(r.file_path))) return true;
    if (r.archived_at != null) return true;
    const content = (readContent.get(r.id) as { content: string } | undefined)?.content;
    if (!!content && content.trim() !== '') { toStamp.push(r); return true; }
    return false;
  });
  if (toStamp.length > 0) {
    const stamp = db.transaction(() => {
      for (const r of toStamp) { markArchived.run(now, r.id); r.archived_at = now; }
    });
    stamp();
  }
  return live.slice(0, limit).map(r => ({
    meta: rowToMeta(r),
    costUsd: r.cost_usd ?? 0,
    durationMs: r.duration_ms ?? 0,
  }));
}

/** Read machine attribution in batches without materializing full sessions. Best-effort so the live
 * view can still render local attribution on failure. */
export function findSessionMachinesByIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  try {
    const db = getDB();
    const CHUNK = 500; // stay well under SQLite's default 999-variable limit
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const batch = uniq.slice(i, i + CHUNK);
      const placeholders = batch.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, machine FROM sessions WHERE id IN (${placeholders})`)
        .all(...batch) as Array<{ id: string; machine: string | null }>;
      for (const r of rows) if (r.machine) out.set(r.id, r.machine);
    }
  } catch {
    /* index read is best-effort — an unavailable DB leaves rows un-attributed */
  }
  return out;
}

export function getSessionById(id: string): SessionMeta | null {
  const db = getDB();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  return row ? rowToMeta(row) : null;
}

/** Exact ids win over prefixes; the normal existence check preserves archived content but excludes phantoms. */
export function findSessionsById(
  idQuery: string,
  scope: Pick<QueryOptions, 'agent' | 'version' | 'cwd' | 'project'> = {},
): SessionMeta[] {
  const q = idQuery.trim();
  if (!q) return [];
  const exact = querySessions({ ...scope, idExact: q });
  if (exact.length > 0) return exact;
  return querySessions({ ...scope, idPrefix: q });
}

/** Upgrade a session-id crumb to the full indexed id: the 8-char hex `short_id` in a "Sent from
 * ..." footer would 404 as a console URL, so an owner ping resolves it first (PHNX-3698). A full
 * id, non-crumb shape (`ses_...`), or unresolvable crumb is returned unchanged, never fabricated. */
export function resolveFullSessionId(idOrCrumb: string | undefined): string | undefined {
  const id = idOrCrumb?.trim();
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}$/i.test(id)) return id; // already a full id (or non-hex shape) — nothing to resolve
  const hit = findSessionsByShortIds([id]).get(id.toLowerCase());
  return hit?.id ?? id;
}

/** Batch-resolve pane short ids; on collision the most recently active session wins. */
export function findSessionsByShortIds(shortIds: string[]): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  const uniq = [...new Set(shortIds.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (uniq.length === 0) return out;
  const db = getDB();
  const CHUNK = 500; // stay well under SQLite's default 999-variable limit
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    const placeholders = batch.map(() => '?').join(',');
    // timestamp ASC so a later (newer) row overwrites an earlier one per short_id.
    const rows = db
      .prepare(`SELECT * FROM sessions WHERE short_id IN (${placeholders}) ORDER BY timestamp ASC`)
      .all(...batch) as SessionRow[];
    for (const row of rows) {
      const key = (row.short_id ?? '').toLowerCase();
      if (key) out.set(key, rowToMeta(row));
    }
  }
  return out;
}

/** A single full-text search result with ranking score. */
interface FtsHit {
  sessionId: string;
  score: number;
  matchedTerms: string[];
  /** A short bm25 `snippet()` excerpt around the best-matching column (label, topic, project, user
   * content or assistant answer), matches wrapped in `**...**`. Absent for a handle/label-tier hit
   * (tiers 1-3), where the label itself is the match. */
  snippet?: string;
}

/** Escape a raw user query into a safe FTS5 MATCH expression: split on non-word characters, keep
 * tokens of 2+ chars, OR-join with a prefix wildcard so partial typing ('rush dep') matches. */
export function buildFtsQuery(input: string): { expr: string; terms: string[] } {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (terms.length === 0) return { expr: '', terms: [] };
  const expr = terms.map(t => `${t}*`).join(' OR ');
  return { expr, terms };
}

/** Build a `label:(...)` FTS5 column-filter expression for the label tier. Unlike `buildFtsQuery`
 * (2-char floor) it allows 1-char terms, since label search is the keystroke-by-keystroke
 * type-ahead path. Terms are filtered to `[a-z0-9]`, so no FTS5 syntax injection. */
function buildLabelFtsQuery(input: string): string {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 1);
  if (terms.length === 0) return '';
  return `label:(${terms.map(t => `${t}*`).join(' OR ')})`;
}

/** Label-first search: sessions whose custom label substring-matches rank ahead of FTS5 hits, so
 * typing an exact `/rename` name is predictable. Tiers: 1 exact label (1_000_000), 2 prefix
 * (900_000), 3 contains (800_000), 4 FTS5 BM25 (1..1000, sign flipped since bm25() is negative). */
export function ftsSearch(input: string, limit = 200): FtsHit[] {
  const db = getDB();
  const trimmed = input.trim();
  if (!trimmed) return [];

  const { expr, terms } = buildFtsQuery(input);
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();
  const hits: FtsHit[] = [];

  // Tier 1-3: handle matches by exactness; a handle is the `label`. Candidates come from the FTS5
  // `label` column, not `LOWER(label) LIKE '%q%'`, which scanned the table per keystroke
  // (RUSH-2211). Trade-off: token-boundary matches only.
  const labelMatchExpr = buildLabelFtsQuery(input);
  const labelRows = labelMatchExpr
    ? (db.prepare(`
        SELECT session_id AS id, label FROM session_text
        WHERE session_text MATCH ?
      `).all(labelMatchExpr) as Array<{ id: string; label: string | null }>)
    : (db.prepare(`
        SELECT id, label FROM sessions
        WHERE label IS NOT NULL AND LOWER(label) LIKE ?
      `).all(`%${lower}%`) as Array<{ id: string; label: string | null }>);

  let hasExactLabelMatch = false;
  for (const row of labelRows) {
    // Score the label by match quality (exact > prefix > contains).
    let score = 0;
    const handle = row.label;
    if (handle) {
      const h = handle.toLowerCase();
      if (h.includes(lower)) {
        if (h === lower) {
          score = 1_000_000;
          hasExactLabelMatch = true;
        } else if (h.startsWith(lower)) {
          score = 900_000;
        } else {
          score = 800_000;
        }
      }
    }
    if (score === 0) continue;
    // matchedTerms is empty for handle hits — the picker can render the handle
    // itself as the highlight, no badge needed.
    hits.push({ sessionId: row.id, score, matchedTerms: [] });
    seen.add(row.id);
  }

  // If the query exactly names a labeled session, don't dilute the result
  // with FTS5 content hits — the user typed a specific thing, show just it.
  if (hasExactLabelMatch) {
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // Tier 4: FTS5 content match, skipping rows already surfaced via label. `snippet(session_text,
  // -1, ...)` lets FTS5 pick the best column itself, so an assistant-only match still gets an
  // excerpt from the right column.
  if (expr) {
    try {
      const rows = db
        .prepare(`
          SELECT session_id, bm25(session_text, ${BM25_WEIGHTS.join(', ')}) AS rank,
                 snippet(session_text, -1, '**', '**', '…', 12) AS snip
          FROM session_text
          WHERE session_text MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(expr, limit) as { session_id: string; rank: number; snip: string | null }[];

      for (const r of rows) {
        if (seen.has(r.session_id)) continue;
        hits.push({
          sessionId: r.session_id,
          score: -r.rank,
          matchedTerms: terms,
          snippet: r.snip?.trim() || undefined,
        });
        seen.add(r.session_id);
      }
    } catch {
      /* invalid MATCH expression — tier 4 just yields nothing */
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Rewrite file_path for sessions whose path starts with any `moves.from`, swapping in `moves.to`
 * and clearing matching scan_ledger entries so the next scan re-indexes. One transaction for the
 * batch (PHNX-3940 T7), so the index is never half-rewritten. Longest `from` wins. */
export function reindexMovedSessionPaths(moves: ReadonlyArray<{ from: string; to: string }>): number {
  const usable = moves.filter((m) => m.from && m.from !== m.to);
  if (usable.length === 0) return 0;

  const db = getDB();
  const sorted = [...usable].sort((a, b) => b.from.length - a.from.length);

  return db.transaction(() => {
    let n = 0;
    const seen = new Set<string>();
    const update = db.prepare(`UPDATE sessions SET file_path = ? WHERE id = ?`);
    const dropLedger = db.prepare(`DELETE FROM scan_ledger WHERE file_path = ?`);
    const select = db.prepare(`SELECT id, file_path FROM sessions WHERE file_path LIKE ?`);
    for (const { from, to } of sorted) {
      const rows = select.all(from + '%') as { id: string; file_path: string }[];
      for (const { id, file_path } of rows) {
        if (seen.has(id)) continue;
        seen.add(id);
        update.run(to + file_path.slice(from.length), id);
        dropLedger.run(canonicalLedgerKey(file_path));
        n++;
      }
    }
    return n;
  })();
}

/** Rewrite file_path for sessions whose path starts with oldPrefix (newPrefix + unchanged suffix)
 * and clear matching scan_ledger entries. Used by removeVersion after soft-deleting a version dir
 * to trash, so transcript view and /continue still work. Returns rows updated. */
export function updateSessionFilePaths(oldPrefix: string, newPrefix: string): number {
  return reindexMovedSessionPaths([{ from: oldPrefix, to: newPrefix }]);
}

/** Count indexed sessions whose transcript path sits under `prefix`. */
export function countSessionsWithFilePrefix(prefix: string): number {
  if (!prefix) return 0;
  const row = getDB()
    .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE file_path LIKE ?`)
    .get(prefix + '%') as { c: number };
  return row.c;
}

// ─── Tool sessions: durable browser / computer-use metadata (RUSH-2549) ──────

/** Per-kind capture tallies for a browser task. Counts only -- never the bytes. */
interface BrowserCaptureCounts {
  screenshot: number;
  pdf: number;
  recording: number;
  download: number;
}

/** One durable browser-task row. `machine` defaults to this device. */
interface BrowserSessionRecord {
  task: string;
  profile: string;
  sessionId?: string;
  launchId?: string;
  actor?: string;
  machine?: string;
  startedAt?: number;
  lastActivity?: number;
  counts?: Partial<BrowserCaptureCounts>;
  captureDir?: string;
  capturesRemote?: string;
}

/** One durable computer-use invocation row. `machine` defaults to this device. */
interface ComputerSessionRecord {
  invocationId: string;
  sessionId?: string;
  launchId?: string;
  actor?: string;
  machine?: string;
  startedAt?: number;
  lastActivity?: number;
  actionCount?: number;
  taskPreview?: string;
}

/** Upsert one browser task's durable metadata at task START. Identity is resolved in the calling
 * CLI process and sent over IPC; resolving daemon-side would attribute every task to the daemon
 * (RUSH-2020). `agents browser stop` keeps the row; identity is only widened. */
export function recordBrowserSession(record: BrowserSessionRecord): void {
  const db = getDB();
  const now = Date.now();
  db.prepare(`
    INSERT INTO browser_sessions (
      task, profile, session_id, launch_id, actor, machine,
      started_at, last_activity,
      screenshot_count, pdf_count, recording_count, download_count,
      capture_dir, captures_remote
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile, task) DO UPDATE SET
      session_id       = COALESCE(excluded.session_id, browser_sessions.session_id),
      launch_id        = COALESCE(excluded.launch_id, browser_sessions.launch_id),
      actor            = COALESCE(excluded.actor, browser_sessions.actor),
      last_activity    = excluded.last_activity,
      screenshot_count = excluded.screenshot_count,
      pdf_count        = excluded.pdf_count,
      recording_count  = excluded.recording_count,
      download_count   = excluded.download_count,
      capture_dir      = COALESCE(excluded.capture_dir, browser_sessions.capture_dir),
      captures_remote  = COALESCE(excluded.captures_remote, browser_sessions.captures_remote)
  `).run(
    record.task,
    record.profile,
    record.sessionId ?? null,
    record.launchId ?? null,
    record.actor ?? null,
    record.machine ?? machineId(),
    record.startedAt ?? now,
    record.lastActivity ?? now,
    record.counts?.screenshot ?? 0,
    record.counts?.pdf ?? 0,
    record.counts?.recording ?? 0,
    record.counts?.download ?? 0,
    record.captureDir ?? null,
    record.capturesRemote ?? null,
  );
}

/** Upsert one computer-use invocation's durable metadata. `action_count` accumulates (a `computer
 * run` loop emits many actions under one invocation id, each its own call). Identity is
 * widened-only, as above. */
export function recordComputerSession(record: ComputerSessionRecord): void {
  const db = getDB();
  const now = Date.now();
  db.prepare(`
    INSERT INTO computer_sessions (
      invocation_id, session_id, launch_id, actor, machine,
      started_at, last_activity, action_count, task_preview
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(invocation_id) DO UPDATE SET
      session_id    = COALESCE(excluded.session_id, computer_sessions.session_id),
      launch_id     = COALESCE(excluded.launch_id, computer_sessions.launch_id),
      actor         = COALESCE(excluded.actor, computer_sessions.actor),
      last_activity = excluded.last_activity,
      action_count  = computer_sessions.action_count + excluded.action_count,
      task_preview  = COALESCE(excluded.task_preview, computer_sessions.task_preview)
  `).run(
    record.invocationId,
    record.sessionId ?? null,
    record.launchId ?? null,
    record.actor ?? null,
    record.machine ?? machineId(),
    record.startedAt ?? now,
    record.lastActivity ?? now,
    record.actionCount ?? 1,
    record.taskPreview ?? null,
  );
}

/** A stored browser row as read back, with counts rehydrated. */
interface StoredBrowserSession extends Required<Pick<BrowserSessionRecord, 'task' | 'profile'>> {
  sessionId?: string;
  launchId?: string;
  actor?: string;
  machine: string;
  startedAt: number;
  lastActivity?: number;
  counts: BrowserCaptureCounts;
  captureDir?: string;
  capturesRemote?: string;
}

interface BrowserSessionRow {
  task: string;
  profile: string;
  session_id: string | null;
  launch_id: string | null;
  actor: string | null;
  machine: string;
  started_at: number;
  last_activity: number | null;
  screenshot_count: number;
  pdf_count: number;
  recording_count: number;
  download_count: number;
  capture_dir: string | null;
  captures_remote: string | null;
}

function toStoredBrowserSession(row: BrowserSessionRow): StoredBrowserSession {
  return {
    task: row.task,
    profile: row.profile,
    sessionId: row.session_id ?? undefined,
    launchId: row.launch_id ?? undefined,
    actor: row.actor ?? undefined,
    machine: row.machine,
    startedAt: row.started_at,
    lastActivity: row.last_activity ?? undefined,
    counts: {
      screenshot: row.screenshot_count,
      pdf: row.pdf_count,
      recording: row.recording_count,
      download: row.download_count,
    },
    captureDir: row.capture_dir ?? undefined,
    capturesRemote: row.captures_remote ?? undefined,
  };
}

/** Stored browser tasks, newest first, optionally scoped to a profile. A profile-scoped read is
 * deliberately unbounded: these rows identify existing capture dirs, and dropping the oldest would
 * regress those tasks to `unlinked`. Only the unscoped read (all profiles) takes a ceiling. */
export function listBrowserSessionRecords(
  profile?: string,
  opts: { limit?: number } = {},
): StoredBrowserSession[] {
  const db = getDB();
  const rows = (profile
    ? db.prepare(`SELECT * FROM browser_sessions WHERE profile = ? ORDER BY started_at DESC`).all(profile)
    : db.prepare(`SELECT * FROM browser_sessions ORDER BY started_at DESC LIMIT ?`)
      .all(opts.limit ?? TOOL_SESSION_LIST_LIMIT)) as BrowserSessionRow[];
  return rows.map(toStoredBrowserSession);
}

/** One stored browser task by its (profile, task) key, or null. */
export function getBrowserSessionRecord(profile: string, task: string): StoredBrowserSession | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT * FROM browser_sessions WHERE profile = ? AND task = ?`)
    .get(profile, task) as BrowserSessionRow | undefined;
  return row ? toStoredBrowserSession(row) : null;
}

/** A stored computer-use invocation as read back. */
interface StoredComputerSession {
  invocationId: string;
  sessionId?: string;
  launchId?: string;
  actor?: string;
  machine: string;
  startedAt: number;
  lastActivity?: number;
  actionCount: number;
  taskPreview?: string;
}

interface ComputerSessionRow {
  invocation_id: string;
  session_id: string | null;
  launch_id: string | null;
  actor: string | null;
  machine: string;
  started_at: number;
  last_activity: number | null;
  action_count: number;
  task_preview: string | null;
}

/** Retention for the tool-session tables: the durable answer to a ledger that prunes at 7 days, but
 * not unbounded. `computer_sessions` gets a row per `agents computer` CLI process (hundreds a
 * day), so an unbounded table would grow forever and be read in full on every listing. */
const TOOL_SESSION_MAX_AGE_DAYS = 365;
/** Default ceiling on rows one listing will read. */
const TOOL_SESSION_LIST_LIMIT = 2000;

/** Drop tool-session rows past {@link TOOL_SESSION_MAX_AGE_DAYS}. Called from the listing path,
 * never the write hot path: an `agents computer` action must not pay for a table sweep. Returns
 * rows deleted. */
export function pruneToolSessions(maxAgeDays: number = TOOL_SESSION_MAX_AGE_DAYS): number {
  const db = getDB();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Cheap indexed guard first, so the common case is one lookup, not a write transaction (same
  // shape as the account repair). A bare DELETE would open one and could make a read-only listing
  // wait on the indexer under `busy_timeout = 30000`.
  const stale = db.prepare(`
    SELECT 1 FROM computer_sessions WHERE started_at < ?
    UNION ALL
    SELECT 1 FROM browser_sessions WHERE started_at < ?
    LIMIT 1
  `).get(cutoff, cutoff);
  if (!stale) return 0;

  const computer = db.prepare(`DELETE FROM computer_sessions WHERE started_at < ?`).run(cutoff);
  const browser = db.prepare(`DELETE FROM browser_sessions WHERE started_at < ?`).run(cutoff);
  return Number(computer.changes ?? 0) + Number(browser.changes ?? 0);
}

/** Stored computer-use invocations, newest first, bounded. The limit is a real ceiling: `--json`
 * serializes whatever this returns, so an unbounded read would dump the whole table on every call. */
export function listComputerSessionRecords(
  opts: { limit?: number; startedBeforeMs?: number } = {},
): StoredComputerSession[] {
  const db = getDB();
  const limit = opts.limit ?? TOOL_SESSION_LIST_LIMIT;
  // `startedBeforeMs` selects the complement of the caller's other source, not the newest N: the
  // recovery caller already holds every recent invocation from the event ledger, so a newest-N
  // read returns rows it discards. Bound by "older than the ledger reaches".
  const rows = (opts.startedBeforeMs === undefined
    ? db
      .prepare(`SELECT * FROM computer_sessions ORDER BY started_at DESC LIMIT ?`)
      .all(limit)
    : db
      .prepare(`SELECT * FROM computer_sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?`)
      .all(opts.startedBeforeMs, limit)) as ComputerSessionRow[];
  return rows.map((row) => ({
    invocationId: row.invocation_id,
    sessionId: row.session_id ?? undefined,
    launchId: row.launch_id ?? undefined,
    actor: row.actor ?? undefined,
    machine: row.machine,
    startedAt: row.started_at,
    lastActivity: row.last_activity ?? undefined,
    actionCount: row.action_count,
    taskPreview: row.task_preview ?? undefined,
  }));
}
