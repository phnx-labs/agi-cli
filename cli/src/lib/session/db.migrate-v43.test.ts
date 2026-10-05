import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv43-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

{
  const seed = new Database(getSessionsDbPath());
  seed.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE tool_calls (
      call_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      source_call_id TEXT, timestamp TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      outcome TEXT NOT NULL, exit_code INTEGER, status_code INTEGER, error_code TEXT,
      output TEXT, error TEXT, parse_error TEXT, evidence_bytes INTEGER NOT NULL,
      UNIQUE(session_id, ordinal)
    );
    INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, tool, input, outcome, error, evidence_bytes)
      VALUES ('pre43-0', 'sess-pre43', 0, '2026-08-27T00:00:00.000Z', 'Bash', 'get_user_location', 'error', 'stdin closed', 64);
    INSERT INTO meta(key, value) VALUES ('schema_version', '42');
  `);
  seed.close();
}

const { getDB, SCHEMA_VERSION } = await import('./db.js');

function recordedVersion(): string | undefined {
  const row = getDB()
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  return row?.value;
}

describe('schema migration v42 -> v43 (per-tool-call end timestamp, PHNX-3437)', () => {
  it('adds the end_timestamp column and stamps the new version', () => {
    const cols = (getDB().prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('end_timestamp');
    expect(recordedVersion()).toBe(String(SCHEMA_VERSION));
  });

  it('leaves the pre-upgrade row intact with a NULL end_timestamp', () => {
    const row = getDB()
      .prepare(`SELECT tool, outcome, error, end_timestamp FROM tool_calls WHERE call_key = 'pre43-0'`)
      .get() as { tool: string; outcome: string; error: string; end_timestamp: string | null };
    expect(row).toEqual({
      tool: 'Bash', outcome: 'error', error: 'stdin closed', end_timestamp: null,
    });
  });

  it('accepts a write carrying an end timestamp and reads it back', () => {
    const db = getDB();
    db.prepare(`
      INSERT INTO tool_calls (call_key, session_id, ordinal, timestamp, end_timestamp, tool, input, outcome, evidence_bytes)
      VALUES ('post43-0', 'sess-post43', 0, '2026-08-27T00:00:00.000Z', '2026-08-27T00:05:30.000Z', 'Bash', 'x', 'error', 32)
    `).run();
    const row = db.prepare(`SELECT end_timestamp FROM tool_calls WHERE call_key = 'post43-0'`).get();
    expect(row).toEqual({ end_timestamp: '2026-08-27T00:05:30.000Z' });
  });
});
