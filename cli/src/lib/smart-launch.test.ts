import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  affinityWeights,
  sampleWeighted,
  resolveDeviceAffinity,
  isDeviceAuto,
  applyDeviceAutoToOptions,
  resolveDeviceAuto,
  formatNoHealthyDeviceError,
  type WeightedCandidate,
} from './smart-launch.js';
import type { AffinityRow } from './session/db.js';

function row(key: string, launches: number): AffinityRow {
  return { key, launches, durationMs: 0, tokenCount: 0, costUsd: 0 };
}

describe('affinityWeights', () => {
  it('gives higher weight to more launches', () => {
    const w = affinityWeights([row('s1', 10), row('m0', 1)], 1.0);
    expect(w.find((c) => c.key === 's1')!.weight).toBeGreaterThan(
      w.find((c) => c.key === 'm0')!.weight,
    );
  });

  it('drops unknown / zero-launch keys', () => {
    const w = affinityWeights([row('(unknown)', 5), row('s1', 0), row('s1', 3)]);
    expect(w.every((c) => c.key !== '(unknown)')).toBe(true);
    expect(w.every((c) => c.launches > 0)).toBe(true);
  });
});

describe('formatNoHealthyDeviceError separates a timeout from an outage (PHNX-3682)', () => {
  it('says the probe timed out instead of calling a healthy box unreachable', () => {
    const msg = formatNoHealthyDeviceError(['m1', 'm2'], new Map([
      ['m1', { reachable: false, timedOut: true }],
      ['m2', { reachable: false, timedOut: true }],
    ]), 'codex');
    expect(msg).toContain('m1 (probe timed out), m2 (probe timed out)');
    expect(msg).not.toContain('unreachable');
  });

  it('drops the usage-window hint when nothing was turned away for a window', () => {
    // "earliest window resets unknown" implies a rate limit. On a timed-out pool
    // that sent operators looking for a quota problem that did not exist.
    const msg = formatNoHealthyDeviceError(['m1'], new Map([
      ['m1', { reachable: false, timedOut: true }],
    ]), 'codex');
    expect(msg).not.toContain('earliest window resets');
    expect(msg).toContain('every probe (1) exceeded the probe budget');
  });

  it('still says unreachable when the probe genuinely could not connect', () => {
    const msg = formatNoHealthyDeviceError(['m1'], new Map([
      ['m1', { reachable: false }],
    ]), 'codex');
    expect(msg).toContain('m1 (unreachable)');
    expect(msg).toContain('earliest window resets unknown');
  });

  it('distinguishes a device the probe returned no signal for at all', () => {
    const msg = formatNoHealthyDeviceError(['ghost'], new Map(), 'codex');
    expect(msg).toContain('ghost (no probe signal)');
  });

  it('counts a partial timeout rather than claiming the whole pool timed out', () => {
    const msg = formatNoHealthyDeviceError(['m1', 'm2'], new Map([
      ['m1', { reachable: false, timedOut: true }],
      ['m2', { reachable: true, headroom: 'loaded', installed: true, signedIn: true }],
    ]), 'codex');
    expect(msg).toContain('1 of 2 probes exceeded the probe budget');
    expect(msg).toContain('m2 (overloaded)');
  });
});

it('truthfully describes installed devices with no ready account', () => {
  expect(formatNoHealthyDeviceError(['local', 'busy'], new Map([
    ['local', { reachable: true, headroom: 'idle', installed: false, signedIn: false }],
    ['busy', { reachable: true, headroom: 'loaded', installed: true, signedIn: true }],
  ]))).toContain("local (no ready harness account), busy (overloaded)");
});

describe('sampleWeighted', () => {
  it('returns null for empty candidates', () => {
    expect(sampleWeighted([])).toBeNull();
  });

  it('always picks the only candidate', () => {
    expect(sampleWeighted([{ key: 'only', launches: 1, weight: 1 }])).toBe('only');
  });

  it('prefers the heavier weight with a deterministic rng', () => {
    const cands: WeightedCandidate[] = [
      { key: 's1', launches: 90, weight: 90 },
      { key: 'm0', launches: 10, weight: 10 },
    ];
    expect(sampleWeighted(cands, () => 0.5)).toBe('s1');
    expect(sampleWeighted(cands, () => 0.95)).toBe('m0');
  });
});

describe('isDeviceAuto', () => {
  it('matches auto case-insensitively', () => {
    expect(isDeviceAuto('auto')).toBe(true);
    expect(isDeviceAuto('AUTO')).toBe(true);
    expect(isDeviceAuto(' Auto ')).toBe(true);
    expect(isDeviceAuto('yosemite-s1')).toBe(false);
    expect(isDeviceAuto(undefined)).toBe(false);
  });
});

