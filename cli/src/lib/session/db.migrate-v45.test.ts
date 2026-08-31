import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db (db.ts captures DB_PATH at
// module load). Same pattern as every migration test in this directory.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv45-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

/**
 * v44 -> v45: add the `first_user_message` column (PHNX-3621). We seed an
 * authentic pre-v45 `sessions` table — every column through v44 but WITHOUT
 * first_user_message — stamp the version to 44, then let getDB replay
 * migrateSchema(44). The ALTER must add the column, preserve the existing row,
 * and that row must read back with a NULL first_user_message (old-row
 * compatibility — it stays NULL until re-indexed).
 */
const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

{
  const seed = new Database(getSessionsDbPath());
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
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path, topic) VALUES
      ('pre-v45', 'pre-v45', 'claude', '2026-08-31T00:00:00.000Z', '/s/pre-v45.jsonl', 'an old row');
    INSERT INTO meta(key, value) VALUES ('schema_version', '44');
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

describe('schema migration v44 -> v45 (first_user_message column, PHNX-3621)', () => {
  it('stamps the new version', () => {
    expect(recordedVersion()).toBe(String(SCHEMA_VERSION));
  });

  it('adds the first_user_message column', () => {
    const cols = (getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('first_user_message');
  });

  it('preserves the pre-existing row, reading first_user_message back as NULL', () => {
    const row = getDB()
      .prepare(`SELECT topic, first_user_message FROM sessions WHERE id = ?`)
      .get('pre-v45') as { topic: string | null; first_user_message: string | null } | undefined;
    expect(row?.topic).toBe('an old row');
    expect(row?.first_user_message).toBeNull();
  });
});
