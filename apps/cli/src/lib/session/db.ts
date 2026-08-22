/**
 * SQLite-backed session index and full-text search.
 *
 * Stores session metadata and user-prompt text in a WAL-mode SQLite database
 * at ~/.agents/.history/sessions/sessions.db. Provides incremental upsert, scan-stamp
 * ledger (mtime/size tracking to skip unchanged files), FTS5 search with
 * BM25 ranking, and label-first search for /rename'd sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import type { SessionAgentId, SessionEvent, SessionMeta, SessionRunMode } from './types.js';
import { parseSession, sessionFilePathContainer } from './parse.js';
import { extractRecentDirectoriesTouched, extractTodoProgressFromEvents } from './state.js';
import { getSessionsDir, getSessionsDbPath } from '../state.js';
import { query as queryEvents, queryToolUsageForSessions } from '../feed/events.js';
import { machineForSessionFile } from '../origin-machine.js';
import { loadSessionActorIndex, readSessionActorRecord } from './actor-sidecar.js';
import { toolCallsFromEvents, type IndexedToolCall } from './tool-calls.js';
import { persistToolCalls, toolEvidenceSourcePath } from './tool-store.js';
import { buildClaudeAccountIndex, resolveClaudeAccount } from './claude-accounts.js';
import { extractSkills, extractSlashCommands } from './highlights.js';
import { resolveResource } from '../resources.js';
import { discoverPlugins } from '../plugins/plugins.js';
import { machineId } from '../machine-id.js';
import type { DiscoveredPlugin } from '../types.js';

const SESSIONS_DIR = getSessionsDir();
const DB_PATH = getSessionsDbPath();

/** Current schema version; bumped when migrations are added. Exported so tests
 * assert against the constant instead of hardcoding a number that every bump
 * then has to chase (docs/sessions.md calls the constant the source of truth). */
export const SCHEMA_VERSION = 39;

/**
 * Bump to force `agents sessions backfill resources` to re-derive every
 * session's skill/slash-command tallies on its next run (resource_scan_ledger
 * rows with a lower version are treated as stale — the same mechanism
 * TOOL_INDEX_VERSION gives the tool backfill).
 */
const RESOURCE_INDEX_VERSION = 1;

/**
 * Canonicalize a file path for use as a scan_ledger key. The same physical
 * session file is reachable via multiple aliases — `~/.claude/projects/x.jsonl`
 * (when `~/.claude` is a symlink to a versioned home) and
 * `~/.agents/versions/claude/<v>/home/.claude/projects/x.jsonl`. Keying the
 * ledger by the raw path means switching between these aliases (e.g. via
 * `agents use`) misses the cache and forces a full re-parse. Realpath collapses
 * all aliases to one stable key.
 */
