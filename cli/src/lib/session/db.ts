
import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import type { SessionAgentId, SessionCheckpoint, SessionChecklistItem, SessionEvent, SessionFiles, SessionGlance, SessionMeta, SessionRequest, SessionRunMode, SessionSubagent, SessionTimeline, SummaryState } from '@phnx-labs/sessions-cli/reader';
import { claudeSubagentFiles, resolvedSubAgentCount } from './glance-files.js';
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

export const SCHEMA_VERSION = 51;

export const CONTENT_INDEX_VERSION = 6;

const RESOURCE_INDEX_VERSION = 1;

function canonicalLedgerKey(filePath: string): string {
  if (!filePath) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

const BM25_WEIGHTS = [5.0, 2.0, 1.5, 1.0, 0.5] as const;

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

export const INSIGHTS_EXTRACTOR_VERSION = 7;
export const SESSION_TOPIC_EXTRACTOR_VERSION = 2;
const PREVIEW_EXTRACTOR_VERSION = 3;
export const SESSION_PHENOTYPE_EXTRACTOR_VERSION = 1;
export const SESSION_SUMMARY_EXTRACTOR_VERSION = 1;

interface SessionRow {
  id: string;
  short_id: string;
  agent: string;
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
  phoenix_id: string | null;
  used_browser: number | null;
  used_computer: number | null;
  archived_at?: number | null;
  mirror_synced_at?: number | null;
  mirror_source?: string | null;
  generated_title?: string | null;
  generated_title_key?: string | null;
  generated_title_at?: number | null;
}

export interface ScanStamp {
  fileMtimeMs: number;
  fileSize: number;
  scannedAt?: number;
  extractorVersion?: number | null;
}

export interface QueryOptions {
  agent?: SessionAgentId;
  agents?: SessionAgentId[];
  origin?: 'cli' | 'routine';
  version?: string;
  cwd?: string;
  cwdPrefix?: string;
  project?: string;
  machine?: string;
  idExact?: string;
  idPrefix?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  excludeTeamOrigin?: boolean;
  onlyTeamOrigin?: boolean;
  sortBy?: 'timestamp' | 'cost' | 'duration';
  skipExistenceCheck?: boolean;
  skill?: string;
  plugin?: string;
}

let dbInstance: Database.Database | null = null;

function migrateSchema(db: Database.Database, fromVersion: number): void {
  if (fromVersion < 2) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'label')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`);
    }
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
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 4) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'is_team_origin')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN is_team_origin INTEGER DEFAULT 0`);
    }
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 5) {
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 6) {
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
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'pr_url')) db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
    if (!cols.some(c => c.name === 'pr_number')) db.exec(`ALTER TABLE sessions ADD COLUMN pr_number INTEGER`);
    if (!cols.some(c => c.name === 'worktree_slug')) db.exec(`ALTER TABLE sessions ADD COLUMN worktree_slug TEXT`);
    if (!cols.some(c => c.name === 'ticket_id')) db.exec(`ALTER TABLE sessions ADD COLUMN ticket_id TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 8) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'last_activity')) db.exec(`ALTER TABLE sessions ADD COLUMN last_activity TEXT`);
    db.exec(`UPDATE sessions SET last_activity = timestamp WHERE last_activity IS NULL`);
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 9) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'name')) db.exec(`ALTER TABLE sessions ADD COLUMN name TEXT`);
  }
  if (fromVersion < 10) {
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
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'plan')) db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 12) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'output_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN output_tokens INTEGER`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 13) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'origin')) db.exec(`ALTER TABLE sessions ADD COLUMN origin TEXT DEFAULT 'cli'`);
    if (!cols.some(c => c.name === 'routine_name')) db.exec(`ALTER TABLE sessions ADD COLUMN routine_name TEXT`);
    if (!cols.some(c => c.name === 'routine_run_id')) db.exec(`ALTER TABLE sessions ADD COLUMN routine_run_id TEXT`);
    db.exec(`UPDATE sessions SET origin = 'cli' WHERE origin IS NULL OR origin = ''`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 14) {
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
    const cols = db.prepare(`PRAGMA table_info(scan_ledger)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'parser_state')) db.exec(`ALTER TABLE scan_ledger ADD COLUMN parser_state TEXT`);
    if (!cols.some(c => c.name === 'content_text')) db.exec(`ALTER TABLE scan_ledger ADD COLUMN content_text TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 16) {
    db.exec(`UPDATE sessions SET short_id = substr(id, 1, 8) WHERE short_id IS NULL OR short_id = ''`);
  }

  if (fromVersion < 17) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'todos')) db.exec(`ALTER TABLE sessions ADD COLUMN todos TEXT`);
    if (!cols.some(c => c.name === 'recent_directories_touched')) db.exec(`ALTER TABLE sessions ADD COLUMN recent_directories_touched TEXT`);
    if (!cols.some(c => c.name === 'linear_project')) db.exec(`ALTER TABLE sessions ADD COLUMN linear_project TEXT`);
    if (!cols.some(c => c.name === 'linear_project_url')) db.exec(`ALTER TABLE sessions ADD COLUMN linear_project_url TEXT`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 18) {
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
    for (const row of rows) {
      upd.run(machineForSessionFile(row.file_path, row.agent), row.id);
    }
  }

  if (fromVersion < 19) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'actor')) db.exec(`ALTER TABLE sessions ADD COLUMN actor TEXT`);
    if (!cols.some(c => c.name === 'initiated_by')) db.exec(`ALTER TABLE sessions ADD COLUMN initiated_by TEXT`);
  }

  if (fromVersion < 20) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'model')) db.exec(`ALTER TABLE sessions ADD COLUMN model TEXT`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 21) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'spawned_team')) db.exec(`ALTER TABLE sessions ADD COLUMN spawned_team TEXT`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 22) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'tool_call_count')) db.exec(`ALTER TABLE sessions ADD COLUMN tool_call_count INTEGER`);
    db.exec(`DELETE FROM scan_ledger; DELETE FROM dir_ledger;`);
  }

  if (fromVersion < 23) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'used_browser')) db.exec(`ALTER TABLE sessions ADD COLUMN used_browser INTEGER`);
    if (!cols.some(c => c.name === 'used_computer')) db.exec(`ALTER TABLE sessions ADD COLUMN used_computer INTEGER`);
  }

  if (fromVersion < 24) {
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
    const callCols = db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>;
    if (!callCols.some((column) => column.name === 'evidence_bytes')) {
      db.exec(`ALTER TABLE tool_calls ADD COLUMN evidence_bytes INTEGER NOT NULL DEFAULT 0`);
    }
    const ledgerCols = db.prepare(`PRAGMA table_info(tool_scan_ledger)`).all() as Array<{ name: string }>;
    if (!ledgerCols.some((column) => column.name === 'evidence_bytes')) {
      db.exec(`ALTER TABLE tool_scan_ledger ADD COLUMN evidence_bytes INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`DELETE FROM tool_scan_ledger`);
  }

  if (fromVersion < 27) {
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
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!cols.has('mode')) db.exec(`ALTER TABLE sessions ADD COLUMN mode TEXT`);
  }

  if (fromVersion < 33) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!cols.has('account_key')) db.exec(`ALTER TABLE sessions ADD COLUMN account_key TEXT`);
    if (!cols.has('account_org')) db.exec(`ALTER TABLE sessions ADD COLUMN account_org TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_account_key ON sessions(account_key)`);
    backfillClaudeAccounts(db);
  }

  if (fromVersion < 34) {
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
    db.exec(`UPDATE sessions SET last_activity = timestamp WHERE last_activity IS NULL`);
  }

  if (fromVersion < 36) {
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
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('input_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER`);
    if (!cols.has('cache_read_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER`);
    if (!cols.has('cache_write_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER`);
    if (!cols.has('cost_usd_nocache')) db.exec(`ALTER TABLE sessions ADD COLUMN cost_usd_nocache REAL`);
  }

  if (fromVersion < 38) {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'archived_at')) db.exec(`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`);
  }

  if (fromVersion < 39) {
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
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('sub_agent_count')) db.exec(`ALTER TABLE sessions ADD COLUMN sub_agent_count INTEGER`);
    if (!cols.has('background_shell_count')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN background_shell_count INTEGER`);
    }
  }

  if (fromVersion < 41) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('harness')) db.exec(`ALTER TABLE sessions ADD COLUMN harness TEXT`);
  }

  if (fromVersion < 42) {
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
  }

  if (fromVersion < 43) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('end_timestamp')) db.exec(`ALTER TABLE tool_calls ADD COLUMN end_timestamp TEXT`);
  }

  if (fromVersion < 44) {
    const nullDurationRows = db.prepare(
      `SELECT id, timestamp, last_activity FROM sessions
       WHERE duration_ms IS NULL AND last_activity IS NOT NULL`,
    ).all() as Array<{ id: string; timestamp: string; last_activity: string }>;
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
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('first_user_message')) db.exec(`ALTER TABLE sessions ADD COLUMN first_user_message TEXT`);
  }

  if (fromVersion < 46) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('mirror_synced_at')) db.exec(`ALTER TABLE sessions ADD COLUMN mirror_synced_at INTEGER`);
    if (!cols.has('mirror_source')) db.exec(`ALTER TABLE sessions ADD COLUMN mirror_source TEXT`);
  }

  if (fromVersion < 47) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('phoenix_id')) db.exec(`ALTER TABLE sessions ADD COLUMN phoenix_id TEXT`);
  }

  if (fromVersion < 48) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('last_user_message')) db.exec(`ALTER TABLE sessions ADD COLUMN last_user_message TEXT`);
  }

  if (fromVersion < 49) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name),
    );
    if (!cols.has('account_id')) db.exec(`ALTER TABLE sessions ADD COLUMN account_id TEXT`);
  }

  if (fromVersion < 50) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('generated_title')) db.exec(`ALTER TABLE sessions ADD COLUMN generated_title TEXT`);
    if (!cols.has('generated_title_key')) db.exec(`ALTER TABLE sessions ADD COLUMN generated_title_key TEXT`);
    if (!cols.has('generated_title_at')) db.exec(`ALTER TABLE sessions ADD COLUMN generated_title_at INTEGER`);
  }

  if (fromVersion < 51) {
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

function backfillClaudeAccounts(
  db: Database.Database,
  scope: 'all' | 'unresolved' = 'all',
): void {
  const where = scope === 'all'
    ? `agent = 'claude'`
    : `agent = 'claude' AND (account_key IS NULL
         OR (account_key LIKE 'unattributed:%' AND account IS NOT NULL))`;
  const index = buildClaudeAccountIndex();
  const rows = db.prepare(
    `SELECT id, file_path, version FROM sessions WHERE ${where}`,
  ).all() as Array<{ id: string; file_path: string; version: string | null }>;
  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE sessions SET account_key = ?, account_org = ?, account = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const bucket = resolveClaudeAccount(index, row.file_path ?? '', row.version, readSessionActorRecord(row.id)?.accountId);
    update.run(bucket.key, bucket.orgName, bucket.email, row.id);
  }
}

export function getDB(initialBusyTimeoutMs = 30_000): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  try {

    db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(initialBusyTimeoutMs))}`);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.exec(SCHEMA);

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
      const migrate = db.transaction(() => {

        const lockedVersion = readSchemaVersion();
        if (lockedVersion === undefined || lockedVersion >= SCHEMA_VERSION) return;
        migrateSchema(db, lockedVersion);
        db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
      });
      migrate();
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_origin ON sessions(origin)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_mirror_synced ON sessions(mirror_synced_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_routine_run_id ON sessions(routine_run_id)`);
    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (['account_id', 'phoenix_id'].some(name => !sessionColumns.some(column => column.name === name))) {
      db.transaction(() => {
        const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === 'account_id')) db.exec('ALTER TABLE sessions ADD COLUMN account_id TEXT');
        if (!columns.some(column => column.name === 'phoenix_id')) db.exec('ALTER TABLE sessions ADD COLUMN phoenix_id TEXT');
      })();
    }

    {
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

    {
      const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'harness')) {
        db.exec(`ALTER TABLE sessions ADD COLUMN harness TEXT`);
      }
    }

    const cleaned = db.prepare(`SELECT value FROM meta WHERE key = 'legacy_indexes_removed'`).get() as { value: string } | undefined;
    if (!cleaned) {
      for (const p of [
        path.join(SESSIONS_DIR, 'index.jsonl'),
        path.join(SESSIONS_DIR, 'content_index.jsonl'),
        path.join(SESSIONS_DIR, 'index.jsonl.bak'),
      ]) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {  }
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

export function withSessionDBTimeout<T>(timeoutMs: number, operation: () => T): T {
  const db = getDB(timeoutMs);
  const previous = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
  try { return operation(); }
  finally { db.pragma(`busy_timeout = ${previous}`); }
}

export function closeDB(): void {
  clearSessionExistenceCache();
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    cachedStmts = {};
  }
}

interface FtsOptimizeResult {
  table: string;
  segmentsBefore: number;
  segmentsAfter: number;
}

export function optimizeSessionSearchIndex(): FtsOptimizeResult[] {
  const db = getDB();
  const tables = ['tool_call_text', 'session_text'];
  const segments = (table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}_data`).get() as { n: number }).n;
  return tables.map((table) => {
    const segmentsBefore = segments(table);
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('optimize')`).run();
    return { table, segmentsBefore, segmentsAfter: segments(table) };
  });
}

const FTS_MAINTENANCE_SEGMENT_THRESHOLD = 512;

const FTS_MAINTENANCE_MERGE_PAGES = 64;

export function maintainSessionSearchIndex(
  db: Database.Database = getDB(),
  options: { segmentThreshold?: number; mergePages?: number } = {},
): FtsOptimizeResult[] {
  const threshold = options.segmentThreshold ?? FTS_MAINTENANCE_SEGMENT_THRESHOLD;
  const pages = options.mergePages ?? FTS_MAINTENANCE_MERGE_PAGES;
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


const SCAN_CLAIM_TTL_MS = 120_000;

function isProcessAlive(pid: number): boolean {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
        return false;
      }
    }

    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('scan_in_progress', ?)`)
      .run(`${pid}:${Date.now()}`);
    return true;
  });

  return txn();
}

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

