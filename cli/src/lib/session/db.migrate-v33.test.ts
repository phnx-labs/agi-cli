import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv33-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const HISTORY = path.join(TEST_HOME, '.agents', '.history');

interface Acct { org: string; email: string; name: string; type: string }
const MODSQUAD: Acct = { org: 'org-ms', email: 'dev@modsquad.example', name: 'ModSquad', type: 'claude_team' };
const TURING: Acct = { org: 'org-tl', email: 'dev@turing.example', name: 'Turing Labs', type: 'claude_team' };
const PERSONAL: Acct = { org: 'org-pers', email: 'dev@turing.example', name: "dev's Org", type: 'claude_max' };

function writeHome(home: string, acct: Acct | null): void {
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', '.claude.json'),
    JSON.stringify(acct
      ? {
        oauthAccount: {
          accountUuid: `acct-${acct.org}`,
          emailAddress: acct.email,
          organizationUuid: acct.org,
          organizationName: acct.name,
          organizationType: acct.type,
        },
      }
      : { numStartups: 1 }),
  );
}

function vHome(v: string): string {
  return path.join(HISTORY, 'versions', 'claude', v, 'home');
}
function transcript(home: string, name: string): string {
  return path.join(home, '.claude', 'projects', '-proj', `${name}.jsonl`);
}

writeHome(vHome('2.1.219'), MODSQUAD);
writeHome(vHome('2.1.220'), TURING);
writeHome(vHome('2.1.218'), PERSONAL);
writeHome(vHome('2.1.170'), null);
fs.symlinkSync(path.join(vHome('2.1.219'), '.claude'), path.join(TEST_HOME, '.claude'));

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const Database = (await import('../sqlite.js')).default;

const SEED: Array<{ id: string; file_path: string; version: string | null; expectOrg: string | null }> = [
  { id: 'ms-1', file_path: transcript(vHome('2.1.219'), 'a'), version: '2.1.219', expectOrg: 'ModSquad' },
  { id: 'tl-1', file_path: transcript(vHome('2.1.220'), 'b'), version: '2.1.220', expectOrg: 'Turing Labs' },
  { id: 'pe-1', file_path: transcript(vHome('2.1.218'), 'c'), version: '2.1.218', expectOrg: "dev's Org" },
  { id: 'sym-1', file_path: path.join(TEST_HOME, '.claude', 'projects', '-proj', 'd.jsonl'), version: '2.1.220', expectOrg: 'Turing Labs' },
  { id: 'out-1', file_path: transcript(vHome('2.1.170'), 'e'), version: '2.1.170', expectOrg: null },
];

