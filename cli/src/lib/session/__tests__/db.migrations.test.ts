import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Set HOME before db.js loads so its module-level DB path picks up the override.
// (Plain top-level statements run before the dynamic `await import` below.)
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-db-migrations-'));
process.env.HOME = TEST_HOME;

const { getDB, closeDB, upsertSession, getSessionById, SCHEMA_VERSION } = await import('../db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

function openDBInChild(): Promise<void> {
  const dbModule = new URL('../db.ts', import.meta.url).href;
  const script = `import { getDB, closeDB } from ${JSON.stringify(dbModule)}; getDB(); closeDB();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      env: { ...process.env, HOME: TEST_HOME, USERPROFILE: TEST_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child database open exited ${code}: ${stderr}`));
    });
  });
}

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('empty-shortId repair migration (v16)', () => {
  it('heals a row the pre-fix parser left with an empty short_id', () => {
    // Reproduce the corruption: a bare-prefix id whose shortId stripped to ''.
    // upsertSession binds meta.shortId verbatim (deriveShortId lives in the
    // parsers, not here), so '' lands in the index exactly as the old code did.
    const corrupt = {
      id: 'session_',
      shortId: '',
      agent: 'rush',
      timestamp: '2026-07-31T20:00:00.000Z',
      filePath: '/tmp/gone/session_/messages.jsonl',
    } as SessionMeta;
    upsertSession(corrupt, 'hello bare prefix');
    expect(getSessionById('session_')?.shortId).toBe(''); // corruption reproduced

    // Simulate an un-migrated (pre-v16) DB and reopen so migrateSchema runs.
    const db = getDB();
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '15')`).run();
    closeDB();

    getDB(); // reopen -> currentVersion 15 < SCHEMA_VERSION -> v16 repair runs
    const healed = getSessionById('session_');
    expect(healed?.shortId).toBe('session_'); // substr(id,1,8), non-empty + addressable
    expect(healed?.shortId).not.toBe('');
  });
});

describe('harness column migration (v41)', () => {
  it('adds the harness column to a v40 index', () => {
    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN harness`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '40')`).run();
    closeDB();

    const reopened = getDB();
    const cols = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('harness');
  });

  it('adds the harness column when schema_version is missing (migrateSchema skipped)', () => {
    // currentVersion === undefined stamps SCHEMA_VERSION and never calls
    // migrateSchema. The v41 ALTER lives only inside migrateSchema, so a
    // sessions table that already exists without `harness` would stay that
    // way — and the next upsertSession INSERT naming the column would throw
    // — unless the unconditional post-migration repair adds it (PHNX-2935).
    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN harness`);
    db.prepare(`DELETE FROM meta WHERE key = 'schema_version'`).run();
    closeDB();

    const reopened = getDB();
    const cols = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('harness');
    const stamped = reopened.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(Number(stamped.value)).toBe(SCHEMA_VERSION);

    expect(() => upsertSession({
      id: 'harness-repair-undefined',
      shortId: 'hrepair',
      agent: 'claude',
      harness: 'deepseek',
      timestamp: '2026-08-27T00:00:00.000Z',
      filePath: '/tmp/harness-repair/session.jsonl',
    } as SessionMeta, 'custom harness stamp')).not.toThrow();
    expect(getSessionById('harness-repair-undefined')?.harness).toBe('deepseek');
  });
});

describe('model column migration (v20)', () => {
  it('adds the model column to a v19 index', () => {
    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN model`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '19')`).run();
    closeDB();

    const reopened = getDB();
    const cols = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('model');
  });
});

describe('spawned_team column migration (v21)', () => {
  it('adds the spawned_team column to a v20 index', () => {
    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN spawned_team`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '20')`).run();
    closeDB();

    const reopened = getDB();
    const cols = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('spawned_team');
  });

  it('clears BOTH ledgers so already-scanned dirs get re-parsed for the new column', () => {
    // scan_ledger alone is not enough: with dir_ledger intact,
    // collectChangedFilesInLeafDirs treats an unchanged dir's files as cold and
    // skips them, so their spawned_team would stay NULL forever.
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/stale/session.jsonl', 1, 1, 1);
    db.prepare(
      `INSERT OR REPLACE INTO dir_ledger(dir_path, dir_mtime_ms, entry_count, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/stale', 1, 1, 1);
    db.exec(`ALTER TABLE sessions DROP COLUMN spawned_team`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '20')`).run();
    closeDB();

    const reopened = getDB();
    expect((reopened.prepare(`SELECT COUNT(*) AS n FROM scan_ledger`).get() as { n: number }).n).toBe(0);
    expect((reopened.prepare(`SELECT COUNT(*) AS n FROM dir_ledger`).get() as { n: number }).n).toBe(0);
  });
});

