import { describe, it, expect } from 'vitest';
import { foldRegistryCandidates, type RunCandidateInputs } from './account-pool-collect.js';
import type { RegistryAccountRecord } from './account-pool.js';
import { readinessFromCandidate, type RotateCandidate } from './rotate.js';
import type { UsageSnapshot } from './usage.js';

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
  it('appends setup-token accounts as candidates carrying providerAccount + the run version, never an api-key one', () => {
    const out = foldRegistryCandidates('claude', inputs());
    const registry = out.filter((c) => c.providerAccount);
    expect(registry.map((c) => c.providerAccount)).toEqual(['claude-setup']);
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
    expect(out.length).toBe(1 + 1);
  });

  it('skips a registry account already covered by a native login (by accountKey)', () => {
    const native = [nativeCandidate({ accountKey: 'claude:name=claude-setup', accountLabel: 'claude-setup' })];
    const out = foldRegistryCandidates('claude', inputs({ native }));
    expect(out.filter((c) => c.providerAccount)).toEqual([]);
  });

  it('returns the native list unchanged when no version is installed to run in', () => {
    const native = [nativeCandidate({})];
    expect(foldRegistryCandidates('claude', inputs({ native, runVersion: undefined }))).toEqual(native);
  });

  it('adds NO provider candidates for a harness with no provider adapter (kimi is native-login only)', () => {
    const out = foldRegistryCandidates('kimi', inputs({ native: [] }));
    expect(out.filter((c) => c.providerAccount)).toEqual([]);
  });

  it('adds no api-key account to any harness: openrouter for codex and a cursor key are left to --account', () => {
    expect(foldRegistryCandidates('codex', inputs()).filter((c) => c.providerAccount)).toEqual([]);
    expect(foldRegistryCandidates('cursor', inputs()).filter((c) => c.providerAccount)).toEqual([]);
  });

  it('includeKeyed (resume with an explicit --account) folds key accounts in, so the named one can match', () => {
    expect(foldRegistryCandidates('claude', inputs(), true).filter((c) => c.providerAccount).map((c) => c.providerAccount))
      .toEqual(['claude-setup', 'or-key']);
  });

  it('carries the provider usage key and its cached snapshot, so rotation excludes a limited token account', () => {
    const resets = new Date(Date.now() + 60 * 60_000);
    const limited: UsageSnapshot = {
      source: 'last_seen',
      sourceLabel: 'status line',
      capturedAt: new Date(),
      windows: [
        { key: 'session', label: 'Current session', shortLabel: 'S', usedPercent: 100, resetsAt: resets, windowMinutes: 300 },
        { key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 40, resetsAt: resets, windowMinutes: 10_080 },
      ],
    };
    const asked: string[] = [];
    const out = foldRegistryCandidates('claude', inputs({
      usageSnapshotFor: (usageKey) => { asked.push(usageKey); return usageKey === 'claude:name=claude-setup' ? limited : null; },
    }));
    const token = out.find((c) => c.providerAccount === 'claude-setup')!;
    expect(token.usageKey).toBe('claude:name=claude-setup');
    expect(token.usageSnapshot).toBe(limited);
    expect(asked).toEqual(['claude:name=claude-setup']);
    expect(readinessFromCandidate(token)).toEqual({ ready: false, reason: 'rate_limited', email: null });

    const blind = foldRegistryCandidates('claude', inputs()).find((c) => c.providerAccount === 'claude-setup')!;
    expect(blind.usageKey).toBe('claude:name=claude-setup');
    expect(blind.usageSnapshot).toBeNull();
    expect(readinessFromCandidate(blind).ready).toBe(true);
  });

  it('reports signedIn:false for a registry account whose secret is not actually present (PHNX-3502)', () => {
    const noSecret: RegistryAccountRecord[] = [{ name: 'claude-setup', provider: 'anthropic', auth: 'setup-token', secretPresent: false }];
    const out = foldRegistryCandidates('claude', inputs({ records: noSecret }));
    const registry = out.filter((c) => c.providerAccount);
    expect(registry).toHaveLength(1);
    expect(registry[0].signedIn).toBe(false);
  });
});
