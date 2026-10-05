import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv10-'));
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
      version TEXT,
      account TEXT,
      timestamp TEXT NOT NULL,
      last_activity TEXT,
      project TEXT,
      cwd TEXT,
      git_branch TEXT,
      topic TEXT,
      label TEXT,
      name TEXT,
      message_count INTEGER,
      token_count INTEGER,
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
      ticket_id TEXT
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
    INSERT INTO meta(key, value) VALUES ('schema_version', '9');
  `);
  seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path, name)
                VALUES ('mig-1', 'mig-1', 'claude', '2026-07-01T00:00:00Z', '', 'my-run')`).run();
  seed.prepare(`INSERT INTO session_text (session_id, label, topic, project, content)
                VALUES ('mig-1', '', '', '', '')`).run();
  seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path, label, name)
                VALUES ('mig-2', 'mig-2', 'claude', '2026-07-01T00:00:00Z', '', 'Real Title', 'seed-loses')`).run();
  seed.prepare(`INSERT INTO session_text (session_id, label, topic, project, content)
                VALUES ('mig-2', 'Real Title', '', '', '')`).run();
  seed.close();
}

const { getDB, getSessionById, ftsSearch } = await import('./db.js');

describe('schema migration v9 -> v10 (name unifies into label)', () => {
  it('drops the separate `name` column', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).not.toContain('name');
  });

  it('folds a --name into label where the label was empty (no data loss)', () => {
    expect(getSessionById('mig-1')?.label).toBe('my-run');
    expect(ftsSearch('my-run')[0]?.sessionId).toBe('mig-1');
  });

  it('preserves an existing label; the redundant name is discarded', () => {
    expect(getSessionById('mig-2')?.label).toBe('Real Title');
    expect(ftsSearch('seed-loses').some(h => h.score >= 800_000)).toBe(false);
  });
});
