/** The session index writes with a named-parameter bind (`upsertSessionStmt`). bun:sqlite matches
 * keys only with the SQL sigil unless opened with `strict: true`; otherwise every param is NULL
 * and `sessions.short_id` rejects the row, so nothing is indexed in the standalone Bun binary. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from './sqlite.js';

const SCHEMA = 'CREATE TABLE t (id TEXT PRIMARY KEY, short_id TEXT NOT NULL, count INTEGER)';
const INSERT = 'INSERT INTO t (id, short_id, count) VALUES (@id, @short_id, @count)';

describe('sqlite shim named-parameter binds', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-shim-test-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('binds bare object keys on the current runtime', () => {
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.prepare(INSERT).run({ id: 'sess-1', short_id: 'sess-1'.slice(0, 4), count: 7 });
    expect(db.prepare('SELECT id, short_id, count FROM t').all()).toEqual([
      { id: 'sess-1', short_id: 'sess', count: 7 },
    ]);
    db.close();
  });

  it('binds bare object keys under bun, the runtime the standalone binary embeds', () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/sqlite.ts');
    const script = `
      import Database from ${JSON.stringify(modulePath)};
      const db = new Database(${JSON.stringify(dbPath)});
      db.exec(${JSON.stringify(SCHEMA)});
      db.prepare(${JSON.stringify(INSERT)}).run({ id: 'sess-1', short_id: 'sess', count: 7 });
      db.close();
    `;
    execFileSync('bun', ['-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });

    // Read back from this (Node) process: the row must exist with real values,
    // not the all-NULL row a silent bind failure would have produced.
    const db = new Database(dbPath);
    expect(db.prepare('SELECT id, short_id, count FROM t').all()).toEqual([
      { id: 'sess-1', short_id: 'sess', count: 7 },
    ]);
    db.close();
  });

  // The shim-level tests pin the binding; this pins the bug that motivated the fix: `agents
  // sessions` writing its index (upsertSessionsBatch, the only named bind) from the runtime the
  // standalone binary embeds.
  it('indexes a scanned session when `agents sessions` runs under bun', () => {
    const home = path.join(dir, 'home');
    const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const projectDir = path.join(home, '.claude', 'projects', '-tmp-demo');
    fs.mkdirSync(projectDir, { recursive: true });
    // ensureInitialized() gates every non-setup command on the system repo being
    // a git checkout — seed it so `sessions` runs instead of erroring.
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: 'user', sessionId, cwd: '/tmp/demo', version: '2.1.220', gitBranch: 'main',
        timestamp: '2026-07-31T10:00:00.000Z',
        message: { role: 'user', content: 'index this session please' },
      }),
      JSON.stringify({
        type: 'assistant', sessionId, cwd: '/tmp/demo', version: '2.1.220',
        timestamp: '2026-07-31T10:00:05.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 4 } },
      }),
    ].join('\n') + '\n');

    const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), 'sessions', '--all', '--local', '--json'], {
      cwd: process.cwd(),
      // USERPROFILE too: discover.ts roots at os.homedir(), which ignores HOME on Windows. With
      // only HOME set, the index goes to the temp home while the scan reads the runner's real
      // profile, so the session is never found.
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENTS_REAL_HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    expect(JSON.parse(out).map((s: { id: string }) => s.id)).toContain(sessionId);

    // The listing can be served from the scan itself, so assert the row actually
    // landed in the index — that is what the failed bind used to swallow.
    const db = new Database(path.join(home, '.agents', '.history', 'sessions', 'sessions.db'));
    expect(db.prepare('SELECT id, short_id FROM sessions').all()).toEqual([
      { id: sessionId, short_id: 'aaaaaaaa' },
    ]);
    db.close();
  });

  it('still binds positional parameters on the current runtime', () => {
    const db = new Database(dbPath);
    db.exec(SCHEMA);
    db.prepare('INSERT INTO t (id, short_id, count) VALUES (?, ?, ?)').run('sess-2', 'sess', 3);
    expect(db.prepare('SELECT short_id FROM t WHERE id = ?').get('sess-2')).toEqual({ short_id: 'sess' });
    db.close();
  });
});
