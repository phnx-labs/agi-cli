import { describe, it, expect } from 'vitest';
import {
  costOfUsage,
  costOfUsageNoCache,
  costOfSession,
  formatUsd,
  estimateCost,
  actualCost,
  isModelPriced,
} from './cost.js';

describe('costOfUsage', () => {
  it('computes a known token->cost fixture (claude-opus-4)', () => {
    const usd = costOfUsage({ model: 'claude-opus-4', inputTokens: 1000, outputTokens: 2000 });
    expect(usd).toBeCloseTo(0.055, 10);
  });

  it('prices cache read and cache write at their dedicated rates', () => {
    const usd = costOfUsage({
      model: 'claude-opus-4',
      cacheReadTokens: 10_000,
      cacheCreationTokens: 1_000,
    });
    expect(usd).toBeCloseTo(0.005 + 0.00625, 10);
  });

  it('falls back to input rate for cache tokens when no cache price (gpt-4o-mini cacheWrite)', () => {
    const usd = costOfUsage({ model: 'gpt-4o-mini', cacheCreationTokens: 1_000_000 });
    expect(usd).toBeCloseTo(0.00000015 * 1_000_000, 10);
  });

  it('returns 0 for unknown model', () => {
    expect(costOfUsage({ model: 'nope-9000', inputTokens: 1_000_000 })).toBe(0);
  });

  it('returns 0 when model is missing', () => {
    expect(costOfUsage({ inputTokens: 1_000_000 })).toBe(0);
  });
});

describe('costOfUsageNoCache', () => {
  it('bills cache read and cache write at the full input rate', () => {
    const usd = costOfUsageNoCache({
      model: 'claude-opus-4',
      cacheReadTokens: 10_000,
      cacheCreationTokens: 1_000,
    });
    expect(usd).toBeCloseTo(0.05 + 0.005, 10);
  });

  it('leaves uncached input and output untouched', () => {
    const args = { model: 'claude-opus-4', inputTokens: 1000, outputTokens: 2000 } as const;
    expect(costOfUsageNoCache(args)).toBeCloseTo(costOfUsage(args), 10);
    expect(costOfUsageNoCache(args)).toBeCloseTo(0.055, 10);
  });

  it('exceeds the cache-aware cost when cache reads dominate (the common case)', () => {
    const args = {
      model: 'claude-opus-4',
      inputTokens: 5_000,
      outputTokens: 5_000,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 10_000,
    } as const;
    expect(costOfUsageNoCache(args)).toBeGreaterThan(costOfUsage(args));
  });

  it('can fall BELOW the cache-aware cost in a cache-write-heavy session', () => {
    const args = {
      model: 'claude-opus-4',
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 2_000_000,
    } as const;
    expect(costOfUsageNoCache(args)).toBeLessThan(costOfUsage(args));
  });

  it('returns 0 for unknown/missing model', () => {
    expect(costOfUsageNoCache({ model: 'nope-9000', cacheReadTokens: 1_000_000 })).toBe(0);
    expect(costOfUsageNoCache({ cacheReadTokens: 1_000_000 })).toBe(0);
  });
});

describe('costOfSession', () => {
  it('sums a multi-model session', () => {
    const usd = costOfSession([
      { model: 'claude-opus-4', inputTokens: 1000, outputTokens: 1000 },
      { model: 'claude-haiku-4', inputTokens: 1000, outputTokens: 1000 },
      { model: 'unknown-model', inputTokens: 999999 },
    ]);
    expect(usd).toBeCloseTo(0.03 + 0.006, 10);
  });
});

describe('formatUsd', () => {
  it('formats cents-precise dollars', () => {
    expect(formatUsd(1.23)).toBe('$1.23');
    expect(formatUsd(1.236)).toBe('$1.24');
  });
  it('floors tiny nonzero costs to <$0.01', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
  });
  it('renders exact zero and negatives as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-5)).toBe('$0.00');
  });
});

describe('estimateCost', () => {
  it('returns usd + matched model for a priced model', () => {
    const r = estimateCost('claude-sonnet-4', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.usd).toBeCloseTo(3, 10);
    expect(r.modelMatched).toBe('claude-sonnet-4');
  });
  it('returns 0 usd + null match for an unpriced model', () => {
    const r = estimateCost('nope-9000', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.usd).toBe(0);
    expect(r.modelMatched).toBeNull();
  });
});

describe('actualCost', () => {
  it('matches costOfUsage for the same inputs', () => {
    const r = actualCost('gpt-4.1', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(r.usd).toBeCloseTo(
      costOfUsage({ model: 'gpt-4.1', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      10,
    );
  });
});

describe('isModelPriced', () => {
  it('true for known, false for unknown', () => {
    expect(isModelPriced('claude-opus-4-8')).toBe(true);
    expect(isModelPriced('nope-9000')).toBe(false);
  });
});
