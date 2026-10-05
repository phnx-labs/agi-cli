import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv14-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;
{
  const seed = new Database(getSessionsDbPath());
  seed.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      origin TEXT DEFAULT 'cli',
      routine_name TEXT,
      routine_run_id TEXT,
      version TEXT,
      account TEXT,
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
      cost_usd REAL,
      duration_ms INTEGER,
      file_path TEXT NOT NULL,
      file_mtime_ms INTEGER,
      file_size INTEGER,
      scanned_at INTEGER,
      is_team_origin INTEGER DEFAULT 0,
      pr_url TEXT,
      pr_number INTEGER,
      worktree_slug TEXT,
      ticket_id TEXT,
      plan TEXT
    );
    CREATE VIRTUAL TABLE session_text USING fts5(
      session_id UNINDEXED, label, topic, project, content,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scan_ledger (
      file_path TEXT PRIMARY KEY, file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL, scanned_at INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '13');
  `);
  seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path)
                VALUES ('v14-1', 'v14-1', 'claude', '2026-07-01T00:00:00Z', '/tmp/x.jsonl')`).run();
  seed.prepare(`INSERT INTO session_text (session_id, label, topic, project, content)
                VALUES ('v14-1', '', '', '', 'hello world')`).run();
  seed.prepare(`INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at)
                VALUES ('/tmp/x.jsonl', 111, 222, 333)`).run();
  seed.close();
}

const { getDB, getSessionById, SCHEMA_VERSION } = await import('./db.js');

describe('schema migration v13 -> current (dir_ledger + resumable parser)', () => {
  it('creates the dir_ledger table with the expected columns (v14)', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(dir_ledger)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(['dir_path', 'dir_mtime_ms', 'entry_count', 'scanned_at']);
  });

  it('adds parser_state + content_text to scan_ledger (v15)', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(scan_ledger)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('parser_state');
    expect(cols).toContain('content_text');
  });

  it('clears scan_ledger so the first post-upgrade scan does a clean full walk', () => {
    const db = getDB();
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM scan_ledger`).get() as { c: number }).c;
    expect(n).toBe(0);
  });

  it('bumps the recorded schema version to the current version', () => {
    const db = getDB();
    const v = (db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value;
    expect(v).toBe(String(SCHEMA_VERSION));
  });

  it('preserves existing session rows through the migration', () => {
    expect(getSessionById('v14-1')?.agent).toBe('claude');
  });
});
