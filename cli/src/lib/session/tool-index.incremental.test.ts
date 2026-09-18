/**
 * The tool index reads a growing transcript incrementally (RUSH-2208).
 *
 * A live session's transcript only ever gets longer, but every scan used to
 * re-read it from byte 0 and delete + reinsert the whole session's evidence, so
 * indexing a session that was scanned N times cost N full parses of an
 * ever-larger file. These tests pin the resume path: which bytes are actually
 * read, that the calls already stored survive, and the cases that must still
 * fall back to a full re-read.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-tool-incremental-'));
process.env.HOME = TEST_HOME;

const { closeDB, getDB, upsertSession } = await import('./db.js');
const { ensureToolIndex } = await import('./tool-index.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/** One completed Claude tool call: the tool_use and its tool_result. */
function callRecords(id: string, command: string, result: string): string {
  return [
    { type: 'assistant', timestamp: '2026-08-03T00:00:00Z', message: { content: [
      { type: 'tool_use', id, name: 'Bash', input: { command } },
    ] } },
    { type: 'user', timestamp: '2026-08-03T00:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: id, content: result },
    ] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

function claudeSession(name: string, body: string): SessionMeta {
  const filePath = path.join(TEST_HOME, `${name}.jsonl`);
  fs.writeFileSync(filePath, body);
  const meta = {
    id: `${name}-session`, shortId: name.slice(0, 8), agent: 'claude',
    timestamp: '2026-08-03T00:00:00Z', filePath, machine: 'test-box',
  } as SessionMeta;
  upsertSession(meta, name);
  return meta;
}

function ledger(sessionId: string) {
  return getDB().prepare(`
    SELECT call_count, file_size, parsed_offset, parser_state
    FROM tool_scan_ledger WHERE session_id = ?
  `).get(sessionId) as {
    call_count: number;
    file_size: number;
    parsed_offset: number | null;
    parser_state: string | null;
  };
}

function storedCalls(sessionId: string) {
  return getDB().prepare(`
    SELECT ordinal, source_call_id, input, rowid FROM tool_calls
    WHERE session_id = ? ORDER BY ordinal
  `).all(sessionId) as Array<{ ordinal: number; source_call_id: string; input: string; rowid: number }>;
}

/**
 * Overwrite text in the already-parsed prefix, in place and at the same byte
 * length so later offsets still line up. Nothing writes a transcript this way —
 * it is a probe. A scan that re-read the prefix picks the new text up; a scan
 * that resumed past it cannot, which is what makes "only the tail was read" an
 * observable fact rather than an inference from row counts.
 */
function mutatePrefix(session: SessionMeta, from: string, to: string): void {
  expect(Buffer.byteLength(to)).toBe(Buffer.byteLength(from));
  const body = fs.readFileSync(session.filePath, 'utf8');
  expect(body).toContain(from);
  fs.writeFileSync(session.filePath, body.replace(from, to));
}

describe('incremental tool index', () => {
  it('reads only the appended bytes and keeps the calls already stored', async () => {
    const session = claudeSession('growing', callRecords('first-call', 'git status', 'clean'));

    const first = await ensureToolIndex([session], { verifySourceStamps: true });
    expect(first).toMatchObject({ indexedFiles: 1, indexedCalls: 1 });
    const afterFirst = ledger(session.id);
    const firstSize = fs.statSync(session.filePath).size;
    expect(afterFirst.parsed_offset).toBe(firstSize);
    expect(afterFirst.parser_state).not.toBeNull();
    const before = storedCalls(session.id);

    mutatePrefix(session, 'git status', 'git st4tus');
    fs.appendFileSync(session.filePath, callRecords('second-call', 'gh pr view', 'open'));
    await ensureToolIndex([session], { verifySourceStamps: true });

    // The whole point: the second scan started past everything it had already
    // parsed, so the doctored prefix never reached it.
    expect(storedCalls(session.id)[0].input).toContain('git status');
    expect(storedCalls(session.id).map((row) => [row.ordinal, row.source_call_id])).toEqual([
      [0, 'first-call'],
      [1, 'second-call'],
    ]);
    // The first call's row was never deleted and reinserted.
    expect(storedCalls(session.id)[0]).toEqual(before[0]);
    const afterSecond = ledger(session.id);
    expect(afterSecond.call_count).toBe(2);
    expect(afterSecond.parsed_offset).toBe(fs.statSync(session.filePath).size);
  });

  it('accounts for every byte of a transcript larger than one read chunk', async () => {
    // The stream reads in 64 KiB chunks, so records straddle chunk boundaries.
    // Counting only the bytes a record contributed to the chunk that ENDED it
    // silently loses the part carried in from the previous chunk: measured, a
    // 4.8 MB transcript came up 22,888 bytes short, and the resume point then
    // re-read (and re-derived) the tail of every split record on the next scan.
    // A single-chunk fixture cannot catch this — hence the size here.
    const body = Array.from({ length: 400 }, (_, i) =>
      callRecords(`bulk-${i}`, `git log --oneline -${i} # ${'x'.repeat(400)}`, `ok ${'y'.repeat(400)}`)).join('');
    const session = claudeSession('multi-chunk', body);
    expect(fs.statSync(session.filePath).size).toBeGreaterThan(64 * 1024);

    await ensureToolIndex([session], { verifySourceStamps: true });

    expect(ledger(session.id).parsed_offset).toBe(fs.statSync(session.filePath).size);
    expect(ledger(session.id).call_count).toBe(400);
  });

  it('correlates a result that lands in a later append with its earlier call', async () => {
    const session = claudeSession('split-call', JSON.stringify({
      type: 'assistant', timestamp: '2026-08-03T00:00:00Z', message: { content: [
        { type: 'tool_use', id: 'pending-call', name: 'Bash', input: { command: 'sleep 30' } },
      ] },
    }) + '\n');

    await ensureToolIndex([session], { verifySourceStamps: true });
    expect(storedCalls(session.id).map((row) => row.ordinal)).toEqual([0]);

    // The result arrives in the appended bytes. Only the resumed collector's
    // restored pending map can pair it with the call from the earlier chunk.
    fs.appendFileSync(session.filePath, JSON.stringify({
      type: 'user', timestamp: '2026-08-03T00:00:31Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'pending-call', content: 'slept' },
      ] },
    }) + '\n');
    await ensureToolIndex([session], { verifySourceStamps: true });

    const calls = getDB().prepare(`SELECT ordinal, outcome, output FROM tool_calls WHERE session_id = ?`)
      .all(session.id) as Array<{ ordinal: number; outcome: string; output: string | null }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].ordinal).toBe(0);
    expect(calls[0].output).toContain('slept');
  });

  it('re-reads from the start when the transcript was rewritten shorter', async () => {
    const session = claudeSession(
      'rewritten',
      callRecords('a-call', 'git status', 'clean') + callRecords('b-call', 'gh pr view', 'open'),
    );
    await ensureToolIndex([session], { verifySourceStamps: true });
    expect(ledger(session.id).call_count).toBe(2);

    // Shorter means the stored prefix no longer describes this file, so the
    // resume point must be refused rather than applied to different bytes.
    fs.writeFileSync(session.filePath, callRecords('c-call', 'ls', 'ok'));
    await ensureToolIndex([session], { verifySourceStamps: true });

    expect(storedCalls(session.id).map((row) => row.source_call_id)).toEqual(['c-call']);
  });

  it('re-reads from the start when the extractor version moved on', async () => {
    const session = claudeSession('stale-extractor', callRecords('old-call', 'git status', 'clean'));
    await ensureToolIndex([session], { verifySourceStamps: true });

    getDB().prepare(`UPDATE tool_scan_ledger SET extractor_version = extractor_version - 1 WHERE session_id = ?`)
      .run(session.id);
    mutatePrefix(session, 'git status', 'git st4tus');
    fs.appendFileSync(session.filePath, callRecords('new-call', 'gh pr view', 'open'));
    await ensureToolIndex([session], { verifySourceStamps: true });

    // A resume point written by a different extractor is refused, so the whole
    // file is re-read -- and the doctored prefix proves it was.
    expect(storedCalls(session.id)[0].input).toContain('git st4tus');
    expect(storedCalls(session.id).map((row) => row.source_call_id)).toEqual(['old-call', 'new-call']);
  });

  it('re-derives the same ordinals for a record that had no trailing newline', async () => {
    const unterminated = JSON.stringify({
      type: 'assistant', timestamp: '2026-08-03T00:00:00Z', message: { content: [
        { type: 'tool_use', id: 'tail-call', name: 'Bash', input: { command: 'git status' } },
      ] },
    });
    const session = claudeSession('unterminated', callRecords('head-call', 'ls', 'ok') + unterminated);
    const prefixSize = Buffer.byteLength(callRecords('head-call', 'ls', 'ok'));

    await ensureToolIndex([session], { verifySourceStamps: true });
    // The half-written record is indexed, but the resume point stops before it.
    expect(storedCalls(session.id).map((row) => row.source_call_id)).toEqual(['head-call', 'tail-call']);
    expect(ledger(session.id).parsed_offset).toBe(prefixSize);

    // Completing that record and appending another must not mint a second
    // ordinal for the record the previous scan already indexed.
    fs.appendFileSync(session.filePath, '\n' + callRecords('after-call', 'gh pr view', 'open'));
    await ensureToolIndex([session], { verifySourceStamps: true });

    expect(storedCalls(session.id).map((row) => [row.ordinal, row.source_call_id])).toEqual([
      [0, 'head-call'],
      [1, 'tail-call'],
      [2, 'after-call'],
    ]);
  });
});
