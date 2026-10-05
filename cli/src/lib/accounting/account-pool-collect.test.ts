import { describe, it, expect } from 'vitest';
import { foldRegistryCandidates, type RunCandidateInputs } from './account-pool-collect.js';
import type { RegistryAccountRecord } from './account-pool.js';
import type { RotateCandidate } from './rotate.js';

function nativeCandidate(over: Partial<RotateCandidate>): RotateCandidate {
  return {
    agent: 'claude',
    version: '2.1.220',
    accountKey: 'claude:org=native',
    accountLabel: 'native@x.com',
    email: 'native@x.com',
    usageKey: null,
    usageStatus: null,
    usageSnapshot: null,
    usageError: null,
    usageMinutesToLimit: null,
    plan: null,
    signedIn: true,
    authVerdict: null,
    lastActive: null,
    ...over,
  };
}

const records: RegistryAccountRecord[] = [
  { name: 'claude-setup', provider: 'anthropic', auth: 'setup-token', secretPresent: true },
  { name: 'or-key', provider: 'openrouter', auth: 'api-key', secretPresent: true },
  { name: 'cursor-key', provider: 'cursor', auth: 'api-key', secretPresent: true },
];

function inputs(over: Partial<RunCandidateInputs> = {}): RunCandidateInputs {
  return { native: [], records, runVersion: '2.1.226', ...over };
}

describe('foldRegistryCandidates', () => {
  it('appends provider accounts as candidates carrying providerAccount + the run version', () => {
    const out = foldRegistryCandidates('claude', inputs());
    const registry = out.filter((c) => c.providerAccount);
    expect(registry.map((c) => c.providerAccount)).toEqual(['claude-setup', 'or-key']);
    for (const c of registry) {
      expect(c.version).toBe('2.1.226');
      expect(c.signedIn).toBe(true);
      expect(c.accountLabel).toBe(c.providerAccount);
    }
  });

  it('keeps native candidates and puts them first', () => {
    const native = [nativeCandidate({})];
    const out = foldRegistryCandidates('claude', inputs({ native }));
    expect(out[0]).toBe(native[0]);
    expect(out.length).toBe(1 + 2);
  });

  it('skips a registry account already covered by a native login (by accountKey)', () => {
    const native = [nativeCandidate({ accountKey: 'claude:name=or-key', accountLabel: 'or-key' })];
    const out = foldRegistryCandidates('claude', inputs({ native }));
    expect(out.filter((c) => c.providerAccount).map((c) => c.providerAccount)).toEqual(['claude-setup']);
  });

  it('returns the native list unchanged when no version is installed to run in', () => {
    const native = [nativeCandidate({})];
    expect(foldRegistryCandidates('claude', inputs({ native, runVersion: undefined }))).toEqual(native);
  });

  it('adds NO provider candidates for a harness with no provider adapter (kimi is native-login only)', () => {
    const out = foldRegistryCandidates('kimi', inputs({ native: [] }));
    expect(out.filter((c) => c.providerAccount)).toEqual([]);
  });

  it('routes each provider account only to a harness its provider can authenticate', () => {
    expect(foldRegistryCandidates('codex', inputs()).filter((c) => c.providerAccount).map((c) => c.providerAccount)).toEqual(['or-key']);
    expect(foldRegistryCandidates('cursor', inputs()).filter((c) => c.providerAccount).map((c) => c.providerAccount)).toEqual(['cursor-key']);
  });

  it('reports signedIn:false for a registry account whose secret is not actually present (PHNX-3502)', () => {
    const noSecret: RegistryAccountRecord[] = [{ name: 'claude-setup', provider: 'anthropic', auth: 'setup-token', secretPresent: false }];
    const out = foldRegistryCandidates('claude', inputs({ records: noSecret }));
    const registry = out.filter((c) => c.providerAccount);
    expect(registry).toHaveLength(1);
    expect(registry[0].signedIn).toBe(false);
  });
});
