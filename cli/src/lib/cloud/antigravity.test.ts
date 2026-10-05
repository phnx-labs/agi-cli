import { describe, it, expect } from 'vitest';
import {
  buildInteractionBody,
  parseInteraction,
} from './antigravity.js';
import { AntigravityCloudProvider } from './antigravity.js';
import { normalizeProviderStatus } from './types.js';

describe("normalizeProviderStatus('antigravity', …)", () => {
  const mapStatus = (s: string | undefined) => normalizeProviderStatus('antigravity', s);
  it('maps Interactions API statuses to the canonical enum', () => {
    expect(mapStatus('queued')).toBe('queued');
    expect(mapStatus('in_progress')).toBe('running');
    expect(mapStatus('completed')).toBe('completed');
    expect(mapStatus('failed')).toBe('failed');
    expect(mapStatus('cancelled')).toBe('cancelled');
  });
  it('defaults unknown/empty to completed (synchronous response is terminal)', () => {
    expect(mapStatus(undefined)).toBe('completed');
    expect(mapStatus('weird')).toBe('completed');
  });
});

describe('buildInteractionBody', () => {
  it('targets the managed agent with a remote sandbox', () => {
    expect(buildInteractionBody('summarize the repo', 'antigravity-preview-05-2026')).toEqual({
      agent: 'antigravity-preview-05-2026',
      input: 'summarize the repo',
      environment: 'remote',
    });
  });
});

describe('parseInteraction', () => {
  it('parses id, status, summary, and environment id', () => {
    const out = parseInteraction({
      id: 'int_1',
      environment_id: 'env_9',
      status: 'completed',
      output_text: 'done',
    });
    expect(out).toEqual({ id: 'int_1', status: 'completed', summary: 'done', environmentId: 'env_9' });
  });

  it('falls back to interaction_id then a synthetic id', () => {
    expect(parseInteraction({ interaction_id: 'x', status: 'completed' }).id).toBe('x');
    expect(parseInteraction({ status: 'completed' }).id).toMatch(/^antigravity-/);
  });
});

describe('AntigravityCloudProvider capabilities', () => {
  const ENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];

  it('is unavailable with no key source', () => {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      const p = new AntigravityCloudProvider();
      expect(p.capabilities().available).toBe(false);
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });

  it('is available when a Gemini key is in the environment', () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      const p = new AntigravityCloudProvider();
      const caps = p.capabilities();
      expect(caps.available).toBe(true);
      expect(caps.dispatch).toBe(true);
      expect(caps.multiRepo).toBe(false);
      expect(caps.message).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it('is available when a secrets bundle is configured (resolved lazily)', () => {
    const p = new AntigravityCloudProvider({ secretsBundle: 'gemini.com' });
    expect(p.capabilities().available).toBe(true);
  });
});

describe('AntigravityCloudProvider dispatch guards', () => {
  it('rejects repo-backed dispatch with a pointer to Rush', async () => {
    const p = new AntigravityCloudProvider({ secretsBundle: 'gemini.com' });
    await expect(
      p.dispatch({ prompt: 'do', repos: ['owner/repo'] }),
    ).rejects.toThrow(/raw sandbox|rush/i);
  });
});
