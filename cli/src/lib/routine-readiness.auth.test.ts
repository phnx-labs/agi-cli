import type { RotateCandidate } from './accounting/rotate.js';
import { describe, it, expect } from 'vitest';
import { fireTimeAuthReadiness } from './routine-readiness.js';
import { writeAuthHealthEntries, authCacheKey, type AuthVerdict } from './auth-health.js';
import { machineId } from './machine-id.js';

/**
 * Seed the daemon-warmed auth-health cache (isolated HOME per tests/setup.ts) for
 * a unique (agent, version) so each case is independent of the merge that
 * `writeAuthHealthEntries` performs. Returns the version key.
 */
let n = 0;
function seed(verdict: AuthVerdict, account?: string): string {
  const version = `9.9.${n++}`;
  writeAuthHealthEntries({
    [authCacheKey(machineId(), 'claude', version)]: { verdict, checkedAt: Date.now(), ...(account ? { account } : {}) },
  });
  return version;
}

describe('fireTimeAuthReadiness (PHNX-3415 fire-time auth preflight)', () => {
  it('BLOCKS a revoked account with agent_auth_failed + a version-targeted re-login repair', () => {
    const version = seed('revoked', 'bot@example.com');
    const r = fireTimeAuthReadiness('claude', version);
    expect(r?.code).toBe('agent_auth_failed');
    expect(r?.repair).toBe(`agents run claude@${version} -- login`);
    expect(r?.message).toContain('bot@example.com');
    expect(r?.message).toContain('revoked');
  });

  it('BLOCKS an unconfigured account — the "no account signed in / Please run /login" case', () => {
    const version = seed('unconfigured');
    expect(fireTimeAuthReadiness('claude', version)?.code).toBe('agent_auth_failed');
  });

  it('fails OPEN (null) on a still-usable or indeterminate verdict', () => {
    for (const verdict of ['live', 'rate_limited', 'unverified', 'expired', 'error'] as AuthVerdict[]) {
      const version = seed(verdict);
      expect(fireTimeAuthReadiness('claude', version), `${verdict} must not block`).toBeNull();
    }
  });

  it('fails OPEN (null) when the cache has no entry for this (agent, version)', () => {
    expect(fireTimeAuthReadiness('claude', '0.0.0-never-probed')).toBeNull();
  });
});

describe('selected account preflight', () => {
  it('ignores the revoked legacy version cache for a healthy selected slot', () => {
    const version = seed('revoked');
    const candidate = { agent: 'claude', version, nativeAccount: 'second', accountKey: 'second', signedIn: true, authVerdict: 'live', authCheckedAt: Date.now(), usageStatus: null, usageSnapshot: null, email: null } as RotateCandidate;
    expect(fireTimeAuthReadiness('claude', version, candidate)).toBeNull();
    expect(fireTimeAuthReadiness('claude', version, { ...candidate, authVerdict: 'revoked' })?.repair).toBe('agents accounts login claude#second');
  });
});
