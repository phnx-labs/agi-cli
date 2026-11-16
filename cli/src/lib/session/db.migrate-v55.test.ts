import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv55-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

const ID = 'cccccccc-0000-4000-8000-000000000055';

{
  const seed = new Database(getSessionsDbPath());
  seed.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, short_id TEXT NOT NULL, agent TEXT NOT NULL, harness TEXT,
      origin TEXT DEFAULT 'cli', routine_name TEXT, routine_run_id TEXT, version TEXT,
      account TEXT, account_key TEXT, account_org TEXT, account_id TEXT, mode TEXT, timestamp TEXT NOT NULL,
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT,
      first_user_message TEXT, last_user_message TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, input_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, cost_usd_nocache REAL,
      duration_ms INTEGER, model TEXT, tool_call_count INTEGER, file_path TEXT NOT NULL,
      file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER, is_team_origin INTEGER DEFAULT 0,
      pr_url TEXT, pr_number INTEGER, pr_urls TEXT, worktree_slug TEXT, ticket_id TEXT, spawned_team TEXT,
      sub_agent_count INTEGER, background_shell_count INTEGER, plan TEXT, machine TEXT, todos TEXT,
      recent_directories_touched TEXT, linear_project TEXT, linear_project_url TEXT, actor TEXT,
      initiated_by TEXT, used_browser INTEGER, used_computer INTEGER, archived_at INTEGER,
      mirror_synced_at INTEGER, mirror_source TEXT,
      generated_title TEXT, generated_title_key TEXT, generated_title_at INTEGER
    );
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path, first_user_message)
      VALUES ('${ID}', 'cccccccc', 'claude', '2026-11-16T00:00:00.000Z', '', 'ship the Rush Mac launch');
    INSERT INTO meta(key, value) VALUES ('schema_version', '54');
  `);
  seed.close();
}

const db = await import('./db.js');

describe('schema migration v54 -> v55 (a session\'s workstream)', () => {
  it('adds sessions.workstream to a v54 index, keeping its rows, and the titler can write it', () => {
    const cols = (db.getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('workstream');
    expect(db.getSessionById(ID)?.firstUserMessage).toBe('ship the Rush Mac launch');
    expect(db.getSessionWorkstream(ID)).toBeUndefined();
    expect(db.setSessionGeneratedTitle(ID, 'Ship the Rush Mac launch', 'k55', 1, 'Rush Mac')).toBe(true);
    expect(db.getSessionWorkstream(ID)).toBe('Rush Mac');
  });
});
