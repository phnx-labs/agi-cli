import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv48-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

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
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT,
      first_user_message TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, input_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, cost_usd_nocache REAL,
      duration_ms INTEGER, model TEXT, tool_call_count INTEGER, file_path TEXT NOT NULL,
      file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER, is_team_origin INTEGER DEFAULT 0,
      pr_url TEXT, pr_number INTEGER, worktree_slug TEXT, ticket_id TEXT, spawned_team TEXT,
      sub_agent_count INTEGER, background_shell_count INTEGER, plan TEXT, machine TEXT, todos TEXT,
      recent_directories_touched TEXT, linear_project TEXT, linear_project_url TEXT, actor TEXT,
      initiated_by TEXT, used_browser INTEGER, used_computer INTEGER, archived_at INTEGER,
      mirror_synced_at INTEGER, mirror_source TEXT, phoenix_id TEXT
    );
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path, actor, initiated_by)
      VALUES ('legacy', 'legacy', 'codex', '2026-08-30T10:00:00.000Z', '/s/legacy.jsonl', 'ada@example.com', 'human');
    INSERT INTO meta(key, value) VALUES ('schema_version', '47');
  `);
  seed.close();
}

const { getDB, SCHEMA_VERSION } = await import('./db.js');

describe('schema migration v47 -> v48 (latest user turn, PHNX-3939)', () => {
  it('adds a nullable last_user_message column without damaging legacy rows', () => {
    const columns = (getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('last_user_message');
    const row = getDB()
      .prepare(`SELECT last_user_message, actor, file_path FROM sessions WHERE id = 'legacy'`)
      .get() as { last_user_message: string | null; actor: string | null; file_path: string };
    expect(row.last_user_message).toBeNull();
    expect(row.actor).toBe('ada@example.com');
    expect(row.file_path).toBe('/s/legacy.jsonl');
  });

  it('creates the session_timelines cache alongside it', () => {
    const tables = (getDB()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('session_timelines');
    const columns = (getDB().prepare(`PRAGMA table_info(session_timelines)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining([
      'session_id', 'file_mtime_ms', 'file_size', 'extractor_version', 'computed_at', 'projection_json', 'state_json',
    ]));
  });

  it('stamps the new schema version', () => {
    const row = getDB().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });
});
