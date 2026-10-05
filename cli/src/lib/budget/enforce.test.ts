import { describe, it, expect } from 'vitest';
import { makeLiveSpendWatcher, capsFromConfig, extractUsageEvents } from './enforce.js';
import type { BreachInfo, UsageEvent } from './enforce.js';

function claudeFiveDollars(): UsageEvent {
  return { agent: 'claude', model: 'claude-opus-4', inputTokens: 1_000_000 };
}
function codexOneTwentyFive(): UsageEvent {
  return { agent: 'codex', model: 'gpt-5', inputTokens: 1_000_000 };
}

describe('makeLiveSpendWatcher', () => {
  it('trips per_run exactly when accumulated cost crosses the cap', () => {
    let breach: BreachInfo | null = null;
    const w = makeLiveSpendWatcher({ caps: { perRun: 7 }, onBreach: (b) => { breach = b; } });
    w.feedUsage(claudeFiveDollars());
    expect(w.breached()).toBe(false);
    w.feedUsage(claudeFiveDollars());
    expect(w.breached()).toBe(true);
    expect(breach!.cap).toBe('per_run');
    expect(breach!.spend).toBeCloseTo(10, 6);
  });

  it('fires onBreach at most once even as spend keeps accumulating', () => {
    let count = 0;
    const w = makeLiveSpendWatcher({ caps: { perRun: 3 }, onBreach: () => { count++; } });
    w.feedUsage(claudeFiveDollars());
    w.feedUsage(claudeFiveDollars());
    w.feedUsage(claudeFiveDollars());
    expect(count).toBe(1);
    expect(w.runSpend()).toBeCloseTo(15, 6);
  });

  it('aggregates spend ACROSS vendors under one per_project cap (the cross-vendor property)', () => {
    let breach: BreachInfo | null = null;
    const w = makeLiveSpendWatcher({ caps: { perProject: 5 }, onBreach: (b) => { breach = b; } });
    w.feedUsage(claudeFiveDollars());
    expect(w.breached()).toBe(false);
    w.feedUsage(codexOneTwentyFive());
    expect(w.breached()).toBe(true);
    expect(breach!.cap).toBe('per_project');
    expect(breach!.spend).toBeCloseTo(6.25, 6);
  });

  it('seeds accumulators with prior ledger spend (per_day counts earlier runs)', () => {
    let breach: BreachInfo | null = null;
    const w = makeLiveSpendWatcher({
      caps: { perDay: 50, priorDaySpend: 48 },
      onBreach: (b) => { breach = b; },
    });
    w.feedUsage(claudeFiveDollars());
    expect(w.breached()).toBe(true);
    expect(breach!.cap).toBe('per_day');
    expect(breach!.spend).toBeCloseTo(53, 6);
  });

  it('enforces a per_agent cap against that agent only', () => {
    let breach: BreachInfo | null = null;
    const w = makeLiveSpendWatcher({
      caps: { perAgent: { codex: 1 } },
      onBreach: (b) => { breach = b; },
    });
    w.feedUsage(claudeFiveDollars());
    expect(w.breached()).toBe(false);
    w.feedUsage(codexOneTwentyFive());
    expect(w.breached()).toBe(true);
    expect(breach!.cap).toBe('per_agent');
    expect(breach!.agent).toBe('codex');
  });

  it('ignores unpriced usage (no cost, no breach)', () => {
    const w = makeLiveSpendWatcher({ caps: { perRun: 0.0001 }, onBreach: () => {} });
    w.feedUsage({ agent: 'claude', model: 'nope-9000', inputTokens: 10_000_000 });
    expect(w.breached()).toBe(false);
    expect(w.runSpend()).toBe(0);
  });
});

describe('capsFromConfig', () => {
  it('maps a BudgetConfig + prior spend into LiveCaps', () => {
    const caps = capsFromConfig(
      { per_run: 5, per_day: 50, per_project: 100, per_agent: { claude: 30 } },
      { daySpend: 10, projectSpend: 20, agentDaySpend: { claude: 5 } },
    );
    expect(caps.perRun).toBe(5);
    expect(caps.perDay).toBe(50);
    expect(caps.perProject).toBe(100);
    expect(caps.perAgent).toEqual({ claude: 30 });
    expect(caps.priorDaySpend).toBe(10);
    expect(caps.priorProjectSpend).toBe(20);
    expect(caps.priorAgentDaySpend).toEqual({ claude: 5 });
  });
});

describe('extractUsageEvents', () => {
  it('parses Claude stream-json assistant turns and buffers a partial trailing line', () => {
    const line1 = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 } } });
    const chunk = line1 + '\n' + '{"type":"assistant","mess';
    const { events, rest } = extractUsageEvents(chunk, '');
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(100);
    expect(events[0].outputTokens).toBe(50);
    expect(events[0].cacheReadTokens).toBe(10);
    expect(events[0].model).toBe('claude-opus-4');
    expect(rest).toBe('{"type":"assistant","mess');
  });

  it('reassembles a usage line split across two chunks', () => {
    const full = JSON.stringify({ message: { model: 'claude-opus-4', usage: { input_tokens: 7 } } });
    const half = full.slice(0, 20);
    const r1 = extractUsageEvents(half, '');
    expect(r1.events).toHaveLength(0);
    const r2 = extractUsageEvents(full.slice(20) + '\n', r1.rest);
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].inputTokens).toBe(7);
  });

  it('parses the flatter usage.record shape', () => {
    const line = JSON.stringify({ type: 'usage.record', model: 'gpt-5', usage: { input_tokens: 200, output: 80 } });
    const { events } = extractUsageEvents(line + '\n', '');
    expect(events).toHaveLength(1);
    expect(events[0].inputTokens).toBe(200);
    expect(events[0].outputTokens).toBe(80);
    expect(events[0].model).toBe('gpt-5');
  });

  it('skips non-JSON and usage-free lines without throwing', () => {
    const chunk = 'plain log line\n' + JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';
    const { events } = extractUsageEvents(chunk, '');
    expect(events).toHaveLength(0);
  });

  it('ignores the Claude type:"result" line so its cumulative usage is not double-counted (#346)', () => {
    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 999_999, output_tokens: 555_555, cache_read_input_tokens: 1234 },
    });
    const { events } = extractUsageEvents(resultLine + '\n', '');
    expect(events).toHaveLength(0);
  });

  it('a result line adds ZERO spend on top of the per-turn usage it summarizes (#346)', () => {
    const turn = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4', usage: { input_tokens: 1_000_000 } } });
    const result = JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 2_000_000 } });
    const stream = turn + '\n' + turn + '\n' + result + '\n';
    const { events } = extractUsageEvents(stream, '');
    const w = makeLiveSpendWatcher({ caps: {}, onBreach: () => {} });
    for (const ev of events) w.feedUsage(ev);
    expect(w.runSpend()).toBeCloseTo(10, 6);
  });
});
