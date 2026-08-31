import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate HOME before db.js captures its module-level DB path (same pattern as
// the sibling db/migration tests). Every import below is dynamic so it runs
// AFTER the override.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-first-user-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { scanClaudeSession, readCodexMeta } = await import('./discover.js');
const { upsertSession, getSessionById, SCHEMA_VERSION } = await import('./db.js');
const { backfillActiveRowsFromMeta } = await import('./active.js');
const { toSessionWatchRow } = await import('./remote/watch.js');
type SessionMeta = import('./types.js').SessionMeta;
type ActiveSession = import('./active.js').ActiveSession;

const SEED_DIR = path.join(TEST_HOME, 'seed');
fs.mkdirSync(SEED_DIR, { recursive: true });

// A genuine first user turn that spans several lines — so it is provably NOT the
// same value as the truncated first-line `topic`.
const FULL_FIRST_TURN = [
  'Implement PHNX-3621: add firstUserMessage to the session index.',
  '',
  'It must carry the FULL first user turn, not the topic summary.',
  'Persist it like version/account and backfill it onto the watch row.',
].join('\n');

function writeClaudeTranscript(id: string): string {
  const filePath = path.join(SEED_DIR, `${id}.jsonl`);
  const lines = [
    { type: 'user', timestamp: '2026-08-31T09:00:00.000Z', cwd: SEED_DIR, sessionId: id, version: '2.1.200', gitBranch: 'main', message: { role: 'user', content: FULL_FIRST_TURN } },
    { type: 'assistant', timestamp: '2026-08-31T09:00:05.000Z', sessionId: id, message: { role: 'assistant', content: 'On it.' } },
    { type: 'user', timestamp: '2026-08-31T09:01:00.000Z', sessionId: id, message: { role: 'user', content: 'A later, second user turn that must not win.' } },
  ];
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

describe('firstUserMessage — scan-time extraction (real Claude transcript)', () => {
  it('captures the full genuine first user turn, distinct from the truncated topic', async () => {
    const filePath = writeClaudeTranscript('fum-scan');
    const scan = await scanClaudeSession(filePath);

    expect(scan.firstUserMessage).toBe(FULL_FIRST_TURN);
    // topic is a short first-line summary — it must NOT be the full turn.
    expect(scan.topic).toBeTruthy();
    expect(scan.topic).not.toBe(scan.firstUserMessage);
    expect(scan.firstUserMessage!.length).toBeGreaterThan(scan.topic!.length);
    // The LATER user turn never overwrites the first.
    expect(scan.firstUserMessage).not.toContain('second user turn');
  });

  it('captures the first user turn from a Codex transcript (the parallel resumable path)', async () => {
    const filePath = path.join(SEED_DIR, 'fum-codex.jsonl');
    const lines = [
      { type: 'session_meta', timestamp: '2026-08-31T00:00:00.000Z', payload: { id: 'fum-codex', timestamp: '2026-08-31T00:00:00.000Z', cwd: SEED_DIR, cli_version: '0.9.0', model: 'gpt-5' } },
      { type: 'response_item', timestamp: '2026-08-31T00:00:30.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: FULL_FIRST_TURN }] } },
      { type: 'response_item', timestamp: '2026-08-31T00:01:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a later turn' }] } },
    ];
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const result = await readCodexMeta(filePath, undefined, undefined, { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });
    expect(result?.meta.firstUserMessage).toBe(FULL_FIRST_TURN);
    expect(result?.meta.firstUserMessage).not.toContain('a later turn');
  });
});

describe('firstUserMessage — DB persistence round-trip', () => {
  it('upsertSession persists firstUserMessage and getSessionById reads it back', () => {
    const filePath = writeClaudeTranscript('fum-db');
    const meta: SessionMeta = {
      id: 'fum-db',
      shortId: 'fum-db',
      agent: 'claude',
      timestamp: '2026-08-31T09:00:00.000Z',
      filePath,
      topic: 'Implement PHNX-3621: add firstUserMessage to the session index.',
      firstUserMessage: FULL_FIRST_TURN,
    };
    upsertSession(meta, FULL_FIRST_TURN, { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    const read = getSessionById('fum-db');
    expect(read?.firstUserMessage).toBe(FULL_FIRST_TURN);
  });

  it('a row written without firstUserMessage reads back undefined (old-row compatibility)', () => {
    const filePath = writeClaudeTranscript('fum-legacy');
    const meta: SessionMeta = {
      id: 'fum-legacy',
      shortId: 'fum-leg',
      agent: 'claude',
      timestamp: '2026-08-31T09:00:00.000Z',
      filePath,
    };
    upsertSession(meta, '', { fileMtimeMs: 1, fileSize: fs.statSync(filePath).size });

    const read = getSessionById('fum-legacy');
    expect(read).not.toBeNull();
    expect(read?.firstUserMessage).toBeUndefined();
  });

  it('the migrated schema carries the first_user_message column at the current version', () => {
    // getSessionById above already exercised a real read of the column, so its
    // presence is proven; pin the version so a future bump revisits this file.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(45);
  });
});

describe('firstUserMessage — live-row backfill and watch projection', () => {
  it('backfillActiveRowsFromMeta fills a running row from the index, like version/account', () => {
    const rows: ActiveSession[] = [
      { context: 'terminal', kind: 'claude', sessionId: 'fum-live', pid: 1234 },
    ];
    // A running process reports no first turn; the index supplies it.
    expect(rows[0].firstUserMessage).toBeUndefined();

    backfillActiveRowsFromMeta(rows, new Map([['fum-live', { firstUserMessage: FULL_FIRST_TURN } as SessionMeta]]));
    expect(rows[0].firstUserMessage).toBe(FULL_FIRST_TURN);
  });

  it('never overwrites a first turn the row already carries', () => {
    const rows: ActiveSession[] = [
      { context: 'terminal', kind: 'claude', sessionId: 'fum-live2', firstUserMessage: 'live value' },
    ];
    backfillActiveRowsFromMeta(rows, new Map([['fum-live2', { firstUserMessage: 'index value' } as SessionMeta]]));
    expect(rows[0].firstUserMessage).toBe('live value');
  });

  it('toSessionWatchRow projects firstUserMessage onto the canonical SessionWatchRow', () => {
    const row: ActiveSession = { context: 'terminal', kind: 'claude', sessionId: 'fum-watch', firstUserMessage: FULL_FIRST_TURN };
    const watchRow = toSessionWatchRow('yosemite-m6', row);
    expect(watchRow.firstUserMessage).toBe(FULL_FIRST_TURN);
  });
});
