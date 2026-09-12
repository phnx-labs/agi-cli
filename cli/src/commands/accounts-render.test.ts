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
  it('renders a healthy account as name + usage and nothing else', () => {
    const out = stripAnsi(renderAccountList([row()], [], { localDevice: 'other-box' }));
    const data = out.split('\n').find((line) => line.includes('work'))!;
    expect(data).toContain('* work');
    expect(data).toContain('20%');
    // The columns the old table printed on every row are gone: a healthy
    // account says only what it is and how used it is.
    expect(data).not.toContain('w@example.com');
    expect(data).not.toContain('LIVE');
    expect(data).not.toContain('box');
    expect(out).not.toContain('IDENTITY');
    expect(out).not.toContain('WHERE');
    expect(out).toContain('* stale usage');
    expect(out).toContain('agents accounts list --fleet');
  });

  it('puts the usage bar + percent in the usage cell and leaves the trailing note empty when there is no repair', () => {
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
    const data = out.split('\n').find((line) => line.includes('work'));
    expect(data).toBeDefined();
    expect(data).toContain('59%*');
    expect(data).not.toContain('fix:');
  });

  it('calls out partial device coverage and stays silent on full coverage', () => {
    const partial = stripAnsi(renderAccountList([row({
      devices: [
        { device: 'zion', authMode: 'native', verdict: 'live' },
        { device: 'worker-1', authMode: 'durable', verdict: 'revoked' },
      ],
    })], [], { localDevice: 'zion' }));
    expect(partial).toContain('usable on 1 of 2 boxes');
    const full = stripAnsi(renderAccountList([row()], [], { localDevice: 'zion' }));
    expect(full).not.toContain('boxes');
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
  });

  it('prints the exact repair command and attention count for an expired account', () => {
    const out = stripAnsi(renderAccountList([
      row({
        verdict: 'expired',
        fix: 'agents accounts login claude#work',
        devices: [{ device: 'zion', authMode: 'native', verdict: 'expired' }],
      }),
    ]));
    expect(out).toContain('expired · fix: agents accounts login claude#work');
    expect(out).toContain('1 accounts need you');
  });

  it.each([
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['missing', 'missing'],
    ['rate_limited', 'rate-limited'],
  ] as const)('trails the %s verdict on the row as %s', (verdict, label) => {
    const out = stripAnsi(renderAccountList([row({
      verdict,
      fix: verdict === 'rate_limited' ? null : 'repair',
    })]));
    const data = out.split('\n').find((line) => line.includes('work'))!;
    expect(data).toContain(label);
  });

  it.each(['live', 'unverified', 'per-device'] as const)(
    'prints no state for the ordinary %s verdict — it is not an operator action',
    (verdict) => {
      const out = stripAnsi(renderAccountList([row({ verdict, fix: null })]));
      const data = out.split('\n').find((line) => line.includes('work'))!;
      expect(data.toLowerCase()).not.toContain(verdict);
    },
  );

  it('never says rate-limited twice when the usage cell already names the throttle', () => {
    const out = stripAnsi(renderAccountList([row({
      verdict: 'rate_limited',
      fix: null,
      usage: {
        status: 'out_of_credits',
        verdict: 'unavailable',
        usedPercent: null,
        stale: false,
        capturedAt: '2026-09-06T00:00:00.000Z',
        resetsAt: null,
        unavailableReason: null,
      },
    })]));
    const data = out.split('\n').find((line) => line.includes('work'))!;
    expect(data).toContain('no credits');
    expect(data).not.toContain('rate-limited');
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
    // A ready provider credential is the ordinary case: name only, no state,
    // and never the provider label the old IDENTITY column repeated.
    const providerLine = out.split('\n').find((line) => line.includes('openrouter-work'))!;
    expect(providerLine.trim()).toBe('openrouter-work');
    expect(out).toContain('Other accounts');
    expect(out).toContain('orphan-proxy');
    expect(out).toContain('missing · fix: agents accounts set-key orphan-proxy');
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
    expect(out).not.toMatch(/out of credits|no credits/i);
    expect(out).toContain('0 accounts need you');
  });
});
