import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Count how many times `opencode.db` is OPENED, the RUSH-2210 cost: the whole-DB mtime stamp
// re-emitted every session on any write and enrichment re-opened the file per entry. Wrap the
// sqlite shim; the counter is a top-level const (Bun does not hoist vi.mock).
const openCounter: { match: string | null; count: number } = { match: null, count: 0 };

vi.mock('../sqlite.js', async () => {
  const actual = await vi.importActual<typeof import('../sqlite.js')>('../sqlite.js');
  const Real = actual.default as any;
  class Counting extends Real {
    constructor(filename: string) {
      if (openCounter.match !== null && filename === openCounter.match) openCounter.count++;
      super(filename);
    }
  }
  return { ...actual, default: Counting };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// db.ts + discover.ts resolve their paths from HOME at module-import time. Point
// HOME at a throwaway dir BEFORE importing so the suite runs against a clean,
// isolated sessions DB and a synthetic opencode.db (real fs, real sqlite).
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-ledger-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Sqlite = typeof import('../sqlite.js');

let discover: Discover;
let db: DB;
let Database: Sqlite['default'];

const SESSION_COUNT = 12;

/** Open the synthetic opencode.db directly (not counted — the counter is off). */
function openFixture() {
  return new (Database as any)(OPENCODE_DB);
}

/** Build an opencode.db with the tables the scanner and parser read: `session`, and
 * `message`/`part`. `control_account` is created as real installs have it but stays unused: the
 * real account source is `auth.json`, since `control_account` is permanently empty (RUSH-2358). */
function seedFixture(): void {
  fs.mkdirSync(path.dirname(OPENCODE_DB), { recursive: true });
  const oc = openFixture();
  oc.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
      version TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER
    );
    CREATE TABLE control_account (email TEXT, active INTEGER);
    INSERT INTO control_account (email, active) VALUES ('dev@example.com', 1);
  `);

  const base = Date.UTC(2026, 6, 1);
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = `ses_fixture${String(i).padStart(2, '0')}`;
    const t = base + i * 60_000;
    oc.prepare(
      `INSERT INTO session (id, parent_id, title, directory, version, time_created, time_updated)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, `session ${i}`, path.join(tmpHome, 'proj'), '0.3.0', t, t);
    addMessage(oc, id, `${id}-m0`, t, `first turn of ${i}`);
  }
  oc.close();
}

/** Write the auth.json `resolveOpenCodeAccountId` actually reads, the real OpenCode account source
 * (RUSH-2358): one valid `api` credential for provider `anthropic`. */
function seedAuthJson(): void {
  const authPath = path.join(tmpHome, '.local', 'share', 'opencode', 'auth.json');
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'sk-test-key' } }));
}

/** Append one user message + its text part to a session. */
function addMessage(oc: any, sessionId: string, messageId: string, ts: number, text: string): void {
  oc.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`)
    .run(messageId, sessionId, JSON.stringify({ role: 'user' }), ts);
  oc.prepare(`INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)`)
    .run(`${messageId}-p0`, messageId, sessionId, JSON.stringify({ type: 'text', text }), ts);
}

/** Write to the shared DB as OpenCode does: append a turn to one session and move that row's
 * `time_updated`. Other rows are untouched but the DB file's mtime/size moves, the shape that used
 * to re-emit all of them. */
function appendTurnTo(sessionId: string, ts: number, text: string): void {
  const oc = openFixture();
  addMessage(oc, sessionId, `${sessionId}-m-${ts}`, ts, text);
  oc.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(ts, sessionId);
  oc.close();
  bumpDbMtime(ts);
}

/** Append a PART to a session's existing message without touching `session` or `message`. Real: on
 * a mac-mini opencode.db a session's `time_updated` lagged its newest part by over four hours, so
 * a stamp from `session.time_updated` alone would call it unchanged forever. */
function appendPartTo(sessionId: string, messageId: string, ts: number, text: string): void {
  const oc = openFixture();
  oc.prepare(`INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)`)
    .run(`${messageId}-p-${ts}`, messageId, sessionId, JSON.stringify({ type: 'text', text }), ts);
  oc.close();
  bumpDbMtime(ts);
}

/** Grow an existing part's `data` in place (a streaming turn) with no new row, id or timestamp
 * moving. */
function growPartInPlace(partId: string, text: string, ts: number): void {
  const oc = openFixture();
  oc.prepare(`UPDATE part SET data = ? WHERE id = ?`).run(JSON.stringify({ type: 'text', text }), partId);
  oc.close();
  bumpDbMtime(ts);
}

/** Force the DB file's mtime forward so the whole-DB short-circuit sees a delta. */
function bumpDbMtime(ts: number): void {
  const secs = Math.floor(ts / 1000);
  fs.utimesSync(OPENCODE_DB, secs, secs);
}

/** The per-session ledger row the scan wrote, read back from sessions.db. */
function ledgerFor(sessionId: string): { file_mtime_ms: number; file_size: number } {
  return db.getDB()
    .prepare(`SELECT file_mtime_ms, file_size FROM scan_ledger WHERE file_path = ?`)
    .get(`${OPENCODE_DB}#${sessionId}`) as { file_mtime_ms: number; file_size: number };
}

