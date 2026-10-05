import { describe, it, expect } from 'vitest';
import {
  planFleetTargets,
  remoteFleetTargets,
  fanOutDevices,
  fleetHealthSkip,
  runFleet,
  skipLabel,
  upgradeCommand,
  type FleetTarget,
} from './fleet.js';
import type { DeviceProfile, DeviceRegistry } from './registry.js';
import type { DeviceStats } from './health.js';

function stats(host: string, reachable: boolean): DeviceStats {
  return { host, reachable, fetchedAt: 0 };
}

function device(overrides: Partial<DeviceProfile> & { name: string }): DeviceProfile {
  const now = '2026-07-14T00:00:00.000Z';
  return {
    name: overrides.name,
    platform: overrides.platform ?? 'linux',
    shell: overrides.shell ?? 'posix',
    user: overrides.user ?? 'muqsit',
    address: overrides.address ?? { via: 'manual', dnsName: `${overrides.name}.ts.net` },
    auth: overrides.auth ?? { method: 'key' },
    tailscale: overrides.tailscale,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

describe('planFleetTargets', () => {
  it('skips Tailscale-offline devices and keeps online ones', () => {
    const reg: DeviceRegistry = {
      alive: device({ name: 'alive', tailscale: { online: true, direct: true } }),
      dead: device({ name: 'dead', tailscale: { online: false, direct: false, lastSeen: 'yesterday' } }),
      manual: device({ name: 'manual' }),
    };
    const plan = planFleetTargets(reg);
    const byName = Object.fromEntries(plan.map((t) => [t.device.name, t]));
    expect(byName.alive.skip).toBeUndefined();
    expect(byName.dead.skip).toBe('offline');
    expect(byName.manual.skip).toBeUndefined();
  });

  it('skips devices with no address', () => {
    const reg: DeviceRegistry = {
      bare: device({ name: 'bare', address: { via: 'manual' } }),
    };
    const plan = planFleetTargets(reg);
    expect(plan[0].skip).toBe('no-address');
  });
});

describe('remoteFleetTargets (fleet health/drift gate targeting)', () => {
  it('drops this machine, but keeps offline/no-address as faults', () => {
    const reg: DeviceRegistry = {
      zion: device({ name: 'zion', tailscale: { online: true, direct: true } }),
      worker: device({ name: 'worker', tailscale: { online: true, direct: true } }),
      dead: device({ name: 'dead', tailscale: { online: false, direct: false, lastSeen: 'y' } }),
    };
    const targets = remoteFleetTargets(planFleetTargets(reg), 'zion');
    const byName = Object.fromEntries(targets.map((t) => [t.device.name, t]));
    expect(byName.zion).toBeUndefined();
    expect(byName.worker.skip).toBeUndefined();
    expect(byName.dead.skip).toBe('offline');
  });
});

describe('fleetHealthSkip (gate version+doctor dials on the reachability verdict)', () => {
  it('skips a box the stats probe found unreachable — on the DEFAULT path, no --refresh', () => {
    expect(fleetHealthSkip(undefined, stats('dead', false))).toBe('unreachable');
  });

  it('does not skip a reachable box — it still gets its version/doctor dial', () => {
    expect(fleetHealthSkip(undefined, stats('alive', true))).toBeUndefined();
  });

  it('leaves a box with no stats (never probed) to be dialed live', () => {
    expect(fleetHealthSkip(undefined, undefined)).toBeUndefined();
  });

  it('keeps a pre-classified skip (offline/no-address) untouched', () => {
    expect(fleetHealthSkip('offline', stats('x', true))).toBe('offline');
    expect(fleetHealthSkip('no-address', undefined)).toBe('no-address');
  });

  it('an unreachable-planned target never triggers a version/doctor probe', async () => {
    const dialed: string[] = [];
    const targets = [
      { name: 'alive', skip: fleetHealthSkip(undefined, stats('alive', true)) },
      { name: 'dead', skip: fleetHealthSkip(undefined, stats('dead', false)) },
    ];
    const results = await fanOutDevices(targets, async (t) => {
      dialed.push(t.name);
      return t.name;
    });
    expect(dialed).toEqual(['alive']);
    expect(results.map((r) => [r.name, r.status, r.reason])).toEqual([
      ['alive', 'ok', undefined],
      ['dead', 'skipped', 'unreachable'],
    ]);
  });
});

describe('runFleet', () => {
  it('skips offline targets and reports per-device ok/failed', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'a' }) },
      { device: device({ name: 'b' }), skip: 'offline' },
      { device: device({ name: 'c' }) },
    ];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], {
      runner: (d) => {
        if (d.name === 'a') return { code: 0, stdout: 'ok', stderr: '' };
        return { code: 1, stdout: '', stderr: 'npm ERR' };
      },
    });
    expect(results).toEqual([
      { name: 'a', status: 'ok', code: 0, detail: undefined },
      { name: 'b', status: 'skipped', code: null, reason: 'offline' },
      { name: 'c', status: 'failed', code: 1, detail: 'npm ERR' },
    ]);
  });

  it('records a throwing device as failed and continues the rest', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'a' }) },
      { device: device({ name: 'b' }) },
      { device: device({ name: 'c' }) },
    ];
    const results = runFleet(targets, ['true'], {
      runner: (d) => {
        if (d.name === 'b') throw new Error('password auth but no secrets bundle');
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(results.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(results[1].detail).toMatch(/password auth/);
  });

  it('runs the self target locally (never ssh) so fleet update upgrades this box too', () => {
    const targets: FleetTarget[] = [
      { device: device({ name: 'zion' }) },
      { device: device({ name: 'worker' }) },
    ];
    const sshed: string[] = [];
    const localRan: string[][] = [];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], {
      self: 'zion',
      runner: (d) => { sshed.push(d.name); return { code: 0, stdout: '', stderr: '' }; },
      localRunner: (cmd) => { localRan.push(cmd); return { code: 0, stdout: '', stderr: '' }; },
    });
    expect(sshed).toEqual(['worker']);
    expect(localRan).toEqual([['agents', 'upgrade', '--yes']]);
    expect(results.map((r) => [r.name, r.status])).toEqual([['zion', 'ok'], ['worker', 'ok']]);
  });

  it('a failing local self upgrade is reported as failed, not swallowed', () => {
    const targets: FleetTarget[] = [{ device: device({ name: 'zion' }) }];
    const results = runFleet(targets, ['agents', 'upgrade', '--yes'], {
      self: 'zion',
      localRunner: () => ({ code: 1, stdout: '', stderr: 'network down' }),
    });
    expect(results).toEqual([{ name: 'zion', status: 'failed', code: 1, detail: 'network down' }]);
  });
});

