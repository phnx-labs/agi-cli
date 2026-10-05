import { describe, it, expect } from 'vitest';
import { buildLoopConfig, loopExitCode } from './exec.js';

describe('buildLoopConfig — flag/frontmatter merge (issue #332)', () => {
  it('returns undefined for a plain run (no --loop, no workflow loop)', () => {
    expect(buildLoopConfig({})).toBeUndefined();
  });

  it('activates a bare loop on --loop alone (driver applies its own cap)', () => {
    expect(buildLoopConfig({ loop: true })).toEqual({});
  });

  it('activates from a workflow loop block even without --loop', () => {
    expect(buildLoopConfig({}, { max_iterations: 3 })).toEqual({ maxIterations: 3 });
  });

  it('translates snake_case workflow fields to the camelCase driver config', () => {
    expect(buildLoopConfig({}, { until: 'signal', max_iterations: 5, budget: 100, interval: '30m' }))
      .toEqual({ until: 'signal', maxIterations: 5, budget: 100, interval: '30m' });
  });

  it('CLI flags override workflow values field-by-field', () => {
    const cfg = buildLoopConfig(
      { loop: true, maxIterations: '7', budget: '999' },
      { max_iterations: 3, budget: 100, interval: '10m' },
    );
    expect(cfg).toEqual({ maxIterations: 7, budget: 999, interval: '10m' });
  });

  it('rejects an invalid --until', () => {
    expect(() => buildLoopConfig({ loop: true, until: 'forever' })).toThrow(/Only 'signal'/);
  });

  it('rejects a non-positive --max-iterations', () => {
    expect(() => buildLoopConfig({ loop: true, maxIterations: '0' })).toThrow(/positive integer/);
    expect(() => buildLoopConfig({ loop: true, maxIterations: 'abc' })).toThrow(/positive integer/);
  });

  it('rejects a non-positive --budget', () => {
    expect(() => buildLoopConfig({ loop: true, budget: '-5' })).toThrow(/positive token/);
  });

  it('accepts "0" and valid durations for --interval', () => {
    expect(buildLoopConfig({ loop: true, interval: '0' })).toEqual({ interval: '0' });
    expect(buildLoopConfig({ loop: true, interval: '30m' })).toEqual({ interval: '30m' });
    expect(buildLoopConfig({ loop: true, interval: '2h30m' })).toEqual({ interval: '2h30m' });
  });

  it('rejects an unparseable --interval instead of silently running back-to-back (FIX 3)', () => {
    expect(() => buildLoopConfig({ loop: true, interval: '30s' })).toThrow(/Invalid --interval/);
    expect(() => buildLoopConfig({ loop: true, interval: '5' })).toThrow(/Invalid --interval/);
    expect(() => buildLoopConfig({ loop: true, interval: 'abc' })).toThrow(/Invalid --interval/);
  });
});

describe('loopExitCode', () => {
  it('maps clean stops to 0', () => {
    expect(loopExitCode('condition-met')).toBe(0);
    expect(loopExitCode('max')).toBe(0);
  });

  it('maps budget to 7 (matches BUDGET_KILL_EXIT_CODE)', () => {
    expect(loopExitCode('budget')).toBe(7);
  });

  it('maps signal to 130 and error/stalled to 1', () => {
    expect(loopExitCode('signal')).toBe(130);
    expect(loopExitCode('error')).toBe(1);
    expect(loopExitCode('stalled')).toBe(1);
  });
});
