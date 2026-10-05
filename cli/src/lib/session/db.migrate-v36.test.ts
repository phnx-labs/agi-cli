import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate a fresh HOME BEFORE importing state/db. db.ts captures DB_PATH at module
// load (db.ts:29), so redirecting it after the import silently opens the wrong
// database. Every migration test in this directory uses this pattern.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv36-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

/** v35 -> v36: the tool index becomes incremental and its FTS rows addressable. `tool_scan_ledger`
 * gains resume columns (NULL means re-read from byte 0); each `tool_call_text` row sits at its
 * `tool_calls` rowid. Non-destructive: `tool_calls` untouched, no ledger wiped. */
const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

const CALLS = [
  { key: 'sess-a:0', session: 'sess-a', ordinal: 0, input: 'git rebase origin/main' },
  { key: 'sess-a:1', session: 'sess-a', ordinal: 1, input: 'gh pr checks 2208' },
  { key: 'sess-b:0', session: 'sess-b', ordinal: 0, input: 'rg needle-in-evidence' },
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
    CREATE TABLE dir_ledger (
      dir_path TEXT PRIMARY KEY, dir_mtime_ms INTEGER NOT NULL, entry_count INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE session_text USING fts5(session_id UNINDEXED, label, topic, project, content);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE scan_ledger (
      file_path TEXT PRIMARY KEY, file_mtime_ms INTEGER NOT NULL, file_size INTEGER NOT NULL,
      scanned_at INTEGER NOT NULL, parser_state TEXT, content_text TEXT
    );
    CREATE TABLE tool_calls (
      call_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      source_call_id TEXT, timestamp TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      outcome TEXT NOT NULL, exit_code INTEGER, status_code INTEGER, error_code TEXT,
      output TEXT, error TEXT, parse_error TEXT, evidence_bytes INTEGER NOT NULL,
      UNIQUE(session_id, ordinal)
    );
    CREATE VIRTUAL TABLE tool_call_text USING fts5(
      call_key UNINDEXED, tool, input, output, error, tokenize = 'trigram'
    );
    CREATE TABLE tool_scan_ledger (
      session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL, extractor_version INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
      call_count INTEGER NOT NULL, evidence_bytes INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '35');
  `);
  const call = seed.prepare(`
    INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, tool, input, outcome, evidence_bytes)
    VALUES (?, ?, ?, '2026-08-03T00:00:00Z', 'Bash', ?, 'unknown', 64)
  `);
  const text = seed.prepare(`INSERT INTO tool_call_text (call_key, tool, input, output, error) VALUES (?, 'Bash', ?, '', '')`);
  // Insert the text rows in a different order than the calls, so a passing rowid
  // assertion cannot be an accident of both tables counting from 1 in step.
  for (const row of CALLS) call.run(row.key, row.session, row.ordinal, row.input);
  for (const row of [...CALLS].reverse()) text.run(row.key, row.input);
  seed.prepare(`INSERT INTO scan_ledger VALUES ('/w/a.jsonl', 1, 2, 3, NULL, NULL)`).run();
  seed.prepare(`
    INSERT INTO tool_scan_ledger VALUES ('sess-a', '/w/a.jsonl', 1, 2, 9, 3, 2, 128)
  `).run();
  seed.close();
}

const { getDB } = await import('./db.js');

describe('schema migration v35 -> v36 (incremental tool index)', () => {
  it('adds the resume columns as NULL, leaving both ledgers warm', () => {
    const db = getDB();
    expect(db.prepare(`SELECT session_id, call_count, parser_state, parsed_offset FROM tool_scan_ledger`).get())
      .toEqual({ session_id: 'sess-a', call_count: 2, parser_state: null, parsed_offset: null });
    expect(db.prepare(`SELECT count(*) AS n FROM scan_ledger`).get()).toEqual({ n: 1 });
  });

  it('rebuilds tool_call_text at the rowid of the call each row describes', () => {
    const db = getDB();
    const mismatched = db.prepare(`
      SELECT t.call_key FROM tool_call_text t
      LEFT JOIN tool_calls c ON c.rowid = t.rowid
      WHERE c.call_key IS NULL OR c.call_key <> t.call_key
    `).all();
    expect(mismatched).toEqual([]);
    expect(db.prepare(`SELECT count(*) AS n FROM tool_call_text`).get()).toEqual({ n: CALLS.length });
  });

  it('keeps every call searchable and every tool_calls row intact', () => {
    const db = getDB();
    expect(db.prepare(`SELECT count(*) AS n FROM tool_calls`).get()).toEqual({ n: CALLS.length });
    expect(db.prepare(`
      SELECT call_key FROM tool_call_text WHERE tool_call_text MATCH '"needle-in-evidence"'
    `).all()).toEqual([{ call_key: 'sess-b:0' }]);
  });

});
