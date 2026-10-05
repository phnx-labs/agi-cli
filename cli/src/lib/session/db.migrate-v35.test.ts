import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv35-'));
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
      routine_name TEXT, routine_run_id TEXT, version TEXT, account TEXT, account_key TEXT,
      account_org TEXT, mode TEXT, timestamp TEXT NOT NULL, last_activity TEXT, project TEXT,
      cwd TEXT, git_branch TEXT, topic TEXT, label TEXT, message_count INTEGER, token_count INTEGER,
      output_tokens INTEGER, cost_usd REAL, duration_ms INTEGER, model TEXT, tool_call_count INTEGER,
      file_path TEXT NOT NULL, file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER,
      is_team_origin INTEGER DEFAULT 0, pr_url TEXT, pr_number INTEGER, worktree_slug TEXT,
      ticket_id TEXT, spawned_team TEXT, plan TEXT, machine TEXT, todos TEXT,
      recent_directories_touched TEXT, linear_project TEXT, linear_project_url TEXT,
      actor TEXT, initiated_by TEXT, used_browser INTEGER, used_computer INTEGER
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
    INSERT INTO meta(key, value) VALUES ('schema_version', '34');
  `);
  const ins = seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, last_activity, file_path)
                            VALUES (?, ?, 'claude', ?, ?, ?)`);
  ins.run('legacy-null', 'legacynul', '2026-01-01T00:00:00Z', null, '/w/legacy.jsonl');
  ins.run('has-activity', 'hasactivi', '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', '/w/has.jsonl');
  seed.close();
}

const { getDB } = await import('./db.js');

describe('schema migration v34 -> v35 (bare-column last_activity sort)', () => {
  it('backfills NULL last_activity from timestamp and leaves a populated one untouched', () => {
    const db = getDB();
    const rows = db.prepare(`SELECT id, last_activity, timestamp FROM sessions ORDER BY id`)
      .all() as Array<{ id: string; last_activity: string | null; timestamp: string }>;
    const legacy = rows.find(r => r.id === 'legacy-null')!;
    const withActivity = rows.find(r => r.id === 'has-activity')!;
    expect(legacy.last_activity).toBe(legacy.timestamp);
    expect(withActivity.last_activity).toBe('2026-03-01T00:00:00Z');
  });

  it('no row is left with a NULL last_activity after migration', () => {
    const db = getDB();
    const nullCount = (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE last_activity IS NULL`).get() as { c: number }).c;
    expect(nullCount).toBe(0);
  });

});
