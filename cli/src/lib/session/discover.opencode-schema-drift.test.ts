import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-drift-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');
const SESSION_ID = 'ses_drift00000000000000000';
const T0 = Date.UTC(2026, 7, 2, 0, 0, 0);

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Sqlite = typeof import('../sqlite.js');
let discover: Discover;
let db: DB;
let Database: Sqlite['default'];

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  Database = (await import('../sqlite.js')).default;

  fs.mkdirSync(path.dirname(OPENCODE_DB), { recursive: true });
  const oc = new (Database as any)(OPENCODE_DB);
  oc.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE control_account (email TEXT, active INTEGER);
  `);
  oc.prepare('INSERT INTO session (id, parent_id, title, directory, version, time_created, time_updated) VALUES (?, NULL, ?, ?, ?, ?, ?)')
    .run(SESSION_ID, 'old session', path.join(tmpHome, 'proj'), '0.3.0', T0, T0 + 1000);
  oc.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)')
    .run(`${SESSION_ID}-m0`, SESSION_ID, JSON.stringify({ role: 'assistant', tokens: { input: 7, output: 3, cache: { read: 0, write: 0 } } }), T0);
  oc.close();

  await discover.discoverSessions({ agent: 'opencode', all: true });
});

afterAll(() => {
  try { db.closeDB?.(); } catch {  }
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode scan tolerates an older schema (RUSH-2358)', () => {
  it('still indexes the session, token fields populate, and cost/model are null', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s).toBeTruthy();
    expect(s!.inputTokens).toBe(7);
    expect(s!.outputTokens).toBe(3);
    expect(s!.costUsd).toBeUndefined();
    expect(s!.model).toBeUndefined();
    expect(s!.todos).toBeUndefined();
  });
});
