/**
 * Verifies parseGrok normalizes Grok's chat_history.jsonl transcript into the
 * shared SessionEvent shape (user/assistant/tool_use/thinking/tool_result), and
 * that detectAgent routes Grok session paths correctly.
 */

import { describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseGrok, detectAgent } from '@phnx-labs/sessions-cli/reader';
import { toolCallsFromEvents } from '@phnx-labs/sessions-cli/reader';

/**
 * Build a Grok session dir (summary.json + chat_history.jsonl) and return the
 * summary.json path — that is what the scanner records as the session filePath,
 * and what parseSession hands the parser.
 */
function makeGrokSession(historyLines: object[]): string {
  const dir = path.join(
    os.tmpdir(),
    '.grok', 'sessions', '%2Ftmp%2Fproj',
    `grok-parse-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ created_at: '2026-07-31T00:00:00.000Z' }));
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), historyLines.map(o => JSON.stringify(o)).join('\n'));
  return path.join(dir, 'summary.json');
}

describe('parseGrok', () => {
  test('classifies user/assistant/tool_use/thinking/tool_result and skips system', () => {
    const summaryPath = makeGrokSession([
      { type: 'system', content: 'You are Grok.' },
      { type: 'user', content: [{ type: 'text', text: 'list the files' }] },
      { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'need to run ls' }], status: 'done' },
      {
        type: 'assistant',
        content: 'Running ls now.',
        tool_calls: [{ id: 'call_1', name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }) }],
      },
      { type: 'tool_result', tool_call_id: 'call_1', content: 'file_a\nfile_b' },
    ]);

    const events = parseGrok(summaryPath);

    // system is intentionally dropped.
    expect(events.find(e => (e as any).content === 'You are Grok.')).toBeUndefined();

    const user = events.find(e => e.type === 'message' && e.role === 'user');
    expect(user?.content).toBe('list the files');

    const thinking = events.find(e => e.type === 'thinking');
    expect(thinking?.content).toBe('need to run ls');

    const assistant = events.find(e => e.type === 'message' && e.role === 'assistant');
    expect(assistant?.content).toBe('Running ls now.');

    const toolUse = events.find(e => e.type === 'tool_use');
    expect(toolUse?.tool).toBe('bash');
    expect(toolUse?.callId).toBe('call_1');
    expect(toolUse?.args?.command).toBe('ls -la');
    expect(toolUse?.command).toBe('ls -la');

    const toolResult = events.find(e => e.type === 'tool_result');
    // tool name is correlated back from the earlier tool_call id.
    expect(toolResult?.tool).toBe('bash');
    expect(toolResult?.callId).toBe('call_1');
    expect(toolResult?.success).toBeUndefined();
    expect(toolResult?.outcome).toBe('unknown');
    expect(toolResult?.output).toBe('file_a\nfile_b');

    // Every event carries the session's created_at timestamp.
    expect(events.every(e => e.timestamp === '2026-07-31T00:00:00.000Z')).toBe(true);
    // Every event is tagged as grok.
    expect(events.every(e => e.agent === 'grok')).toBe(true);
  });

  test('maps a tool_result whose content starts with "Error:" to an error event', () => {
    const summaryPath = makeGrokSession([
      {
        type: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_err', name: 'read_file', arguments: JSON.stringify({ path: '/nope' }) }],
      },
      { type: 'tool_result', tool_call_id: 'call_err', content: 'Error: no such file' },
    ]);

    const events = parseGrok(summaryPath);
    const errored = events.find(e => e.type === 'error');
    expect(errored?.tool).toBe('read_file');
    expect(errored?.success).toBeUndefined();
    expect(errored?.outcome).toBe('unknown');
    expect(toolCallsFromEvents(events)).toEqual([
      expect.objectContaining({ outcome: 'unknown', output: 'Error: no such file' }),
    ]);
    // An assistant turn with empty text emits only the tool_use, no empty message.
    expect(events.some(e => e.type === 'message')).toBe(false);
    const toolUse = events.find(e => e.type === 'tool_use');
    expect(toolUse?.path).toBe('/nope');
  });

  test('returns no events when chat_history.jsonl is absent', () => {
    const dir = path.join(os.tmpdir(), '.grok', 'sessions', 'x', `empty-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ created_at: '2026-07-31T00:00:00.000Z' }));
    expect(parseGrok(path.join(dir, 'summary.json'))).toEqual([]);
  });

  test('detectAgent routes a Grok session path to grok', () => {
    expect(detectAgent('/home/u/.grok/sessions/%2Ftmp/abc/chat_history.jsonl')).toBe('grok');
    expect(detectAgent('/home/u/.grok/sessions/%2Ftmp/abc/summary.json')).toBe('grok');
  });
});
