import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSSE, renderStream } from './stream.js';
import type { CloudEvent } from './types.js';

function sseResponse(text: string): Response {
  return new Response(text, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(text: string): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  for await (const e of parseSSE(sseResponse(text))) {
    events.push(e);
  }
  return events;
}


describe('parseSSE', () => {
  it('yields nothing for an empty stream', async () => {
    expect(await collect('')).toEqual([]);
  });

  it('parses a status event', async () => {
    const raw = 'event: status\ndata: {"status":"running","id":"t1"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('status');
    if (e.type === 'status') expect(e.status).toBe('running');
  });

  it('maps factory "output" event to type text', async () => {
    const raw = 'event: output\ndata: {"content":"hello world"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('text');
    if (e.type === 'text') expect(e.content).toBe('hello world');
  });

  it('maps "message" event to type text', async () => {
    const raw = 'event: message\ndata: {"content":"hi"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('text');
  });

  it('maps "text" event to type text', async () => {
    const raw = 'event: text\ndata: {"content":"direct text"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('text');
    if (e.type === 'text') expect(e.content).toBe('direct text');
  });

  it('parses a done event with status and summary', async () => {
    const raw = 'event: done\ndata: {"status":"completed","output":"fixed the bug"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('done');
    if (e.type === 'done') {
      expect(e.status).toBe('completed');
      expect(e.summary).toBe('fixed the bug');
    }
  });

  it('parses a done event with prUrl', async () => {
    const raw = 'event: done\ndata: {"status":"completed","prUrl":"https://github.com/org/repo/pull/1"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('done');
    if (e.type === 'done') expect(e.prUrl).toBe('https://github.com/org/repo/pull/1');
  });

  it('parses an error event', async () => {
    const raw = 'event: error\ndata: {"message":"Task deleted"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('error');
    if (e.type === 'error') expect(e.message).toBe('Task deleted');
  });

  it('parses a thinking event', async () => {
    const raw = 'event: thinking\ndata: {"content":"analyzing the code"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('thinking');
    if (e.type === 'thinking') expect(e.content).toBe('analyzing the code');
  });

  it('parses a tool_use event', async () => {
    const raw = 'event: tool_use\ndata: {"tool":"Bash","input":{"command":"ls"}}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('tool_use');
    if (e.type === 'tool_use') {
      expect(e.tool).toBe('Bash');
      expect(e.input).toEqual({ command: 'ls' });
    }
  });

  it('parses a tool_result event', async () => {
    const raw = 'event: tool_result\ndata: {"tool":"Bash","output":"file.ts"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('tool_result');
    if (e.type === 'tool_result') expect(e.tool).toBe('Bash');
  });

  it('parses a usage event', async () => {
    const raw = 'event: usage\ndata: {"model":"claude-sonnet-4-6","inputTokens":100,"outputTokens":200}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('usage');
    if (e.type === 'usage') {
      expect(e.model).toBe('claude-sonnet-4-6');
      expect(e.inputTokens).toBe(100);
      expect(e.outputTokens).toBe(200);
    }
  });

  it('silently ignores keepalive comments', async () => {
    const raw = ': keepalive\n\nevent: status\ndata: {"status":"running"}\n\n';
    const events = await collect(raw);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('status');
  });

  it('surfaces unknown event names as type unknown', async () => {
    const raw = 'event: custom_event\ndata: {"foo":"bar"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('unknown');
    if (e.type === 'unknown') {
      expect(e.name).toBe('custom_event');
      expect(e.data).toBe('{"foo":"bar"}');
    }
  });

  it('parses multiple events in sequence', async () => {
    const raw = [
      'event: status\ndata: {"status":"running"}\n\n',
      'event: output\ndata: {"content":"line 1"}\n\n',
      'event: output\ndata: {"content":"line 2"}\n\n',
      'event: done\ndata: {"status":"completed"}\n\n',
    ].join('');
    const events = await collect(raw);
    expect(events).toHaveLength(4);
    expect(events.map(e => e.type)).toEqual(['status', 'text', 'text', 'done']);
  });

  it('handles an event with no event: line (defaults to output→text)', async () => {
    const raw = 'data: {"content":"bare data"}\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('text');
    if (e.type === 'text') expect(e.content).toBe('bare data');
  });

  it('handles non-JSON data gracefully', async () => {
    const raw = 'event: error\ndata: plain error text\n\n';
    const [e] = await collect(raw);
    expect(e.type).toBe('error');
    if (e.type === 'error') expect(e.message).toBe('plain error text');
  });

  it('attaches a timestamp to every event', async () => {
    const raw = 'event: status\ndata: {"status":"queued"}\n\n';
    const [e] = await collect(raw);
    expect(e.timestamp).toBeDefined();
    expect(() => new Date(e.timestamp!)).not.toThrow();
  });

  it('truncates output field on done event to 2000 chars', async () => {
    const longOutput = 'x'.repeat(3000);
    const raw = `event: done\ndata: ${JSON.stringify({ status: 'completed', output: longOutput })}\n\n`;
    const [e] = await collect(raw);
    expect(e.type).toBe('done');
    if (e.type === 'done') {
      expect(e.summary!.length).toBe(2000);
    }
  });

  it('handles a typical factory run sequence', async () => {
    const raw = [
      'event: status\ndata: {"status":"running","id":"t123"}\n\n',
      ': keepalive\n\n',
      'event: output\ndata: {"content":"Claude is analyzing..."}\n\n',
      'event: output\ndata: {"content":"Writing fix..."}\n\n',
      'event: done\ndata: {"status":"completed","exitCode":0}\n\n',
    ].join('');
    const events = await collect(raw);
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('status');
    expect(events[1].type).toBe('text');
    expect(events[2].type).toBe('text');
    expect(events[3].type).toBe('done');
  });
});


describe('renderStream', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function* makeStream(events: CloudEvent[]): AsyncIterable<CloudEvent> {
    for (const e of events) yield e;
  }

  it('returns completed status from a done event', async () => {
    const result = await renderStream(makeStream([
      { type: 'done', status: 'completed', summary: 'all good' },
    ]));
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('all good');
  });

  it('returns failed status from an error event', async () => {
    const result = await renderStream(makeStream([
      { type: 'error', message: 'something broke' },
    ]));
    expect(result.status).toBe('failed');
  });

  it('returns prUrl from a done event', async () => {
    const result = await renderStream(makeStream([
      { type: 'done', status: 'completed', prUrl: 'https://github.com/org/repo/pull/42' },
    ]));
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/42');
  });

  it('tracks last status through status events', async () => {
    const result = await renderStream(makeStream([
      { type: 'status', status: 'queued' },
      { type: 'status', status: 'running' },
      { type: 'done', status: 'completed' },
    ]));
    expect(result.status).toBe('completed');
  });

  it('renders idle status and returns it as the last status', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderr.push(String(s));
      return true;
    });

    const result = await renderStream(makeStream([
      { type: 'status', status: 'idle' },
    ]));

    expect(result.status).toBe('idle');
    expect(stderr.join('')).toContain('[idle]');
  });

  it('emits JSON lines when json option is set', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      lines.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await renderStream(makeStream([
      { type: 'status', status: 'running' },
      { type: 'text', content: 'hello' },
    ]), { json: true });

    expect(lines).toHaveLength(2);
    const parsed = lines.map(l => JSON.parse(l));
    expect(parsed[0].type).toBe('status');
    expect(parsed[1].type).toBe('text');
  });

  it('writes text content to stdout', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      chunks.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await renderStream(makeStream([{ type: 'text', content: 'agent output' }]));
    expect(chunks).toContain('agent output');
  });

  it('handles an empty stream (default running status)', async () => {
    const result = await renderStream(makeStream([]));
    expect(result.status).toBe('running');
    expect(result.summary).toBeUndefined();
  });
});
