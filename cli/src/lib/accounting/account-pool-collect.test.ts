import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { foldRegistryCandidates, localRegistryRecords, type RunCandidateInputs } from './account-pool-collect.js';
import { addAccount, readAccountRegistry } from '../account-registry.js';
import { deleteKeychainTokenSync } from '../secrets-client.js';
import { standaloneKeychainIsFileBacked, useFreshSecretsHome } from '../../../tests/secrets-standalone.js';
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

  it('reports signedIn:false for a registry account whose secret is not actually present (PHNX-3502)', () => {
    const noSecret: RegistryAccountRecord[] = [{ name: 'claude-setup', provider: 'anthropic', auth: 'setup-token', secretPresent: false }];
    const out = foldRegistryCandidates('claude', inputs({ records: noSecret }));
    const registry = out.filter((c) => c.providerAccount);
    expect(registry).toHaveLength(1);
    expect(registry[0].signedIn).toBe(false);
  });
});

const fileBacked = await standaloneKeychainIsFileBacked();

describe.skipIf(!fileBacked)('localRegistryRecords — which stored credentials a run may rotate through', () => {
  useFreshSecretsHome();

  it('checks only the accounts that serve the harness, and keeps only those whose secret is present', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pool-'));
    addAccount('claude-a', 'anthropic', 'setup-token', 'sk-ant-oat01-a', root);
    addAccount('claude-b', 'anthropic', 'setup-token', 'sk-ant-oat01-b', root);
    addAccount('claude-gone', 'anthropic', 'setup-token', 'sk-ant-oat01-c', root);
    addAccount('or-key', 'openrouter', 'api-key', 'sk-or-secret', root);
    deleteKeychainTokenSync(Object.values(readAccountRegistry().accounts).find((a) => a.name === 'claude-gone')!.secretRef);

    const started = Date.now();
    const records = await localRegistryRecords('claude');
    const elapsed = Date.now() - started;
    expect(records.map((r) => r.name).sort()).toEqual(['claude-a', 'claude-b']);
    expect(records.every((r) => r.secretPresent)).toBe(true);
    expect((await localRegistryRecords('claude', true)).map((r) => r.name).sort()).toEqual(['claude-a', 'claude-b', 'or-key']);
    expect(await localRegistryRecords('kimi')).toEqual([]);
    expect(elapsed).toBeLessThan(5_000);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
