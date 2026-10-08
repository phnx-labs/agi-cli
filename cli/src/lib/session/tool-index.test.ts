import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-tool-index-'));
process.env.HOME = TEST_HOME;
process.env.TEST_API_TOKEN = 'literal-secret-value-789';

const { closeDB, getDB, upsertSession } = await import('./db.js');
const {
  ensureToolIndex,
  readToolIndexCoverage,
  BACKFILL_MAX_STREAM_SOURCE_BYTES,
} = await import('./tool-index.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  delete process.env.TEST_API_TOKEN;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function writeClaudeSession(name: string): SessionMeta {
  const filePath = path.join(TEST_HOME, `${name}.jsonl`);
  const lines = [
    { type: 'assistant', timestamp: '2026-08-03T00:00:00Z', message: { content: [
      { type: 'tool_use', id: 'git-call', name: 'Bash', input: { command: 'TOKEN=literal-secret-value-789 git merge topic' } },
    ] } },
    { type: 'user', timestamp: '2026-08-03T00:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'git-call', content: 'merge completed' },
    ] } },
    { type: 'assistant', timestamp: '2026-08-03T00:00:02Z', message: { content: [
      { type: 'tool_use', id: 'gh-call', name: 'Bash', input: { command: 'gh pr view' } },
    ] } },
    { type: 'user', timestamp: '2026-08-03T00:00:03Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'gh-call', content: 'CONFLICT in src/app.ts', is_error: true },
    ] } },
  ];
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const meta = {
    id: `${name}-session`, shortId: name.slice(0, 8), agent: 'claude',
    timestamp: '2026-08-03T00:00:00Z', filePath, machine: 'test-box',
  } as SessionMeta;
  upsertSession(meta, name);
  return meta;
}

