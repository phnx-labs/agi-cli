import { describe, it, expect } from 'vitest';
import { resolveDispatchRepos, normalizeProviderStatus } from './types.js';

describe('resolveDispatchRepos', () => {
  it('returns [] when neither repo nor repos is set', () => {
    expect(resolveDispatchRepos({ prompt: 'do' })).toEqual([]);
  });

  it('falls back to singular repo when repos is absent', () => {
    expect(resolveDispatchRepos({ prompt: 'do', repo: 'example-user/agents' }))
      .toEqual(['example-user/agents']);
  });

  it('uses repos[] when provided', () => {
    expect(
      resolveDispatchRepos({ prompt: 'do', repos: ['a/b', 'c/d'] }),
    ).toEqual(['a/b', 'c/d']);
  });

  it('merges repo + repos, deduping', () => {
    expect(
      resolveDispatchRepos({
        prompt: 'do',
        repo: 'a/b',
        repos: ['a/b', 'c/d'],
      }),
    ).toEqual(['a/b', 'c/d']);
  });

  it('dedupes case-insensitively', () => {
    expect(
      resolveDispatchRepos({
        prompt: 'do',
        repos: ['Example-User/Agents', 'example-user/agents', 'EXAMPLE-USER/AGENTS'],
      }),
    ).toEqual(['Example-User/Agents']);
  });

  it('trims whitespace', () => {
    expect(
      resolveDispatchRepos({ prompt: 'do', repos: ['  a/b  ', 'c/d'] }),
    ).toEqual(['a/b', 'c/d']);
  });

  it('ignores empty and whitespace-only entries', () => {
    expect(
      resolveDispatchRepos({ prompt: 'do', repos: ['', '   ', 'a/b'] }),
    ).toEqual(['a/b']);
  });

  it('preserves dispatch order (repos first, then singular repo)', () => {
    expect(
      resolveDispatchRepos({
        prompt: 'do',
        repos: ['second/one', 'third/one'],
        repo: 'fourth/one',
      }),
    ).toEqual(['second/one', 'third/one', 'fourth/one']);
  });
});

describe('normalizeProviderStatus', () => {
  describe('rush (Factory Floor switch; default running; has allocating, no queued)', () => {
    it('maps the known Factory Floor strings', () => {
      expect(normalizeProviderStatus('rush', 'allocating')).toBe('allocating');
      expect(normalizeProviderStatus('rush', 'running')).toBe('running');
      expect(normalizeProviderStatus('rush', 'idle')).toBe('idle');
      expect(normalizeProviderStatus('rush', 'paused')).toBe('idle');
      expect(normalizeProviderStatus('rush', 'needs_review')).toBe('idle');
      expect(normalizeProviderStatus('rush', 'input_required')).toBe('input_required');
      expect(normalizeProviderStatus('rush', 'completed')).toBe('completed');
      expect(normalizeProviderStatus('rush', 'failed')).toBe('failed');
      expect(normalizeProviderStatus('rush', 'cancelled')).toBe('cancelled');
    });
    it('defaults unknown/empty to running (no queued, exact-match only)', () => {
      expect(normalizeProviderStatus('rush', 'queued')).toBe('running');
      expect(normalizeProviderStatus('rush', 'weird')).toBe('running');
      expect(normalizeProviderStatus('rush', '')).toBe('running');
      expect(normalizeProviderStatus('rush', undefined)).toBe('running');
    });
  });

  describe('codex (substring match; default running)', () => {
    it('maps a representative status per bucket', () => {
      expect(normalizeProviderStatus('codex', 'queued')).toBe('queued');
      expect(normalizeProviderStatus('codex', 'in_progress')).toBe('running');
      expect(normalizeProviderStatus('codex', 'paused')).toBe('idle');
      expect(normalizeProviderStatus('codex', 'needs_review')).toBe('idle');
      expect(normalizeProviderStatus('codex', 'succeeded')).toBe('completed');
      expect(normalizeProviderStatus('codex', 'error')).toBe('failed');
      expect(normalizeProviderStatus('codex', 'canceled')).toBe('cancelled');
    });
    it('defaults unknown/empty to running', () => {
      expect(normalizeProviderStatus('codex', 'weird')).toBe('running');
      expect(normalizeProviderStatus('codex', '')).toBe('running');
    });
  });

  describe('antigravity (substring match; undefined-safe; default completed)', () => {
    it('maps a representative status per bucket', () => {
      expect(normalizeProviderStatus('antigravity', 'pending')).toBe('queued');
      expect(normalizeProviderStatus('antigravity', 'in_progress')).toBe('running');
      expect(normalizeProviderStatus('antigravity', 'idle')).toBe('idle');
      expect(normalizeProviderStatus('antigravity', 'paused')).toBe('idle');
      expect(normalizeProviderStatus('antigravity', 'success')).toBe('completed');
      expect(normalizeProviderStatus('antigravity', 'fail')).toBe('failed');
      expect(normalizeProviderStatus('antigravity', 'cancel')).toBe('cancelled');
    });
    it('defaults unknown/undefined to completed (terminal synchronous response)', () => {
      expect(normalizeProviderStatus('antigravity', 'weird')).toBe('completed');
      expect(normalizeProviderStatus('antigravity', undefined)).toBe('completed');
    });
  });

  describe('cursor (v1 run statuses)', () => {
    it('maps every documented run status', () => {
      expect(normalizeProviderStatus('cursor', 'CREATING')).toBe('queued');
      expect(normalizeProviderStatus('cursor', 'RUNNING')).toBe('running');
      expect(normalizeProviderStatus('cursor', 'FINISHED')).toBe('completed');
      expect(normalizeProviderStatus('cursor', 'ERROR')).toBe('failed');
      expect(normalizeProviderStatus('cursor', 'EXPIRED')).toBe('failed');
      expect(normalizeProviderStatus('cursor', 'CANCELLED')).toBe('cancelled');
      expect(normalizeProviderStatus('cursor', 'future')).toBe('running');
    });
  });
});
