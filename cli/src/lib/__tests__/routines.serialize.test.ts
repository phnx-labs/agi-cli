import { describe, it, expect } from 'vitest';
import * as yaml from 'yaml';
import { serializeJob } from '../scheduling/routines.js';

const EXISTING = `name: drain-prix
schedule: "15,45 * * * *"
agent: claude
mode: skip
timeout: 2h
prompt: >
  Unattended drain for the "Prix" Linear project. There is no interactive user:
  never call AskUserQuestion, never wait for input.
`;

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(yaml.parse(EXISTING) as Record<string, unknown>), ...overrides };
}

describe('serializeJob — format-preserving writes', () => {
  it('is a byte-for-byte no-op when nothing changed', () => {
    expect(serializeJob(output(), EXISTING)).toBe(EXISTING);
  });

  it('pinning devices adds only the devices key, preserving the rest', () => {
    const result = serializeJob(output({ devices: ['zion'] }), EXISTING);
    expect(result).toContain('schedule: "15,45 * * * *"');
    expect(result).toContain('prompt: >');
    expect(result).toContain('never call AskUserQuestion');
    expect(result).toContain('zion');
    const added = result.replace(EXISTING.replace(/\n$/, ''), '').trim();
    expect(added).toMatch(/devices:/);
  });

  it('pause then resume round-trips back to the original bytes', () => {
    const paused = serializeJob(output({ enabled: false }), EXISTING);
    expect(paused).toContain('enabled: false');
    expect(paused).toContain('schedule: "15,45 * * * *"');
    const resumed = serializeJob(output(), paused);
    expect(resumed).toBe(EXISTING);
  });

  it('removes keys that are no longer present (devices cleared)', () => {
    const pinned = serializeJob(output({ devices: ['zion'] }), EXISTING);
    const cleared = serializeJob(output(), pinned);
    expect(cleared).not.toContain('devices');
    expect(cleared).toBe(EXISTING);
  });

  it('falls back to canonical stringify for a new file (null existing)', () => {
    const result = serializeJob(output({ devices: ['zion'] }), null);
    expect(result).toContain('name: drain-prix');
    expect(result).toContain('zion');
  });

  it('falls back to canonical stringify when the existing file is unparseable', () => {
    const result = serializeJob(output(), ':\n  - broken: [unbalanced');
    expect(result).toContain('name: drain-prix');
  });
});
