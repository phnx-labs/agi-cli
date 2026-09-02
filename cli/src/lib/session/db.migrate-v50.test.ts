import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv50-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

{
  const seed = new Database(getSessionsDbPath());
  // Authentic v49 shape: the PHNX-3792 mirror columns, the PHNX-3798 phoenix_id
  // column, the PHNX-3939 last_user_message column, and the PHNX-3940 account_id
  // column all exist; the PHNX-3797 generated-title columns deliberately do not,
  // so getDB must add them through migrateSchema(49).
  seed.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, short_id TEXT NOT NULL, agent TEXT NOT NULL, harness TEXT,
      origin TEXT DEFAULT 'cli', routine_name TEXT, routine_run_id TEXT, version TEXT,
      account TEXT, account_key TEXT, account_org TEXT, account_id TEXT, mode TEXT, timestamp TEXT NOT NULL,
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT,
      first_user_message TEXT, last_user_message TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, input_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, cost_usd_nocache REAL,
      duration_ms INTEGER, model TEXT, tool_call_count INTEGER, file_path TEXT NOT NULL,
      file_mtime_ms INTEGER, file_size INTEGER, scanned_at INTEGER, is_team_origin INTEGER DEFAULT 0,
      pr_url TEXT, pr_number INTEGER, worktree_slug TEXT, ticket_id TEXT, spawned_team TEXT,
      sub_agent_count INTEGER, background_shell_count INTEGER, plan TEXT, machine TEXT, todos TEXT,
      recent_directories_touched TEXT, linear_project TEXT, linear_project_url TEXT, actor TEXT,
      initiated_by TEXT, used_browser INTEGER, used_computer INTEGER, archived_at INTEGER,
      mirror_synced_at INTEGER, mirror_source TEXT, phoenix_id TEXT
    );
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path, first_user_message, phoenix_id)
      VALUES ('legacy', 'legacy', 'codex', '2026-09-01T10:00:00.000Z', '/s/legacy.jsonl', 'fix the release gate', 'phx_ada');
    INSERT INTO meta(key, value) VALUES ('schema_version', '49');
  `);
  seed.close();
}

const { getDB, SCHEMA_VERSION, setSessionGeneratedTitle, getSessionById } = await import('./db.js');

describe('schema migration v49 -> v50 (daemon-generated session title, PHNX-3797)', () => {
  it('adds the nullable title columns without touching legacy rows', () => {
    const columns = (getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('generated_title');
    expect(columns).toContain('generated_title_key');
    expect(columns).toContain('generated_title_at');
    const row = getDB()
      .prepare(`SELECT generated_title, generated_title_key, first_user_message, phoenix_id FROM sessions WHERE id = 'legacy'`)
      .get() as {
        generated_title: string | null;
        generated_title_key: string | null;
        first_user_message: string;
        phoenix_id: string | null;
      };
    // An untitled legacy row stays untitled — the ladder falls back to the
    // user's own first message, which the migration must not have disturbed.
    expect(row.generated_title).toBeNull();
    expect(row.generated_title_key).toBeNull();
    expect(row.first_user_message).toBe('fix the release gate');
    // Earlier columns survive the v50 step — this migration is purely additive
    // and runs AFTER PHNX-3798's, PHNX-3939's, and PHNX-3940's, never in place of them.
    expect(row.phoenix_id).toBe('phx_ada');
    const version = getDB().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));
  });

  it('surfaces a written title on SessionMeta', () => {
    expect(setSessionGeneratedTitle('legacy', 'Release gate producer fix', 'abc123', 1_760_000_000_000)).toBe(true);
    expect(getSessionById('legacy')?.generatedTitle).toBe('Release gate producer fix');
  });
});
