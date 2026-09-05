import { describe, expect, it } from 'vitest';
import {
  TOOL_PENDING_MAX_BYTES,
  TOOL_PENDING_MAX_CALLS,
  TOOL_CHANGED_MAX_CALLS,
  TOOL_SHELL_PARSE_MAX_BYTES,
  ToolCallCollector,
  collectClaudeToolCalls,
  collectCodexToolCalls,
  toolCallsFromEvents,
  sanitizeToolEvidenceText,
  structuredToolResult,
} from './tool-calls.js';

describe('ToolCallCollector', () => {
  it('carries a pending call across an incremental snapshot', () => {
    const first = new ToolCallCollector();
    collectClaudeToolCalls(first, {
      type: 'assistant', timestamp: '2026-08-03T00:00:00Z',
      message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'git merge topic' } }] },
    });
    expect(first.drainChanged()[0]).toMatchObject({ ordinal: 0, outcome: 'unknown', programs: ['git'] });

    const resumed = new ToolCallCollector(first.snapshot());
    collectClaudeToolCalls(resumed, {
      type: 'user', timestamp: '2026-08-03T00:00:01Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'CONFLICT', is_error: true }] },
    });
    expect(resumed.drainChanged()).toEqual([
      expect.objectContaining({ ordinal: 0, outcome: 'error', error: 'CONFLICT' }),
    ]);
  });

  it('redacts and bounds persisted inputs and results', () => {
    const calls = toolCallsFromEvents([
      {
        type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec_command',
        command: 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 git status',
      },
      {
        type: 'tool_result', agent: 'codex', timestamp: '2026-08-03T00:00:01Z', tool: 'exec_command',
        success: true, output: 'x'.repeat(5000),
      },
    ]);
    expect(calls[0].input).not.toContain('ghp_');
    expect(calls[0].programs).toContain('git');
    expect(calls[0].outcome).toBe('ok');
    expect(Buffer.byteLength(calls[0].output || '')).toBeLessThanOrEqual(1024);
  });

  it('records the result record timestamp as the call end time (PHNX-3437)', () => {
    const calls = toolCallsFromEvents([
      {
        type: 'tool_use', agent: 'claude', timestamp: '2026-08-03T00:00:00.000Z', tool: 'Bash',
        command: 'sleep 330', callId: 'call-a',
      },
      {
        type: 'tool_result', agent: 'claude', timestamp: '2026-08-03T00:05:30.000Z', tool: 'Bash',
        success: false, output: 'timed out', callId: 'call-a',
      },
    ]);
    // start is the tool_use timestamp; end is the tool_result timestamp.
    expect(calls[0].timestamp).toBe('2026-08-03T00:00:00.000Z');
    expect(calls[0].endTimestamp).toBe('2026-08-03T00:05:30.000Z');
    expect(calls[0].outcome).toBe('error');
  });

  it('leaves endTimestamp undefined for a call that never produced a result', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'claude', timestamp: '2026-08-03T00:00:00.000Z', tool: 'Bash',
      command: 'echo hi', callId: 'pending-1',
    }]);
    expect(calls[0].endTimestamp).toBeUndefined();
    expect(calls[0].outcome).toBe('unknown');
  });

  it("recognizes Codex's exec tool as a shell command", () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec',
      args: { input: 'git status' },
    }]);
    expect(calls[0].programs).toEqual(['git']);
  });

  it('extracts literal shell commands from the Codex orchestration wrapper', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec',
      args: { input: `
        const label = \`run ${'${mode}'}\`;
        const first = await tools.exec_command({ cmd: "git status\\nprintf done" });
        const second = await tools.exec_command({ "cmd": 'gh pr view' });
        text(first.output + second.output);
      ` },
    }]);
    expect(calls[0].programs).toEqual(['git', 'printf', 'gh']);
  });

  it('does not parse non-shell Codex orchestration source as Bash', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec',
      args: { input: `
        const patch = "tools.exec_command({ cmd: 'git status' })";
        text(await tools.apply_patch(patch));
      ` },
    }]);
    expect(calls[0].programs).toEqual([]);
  });

  it('ignores computed Codex orchestration commands rather than indexing wrapper tokens', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec',
      args: { input: 'const cmd = chooseCommand(); await tools.exec_command({ cmd });' },
    }]);
    expect(calls[0].programs).toEqual([]);
  });

  it('bounds Codex orchestration parsing before building a JavaScript AST', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec',
      args: { input: `${' '.repeat(TOOL_SHELL_PARSE_MAX_BYTES)}tools.exec_command({ cmd: 'git status' })` },
    }]);
    expect(calls[0].programs).toEqual([]);
  });

  it('redacts nested secret-shaped argument fields before JSON persistence', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'http',
      args: { url: 'https://example.test', headers: { authorization: 'unrecognized credential', apiKey: 'also private' } },
    }]);
    expect(calls[0].input).toContain('https://example.test');
    expect(calls[0].input).not.toContain('unrecognized credential');
    expect(calls[0].input).not.toContain('also private');
  });

  it('normalizes malformed adapter fields at the evidence boundary', () => {
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'rush', timestamp: 42, tool: { malformed: true },
      callId: 99, args: ['not', 'a', 'record'], command: { unsafe: true },
    } as any]);
    expect(calls).toEqual([
      expect.objectContaining({ timestamp: '', tool: 'unknown', input: 'unknown', sourceCallId: undefined }),
    ]);
  });

  it('bounds non-shell argument traversal before serialization', () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 2_000; i++) args[`field_${String(i).padStart(4, '0')}`] = 'x'.repeat(256);
    Object.defineProperty(args, 'zzzz_unreachable', {
      enumerable: true,
      get: () => { throw new Error('serializer traversed beyond its byte budget'); },
    });
    const calls = toolCallsFromEvents([{
      type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'custom', args,
    }]);
    expect(Buffer.byteLength(calls[0].input)).toBeLessThanOrEqual(16 * 1024);
    expect(calls[0].input).toContain('[truncated]');
  });

  it('redacts credential positions and terminal controls in raw input and output', () => {
    const credential = 'opaque-session-credential-123456';
    const calls = toolCallsFromEvents([
      {
        type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'exec_command',
        command: `curl -H "Cookie: sid=${credential}; theme=dark" https://example.test`,
      },
      {
        type: 'tool_result', agent: 'codex', timestamp: '2026-08-03T00:00:01Z', tool: 'exec_command',
        success: true, output: `{"password":"${credential}"}\x1b]52;c;payload\x07`,
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(credential);
    expect(JSON.stringify(calls)).not.toContain('\x1b');
    expect(JSON.stringify(calls)).not.toContain('\x07');
  });

  it('redacts a known secret that crosses the raw-processing boundary', () => {
    const credential = '~'.repeat(8192);
    const input = `${'x'.repeat(60_000)}${credential} tail`;
    const sanitized = sanitizeToolEvidenceText(input, 64 * 1024, [credential]);
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('~');
  });

  it('bounds pending call continuation state and never mis-correlates an evicted id', () => {
    const collector = new ToolCallCollector();
    for (let i = 0; i < TOOL_PENDING_MAX_CALLS + 20; i++) {
      collector.start({
        timestamp: '2026-08-03T00:00:00Z', sourceCallId: `call-${i}`, tool: 'exec_command',
        command: `printf '%s' '${'x'.repeat(Math.ceil(TOOL_PENDING_MAX_BYTES / TOOL_PENDING_MAX_CALLS))}'`,
      });
    }
    const snapshot = collector.snapshot();
    expect(snapshot.pending.length).toBeLessThanOrEqual(TOOL_PENDING_MAX_CALLS);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(TOOL_PENDING_MAX_BYTES + 32_768);
    expect(collector.finish({ timestamp: '2026-08-03T00:00:01Z', sourceCallId: 'call-0', output: 'wrong' }))
      .toBeUndefined();
  });

  it('bounds completed calls before the persistence layer receives them', () => {
    const collector = new ToolCallCollector();
    for (let i = 0; i < TOOL_CHANGED_MAX_CALLS + 20; i++) {
      collector.start({ timestamp: '2026-08-03T00:00:00Z', sourceCallId: `done-${i}`, tool: 'http' });
      collector.finish({ timestamp: '2026-08-03T00:00:01Z', sourceCallId: `done-${i}`, output: 'ok' });
    }
    const changed = collector.drainChanged();
    expect(changed).toHaveLength(TOOL_CHANGED_MAX_CALLS + 1);
    expect(changed.at(-1)).toMatchObject({ tool: 'index_limit' });
  });

  it('preserves distinct calls when multiple clauses can match one session', () => {
    const calls = toolCallsFromEvents([
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-03T00:00:00Z', tool: 'Bash', command: 'git merge topic' },
      { type: 'tool_use', agent: 'claude', timestamp: '2026-08-03T00:00:01Z', tool: 'Bash', command: 'gh pr view' },
    ]);
    expect(calls.map((call) => call.ordinal)).toEqual([0, 1]);
  });

  it('correlates interleaved same-tool results by native call id, not arrival order', () => {
    const calls = toolCallsFromEvents([
      { type: 'tool_use', agent: 'grok', timestamp: '2026-08-03T00:00:00Z', tool: 'bash', callId: 'first', command: 'printf first' },
      { type: 'tool_use', agent: 'grok', timestamp: '2026-08-03T00:00:01Z', tool: 'bash', callId: 'second', command: 'printf second' },
      { type: 'tool_result', agent: 'grok', timestamp: '2026-08-03T00:00:02Z', tool: 'bash', callId: 'second', success: true, output: 'SECOND' },
      { type: 'tool_result', agent: 'grok', timestamp: '2026-08-03T00:00:03Z', tool: 'bash', callId: 'first', success: true, output: 'FIRST' },
    ]);
    expect(calls.find((call) => call.input === 'printf first')?.output).toBe('FIRST');
    expect(calls.find((call) => call.input === 'printf second')?.output).toBe('SECOND');
  });

  it('keeps long native call ids distinct after bounding their persisted form', () => {
    const prefix = 'x'.repeat(600);
    const calls = toolCallsFromEvents([
      { type: 'tool_use', agent: 'grok', timestamp: '2026-08-03T00:00:00Z', tool: 'bash', callId: `${prefix}-a`, command: 'printf first' },
      { type: 'tool_use', agent: 'grok', timestamp: '2026-08-03T00:00:01Z', tool: 'bash', callId: `${prefix}-b`, command: 'printf second' },
      { type: 'tool_result', agent: 'grok', timestamp: '2026-08-03T00:00:02Z', tool: 'bash', callId: `${prefix}-b`, success: true, output: 'SECOND' },
      { type: 'tool_result', agent: 'grok', timestamp: '2026-08-03T00:00:03Z', tool: 'bash', callId: `${prefix}-a`, success: true, output: 'FIRST' },
    ]);
    expect(new Set(calls.map((call) => call.sourceCallId)).size).toBe(2);
    expect(calls.find((call) => call.input === 'printf first')?.output).toBe('FIRST');
    expect(calls.find((call) => call.input === 'printf second')?.output).toBe('SECOND');
  });

  it('leaves ambiguous same-tool results unattached when the harness omits call ids', () => {
    const calls = toolCallsFromEvents([
      { type: 'tool_use', agent: 'gemini', timestamp: '2026-08-03T00:00:00Z', tool: 'bash', command: 'printf first' },
      { type: 'tool_use', agent: 'gemini', timestamp: '2026-08-03T00:00:01Z', tool: 'bash', command: 'printf second' },
      { type: 'tool_result', agent: 'gemini', timestamp: '2026-08-03T00:00:02Z', tool: 'bash', success: true, output: 'UNSAFE' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.outcome === 'unknown' && call.output === undefined)).toBe(true);
  });

  it('records only structured status metadata and leaves plain Codex text unknown', () => {
    const collector = new ToolCallCollector();
    collectCodexToolCalls(collector, {
      type: 'response_item', timestamp: '2026-08-03T00:00:00Z',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{"command":"false"}' },
    });
    collectCodexToolCalls(collector, {
      type: 'response_item', timestamp: '2026-08-03T00:00:01Z',
      payload: { type: 'function_call_output', call_id: 'a', output: 'Process exited with code 7' },
    });
    collectCodexToolCalls(collector, {
      type: 'response_item', timestamp: '2026-08-03T00:00:02Z',
      payload: { type: 'function_call', name: 'http', call_id: 'b', arguments: '{}' },
    });
    collectCodexToolCalls(collector, {
      type: 'response_item', timestamp: '2026-08-03T00:00:03Z',
      payload: { type: 'function_call_output', call_id: 'b', output: {
        output: 'not found', success: false, exit_code: 22, status_code: 404, error_code: 'HTTP_NOT_FOUND',
      } },
    });
    const calls = collector.drainChanged();
    expect(calls[0]).toMatchObject({ outcome: 'unknown', exitCode: undefined });
    expect(calls[1]).toMatchObject({
      outcome: 'error', exitCode: 22, statusCode: 404, errorCode: 'HTTP_NOT_FOUND', error: 'not found',
    });
  });

  it('redacts, strips controls from, and bounds structured error codes', () => {
    const credential = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const calls = toolCallsFromEvents([
      { type: 'tool_use', agent: 'codex', timestamp: '2026-08-03T00:00:00Z', tool: 'http', callId: 'code' },
      {
        type: 'tool_result', agent: 'codex', timestamp: '2026-08-03T00:00:01Z', tool: 'http', callId: 'code',
        success: false, errorCode: `${credential}\x1b]52;c;payload\x07${'x'.repeat(1_000)}`, output: 'failed',
      },
    ]);
    expect(calls[0].errorCode).not.toContain(credential);
    expect(calls[0].errorCode).not.toContain('\x1b');
    expect(Buffer.byteLength(calls[0].errorCode ?? '')).toBeLessThanOrEqual(512);
  });
});

// PHNX-3761: Codex exec/apply_patch results are a string or input_text[], never
// an object, so before this they always classified 'unknown' and the console
// error rate read 0%. The only signal is the leading "Script failed"/"Script
// completed" marker. Shapes below are copied from real ~/.codex/sessions rows.
describe('structuredToolResult — Codex output shapes', () => {
  it('classifies a leading "Script failed" string as an error', () => {
    expect(structuredToolResult('Script failed\nWall time 0.1 seconds\nOutput:\n').outcome).toBe('error');
  });

  it('classifies a leading "Script completed" string as ok', () => {
    expect(structuredToolResult('Script completed\nWall time 0.0 seconds\nOutput:\n').outcome).toBe('ok');
  });

  it('reads the marker from the first block of an input_text[] result and joins the text', () => {
    const result = structuredToolResult([
      { type: 'input_text', text: 'Script failed\nWall time 0.3 seconds\nOutput:\n' },
      { type: 'input_text', text: 'error: apply_patch verification failed: Failed to find expected lines' },
    ]);
    expect(result.outcome).toBe('error');
    expect(result.text).toContain('Script failed');
    expect(result.text).toContain('apply_patch verification failed');
  });

  it('classifies a completed input_text[] result as ok', () => {
    expect(structuredToolResult([
      { type: 'input_text', text: 'Script completed\nWall time 9.6 seconds\nOutput:\n' },
      { type: 'input_text', text: '{"chunk_id":"b7deb4","exit_code":0}' },
    ]).outcome).toBe('ok');
  });

  it('leaves an async "Script running" cell unknown (no outcome yet)', () => {
    expect(structuredToolResult('Script running with cell ID 25\nWall time 11.0 seconds\nOutput:\n').outcome).toBe('unknown');
  });

  it('still honours the object success/is_error path (Claude)', () => {
    expect(structuredToolResult({ is_error: true, content: 'CONFLICT' }).outcome).toBe('error');
    expect(structuredToolResult({ success: true, exit_code: 0 }).outcome).toBe('ok');
    expect(structuredToolResult({ success: false, exit_code: 1 })).toMatchObject({ outcome: 'error', exitCode: 1 });
  });
});