export function getDBPath(): string {
  return DB_PATH;
}

export function getScanStampByPath(filePath: string): ScanStamp | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT file_mtime_ms, file_size, scanned_at, extractor_version FROM scan_ledger WHERE file_path = ? LIMIT 1`)
    .get(canonicalLedgerKey(filePath)) as { file_mtime_ms: number; file_size: number; scanned_at: number; extractor_version: number | null } | undefined;
  return row
    ? { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, scannedAt: row.scanned_at, extractorVersion: row.extractor_version }
    : null;
}

export function getScanStampsForPaths(filePaths: string[]): Map<string, ScanStamp> {
  const result = new Map<string, ScanStamp>();
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

interface ParserStateRow {
  parserState: string | null;
  contentText: string | null;
  fileMtimeMs: number;
  fileSize: number;
  scannedAt: number;
  extractorVersion: number | null;
}

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
      stmt.run(canonicalLedgerKey(filePath), scan.fileMtimeMs, scan.fileSize, now, CONTENT_INDEX_VERSION);
    }
  });
  txn(entries);
}

export interface DirStamp {
  dirMtimeMs: number;
  entryCount: number;
}

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

function detectToolUsage(sessionId: string): { usedBrowser: boolean; usedComputer: boolean } {
  const usedBrowser = queryEvents({ sessionId, eventTypes: ['browser.navigate', 'browser.screenshot'], limit: 1 }).length > 0;
  const usedComputer = queryEvents({ sessionId, eventTypes: ['computer.action'], limit: 1 }).length > 0;
  return { usedBrowser, usedComputer };
}

const deleteResourceUsageStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_resource_usage WHERE session_id = ?`);
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