describe('prerelease schema collision repair (v30)', () => {
  it('atomically repairs concurrent v29 opens and runs only once', async () => {
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`,
    ).run('/tmp/prerelease/session.jsonl', 1, 1, 1);
    db.prepare(
      `INSERT OR REPLACE INTO dir_ledger(dir_path, dir_mtime_ms, entry_count, scanned_at) VALUES (?, ?, ?, ?)`,
    ).run('/tmp/prerelease', 1, 1, 1);
    db.exec(`ALTER TABLE sessions DROP COLUMN tool_call_count`);
    db.exec(`ALTER TABLE sessions DROP COLUMN used_browser`);
    db.exec(`ALTER TABLE sessions DROP COLUMN used_computer`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '29')`).run();
    closeDB();

    await Promise.all([openDBInChild(), openDBInChild()]);

    const reopened = getDB();
    const columns = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toContain('tool_call_count');
    expect(columns).toContain('used_browser');
    expect(columns).toContain('used_computer');
    expect(reopened.prepare(`SELECT count(*) AS n FROM scan_ledger`).get()).toEqual({ n: 0 });
    expect(reopened.prepare(`SELECT count(*) AS n FROM dir_ledger`).get()).toEqual({ n: 0 });

    reopened.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`,
    ).run('/tmp/warm-after-repair/session.jsonl', 2, 2, 2);
    reopened.prepare(
      `INSERT OR REPLACE INTO dir_ledger(dir_path, dir_mtime_ms, entry_count, scanned_at) VALUES (?, ?, ?, ?)`,
    ).run('/tmp/warm-after-repair', 2, 2, 2);
    closeDB();
    const secondOpen = getDB();
    expect(secondOpen.prepare(`SELECT count(*) AS n FROM scan_ledger`).get()).toEqual({ n: 1 });
    expect(secondOpen.prepare(`SELECT count(*) AS n FROM dir_ledger`).get()).toEqual({ n: 1 });

    upsertSession(
      {
        id: 'repaired-tool-count',
        shortId: 'repaired',
        agent: 'claude',
        timestamp: '2026-08-04T00:00:00.000Z',
        filePath: '/tmp/prerelease/session.jsonl',
        toolCallCount: 3,
      } as SessionMeta,
      'three calls',
    );
    expect(getSessionById('repaired-tool-count')?.toolCallCount).toBe(3);
  });
});

describe('tool-call index migration (v25)', () => {
  it('adds the independent schema without invalidating warm session ledgers', () => {
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/warm/session.jsonl', 1, 1, 1);
    db.prepare(
      `INSERT OR REPLACE INTO dir_ledger(dir_path, dir_mtime_ms, entry_count, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/warm', 1, 1, 1);
    db.exec(`
      DROP TABLE tool_call_text;
      DROP TABLE tool_call_programs;
      DROP TABLE tool_calls;
      DROP TABLE tool_scan_ledger;
    `);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '24')`).run();
    closeDB();

    const reopened = getDB();
    const tables = (reopened.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view')`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toContain('tool_calls');
    expect(tables).toContain('tool_call_programs');
    expect(tables).toContain('tool_scan_ledger');
    expect((reopened.prepare(`PRAGMA table_info(tool_calls)`).all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('evidence_bytes');
    expect((reopened.prepare(`PRAGMA table_info(tool_scan_ledger)`).all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('evidence_bytes');
    expect((reopened.prepare(`SELECT count(*) AS n FROM scan_ledger`).get() as { n: number }).n).toBeGreaterThan(0);
    expect((reopened.prepare(`SELECT count(*) AS n FROM dir_ledger`).get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('tool-call trigram migration (v27)', () => {
  it('rebuilds FTS from redacted rows while the later occurrence migration keeps the normal ledger warm', () => {
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/trigram/session.jsonl', 1, 1, 1);
    db.prepare(`
      INSERT OR REPLACE INTO tool_calls (
        call_key, session_id, ordinal, timestamp, tool, input, outcome, evidence_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('trigram-call', 'trigram-session', 0, '2026-08-03T00:00:00Z', 'Bash', 'git merge topic', 'unknown', 15);
    db.prepare(`
      INSERT OR REPLACE INTO tool_scan_ledger (
        session_id, file_path, file_mtime_ms, file_size, extractor_version, indexed_at, call_count, evidence_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('trigram-session', '/tmp/trigram/session.jsonl', 1, 1, 1, 1, 1, 15);
    db.exec(`
      DROP TABLE tool_call_text;
      CREATE VIRTUAL TABLE tool_call_text USING fts5(
        call_key UNINDEXED, tool, input, output, error,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      INSERT INTO tool_call_text VALUES ('trigram-call', 'Bash', 'git merge topic', '', '');
    `);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '26')`).run();
    closeDB();

    const reopened = getDB();
    expect(reopened.prepare(`SELECT call_key FROM tool_call_text WHERE tool_call_text MATCH ?`).all('input:erge'))
      .toEqual([{ call_key: 'trigram-call' }]);
    expect(reopened.prepare(`SELECT count(*) AS n FROM scan_ledger WHERE file_path = ?`).get('/tmp/trigram/session.jsonl'))
      .toEqual({ n: 1 });
    expect(reopened.prepare(`SELECT count(*) AS n FROM tool_scan_ledger WHERE file_path = ?`).get('/tmp/trigram/session.jsonl'))
      .toEqual({ n: 0 });
  });
});

describe('tool program occurrence migration (v28)', () => {
  it('adds ordered occurrences and invalidates only the derived tool ledger', () => {
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/occurrences/session.jsonl', 1, 1, 1);
    db.prepare(`
      INSERT OR REPLACE INTO tool_scan_ledger (
        session_id, file_path, file_mtime_ms, file_size, extractor_version, indexed_at, call_count, evidence_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('occurrence-session', '/tmp/occurrences/session.jsonl', 1, 1, 4, 1, 1, 15);
    db.exec(`DROP TABLE tool_program_occurrences`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '27')`).run();
    closeDB();

    const reopened = getDB();
    expect((reopened.prepare(`PRAGMA table_info(tool_program_occurrences)`).all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(['call_key', 'occurrence_ordinal', 'program', 'role']);
    expect(reopened.prepare(`SELECT count(*) AS n FROM tool_scan_ledger`).get()).toEqual({ n: 0 });
    expect(reopened.prepare(`SELECT count(*) AS n FROM scan_ledger WHERE file_path = ?`).get('/tmp/occurrences/session.jsonl'))
      .toEqual({ n: 1 });
  });
});

describe('tool ledger session identity migration (v29)', () => {
  it('moves coverage lookups to session ids without invalidating normal session ledgers', () => {
    const db = getDB();
    db.prepare(
      `INSERT OR REPLACE INTO scan_ledger(file_path, file_mtime_ms, file_size, scanned_at) VALUES (?, ?, ?, ?)`
    ).run('/tmp/session-ledger/session.jsonl', 1, 1, 1);
    db.exec(`
      DROP TABLE tool_scan_ledger;
      CREATE TABLE tool_scan_ledger (
        file_path TEXT PRIMARY KEY,
        file_mtime_ms INTEGER NOT NULL,
        file_size INTEGER NOT NULL,
        extractor_version INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        call_count INTEGER NOT NULL,
        evidence_bytes INTEGER NOT NULL
      );
      INSERT INTO tool_scan_ledger VALUES ('/tmp/session-ledger/session.jsonl', 1, 1, 5, 1, 1, 15);
    `);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '28')`).run();
    closeDB();

    const reopened = getDB();
    expect((reopened.prepare(`PRAGMA table_info(tool_scan_ledger)`).all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual([
        'session_id', 'file_path', 'file_mtime_ms', 'file_size', 'extractor_version', 'indexed_at',
        'call_count', 'evidence_bytes',
        // v36 resume point for the incremental tool scan.
        'parser_state', 'parsed_offset',
      ]);
    expect(reopened.prepare(`SELECT count(*) AS n FROM tool_scan_ledger`).get()).toEqual({ n: 0 });
    expect(reopened.prepare(`SELECT count(*) AS n FROM scan_ledger WHERE file_path = ?`).get('/tmp/session-ledger/session.jsonl'))
      .toEqual({ n: 1 });
  });
});

describe('session launch mode migration (v32)', () => {
  it('adds the mode column without losing existing sessions', () => {
    upsertSession({
      id: 'pre-mode-session',
      shortId: 'pre-mode',
      agent: 'codex',
      timestamp: '2026-08-05T09:00:00.000Z',
      filePath: '/tmp/pre-mode-session.jsonl',
    } as SessionMeta, 'resume me');

    const db = getDB();
    db.exec(`ALTER TABLE sessions DROP COLUMN mode`);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '31')`).run();
    closeDB();

    const reopened = getDB();
    const columns = (reopened.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toContain('mode');
    expect(getSessionById('pre-mode-session')?.id).toBe('pre-mode-session');
  });
});

describe('spawned_team round-trip', () => {
  it('persists the team a session spawned and reads it back', () => {
    // Before this column existed the value was derived at scan time, set on the
    // meta, and then silently dropped by the writer — so every read came back
    // undefined. This pins the whole write -> read path.
    upsertSession(
      {
        id: 'orchestrator-1',
        shortId: 'orchestr',
        agent: 'claude',
        timestamp: '2026-08-01T10:00:00.000Z',
        filePath: '/tmp/orchestrator-1.jsonl',
        spawnedTeam: 'redesign',
      } as SessionMeta,
      'agents teams create redesign'
    );
    expect(getSessionById('orchestrator-1')?.spawnedTeam).toBe('redesign');
  });

  it('leaves spawnedTeam undefined for a session that spawned nothing', () => {
    upsertSession(
      {
        id: 'plain-1',
        shortId: 'plain-1a',
        agent: 'claude',
        timestamp: '2026-08-01T10:00:00.000Z',
        filePath: '/tmp/plain-1.jsonl',
      } as SessionMeta,
      'just a normal session'
    );
    expect(getSessionById('plain-1')?.spawnedTeam).toBeUndefined();
  });
});