function canonicalLedgerKey(filePath: string): string {
  if (!filePath) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

// BM25 column weights for session_text: label > topic > project > content.
// Higher weights make matches in that column rank higher.
/** BM25 column weights for FTS5: label > topic > project > content. */
const BM25_WEIGHTS = [5.0, 2.0, 1.5, 1.0] as const;

/** DDL for the sessions database (tables, indexes, FTS5 virtual table). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  origin TEXT DEFAULT 'cli',
  routine_name TEXT,
  routine_run_id TEXT,
  version TEXT,
  account TEXT,
  account_key TEXT,
  account_org TEXT,
  mode TEXT,
  timestamp TEXT NOT NULL,
  last_activity TEXT,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  topic TEXT,
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
  plan TEXT,
  machine TEXT,
  todos TEXT,
  recent_directories_touched TEXT,
  linear_project TEXT,
  linear_project_url TEXT,
  actor TEXT,
  initiated_by TEXT,
  used_browser INTEGER,
  used_computer INTEGER,
  -- Epoch ms of the first time a previously-scanned transcript was confirmed
  -- gone from disk while its user-turn content still lives in session_text
  -- (RUSH-2436). Non-NULL means "archived": the row is served/rendered from the
  -- DB and flagged, instead of being dropped when the file vanishes. A row whose
  -- file is missing but which has NO cached content is a phantom (a stale/moved
  -- file_path), never stamped, still suppressed — see querySessions.
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_file_path ON sessions(file_path);
CREATE INDEX IF NOT EXISTS idx_sessions_short_id ON sessions(short_id);
-- idx_sessions_machine_ts / idx_sessions_agent_ts are created after migration
-- v17 guarantees the machine column exists (same pattern as last_activity).

CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
  session_id UNINDEXED,
  label,
  topic,
  project,
  content,
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
  content_text TEXT
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
-- Keyed on invocation_id, the id emitComputerAction stamps once per emitting CLI
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
`;

/**
 * Bumping this invalidates every cached facet row without touching the schema
 * version, so a change to the extraction logic (a new metric, a corrected bucket)
 * re-derives on the next `agents insights` instead of silently reporting stale
 * numbers alongside fresh ones. Same role as RESOURCE_INDEX_VERSION.
 */
/** Bump when facet extraction changes so cached rows recompute (stalls-by-model v6). */
export const INSIGHTS_EXTRACTOR_VERSION = 6;
const PREVIEW_EXTRACTOR_VERSION = 1;

/** Raw row shape returned from the sessions table. */
interface SessionRow {
  id: string;
  short_id: string;
  agent: string;
  origin: string | null;
  routine_name: string | null;
  routine_run_id: string | null;
  version: string | null;
  account: string | null;
  account_key: string | null;
  account_org: string | null;
  mode: string | null;
  timestamp: string;
  last_activity: string | null;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  topic: string | null;
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
  plan: string | null;
  machine: string | null;
  todos: string | null;
  recent_directories_touched: string | null;
  linear_project: string | null;
  linear_project_url: string | null;
  actor: string | null;
  initiated_by: string | null;
  /** NULL means "not yet computed" (a row scanned before this field existed) — see rowToMeta. */
  used_browser: number | null;
  used_computer: number | null;
  /**
   * Epoch ms the transcript file was first confirmed gone while content survived
   * (RUSH-2436); NULL = live/never archived. Optional because the scanner upsert
   * write-payload never sets it — the INSERT column list omits it, so a rescan
   * preserves the sticky stamp; it is written only by querySessions.
   */
  archived_at?: number | null;
}

/** File stat snapshot used to detect changes between scan runs. */
export interface ScanStamp {
  fileMtimeMs: number;
  fileSize: number;
  scannedAt?: number;
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
  /**
   * Column to order by, all descending. 'timestamp' (default) sorts newest
   * first; 'cost' and 'duration' put the priciest / longest sessions on top,
   * with NULLs sorted last so unpriced rows never crowd out real data.
   */
  sortBy?: 'timestamp' | 'cost' | 'duration';
  /** Internal warm-cache path; callers must validate the small final result set. */
  skipExistenceCheck?: boolean;
  /**
   * Only sessions that invoked this skill (#12), joined against
   * session_resource_usage.kind='skill'. Matches either the full stored name
   * (bare, or `plugin:name` for a plugin skill) or just the short name after
   * the colon — `--skill design` finds a session that used `rush:design`.
   */
  skill?: string;
  /**
   * Only sessions that used a skill or slash-command owned by this plugin
   * (#12), joined against session_resource_usage.plugin.
   */
  plugin?: string;
}

let dbInstance: Database.Database | null = null;

/**
 * Apply schema migrations from `fromVersion` → SCHEMA_VERSION. The new
 * `CREATE IF NOT EXISTS` at SCHEMA doesn't help when column sets or FTS
 * column definitions change — those need explicit migration here.
 */
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
    // v4 → v5: ledger is now keyed by realpath instead of the as-discovered
    // path, so symlink/version-relative aliases for the same physical file
    // collapse to one row. Old aliased rows are dropped — next scan will
    // repopulate under canonical keys.
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
    // v7 → v8: the listing now sorts and labels by last-activity (last message
    // time) instead of creation time. Add the column, seed it to `timestamp` so
    // no row sorts as NULL before the rescan lands, then force a full rescan so
    // every session gets its true last_activity (from lastTsMs) repopulated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'last_activity')) db.exec(`ALTER TABLE sessions ADD COLUMN last_activity TEXT`);
    db.exec(`UPDATE sessions SET last_activity = timestamp WHERE last_activity IS NULL`);
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 9) {
    // v8 → v9: `agents run --name <slug>` gives a run a durable launch handle,
    // resolvable via `agents sessions <name>`. Additive column; NO rescan — the
    // name is set at run time (host sidecar / run-name sidecar), not parsed from
    // transcripts, so existing rows stay valid with a NULL name.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'name')) db.exec(`ALTER TABLE sessions ADD COLUMN name TEXT`);
  }
  if (fromVersion < 10) {
    // v9 → v10: `name` and `label` unify into a single `label`. `--name` now
    // SEEDS the label at launch (refined later by an agent-generated title)
    // instead of living in a separate immutable `name` column. Fold any existing
    // name into label where the label is empty, mirror it into the FTS row, then
    // drop the redundant column. Seeds re-apply from the run-name sidecars every
    // scan (seedLabelsFromNames), so no rescan is required.
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
    // v10 → v11: the Claude scanner now captures the ExitPlanMode plan markdown
    // at scan time so `agents sessions --json` can surface it without forcing
    // consumers (the Factory NEEDS-YOU panel) to re-read raw JSONL. Additive
    // column; rescan to backfill.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'plan')) db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 12) {
    // v11 → v12: `output_tokens` — the real generated-token count, kept separate
    // from `token_count` (which sums cache-read/-write and so is dominated by
    // cheap re-counted context). This is the honest "output" metric powering
    // `agents insights output`. Additive column; rescan to backfill from transcripts.
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
    // v13 → v14: the discovery scan now short-circuits the readdir + per-file
    // stat of leaf transcript dirs whose (mtime, entry_count) is unchanged,
    // caching that snapshot in the new `dir_ledger` table. Create it, and clear
    // scan_ledger so the first post-upgrade scan does a clean full walk — that
    // walk seeds BOTH ledgers correctly, so a cold/empty dir_ledger degrades to
    // today's full behavior.
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
    // v14 → v15: the Claude scan becomes resumable (B-1). scan_ledger gains a
    // `parser_state` continuation blob (offset + accumulator snapshot) and a
    // `content_text` cache of the accumulated user doc. Add both columns, then
    // clear scan_ledger so the first post-upgrade scan does a clean full walk
    // that reseeds the cursor from byte 0.
    const cols = db.prepare(`PRAGMA table_info(scan_ledger)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'parser_state')) db.exec(`ALTER TABLE scan_ledger ADD COLUMN parser_state TEXT`);
    if (!cols.some(c => c.name === 'content_text')) db.exec(`ALTER TABLE scan_ledger ADD COLUMN content_text TEXT`);
    db.exec(`DELETE FROM scan_ledger;`);
  }

  if (fromVersion < 16) {
    // v15 → v16: repair rows poisoned by the empty-shortId bug (now fixed at the
    // source in deriveShortId). A session id that was only a known prefix — a bare
    // `session_` dir, an id of exactly `api-` or `ses_` — derived to '' via
    // `id.replace(prefix, '').slice(0, 8)`, passed the `short_id TEXT NOT NULL`
    // column (empty string is not NULL), yet matched nothing in the
    // `short_id LIKE ?` picker lookups. The parser no longer produces '', but
    // existing rows don't self-heal: an empty short_id is not re-parsed unless its
    // file changes, and an orphaned row (file gone) never re-parses at all. Repair
    // in place — `substr(id, 1, 8)` is non-empty because `id` is the non-empty
    // primary key — so every corrupt row becomes addressable. No rescan needed.
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
    // v18 → v19: actor provenance (RUSH-2018) — who initiated the session and
    // the actor's kind. Populated at write time from the resolved actor (the
    // pid-registry/spawn path), not derivable from the transcript, so there is
    // no ledger wipe here: a rescan can't backfill these, and forcing a full
    // re-parse would be pure churn. Existing rows stay NULL until re-created.
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
    // v20 → v21: persist the team a session SPAWNED (`agents teams create/add`).
    // The value was already derived at scan time (discover.ts detectSpawnedTeam)
    // and set on SessionMeta, but had no column — so it was dropped at the write
    // and no consumer ever saw it. Wipe BOTH ledgers, not just scan_ledger: with
    // dir_ledger intact, collectChangedFilesInLeafDirs treats every non-live-root
    // dir as unchanged and derives its hot set from the scan stamps just deleted,
    // so archived dirs would never be re-parsed and would stay NULL forever.
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
    // v22 → v23: persist usedBrowser/usedComputer (#11) so the sessions picker
    // preview can trust a positive detection instead of re-deriving it from a
    // transcript regex on every render. Computed from a sessionId-scoped read
    // of the events log (see detectToolUsage), not from the parsed transcript,
    // so no ledger wipe is needed here — a rescan re-derives them regardless.
    //
    // Deliberately NO DEFAULT (NULL on ALTER, for every pre-existing row):
    // NULL means "not yet computed by this scanner" (a legacy row), distinct
    // from a real, computed 0/false.
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
    // v26 → v27: the original unicode word tokenizer could not prefilter the
    // substring semantics promised by input/output/error queries. Rebuild only
    // the derived FTS table from already-redacted call rows; transcripts and
    // both scan ledgers remain warm.
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
    // v30 → v31: independent ledger for the explicit resource-usage backfill
    // (agents sessions backfill resources). Do NOT wipe scan_ledger — normal
    // session listing stays warm; historical resource rows are filled once on
    // demand, exactly like the tool-index ledger (v25).
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
    // v32 → v33: attribute each Claude session to the account that produced it.
    // Until now `account` held ONE email resolved process-globally and stamped on
    // every row of a scan, so a machine with several signed-in accounts reported all
    // of its history under whichever resolved first.
    //
    // Do NOT wipe scan_ledger. Attribution is a pure function of (file_path,
    // version) — both already stored — so existing rows are repaired in place with
    // no transcript re-parsed. Adding `DELETE FROM scan_ledger` here to match the
    // other migrations would force a full re-parse of every indexed transcript to
    // recompute something derivable from two columns. The v31 migration sets the
    // same precedent.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    if (!cols.has('account_key')) db.exec(`ALTER TABLE sessions ADD COLUMN account_key TEXT`);
    if (!cols.has('account_org')) db.exec(`ALTER TABLE sessions ADD COLUMN account_org TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_account_key ON sessions(account_key)`);
    backfillClaudeAccounts(db);
  }

  if (fromVersion < 34) {
    // v33 -> v34: claude-opus-5 and claude-sonnet-5 were missing from the pricing
    // table. `getModelPricing` matches on a dash-bounded prefix, so neither could fall
    // back to its Claude 4 entry: both resolved to null and every session using them
    // priced to $0 -- silently, because an unpriced model contributes nothing rather
    // than raising. On one real index that was 526 sessions, 478 of them the current
    // default model.
    //
    // Adding the prices alone fixes nothing already indexed: cost_usd is computed at
    // scan time, and the scanner skips any transcript whose (file_mtime_ms, file_size)
    // is unchanged. Nor can those rows be repaired in place -- the row stores
    // token_count and output_tokens, not the uncached-input / cache-read / cache-write
    // split the price table needs -- so the figure has to come from re-reading the
    // transcript.
    //
    // Flush ONLY the affected transcripts, not the whole ledger. A blanket
    // `DELETE FROM scan_ledger` (what v5 -> v6 did when cost was introduced) would
    // re-parse every session on the next scan and break the contract the other
    // migrations here are tested against: adding a column must not invalidate warm
    // session ledgers. Scoping it to the rows that actually mispriced keeps every
    // other ledger entry warm and still guarantees the numbers correct themselves.
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
    // v34 -> v35: the default listing sort was `ORDER BY IFNULL(last_activity,
    // timestamp) DESC` — wrapping the column in IFNULL() makes SQLite unable to
    // satisfy it from idx_sessions_last_activity, so every list/resume query did
    // a full table sort instead of an index walk (RUSH-2211). Every upsert path
    // already writes a non-NULL last_activity (resolveLastActivity falls back to
    // `timestamp`, itself NOT NULL) — the only rows that can still be NULL here
    // are ones written before the v8 migration that somehow slipped the backfill,
    // or seeded directly by a test. Backfill them so the column is unconditionally
    // NOT NULL, then querySessions can sort on the bare column and use the index.
    db.exec(`UPDATE sessions SET last_activity = timestamp WHERE last_activity IS NULL`);
  }

  if (fromVersion < 36) {
    // v35 -> v36: make the tool index incremental, and stop paying a full FTS
    // scan per deleted call.
    //
    // (a) tool_scan_ledger gains a resume point (parser_state + parsed_offset).
    //     Existing rows get NULLs, which read as "no resume point": the next
    //     scan of each session re-reads it once from byte 0 and records a resume
    //     point, so every scan after that is incremental. No ledger is wiped.
    //
    // (b) tool_call_text is rebuilt so its rowid mirrors tool_calls.rowid. The
    //     old rows were inserted with FTS5-assigned rowids and are only
    //     addressable by the UNINDEXED call_key, i.e. a full index scan per
    //     delete. There is no ALTER for that, and the rowids cannot be repaired
    //     in place, so the table is dropped and repopulated from tool_calls --
    //     the same non-destructive derived-table rebuild v27 did (the source of
    //     truth is tool_calls, which is untouched). The rebuild also lands the
    //     content as one merged segment, which is the compaction
    //     optimizeSessionSearchIndex would otherwise have to do afterwards.
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
    // v36 -> v37: persist the burn SPLIT (uncached input / cache-read /
    // cache-write) and a second "no-cache" cost per session, so `agents insights output`
    // can report the token split and a --pricing no-cache scenario (RUSH-2287).
    // These are new nullable columns — do NOT flush scan_ledger (adding a column
    // must keep warm session ledgers warm, the contract the v33->v34 note above
    // states). Pre-upgrade rows stay NULL for the split until their transcript is
    // re-scanned; `agents insights output` reports the split only where it is present, so
    // an absent split reads as "not available for this session", never as zero.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('input_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER`);
    if (!cols.has('cache_read_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER`);
    if (!cols.has('cache_write_tokens')) db.exec(`ALTER TABLE sessions ADD COLUMN cache_write_tokens INTEGER`);
    if (!cols.has('cost_usd_nocache')) db.exec(`ALTER TABLE sessions ADD COLUMN cost_usd_nocache REAL`);
  }

  if (fromVersion < 38) {
    // v37 -> v38: archived_at (RUSH-2436). Makes the local DB authoritative for
    // content: a session whose transcript file is gone but whose user turns still
    // live in session_text is kept (flagged archived) instead of dropped from
    // listings. New nullable column, so no ledger flush — it is populated lazily
    // by querySessions the first time it confirms a scanned file is gone.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'archived_at')) db.exec(`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`);
  }

  if (fromVersion < 39) {
    // v38 -> v39: durable tool-session metadata (RUSH-2549). Browser task identity
    // lived only in the daemon's tasks.json, which is rewritten from the live task
    // map -- so stopping a task erased the link to the agent session that drove it
    // and every finished task listed as "unlinked". Computer-use had the identity
    // right but wrote it to the 7-day event ledger, so its history expired instead.
    // Both now persist metadata here. Pure additions, so no ledger flush: nothing
    // already indexed is invalidated, and the tables populate going forward.
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
}

/**
 * Stamp `account_key` / `account_org` / `account` on every Claude row from its
 * `file_path` and recorded `version`. Used by the v33 migration; idempotent, so it is
 * safe to re-run.
 */
function backfillClaudeAccounts(
  db: Database.Database,
  scope: 'all' | 'unresolved' = 'all',
): void {
  // 'unresolved' exists so the getDB repair touches ONLY rows that are actually
  // broken. Re-resolving every Claude row on an unrelated trigger would silently
  // downgrade a correct row whose version home has since been uninstalled and its
  // trash snapshot pruned — the row would go from attributed to dark for no reason
  // the user caused. The migration wants 'all'; the repair does not.
  const where = scope === 'all'
    ? `agent = 'claude'`
    : `agent = 'claude' AND (account_key IS NULL
         OR (account_key LIKE 'unattributed:%' AND account IS NOT NULL))`;
  const index = buildClaudeAccountIndex();
  const rows = db.prepare(
    `SELECT id, file_path, version FROM sessions WHERE ${where}`,
  ).all() as Array<{ id: string; file_path: string; version: string | null }>;
  if (rows.length === 0) return;

  // `account` is overwritten, not COALESCEd. Every pre-v33 row carries the wrong
  // globally-resolved email; keeping it on a row we could not attribute would leave a
  // known-false address on display (commands/sessions.ts prints it, and its fuzzy
  // matcher scores on it) and would disagree with the scan path, which writes
  // `account = excluded.account` unconditionally. A dark row reads NULL.
  const update = db.prepare(
    `UPDATE sessions SET account_key = ?, account_org = ?, account = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const bucket = resolveClaudeAccount(index, row.file_path ?? '', row.version);
    update.run(bucket.key, bucket.orgName, bucket.email, row.id);
  }
}

/** Open (or return the cached) sessions database, applying migrations as needed. */
export function getDB(): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  // Wait up to 30s instead of failing immediately on SQLITE_BUSY. Install the
  // handler before journal_mode: concurrent first opens can race for its schema
  // lock, before a later busy_timeout would have a chance to wait. Multiple
  // agents (CLIs, skills, hooks) open this DB concurrently. The first scan of
  // a new version home can take longer than 10s; concurrent callers need enough
  // headroom to wait. The ledger-recheck in upsertSessionsBatch makes
  // subsequent writers near-instant, so 30s is a rarely-reached safety net.
  db.pragma('busy_timeout = 30000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.exec(SCHEMA);

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

  // Index last_activity only after the column is guaranteed to exist — fresh DBs
  // get it from CREATE TABLE above, existing pre-v8 DBs from the migration just
  // run. It must NOT live in SCHEMA (executed before migration) or an existing
  // DB would fail the index build on a column it doesn't have yet.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_origin ON sessions(origin)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_routine_run_id ON sessions(routine_run_id)`);
  // Account attribution repair. Two ways a Claude row ends up wrong even at v33:
  // an older CLI (whose INSERT does not name the column) writes NULL, and a DB
  // migrated by a build that predates the "clear the stale email on a dark row" fix
  // keeps a known-wrong address. The v33 migration cannot fix either — it never runs
  // again. Cheap guard first so the common case is one indexed lookup, then repair.
  // Same shape as the `machine` repair below, for the same reason.
  {
    // Column guard FIRST, like the `machine` repair below. schema_version can be
    // stamped at SCHEMA_VERSION without the column existing — getDB writes the marker
    // for any DB whose meta has no row (a hand-built or partially-created index), and
    // migrateSchema never runs in that path. Querying account_key unguarded would
    // then throw "no such column" and take down every command that opens the index.
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

  dbInstance = db;
  return db;
}

/** Close the cached database connection. */
export function closeDB(): void {
  clearSessionExistenceCache();
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    // Closing the connection finalizes every prepared statement it owns. Drop
    // the cached upsert/FTS statements too, so the next getDB() rebuilds them
    // against the fresh connection instead of re-running a finalized statement
    // (which throws "statement has been finalized" on the first upsert).
    cachedStmts = {};
  }
}

interface FtsOptimizeResult {
  table: string;
  segmentsBefore: number;
  segmentsAfter: number;
}

/**
 * Compact the session + tool-call full-text-search indexes.
 *
 * FTS5 appends a new segment on every insert and leaves a tombstone on every
 * delete. The scanner delete+inserts a session's docs on each rescan (and on
 * every extractor-version bump), and FTS5 never merges those segments on its
 * own — so `tool_call_text_data` / `session_text_data` accumulate hundreds of
 * thousands of unmerged segments, gigabytes of index for tens of MB of content,
 * and `agents sessions` queries slow to a crawl. The FTS5 `'optimize'` command
 * merges every segment into one and purges tombstones. Non-destructive: no
 * searchable content is lost. Reclaimed space becomes reusable free pages inside
 * the DB file; run VACUUM (with the daemon stopped) to return it to the OS.
 */
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

/**
 * Segment count above which a scan pays for a slice of merge work. Below it the
 * index is small enough that querying it is not the bottleneck and merging is
 * pure overhead on every scan.
 */
const FTS_MAINTENANCE_SEGMENT_THRESHOLD = 512;

/**
 * Page budget for one incremental merge. FTS5's `'merge'` command does at most
 * this much work and returns — it is not `'optimize'`, which merges the whole
 * index in one unbounded pass. That bound is why this can run on the scan path:
 * the cost per scan is fixed, and repeated scans converge the index instead of
 * one scan stalling on a multi-gigabyte compaction.
 */
const FTS_MAINTENANCE_MERGE_PAGES = 64;

/**
 * Keep the FTS indexes from degrading on the normal scan path.
 *
 * `optimizeSessionSearchIndex` is the full, unbounded compaction behind
 * `agents sessions optimize`. Leaving it as the ONLY compaction meant the index
 * degraded until a human happened to run that command, which is how
 * `tool_call_text_data` reached gigabytes for tens of MB of content. This is the
 * automatic counterpart: bounded, threshold-gated, and safe to call after every
 * batch of writes. Non-destructive — merging never changes what is searchable.
 *
 * Returns one result per table it actually merged (empty when every table is
 * under the threshold, which is the common case on a warm index).
 */
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

/**
 * Try to claim the right to run the incremental scan. Returns true if this
 * process should proceed with scanning, false if another live process is
 * already scanning (caller should skip the scan and serve from the DB).
 *
 * Uses the `meta` table so it survives crashes — dead PIDs are detected via
 * process.kill(pid, 0), stale entries via TTL. No external lock files needed.
 *
 * Wrapped in db.transaction() (BEGIN IMMEDIATE) so the read-then-write is
 * atomic and busy_timeout retries correctly — bare auto-commit DML in WAL
 * mode can return SQLITE_BUSY_SNAPSHOT which bypasses the busy handler.
 */
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

/**
 * Read-only probe: is a scan in progress right now, held by a LIVE process
 * within the TTL? (RUSH-2682). Unlike {@link tryClaimScan} it never writes, so a
 * caller that lost the claim can wait for the in-flight scan to finish rather
 * than returning the pre-scan DB snapshot as if it were the answer. Returns
 * false for a dead-PID or expired claim — that scan is not actually running.
 */
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

/**
 * Release the scan claim written by tryClaimScan. Only deletes the entry
 * if it still belongs to this process (guards against TTL takeovers).
 */
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

/**
 * Look up the file stat stamp we stored the last time we scanned a given file path.
 * Callers compare this to the current fs.stat to decide whether to rescan.
 */
export function getScanStampByPath(filePath: string): ScanStamp | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT file_mtime_ms, file_size, scanned_at FROM scan_ledger WHERE file_path = ? LIMIT 1`)
    .get(canonicalLedgerKey(filePath)) as { file_mtime_ms: number; file_size: number; scanned_at: number } | undefined;
  return row ? { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, scannedAt: row.scanned_at } : null;
}

/**
 * Bulk-load the stamp ledger for a set of file paths in a single SQL query.
 * This is the fast path used by the incremental scanner — avoids N+1 queries.
 */
export function getScanStampsForPaths(filePaths: string[]): Map<string, ScanStamp> {
  const result = new Map<string, ScanStamp>();
  if (filePaths.length === 0) return result;
  const db = getDB();

  // Multiple input paths can resolve to the same canonical key (e.g. the same
  // session JSONL reachable via `~/.claude/...` and `~/.agents/versions/...`).
  // We query DB by canonical key, then fan results back out to every original
  // alias so callers can `.get(filePath)` with the path they passed in.
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
        SELECT file_path, file_mtime_ms, file_size, scanned_at
        FROM scan_ledger
        WHERE file_path IN (${placeholders})
      `)
      .all(...chunk) as Array<{ file_path: string; file_mtime_ms: number; file_size: number; scanned_at: number }>;

    for (const row of rows) {
      const stamp = { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, scannedAt: row.scanned_at };
      for (const original of canonicalToOriginals.get(row.file_path) || []) {
        result.set(original, stamp);
      }
    }
  }
  return result;
}

/**
 * A file's persisted resumable-parse continuation, read back from scan_ledger.
 * `parserState` is the serialized {@link ClaudeParserState} JSON blob (offset +
 * accumulator snapshot); `contentText` is the accumulated user doc. Both are
 * written by the Claude scan (B-2) and consumed on the next scan to decide
 * full-vs-incremental and to hydrate the resume.
 */
interface ParserStateRow {
  parserState: string | null;
  contentText: string | null;
  fileMtimeMs: number;
  fileSize: number;
  scannedAt: number;
}

/**
 * Bulk-load the resumable-parse continuation (parser_state + content_text) plus
 * the stamp for a set of file paths in a single chunked query. Mirrors
 * {@link getScanStampsForPaths}: keys by canonical path and fans results back to
 * every original alias so callers can `.get(filePath)` with the path they passed.
 * The Claude incremental scan uses this to fetch each changed file's prior
 * continuation without an N+1 of {@link getScanStampByPath}.
 */
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
        SELECT file_path, file_mtime_ms, file_size, scanned_at, parser_state, content_text
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
      }>;

    for (const row of rows) {
      const state: ParserStateRow = {
        parserState: row.parser_state,
        contentText: row.content_text,
        fileMtimeMs: row.file_mtime_ms,
        fileSize: row.file_size,
        scannedAt: row.scanned_at,
      };
      for (const original of canonicalToOriginals.get(row.file_path) || []) {
        result.set(original, state);
      }
    }
  }
  return result;
}