function writeResourceUsage(sessionId: string, events: SessionEvent[], cwd: string | undefined): void {
  writeResourceUsageFromTallies(sessionId, extractSkills(events), extractSlashCommands(events), cwd);
}

function fanOutCounts(
  events: SessionEvent[],
  agent: SessionAgentId,
  sessionFile?: string,
): { subAgentCount: number; backgroundShellCount: number | undefined } {
  let subAgentCount = 0;
  for (const e of events) {
    if (e.type !== 'tool_use' || e._local) continue;
    if (isSubAgentTool(e.tool || '', e.command || '')) subAgentCount++;
  }
  const children = agent === 'claude' && sessionFile ? claudeSubagentFiles(sessionFile) : undefined;
  return {
    subAgentCount: resolvedSubAgentCount(children, subAgentCount),
    backgroundShellCount: harnessTracksBackgroundShells(agent)
      ? extractBackgroundShells(events).length
      : undefined,
  };
}

function enrichMetaFromEvents(meta: SessionMeta, events: SessionEvent[]): SessionMeta {
  return {
    ...meta,
    firstUserMessage: meta.firstUserMessage ?? firstUserMessageFromEvents(events),
    lastUserMessage: meta.lastUserMessage ?? lastUserMessageFromEvents(events),
    todos: extractTodoProgressFromEvents(events),
    recentDirectoriesTouched: extractRecentDirectoriesTouched(events, meta.cwd),
    ...fanOutCounts(events, meta.agent, meta.filePath),
  };
}

