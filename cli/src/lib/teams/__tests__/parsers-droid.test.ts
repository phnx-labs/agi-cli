import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { normalizeEvents, parseEvent } from '../parsers.js';
import { summarizeEvents } from '../summarizer.js';

function fixtureLines(name: string): string[] {
  const p = fileURLToPath(new URL(`./testdata/${name}`, import.meta.url));
  return fs.readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('normalizeEvents(droid)', () => {
  it('maps the real message-envelope stream into summary-visible activity', () => {
    const events = fixtureLines('droid-stream-json.jsonl').flatMap((line) => parseEvent('droid', line) ?? []);
    const summary = summarizeEvents('droid-1', 'droid', 'completed', events);

    expect(summary.filesRead).toContain('package.json');
    expect(summary.filesModified).toContain('droid-summary-sample.txt');
    expect(summary.filesModified).toContain('/work/src/index.ts');
    expect(summary.toolsUsed).toContain('bash');
    expect(summary.toolCallCount).toBe(4);
    expect(summary.finalMessage).toBe('Droid sample complete.');
  });

  it('maps Create, Read, and unknown tools to the shared event shape', () => {
    expect(normalizeEvents('droid', {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'create-1', name: 'Create', input: { file_path: '/work/new.ts' } }],
      },
    })[0]).toMatchObject({
      type: 'file_create',
      agent: 'droid',
      tool: 'Create',
      path: '/work/new.ts',
    });

    expect(normalizeEvents('droid', {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/work/new.ts' } }],
      },
    })[0]).toMatchObject({
      type: 'file_read',
      agent: 'droid',
      tool: 'Read',
      path: '/work/new.ts',
    });

    expect(normalizeEvents('droid', {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: 'done' } }],
      },
    })[0]).toMatchObject({
      type: 'tool_use',
      agent: 'droid',
      tool: 'TodoWrite',
      args: { todos: 'done' },
    });
  });

  it('maps failed tool results to errors using the correlated tool name', () => {
    normalizeEvents('droid', {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'execute-fail', name: 'Execute', input: { command: 'false' } }],
      },
    });

    const events = normalizeEvents('droid', {
      type: 'message',
      timestamp: '2026-07-20T08:05:06.384Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'execute-fail', is_error: true, content: 'failed' }],
      },
    });

    expect(events[0]).toMatchObject({
      type: 'error',
      agent: 'droid',
      tool: 'Execute',
      content: 'failed',
    });
  });
});