/**
 * Record scan stamps for files we've looked at. Covers both files that produced
 * a session and files we looked at but chose not to index (e.g. malformed).
 */
export function recordScans(entries: Array<{ filePath: string; scan: ScanStamp }>): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at
  `);
  const now = Date.now();
  const txn = db.transaction((items: typeof entries) => {
    for (const { filePath, scan } of items) {
      stmt.run(canonicalLedgerKey(filePath), scan.fileMtimeMs, scan.fileSize, now);
    }
  });
  txn(entries);
}

/** Snapshot of a leaf transcript directory used to detect create/delete/rename. */
export interface DirStamp {
  dirMtimeMs: number;
  entryCount: number;
}

/**
 * Bulk-load the dir ledger for a set of leaf directories in a single SQL query.
 * Mirrors {@link getScanStampsForPaths}: keys by canonical path (so a dir
 * reachable via a symlinked version home and its realpath collapse to one row)
 * and fans the result back out to every original alias so callers can
 * `.get(dirPath)` with the path they passed in.
 */
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

/**
 * Upsert dir-scan stamps. Recorded after a full readdir of a leaf transcript
 * dir so the next scan can skip that dir when its (mtime, entry_count) is
 * unchanged. Mirrors {@link recordScans}.
 */
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
    id, short_id, agent, origin, routine_name, routine_run_id,
    version, account, account_key, account_org, mode, timestamp, last_activity,
    project, cwd, git_branch, topic, label, message_count, token_count,
    output_tokens, input_tokens, cache_read_tokens, cache_write_tokens,
    cost_usd, cost_usd_nocache, duration_ms, model, tool_call_count,
    file_path, file_mtime_ms, file_size, scanned_at, is_team_origin,
    pr_url, pr_number, worktree_slug, ticket_id, spawned_team, plan, todos,
    recent_directories_touched, linear_project, linear_project_url, machine,
    actor, initiated_by, used_browser, used_computer
  ) VALUES (
    @id, @short_id, @agent, @origin, @routine_name, @routine_run_id,
    @version, @account, @account_key, @account_org, @mode, @timestamp, @last_activity,
    @project, @cwd, @git_branch, @topic, @label, @message_count, @token_count,
    @output_tokens, @input_tokens, @cache_read_tokens, @cache_write_tokens,
    @cost_usd, @cost_usd_nocache, @duration_ms, @model, @tool_call_count,
    @file_path, @file_mtime_ms, @file_size, @scanned_at, @is_team_origin,
    @pr_url, @pr_number, @worktree_slug, @ticket_id, @spawned_team, @plan, @todos,
    @recent_directories_touched, @linear_project, @linear_project_url, @machine,
    @actor, @initiated_by, @used_browser, @used_computer
  )
  ON CONFLICT(id) DO UPDATE SET
    short_id = excluded.short_id,
    agent = excluded.agent,
    origin = excluded.origin,
    routine_name = excluded.routine_name,
    routine_run_id = excluded.routine_run_id,
    version = excluded.version,
    account = excluded.account,
    account_key = excluded.account_key,
    account_org = excluded.account_org,
    mode = COALESCE(excluded.mode, sessions.mode),
    timestamp = excluded.timestamp,
    last_activity = excluded.last_activity,
    project = excluded.project,
    cwd = excluded.cwd,
    git_branch = excluded.git_branch,
    topic = excluded.topic,
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
    initiated_by = COALESCE(sessions.initiated_by, excluded.initiated_by)
`);

