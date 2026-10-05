import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv46-'));
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
      initiated_by TEXT, used_browser INTEGER, used_computer INTEGER, archived_at INTEGER
    );
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path)
      VALUES ('legacy', 'legacy', 'codex', '2026-08-30T10:00:00.000Z', '/s/legacy.jsonl');
    INSERT INTO meta(key, value) VALUES ('schema_version', '45');
  `);
  seed.close();
}

const { getDB, SCHEMA_VERSION } = await import('./db.js');

describe('schema migration v45 -> v46 (session mirror provenance, PHNX-3792)', () => {
  it('adds nullable mirror_synced_at + mirror_source columns without damaging legacy rows', () => {
    const columns = (getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('mirror_synced_at');
    expect(columns).toContain('mirror_source');
    const row = getDB()
      .prepare(`SELECT mirror_synced_at, mirror_source, file_path FROM sessions WHERE id = 'legacy'`)
      .get() as { mirror_synced_at: number | null; mirror_source: string | null; file_path: string };
    expect(row.mirror_synced_at).toBeNull();
    expect(row.mirror_source).toBeNull();
    expect(row.file_path).toBe('/s/legacy.jsonl');
  });

  it('builds the mirror-prune scan index and stamps the new schema version', () => {
    const indexes = (getDB().prepare(`PRAGMA index_list(sessions)`).all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain('idx_sessions_mirror_synced');
    const row = getDB().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });
});
