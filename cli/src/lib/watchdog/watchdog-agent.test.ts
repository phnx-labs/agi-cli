import { describe, it, expect } from 'vitest';
import { makeWatchdogAgentDecider } from './watchdog-agent.js';
import type { WatchdogCandidate } from './watchdog.js';

const cand = (id: string): WatchdogCandidate => ({
  terminalId: id,
  agentType: 'claude',
  tailLines: ['{}'],
  stalledForMs: 60_000,
});

describe('makeWatchdogAgentDecider', () => {
  it('sends ALL candidates to the agent in ONE call and maps decisions by terminalId', async () => {
    const calls: { runTarget: string; prompt: string }[] = [];
    const run = async (runTarget: string, prompt: string) => {
      calls.push({ runTarget, prompt });
      return (
        '[{"terminalId":"A","action":"nudge","text":"go","reason":"unfinished"},' +
        '{"terminalId":"B","action":"skip","text":"","reason":"done","needsHuman":false}]'
      );
    };
    const out = await makeWatchdogAgentDecider('claude', { run })([cand('A'), cand('B')]);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('terminal A');
    expect(calls[0].prompt).toContain('terminal B');
    expect(out.get('A')?.action).toBe('nudge');
    expect(out.get('B')?.action).toBe('skip');
    expect(out.get('B')?.needsHuman).toBe(false);
  });

  it('returns an empty map (every session safe-skips) when the agent throws', async () => {
    const run = async () => { throw new Error('agent unavailable'); };
    const out = await makeWatchdogAgentDecider('claude', { run })([cand('A')]);
    expect(out.size).toBe(0);
  });

  it('never runs the agent when nothing is idle', async () => {
    let called = false;
    const run = async () => { called = true; return '[]'; };
    const out = await makeWatchdogAgentDecider('claude', { run })([]);
    expect(called).toBe(false);
    expect(out.size).toBe(0);
  });
});