/**
 * Did this session emit at least one browser/computer-automation event?
 * A scoped, sessionId-filtered read of the events log — NOT a re-scan of the
 * (potentially huge) transcript — since browser.navigate / browser.screenshot
 * / computer.action are recorded there via events.ts's emit(), keyed by the
 * same session id that is this row's `meta.id` (the provenance floor stamps
 * AGENT_SESSION_ID/AGENTS_SESSION_ID on every such event at emit time).
 *
 * Called independently of {@link enrichCachedSessionMeta} (which SKIPS
 * claude/codex entries in the batch path because their caller already parsed
 * the transcript for todos/recentDirectoriesTouched) — this never touches the
 * transcript, so it must run for every agent, every time.
 */
function detectToolUsage(sessionId: string): { usedBrowser: boolean; usedComputer: boolean } {
  const usedBrowser = queryEvents({ sessionId, eventTypes: ['browser.navigate', 'browser.screenshot'], limit: 1 }).length > 0;
  const usedComputer = queryEvents({ sessionId, eventTypes: ['computer.action'], limit: 1 }).length > 0;
  return { usedBrowser, usedComputer };
}

const deleteResourceUsageStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_resource_usage WHERE session_id = ?`);
/**
 * Named-bind shape for {@link insertResourceUsageStmt}. Declared so the two call sites
 * are type-checked: bun binds named parameters in strict mode where a MISSING key
 * throws (node binds NULL), and both call sites sit outside any per-row guard, so a
 * dropped key would abort the whole batch on the runtime the shipped binary embeds.
 */
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

/**
 * Resolve a skill/slash-command's provenance for `session_resource_usage`
 * (#12). A flat (non-namespaced) resource resolves via resolveResource()'s
 * project/user/system/extra-repo scan. A namespaced one (`plugin:name`, e.g.
 * `rush:design` — the shape both a plugin skill's `args.skill` and a plugin
 * command's SessionEvent.slashCommand carry) is plugin-owned and lives under
 * the plugin's own directory, invisible to resolveResource()'s flat scan —
 * resolved instead against the already-discovered plugin list. Neither found
 * (renamed or uninstalled since the session ran) returns all-undefined
 * rather than a stale guess.
 */
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

/**
 * Persist already-computed skill/slash-command tallies for a session (#12)
 * into `session_resource_usage`, replacing any prior rows for it (a rescan's
 * usage supersedes the old — same replace-on-upsert shape as the FTS text
 * below). `discoverPlugins()` (real I/O: manifest + directory reads) only
 * runs when there is actually a skill/command to resolve, so a session with
 * neither pays nothing beyond the DELETE.
 *
 * Split from {@link writeResourceUsage} so a caller that already has the
 * tallies (claude/codex's incremental accumulator — see
 * ClaudeParseState.skillEvents/slashCommandEvents, threaded onto
 * SessionMeta.skillsUsed/slashCommandsUsed) can write without re-parsing the
 * transcript to re-derive them.
 *
 * Deliberately NOT wrapped in its own `db.transaction()`: better-sqlite3
 * (this repo's wrapper included) does not support nested transactions, and
 * `upsertSessionsBatch` calls this from INSIDE its own outer transaction. A
 * standalone caller (enrichCachedSessionMeta, outside any transaction) still
 * gets each statement committed individually — a crash between the DELETE
 * and an INSERT self-heals on the next rescan, the same risk profile as any
 * other un-batched write in this file.
 */
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

/**
 * Persist skill/slash-command usage for a session (#12) by deriving the
 * tallies from a full parsed transcript. Used by {@link enrichCachedSessionMeta}
 * (every `upsertSession()` call, and `upsertSessionsBatch` for every harness
 * EXCEPT claude/codex, which pre-compute skillsUsed/slashCommandsUsed via
 * their incremental accumulator instead — see writeResourceUsageFromTallies
 * and the call site in upsertSessionsBatch).
 */
function writeResourceUsage(sessionId: string, events: SessionEvent[], cwd: string | undefined): void {
  writeResourceUsageFromTallies(sessionId, extractSkills(events), extractSlashCommands(events), cwd);
}

function enrichCachedSessionMeta(meta: SessionMeta): SessionMeta {
  if (!meta.filePath) return meta;
  try {
    const events = parseSession(meta.filePath, meta.agent);
    writeResourceUsage(meta.id, events, meta.cwd);
    return {
      ...meta,
      todos: extractTodoProgressFromEvents(events),
      recentDirectoriesTouched: extractRecentDirectoriesTouched(events, meta.cwd),
    };
  } catch {
    // Synthetic/cloud rows can intentionally name a transcript that is not local.
    return meta;
  }
}

const deleteTextStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_text WHERE session_id = ?`);
const insertTextStmt = (db: Database.Database) =>
  db.prepare(`INSERT INTO session_text (session_id, label, topic, project, content) VALUES (?, ?, ?, ?, ?)`);
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

/**
 * Return the label stored for a session, as text for the FTS index (never NULL).
 * Called inside the upsert transaction, AFTER the row upsert, so it reflects the
 * preserve-non-empty-label rule in the ON CONFLICT clause rather than the raw
 * incoming label.
 */
function storedFtsLabel(readLabel: Database.Statement<unknown[]>, id: string): string {
  const row = readLabel.get(id) as { label: string | null } | undefined;
  return row?.label ?? '';
}

/** Resolve origin machine for a row: prefer caller-stamped meta, else path. */
function resolveMachine(meta: SessionMeta): string {
  if (meta.machine && meta.machine.trim()) return meta.machine.trim();
  return machineForSessionFile(meta.filePath, meta.agent);
}

/**
 * Upsert a session row and replace its FTS5 content in a single transaction.
 * `content` is the tokenizable user-prompt text; pass '' to leave the row unsearchable.
 */
