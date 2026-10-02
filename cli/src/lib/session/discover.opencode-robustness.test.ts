import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// db.ts + discover.ts capture their paths from HOME at import time, so point HOME
// at a throwaway dir BEFORE importing. Real fs, real sqlite, a synthetic
// opencode.db — no mocking.
//
// Two regressions this pins, both found on a real opencode.db after RUSH-2358
// shipped:
//   1. The tool-part read truncated only `state.output`, which bounds nothing —
//      the largest real part was 1,346,068 bytes of which `state.attachments`
//      (a base64 data URL from `read`) was 1,345,674 and `state.output` was 23.
//   2. `json_extract` raises "malformed JSON" on a non-JSON value and aborts the
//      WHOLE query, so one unparseable `part`/`message` row dropped EVERY
//      OpenCode session from the index — silently in a non-TTY run.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-opencode-robust-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const OPENCODE_DB = path.join(tmpHome, '.local', 'share', 'opencode', 'opencode.db');
const CWD = path.join(tmpHome, 'repo');
const READ_FILE = path.join(CWD, 'src', 'huge-image-holder.ts');
const EDIT_FILE = path.join(CWD, 'src', 'edited.ts');
const SHELL_CWD = path.join(CWD, 'packages', 'runner');

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');
type Parse = typeof import('@phnx-labs/sessions-cli/reader');
type Sqlite = typeof import('../sqlite.js');
let discover: Discover;
let db: DB;
let parse: Parse;
let Database: Sqlite['default'];

const SESSION_ID = 'ses_robust00000000000000000';
const T0 = Date.UTC(2026, 7, 2, 0, 0, 0);
const T1 = T0 + 9000;

/** A base64-ish data URL of the shape `read` attaches for an image. */
const HUGE_ATTACHMENT = `data:image/png;base64,${'A'.repeat(1_000_000)}`;
const BIG_STRING = 'X'.repeat(20_000);

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  parse = await import('@phnx-labs/sessions-cli/reader');
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
  ).run(SESSION_ID, 'robustness', CWD, '1.16.0', 0.5,
        JSON.stringify({ id: 'big-pickle', providerID: 'opencode' }), T0, T1);

  const insMsg = oc.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)');
  const insPart = oc.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)');

  insMsg.run(`${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({ role: 'assistant', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 200, write: 5 } } }), T0);

  // (1) A `read` whose weight is entirely in `state.attachments`, not `state.output`.
  insPart.run(`${SESSION_ID}-p0`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({
      type: 'tool', tool: 'read', callID: 'c0',
      state: {
        status: 'completed',
        input: { filePath: READ_FILE },
        output: 'read 1 image',
        attachments: [{ url: HUGE_ATTACHMENT, mime: 'image/png' }],
      },
    }), T0);

  // (2) An `edit` whose weight is in `state.input` (old/new strings).
  insPart.run(`${SESSION_ID}-p1`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({
      type: 'tool', tool: 'edit', callID: 'c1',
      state: { status: 'completed', input: { filePath: EDIT_FILE, oldString: BIG_STRING, newString: BIG_STRING }, output: 'ok' },
    }), T0 + 1);

  // (3) A `shell` whose input is oversized: the collapse must keep `cwd`, which is
  // the key `extractRecentDirectoriesTouched` reads for shell tools (state.ts).
  insPart.run(`${SESSION_ID}-p3`, `${SESSION_ID}-m0`, SESSION_ID,
    JSON.stringify({
      type: 'tool', tool: 'shell', callID: 'c3',
      state: { status: 'completed', input: { command: `echo ${BIG_STRING}`, cwd: SHELL_CWD }, output: 'ok' },
    }), T0 + 4);

  // (4) Poisoned rows: a non-JSON part and a non-JSON message in the SAME shared DB.
  insPart.run(`${SESSION_ID}-p2`, `${SESSION_ID}-m0`, SESSION_ID, 'not json at all', T0 + 2);
  insMsg.run(`${SESSION_ID}-m1`, SESSION_ID, '<<< truncated write >>>', T0 + 3);

  oc.close();

  await discover.discoverSessions({ agent: 'opencode', all: true });
});

afterAll(() => {
  try { db.closeDB?.(); } catch { /* ignore */ }
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OpenCode scan survives a malformed row (RUSH-2358 follow-up)', () => {
  it('still indexes the session when a part and a message hold non-JSON', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s).toBeTruthy();
    // Pre-fix, the unguarded json_extract aggregate threw "malformed JSON" and
    // the whole scan was swallowed, leaving ZERO OpenCode rows indexed.
    expect(s!.model).toBe('big-pickle');
    expect(s!.durationMs).toBe(9000);
  });

  it('counts only the valid tool parts, ignoring the poisoned row', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s!.toolCallCount).toBe(3); // read + edit + shell; the non-JSON row is skipped
  });

  it('still aggregates tokens across the valid messages', () => {
    const s = db.getSessionById(SESSION_ID);
    expect(s!.inputTokens).toBe(100);
    expect(s!.outputTokens).toBe(50);
    expect(s!.cacheReadTokens).toBe(200);
    expect(s!.cacheWriteTokens).toBe(5);
    expect(s!.tokenCount).toBe(355); // 100+50+0+200+5
  });
});

describe('OpenCode tool-part read stays bounded (RUSH-2358 follow-up)', () => {
  const parsed = () => parse.parseOpenCode(`${OPENCODE_DB}#${SESSION_ID}`);

  // The cost being pinned is what the QUERY loads, not what reaches the events:
  // `state.attachments` never reached an event even before the fix, because the
  // `case 'tool'` branch only copies `state.input` / `state.output`. The 1 MB
  // was paid in the result set, which is why asserting on events alone would
  // pass against the pre-fix code. Run the real query (imported, not re-typed)
  // and measure its `part_data`.
  const projectedBytes = (): { total: number; max: number } => {
    const oc = new (Database as any)(OPENCODE_DB);
    try {
      const rows = oc.prepare(parse.OPENCODE_TRANSCRIPT_QUERY).all(SESSION_ID) as Array<{ part_data: unknown }>;
      const sizes = rows.map(r => (typeof r.part_data === 'string' ? Buffer.byteLength(r.part_data) : 0));
      return { total: sizes.reduce((a, b) => a + b, 0), max: Math.max(0, ...sizes) };
    } finally {
      try { oc.close(); } catch { /* best-effort */ }
    }
  };

  it('does not load the huge state.attachments payload out of the database', () => {
    const { total, max } = projectedBytes();
    // The `read` row alone is >1 MB in the DB. Truncating only `state.output`
    // shrank it by zero bytes; the projection has to drop `attachments`.
    expect(max).toBeLessThan(10_000);
    expect(total).toBeLessThan(20_000);
  });

  it('never carries an attachment data URL into the parsed events', () => {
    expect(JSON.stringify(parsed())).not.toContain('data:image/png;base64');
  });

  it('keeps the addressing fields the enrichment needs, for both tools', () => {
    const events = parsed();
    const toolUses = events.filter(e => e.type === 'tool_use') as Array<any>;
    expect(toolUses.map(e => e.tool)).toEqual(expect.arrayContaining(['read', 'edit']));
    // `read` keeps its filePath even though the part was 1 MB.
    expect(toolUses.find(e => e.tool === 'read')?.path).toBe(READ_FILE);
    // `edit`'s oversized input collapses to its addressing fields — filePath survives.
    expect(toolUses.find(e => e.tool === 'edit')?.path).toBe(EDIT_FILE);
    expect(JSON.stringify(toolUses.find(e => e.tool === 'edit')?.args)).not.toContain(BIG_STRING);
  });

  it('keeps a shell tool cwd through the oversized-input collapse', () => {
    const shell = (parsed().filter(e => e.type === 'tool_use') as Array<any>).find(e => e.tool === 'shell');
    // `extractRecentDirectoriesTouched` reads args.cwd for shell tools; dropping it
    // would silently degrade the session's directories to the session cwd.
    expect(shell?.args?.cwd).toBe(SHELL_CWD);
    expect(JSON.stringify(shell?.args)).not.toContain(BIG_STRING);
  });

  it('drops the non-JSON part without losing the rest of the transcript', () => {
    const events = parsed();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'tool_use')).toBe(true);
  });
});