describe('resolveDeviceAffinity', () => {
  it('samples most-used online host', () => {
    const plan = resolveDeviceAffinity({
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0', 'yosemite-s1', 'yosemite-m0'],
      deviceAffinity: [
        row('yosemite-s1', 50),
        row('yosemite-s0', 5),
        row('yosemite-m0', 1),
      ],
      rng: () => 0.5,
    });
    expect(plan.host).toBe('yosemite-s1');
  });

  it('returns host null when local machine is picked', () => {
    const plan = resolveDeviceAffinity({
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0'],
      deviceAffinity: [row('yosemite-s0', 10)],
      rng: () => 0.5,
    });
    expect(plan.host).toBeNull();
  });

  it('excludes offline hosts from affinity', () => {
    const plan = resolveDeviceAffinity({
      localMachine: 'yosemite-s0',
      eligibleHosts: ['yosemite-s0'],
      deviceAffinity: [row('yosemite-s1', 100), row('yosemite-s0', 2)],
      rng: () => 0.5,
    });
    expect(plan.host).toBeNull();
    expect(plan.pickedDeviceKey).toBe('yosemite-s0');
  });
});

describe('resolveDeviceAuto', () => {
  it('picks the least-loaded reachable device with the requested agent installed', async () => {
    const plan = await resolveDeviceAuto('codex', {
      localMachine: 'local',
      eligibleHosts: ['local', 'busy', 'idle-no-codex', 'idle'],
      probe: async () => new Map([
        ['local', { reachable: true, loadPercent: 30, memPercent: 20, headroom: 'light', installed: true, signedIn: true }],
        ['busy', { reachable: true, loadPercent: 80, memPercent: 20, headroom: 'loaded', installed: true }],
        ['idle-no-codex', { reachable: true, loadPercent: 2, memPercent: 5, headroom: 'idle', installed: false }],
        ['idle', { reachable: true, loadPercent: 5, memPercent: 5, headroom: 'idle', installed: true, signedIn: true }],
      ]),
    });
    expect(plan.host).toBe('idle');
    expect(plan.pickedDeviceKey).toBe('idle');
  });

  it('ranks a preferred device ahead of a less-loaded one (agents devices prefer)', async () => {
    // `busy-preferred` is loaded heavier than `idle`, but the operator boosted
    // it — so it wins. Without the boost `idle` would.
    const probe = async () => new Map([
      ['idle', { reachable: true, loadPercent: 5, memPercent: 5, headroom: 'idle', installed: true, signedIn: true }],
      ['busy-preferred', { reachable: true, loadPercent: 60, memPercent: 30, headroom: 'busy', installed: true, signedIn: true }],
    ] as const);
    const base = { localMachine: 'local', eligibleHosts: ['idle', 'busy-preferred'], probe } as const;
    expect((await resolveDeviceAuto('codex', { ...base })).host).toBe('idle');
    expect((await resolveDeviceAuto('codex', { ...base, preferred: new Set(['busy-preferred']) })).host).toBe('busy-preferred');
  });

  it('fails loud when live probing cannot evaluate placement', async () => {
    await expect(resolveDeviceAuto('codex', {
      localMachine: 'local',
      eligibleHosts: ['local', 'remote'],
      probe: async () => {
        throw new Error('probe unavailable');
      },
    })).rejects.toThrow('probe unavailable');
  });

  it('excludes unreachable, signed-out, capped, and overloaded choices', async () => {
    const plan = await resolveDeviceAuto('codex', {
      localMachine: 'local',
      eligibleHosts: ['local', 'offline', 'capped', 'loaded', 'ready'],
      probe: async () => new Map([
        ['local', { reachable: true, headroom: 'light', installed: true, signedIn: false }],
        ['offline', { reachable: false, headroom: 'idle', installed: true, signedIn: true }],
        ['capped', { reachable: true, headroom: 'idle', installed: true, signedIn: false }],
        ['loaded', { reachable: true, headroom: 'loaded', installed: true, signedIn: true }],
        ['ready', { reachable: true, headroom: 'light', installed: true, signedIn: true }],
      ]),
    });
    expect(plan.host).toBe('ready');
  });

  it('fails loud when every account is ineligible', async () => {
    await expect(resolveDeviceAuto('codex', {
      localMachine: 'local',
      eligibleHosts: ['local', 'remote'],
      probe: async () => new Map([
        ['local', { reachable: true, headroom: 'idle', installed: true, signedIn: false }],
        ['remote', { reachable: true, headroom: 'idle', installed: true, signedIn: false }],
      ]),
    })).rejects.toThrow('no healthy device can run codex');
  });

  it('keeps installed signed-out devices eligible for an interactive account picker', async () => {
    const plan = await resolveDeviceAuto('claude', {
      accountPicker: true,
      localMachine: 'local',
      eligibleHosts: ['local', 'remote'],
      probe: async () => new Map([
        ['local', { reachable: true, loadPercent: 35, headroom: 'light', installed: true, signedIn: false, pickerEligible: true }],
        ['remote', { reachable: true, loadPercent: 5, headroom: 'idle', installed: true, signedIn: false, pickerEligible: true }],
      ]),
    });
    expect(plan.host).toBe('remote');
    expect(plan.pickedDeviceKey).toBe('remote');
  });

  it('still prefers a signed-in device when picker placement also admits signed-out devices', async () => {
    const plan = await resolveDeviceAuto('claude', {
      accountPicker: true,
      localMachine: 'local',
      eligibleHosts: ['signed-out-idle', 'signed-in-light'],
      probe: async () => new Map([
        ['signed-out-idle', { reachable: true, loadPercent: 2, headroom: 'idle', installed: true, signedIn: false, pickerEligible: true }],
        ['signed-in-light', { reachable: true, loadPercent: 25, headroom: 'light', installed: true, signedIn: true, pickerEligible: true }],
      ]),
    });
    expect(plan.host).toBe('signed-in-light');
  });

  it('excludes a lower-load device whose picker has only throttled accounts', async () => {
    const plan = await resolveDeviceAuto('claude', {
      accountPicker: true,
      localMachine: 'local',
      eligibleHosts: ['throttled-idle', 'signed-out-light'],
      probe: async () => new Map([
        ['throttled-idle', { reachable: true, loadPercent: 2, headroom: 'idle', installed: true, signedIn: false, pickerEligible: false }],
        ['signed-out-light', { reachable: true, loadPercent: 25, headroom: 'light', installed: true, signedIn: false, pickerEligible: true }],
      ]),
    });
    expect(plan.host).toBe('signed-out-light');
  });

  it('fails loud when every account picker would contain only throttled rows', async () => {
    await expect(resolveDeviceAuto('claude', {
      accountPicker: true,
      localMachine: 'local',
      eligibleHosts: ['local', 'remote'],
      probe: async () => new Map([
        ['local', { reachable: true, headroom: 'idle', installed: true, signedIn: false, pickerEligible: false }],
        ['remote', { reachable: true, headroom: 'idle', installed: true, signedIn: false, pickerEligible: false }],
      ]),
    })).rejects.toThrow('no healthy device can run claude');
  });


  it('keeps live load placement when run auto has not selected a harness yet', async () => {
    const plan = await resolveDeviceAuto(undefined, {
      localMachine: 'local',
      eligibleHosts: ['local', 'idle'],
      probe: async (_pool, agent) => {
        expect(agent).toBeUndefined();
        return new Map([
          ['local', { reachable: true, loadPercent: 40, memPercent: 20, headroom: 'light' }],
          ['idle', { reachable: true, loadPercent: 5, memPercent: 10, headroom: 'idle' }],
        ]);
      },
    });
    expect(plan.host).toBe('idle');
    expect(plan.pickedDeviceKey).toBe('idle');
  });
});

