import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-fields-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');
const SLUG = 'my-feature';
const CWD = path.join(tmpHome, 'repo', '.agents', 'worktrees', SLUG);
const EDIT_FILE = path.join(CWD, 'apps', 'cli', 'src', 'thing.ts');

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Sqlite = typeof import('../sqlite.js');
let discover: Discover;
let db: DB;
let Database: Sqlite['default'];

const SESSION_ID = 'ses_fields0000000000000000';
const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);
const T1 = T0 + 5000;

const SESSION_ID_POSIX = 'ses_fieldsposix000000000000';
const POSIX_SLUG = 'posix-feature';
const POSIX_CWD = '/home/dev/repo/.agents/worktrees/posix-feature';
const SESSION_ID_WIN = 'ses_fieldswin00000000000000';
const WIN_SLUG = 'win-feature';
const WIN_CWD = 'C:\\Users\\dev\\repo\\.agents\\worktrees\\win-feature';

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  Database = (await import('../sqlite.js')).default;

  fs.mkdirSync(path.dirname(OPENCODE_DB), { recursive: true });
  const oc = new (Database as any)(OPENCODE_DB);
  oc.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, version TEXT,
      cost REAL, model TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE control_account (email TEXT, active INTEGER);
  `);

  oc.prepare(
    `INSERT INTO session (id, parent_id, title, directory, version, cost, model, time_created, time_updated)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID, 'my session', CWD, '1.16.0', 1.23,
        JSON.stringify({ id: 'claude-x', providerID: 'anthropic' }), T0, T1);

  oc.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)').run(
    `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({ role: 'assistant', tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 5 } } }),
    T0,
  );

  const bigString = 'X'.repeat(6000);
  oc.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)').run(
    `${SESSION_ID}-p0`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({ type: 'tool', tool: 'edit', callID: 'c0',
      state: { status: 'completed', input: { filePath: EDIT_FILE, oldString: bigString, newString: bigString }, output: bigString } }),
    T0,
  );
  oc.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)').run(
    `${SESSION_ID}-p1`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({ type: 'tool', tool: 'bash', callID: 'c1',
      state: { status: 'completed', input: { command: 'ls' }, output: 'files' } }),
    T0 + 1,
  );

  oc.prepare(
    'INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(SESSION_ID, 'finish the thing', 'pending', 'high', 0, T0, T1);

  oc.prepare(
    `INSERT INTO session (id, parent_id, title, directory, version, cost, model, time_created, time_updated)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID_POSIX, 'posix session', POSIX_CWD, '1.16.0', 0,
        JSON.stringify({ id: 'claude-x', providerID: 'anthropic' }), T0, T1);
  oc.prepare(
    `INSERT INTO session (id, parent_id, title, directory, version, cost, model, time_created, time_updated)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SESSION_ID_WIN, 'windows session', WIN_CWD, '1.16.0', 0,
        JSON.stringify({ id: 'claude-x', providerID: 'anthropic' }), T0, T1);
  oc.close();

  const authPath = path.join(tmpHome, '.local', 'share', 'opencode', 'auth.json');
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-test-key' } }));

  await discover.discoverSessions({ agent: 'opencode', all: true });
});

afterAll(() => {
  try { db.closeDB?.(); } catch {  }
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode field parity (RUSH-2358)', () => {
  it('populates every Tier-1 field the session table / message JSON already holds', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s).toBeTruthy();
    expect(s!.inputTokens).toBe(100);
    expect(s!.outputTokens).toBe(50);
    expect(s!.cacheReadTokens).toBe(200);
    expect(s!.cacheWriteTokens).toBe(5);
    expect(s!.tokenCount).toBe(365);
    expect(s!.costUsd).toBe(1.23);
    expect(s!.model).toBe('claude-x');
    expect(s!.durationMs).toBe(5000);
    expect(s!.toolCallCount).toBe(2);
    expect(s!.account).toBe('anthropic');
  });

  it('derives Tier-2 fields OpenCode records: recentDirectoriesTouched (survives truncation) and todos', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s!.recentDirectoriesTouched).toContain(path.dirname(EDIT_FILE));
    expect(s!.todos).toBeTruthy();
    expect(s!.todos!.total).toBe(1);
  });

  it('derives worktree_slug from the session cwd', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s!.worktreeSlug).toBe(SLUG);
  });

  it('derives worktree_slug from a cwd recorded with EITHER separator (RUSH-2358) — a transcript synced from another platform must not silently lose its worktree attribution', () => {
    const posix = db.getSessionById(SESSION_ID_POSIX);
    expect(posix!.worktreeSlug).toBe(POSIX_SLUG);
    const win = db.getSessionById(SESSION_ID_WIN);
    expect(win!.worktreeSlug).toBe(WIN_SLUG);

    expect(win!.cwd).toBe(WIN_CWD);
    expect(win!.cwd).not.toContain(process.cwd());
    expect(posix!.cwd).toBe(POSIX_CWD);
  });
});
