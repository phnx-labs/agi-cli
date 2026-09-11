import { describe, expect, it } from 'vitest';
import { renderAccountList } from './accounts.js';
import { accountListJson, type NativeAccountCatalogRow, type ProviderAccountCatalogRow } from '../lib/account-catalog.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function row(overrides: Partial<NativeAccountCatalogRow> = {}): NativeAccountCatalogRow {
  return {
    kind: 'native',
    agent: 'claude',
    identityKey: 'claude:user=1',
    name: 'work',
    id: 'id-work',
    email: 'w@example.com',
    display: 'w@example.com',
    identityLabel: 'w@example.com',
    home: 'main',
    installations: [{ label: 'main', releaseVersion: '2.1.220', signedIn: true }],
    isDefault: true,
    state: 'connected',
    provisioning: 'portable',
    verdict: 'live',
    checkedAt: '2026-09-06T00:00:00.000Z',
    devices: [{ device: 'zion', authMode: 'native', verdict: 'live' }],
    usage: {
      status: 'available',
      verdict: 'available',
      usedPercent: 20,
      stale: false,
      capturedAt: '2026-09-06T00:00:00.000Z',
      resetsAt: null,
      unavailableReason: null,
    },
    fix: null,
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderAccountCatalogRow> = {}): ProviderAccountCatalogRow {
  return {
    kind: 'provider',
    name: 'openrouter-work',
    id: 'id-or',
    provider: 'openrouter',
    auth: 'api-key',
    harnesses: ['claude'],
    defaultFor: [],
    identityLabel: 'openrouter',
    verdict: 'ready',
    fix: null,
    ...overrides,
  };
}