{
  const seed = new Database(getSessionsDbPath());
  seed.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, short_id TEXT NOT NULL, agent TEXT NOT NULL, origin TEXT DEFAULT 'cli',
      routine_name TEXT, routine_run_id TEXT, version TEXT, account TEXT, mode TEXT, timestamp TEXT NOT NULL,
      last_activity TEXT, project TEXT, cwd TEXT, git_branch TEXT, topic TEXT, label TEXT,
      message_count INTEGER, token_count INTEGER, output_tokens INTEGER, cost_usd REAL, duration_ms INTEGER,
      model TEXT, tool_call_count INTEGER, file_path TEXT NOT NULL, file_mtime_ms INTEGER, file_size INTEGER,
      scanned_at INTEGER, is_team_origin INTEGER DEFAULT 0, pr_url TEXT, pr_number INTEGER, worktree_slug TEXT,
      ticket_id TEXT, spawned_team TEXT, plan TEXT, machine TEXT, todos TEXT, recent_directories_touched TEXT,
      linear_project TEXT, linear_project_url TEXT, actor TEXT, initiated_by TEXT,
      used_browser INTEGER, used_computer INTEGER
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
    CREATE TABLE tool_scan_ledger (
      session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL, extractor_version INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
      call_count INTEGER NOT NULL, evidence_bytes INTEGER NOT NULL
    );
    CREATE TABLE resource_scan_ledger (
      session_id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL, extractor_version INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
      resource_count INTEGER NOT NULL
    );
    INSERT INTO meta(key, value) VALUES ('schema_version', '32');
  `);
  const ins = seed.prepare(`INSERT INTO sessions (id, short_id, agent, version, account, timestamp, file_path)
                            VALUES (?, ?, 'claude', ?, 'stale@wrong.example', '2026-07-01T00:00:00Z', ?)`);
  for (const row of SEED) ins.run(row.id, row.id, row.version, row.file_path);
  seed.prepare(`INSERT INTO sessions (id, short_id, agent, timestamp, file_path)
                VALUES ('cx-1', 'cx-1', 'codex', '2026-07-01T00:00:00Z', '/x/rollout.jsonl')`).run();
  const led = seed.prepare(`INSERT INTO scan_ledger VALUES (?, 1, 2, 3, NULL, NULL)`);
  for (const row of SEED) led.run(row.file_path);
  seed.close();
}

const { getDB, queryUsageRollup, closeDB } = await import('./db.js');

describe('schema migration v32 -> v33 (per-account attribution)', () => {
  it('adds account_key / account_org and its index', () => {
    const db = getDB();
    const cols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain('account_key');
    expect(cols).toContain('account_org');

    const idx = (db.prepare(`PRAGMA index_list(sessions)`).all() as Array<{ name: string }>)
      .map((i) => i.name);
    expect(idx).toContain('idx_sessions_account_key');
  });

  it('backfills each row to the account that actually produced it', () => {
    const db = getDB();
    const rows = db.prepare(
      `SELECT id, account_key, account_org, account FROM sessions WHERE agent='claude'`,
    ).all() as Array<{ id: string; account_key: string | null; account_org: string | null; account: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const seed of SEED) {
      const row = byId.get(seed.id)!;
      expect(row.account_org, `${seed.id} org`).toBe(seed.expectOrg);
      if (seed.expectOrg === null) {
        expect(row.account_key, `${seed.id} dark`).toContain('unattributed:');
        expect(row.account, `${seed.id} stale email cleared`).toBeNull();
      } else {
        expect(row.account_key, `${seed.id} key`).toContain('claude:org=');
      }
    }
  });

  it('produces distinct keys per org — the bug this migration fixes', () => {
    const db = getDB();
    const keys = (db.prepare(
      `SELECT DISTINCT account_key FROM sessions WHERE agent='claude' AND account_key LIKE 'claude:org=%'`,
    ).all() as Array<{ account_key: string }>).map((r) => r.account_key);
    expect(keys).toHaveLength(3);
  });

  it('keeps two orgs that share an email in separate buckets', () => {
    const db = getDB();
    const rows = db.prepare(
      `SELECT id, account, account_key FROM sessions WHERE id IN ('tl-1','pe-1')`,
    ).all() as Array<{ id: string; account: string; account_key: string }>;
    expect(rows[0].account).toBe(rows[1].account);
    expect(rows[0].account_key).not.toBe(rows[1].account_key);
  });

  it('does NOT wipe scan_ledger — attribution needs no re-parse', () => {
    const db = getDB();
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM scan_ledger`).get() as { n: number };
    expect(n).toBe(SEED.length);
  });

  it('leaves non-Claude rows untouched', () => {
    const db = getDB();
    const row = db.prepare(`SELECT account_key, account_org FROM sessions WHERE id='cx-1'`)
      .get() as { account_key: string | null; account_org: string | null };
    expect(row.account_key).toBeNull();
    expect(row.account_org).toBeNull();
  });

  it('rolls up by account, naming un-indexed rows instead of merging them', () => {
    const rows = queryUsageRollup({ groupBy: 'account' });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('unattributed:codex');
    const total = rows.reduce((s, r) => s + r.sessionCount, 0);
    expect(total).toBe(SEED.length + 1);
  });

  it('carries a human label for org keys, since a uuid is not display text', () => {
    const rows = queryUsageRollup({ groupBy: 'account' });
    const org = rows.find((r) => r.key.startsWith('claude:org='))!;
    expect(org.label).toMatch(/^.+ <.+@.+>$/);

    const dark = rows.find((r) => r.key === 'unattributed:codex')!;
    expect(dark.label ?? null).toBeNull();
  });

  it('groups by identity, not by label — same email, two orgs stays two rows', () => {
    const rows = queryUsageRollup({ groupBy: 'account' })
      .filter((r) => r.label?.includes('dev@turing.example'));
    expect(rows).toHaveLength(2);
  });
});

describe('v33 self-healing repair on an already-migrated DB', () => {
  it('clears a stale email left on a dark row and fills a NULL account_key', () => {
    const db = getDB();
    db.prepare(`UPDATE sessions SET account = 'stale@wrong.example' WHERE id = 'out-1'`).run();
    db.prepare(`UPDATE sessions SET account_key = NULL, account_org = NULL WHERE id = 'ms-1'`).run();

    closeDB();
    const repaired = getDB();

    const dark = repaired.prepare(`SELECT account, account_key FROM sessions WHERE id='out-1'`)
      .get() as { account: string | null; account_key: string };
    expect(dark.account).toBeNull();
    expect(dark.account_key).toContain('unattributed:');

    const refilled = repaired.prepare(`SELECT account_key, account_org FROM sessions WHERE id='ms-1'`)
      .get() as { account_key: string | null; account_org: string | null };
    expect(refilled.account_key).toContain('claude:org=');
    expect(refilled.account_org).toBe('ModSquad');
  });
});

describe('v33 repair safety', () => {

  it('repairs only broken rows, leaving an attributed row untouched', () => {
    closeDB();
    const db = getDB();
    db.prepare(
      `UPDATE sessions SET account_key='claude:org=org-gone', account_org='Gone Inc',
       account='was@here.example', version='9.9.999' WHERE id='tl-1'`,
    ).run();
    db.prepare(`UPDATE sessions SET account_key=NULL, account_org=NULL WHERE id='pe-1'`).run();

    closeDB();
    const repaired = getDB();

    const untouched = repaired.prepare(`SELECT account_key, account_org FROM sessions WHERE id='tl-1'`)
      .get() as { account_key: string; account_org: string };
    expect(untouched.account_key).toBe('claude:org=org-gone');
    expect(untouched.account_org).toBe('Gone Inc');

    const fixed = repaired.prepare(`SELECT account_key FROM sessions WHERE id='pe-1'`)
      .get() as { account_key: string };
    expect(fixed.account_key).toContain('claude:org=');
  });
});