function enrichCachedSessionMeta(meta: SessionMeta): SessionMeta {
  if (!meta.filePath) return meta;
  try {
    const events = parseSession(meta.filePath, meta.agent);
    writeResourceUsage(meta.id, events, meta.cwd);
    return enrichMetaFromEvents(meta, events);
  } catch {
    return meta;
  }
}

const SESSION_TEXT_ROWID = `(SELECT rowid FROM sessions WHERE id = ?)`;

const deleteTextStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`);
const insertTextStmt = (db: Database.Database) =>
  db.prepare(`INSERT INTO session_text (rowid, session_id, label, topic, project, content, assistant) VALUES (${SESSION_TEXT_ROWID}, ?, ?, ?, ?, ?, ?)`);
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

function storedFtsLabel(readLabel: Database.Statement<unknown[]>, id: string): string {
  const row = readLabel.get(id) as { label: string | null } | undefined;
  return row?.label ?? '';
}

function resolveMachine(meta: SessionMeta): string {
  if (meta.machine && meta.machine.trim()) return meta.machine.trim();
  return machineForSessionFile(meta.filePath, meta.agent);
}

export function upsertSession(meta: SessionMeta, content: string, scan?: ScanStamp, assistantContent = ''): void {
  meta = enrichCachedSessionMeta(meta);
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
      storedFtsLabel(readLabel, meta.id),
      meta.topic ?? '',
      meta.project ?? '',
      content ?? '',
      assistantContent ?? '',
    );
  });
  txn();
}

function reconcileCodexFileOwners(db: Database.Database, metas: SessionMeta[]): void {
  const owners = new Map(metas.filter(meta => meta.agent === 'codex' && meta.filePath).map(meta => [meta.filePath, meta.id]));
  const paths = [...owners.keys()];
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const rows = db.prepare(`SELECT id, file_path FROM sessions WHERE agent = 'codex' AND file_path IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as Array<{ id: string; file_path: string }>;
    for (const row of rows) {
      if (owners.get(row.file_path) === row.id) continue;
      db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`).run(row.id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      for (const table of ['session_preview_cache', 'session_summaries', 'session_insights', 'session_topics', 'session_phenotypes', 'session_resource_usage', 'resource_scan_ledger']) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(row.id);
      }
      purgeToolCalls(db, row.id);
    }
  }
}

export function upsertSessionsBatch(
  entries: Array<{
    meta: SessionMeta;
    content: string;
    assistantContent?: string;
    scan?: ScanStamp;
    parserState?: string;
    contentText?: string;
    events?: SessionEvent[];
    toolCalls?: IndexedToolCall[];
    toolScan?: ScanStamp;
    toolIndexMode?: 'replace' | 'append';
    toolResume?: ToolScanResumePoint | null;
  }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const { upsert, delText, insText, readLabel } = stmts(db);
  const now = Date.now();
  const actorIndex = loadSessionActorIndex();
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

  const byPath = new Map(
    entries
      .filter(e => e.scan && e.meta.filePath)
      .map(e => [canonicalLedgerKey(e.meta.filePath), e]),
  );
  const enrichedEntries = entries.map(entry => {
    if (entry.meta.agent === 'claude' || entry.meta.agent === 'codex' || !entry.meta.filePath) {
      return entry.events
        ? { ...entry, meta: enrichMetaFromEvents(entry.meta, entry.events) }
        : entry;
    }
    const LARGE_TRANSCRIPT_AGENTS: ReadonlySet<string> = new Set(['kimi', 'grok']);
    if (!entry.events && LARGE_TRANSCRIPT_AGENTS.has(entry.meta.agent)) {
      return entry;
    }
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
      const prior = toolScan
        ? planEventToolResume(db, entry.meta.id, toolSourcePath, toolScan, events.length)
        : null;
      const scanned = scanEventToolCalls(events, prior ?? undefined);
      return {
        ...entry,
        meta: enrichMetaFromEvents(entry.meta, events),
        toolCalls: scanned.calls,
        toolScan,
        toolIndexMode: (prior ? 'append' : 'replace') as 'replace' | 'append',
        toolResume: { parserState: JSON.stringify(scanned.snapshot), parsedOffset: scanned.eventCount },
      };
    } catch {
      return entry;
    }
  });
  const writtenEntries: typeof enrichedEntries = [];

  const toolUsageBySession = queryToolUsageForSessions(
    new Set(enrichedEntries.map(e => e.meta.id)),
  );

  const txn = db.transaction((items: typeof entries) => {
    const CHUNK = 500;
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
      const toolUsage = toolUsageBySession.get(meta.id) ?? { usedBrowser: false, usedComputer: false };
      if (meta.agent === 'claude' || meta.agent === 'codex') {
        writeResourceUsageFromTallies(meta.id, meta.skillsUsed ?? [], meta.slashCommandsUsed ?? [], meta.cwd);
      }
      try {
      const row: SessionRow = {
        id: meta.id,
        short_id: meta.shortId,
        agent: meta.agent,
        harness: meta.harness ?? actorIndex.get(meta.id)?.harness ?? null,
        origin: meta.origin ?? 'cli',
        routine_name: meta.routineName ?? null,
        routine_run_id: meta.routineRunId ?? null,
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
  for (const entry of writtenEntries) {
    const toolScan = entry.toolScan ?? entry.scan;
    if (!toolScan || !entry.toolCalls) continue;
    try {
      persistToolCalls(db, entry.meta, entry.toolCalls, toolScan, {
        mode: entry.toolIndexMode ?? 'replace',
        resume: entry.toolResume,
      });
    } catch {
    }
  }
  maintainSessionSearchIndex(db);
}

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
    initiatedBy: row.initiated_by === 'human' || row.initiated_by === 'agent' ? row.initiated_by : undefined,
    phoenixId: row.phoenix_id ?? undefined,
    usedBrowser: row.used_browser === null ? undefined : row.used_browser === 1,
    usedComputer: row.used_computer === null ? undefined : row.used_computer === 1,
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

function resolveLastActivity(meta: SessionMeta, scan?: ScanStamp): string {
  if (meta.lastActivity) return meta.lastActivity;
  if (scan?.fileMtimeMs && meta.filePath) return new Date(scan.fileMtimeMs).toISOString();
  return meta.timestamp;
}

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

export function cacheLinearProject(sessionId: string, project: string, projectUrl: string): void {
  getDB().prepare(`UPDATE sessions SET linear_project = ?, linear_project_url = ? WHERE id = ?`)
    .run(project, projectUrl, sessionId);
}

export function latestSessionFileForCwd(agent: SessionAgentId, cwd: string, options?: { maxAgeMs?: number; nowMs?: number }): string | undefined {
  if (!cwd) return undefined;
  let normalized = cwd;
  try { normalized = fs.realpathSync(cwd); } catch {  }
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

  if (options.idExact) {
    where.push('(id = ? COLLATE NOCASE OR short_id = ? COLLATE NOCASE OR routine_run_id = ? COLLATE NOCASE)');
    params.push(options.idExact, options.idExact, options.idExact);
  }
  if (options.idPrefix) {
    where.push('(id LIKE ? OR short_id LIKE ? OR routine_run_id LIKE ?)');
    params.push(`${options.idPrefix}%`, `${options.idPrefix}%`, `${options.idPrefix}%`);
  }

  if (typeof options.sinceMs === 'number') {
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

interface DirectoryMembershipCacheEntry {
  mtimeMs: number;
  size: number;
  cachedAtMs: number;
  entries: Set<string>;
}

const directoryMembershipCache = new Map<string, DirectoryMembershipCacheEntry>();
let directoryMembershipSweepCount = 0;
const DIRECTORY_MTIME_SETTLE_MS = 2_000;

export function getSessionExistenceCacheStats(): { sweeps: number } {
  return { sweeps: directoryMembershipSweepCount };
}

function clearSessionExistenceCache(): void {
  directoryMembershipCache.clear();
  directoryMembershipSweepCount = 0;
}

function findMissingFilePaths(filePaths: string[]): Set<string> {
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

export function querySessions(options: QueryOptions = {}): SessionMeta[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const limitClause = options.limit
    ? `LIMIT ${Math.max(1, Math.floor(options.limit)) + 16}`
    : '';
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

export function countSessions(options: QueryOptions = {}): number {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const sql = `SELECT COUNT(*) AS n FROM sessions ${clause}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? row.n : 0;
}

