/**
 * Verifies parseRush normalizes the flat rush messages.jsonl format to the
 * shared SessionEvent shape, and detectAgent routes both local and cloud
 * filename conventions to the right parser.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRush, detectAgent, parseSession } from '@phnx-labs/sessions-cli/reader';

function writeTmp(content: string): string {
  const p = path.join(os.tmpdir(), `rush-parse-${Date.now()}-${Math.random()}.jsonl`);
  fs.writeFileSync(p, content);
  return p;
}

describe('parseRush', () => {
  test('maps message/tool_call/tool_result to normalized events', () => {
    const jsonl = [
      {
        id: 'm1',
        session_id: 's1',
        role: 'user',
        type: 'message',
        content: { text: '<user_input>Hello</user_input>' },
        created_at: '2026-04-22T10:00:00Z',
      },
      {
        id: 'm2',
        session_id: 's1',
        role: 'assistant',
        type: 'message',
        content: { text: 'Working on it' },
        created_at: '2026-04-22T10:00:01Z',
      },
      {
        id: 'tc1',
        session_id: 's1',
        role: 'assistant',
        type: 'tool_call',
        content: { input: { pattern: 'foo' } },
        created_at: '2026-04-22T10:00:02Z',
        tool_call_id: 'call_1',
        name: 'Grep',
      },
      {
        id: 'tr1',
        session_id: 's1',
        role: 'assistant',
        type: 'tool_result',
        content: { input: { pattern: 'foo' }, output: { matches: 3, success: true } },
        created_at: '2026-04-22T10:00:03Z',
        tool_call_id: 'call_1',
        name: 'Grep',
      },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');

    const p = writeTmp(jsonl);
    try {
      const events = parseRush(p);
      expect(events).toHaveLength(4);
      expect(events[0]).toMatchObject({ type: 'message', agent: 'rush', role: 'user', content: 'Hello' });
      expect(events[1]).toMatchObject({ type: 'message', role: 'assistant', content: 'Working on it' });
      expect(events[2]).toMatchObject({ type: 'tool_use', tool: 'Grep', callId: 'call_1', args: { pattern: 'foo' } });
      expect(events[3]).toMatchObject({ type: 'tool_result', tool: 'Grep', callId: 'call_1', success: true });
    } finally {
      fs.unlinkSync(p);
    }
  });

  test('skips sentinel execution_start and malformed lines', () => {
    const jsonl = [
      'not-json',
      JSON.stringify({
        role: 'system',
        type: 'message',
        content: { text: 'execution_start' },
        created_at: '2026-04-22T10:00:00Z',
      }),
      JSON.stringify({
        role: 'user',
        type: 'message',
        content: { text: 'hi' },
        created_at: '2026-04-22T10:00:01Z',
      }),
    ].join('\n');

    const p = writeTmp(jsonl);
    try {
      const events = parseRush(p);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ role: 'user', content: 'hi' });
    } finally {
      fs.unlinkSync(p);
    }
  });

  test('marks failed tool_result as error event', () => {
    const jsonl =
      JSON.stringify({
        type: 'tool_result',
        content: { input: {}, output: { success: false, error: 'boom' } },
        created_at: '2026-04-22T10:00:00Z',
        tool_call_id: 'c1',
        name: 'Bash',
      }) + '\n';

    const p = writeTmp(jsonl);
    try {
      const events = parseRush(p);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', tool: 'Bash', success: false });
    } finally {
      fs.unlinkSync(p);
    }
  });

  test('ignores non-string tool call ids', () => {
    const jsonl = [
      {
        type: 'tool_call', content: { input: ['malformed'] },
        created_at: 42, tool_call_id: 42, name: { malformed: true },
      },
      {
        type: 'tool_result', content: { output: { success: true } },
        created_at: '2026-04-22T10:00:01Z', tool_call_id: { malformed: true }, name: 'Bash',
      },
    ].map((row) => JSON.stringify(row)).join('\n');
    const p = writeTmp(jsonl);
    try {
      const events = parseRush(p);
      expect(events.map((event) => event.callId)).toEqual([undefined, undefined]);
      expect(events[0]).toMatchObject({ tool: 'unknown', args: {} });
      expect(typeof events[0].timestamp).toBe('string');
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe('detectAgent routes rush paths', () => {
  test('local ~/.rush/ path', () => {
    expect(detectAgent('/home/me/.rush/sessions/abc/messages.jsonl')).toBe('rush');
  });

  test('cloud cache session.<format>.jsonl filename', () => {
    expect(detectAgent('/tmp/cache/cloud-sessions/exec123/session.rush.jsonl')).toBe('rush');
    expect(detectAgent('/tmp/cache/cloud-sessions/exec123/session.claude.jsonl')).toBe('claude');
    expect(detectAgent('/tmp/cache/cloud-sessions/exec123/session.codex.jsonl')).toBe('codex');
  });

  test('parseSession dispatches through detectAgent for rush', () => {
    const jsonl =
      JSON.stringify({
        role: 'user',
        type: 'message',
        content: { text: 'hello' },
        created_at: '2026-04-22T10:00:00Z',
      }) + '\n';

    // Simulate a cloud cache file — dispatch uses detectAgent on the path.
    const cacheDir = path.join(os.tmpdir(), `cloud-${Date.now()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    const p = path.join(cacheDir, 'session.rush.jsonl');
    fs.writeFileSync(p, jsonl);
    try {
      const events = parseSession(p);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agent: 'rush', role: 'user', content: 'hello' });
    } finally {
      fs.unlinkSync(p);
      fs.rmdirSync(cacheDir);
    }
  });
});