describe('applyDeviceAutoToOptions', () => {
  it('rewrites --device auto to a concrete remote host and enables balanced', async () => {
    const options = { device: 'auto' as string | undefined };
    const result = await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'yosemite-s1',
        candidates: [
          { key: 'yosemite-s1', loadPercent: 5 },
          { key: 'yosemite-s0', loadPercent: 50 },
        ],
        pickedDeviceKey: 'yosemite-s1',
      }),
    });
    expect(options.device).toBe('yosemite-s1');
    expect(options.balanced).toBe(true);
    expect(result.attempted).toBe(true);
    expect(result.banner?.hostLabel).toBe('yosemite-s1');
    expect(result.banner?.deviceHint).toContain('yosemite-s1:5%');
    expect(result.banner?.acctNote).toBe('accounts=balanced');
  });

  it('rewrites auto on every host slot alias once', async () => {
    const options = {
      host: 'auto' as string | undefined,
      device: 'auto' as string | undefined,
    };
    await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: 'mac-mini',
        candidates: [{ key: 'mac-mini', loadPercent: 3 }],
        pickedDeviceKey: 'mac-mini',
      }),
    });
    expect(options.host).toBe('mac-mini');
    expect(options.device).toBe('mac-mini');
  });

  it('maps local pick to undefined host (no --device)', async () => {
    const options = { device: 'auto' as string | undefined };
    const result = await applyDeviceAutoToOptions(options, {
      resolve: () => ({
        host: null,
        candidates: [{ key: 'yosemite-s0', loadPercent: 10 }],
        pickedDeviceKey: 'yosemite-s0',
      }),
    });
    expect(options.device).toBeUndefined();
    expect(result.banner?.hostLabel).toBe('local');
  });

  it('preserves the auto request and throws on placement failure', async () => {
    const options = { device: 'auto' as string | undefined, balanced: undefined as boolean | undefined };
    await expect(applyDeviceAutoToOptions(options, {
      resolve: () => {
        throw new Error('db locked');
      },
    })).rejects.toThrow('db locked');
    expect(options.device).toBe('auto');
    expect(options.balanced).toBeUndefined();
  });

  it('preserves strategy override and account-picker note', async () => {
    const options = {
      device: 'auto' as string | undefined,
      strategy: 'round-robin',
    };
    const result = await applyDeviceAutoToOptions(options, {
      accountPickerRequested: true,
      resolve: (accountPicker) => {
        expect(accountPicker).toBe(true);
        return {
          host: null,
          candidates: [],
          pickedDeviceKey: 'local',
        };
      },
    });
    expect(options.strategy).toBe('round-robin');
    expect(options.balanced).toBeUndefined();
    expect(result.banner?.acctNote).toBe('accounts=picker');
  });
});