interface UsageRollupRow {
  key: string;
  label?: string;
  costUsd: number;
  costUsdNoCache: number;
  durationMs: number;
  sessionCount: number;
  tokenCount: number;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function readSessionInsights<T>(ids: string[]): Map<string, T> {
  const db = getDB();
  const out = new Map<string, T>();
  if (ids.length === 0) return out;
  const CHUNK = 400;
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
      }
    }
  }
  return out;
}

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

export function clearSessionInsights(): void {
  getDB().exec(`DELETE FROM session_insights`);
}

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
      }
    }
  }
  return out;
}

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
      }
    }
  }
  return out;
}

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

export const REMOTE_PREVIEW_SCHEMA_VERSION = 1;

const REMOTE_PREVIEW_CACHE_MAX_ROWS = 500;

const REMOTE_PREVIEW_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export const REMOTE_PREVIEW_ENVELOPE_MAX_BYTES = 512 * 1024;

export interface RemotePreviewCacheRow {
  fetchedAt: number;
  ok: boolean;
  envelope?: unknown;
  failureReason?: string;
  consecutiveFailures: number;
  nextAttemptAt: number;
  lastCallerRevision?: string;
}

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

const REMOTE_PREVIEW_FAILURE_REASON_MAX_CHARS = 300;

function boundFailureReason(reason: string): string {
  return reason.length > REMOTE_PREVIEW_FAILURE_REASON_MAX_CHARS
    ? reason.slice(0, REMOTE_PREVIEW_FAILURE_REASON_MAX_CHARS) + '…'
    : reason;
}

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
    pruneRemotePreviewCache();
  });
  write();
}