export function upsertSession(meta: SessionMeta, content: string, scan?: ScanStamp): void {
  meta = enrichCachedSessionMeta(meta);
  // Join the durable sessionId -> actor sidecar (RUSH-2019) when the caller
  // didn't already carry an actor, so a scanned transcript still attributes to a
  // person. The ON CONFLICT COALESCEs actor/initiated_by, so this fills a fresh
  // row AND backfills one indexed null-first (before its sidecar existed), while a
  // rescan carrying no actor still keeps the stored owner.
  const actorRec = meta.actor ? undefined : readSessionActorRecord(meta.id);
  const toolUsage = detectToolUsage(meta.id);
  const db = getDB();
  const { upsert, delText, insText, readLabel } = stmts(db);
  const row: SessionRow = {
    id: meta.id,
    short_id: meta.shortId,
    agent: meta.agent,
    origin: meta.origin ?? 'cli',
    routine_name: meta.routineName ?? null,
    routine_run_id: meta.routineRunId ?? null,
    version: meta.version ?? null,
    account: meta.account ?? null,
    account_key: meta.accountKey ?? null,
    account_org: meta.accountOrg ?? null,
    mode: meta.mode ?? actorRec?.mode ?? null,
    timestamp: meta.timestamp,
    last_activity: resolveLastActivity(meta, scan),
    project: meta.project ?? null,
    cwd: meta.cwd ?? null,
    git_branch: meta.gitBranch ?? null,
    topic: meta.topic ?? null,
    label: meta.label ?? null,
    message_count: meta.messageCount ?? null,
    token_count: meta.tokenCount ?? null,
    output_tokens: meta.outputTokens ?? null,
    input_tokens: meta.inputTokens ?? null,
    cache_read_tokens: meta.cacheReadTokens ?? null,
    cache_write_tokens: meta.cacheWriteTokens ?? null,
    cost_usd: meta.costUsd ?? null,
    cost_usd_nocache: meta.costUsdNoCache ?? null,
    duration_ms: meta.durationMs ?? null,
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
    plan: meta.plan ?? null,
    todos: meta.todos ? JSON.stringify(meta.todos) : null,
    recent_directories_touched: meta.recentDirectoriesTouched ? JSON.stringify(meta.recentDirectoriesTouched) : null,
    linear_project: meta.linearProject ?? null,
    linear_project_url: meta.linearProjectUrl ?? null,
    machine: resolveMachine(meta),
    actor: meta.actor ?? actorRec?.actor ?? null,
    initiated_by: meta.initiatedBy ?? actorRec?.initiatedBy ?? null,
    used_browser: toolUsage.usedBrowser ? 1 : 0,
    used_computer: toolUsage.usedComputer ? 1 : 0,
  };

  const txn = db.transaction(() => {
    upsert.run(row);
    delText.run(meta.id);
    insText.run(
      meta.id,
      // Use the label the upsert actually stored (preserve-non-empty rule),
      // not the raw incoming one, so FTS label ranking survives a bare rescan.
      storedFtsLabel(readLabel, meta.id),
      meta.topic ?? '',
      meta.project ?? '',
      content ?? '',
    );
  });
  txn();
}

