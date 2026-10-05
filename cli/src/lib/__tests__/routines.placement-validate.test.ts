import { describe, expect, it } from 'vitest';
import { validateJob, type JobConfig } from '../scheduling/routines.js';

function base(overrides: Partial<JobConfig> = {}): Partial<JobConfig> {
  return {
    name: 't',
    schedule: '0 9 * * *',
    agent: 'claude',
    prompt: 'do a thing',
    mode: 'auto',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    ...overrides,
  };
}

describe('validateJob hostStrategy', () => {
  it('accepts each known strategy independently of device activation', () => {
    for (const hostStrategy of ['local', 'host', 'fleet', 'cloud'] as const) {
      const cfg = base({
        hostStrategy,
        ...(hostStrategy === 'host' ? { host: 'gpu-box' } : {}),
      });
      expect(validateJob(cfg)).toEqual([]);
    }
  });

  it('rejects unknown strategy', () => {
    const errs = validateJob(base({ hostStrategy: 'everywhere' as JobConfig['hostStrategy'] }));
    expect(errs.some((e) => e.includes('hostStrategy'))).toBe(true);
  });

  it('requires host when strategy is host', () => {
    const errs = validateJob(base({ hostStrategy: 'host', devices: ['zion'] }));
    expect(errs.some((e) => e.includes('requires host'))).toBe(true);
  });

  it('does not encode device activation in host/fleet/cloud definitions', () => {
    for (const hostStrategy of ['host', 'fleet', 'cloud'] as const) {
      const errs = validateJob(base({
        hostStrategy,
        ...(hostStrategy === 'host' ? { host: 'gpu-box' } : {}),
      }));
      expect(errs).toEqual([]);
    }
  });

  it('rejects cloud + workflow', () => {
    const errs = validateJob(base({
      hostStrategy: 'cloud',
      devices: ['zion'],
      agent: undefined,
      workflow: 'autodev',
      prompt: 'x',
    }));
    expect(errs.some((e) => e.includes('cloud') && e.includes('workflow'))).toBe(true);
  });

  it('rejects fleet + command', () => {
    const errs = validateJob(base({
      hostStrategy: 'fleet',
      devices: ['zion'],
      agent: undefined,
      command: 'echo hi',
      prompt: '',
    }));
    expect(errs.some((e) => e.includes('fleet') && e.includes('command'))).toBe(true);
  });

  it('accepts bare host: as back-compat host strategy', () => {
    expect(validateJob(base({ host: 'gpu-box', devices: ['zion'] }))).toEqual([]);
  });

  it('accepts bare host: without definition-level activation metadata', () => {
    expect(validateJob(base({ host: 'gpu-box' }))).toEqual([]);
  });
});