export function readSessionContent(id: string): string | undefined {
  const row = getDB().prepare(
    `SELECT content FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`,
  ).get(id) as { content: string } | undefined;
  return row?.content;
}

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

export interface SessionSummaryEntry {
  goal?: string;
  checkpoints?: SessionCheckpoint[];
  summaryChecklist?: SessionChecklistItem[];
  summaryState: SummaryState;
}

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

export interface SessionTimelineProjection extends SessionGlance {
  subagents?: SessionSubagent[];
  timeline: SessionTimeline;
  request?: SessionRequest;
  files?: SessionFiles;
}

export interface SessionTimelineEntry extends SessionTimelineProjection {
  state: TimelineState;
}

export interface SessionTimelineCacheRow extends SessionTimelineEntry {
  computedAt: number;
}

function parseTimelineProjection(json: string): SessionTimelineProjection | undefined {
  try {
    return JSON.parse(json) as SessionTimelineProjection;
  } catch {
    return undefined;
  }
}

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

export function writeSessionTimeline(entry: {
  id: string;
  fileMtimeMs: number | null;
  fileSize: number | null;
  timeline: SessionTimelineEntry;
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
  generatedTitle: string | null;
  lastActivity: string | null;
  timestamp: string;
  ticketId: string | null;
  prUrl: string | null;
  summary: SessionSummaryEntry | null;
  timeline: SessionTimelineProjection | null;
}

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
    summary: readSessionSummaryAny(r.id) ?? null,
    timeline: readSessionTimelineAny(r.id) ?? null,
  }));
}

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
  generatedTitle?: string | null;
  lastActivity?: string | null;
  timestamp: string;
  ticketId?: string | null;
  prUrl?: string | null;
  summary?: SessionSummaryEntry | null;
  timeline?: SessionTimelineProjection | null;
}

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
  db.prepare(`DELETE FROM session_text WHERE rowid = ${SESSION_TEXT_ROWID}`).run(row.id);
  db.prepare(`
    INSERT INTO session_text (rowid, session_id, label, topic, project, content, assistant)
    VALUES (${SESSION_TEXT_ROWID}, ?, ?, ?, '', ?, '')
  `).run(row.id, row.id, row.label ?? '', row.topic ?? '', row.firstUser ?? '');
  if (row.summary) {
    writeSessionSummary({ id: row.id, fileMtimeMs: null, fileSize: null, summary: row.summary });
  }
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

