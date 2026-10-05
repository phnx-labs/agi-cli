import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv34-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

const SEED: Array<{ id: string; model: string; cost: number | null; file: string; invalidated: boolean }> = [
  { id: 'opus5-null', model: 'claude-opus-5', cost: null, file: '/w/opus5.jsonl', invalidated: true },
  { id: 'opus5-dated', model: 'claude-opus-5-20260714', cost: null, file: '/w/opus5-dated.jsonl', invalidated: true },
  { id: 'sonnet5-null', model: 'claude-sonnet-5', cost: null, file: '/w/sonnet5.jsonl', invalidated: true },
  { id: 'opus5-priced', model: 'claude-opus-5', cost: 1.25, file: '/w/priced.jsonl', invalidated: false },
  { id: 'opus48-null', model: 'claude-opus-4-8', cost: null, file: '/w/opus48.jsonl', invalidated: false },
  { id: 'fable-null', model: 'claude-fable-5', cost: null, file: '/w/fable.jsonl', invalidated: false },
];

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
    INSERT INTO meta(key, value) VALUES ('schema_version', '33');
  `);
  const ins = seed.prepare(`INSERT INTO sessions (id, short_id, agent, model, cost_usd, timestamp, file_path)
                            VALUES (?, ?, 'claude', ?, ?, '2026-07-01T00:00:00Z', ?)`);
  const led = seed.prepare(`INSERT INTO scan_ledger VALUES (?, 1, 2, 3, NULL, NULL)`);
  for (const r of SEED) { ins.run(r.id, r.id.slice(0, 8), r.model, r.cost, r.file); led.run(r.file); }
  seed.close();
}

const { getDB } = await import('./db.js');

describe('schema migration v33 -> v34 (reprice the Claude 5 line)', () => {
  it('invalidates exactly the mispriced transcripts and no others', () => {
    const db = getDB();
    const warm = new Set(
      (db.prepare(`SELECT file_path FROM scan_ledger`).all() as Array<{ file_path: string }>)
        .map((r) => r.file_path),
    );
    for (const r of SEED) {
      expect(warm.has(r.file), `${r.id} (${r.model}, cost=${r.cost}) should be ${r.invalidated ? 'invalidated' : 'warm'}`)
        .toBe(!r.invalidated);
    }
  });

  it('leaves the session rows themselves untouched — the rescan repairs them', () => {
    const db = getDB();
    const row = db.prepare(`SELECT cost_usd, model FROM sessions WHERE id = 'opus5-null'`)
      .get() as { cost_usd: number | null; model: string };
    expect(row.cost_usd).toBeNull();
    expect(row.model).toBe('claude-opus-5');
  });

});
