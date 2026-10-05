import { describe, expect, it } from 'vitest';
import {
  buildSummarizeUserMessage,
  extractJsonObject,
  summarize,
  validateSummarizeResult,
} from './summarize.js';

function stubEndpoint(text: string, ok = true): { fetch: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return {
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'err',
      json: async () => ({ content: [{ type: 'text', text }] }),
      text: async () => text,
    } as any;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const OPTS = { baseUrl: 'http://localhost:11434', model: 'qwen2.5:3b' };

describe('validateSummarizeResult', () => {
  it('accepts a well-formed object and trims/filters', () => {
    const r = validateSummarizeResult({
      goal: '  Ship the summarizer  ',
      checkpoints: ['wrote the cache', '   ', 42, 'wired the service'],
      checklist: [{ text: 'add table', done: true }, { text: '', done: false }, { done: true }],
    });
    expect(r).toEqual({
      goal: 'Ship the summarizer',
      checkpoints: ['wrote the cache', 'wired the service'],
      checklist: [{ text: 'add table', done: true }],
    });
  });

  it('rejects a missing/empty goal', () => {
    expect(validateSummarizeResult({ checkpoints: [], checklist: [] })).toBeUndefined();
    expect(validateSummarizeResult({ goal: '   ' })).toBeUndefined();
    expect(validateSummarizeResult('nope')).toBeUndefined();
    expect(validateSummarizeResult(null)).toBeUndefined();
  });

  it('degrades missing arrays to []', () => {
    expect(validateSummarizeResult({ goal: 'g' })).toEqual({ goal: 'g', checkpoints: [], checklist: [] });
  });
});

describe('extractJsonObject', () => {
  it('strips code fences and pulls the object', () => {
    expect(extractJsonObject('```json\n{"goal":"x"}\n```')).toBe('{"goal":"x"}');
  });
  it('pulls the object out of surrounding chatter', () => {
    expect(extractJsonObject('Sure! {"goal":"x","checkpoints":[]} hope that helps')).toBe('{"goal":"x","checkpoints":[]}');
  });
  it('returns undefined when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
  });
});

describe('buildSummarizeUserMessage', () => {
  it('includes the prompt, phase, checklist and plan but never a tool firehose', () => {
    const msg = buildSummarizeUserMessage('Do the thing', {
      phase: 'running',
      todos: { items: [{ content: 'step one', status: 'completed' }, { content: 'step two', status: 'pending' }], done: 1, total: 2 },
      plan: 'the plan body',
    });
    expect(msg).toContain('USER REQUEST:\nDo the thing');
    expect(msg).toContain('PHASE: running');
    expect(msg).toContain('(1/2 done)');
    expect(msg).toContain('[x] step one');
    expect(msg).toContain('PLAN:\nthe plan body');
  });

  it('adds the agent\'s own narration headlines when the timeline fold produced any (PHNX-3939)', () => {
    const msg = buildSummarizeUserMessage('Do the thing', {
      steps: ['Reading the CI manifest.', 'Static musl builds work here.'],
    });
    expect(msg).toContain('WHAT THE AGENT SAID IT WAS DOING (oldest first):');
    expect(msg).toContain('- Reading the CI manifest.');
    expect(msg).toContain('- Static musl builds work here.');
  });

  it('adds nothing for a session with no folded timeline — the input stays optional', () => {
    expect(buildSummarizeUserMessage('Do the thing', {})).toBe('USER REQUEST:\nDo the thing');
    expect(buildSummarizeUserMessage('Do the thing', { steps: [] })).toBe('USER REQUEST:\nDo the thing');
  });
});

describe('summarize (stubbed model endpoint)', () => {
  it('parses a strict-JSON reply into a validated result', async () => {
    const stub = stubEndpoint('{"goal":"Ship it","checkpoints":["did A"],"checklist":[{"text":"B","done":false}]}');
    const r = await summarize('Ship it end to end', { phase: 'running' }, { ...OPTS, fetchImpl: stub.fetch });
    expect(r).toEqual({ goal: 'Ship it', checkpoints: ['did A'], checklist: [{ text: 'B', done: false }] });
    expect(stub.calls[0].url).toBe('http://localhost:11434/v1/messages');
    expect(stub.calls[0].body.model).toBe('qwen2.5:3b');
    expect(stub.calls[0].body.tools).toBeUndefined();
  });

  it('returns undefined on a non-2xx response', async () => {
    const stub = stubEndpoint('{"goal":"x"}', false);
    expect(await summarize('p', {}, { ...OPTS, fetchImpl: stub.fetch })).toBeUndefined();
  });

  it('returns undefined on non-JSON output', async () => {
    const stub = stubEndpoint('the model refused to produce json');
    expect(await summarize('p', {}, { ...OPTS, fetchImpl: stub.fetch })).toBeUndefined();
  });

  it('returns undefined on a thrown fetch (network error)', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await summarize('p', {}, { ...OPTS, fetchImpl })).toBeUndefined();
  });

  it('returns undefined for an empty prompt without calling the model', async () => {
    const stub = stubEndpoint('{"goal":"x"}');
    expect(await summarize('   ', {}, { ...OPTS, fetchImpl: stub.fetch })).toBeUndefined();
    expect(stub.calls.length).toBe(0);
  });

  it('never forwards the ambient ANTHROPIC_API_KEY to the endpoint', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    const prevSumm = process.env.AGENTS_SUMMARIZER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-leak';
    delete process.env.AGENTS_SUMMARIZER_API_KEY;
    const calls: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      calls.push({ apiKey: (init?.headers ?? {})['x-api-key'] });
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ content: [{ type: 'text', text: '{"goal":"g"}' }] }), text: async () => '' } as any;
    }) as unknown as typeof fetch;
    try {
      await summarize('do it', {}, { ...OPTS, fetchImpl });
      expect(calls[0].apiKey).toBe('');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
      if (prevSumm !== undefined) process.env.AGENTS_SUMMARIZER_API_KEY = prevSumm;
    }
  });
});