type AffinityGroup = 'machine' | 'agent' | 'machine_agent';

export interface AffinityRow {
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
  sinceMs?: number;
  agents?: SessionAgentId[];
  onlyCli?: boolean;
  excludeTeamOrigin?: boolean;
  project?: string;
}): AffinityRow[] {
  const db = getDB();
  const where: string[] = [];
  const params: unknown[] = [];

  const sinceMs = options.sinceMs ?? (Date.now() - 14 * 24 * 60 * 60 * 1000);
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
          ? `IFNULL(NULLIF(CASE
              WHEN substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, -9, 1) = '-'
                AND length(substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, -8)) = 8
                AND substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, -8) NOT GLOB '*[^0-9]*'
              THEN substr(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END, 1,
                          length(CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END) - 9)
              ELSE CASE WHEN model LIKE 'claude-%' THEN substr(model, 8) ELSE model END
            END, ''), '(unknown)')`
        : options.groupBy === 'account'
          ? `IFNULL(NULLIF(account_key, ''), 'unattributed:' || agent)`
          : `substr(timestamp, 1, 10)`;

  const sql = `
    SELECT
      ${keyExpr} AS key,
      ${options.groupBy === 'account'
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

export interface ResourceStatRow {
  kind: string;
  name: string;
  plugin: string | null;
  source: string | null;
  sessions: number;
  invocations: number;
}

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

export function resourceUsageCoverage(): { covered: number; scanned: number; total: number } {
  const db = getDB();
  const covered = (db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM session_resource_usage`).get() as { n: number }).n;
  const scanned = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM resource_scan_ledger l
    JOIN sessions s ON s.id = l.session_id
    WHERE l.extractor_version = ?
  `).get(RESOURCE_INDEX_VERSION) as { n: number }).n;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  return { covered, scanned, total };
}

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

interface ResourceBackfillResult {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  resourceRows: number;
}

export function backfillResourceUsage(
  filter: QueryOptions = {},
  onProgress?: (done: number, total: number) => void,
): ResourceBackfillResult {
  const db = getDB();
  const sessions = querySessions({ ...filter, limit: undefined });
  const result: ResourceBackfillResult = { scanned: 0, updated: 0, skipped: 0, failed: 0, resourceRows: 0 };
  let done = 0;
  for (const meta of sessions) {
    if (!meta.filePath) { done++; onProgress?.(done, sessions.length); continue; }
    result.scanned++;
    let stamp: { fileMtimeMs: number; fileSize: number };
    try {
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

export interface TeamSpawner {
  sessionId: string;
  shortId: string;
  actor?: string;
}

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

interface TopCostSession {
  meta: SessionMeta;
  costUsd: number;
  durationMs: number;
}

export function topSessionsByCost(
  n: number,
  options: QueryOptions = {},
): TopCostSession[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const whereCost = clause ? `${clause} AND cost_usd IS NOT NULL` : 'WHERE cost_usd IS NOT NULL';
  const limit = Math.max(1, Math.floor(n));
  const sql = `SELECT * FROM sessions ${whereCost} ORDER BY cost_usd DESC, timestamp DESC LIMIT ${limit + 16}`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
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

export function findSessionMachinesByIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return out;
  try {
    const db = getDB();
    const CHUNK = 500;
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const batch = uniq.slice(i, i + CHUNK);
      const placeholders = batch.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, machine FROM sessions WHERE id IN (${placeholders})`)
        .all(...batch) as Array<{ id: string; machine: string | null }>;
      for (const r of rows) if (r.machine) out.set(r.id, r.machine);
    }
  } catch {
  }
  return out;
}

