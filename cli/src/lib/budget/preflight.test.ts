import { describe, it, expect } from 'vitest';
import {
  estimateRunCost,
  ledgerAverageTokens,
  enforcePreflight,
  ledgerStateFor,
  type LedgerState,
} from './preflight.js';
import type { SpendEntry } from './ledger.js';
import { localDay } from './ledger.js';

function entry(over: Partial<SpendEntry>): SpendEntry {
  return {
    runId: 'r', agent: 'claude', project: '/p', day: localDay(),
    model: 'claude-opus-4', inputTok: 0, outputTok: 0, cacheTok: 0,
    costUsd: 0, source: 'run', ts: new Date().toISOString(),
    ...over,
  };
}

describe('estimateRunCost', () => {
  it('uses ledger average tokens when history exists (claude-opus-4)', () => {
    const ledger = [
      entry({ runId: 'a', inputTok: 1_000_000, outputTok: 1_000_000 }),
      entry({ runId: 'b', inputTok: 1_000_000, outputTok: 1_000_000 }),
    ];
    const est = estimateRunCost({ agent: 'claude', model: 'claude-opus-4', ledger });
    expect(est.basis).toBe('ledger-average');
    expect(est.estUsd).toBeCloseTo(30, 6);
    expect(est.priced).toBe(true);
  });

  it('falls back to the prompt-char heuristic with no history', () => {
    const est = estimateRunCost({ agent: 'claude', model: 'claude-opus-4', promptChars: 4000, ledger: [] });
    expect(est.basis).toBe('prompt-heuristic');
    expect(est.estInputTokens).toBe(1000);
    expect(est.estOutputTokens).toBe(6000);
    expect(est.estUsd).toBeGreaterThan(0);
  });

  it('marks unpriced models priced:false with $0', () => {
    const est = estimateRunCost({ agent: 'x', model: 'nope-9000', promptChars: 4000, ledger: [] });
    expect(est.priced).toBe(false);
    expect(est.estUsd).toBe(0);
  });
});

describe('ledgerAverageTokens', () => {
  it('averages per-RUN, not per-entry (multi-entry run counts once)', () => {
    const ledger = [
      entry({ runId: 'a', inputTok: 100 }),
      entry({ runId: 'a', inputTok: 100 }),
      entry({ runId: 'b', inputTok: 400 }),
    ];
    expect(ledgerAverageTokens('claude', ledger)).toEqual({ input: 300, output: 0 });
  });

  it('returns null with no matching agent', () => {
    expect(ledgerAverageTokens('codex', [entry({ agent: 'claude' })])).toBeNull();
  });
});

describe('enforcePreflight', () => {
  const state: LedgerState = { agent: 'claude', daySpend: 0, projectSpend: 0, agentDaySpend: 0 };
  const est = (usd: number) => ({ estUsd: usd, basis: 'ledger-average' as const, priced: true, estInputTokens: 0, estOutputTokens: 0 });

  it('blocks when estimate exceeds per_run under on_exceed:block', () => {
    const d = enforcePreflight({ per_run: 5, on_exceed: 'block' }, state, est(6));
    expect(d.allow).toBe(false);
    expect(d.blockedCap).toBe('per_run');
  });

  it('WARNS (allows) the same overrun under on_exceed:warn', () => {
    const d = enforcePreflight({ per_run: 5, on_exceed: 'warn' }, state, est(6));
    expect(d.allow).toBe(true);
    expect(d.blockedCap).toBe('per_run');
  });

  it('blocks on projected per_day even when this run alone is small', () => {
    const s: LedgerState = { agent: 'claude', daySpend: 49, projectSpend: 0, agentDaySpend: 0 };
    const d = enforcePreflight({ per_day: 50, on_exceed: 'block' }, s, est(2));
    expect(d.allow).toBe(false);
    expect(d.blockedCap).toBe('per_day');
    expect(d.projectedDaySpend).toBeCloseTo(51, 6);
  });

  it('blocks on per_agent projection for the matching agent', () => {
    const s: LedgerState = { agent: 'codex', daySpend: 0, projectSpend: 0, agentDaySpend: 19 };
    const d = enforcePreflight({ per_agent: { codex: 20 }, on_exceed: 'block' }, s, est(2));
    expect(d.allow).toBe(false);
    expect(d.blockedCap).toBe('per_agent');
  });

  it('does NOT apply a per_agent cap meant for a different agent', () => {
    const s: LedgerState = { agent: 'claude', daySpend: 0, projectSpend: 0, agentDaySpend: 19 };
    const d = enforcePreflight({ per_agent: { codex: 20 }, on_exceed: 'block' }, s, est(2));
    expect(d.allow).toBe(true);
  });

  it('sets needsConfirm when estimate >= require_confirm_over (no hard block)', () => {
    const d = enforcePreflight({ require_confirm_over: 1, on_exceed: 'block' }, state, est(2));
    expect(d.allow).toBe(true);
    expect(d.needsConfirm).toBe(true);
  });

  it('a hard block stays a block regardless of require_confirm_over (--yes cannot save it)', () => {
    const d = enforcePreflight({ per_run: 1, require_confirm_over: 100, on_exceed: 'block' }, state, est(5));
    expect(d.allow).toBe(false);
    expect(d.needsConfirm).toBe(false);
    expect(d.blockedCap).toBe('per_run');
  });

  it('does NOT silently allow an UNPRICED model when caps are set — requires confirm (#346)', () => {
    const unpricedEst = { estUsd: 0, basis: 'none' as const, priced: false, estInputTokens: 0, estOutputTokens: 0 };
    const d = enforcePreflight({ per_run: 0.01, on_exceed: 'block' }, state, unpricedEst);
    expect(d.needsConfirm).toBe(true);
    expect(d.reason).toMatch(/unpriced/);
  });

  it('a PRICED $0-ish estimate under caps is allowed without forced confirm', () => {
    const d = enforcePreflight({ per_run: 5, on_exceed: 'block' }, state, est(0.001));
    expect(d.allow).toBe(true);
    expect(d.needsConfirm).toBe(false);
  });
});

describe('ledgerStateFor', () => {
  it('snapshots day/project/agent-day spend for the gate', () => {
    const ledger = [
      entry({ agent: 'claude', project: '/p', costUsd: 3 }),
      entry({ agent: 'codex', project: '/p', costUsd: 2 }),
    ];
    const s = ledgerStateFor('claude', '/p', ledger);
    expect(s.agent).toBe('claude');
    expect(s.daySpend).toBeCloseTo(5, 6);
    expect(s.projectSpend).toBeCloseTo(5, 6);
    expect(s.agentDaySpend).toBeCloseTo(3, 6);
  });
});
