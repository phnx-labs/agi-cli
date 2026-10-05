
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

    const db = new Database(dbPath);
    expect(db.prepare('SELECT id, short_id, count FROM t').all()).toEqual([
      { id: 'sess-1', short_id: 'sess', count: 7 },
    ]);
    db.close();
  });

  it('indexes a scanned session when `agents sessions` runs under bun', () => {
    const home = path.join(dir, 'home');
    const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const projectDir = path.join(home, '.claude', 'projects', '-tmp-demo');
    fs.mkdirSync(projectDir, { recursive: true });
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
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENTS_REAL_HOME: home },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    expect(JSON.parse(out).map((s: { id: string }) => s.id)).toContain(sessionId);

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