export function getSessionById(id: string): SessionMeta | null {
  const db = getDB();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  return row ? rowToMeta(row) : null;
}

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

export function resolveFullSessionId(idOrCrumb: string | undefined): string | undefined {
  const id = idOrCrumb?.trim();
  if (!id) return undefined;
  if (!/^[0-9a-f]{8}$/i.test(id)) return id;
  const hit = findSessionsByShortIds([id]).get(id.toLowerCase());
  return hit?.id ?? id;
}

export function findSessionsByShortIds(shortIds: string[]): Map<string, SessionMeta> {
  const out = new Map<string, SessionMeta>();
  const uniq = [...new Set(shortIds.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (uniq.length === 0) return out;
  const db = getDB();
  const CHUNK = 500;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    const placeholders = batch.map(() => '?').join(',');
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

interface FtsHit {
  sessionId: string;
  score: number;
  matchedTerms: string[];
  snippet?: string;
}

export function buildFtsQuery(input: string): { expr: string; terms: string[] } {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (terms.length === 0) return { expr: '', terms: [] };
  const expr = terms.map(t => `${t}*`).join(' OR ');
  return { expr, terms };
}

function buildLabelFtsQuery(input: string): string {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 1);
  if (terms.length === 0) return '';
  return `label:(${terms.map(t => `${t}*`).join(' OR ')})`;
}

export function ftsSearch(input: string, limit = 200): FtsHit[] {
  const db = getDB();
  const trimmed = input.trim();
  if (!trimmed) return [];

  const { expr, terms } = buildFtsQuery(input);
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();
  const hits: FtsHit[] = [];

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
    hits.push({ sessionId: row.id, score, matchedTerms: [] });
    seen.add(row.id);
  }

  if (hasExactLabelMatch) {
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

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
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

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

export function updateSessionFilePaths(oldPrefix: string, newPrefix: string): number {
  return reindexMovedSessionPaths([{ from: oldPrefix, to: newPrefix }]);
}

export function countSessionsWithFilePrefix(prefix: string): number {
  if (!prefix) return 0;
  const row = getDB()
    .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE file_path LIKE ?`)
    .get(prefix + '%') as { c: number };
  return row.c;
}


interface BrowserCaptureCounts {
  screenshot: number;
  pdf: number;
  recording: number;
  download: number;
}

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

export function getBrowserSessionRecord(profile: string, task: string): StoredBrowserSession | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT * FROM browser_sessions WHERE profile = ? AND task = ?`)
    .get(profile, task) as BrowserSessionRow | undefined;
  return row ? toStoredBrowserSession(row) : null;
}

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

const TOOL_SESSION_MAX_AGE_DAYS = 365;
const TOOL_SESSION_LIST_LIMIT = 2000;

export function pruneToolSessions(maxAgeDays: number = TOOL_SESSION_MAX_AGE_DAYS): number {
  const db = getDB();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

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

export function listComputerSessionRecords(
  opts: { limit?: number; startedBeforeMs?: number } = {},
): StoredComputerSession[] {
  const db = getDB();
  const limit = opts.limit ?? TOOL_SESSION_LIST_LIMIT;
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
