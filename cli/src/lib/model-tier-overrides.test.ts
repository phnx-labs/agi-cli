import { describe, it, expect } from 'vitest';
import { resolveTierOverrideFrom, parseTier } from './model-tier-overrides.js';

describe('resolveTierOverrideFrom — layered precedence', () => {
  const store = {
    'kimi:*': { best: 'kimi-code/k3', default: 'kimi-code/kimi-for-coding' },
    'kimi:0.19.2': { best: 'kimi-code/k3-256k' },
    'claude:*': { cheap: 'claude-haiku-4-5' },
  };

  it('applies the <agent>:* wildcard for any version', () => {
    const r = resolveTierOverrideFrom(store, 'kimi', '9.9.9');
    expect(r.best).toBe('kimi-code/k3');
    expect(r.default).toBe('kimi-code/kimi-for-coding');
  });

  it('lets an exact <agent>:<version> selector win per tier, keeping wildcard for the rest', () => {
    const r = resolveTierOverrideFrom(store, 'kimi', '0.19.2');
    expect(r.best).toBe('kimi-code/k3-256k');
    expect(r.default).toBe('kimi-code/kimi-for-coding');
  });

  it('returns empty when nothing matches the agent', () => {
    expect(resolveTierOverrideFrom(store, 'grok', '0.2.117')).toEqual({});
  });

  it('drops unknown tiers / non-string values (normalization)', () => {
    const dirty = { 'kimi:*': { best: 'kimi-code/k3', bogus: 'x', cheap: 42 } };
    const r = resolveTierOverrideFrom(dirty as any, 'kimi', null);
    expect(r).toEqual({ best: 'kimi-code/k3' });
  });
});

describe('parseTier', () => {
  it('accepts the four tiers case-insensitively, rejects others', () => {
    expect(parseTier('BEST')).toBe('best');
    expect(() => parseTier('sonnet')).toThrow(/Invalid tier/);
  });
});
