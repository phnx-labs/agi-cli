import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv22-'));
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
      linear_project TEXT, linear_project_url TEXT, actor TEXT, initiated_by TEXT
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
    INSERT INTO meta(key, value) VALUES ('schema_version', '22');
    INSERT INTO scan_ledger VALUES ('/warm/session.jsonl', 1, 2, 3, NULL, NULL);
  `);
  seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path)
                VALUES ('v22-1', 'v22-1', 'claude', '2026-07-01T00:00:00Z', '/warm/session.jsonl')`).run();
  seed.close();
}

const { getDB, SCHEMA_VERSION } = await import('./db.js');

describe('schema migration v22 -> v23 (usedBrowser/usedComputer, #11)', () => {
  it('adds used_browser and used_computer columns, NULL (not 0) on a pre-existing row', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; dflt_value: string | null }>);
    const usedBrowser = cols.find((c) => c.name === 'used_browser');
    const usedComputer = cols.find((c) => c.name === 'used_computer');
    expect(usedBrowser).toBeTruthy();
    expect(usedBrowser?.dflt_value).toBeNull();
    expect(usedComputer).toBeTruthy();
    expect(usedComputer?.dflt_value).toBeNull();

    const row = db.prepare(`SELECT used_browser, used_computer FROM sessions WHERE id = 'v22-1'`).get() as {
      used_browser: number | null;
      used_computer: number | null;
    };
    expect(row.used_browser).toBeNull();
    expect(row.used_computer).toBeNull();
  });

  it('does NOT clear scan_ledger — the value is derived from the events log, not the transcript ledger', () => {
    const db = getDB();
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM scan_ledger`).get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('bumps the recorded schema version to the current version', () => {
    const db = getDB();
    const v = (db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value;
    expect(v).toBe(String(SCHEMA_VERSION));
  });
});
