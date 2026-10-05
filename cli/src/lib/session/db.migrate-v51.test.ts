import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migv51-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir, getSessionsDbPath } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const db = await import('./db.js');
const Database = (await import('../sqlite.js')).default;

const SESSIONS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', content: 'rebase the release branch' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000002', content: 'needle-in-session-text' },
  { id: 'cccccccc-0000-4000-8000-000000000003', content: 'audit the mirror ingest' },
];

function seedSession(id: string, content: string): void {
  db.upsertSession({
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: '2026-09-18T00:00:00.000Z',
    filePath: path.join(TEST_HOME, `${id}.jsonl`),
    topic: content,
    firstUserMessage: content,
  } as any, content);
}

{
  for (const s of SESSIONS) seedSession(s.id, s.content);
  db.closeDB();

  const raw = new Database(getSessionsDbPath());
  raw.exec(`DROP TABLE session_text`);
  raw.exec(`
    CREATE VIRTUAL TABLE session_text USING fts5(
      session_id UNINDEXED, label, topic, project, content, assistant,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `);
  const ins = raw.prepare(
    `INSERT INTO session_text (session_id, label, topic, project, content, assistant) VALUES (?, '', ?, '', ?, '')`,
  );
  ins.run(SESSIONS[2].id, 'old topic', 'stale duplicate that must not survive');
  for (const s of [...SESSIONS].reverse()) ins.run(s.id, s.content, s.content);
  ins.run('dddddddd-0000-4000-8000-000000000004', 'orphan', 'no sessions row owns this');
  raw.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '50')`).run();
  raw.close();
}

describe('schema migration v50 -> v51 (session_text keyed by sessions.rowid)', () => {
  it('rebuilds session_text at the rowid of the session each row describes', () => {
    const d = db.getDB();
    const mismatched = d.prepare(`
      SELECT t.session_id FROM session_text t
      LEFT JOIN sessions s ON s.rowid = t.rowid
      WHERE s.id IS NULL OR s.id <> t.session_id
    `).all();
    expect(mismatched).toEqual([]);
    expect(d.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get())
      .toEqual({ value: String(db.SCHEMA_VERSION) });
  });

  it('keeps one row per session — the newest duplicate wins, the orphan is dropped', () => {
    const d = db.getDB();
    expect(d.prepare(`SELECT count(*) AS n FROM session_text`).get()).toEqual({ n: SESSIONS.length });
    expect(db.readSessionContent(SESSIONS[2].id)).toBe(SESSIONS[2].content);
    expect(db.readSessionContent('dddddddd-0000-4000-8000-000000000004')).toBeUndefined();
  });

  it('keeps every session searchable', () => {
    const d = db.getDB();
    expect(d.prepare(
      `SELECT session_id FROM session_text WHERE session_text MATCH '"needle-in-session-text"'`,
    ).all()).toEqual([{ session_id: SESSIONS[1].id }]);
  });

  it('addresses session_text by rowid everywhere in db.ts, never by the UNINDEXED session_id', () => {
    const source = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf-8');
    const runtime = source.slice(source.indexOf('export function getDB('));
    expect(runtime.length).toBeGreaterThan(0);
    expect(runtime).not.toMatch(/session_text[^`]*\bWHERE\s+session_id\s*=/);
    expect(runtime).not.toMatch(/INSERT INTO session_text \(session_id/);
  });
});
