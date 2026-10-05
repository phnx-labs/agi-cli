import { describe, it, expect } from 'vitest';
import { extractVersionFromManagedPath } from './discover.js';

describe('extractVersionFromManagedPath', () => {
  it('reads the version from the standard versions/<agent>/<version>/ home', () => {
    const p = '/home/u/.agents/versions/claude/2.1.207/home/.claude/projects/-repo/abc.jsonl';
    expect(extractVersionFromManagedPath('claude', p)).toBe('2.1.207');
  });

  it('reads the codex version from the relocated .codex-homes/<version>/ layout', () => {
    const p = '/home/u/.agents/.codex-homes/0.146.0/sessions/2026/08/30/rollout-abc.jsonl';
    expect(extractVersionFromManagedPath('codex', p)).toBe('0.146.0');
  });

  it('does not present an account short-home key as a vendor version', () => {
    expect(extractVersionFromManagedPath('codex', '/home/u/.agents/.codex-homes/a-deadbeef-123/.codex/sessions/rollout.jsonl')).toBeUndefined();
  });

  it('does not match the codex-homes marker for a non-codex agent', () => {
    const p = '/home/u/.agents/.codex-homes/0.146.0/sessions/x.jsonl';
    expect(extractVersionFromManagedPath('claude', p)).toBeUndefined();
  });

  it('returns undefined for an unmanaged dotfile transcript', () => {
    expect(extractVersionFromManagedPath('codex', '/home/u/.codex/sessions/rollout-x.jsonl')).toBeUndefined();
  });
});