describe('OpenCode transcript parses on a schema with no todo table', () => {
  // The `todo` probe must not cost the transcript when the table is absent. The
  // hazard is runtime-specific: node:sqlite returns `undefined` for an empty
  // `get()` and bun:sqlite returns `null`, so a sentinel-based probe silently
  // inverts on the shipped Bun binary and every no-todo database parses to
  // zero events. The probe counts rows instead, which is why this holds under
  // both runtimes — vitest only exercises the node one.
  const OLD_DB = path.join(tmpHome, 'old', 'opencode.db');
  const OLD_SESSION = 'ses_notodo000000000000000000';

  beforeAll(() => {
    fs.mkdirSync(path.dirname(OLD_DB), { recursive: true });
    const oc = new (Database as any)(OLD_DB);
    oc.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    `);
    oc.prepare('INSERT INTO session (id, parent_id, title, directory, version, time_created, time_updated) VALUES (?, NULL, ?, ?, ?, ?, ?)')
      .run(OLD_SESSION, 'old schema', CWD, '0.3.0', T0, T1);
    oc.prepare('INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)')
      .run(`${OLD_SESSION}-m0`, OLD_SESSION, JSON.stringify({ role: 'assistant' }), T0);
    oc.prepare('INSERT INTO part (id, message_id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)')
      .run(`${OLD_SESSION}-p0`, `${OLD_SESSION}-m0`, OLD_SESSION, JSON.stringify({ type: 'text', text: 'hello world' }), T0);
    oc.close();
  });

  it('returns the transcript instead of an empty session', () => {
    const events = parse.parseOpenCode(`${OLD_DB}#${OLD_SESSION}`);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'message' && (e as any).content === 'hello world')).toBe(true);
  });
});
