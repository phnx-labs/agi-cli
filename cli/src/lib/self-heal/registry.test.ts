import { describe, expect, it } from 'vitest';
import {
  selfHealChangedAnything,
  selfHealNeedsAttention,
  summarizeSelfHeal,
} from './registry.js';
import type { SelfHealReport } from './types.js';


function report(checks: SelfHealReport['checks']): SelfHealReport {
  return { checks };
}

describe('self-heal report aggregation', () => {
  it('changedAnything is true only when a check fixed something', () => {
    expect(selfHealChangedAnything(report([
      { id: 'shims', title: 't', result: { fixed: ['claude shim'], needsAttention: [], ok: false } },
    ]))).toBe(true);
    expect(selfHealChangedAnything(report([
      { id: 'shims', title: 't', result: { fixed: [], needsAttention: ['x'], ok: false } },
    ]))).toBe(false);
    expect(selfHealChangedAnything(report([
      { id: 'shims', title: 't', result: { fixed: [], needsAttention: [], ok: true } },
    ]))).toBe(false);
  });

  it('needsAttention is true for review items OR a check error', () => {
    expect(selfHealNeedsAttention(report([
      { id: 'shadowing', title: 't', result: { fixed: [], needsAttention: ['real binary'], ok: false } },
    ]))).toBe(true);
    expect(selfHealNeedsAttention(report([
      { id: 'resources', title: 't', result: null, error: 'boom' },
    ]))).toBe(true);
    expect(selfHealNeedsAttention(report([
      { id: 'shims', title: 't', result: { fixed: ['a'], needsAttention: [], ok: false } },
    ]))).toBe(false);
  });

  it('summarizes fixed + attention counts, and reports errors', () => {
    const s = summarizeSelfHeal(report([
      { id: 'shims', title: 't', result: { fixed: ['a', 'b'], needsAttention: [], ok: false } },
      { id: 'shadowing', title: 't', result: { fixed: [], needsAttention: ['real'], ok: false } },
      { id: 'path', title: 't', result: { fixed: [], needsAttention: [], ok: true } },
      { id: 'resources', title: 't', result: null, error: 'boom' },
    ]));
    expect(s).toContain('shims: 2 fixed');
    expect(s).toContain('shadowing: 0 fixed, 1 to review');
    expect(s).toContain('resources: error (boom)');
    expect(s).not.toContain('path:');
  });

  it('empty / all-ok report summarizes as nothing to heal', () => {
    expect(summarizeSelfHeal(report([]))).toBe('nothing to heal');
  });
});
