import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv47-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

{
  const seed = new Database(getSessionsDbPath());
  // Authentic v46 shape: the PHNX-3792 mirror provenance columns exist, but the
  // PHNX-3798 phoenix_id column is deliberately absent so getDB must add it
  // through migrateSchema(46).
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
      mirror_synced_at INTEGER, mirror_source TEXT
    );
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path, actor, initiated_by)
      VALUES ('legacy', 'legacy', 'codex', '2026-08-30T10:00:00.000Z', '/s/legacy.jsonl', 'ada@example.com', 'human');
    INSERT INTO meta(key, value) VALUES ('schema_version', '46');
  `);
  seed.close();
}

const { getDB, closeDB, SCHEMA_VERSION, getSessionById, upsertSession } = await import('./db.js');

describe('schema migration v46 -> v47 (actor Phoenix id, PHNX-3798)', () => {
  it('adds a nullable phoenix_id column without damaging legacy rows', () => {
    const columns = (getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('phoenix_id');
    const row = getDB()
      .prepare(`SELECT phoenix_id, actor, file_path FROM sessions WHERE id = 'legacy'`)
      .get() as { phoenix_id: string | null; actor: string | null; file_path: string };
    // A legacy row indexed before Phoenix-id stamping stays NULL; its actor and
    // content are untouched by the additive migration.
    expect(row.phoenix_id).toBeNull();
    expect(row.actor).toBe('ada@example.com');
    expect(row.file_path).toBe('/s/legacy.jsonl');
  });

  it('stamps the new schema version', () => {
    const row = getDB().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(row.value).toBe(String(SCHEMA_VERSION));
  });

  it('repairs a current-version index missing phoenix_id and preserves its metadata', () => {
    const db = getDB();
    db.prepare(`UPDATE sessions SET account_id = ?, generated_title = ? WHERE id = 'legacy'`)
      .run('account-legacy', 'Existing session title');
    db.exec('ALTER TABLE sessions DROP COLUMN phoenix_id');
    closeDB();

    const repaired = getDB();
    expect(repaired.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get())
      .toEqual({ value: String(SCHEMA_VERSION) });
    expect(repaired.prepare(`SELECT account_id, generated_title, actor, file_path, phoenix_id FROM sessions WHERE id = 'legacy'`).get())
      .toEqual({ account_id: 'account-legacy', generated_title: 'Existing session title', actor: 'ada@example.com', file_path: '/s/legacy.jsonl', phoenix_id: null });

    const session = getSessionById('legacy');
    expect(session).not.toBeNull();
    upsertSession({ ...session!, phoenixId: 'phx_ada' }, 'Recovered session');
    closeDB();
    expect(getSessionById('legacy')?.phoenixId).toBe('phx_ada');
  });
});