// `skipExistenceCheck` because an OpenCode filePath is `opencode.db#<id>` — a
// row address inside the shared DB, not a file `fs.existsSync` can stat.
async function scan() {
  return discover.discoverSessions({ agent: 'opencode', all: true, skipExistenceCheck: true });
}

beforeAll(async () => {
  Database = (await import('../sqlite.js')).default;
  db = await import('./db.js');
  discover = await import('./discover.js');
  db.getDB(); // create schema
  seedFixture();
  seedAuthJson();
});

beforeEach(() => {
  openCounter.match = null;
  openCounter.count = 0;
});

afterAll(() => {
  // Close before removing the tree: Windows refuses to unlink an open file, so a
  // leaked connection (plus its WAL sidecars) fails the whole suite there.
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode per-session scan ledger (RUSH-2210)', () => {
  it('indexes every session on the first scan', async () => {
    const sessions = await scan();
    expect(sessions.length).toBe(SESSION_COUNT);
    expect(sessions.every(s => s.agent === 'opencode')).toBe(true);
    // account comes from auth.json's valid credential (provider ids joined),
    // never the always-empty control_account table (RUSH-2358).
    expect(sessions.every(s => s.account === 'anthropic')).toBe(true);
  });

  it('re-emits ONLY the changed session when the shared DB is written', async () => {
    const target = 'ses_fixture03';
    const before = (await scan()).find(s => s.id === target)!;
    expect(before.messageCount).toBe(1);

    appendTurnTo(target, Date.UTC(2026, 6, 2), 'second turn');

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    const after = await scan();

    // The changed row is re-parsed and its new message count lands...
    expect(after.find(s => s.id === target)!.messageCount).toBe(2);
    // ...every other session still surfaces (skipped, not dropped)...
    expect(after.length).toBe(SESSION_COUNT);
    // ...and the DB was opened a handful of times, not once per indexed session.
    // Pre-fix this was 1 (the scan) + SESSION_COUNT (one enrichment parse per
    // re-emitted entry); now it is the scan handle plus the single changed row.
    expect(openCounter.count).toBeLessThanOrEqual(3);
    expect(openCounter.count).toBeLessThan(SESSION_COUNT);
  });

  it('catches a part appended with NO write to session or message', async () => {
    const target = 'ses_fixture05';
    await scan();
    const before = ledgerFor(target);

    // The real-world shape: a part lands hours after session.time_updated.
    appendPartTo(target, `${target}-m0`, Date.UTC(2026, 6, 2, 4), 'a part written much later');

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    await scan();

    const after = ledgerFor(target);
    // The stamp moved on the part's own time and on the added bytes, so the
    // session was re-indexed rather than skipped forever.
    expect(after.file_mtime_ms).toBeGreaterThan(before.file_mtime_ms);
    expect(after.file_size).toBeGreaterThan(before.file_size);
    // Still only this one session was re-emitted.
    expect(openCounter.count).toBeLessThanOrEqual(3);
  });

  it('catches an existing part rewritten in place (no new row, no timestamp move)', async () => {
    const target = 'ses_fixture06';
    await scan();
    const before = ledgerFor(target);

    growPartInPlace(`${target}-m0-p0`, 'x'.repeat(4096), Date.UTC(2026, 6, 2, 5));

    await scan();

    const after = ledgerFor(target);
    // No timestamp anywhere changed — the byte total is what caught it.
    expect(after.file_mtime_ms).toBe(before.file_mtime_ms);
    expect(after.file_size).toBeGreaterThan(before.file_size);
  });

  it('stamps file_size in real bytes, which tool-index reads as a byte budget', async () => {
    await scan();
    // `sessions.file_size` feeds ensureToolIndex's byte budget and
    // toolCallsForBackfill's 16 MiB in-memory cap (tool-index.ts), so the value
    // must be a genuine payload size — not a repurposed row counter.
    const row = db.getDB()
      .prepare(`SELECT file_size FROM sessions WHERE id = ?`)
      .get('ses_fixture00') as { file_size: number };
    const oc = openFixture();
    const expected = (oc.prepare(
      `SELECT (SELECT COALESCE(SUM(LENGTH(data)),0) FROM message WHERE session_id = ?)
            + (SELECT COALESCE(SUM(LENGTH(data)),0) FROM part WHERE session_id = ?) AS n`,
    ).get('ses_fixture00', 'ses_fixture00') as { n: number }).n;
    oc.close();
    expect(row.file_size).toBe(expected);
    expect(expected).toBeGreaterThan(SESSION_COUNT); // not a count masquerading as bytes
  });

  it('counts BYTES, not characters, for multi-byte content', async () => {
    const target = 'ses_fixture07';
    await scan();
    const before = ledgerFor(target);

    // SQLite's LENGTH() on TEXT returns characters (`LENGTH('日本語')` is 3, as a BLOB 9). The stamp
    // is a byte budget downstream (tool-index.ts), so a CJK transcript must not report a third of
    // its real size.
    const cjk = '日本語'.repeat(200); // 600 chars, 1800 UTF-8 bytes
    appendPartTo(target, `${target}-m0`, Date.UTC(2026, 6, 2, 6), cjk);

    await scan();

    const grew = ledgerFor(target).file_size - before.file_size;
    expect(grew).toBeGreaterThan(1800);
    expect(grew).toBeGreaterThan(Buffer.byteLength(cjk, 'utf8'));
    // A character count would have grown by only ~600 plus the JSON envelope.
    expect(grew).toBeGreaterThan(cjk.length * 2);
  });

  it('emits nothing when the DB file changes but no session row does', async () => {
    await scan();

    // A write that moves the file's stat without touching any session row —
    // e.g. OpenCode updating its own bookkeeping tables.
    const oc = openFixture();
    oc.prepare(`UPDATE control_account SET active = 1`).run();
    oc.close();
    bumpDbMtime(Date.UTC(2026, 6, 3));

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    const after = await scan();

    expect(after.length).toBe(SESSION_COUNT);
    // Exactly one open: the scan's own handle. No session was re-emitted, so no
    // enrichment parse re-opened the file.
    expect(openCounter.count).toBe(1);
  });

  it('short-circuits entirely when the DB file itself is unchanged', async () => {
    await scan();

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    const after = await scan();

    expect(after.length).toBe(SESSION_COUNT);
    expect(openCounter.count).toBe(0);
  });
});

