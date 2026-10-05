import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { normalizeEvents } from '../parsers.js';

function fixtureLines(name: string): any[] {
  const p = fileURLToPath(new URL(`./testdata/${name}`, import.meta.url));
  return fs.readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

describe('normalizeEvents(kimi)', () => {
  it('maps assistant content to a complete message', () => {
    const events = normalizeEvents('kimi', { role: 'assistant', content: 'Hi.' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'kimi',
      content: 'Hi.',
      complete: true,
    });
  });

  it('drops empty assistant content', () => {
    expect(normalizeEvents('kimi', { role: 'assistant', content: '' })).toEqual([]);
  });

  it('maps Bash tool_calls to bash events with file-op sidecars', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        id: 'tool_1',
        function: {
          name: 'Bash',
          arguments: JSON.stringify({ command: 'cat file.txt && rm old.txt' }),
        },
      }],
    });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'bash',
        agent: 'kimi',
        tool: 'Bash',
        command: 'cat file.txt && rm old.txt',
      }),
      expect.objectContaining({
        type: 'file_read',
        agent: 'kimi',
        tool: 'bash',
        path: 'file.txt',
      }),
      expect.objectContaining({
        type: 'file_delete',
        agent: 'kimi',
        tool: 'bash',
        path: 'old.txt',
      }),
    ]));
  });

  it('maps Read tool_calls to file_read events', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        id: 'tool_2',
        function: {
          name: 'Read',
          arguments: JSON.stringify({ path: '/tmp/readme.md' }),
        },
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'file_read',
      agent: 'kimi',
      tool: 'Read',
      path: '/tmp/readme.md',
    });
  });

  it('maps Edit tool_calls to file_write events', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        id: 'tool_3',
        function: {
          name: 'Edit',
          arguments: JSON.stringify({ path: '/tmp/file.txt', old_string: 'a', new_string: 'b' }),
        },
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'file_write',
      agent: 'kimi',
      tool: 'Edit',
      path: '/tmp/file.txt',
    });
  });

  it('maps Write tool_calls to file_create events', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        id: 'tool_4',
        function: {
          name: 'Write',
          arguments: JSON.stringify({ path: '/tmp/new.txt', content: 'hello' }),
        },
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'file_create',
      agent: 'kimi',
      tool: 'Write',
      path: '/tmp/new.txt',
    });
  });

  it('maps unknown tools to tool_use events', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        id: 'tool_5',
        function: {
          name: 'FetchURL',
          arguments: JSON.stringify({ url: 'https://example.com' }),
        },
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      agent: 'kimi',
      tool: 'FetchURL',
      args: { url: 'https://example.com' },
    });
  });

  it('handles multiple tool_calls in one assistant event', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [
        {
          type: 'function',
          id: 'tool_6',
          function: {
            name: 'Read',
            arguments: JSON.stringify({ path: '/a' }),
          },
        },
        {
          type: 'function',
          id: 'tool_7',
          function: {
            name: 'Read',
            arguments: JSON.stringify({ path: '/b' }),
          },
        },
      ],
    });

    expect(events).toHaveLength(2);
    expect(events[0].path).toBe('/a');
    expect(events[1].path).toBe('/b');
  });

  it('maps tool results to tool_result events', () => {
    const events = normalizeEvents('kimi', {
      role: 'tool',
      tool_call_id: 'tool_1',
      content: 'output here',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      agent: 'kimi',
      tool_call_id: 'tool_1',
      success: true,
      content: 'output here',
    });
  });

  it('marks tool results with Error: prefix as failures', () => {
    const events = normalizeEvents('kimi', {
      role: 'tool',
      tool_call_id: 'tool_1',
      content: 'Error: command failed',
    });

    expect(events[0].success).toBe(false);
  });

  it('marks tool results with isError as failures', () => {
    const events = normalizeEvents('kimi', {
      role: 'tool',
      tool_call_id: 'tool_1',
      content: 'something',
      isError: true,
    });

    expect(events[0].success).toBe(false);
  });

  it('maps session.resume_hint (kimi terminal marker) to a success result with session_id', () => {
    const events = normalizeEvents('kimi', {
      role: 'meta',
      type: 'session.resume_hint',
      session_id: 'sess-123',
      command: 'kimi -r sess-123',
      content: 'To resume...',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'result',
      agent: 'kimi',
      status: 'success',
      session_id: 'sess-123',
    });
  });

  it('passes through unknown meta types as meta events', () => {
    const events = normalizeEvents('kimi', {
      role: 'meta',
      type: 'custom',
      payload: 'x',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'meta',
      agent: 'kimi',
      meta_type: 'custom',
    });
  });

  it('falls back to unknown for malformed input', () => {
    const events = normalizeEvents('kimi', null);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'unknown',
      agent: 'kimi',
    });
  });

  it('falls back to unknown for unrecognized roles', () => {
    const events = normalizeEvents('kimi', { role: 'system', type: 'ping' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ping',
      agent: 'kimi',
    });
  });

  it('survives unparseable tool arguments', () => {
    const events = normalizeEvents('kimi', {
      role: 'assistant',
      tool_calls: [{
        type: 'function',
        id: 'tool_bad',
        function: {
          name: 'Bash',
          arguments: 'not-json',
        },
      }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      agent: 'kimi',
      tool: 'Bash',
    });
    expect(events[0].args).toMatchObject({ _raw: 'not-json' });
  });
});

describe('normalizeEvents(kimi) — real captured streams', () => {
  for (const fixture of ['kimi-stream-notool.jsonl', 'kimi-stream-tool.jsonl']) {
    it(`${fixture}: emits exactly one terminal result (success), and it is last`, () => {
      const raws = fixtureLines(fixture);
      const events = raws.flatMap((r) => normalizeEvents('kimi', r));

      const results = events.filter((e) => e.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ agent: 'kimi', status: 'success' });

      expect(events[events.length - 1].type).toBe('result');
      expect(events.some((e) => e.type === 'init')).toBe(false);
    });
  }
});