describe('tool-call index', () => {
  it('indexes each call once, with secrets redacted before they reach SQLite', async () => {
    const session = writeClaudeSession('two-calls');
    const first = await ensureToolIndex([session]);
    expect(first).toMatchObject({ indexedFiles: 1, indexedCalls: 2, remainingFiles: 0, complete: true });

    const rows = getDB().prepare(`
      SELECT source_call_id, tool, input, outcome FROM tool_calls WHERE session_id = ? ORDER BY ordinal
    `).all(session.id) as Array<{ source_call_id: string; tool: string; input: string; outcome: string }>;
    expect(rows.map((row) => [row.source_call_id, row.outcome])).toEqual([['git-call', 'ok'], ['gh-call', 'error']]);
    expect(JSON.stringify(rows)).not.toContain('literal-secret-value-789');
    expect(rows[0].input).toContain('git merge topic');
  });

  it('serves a warm index without reparsing the transcript', async () => {
    const session = writeClaudeSession('warm-cache');
    await ensureToolIndex([session]);
    const warm = await ensureToolIndex([session]);
    expect(warm).toMatchObject({ indexedFiles: 0, indexedCalls: 0, remainingFiles: 0, complete: true });
  });

  it('keeps repeated static program sites and their coverage after the transcript is unavailable', async () => {
    const filePath = path.join(TEST_HOME, 'repeated-programs.jsonl');
    const session = {
      id: 'repeated-programs-session', shortId: 'repeated', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath, machine: 'test-box',
    } as SessionMeta;
    fs.writeFileSync(filePath, JSON.stringify({
      type: 'assistant', timestamp: session.timestamp, message: { content: [{
        type: 'tool_use', id: 'repeated-call', name: 'Bash',
        input: { command: 'git status; git diff' },
      }] },
    }) + '\n');
    upsertSession(session, 'repeated programs');
    await ensureToolIndex([session]);
    fs.renameSync(filePath, `${filePath}.offline`);

    expect(readToolIndexCoverage([session])).toMatchObject({ indexedFiles: 1, indexedCalls: 1, complete: true });
    expect(getDB().prepare(`
      SELECT o.program, o.role FROM tool_program_occurrences o
      JOIN tool_calls c ON c.call_key = o.call_key
      WHERE c.session_id = ? ORDER BY o.occurrence_ordinal
    `).all(session.id)).toEqual([
      { program: 'git', role: 'effective' },
      { program: 'git', role: 'effective' },
    ]);
  });

  it('advances only one bounded backfill chunk', async () => {
    const sessions = [writeClaudeSession('chunk-one'), writeClaudeSession('chunk-two')];
    const coverage = await ensureToolIndex(sessions, { maxFiles: 1, maxBytes: 1024 * 1024 });
    expect(coverage.indexedFiles).toBe(1);
    expect(coverage.remainingFiles).toBe(1);
    expect(coverage.complete).toBe(false);
  });

  it('admits one transcript larger than the batch budget so backfill cannot wedge', async () => {
    const session = writeClaudeSession('oversized');
    const coverage = await ensureToolIndex([session], { maxFiles: 1, maxBytes: 1 });
    expect(coverage).toMatchObject({ indexedFiles: 1, skippedFiles: 0, remainingFiles: 0, complete: true });
  });

  it('streams JSONL and drops a record larger than 1 MiB without losing later calls', async () => {
    const filePath = path.join(TEST_HOME, 'streamed-oversized-record.jsonl');
    const session = {
      id: 'streamed-oversized-record-session', shortId: 'streamed', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    const start = { type: 'assistant', timestamp: session.timestamp, message: { content: [
      { type: 'tool_use', id: 'stream-call', name: 'Bash', input: { command: 'git status' } },
    ] } };
    const finish = { type: 'user', timestamp: '2026-08-03T00:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'stream-call', content: 'clean' },
    ] } };
    fs.writeFileSync(filePath, `${JSON.stringify(start)}\n${'x'.repeat(1024 * 1024 + 1)}\n${JSON.stringify(finish)}\n`);
    upsertSession(session, 'streamed');

    const coverage = await ensureToolIndex([session]);
    expect(coverage).toMatchObject({ indexedFiles: 1, skippedFiles: 0, limitedFiles: 1, complete: false });
    expect(getDB().prepare(`SELECT tool, outcome FROM tool_calls WHERE session_id = ? ORDER BY ordinal`).all(session.id))
      .toEqual([
        { tool: 'Bash', outcome: 'ok' },
        { tool: 'index_limit', outcome: 'unknown' },
      ]);
  });

  it('records a limit without reading a streaming transcript over 64 MiB', async () => {
    const filePath = path.join(TEST_HOME, 'oversized-streaming-session.jsonl');
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, BACKFILL_MAX_STREAM_SOURCE_BYTES + 1);
    const session = {
      id: 'oversized-streaming-session', shortId: 'oversize', agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    upsertSession(session, 'oversized streaming transcript');

    const coverage = await ensureToolIndex([session]);
    expect(coverage).toMatchObject({ indexedFiles: 1, limitedFiles: 1, remainingFiles: 0, complete: false });
    expect(getDB().prepare(`SELECT tool, input FROM tool_calls WHERE session_id = ?`).get(session.id))
      .toEqual({
        tool: 'index_limit',
        input: 'Transcript exceeds the 64 MiB safe streaming tool-backfill limit.',
      });
  });

  it('does not materialize oversized transcripts for non-streaming harness parsers', async () => {
    const filePath = path.join(TEST_HOME, 'oversized-droid-session.jsonl');
    fs.closeSync(fs.openSync(filePath, 'w'));
    fs.truncateSync(filePath, 16 * 1024 * 1024 + 1);
    const session = {
      id: 'oversized-droid-session', shortId: 'oversize', agent: 'droid',
      timestamp: '2026-08-03T00:00:00Z', filePath,
    } as SessionMeta;
    upsertSession(session, 'oversized droid');

    await ensureToolIndex([session]);
    expect(getDB().prepare(`SELECT tool, input FROM tool_calls WHERE session_id = ?`).get(session.id))
      .toEqual({
        tool: 'index_limit',
        input: 'Transcript exceeds the 16 MiB safe in-memory tool-backfill parser limit.',
      });
  });

  it('keys Kimi freshness and source limits to wire.jsonl instead of the small state file', async () => {
    const sessionDir = path.join(TEST_HOME, 'kimi', 'session_wire-source');
    const wireDir = path.join(sessionDir, 'agents', 'main');
    const statePath = path.join(sessionDir, 'state.json');
    const wirePath = path.join(wireDir, 'wire.jsonl');
    fs.mkdirSync(wireDir, { recursive: true });
    fs.writeFileSync(statePath, '{}');
    const wireCall = (id: string, command: string, output: string) => [
      { type: 'context.append_loop_event', time: 1, event: { type: 'tool.call', toolCallId: id, name: 'Bash', args: { command } } },
      { type: 'context.append_loop_event', time: 2, event: { type: 'tool.result', toolCallId: id, result: { output } } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n';
    fs.writeFileSync(wirePath, wireCall('one', 'git status', 'clean'));
    const session = {
      id: 'session_wire-source', shortId: 'wire-sou', agent: 'kimi',
      timestamp: '2026-08-03T00:00:00Z', filePath: statePath,
    } as SessionMeta;
    upsertSession(session, 'kimi wire source');

    await ensureToolIndex([session]);
    expect(getDB().prepare(`SELECT input, output FROM tool_calls WHERE session_id = ? ORDER BY ordinal`).all(session.id))
      .toEqual([{ input: 'git status', output: 'clean' }]);

    fs.appendFileSync(wirePath, wireCall('two', 'gh pr view', 'open'));
    const refreshed = await ensureToolIndex([session]);
    expect(refreshed.indexedFiles).toBe(1);
    expect(getDB().prepare(`SELECT input, output FROM tool_calls WHERE session_id = ? ORDER BY ordinal`).all(session.id))
      .toEqual([
        { input: 'git status', output: 'clean' },
        { input: 'gh pr view', output: 'open' },
      ]);

    const oversizedStatePath = path.join(TEST_HOME, 'kimi', 'session_oversized-wire', 'state.json');
    const oversizedWirePath = path.join(path.dirname(oversizedStatePath), 'agents', 'main', 'wire.jsonl');
    fs.mkdirSync(path.dirname(oversizedWirePath), { recursive: true });
    fs.writeFileSync(oversizedStatePath, '{}');
    fs.closeSync(fs.openSync(oversizedWirePath, 'w'));
    fs.truncateSync(oversizedWirePath, 16 * 1024 * 1024 + 1);
    const oversizedSession = {
      id: 'session_oversized-wire', shortId: 'oversize', agent: 'kimi',
      timestamp: session.timestamp, filePath: oversizedStatePath,
    } as SessionMeta;
    upsertSession(oversizedSession, 'oversized kimi wire');
    await ensureToolIndex([oversizedSession]);
    expect(getDB().prepare(`SELECT tool, input FROM tool_calls WHERE session_id = ?`).get(oversizedSession.id))
      .toEqual({
        tool: 'index_limit',
        input: 'Transcript exceeds the 16 MiB safe in-memory tool-backfill parser limit.',
      });
  });
});
