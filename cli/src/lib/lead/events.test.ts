import { describe, expect, it } from 'vitest';
import { LeadTurnParser, contextUsageFromResult, shouldRotate, stopTarget, summarize, toolLabel, type ParsedItem } from './events.js';

const events = (items: ParsedItem[]) => items.filter((i) => i.kind === 'event').map((i) => (i as { event: unknown }).event);

describe('LeadTurnParser', () => {
  it('turns a real stream-json tool turn into status, tool and text events', () => {
    const p = new LeadTurnParser();
    const out: ParsedItem[] = [];
    out.push(...p.feed({ type: 'system', subtype: 'init', session_id: 's1' }, 0));
    out.push(...p.feed({ type: 'stream_event', event: { type: 'message_start' } }, 10));
    out.push(...p.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'agents ps --json | head -c 300', description: 'x' } }] } }, 100));
    out.push(...p.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }] } }, 1340));
    out.push(...p.feed({ type: 'stream_event', event: { type: 'message_start' } }, 1400));
    out.push(...p.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Two ' } } }, 1500));
    out.push(...p.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }, 1510));
    out.push(...p.feed({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'agents.' } } }, 1520));
    out.push(...p.feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Two agents.' }] } }, 1600));
    expect(out[0]).toEqual({ kind: 'init', sessionId: 's1' });
    expect(events(out)).toEqual([
      { type: 'status', state: 'thinking' },
      { type: 'status', state: 'tool' },
      { type: 'tool', id: 'toolu_1', label: 'agents ps', cmd: 'agents ps --json | head -c 300', state: 'run' },
      { type: 'tool', id: 'toolu_1', label: 'agents ps', state: 'ok', secs: 1.24 },
      { type: 'status', state: 'thinking' },
      { type: 'status', state: 'answering' },
      { type: 'text', delta: 'Two ' },
      { type: 'text', delta: 'agents.' },
    ]);
    expect(p.toolSeconds()).toBe(1.24);
  });

  it('emits assistant text once when the harness streams no partial deltas', () => {
    const p = new LeadTurnParser();
    const out = p.feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }] } }, 0);
    expect(events(out)).toEqual([{ type: 'status', state: 'answering' }, { type: 'text', delta: 'Hi.' }]);
  });

  it('holds an agents ps stop call as a stop intent and drops its denied result', () => {
    const p = new LeadTurnParser();
    const a = p.feed({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'agents ps stop 698dab45' } }] } }, 0);
    expect(a).toEqual([{ kind: 'stop', intent: { toolId: 't9', sessionRef: '698dab45' } }]);
    const u = p.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error: true, content: 'Permission to use Bash with command agents ps stop 698dab45 has been denied.' }] } }, 5);
    expect(u).toEqual([]);
  });

  it('marks a failed tool and merges overlapping parallel tool time', () => {
    const p = new LeadTurnParser();
    p.feed({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'linear tasks --json' } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'sessions --json' } },
    ] } }, 0);
    const r = p.feed({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'a', is_error: true },
      { type: 'tool_result', tool_use_id: 'b', is_error: false },
    ] } }, 2000);
    expect(events(r)).toEqual([
      { type: 'tool', id: 'a', label: 'linear tasks', state: 'fail', secs: 2 },
      { type: 'tool', id: 'b', label: 'sessions', state: 'ok', secs: 2 },
    ]);
    expect(p.toolSeconds()).toBe(2);
  });

  it('reads the result text, error flag and context usage', () => {
    const p = new LeadTurnParser();
    const [item] = p.feed({
      type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1',
      usage: { input_tokens: 4, cache_read_input_tokens: 55159, cache_creation_input_tokens: 34931, output_tokens: 176,
        iterations: [{ input_tokens: 2, output_tokens: 83, cache_read_input_tokens: 44764, cache_creation_input_tokens: 562 }] },
      modelUsage: { 'claude-sonnet-5-5': { contextWindow: 1000000 } },
    }, 0);
    expect(item).toEqual({ kind: 'result', result: { text: 'Done.', isError: false, usage: { tokens: 45411, window: 1000000 }, sessionId: 's1' } });
  });
});

describe('rotation threshold', () => {
  it('rotates at 60% of the window and never without usage', () => {
    expect(shouldRotate({ tokens: 599_999, window: 1_000_000 })).toBe(false);
    expect(shouldRotate({ tokens: 600_000, window: 1_000_000 })).toBe(true);
    expect(shouldRotate(null)).toBe(false);
    expect(contextUsageFromResult({ usage: { input_tokens: 5 } })).toBeNull();
  });
});

describe('labels and summaries', () => {
  it('labels commands by their verb and finds stop targets', () => {
    expect(toolLabel('AGENTS_X=1 agents run claude "x"')).toBe('agents run');
    expect(toolLabel('linear update PHNX-1 --state Doing')).toBe('linear update');
    expect(toolLabel('sessions --json')).toBe('sessions');
    expect(stopTarget('agents ps stop 4b2f1a9c && echo done')).toBe('4b2f1a9c');
    expect(stopTarget('agents ps --json')).toBeUndefined();
  });

  it('keeps the first sentence within 80 characters, without markdown', () => {
    expect(summarize('**Two agents** are running. More detail follows.')).toBe('Two agents are running.');
    expect(summarize('- `agents ps`: three rows\n- more')).toBe('agents ps: three rows more');
    const long = summarize('Claude is working on PHNX-4365 in the rush repo and Codex is reviewing the follow-up PR for the MCP server today.');
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('…')).toBe(true);
    expect(summarize('Version 1.2 shipped.')).toBe('Version 1.2 shipped.');
  });
});
