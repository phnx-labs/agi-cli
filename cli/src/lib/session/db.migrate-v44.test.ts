import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db. db.ts captures DB_PATH at module
// load, so redirecting it after the import silently opens the wrong database.
// Every migration test in this directory uses this pattern.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv44-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

/** v43 -> v44: backfill duration_ms for harnesses whose extractor never derived it (PHNX-3457), in
 * place from last_activity - timestamp with no reparse. Seeds a pre-v44 table with a NULL row with
 * a real span, a NULL row with no positive span, and a row with a precise duration. */
const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

{
  const seed = new Database(getSessionsDbPath());
  // The full sessions table is created by getDB's SCHEMA via CREATE TABLE IF NOT EXISTS, so a
  // partial pre-seed would block it and fail the post-migration index/repair steps. Seed the full
  // authentic pre-v44 shape.
  seed.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, short_id TEXT NOT NULL, agent TEXT NOT NULL, harness TEXT,
      origin TEXT DEFAULT 'cli', routine_name TEXT, routine_run_id TEXT, version TEXT,
      account TEXT, account_key TEXT, account_org TEXT, mode TEXT, timestamp TEXT NOT NULL,
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, input_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, cost_usd_nocache REAL,
      duration_ms INTEGER, model TEXT, tool_call_count INTEGER, file_path TEXT NOT NULL,
      file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER, is_team_origin INTEGER DEFAULT 0,
      pr_url TEXT, pr_number INTEGER, worktree_slug TEXT, ticket_id TEXT, spawned_team TEXT,
      sub_agent_count INTEGER, background_shell_count INTEGER, plan TEXT, machine TEXT, todos TEXT,
      recent_directories_touched TEXT, linear_project TEXT, linear_project_url TEXT, actor TEXT,
      initiated_by TEXT, used_browser INTEGER, used_computer INTEGER, archived_at INTEGER
    );
    INSERT INTO sessions (id, short_id, agent, timestamp, last_activity, file_path, duration_ms) VALUES
      ('rush-span',      'span',    'rush',   '2026-08-28T20:00:08.000Z', '2026-08-28T20:12:08.000Z', '/s/rush-span.jsonl',    NULL),
      ('rush-nospan',    'nospan',  'rush',   '2026-08-28T20:00:08.000Z', '2026-08-28T20:00:08.000Z', '/s/rush-nospan.jsonl',  NULL),
      ('claude-precise', 'precise', 'claude', '2026-08-28T20:00:00.000Z', '2026-08-28T20:30:00.000Z', '/s/claude-precise.jsonl', 42000);
    INSERT INTO meta(key, value) VALUES ('schema_version', '43');
  `);
  seed.close();
}

const { getDB, SCHEMA_VERSION } = await import('./db.js');

function recordedVersion(): string | undefined {
  const row = getDB()
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  return row?.value;
}

function durationOf(id: string): number | null {
  const row = getDB()
    .prepare(`SELECT duration_ms FROM sessions WHERE id = ?`)
    .get(id) as { duration_ms: number | null } | undefined;
  return row?.duration_ms ?? null;
}

describe('schema migration v43 -> v44 (duration_ms backfill, PHNX-3457)', () => {
  it('stamps the new version', () => {
    expect(recordedVersion()).toBe(String(SCHEMA_VERSION));
  });

  it('backfills a NULL duration from last_activity − timestamp', () => {
    // 20:12:08 − 20:00:08 = 12 minutes.
    expect(durationOf('rush-span')).toBe(12 * 60_000);
  });

  it('leaves a NULL duration NULL when there is no positive span (never a fabricated 0)', () => {
    expect(durationOf('rush-nospan')).toBeNull();
  });

  it('never overwrites a harness-computed precise duration', () => {
    expect(durationOf('claude-precise')).toBe(42000);
  });
});
