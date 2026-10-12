import { describe, it, expect } from 'vitest';
import { registryPoolCandidates, type RegistryAccountRecord } from './account-pool.js';

describe('registryPoolCandidates — subscription credentials the harness can use', () => {
  const records: RegistryAccountRecord[] = [
    { name: 'claude-setup', provider: 'anthropic', auth: 'setup-token', secretPresent: true },
    { name: 'openai-key', provider: 'openai', auth: 'api-key', secretPresent: true },
    { name: 'cursor-key', provider: 'cursor', auth: 'api-key', secretPresent: true },
    { name: 'or-key', provider: 'openrouter', auth: 'api-key', secretPresent: true },
  ];

  it('claude pool takes the anthropic setup-token only: an openrouter key is never picked automatically', () => {
    expect(registryPoolCandidates(records, 'claude').map((c) => c.name)).toEqual(['claude-setup']);
  });

  it('per-token accounts never join any pool: api-key and bearer-token records are left to --account', () => {
    const keyed: RegistryAccountRecord[] = [
      ...records,
      { name: 'anthropic-key', provider: 'anthropic', auth: 'api-key', secretPresent: true },
      { name: 'gateway', provider: 'litellm', auth: 'bearer-token', secretPresent: true },
      { name: 'grok-key', provider: 'xai', auth: 'api-key', secretPresent: true },
    ];
    for (const agent of ['claude', 'codex', 'cursor', 'grok', 'opencode'] as const) {
      expect(registryPoolCandidates(keyed, agent).every((c) => c.auth === 'setup-token')).toBe(true);
    }
    expect(registryPoolCandidates(keyed, 'codex')).toEqual([]);
  });

  it('carries secretPresent through unchanged — false is not upgraded to true', () => {
    const rec: RegistryAccountRecord[] = [{ name: 'claude-setup', provider: 'anthropic', auth: 'setup-token', secretPresent: false }];
    expect(registryPoolCandidates(rec, 'claude')[0].secretPresent).toBe(false);
  });

  it('tags a synthetic agent-scoped accountKey until identity capture backfills it', () => {
    const [c] = registryPoolCandidates(records, 'claude');
    expect(c.accountKey).toBe('claude:name=claude-setup');
    expect(c.email).toBeNull();
    expect(c.auth).toBe('setup-token');
  });

  it('tags the key with the harness, so the same name under two harnesses never collides', () => {
    const rec: RegistryAccountRecord[] = [{ name: 'shared', provider: 'anthropic', auth: 'setup-token', secretPresent: true }];
    expect(registryPoolCandidates(rec, 'claude')[0].accountKey).toBe('claude:name=shared');
  });
});