/** Batch-upsert sessions with their FTS5 content and scan stamps in a single transaction. */
export function upsertSessionsBatch(
  entries: Array<{
    meta: SessionMeta;
    content: string;
    scan?: ScanStamp;
    parserState?: string;
    contentText?: string;
    events?: SessionEvent[];
    toolCalls?: IndexedToolCall[];
    toolScan?: ScanStamp;
    toolIndexMode?: 'replace' | 'append';
  }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const { upsert, delText, insText, readLabel } = stmts(db);
  const now = Date.now();
  // One directory read for the whole batch: join the durable sessionId -> actor
  // sidecar (RUSH-2019) so scanned transcripts attribute to a person. Only used
  // for entries whose meta carries no actor; the ON CONFLICT COALESCEs the column,
  // so this fills fresh rows AND backfills null-first ones, never clobbering a
  // stored owner on rescan.
  const actorIndex = loadSessionActorIndex();
  // Persist the Claude resumable-parse continuation (parser_state + content_text)
  // alongside the stamp. On a full/incremental Claude parse the caller passes the
  // serialized newState + accumulated user doc so the NEXT scan can resume from
  // the persisted offset (B-2). Other scanners pass neither, leaving both columns
  // NULL exactly as before — their ledger rows are unaffected.
  const ledger = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at, parser_state, content_text)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at,
      parser_state = excluded.parser_state,
      content_text = excluded.content_text
  `);

  // Build a lookup from canonical file path → entry, used inside the write
  // transaction to re-check the ledger AFTER acquiring the lock. When a
  // concurrent process already committed the same files between our
  // filterChangedFiles call and now, the ledger will have matching (mtime, size)
  // rows — we skip those entries, making the second writer's transaction a
  // near-instant no-op rather than redundant work.
  const byPath = new Map(
    entries
      .filter(e => e.scan && e.meta.filePath)
      .map(e => [canonicalLedgerKey(e.meta.filePath), e]),
  );
  const enrichedEntries = entries.map(entry => {
    if (entry.meta.agent === 'claude' || entry.meta.agent === 'codex' || !entry.meta.filePath) return entry;
    try {
      const toolSourcePath = toolEvidenceSourcePath(entry.meta.filePath, entry.meta.agent);
      const toolScan = toolSourcePath === entry.meta.filePath
        ? entry.scan
        : (() => {
            const stat = fs.statSync(toolSourcePath);
            return { fileMtimeMs: stat.mtimeMs, fileSize: stat.size };
          })();
      // Some non-resumable scanners already normalized the transcript while
      // deriving metadata. Reuse those events; scanners that only read summary
      // metadata fall back to exactly one normalized parse here.
      const events = entry.events ?? parseSession(entry.meta.filePath, entry.meta.agent);
      writeResourceUsage(entry.meta.id, events, entry.meta.cwd);
      return {
        ...entry,
        meta: {
          ...entry.meta,
          todos: extractTodoProgressFromEvents(events),
          recentDirectoriesTouched: extractRecentDirectoriesTouched(events, entry.meta.cwd),
        },
        toolCalls: toolCallsFromEvents(events),
        toolScan,
        // These are complete event arrays, not an appended tail. Append would
        // duplicate existing evidence even when persistToolCalls supports it.
        toolIndexMode: 'replace' as const,
      };
    } catch {
      return entry;
    }
  });
  const writtenEntries: typeof enrichedEntries = [];

  // Pre-compute browser/computer usage for all sessions outside the write
  // transaction. detectToolUsage scans all event log files (O(files) I/O
  // per call) and holding the SQLite write lock during that scan is what
  // causes the "DB locked" errors (RUSH-2006). One pass for the whole batch
  // costs O(files) total instead of O(N × files) inside the lock.
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
        .prepare(`SELECT file_path, file_mtime_ms, file_size FROM scan_ledger WHERE file_path IN (${phs})`)
        .all(...chunk) as Array<{ file_path: string; file_mtime_ms: number; file_size: number }>;
      for (const row of rows) {
        const entry = byPath.get(row.file_path);
        if (entry && row.file_mtime_ms === entry.scan!.fileMtimeMs && row.file_size === entry.scan!.fileSize) {
          alreadyIndexed.add(entry.meta.id);
        }
      }
    }

    for (const entry of items) {
      const { meta, content, scan, parserState, contentText } = entry;
      if (alreadyIndexed.has(meta.id)) continue;
      // Per-row guard: one malformed session (e.g. a required field that resolves to
      // NULL) must not abort the whole batch and take down the entire `agents sessions`
      // listing. A constraint error uses SQLite's ABORT resolution — it reverts only the
      // failing statement, not the transaction — and the db.transaction wrapper only rolls
      // back when the error escapes `fn`, so catching + skipping here leaves the txn valid
      // and committable. We deliberately do NOT stamp the ledger for a skipped row, so the
      // next scan re-tries it (self-healing once the underlying parser is fixed).
      const toolUsage = toolUsageBySession.get(meta.id) ?? { usedBrowser: false, usedComputer: false };
      // claude/codex skip enrichCachedSessionMeta above (preserving their
      // resumable-parse optimization) — write their pre-computed
      // skillsUsed/slashCommandsUsed (folded incrementally by discover.ts's
      // accumulator) here instead. Every other harness already got this
      // write from enrichCachedSessionMeta() in the .map() above.
      if (meta.agent === 'claude' || meta.agent === 'codex') {
        writeResourceUsageFromTallies(meta.id, meta.skillsUsed ?? [], meta.slashCommandsUsed ?? [], meta.cwd);
      }
      try {
      // Typed, not a bare literal: bun binds named parameters in strict mode, where a
      // MISSING key throws (node binds NULL instead). A silently dropped key therefore
      // breaks only the shipped binary's runtime, and the per-row catch below swallows
      // it — the exact shape of the bug that shipped account_key unbound. Annotating
      // against SessionRow makes tsc reject the next omission.
      const row: SessionRow = {
        id: meta.id,
        short_id: meta.shortId,
        agent: meta.agent,
        origin: meta.origin ?? 'cli',
        routine_name: meta.routineName ?? null,
        routine_run_id: meta.routineRunId ?? null,
        version: meta.version ?? null,
        account: meta.account ?? null,
        account_key: meta.accountKey ?? null,
        account_org: meta.accountOrg ?? null,
        mode: meta.mode ?? actorIndex.get(meta.id)?.mode ?? null,
        timestamp: meta.timestamp,
        last_activity: resolveLastActivity(meta, scan),
        project: meta.project ?? null,
        cwd: meta.cwd ?? null,
        git_branch: meta.gitBranch ?? null,
        topic: meta.topic ?? null,
        label: meta.label ?? null,
        message_count: meta.messageCount ?? null,
        token_count: meta.tokenCount ?? null,
        output_tokens: meta.outputTokens ?? null,
        input_tokens: meta.inputTokens ?? null,
        cache_read_tokens: meta.cacheReadTokens ?? null,
        cache_write_tokens: meta.cacheWriteTokens ?? null,
        cost_usd: meta.costUsd ?? null,
        cost_usd_nocache: meta.costUsdNoCache ?? null,
        duration_ms: meta.durationMs ?? null,
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
        plan: meta.plan ?? null,
        todos: meta.todos ? JSON.stringify(meta.todos) : null,
        recent_directories_touched: meta.recentDirectoriesTouched ? JSON.stringify(meta.recentDirectoriesTouched) : null,
        linear_project: meta.linearProject ?? null,
        linear_project_url: meta.linearProjectUrl ?? null,
    machine: resolveMachine(meta),
        actor: meta.actor ?? actorIndex.get(meta.id)?.actor ?? null,
        initiated_by: meta.initiatedBy ?? actorIndex.get(meta.id)?.initiatedBy ?? null,
        used_browser: toolUsage.usedBrowser ? 1 : 0,
        used_computer: toolUsage.usedComputer ? 1 : 0,
      };
      upsert.run(row);
      delText.run(meta.id);
      insText.run(
        meta.id,
        // Mirror upsertSession: index the label the upsert actually stored
        // (preserve-non-empty rule), not the raw incoming one.
        storedFtsLabel(readLabel, meta.id),
        meta.topic ?? '',
        meta.project ?? '',
        content ?? '',
      );
      if (scan && meta.filePath) {
        ledger.run(
          canonicalLedgerKey(meta.filePath),
          scan.fileMtimeMs,
          scan.fileSize,
          now,
          parserState ?? null,
          contentText ?? null,
        );
      }
      writtenEntries.push(entry);
      } catch (err) {
        if (process.stderr.isTTY) {
          console.error(`Warning: skipped unindexable session ${meta.id}: ${(err as Error).message}`);
        }
      }
    }
  });
  txn(enrichedEntries);
  // Tool evidence shares the transcript parse above but owns an independent
  // transaction/ledger. If this write fails, the normal session row remains
  // valid and ensureToolIndex retries from the missing tool ledger later.
  for (const entry of writtenEntries) {
    const toolScan = entry.toolScan ?? entry.scan;
    if (!toolScan || !entry.toolCalls) continue;
    try {
      persistToolCalls(db, entry.meta, entry.toolCalls, toolScan, { mode: entry.toolIndexMode ?? 'replace' });
    } catch {
      // Boundary is intentionally retryable via tool_scan_ledger.
    }
  }
  // Every batch appends FTS segments (session_text always, tool_call_text for the
  // harnesses indexed above). Pay a bounded slice of the merge here so the
  // scan path keeps its own index healthy instead of leaving all compaction to
  // the manual `agents sessions optimize` (RUSH-2208). Threshold-gated, so a
  // small index costs two counts and nothing else.
  maintainSessionSearchIndex(db);
}

/**
 * Sync labels for a set of sessions. For each id in the map, if the stored
 * label differs, update both `sessions.label` and the FTS5 label column.
 * Leaves FTS5 content/topic/project untouched — cheap to call every run.
 */
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
  const updFts = db.prepare(`UPDATE session_text SET label = ? WHERE session_id = ?`);

  const txn = db.transaction((items: typeof updates) => {
    for (const { id, label } of items) {
      updSessions.run(label, id);
      updFts.run(label ?? '', id);
    }
  });
  txn(updates);
  return updates.length;
}

/**
 * Seed session labels from `agents run --name` handles, keyed by session id.
 *
 * `--name` is the universal launch-time way to set a session's label — the same
 * field an agent later refines with a generated title (`syncLabels`) or the user
 * with `/rename`. The seed's source of truth lives outside the transcript (host
 * task sidecars, run-name sidecars written at launch), so it is re-applied by id
 * every scan rather than parsed per-file. It only fills a label that is still
 * EMPTY — an agent-generated title always wins over the seed, so a Claude run's
 * `--name` shows until Claude titles it, and a non-Claude run keeps its `--name`
 * as the label. Writes both `sessions.label` and the FTS5 label column so a
 * seeded name is fuzzy-searchable. Cheap to call every run; returns rows updated.
 *
 * Ordering matters: this runs AFTER the per-agent scans (which apply
 * agent-generated titles via {@link syncLabels}), so it never overwrites a real
 * title — it only backfills the gap the seed was meant to cover.
 */
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
  const updFts = db.prepare(`UPDATE session_text SET label = ? WHERE session_id = ?`);
  const txn = db.transaction((items: typeof updates) => {
    for (const { id, label } of items) {
      updSessions.run(label, id);
      updFts.run(label, id);
    }
  });
  txn(updates);
  return updates.length;
}

/**
 * Sync topics (session titles) for a set of sessions, keyed by id. For agents
 * whose human-readable title lives in a side index that updates independently
 * of the transcript (Codex `session_index.jsonl`), the per-file scan can't see
 * a title that lands later. This applies those titles by id, updating both
 * `sessions.topic` and the FTS5 topic column. Only ever sets a non-empty title
 * and only when it differs from the stored value — cheap to call every run.
 * Returns the number of rows updated.
 */
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
  const updFts = db.prepare(`UPDATE session_text SET topic = ? WHERE session_id = ?`);

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
    accountOrg: row.account_org ?? undefined,
    mode: isSessionRunMode(row.mode) ? row.mode : undefined,
    topic: row.topic ?? undefined,
    label: row.label ?? undefined,
    isTeamOrigin: row.is_team_origin === 1,
    prUrl: row.pr_url ?? undefined,
    prNumber: row.pr_number ?? undefined,
    worktreeSlug: row.worktree_slug ?? undefined,
    ticketId: row.ticket_id ?? undefined,
    spawnedTeam: row.spawned_team ?? undefined,
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
  };
}

function isSessionRunMode(value: string | null): value is SessionRunMode {
  return value === 'plan' || value === 'edit' || value === 'auto' || value === 'skip';
}

function parseJsonColumn<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

/**
 * The recency signal used to sort and label the listing: last-message time when
 * a parser computed it (`meta.lastActivity` from `lastTsMs`), else the file's
 * mtime (its last write), else creation time. Guarded on `filePath` so synthetic
 * / cloud rows (no local file) fall to their creation timestamp rather than a
 * bogus scan-time mtime. Always an ISO string, so it sorts lexicographically
 * against `timestamp` and feeds `formatRelativeTime` unchanged.
 */
function resolveLastActivity(meta: SessionMeta, scan?: ScanStamp): string {
  if (meta.lastActivity) return meta.lastActivity;
  if (scan?.fileMtimeMs && meta.filePath) return new Date(scan.fileMtimeMs).toISOString();
  return meta.timestamp;
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

/**
 * Newest indexed session file for an agent working in `cwd`. Lets the live
 * `--active` scanner locate a Codex transcript (whose files are date-partitioned,
 * not cwd-keyed like Claude's) by reusing the index. Returns undefined if the
 * session hasn't been scanned yet — the caller degrades to no live state.
 */
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
    // A LOCAL stored cwd uses the host path separator (normalizeCwd runs
    // path.normalize on it), so the subdir wildcard must too — a hardcoded '/'
    // never matches a Windows `C:\a\b` subpath and the listing comes back empty.
    // A cwd recorded on another machine keeps its own separators, so this
    // wildcard does not match foreign subpaths; both sides go through
    // normalizeCwd, so the exact `cwd = ?` comparison still holds for them.
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

  // id lookup. SQLite's LIKE is case-insensitive for ASCII, so a lowercased
  // pattern matches mixed-case ids; the `=` exact compare adds COLLATE NOCASE
  // for the same reason. short_id carries its own index (idx_sessions_short_id);
  // id is the PRIMARY KEY.
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

  // #12: join against session_resource_usage. A subquery IN, not a real JOIN
  // on the base SELECT, keeps `SELECT * FROM sessions` untouched for every
  // other caller of buildSessionWhere() (countSessions, the usage rollup, …)
  // that never wants a skill/plugin filter.
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

/**
 * Resolve which of the given file paths no longer exist, batching the check
 * per directory instead of one `fs.existsSync` stat syscall per file.
 * Transcript trees put many sessions in the same directory (one Claude
 * `~/.claude/projects/<slug>/` holds every session for that project), so
 * `readdirSync` once per directory and a Set membership test collapses what
 * used to be N stat syscalls into (number of distinct directories) readdir
 * syscalls — the same existence answer, far fewer syscalls on a large index
 * (RUSH-2211). Each directory membership set is cached by directory mtime+size,
 * so filesystem-only creates and deletes invalidate it without a SQLite write
 * (RUSH-2318). Falls back to per-file existsSync when a directory cannot be
 * listed.
 */
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
  // Existence is decided on the CONTAINER file, never the raw stored path. A
  // composite `file_path` (`<container>#<id>`, e.g. OpenCode's `opencode.db#ses_…`)
  // names a row INSIDE a shared file — its basename is never a directory entry,
  // so a dirname/basename membership check on the composite string classified
  // every such row as deleted and pruned it (RUSH-2357). Group the original
  // paths under the container we actually stat, and map the verdict back so the
  // returned set still holds the original `file_path` strings the caller keys on.
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
  // NULLs last so unpriced / duration-less rows never crowd out real data when
  // sorting by cost or duration. timestamp is never null (NOT NULL column).
  // Default sort is the bare `last_activity` column, not `IFNULL(last_activity,
  // timestamp)` — the v35 migration backfills every row so last_activity is
  // never NULL, and every upsert path (resolveLastActivity) keeps it that way
  // going forward. Wrapping the column in IFNULL() defeats
  // idx_sessions_last_activity (SQLite can't use an index on an expression that
  // isn't the bare column); the bare column lets the planner walk the index
  // instead of sorting the whole result set (RUSH-2211).
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
  // A row whose transcript file is gone from disk is one of two things, and the
  // local DB is now authoritative for telling them apart (RUSH-2436):
  //   - ARCHIVED — its user turns still live in session_text. The session is
  //     real; the file was just removed (agents remove trash, a manual rm, a
  //     .history rotation, a box reimage). Keep it, stamped `archived`, so it
  //     still lists and renders from the DB instead of silently vanishing.
  //   - PHANTOM — a stale/moved file_path with NO cached content (#136), e.g. a
  //     path a scan forgot to rewrite. There is nothing durable to serve, so it
  //     stays suppressed exactly as before.
  // We NO LONGER purge tool-call evidence here: merely listing a file-gone
  // session used to DELETE its redacted tool calls (purgeToolCalls), destroying
  // durable data on a read. Synthetic rows (OpenClaw channels/cron — see
  // scanOpenClawIncremental) carry an empty file_path and are exempt.
  const missingPaths = findMissingFilePaths(rows.map(r => r.file_path).filter((p): p is string => !!p));
  const missing = rows.filter(r => r.file_path && missingPaths.has(r.file_path));
  const missingIds = new Set(missing.map(r => r.id));
  const phantomIds = new Set<string>();
  if (missing.length > 0) {
    const readContent = db.prepare(`SELECT content FROM session_text WHERE session_id = ?`);
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
  // Un-archive a row whose file came back (a recoverable-trash restore, a re-sync):
  // it is present on disk now, so it must not keep reporting `archived` to a
  // machine consumer reading the --json listing. Rare, so the write only fires when
  // such a row actually exists (RUSH-2436).
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
  /**
   * Grouping key value: the agent id, project name, ISO date (YYYY-MM-DD), or
   * account identity (`claude:org=<uuid>` / `unattributed:<reason>`).
   */
  key: string;
  /**
   * Human label for the key when it is not itself readable — an org uuid is an
   * identity, not something to show a user. Absent when `key` reads fine on its own.
   */
  label?: string;
  costUsd: number;
  /**
   * USD cost priced as if caching were off (cache read/write at the input rate),
   * summed from `cost_usd_nocache`. Backs `agents insights output --pricing no-cache`.
   * Equals `costUsd` for rows whose sessions record no cache split (RUSH-2287).
   */
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
/**
 * Read cached facets for the given sessions, dropping any row that is stale.
 *
 * Staleness is decided in SQL against the session's own `file_mtime_ms` / `file_size`,
 * the same pair the scanner maintains — so the cache cannot disagree with the index,
 * `IS` rather than `=` so a source with no statable file — NULL on both sides — is a
 * cache HIT rather than a permanent miss that re-parses it on every run.
 */
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

/**
 * Persist freshly computed facets against the stamp of the bytes actually parsed.
 *
 * The caller passes the stat it observed when it read the file. Re-reading the stamp
 * from the sessions table inside this INSERT would race: a concurrent rescan between
 * the parse and the write (the cold path flushes in batches, so the window is minutes
 * wide, and this module treats concurrent access as a design assumption) stamps NEW
 * bytes onto OLD facets — a permanent false cache hit until the file changes again.
 * tool-index.ts sets the precedent: stat at parse time, carry the stamp into the write.
 */
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

/**
 * The session's durable user-turn text, as stored in the `session_text` FTS
 * `content` column at scan time (all harnesses, keyed by session_id). This is
 * the content that survives the transcript file being deleted (RUSH-2436): the
 * render path reads it so a file-gone session still shows its user prompts, and
 * querySessions uses its presence to tell a genuine archived session (has
 * content) from a phantom (a stale/moved file_path with none). Returns undefined
 * when no row exists; an empty string when a row exists but carried no content.
 */
export function readSessionContent(id: string): string | undefined {
  const row = getDB().prepare(
    `SELECT content FROM session_text WHERE session_id = ?`,
  ).get(id) as { content: string } | undefined;
  return row?.content;
}

/**
 * Read the last-computed preview digest for a session by id, validated against
 * the session row's OWN stored file stamp rather than a live `fs.stat` — the
 * transcript file is gone, so there is nothing on disk to stat, but the preview
 * cache was written with the same `file_mtime_ms`/`file_size` the sessions row
 * still records, so the join re-establishes that stamp. Backs the file-gone
 * render/preview path (RUSH-2436). Returns undefined when no cached digest
 * survives for this session.
 */
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

export type UsageRollupGroup = 'agent' | 'project' | 'day' | 'account';

/**
 * Smart-launch affinity priors: group sessions by origin machine, harness, or
 * joint (machine + agent). Ordered by launch count desc.
 *
 * SQL shape (device example):
 *   SELECT machine, COUNT(*) launches, SUM(duration_ms), SUM(token_count)
 *   FROM sessions
 *   WHERE timestamp >= ? AND origin = 'cli' AND is_team_origin = 0
 *   GROUP BY machine ORDER BY launches DESC
 *
 * Account rotation is NOT done here — that stays on live rate-limit windows
 * via `--strategy balanced` / rotate.ts.
 */
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

/**
 * Aggregate cost / duration / tokens across sessions, grouped by agent,
 * project, or calendar day. Honors the same filter shape as querySessions
 * (agent, since/until, team-origin) so `agents insights cost --since 7d --by day`
 * lines up with what `agents sessions` would list. Ordered by cost desc.
 */
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
        : options.groupBy === 'account'
          // A NULL account_key means this harness has no account attribution yet —
          // the mechanism is Claude-only today (see lib/session/claude-accounts.ts).
          // Bucket per agent so the rows are named honestly instead of being called
          // "not indexed", which they are not, and instead of joining a real account.
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

/**
 * Roll up skill / slash-command usage from session_resource_usage, joined to
 * `sessions` for attribution so the same filter shape as querySessions
 * (agent / project / since / machine) narrows WHICH sessions count. Grouped by
 * resource identity (kind + name + plugin + source) and ordered by invocation
 * volume — the read side of "which skills/commands do I actually use, and which
 * are dead weight". `order: 'bottom'` ranks least-used first (the one-time
 * skills); `limit` caps the returned rows.
 *
 * The signal only captures EXPLICIT invocations (slash commands and `Skill`
 * tool calls). An auto-triggered skill (loaded by description match) emits no
 * event, so it reads as zero here — a 0 means "never explicitly invoked", not
 * "never loaded". Skill invocations are recorded for Claude and Kimi (the
 * `Skill`-tool harnesses); slash-commands are Claude-only.
 *
 * `kind` / `pluginFilter` filter the RESOURCE rows directly (r.kind / r.plugin),
 * distinct from QueryOptions.skill / QueryOptions.plugin, which filter SESSIONS
 * — deliberately not routed through buildSessionWhere so `--plugin rush` shows
 * only rush's resources rather than every resource used by a rush-touching
 * session.
 */
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
  // buildSessionWhere emits bare column names (agent, timestamp, machine, …) and
  // `id IN (…)` subqueries; in this join they resolve unambiguously to `sessions`
  // (session_resource_usage carries none of those columns, and its key is
  // session_id, not id). Strip the leading WHERE so resource predicates append.
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
  // Group by resource IDENTITY = (kind, name) only, per SES-IF-4b. name already
  // embeds the `plugin:short` prefix for a plugin resource, so (kind, name) is
  // the true identity. plugin and source are PROVENANCE, not identity, and drift
  // per session — the same `rush:design` resolves plugin='rush' in a session
  // whose cwd discovered the plugin and plugin=NULL in one that didn't, and the
  // layer a flat resource resolved to varies (user vs system). Grouping on either
  // would split one resource into fractional rows. Aggregate both with MAX so the
  // row carries a representative (non-NULL when any session resolved it) label
  // while the counts stay whole.
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

/**
 * Coverage of the resource-usage signal: how many distinct sessions carry any
 * row in session_resource_usage vs. the total indexed. A low ratio means the
 * historical backfill (`agents sessions backfill resources`) hasn't run — the
 * stats surface uses this to tell the user their zero-counts may just be
 * un-scanned history, not genuine non-use.
 */
export function resourceUsageCoverage(): { covered: number; total: number } {
  const db = getDB();
  const covered = (db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM session_resource_usage`).get() as { n: number }).n;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
  return { covered, total };
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

/**
 * One-shot historical backfill of session_resource_usage (#12). The normal
 * incremental scan writes resource usage only for sessions whose transcript it
 * (re)parses; a session indexed before this feature shipped keeps a fresh
 * scan_ledger row and is never re-derived, so its skill/slash-command tallies
 * were never recorded. This walks the session index, re-parses each transcript
 * FROM BYTE 0 (parseSession fully materializes — no resumable cursor, so
 * claude/codex re-derive their tallies from scratch), writes the usage, and
 * stamps resource_scan_ledger so reruns skip completed transcripts — the same
 * independent-ledger shape `agents sessions backfill tools` uses.
 *
 * Harness-agnostic: parseSession + extractSkills/extractSlashCommands cover
 * every agent uniformly, so there is no per-harness branch to keep in parity.
 * Synthetic rows without a transcript (OpenClaw channels/cron) are skipped.
 */
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
      // Fail loud on a bad read. writeResourceUsage DELETEs the session's rows
      // before it re-inserts, so a transcript that parses to ZERO events (a
      // truncated / mid-sync / corrupt file — parseSession returns [] instead of
      // throwing) would silently wipe real historical usage and then stamp the
      // ledger "current", masking the loss. A completed historical transcript
      // always has turns, so an empty parse is never a legitimate "this session
      // used nothing" — it is an unreadable file. Skip it (count as failed, leave
      // the ledger unstamped) so a later good read retries.
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

/**
 * Map every team name to the session that ran `agents teams create/add` for it.
 *
 * One scan over the rows that carry a `spawned_team`, rather than a query per
 * team — `agents teams list` needs the whole map at once, and the column has no
 * index. When two sessions spawned the same team name (a team re-created after a
 * disband), the most recent wins, which is the one whose work the name refers to.
 */
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

/**
 * Return the N most expensive sessions (cost_usd DESC, NULLs excluded),
 * honoring the same filter shape as querySessions. Drops rows whose JSONL
 * vanished, mirroring querySessions' liveness filter.
 */
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
  // Keep a row whose file is present OR whose transcript is already archived
  // (file gone but user turns still in session_text) — an expensive, real
  // session must not drop out of the cost rollup just because its file was
  // removed (RUSH-2436). A file-gone row with no durable content (a phantom) is
  // still excluded. archived_at is the persisted signal; stamp it here too (once)
  // so a session first surfaced through the cost rollup reports `archived`
  // consistently with the listing path.
  const readContent = db.prepare(`SELECT content FROM session_text WHERE session_id = ?`);
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

/** Look up a single session by its unique ID. */
/**
 * Batch-resolve session ids to the machine each one runs on, in ONE indexed
 * query. `getActiveSessions` needs only this column for every live row, and
 * `getSessionById` would re-`prepare` a `SELECT *` and materialize a full
 * `SessionMeta` per id to read it — mirrors {@link findSessionsByShortIds}'s
 * single-round-trip pattern. Ids absent from the index are simply absent from
 * the map. Best-effort: an unavailable DB yields an empty map, so the live view
 * still renders (the caller then leaves rows attributed to this box).
 */
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

/**
 * Resolve a full-or-partial session id against the index, exact-first then
 * prefix — the DB-backed equivalent of resolveSessionById() that runs over the
 * SQLite table instead of a pre-loaded array. Matches both the full id and the
 * short id. An exact hit short-circuits so a complete id never also drags in its
 * prefix siblings. `scope` narrows by agent / version / project (cwd) so an
 * ambiguous prefix disambiguates against the caller's context.
 *
 * Routes through the full querySessions existence check (NOT skipExistenceCheck)
 * on purpose (RUSH-2436): that check now KEEPS a file-gone session whose user
 * turns still live in session_text (flagged archived) and only suppresses a
 * contentless phantom — so `agents sessions <id>` resolves an archived session
 * instead of failing with "No session found", while a phantom id still misses.
 */
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

/**
 * Batch-resolve many 8-char short ids to their sessions in ONE indexed query.
 * The live-scan path (listTmuxAgentSessions) turns every `ag-<agent>-<shortid>`
 * tmux pane name back into a full session id this way, so it pays a single
 * `short_id IN (…)` round-trip per scan instead of N per-pane lookups.
 *
 * Returns a map keyed by short_id (lowercased). Short ids are the first 8 chars
 * of the lowercase session UUID (deriveShortId), so a lowercased `IN` matches and
 * still uses idx_sessions_short_id. When several sessions share a short id — only
 * time-ordered ids (ULID/UUIDv7) ever collide; random UUIDv4 short ids are unique
 * in practice — the most-recently-active one wins (the caller can further
 * disambiguate by cwd).
 */
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
}

/**
 * Escape a raw user query into a safe FTS5 MATCH expression.
 * Splits on non-word characters, keeps tokens >= 2 chars, and OR-joins
 * them with a prefix wildcard so partial typing ('rush dep') matches.
 */
export function buildFtsQuery(input: string): { expr: string; terms: string[] } {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (terms.length === 0) return { expr: '', terms: [] };
  const expr = terms.map(t => `${t}*`).join(' OR ');
  return { expr, terms };
}

/**
 * Build a `label:(...)` FTS5 column-filter MATCH expression for the label
 * tier. Unlike `buildFtsQuery` (2-char floor, tuned for full-content search),
 * this allows 1-char terms: label search is the interactive type-ahead path —
 * the query grows one keystroke at a time, so a single character has to be
 * indexable too. Terms are filtered to `[a-z0-9]` before being embedded in the
 * expression string, so there's no FTS5 syntax injection from user input.
 */
function buildLabelFtsQuery(input: string): string {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 1);
  if (terms.length === 0) return '';
  return `label:(${terms.map(t => `${t}*`).join(' OR ')})`;
}

/**
 * Label-first search. Sessions whose custom label substring-matches the query
 * always rank ahead of FTS5 hits — this gives predictable behavior when a user
 * types the exact name they gave a session via /rename.
 *
 * Tiers (highest → lowest):
 *   1. Exact label match (case-insensitive): score 1_000_000
 *   2. Label prefix match:                   score   900_000
 *   3. Label contains query:                 score   800_000
 *   4. FTS5 BM25 hits:                       score   1..1000 (scaled)
 *
 * Note: FTS5's bm25() returns negative numbers; we flip the sign for tier 4
 * so "higher = better" is consistent across all tiers.
 */
export function ftsSearch(input: string, limit = 200): FtsHit[] {
  const db = getDB();
  const trimmed = input.trim();
  if (!trimmed) return [];

  const { expr, terms } = buildFtsQuery(input);
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();
  const hits: FtsHit[] = [];

  // Tier 1-3: handle-based matches, ordered by exactness. A session's handle is
  // its `label` — set by an agent title / `/rename`, or seeded at launch from
  // `agents run --name`. Typing it resolves the session ahead of any FTS content
  // hit.
  //
  // Candidates come from the FTS5 `label` column, not a raw `LOWER(label) LIKE
  // '%q%'` scan of `sessions`: a leading wildcard can't use any index, so on a
  // large session table that was a full-table scan on every keystroke of
  // interactive search (RUSH-2211). `session_text.label` is kept 1:1 with
  // `sessions.label` by every upsert path (storedFtsLabel), so this is the
  // same data, indexed. Token-prefix matching seeks the FTS index instead of
  // scanning every row, at the cost of only matching at token boundaries — a
  // substring inside a single token (e.g. "ckf" inside "quickfix") no longer
  // matches, since FTS5 only indexes prefixes of whole tokens, not arbitrary
  // interior slices. (A slice spanning a token boundary, like "ix-b" inside
  // "fix-bug", still matches: "ix-b" tokenizes to "ix" + "b", and "b" is a
  // valid prefix of the "bug" token.) That's the accepted trade-off for an
  // indexable interactive path; the exact/prefix/contains scoring below still
  // runs in JS over the FTS candidate set, so ranking among real matches is
  // unchanged. Only a query with no indexable token (rare — e.g.
  // punctuation-only input) falls back to the direct scan rather than
  // silently dropping the tier.
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

  // Tier 4: FTS5 content match, skipping anything already surfaced via label.
  if (expr) {
    try {
      const rows = db
        .prepare(`
          SELECT session_id, bm25(session_text, ${BM25_WEIGHTS.join(', ')}) AS rank
          FROM session_text
          WHERE session_text MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(expr, limit) as { session_id: string; rank: number }[];

      for (const r of rows) {
        if (seen.has(r.session_id)) continue;
        hits.push({ sessionId: r.session_id, score: -r.rank, matchedTerms: terms });
        seen.add(r.session_id);
      }
    } catch {
      /* invalid MATCH expression — tier 4 just yields nothing */
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Rewrite file_path for all sessions whose path starts with oldPrefix, replacing
 * it with newPrefix + the unchanged suffix. Also clears the matching scan_ledger
 * entries so they are re-indexed from the new location on the next scan.
 *
 * Used by removeVersion after soft-deleting a version directory to trash, so
 * that session reads (transcript view, /continue) still work from the trash path.
 * Returns the number of session rows updated.
 */
export function updateSessionFilePaths(oldPrefix: string, newPrefix: string): number {
  const db = getDB();
  const rows = db
    .prepare(`SELECT id, file_path FROM sessions WHERE file_path LIKE ?`)
    .all(oldPrefix + '%') as { id: string; file_path: string }[];

  if (rows.length === 0) return 0;

  const txn = db.transaction(() => {
    for (const { id, file_path } of rows) {
      const newPath = newPrefix + file_path.slice(oldPrefix.length);
      db.prepare(`UPDATE sessions SET file_path = ? WHERE id = ?`).run(newPath, id);
      db.prepare(`DELETE FROM scan_ledger WHERE file_path = ?`).run(canonicalLedgerKey(file_path));
    }
  });
  txn();
  return rows.length;
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

/**
 * Upsert one browser task's durable metadata.
 *
 * Called at task START. This executes INSIDE the browser daemon (daemon.ts
 * constructs BrowserService; ipc.ts dispatches `start` to it), which makes the
 * shared daemon a writer of this DB — but the identity it writes is RESOLVED IN
 * THE CALLING CLI PROCESS and forwarded over IPC, never resolved here. That
 * distinction is the whole fix: resolving it daemon-side would attribute every
 * task to the daemon's own actor (the RUSH-2020 bug).
 *
 * `agents browser stop` deliberately does NOT delete this row: the whole point
 * is that the link outlives the task.
 *
 * Identity fields are only ever widened, never blanked. A later capture-count
 * update carries no session id, and `COALESCE(excluded.…, browser_sessions.…)`
 * keeps the one recorded at start rather than overwriting it with NULL --
 * otherwise the second write would undo exactly what the first was for.
 */
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

/**
 * Upsert one computer-use invocation's durable metadata.
 *
 * `action_count` accumulates: a `computer run` loop emits many actions under one
 * invocation id, and each arrives as its own call, so the count is incremented
 * rather than replaced. Identity is widened-only, for the same reason as above.
 */
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

/**
 * Stored browser tasks, newest first; optionally scoped to one profile.
 *
 * A PROFILE-SCOPED read is deliberately unbounded. These rows are the identity
 * for capture dirs that still exist on disk, and dropping the oldest ones would
 * silently regress exactly those tasks to `unlinked` — the symptom this whole
 * change removes, reappearing at a higher threshold. The row count is already
 * bounded by the tasks that profile has ever run, and each row is a short
 * metadata record. Only the unscoped read (every profile, used for overviews)
 * takes a ceiling, since that one has no natural bound.
 */
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

/**
 * Retention for the tool-session tables.
 *
 * These are the durable answer to a ledger that prunes at 7 days, so they are
 * deliberately long-lived — but "durable" is not "unbounded". `computer_sessions`
 * takes one row per `agents computer` CLI PROCESS (`COMPUTER_INVOCATION_ID` is
 * minted per process), and an agent driving a desktop invokes that hundreds of
 * times a day, so an unbounded table would grow without limit and be read in
 * full on every listing.
 */
const TOOL_SESSION_MAX_AGE_DAYS = 365;
/** Default ceiling on rows one listing will read. */
const TOOL_SESSION_LIST_LIMIT = 2000;

/**
 * Drop tool-session rows past {@link TOOL_SESSION_MAX_AGE_DAYS}.
 *
 * Called from the listing path, never from the write hot path: an
 * `agents computer` action must not pay for a table sweep (see the fail-soft
 * note on `recordComputerSession`'s caller). Returns rows deleted.
 */
export function pruneToolSessions(maxAgeDays: number = TOOL_SESSION_MAX_AGE_DAYS): number {
  const db = getDB();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // Cheap indexed guard first, so the common case is one lookup rather than a
  // write transaction (the same shape as the account repair below). Every
  // listing calls this, and on any table younger than the retention window
  // there is nothing to delete — but a bare DELETE still opens a write
  // transaction, which under `busy_timeout = 30000` can make a read-only
  // listing wait on the session indexer for no reason at all.
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

/**
 * Stored computer-use invocations, newest first, bounded.
 *
 * The limit is a real ceiling, not a nicety: `--json` serializes whatever this
 * returns, so an unbounded read would dump the entire table on every call.
 */
export function listComputerSessionRecords(
  opts: { limit?: number; startedBeforeMs?: number } = {},
): StoredComputerSession[] {
  const db = getDB();
  const limit = opts.limit ?? TOOL_SESSION_LIST_LIMIT;
  // `startedBeforeMs` selects the COMPLEMENT of the caller's other source
  // rather than the newest N. The caller that recovers pruned runs already
  // holds every recent invocation from the event ledger and discards any row
  // it has seen — so a bare newest-N read hands it 2000 rows it is guaranteed
  // to throw away, and returns nothing at all once the table passes that size.
  // Bounding by "older than the ledger reaches" truncates the TAIL of
  // recoverable history instead of deleting all of it.
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
