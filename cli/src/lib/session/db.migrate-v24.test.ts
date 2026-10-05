import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv23-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;
{
  const seed = new Database(getSessionsDbPath());
  seed.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, short_id TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT DEFAULT 'cli',
      routine_name TEXT, routine_run_id TEXT, version TEXT, account TEXT, timestamp TEXT NOT NULL,
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, cost_usd REAL, duration_ms INTEGER,
      model TEXT, tool_call_count INTEGER, file_path TEXT NOT NULL, file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER,
      is_team_origin INTEGER DEFAULT 0, pr_url TEXT, pr_number INTEGER, worktree_slug TEXT, ticket_id TEXT,
      spawned_team TEXT, plan TEXT, machine TEXT, todos TEXT, recent_directories_touched TEXT,
      linear_project TEXT, linear_project_url TEXT, actor TEXT, initiated_by TEXT,
      used_browser INTEGER, used_computer INTEGER
    );
    CREATE VIRTUAL TABLE session_text USING fts5(session_id UNINDEXED, label, topic, project, content);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scan_ledger (
      file_path TEXT PRIMARY KEY, file_mtime_ms INTEGER NOT NULL, file_size INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL, parser_state TEXT, content_text TEXT
    );
    CREATE TABLE dir_ledger (
      dir_path TEXT PRIMARY KEY, dir_mtime_ms INTEGER NOT NULL, entry_count INTEGER NOT NULL, scanned_at INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '23');
    INSERT INTO scan_ledger VALUES ('/warm/session.jsonl', 1, 2, 3, NULL, NULL);
  `);
  seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path)
                VALUES ('v23-1', 'v23-1', 'claude', '2026-07-01T00:00:00Z', '/warm/session.jsonl')`).run();
  seed.close();
}

const { getDB, SCHEMA_VERSION } = await import('./db.js');

describe('schema migration v23 -> v24 (session_resource_usage, #12)', () => {
  it('creates the session_resource_usage table with the expected columns', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(session_resource_usage)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['session_id', 'kind', 'name', 'plugin', 'source', 'repo_root', 'snapshot_sha', 'count']);
  });

  it('the table is immediately writable and enforces one row per (session, kind, name)', () => {
    const db = getDB();
    db.prepare(`
      INSERT INTO session_resource_usage (session_id, kind, name, plugin, source, repo_root, snapshot_sha, count)
      VALUES ('v23-1', 'skill', 'teams', NULL, 'user', '/home/u/.agents', 'abc1234', 3)
    `).run();
    const row = db.prepare(`SELECT * FROM session_resource_usage WHERE session_id = 'v23-1'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ kind: 'skill', name: 'teams', count: 3, source: 'user', repo_root: '/home/u/.agents', snapshot_sha: 'abc1234' });

    expect(() =>
      db.prepare(`
        INSERT INTO session_resource_usage (session_id, kind, name, count)
        VALUES ('v23-1', 'skill', 'teams', 1)
      `).run()
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it('does NOT clear scan_ledger — this table is populated independently at upsert time', () => {
    const db = getDB();
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM scan_ledger`).get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('preserves existing session rows (including earlier columns) through the migration', () => {
    const db = getDB();
    const row = db.prepare(`SELECT agent, used_browser FROM sessions WHERE id = 'v23-1'`).get() as { agent: string; used_browser: number | null };
    expect(row.agent).toBe('claude');
    expect(row.used_browser).toBeNull();
  });

  it('bumps the recorded schema version to the current version', () => {
    const db = getDB();
    const v = (db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value;
    expect(v).toBe(String(SCHEMA_VERSION));
  });
});