describe('OpenCode first-user-message extractor invalidation (PHNX-3621)', () => {
  function firstUserMessageOf(sessionId: string): string | null {
    const row = db.getDB()
      .prepare(`SELECT first_user_message FROM sessions WHERE id = ?`)
      .get(sessionId) as { first_user_message: string | null } | undefined;
    return row?.first_user_message ?? null;
  }

  it('backfills an unchanged merged-v2 session and then returns to the warm short-circuit', async () => {
    const target = 'ses_fixture09';
    await scan();

    // Model the real merged-v2 -> fixed-v3 upgrade: #3358 already stamped the
    // transcript and shared OpenCode DB at v2 without extracting this field.
    // Nothing on disk changed; only the extractor version advanced.
    const stale = db.CONTENT_INDEX_VERSION - 1;
    db.getDB().prepare(`UPDATE scan_ledger SET extractor_version = ?`).run(stale);
    db.getDB().prepare(`UPDATE sessions SET first_user_message = NULL WHERE id = ?`).run(target);
    expect(firstUserMessageOf(target)).toBeNull();

    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    await scan();

    expect(firstUserMessageOf(target)).toBe('first turn of 9');
    expect(openCounter.count).toBeGreaterThanOrEqual(1);
    expect(db.getScanStampByPath(OPENCODE_DB)?.extractorVersion).toBe(db.CONTENT_INDEX_VERSION);

    // The successful scan stamps both the container and session rows current;
    // another unchanged scan must be a zero-open warm no-op again.
    openCounter.match = OPENCODE_DB;
    openCounter.count = 0;
    await scan();
    expect(openCounter.count).toBe(0);
  });

  it('re-extracts an older stale row behind more than 1,000 newer sessions', async () => {
    const target = 'ses_fixture00';
    await scan();

    const oc = openFixture();
    const insertSession = oc.prepare(
      `INSERT INTO session (id, parent_id, title, directory, version, time_created, time_updated)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    );
    const base = Date.UTC(2026, 7, 1);
    oc.transaction(() => {
      for (let i = 0; i < 1_001; i++) {
        const id = `ses_upgrade_${String(i).padStart(4, '0')}`;
        const ts = base + i * 1_000;
        insertSession.run(id, `upgrade ${i}`, path.join(tmpHome, 'proj'), '0.3.0', ts, ts);
        addMessage(oc, id, `${id}-m0`, ts, `upgrade turn ${i}`);
      }
    })();
    oc.close();
    bumpDbMtime(base + 2_000_000);

    db.getDB().prepare(`UPDATE scan_ledger SET extractor_version = ?`).run(db.CONTENT_INDEX_VERSION - 1);
    db.getDB().prepare(`UPDATE sessions SET first_user_message = NULL WHERE id = ?`).run(target);
    await scan();

    expect(firstUserMessageOf(target)).toBe('first turn of 0');
    expect(db.getScanStampByPath(`${OPENCODE_DB}#${target}`)?.extractorVersion).toBe(db.CONTENT_INDEX_VERSION);
  });

  it('keeps a first-ever import capped when no container ledger exists', async () => {
    db.getDB().exec(`DELETE FROM scan_ledger; DELETE FROM sessions;`);

    await scan();

    const imported = db.getDB().prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number };
    expect(imported.n).toBe(1_000);
    expect(firstUserMessageOf('ses_fixture00')).toBeNull();
    expect(db.getScanStampByPath(OPENCODE_DB)?.extractorVersion).toBe(db.CONTENT_INDEX_VERSION);
  });
});
