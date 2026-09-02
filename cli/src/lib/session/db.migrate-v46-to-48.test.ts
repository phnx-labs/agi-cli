import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv46to48-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

{
  const seed = new Database(getSessionsDbPath());
  // Authentic v46 shape: the PHNX-3792 mirror provenance columns exist, but NEITHER
  // the PHNX-3798 phoenix_id column NOR the PHNX-3797 generated-title columns do.
  // A real box on v46 upgrading straight to v48 (skipping no releases, just landing
  // both merged migrations at once) must get BOTH — the collision-resolution case
  // this whole rebase turned on (v47 = phoenix_id, v48 = generated_title*).
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
    INSERT INTO sessions (id, short_id, agent, timestamp, file_path, first_user_message, actor)
      VALUES ('legacy', 'legacy', 'codex', '2026-08-29T10:00:00.000Z', '/s/legacy.jsonl', 'triage the AGI board', 'ada@example.com');
    INSERT INTO meta(key, value) VALUES ('schema_version', '46');
  `);
  seed.close();
}

const { getDB, SCHEMA_VERSION, setSessionGeneratedTitle, getSessionById } = await import('./db.js');

describe('schema migration v46 -> v48 (both merged migrations land, neither dropped)', () => {
  it('adds phoenix_id (<47, PHNX-3798) AND the generated-title columns (<48, PHNX-3797) in one upgrade', () => {
    const columns = (getDB().prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    // PHNX-3798's column (the v47 rung).
    expect(columns).toContain('phoenix_id');
    // PHNX-3797's columns (the v48 rung).
    expect(columns).toContain('generated_title');
    expect(columns).toContain('generated_title_key');
    expect(columns).toContain('generated_title_at');
    // The DB is stamped at the combined head, not stranded at 47.
    const version = getDB().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(version.value).toBe(String(SCHEMA_VERSION));
    expect(SCHEMA_VERSION).toBe(48);
  });

  it('leaves the legacy row intact — additive columns start NULL, existing content untouched', () => {
    const row = getDB()
      .prepare(`SELECT phoenix_id, generated_title, generated_title_key, first_user_message, actor FROM sessions WHERE id = 'legacy'`)
      .get() as {
        phoenix_id: string | null;
        generated_title: string | null;
        generated_title_key: string | null;
        first_user_message: string;
        actor: string;
      };
    expect(row.phoenix_id).toBeNull();
    expect(row.generated_title).toBeNull();
    expect(row.generated_title_key).toBeNull();
    // The user's own words survive to be the ladder's honest fallback headline.
    expect(row.first_user_message).toBe('triage the AGI board');
    expect(row.actor).toBe('ada@example.com');
  });

  it('the new generated_title column is writable after the combined migration', () => {
    expect(setSessionGeneratedTitle('legacy', 'Triage the AGI board', 'k46to48', 1_760_000_000_000)).toBe(true);
    expect(getSessionById('legacy')?.generatedTitle).toBe('Triage the AGI board');
  });
});