describe('device roles narrow automatic placement', () => {
  // A real agents.yaml under a throwaway HOME — the same store `agents devices
  // role` writes, read back through the placement engine. No mocks.
  let TMP = '';

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-smart-launch-roles-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function fresh() {
    vi.resetModules();
    const deviceConfig = await import('./device-config.js');
    const smartLaunch = await import('./smart-launch.js');
    return { ...deviceConfig, ...smartLaunch };
  }

  it('listOnlineDeviceNames drops a local machine marked personal', async () => {
    const mod = await fresh();
    mod.setConfiguredDeviceRole('zion', 'personal');
    expect(mod.listOnlineDeviceNames('zion')).toEqual([]);
  });

  it('resolveDeviceAuto does not re-add a personal local machine to the pool', async () => {
    const mod = await fresh();
    mod.setConfiguredDeviceRole('zion', 'personal');
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    const seen: string[][] = [];
    const plan = await mod.resolveDeviceAuto('claude', {
      localMachine: 'zion',
      eligibleHosts: ['yosemite-s0'],
      probe: async (pool) => {
        seen.push([...pool]);
        return new Map([['yosemite-s0', { reachable: true, loadPercent: 5, memPercent: 5, headroom: 'idle', installed: true, signedIn: true }]]);
      },
    });
    expect(seen[0]).toEqual(['yosemite-s0']);
    expect(plan.host).toBe('yosemite-s0');
  });

  it('resolveDeviceAffinity fails loud instead of degrading to a personal local box', async () => {
    // The generic `auto` sentinel (agents ssh auto, the --device auto passthrough,
    // matchHost) resolves through resolveDeviceAffinity, and a null host there
    // means "run locally" — on the very box the personal mark exists to protect.
    const mod = await fresh();
    mod.setConfiguredDeviceRole('zion', 'personal');
    expect(() => mod.resolveDeviceAffinity({ localMachine: 'zion' }))
      .toThrow(/no device is eligible for automatic placement/);
  });

  it('resolveDeviceAffinity keeps the historical degrade when the CALLER hands it an empty list', async () => {
    const mod = await fresh();
    const plan = mod.resolveDeviceAffinity({ localMachine: 'zion', eligibleHosts: [], deviceAffinity: [] });
    expect(plan.host).toBeNull();
  });

  it('resolveDeviceAffinity picks a marked worker over the local personal box', async () => {
    const mod = await fresh();
    mod.setConfiguredDeviceRole('zion', 'personal');
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    const plan = mod.resolveDeviceAffinity({
      localMachine: 'zion',
      eligibleHosts: ['yosemite-s0'],
      deviceAffinity: [{ key: 'yosemite-s0', launches: 3, durationMs: 0, tokenCount: 0, costUsd: 0 }],
      rng: () => 0.5,
    });
    expect(plan.host).toBe('yosemite-s0');
  });

  it('fails loud, naming the fix, when roles leave no eligible device', async () => {
    const mod = await fresh();
    mod.setConfiguredDeviceRole('zion', 'personal');
    await expect(mod.resolveDeviceAuto('claude', { localMachine: 'zion' }))
      .rejects.toThrow(/no device is eligible for automatic placement/);
  });

  it('the no-healthy-device error names the worker pool that narrowed it', async () => {
    const mod = await fresh();
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    await expect(mod.resolveDeviceAuto('claude', {
      localMachine: 'zion',
      eligibleHosts: ['yosemite-s0'],
      probe: async () => new Map([['yosemite-s0', { reachable: true, headroom: 'idle', installed: true, signedIn: false }]]),
    })).rejects.toThrow(/pool: workers: yosemite-s0/);
  });
});