describe('renderAccountList', () => {
  it('renders one account row with state, where, usage, and default marker', () => {
    const out = stripAnsi(renderAccountList([row()], [], { localDevice: 'other-box' }));
    expect(out).toContain('ACCOUNT');
    expect(out).toContain('IDENTITY');
    expect(out).toContain('STATE');
    expect(out).toContain('WHERE');
    expect(out).toContain('USAGE');
    expect(out).toContain('FIX');
    expect(out).toContain('* work');
    expect(out).toContain('LIVE');
    expect(out).toContain('on 1 box');
    expect(out).toContain('20%');
    expect(out).toContain('STATE:');
    expect(out).toContain('* stale usage');
  });

  it('puts the usage bar + percent in USAGE and leaves FIX empty when there is no repair', () => {
    const out = stripAnsi(renderAccountList([row({
      usage: {
        status: 'available',
        verdict: 'available',
        usedPercent: 59,
        stale: true,
        capturedAt: '2026-09-06T00:00:00.000Z',
        resetsAt: null,
        unavailableReason: null,
      },
      fix: null,
    })], [], { localDevice: 'zion' }));
    const data = out.split('\n').find((line) => line.includes('work') && line.includes('LIVE'));
    expect(data).toBeDefined();
    expect(data).toContain('59%*');
    expect(data).not.toContain('fix:');
    const header = out.split('\n').find((line) => line.includes('ACCOUNT') && line.includes('FIX'));
    expect(header).toMatch(/WHERE\s+USAGE\s+FIX/);
  });

  it('reads WHERE as this box when only the local device reports', () => {
    const out = stripAnsi(renderAccountList([row()], [], { localDevice: 'zion' }));
    expect(out).toContain('this box');
    expect(out).not.toContain('on 1 box');
    // The renderer must not consult machineId() — omitting localDevice stays
    // hermetic even when this host's name matches the fixture device.
    const omitted = stripAnsi(renderAccountList([row()]));
    expect(omitted).not.toContain('this box');
    expect(omitted).toContain('on 1 box');
  });

  it('restricts a harness filter to that harness and never prints an empty group', () => {
    const native = row({ agent: 'codex', name: 'codex-work', identityKey: 'codex:user=1' });
    const cross = provider({
      name: 'legacy-openrouter-work',
      harnesses: ['claude', 'codex', 'opencode'],
    });
    const out = stripAnsi(renderAccountList([native], [cross], { harness: 'codex', localDevice: 'zion' }));
    expect(out).toContain('codex');
    expect(out).toContain('codex-work');
    expect(out).toContain('legacy-openrouter-work');
    expect(out).not.toMatch(/^claude$/m);
    expect(out).not.toContain('\nclaude\n');
    expect(out).not.toContain('opencode');
    const headers = out.split('\n').filter((line) => /ACCOUNT\s+IDENTITY/.test(line));
    expect(headers).toHaveLength(1);
  });

  it('prints the exact repair command and attention count for an expired account', () => {
    const out = stripAnsi(renderAccountList([
      row({
        verdict: 'expired',
        fix: 'agents accounts login claude#work',
        devices: [{ device: 'zion', authMode: 'native', verdict: 'expired' }],
      }),
    ]));
    expect(out).toContain('EXPIRED');
    expect(out).toContain('fix: agents accounts login claude#work');
    expect(out).toContain('1 accounts need you');
  });

  it.each([
    ['live', 'LIVE'],
    ['expired', 'EXPIRED'],
    ['revoked', 'REVOKED'],
    ['rate_limited', 'LIMITED'],
    ['unverified', 'UNVERIFIED'],
    ['missing', 'MISSING'],
    ['per-device', 'PER-DEVICE'],
  ] as const)('renders the %s verdict as %s', (verdict, label) => {
    const out = stripAnsi(renderAccountList([row({
      verdict,
      fix: verdict === 'live' || verdict === 'rate_limited' ? null : 'repair',
    })]));
    expect(out).toContain(label);
  });

  it('never exposes reserved credential stores in account output', () => {
    const out = stripAnsi(renderAccountList([row()]));
    expect(out.toLowerCase()).not.toContain('bundle');
    expect(out).not.toContain('__claude__');
  });

  it('handles an empty account list', () => {
    const out = stripAnsi(renderAccountList([]));
    expect(out).toContain('No accounts found');
    expect(out).toContain('agents accounts add <harness> [name]');
    expect(out).toContain('0 accounts need you');
  });

  it('folds a provider credential under its harness and lists an unused one under Other accounts', () => {
    const native = row();
    const used = provider();
    const orphan = provider({
      name: 'orphan-proxy',
      id: 'id-orphan',
      provider: 'custom',
      harnesses: [],
      identityLabel: 'custom',
      verdict: 'missing',
      fix: 'agents accounts set-key orphan-proxy',
    });
    const out = stripAnsi(renderAccountList([native], [used, orphan]));
    expect(out).toContain('claude');
    expect(out).toContain('* work');
    expect(out).toContain('openrouter-work');
    expect(out).toContain('READY');
    expect(out).toContain('Other accounts');
    expect(out).toContain('orphan-proxy');
    expect(out).toContain('MISSING');
    expect(out).toContain('fix: agents accounts set-key orphan-proxy');
    expect(out.toLowerCase()).not.toContain('bundle');
    expect(out).toContain('1 accounts need you');

    const json = accountListJson([native], [used, orphan]);
    expect(json.accounts).toEqual([
      expect.objectContaining({ kind: 'native', harness: 'claude', name: 'work' }),
      expect.objectContaining({ kind: 'provider', harness: 'claude', name: 'openrouter-work', verdict: 'ready' }),
      expect.objectContaining({ kind: 'provider', harness: null, name: 'orphan-proxy', verdict: 'missing' }),
    ]);
  });

  it('emits one unfiltered JSON entry per harness a provider account authenticates', () => {
    const multi = provider({
      name: 'myrouter',
      id: 'id-or',
      harnesses: ['claude', 'codex', 'opencode'],
      defaultFor: ['codex'],
    });
    const unfiltered = accountListJson([], [multi]);
    expect(unfiltered.accounts).toHaveLength(3);
    expect(unfiltered.accounts.map((row) => row.id)).toEqual(['id-or', 'id-or', 'id-or']);
    expect(unfiltered.accounts.map((row) => row.kind)).toEqual(['provider', 'provider', 'provider']);
    expect(unfiltered.accounts.map((row) => row.harness)).toEqual(['claude', 'codex', 'opencode']);
    expect(unfiltered.accounts.map((row) => row.isDefault)).toEqual([false, true, false]);

    const filtered = accountListJson([], [multi], 'codex');
    expect(filtered.accounts).toHaveLength(1);
    expect(filtered.accounts[0]).toEqual(expect.objectContaining({
      kind: 'provider',
      id: 'id-or',
      harness: 'codex',
      name: 'myrouter',
      isDefault: true,
    }));
  });

  it('does not count an unverified worker (no repair) as needing you', () => {
    const out = stripAnsi(renderAccountList([row({
      verdict: 'unverified',
      fix: null,
      usage: {
        status: null,
        verdict: 'unavailable',
        usedPercent: null,
        stale: false,
        capturedAt: null,
        resetsAt: null,
        unavailableReason: 'usage unavailable (headless)',
      },
    })]));
    expect(out).toContain('UNVERIFIED');
    expect(out).not.toMatch(/out of credits|no credits/i);
    expect(out).toContain('0 accounts need you');
  });
});
