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
  countToolProgramOccurrences,
  readToolIndexCoverage,
  searchToolCalls,
  serializeToolSearchEnvelope,
  toolSearchRemoteReceiveBudget,
  TOOL_QUERY_MAX_SERIALIZED_BYTES,
  TOOL_QUERY_MERGE_OVERHEAD_BYTES,
  BACKFILL_MAX_STREAM_SOURCE_BYTES,
} = await import('./tool-index.js');
const { persistToolCalls } = await import('./tool-store.js');
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
  it('requires repeated clauses to match distinct calls in one session', async () => {
    const session = writeClaudeSession('two-calls');
    const first = await ensureToolIndex([session]);
    expect(first).toMatchObject({ indexedFiles: 1, indexedCalls: 2, remainingFiles: 0, complete: true });

    const result = searchToolCalls(
      [session],
      ['program:git input:merge', 'program:gh output:CONFLICT'],
      first,
    );
    expect(result.schemaVersion).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].calls.map((call) => call.sourceCallId)).toEqual(['git-call', 'gh-call']);
    expect(JSON.stringify(result)).not.toContain('literal-secret-value-789');

    const substring = searchToolCalls([session], ['input:erge'], first);
    expect(substring.sessions).toHaveLength(1);
    expect(substring.sessions[0].calls[0].input).toContain('merge');

    const impossible = searchToolCalls(
      [session],
      ['program:git', 'program:git'],
      first,
    );
    expect(impossible.sessions).toEqual([]);
    expect(() => searchToolCalls([session], Array.from({ length: 33 }, () => 'program:git'), first))
      .toThrow('at most 32');
  });

  it('does not silently cap the filtered session scope at 10,000 rows', async () => {
    const target = writeClaudeSession('beyond-ten-thousand');
    const coverage = await ensureToolIndex([target]);
    const filler = Array.from({ length: 10_000 }, (_, index) => ({
      id: `filler-${index}`, shortId: `f${index}`, agent: 'claude',
      timestamp: '2026-08-03T00:00:00Z', filePath: path.join(TEST_HOME, `absent-${index}.jsonl`),
    } as SessionMeta));

    const result = searchToolCalls([...filler, target], ['program:git'], coverage, 1_000);
    expect(result.sessions.map((session) => session.id)).toEqual([target.id]);
  });

  it('serves a warm index without reparsing the transcript', async () => {
    const session = writeClaudeSession('warm-cache');
    await ensureToolIndex([session]);
    const warm = await ensureToolIndex([session]);
    expect(warm).toMatchObject({ indexedFiles: 0, indexedCalls: 0, remainingFiles: 0, complete: true });
  });

  it('counts repeated static sites from SQLite after the transcript is unavailable', async () => {
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

    const coverage = readToolIndexCoverage([session]);
    expect(coverage.complete).toBe(true);
    expect(countToolProgramOccurrences([session], 'git', coverage, 'test-box')).toMatchObject({
      totals: { occurrences: 2, toolCalls: 1, sessions: 1 },
    });
    expect(searchToolCalls([session], ['program:git'], coverage).sessions[0].calls[0])
      .toMatchObject({
        programs: ['git'],
        programOccurrences: [
          { program: 'git', role: 'effective' },
          { program: 'git', role: 'effective' },
        ],
      });
  });

  it('groups a direct local count by each transcript origin', async () => {
    const sessions = [
      { id: 'origin-local', machine: 'local-box', command: 'git status' },
      { id: 'origin-mirror', machine: 'peer-box', command: 'git diff; git log' },
    ].map(({ id, machine, command }) => {
      const filePath = path.join(TEST_HOME, `${id}.jsonl`);
      const session = {
        id, shortId: id.slice(0, 8), agent: 'claude', machine,
        timestamp: '2026-08-03T00:00:00Z', filePath,
      } as SessionMeta;
      fs.writeFileSync(filePath, JSON.stringify({
        type: 'assistant', timestamp: session.timestamp, message: { content: [{
          type: 'tool_use', id: `${id}-call`, name: 'Bash', input: { command },
        }] },
      }) + '\n');
      upsertSession(session, id);
      return session;
    });
    await ensureToolIndex(sessions);

    const count = countToolProgramOccurrences(
      sessions,
      'git',
      readToolIndexCoverage(sessions),
      'local-box',
    );
    expect(count.totals).toEqual({ occurrences: 3, toolCalls: 2, sessions: 2 });
    expect(count.machines).toMatchObject([
      { machine: 'local-box', totals: { occurrences: 1, toolCalls: 1, sessions: 1 } },
      { machine: 'peer-box', totals: { occurrences: 2, toolCalls: 1, sessions: 1 } },
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

  it('bounds the requested session count and aggregate evidence bytes', () => {
    const coverage = { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true };
    expect(() => searchToolCalls([writeClaudeSession('bad-limit')], [], coverage, 1_001))
      .toThrow('from 1 to 1000');

    const sessions = ['large-a', 'large-b'].map((name) => {
      const filePath = path.join(TEST_HOME, `${name}.jsonl`);
      fs.writeFileSync(filePath, '{}\n');
      const session = {
        id: `${name}-session`, shortId: name, agent: 'codex',
        timestamp: '2026-08-03T00:00:00Z', filePath,
      } as SessionMeta;
      upsertSession(session, name);
      const stat = fs.statSync(filePath);
      persistToolCalls(getDB(), session, Array.from({ length: 280 }, (_, ordinal) => ({
        ordinal,
        timestamp: session.timestamp,
        tool: 'exec_command',
        programs: ['printf'],
        programOccurrences: [{ program: 'printf', role: 'effective' as const }],
        input: `printf ${'x'.repeat(15_500)}`,
        outcome: 'unknown' as const,
      })), { fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
      return session;
    });

    expect(() => searchToolCalls(sessions, [], coverage, 2)).toThrow('8 MiB');
  });

  it('keeps JSON encoding below the fleet stdout budget', () => {
    const input = '"'.repeat(16_000);
    const sessions = ['encoded-a', 'encoded-b'].map((id) => ({
      id, shortId: id, agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
      calls: Array.from({ length: 261 }, (_, ordinal) => ({
        id: `${id}:${ordinal}`,
        ordinal,
        timestamp: '2026-08-03T00:00:00Z',
        tool: 'exec_command',
        programs: ['printf'],
        programOccurrences: [{ program: 'printf', role: 'effective' as const }],
        input,
        outcome: 'unknown' as const,
      })),
    }));
    const envelope = {
      schemaVersion: 1 as const,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: [] },
      coverage: { indexedFiles: 0, indexedCalls: 0, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions,
    };
    expect(() => serializeToolSearchEnvelope(envelope)).toThrow('15 MiB after JSON encoding');
  });

  it('reserves the local envelope and coordinator overhead before accepting peer bytes', () => {
    const envelope = {
      schemaVersion: 1 as const,
      generatedAt: '2026-08-03T00:00:00Z',
      query: { clauses: ['program:git'] },
      coverage: { indexedFiles: 1, indexedCalls: 20, skippedFiles: 0, limitedFiles: 0, remainingFiles: 0, complete: true },
      sessions: [{
        id: 'local', shortId: 'local', agent: 'codex', timestamp: '2026-08-03T00:00:00Z',
        calls: Array.from({ length: 20 }, (_, ordinal) => ({
          id: `local:${ordinal}`,
          ordinal,
          timestamp: '2026-08-03T00:00:00Z',
          tool: 'exec_command',
          programs: ['git'],
          programOccurrences: [{ program: 'git', role: 'effective' as const }],
          input: `git status ${'x'.repeat(16_000)}`,
          outcome: 'unknown' as const,
        })),
      }],
    };
    const localBytes = Buffer.byteLength(serializeToolSearchEnvelope(envelope));
    expect(toolSearchRemoteReceiveBudget(envelope)).toBe(
      TOOL_QUERY_MAX_SERIALIZED_BYTES - TOOL_QUERY_MERGE_OVERHEAD_BYTES - localBytes,
    );
  });
});