describe('fanOutDevices', () => {
  it('runs targets concurrently while preserving input order', async () => {
    const started: string[] = [];
    const results = await fanOutDevices(
      [{ name: 'slow' }, { name: 'fast' }],
      async (target) => {
        started.push(target.name);
        if (target.name === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
        return `${target.name}-ok`;
      },
    );

    expect(started).toEqual(['slow', 'fast']);
    expect(results.map((r) => [r.name, r.status, r.value])).toEqual([
      ['slow', 'ok', 'slow-ok'],
      ['fast', 'ok', 'fast-ok'],
    ]);
  });

  it('records skipped and failed devices without aborting the fan-out', async () => {
    const results = await fanOutDevices(
      [{ name: 'a' }, { name: 'b', skip: 'offline' }, { name: 'c' }],
      async (target) => {
        if (target.name === 'c') throw new Error('timed out');
        return target.name;
      },
    );

    expect(results).toEqual([
      { name: 'a', status: 'ok', value: 'a' },
      { name: 'b', status: 'skipped', reason: 'offline' },
      { name: 'c', status: 'failed', error: 'timed out' },
    ]);
  });

  it('per-device timeout: a probe slower than perDeviceTimeoutMs is recorded as failed', async () => {
    const results = await fanOutDevices(
      [{ name: 'fast' }, { name: 'slow' }],
      async (target) => {
        if (target.name === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return `${target.name}-ok`;
      },
      { perDeviceTimeoutMs: 50 },
    );

    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['fast', 'ok'],
      ['slow', 'failed'],
    ]);
    expect(results[1].error).toBe('timed out');
  }, 2000);

  it('per-device timeout: a probe that finishes within the budget is not affected', async () => {
    const results = await fanOutDevices(
      [{ name: 'quick' }],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'done';
      },
      { perDeviceTimeoutMs: 200 },
    );

    expect(results).toEqual([{ name: 'quick', status: 'ok', value: 'done' }]);
  }, 2000);

  it('per-device timeout: skipped devices are not subject to the probe timeout', async () => {
    const results = await fanOutDevices(
      [{ name: 'gone', skip: 'offline' }],
      async () => {
        throw new Error('probe was called for a skipped device');
      },
      { perDeviceTimeoutMs: 10 },
    );

    expect(results).toEqual([{ name: 'gone', status: 'skipped', reason: 'offline' }]);
  });
});

describe('upgradeCommand', () => {
  it('defaults to latest with --yes', () => {
    expect(upgradeCommand()).toEqual(['agents', 'upgrade', '--yes']);
    expect(upgradeCommand('1.20.62')).toEqual(['agents', 'upgrade', '1.20.62', '--yes']);
    expect(upgradeCommand('latest')).toEqual(['agents', 'upgrade', 'latest', '--yes']);
  });

  it('rejects shell metacharacters in the version pin', () => {
    expect(() => upgradeCommand('1.0.0; curl evil')).toThrow(/Invalid version/);
    expect(() => upgradeCommand('$(reboot)')).toThrow(/Invalid version/);
    expect(() => upgradeCommand('1.0.0 && true')).toThrow(/Invalid version/);
  });
});

describe('skipLabel', () => {
  it('labels each reason', () => {
    expect(skipLabel('offline')).toBe('offline');
    expect(skipLabel('no-address')).toBe('no address');
  });
});
