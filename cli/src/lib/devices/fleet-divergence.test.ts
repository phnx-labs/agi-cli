import { describe, expect, it } from 'vitest';
import {
  compareFleetInventories,
  FLEET_RESOURCE_KINDS,
  type DeviceInventory,
  type FleetInventory,
  type FleetResourceKind,
  type RepoState,
} from './fleet-divergence.js';

function inventory(overrides: {
  resources?: Partial<Record<FleetResourceKind, string[]>>;
  agentVersions?: Record<string, string[]>;
  repos?: { agents?: RepoState | null; system?: RepoState | null };
} = {}): FleetInventory {
  const resources = {} as Record<FleetResourceKind, string[]>;
  for (const kind of FLEET_RESOURCE_KINDS) resources[kind] = overrides.resources?.[kind] ?? [];
  return {
    resources,
    agentVersions: overrides.agentVersions ?? {},
    repos: {
      agents: overrides.repos?.agents ?? null,
      system: overrides.repos?.system ?? null,
    },
  };
}

const repo = (over: Partial<RepoState> = {}): RepoState => ({
  branch: over.branch ?? 'main',
  head: over.head ?? 'aaaaaaaa',
  dirty: over.dirty ?? false,
});

describe('compareFleetInventories', () => {
  it('flags a plugin present locally but missing on a remote device', () => {
    const devices: DeviceInventory[] = [
      { name: 'zion', inventory: inventory({ resources: { plugins: ['swarm', 'rush'] } }) },
      { name: 'yosemite-s0', inventory: inventory({ resources: { plugins: ['rush'] } }) },
    ];
    const report = compareFleetInventories(devices, 'zion');

    expect(report.hasDivergence).toBe(true);
    const swarmMiss = report.divergences.find((d) => d.name === 'swarm');
    expect(swarmMiss).toBeDefined();
    expect(swarmMiss!.kind).toBe('resource-missing-remote');
    expect(swarmMiss!.device).toBe('yosemite-s0');
    expect(swarmMiss!.category).toBe('plugins');
    expect(swarmMiss!.message).toContain("yosemite-s0 is missing plugin 'swarm'");
    expect(swarmMiss!.message).toContain('present on zion');
    expect(report.divergences.some((d) => d.name === 'rush')).toBe(false);
    expect(report.comparedDevices).toEqual(['yosemite-s0']);
    expect(report.skippedDevices).toEqual([]);
  });

  it('flags a resource present on a remote but missing on the local baseline (reverse direction)', () => {
    const devices: DeviceInventory[] = [
      { name: 'zion', inventory: inventory({ resources: { skills: ['audit'] } }) },
      { name: 'mac-mini', inventory: inventory({ resources: { skills: ['audit', 'pitch'] } }) },
    ];
    const report = compareFleetInventories(devices, 'zion');

    const pitch = report.divergences.find((d) => d.name === 'pitch');
    expect(pitch).toBeDefined();
    expect(pitch!.kind).toBe('resource-missing-local');
    expect(pitch!.category).toBe('skills');
    expect(pitch!.message).toContain("zion is missing skill 'pitch'");
    expect(pitch!.message).toContain('present on mac-mini');
  });

  it('flags an agent version installed locally but missing on a remote', () => {
    const devices: DeviceInventory[] = [
      { name: 'zion', inventory: inventory({ agentVersions: { claude: ['2.1.170', '2.1.220'] } }) },
      { name: 'yosemite-s0', inventory: inventory({ agentVersions: { claude: ['2.1.170'] } }) },
    ];
    const report = compareFleetInventories(devices, 'zion');

    const gap = report.divergences.find((d) => d.kind === 'agent-version-missing-remote');
    expect(gap).toBeDefined();
    expect(gap!.category).toBe('claude');
    expect(gap!.name).toBe('2.1.220');
    expect(gap!.message).toContain('yosemite-s0 is missing claude@2.1.220');
    expect(gap!.message).toContain('installed on zion');
  });

  it('flags a diverged .agents repo HEAD, branch, and remote-only dirty tree', () => {
    const local = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'main', dirty: false }) } });
    const remoteHead = inventory({ repos: { agents: repo({ head: 'bbbbbbbb' }) } });
    let report = compareFleetInventories(
      [{ name: 'zion', inventory: local }, { name: 'box', inventory: remoteHead }],
      'zion',
    );
    let drift = report.divergences.find((d) => d.kind === 'repo-drift');
    expect(drift?.message).toContain('.agents repo diverged');
    expect(drift?.message).toContain('HEAD bbbbbbbb != local aaaaaaaa');

    const remoteBranch = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'feature' }) } });
    report = compareFleetInventories(
      [{ name: 'zion', inventory: local }, { name: 'box', inventory: remoteBranch }],
      'zion',
    );
    drift = report.divergences.find((d) => d.kind === 'repo-drift');
    expect(drift?.message).toContain('branch feature != local main');

    const remoteDirty = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'main', dirty: true }) } });
    report = compareFleetInventories(
      [{ name: 'zion', inventory: local }, { name: 'box', inventory: remoteDirty }],
      'zion',
    );
    drift = report.divergences.find((d) => d.kind === 'repo-drift');
    expect(drift?.message).toContain('box .agents tree has uncommitted changes');

    const cleanRemote = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'main', dirty: false }) } });
    const dirtyLocal = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'main', dirty: true }) } });
    report = compareFleetInventories(
      [{ name: 'zion', inventory: dirtyLocal }, { name: 'box', inventory: cleanRemote }],
      'zion',
    );
    const localDrift = report.divergences.filter((d) => d.kind === 'repo-drift');
    expect(localDrift).toHaveLength(1);
    expect(localDrift[0].device).toBe('zion');
    expect(localDrift[0].message).toBe('zion .agents tree has uncommitted changes');
  });

  it('a dirty LOCAL tree is one finding, not one per remote it was compared against', () => {
    const clean = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'main', dirty: false }) } });
    const dirtyLocal = inventory({ repos: { agents: repo({ head: 'aaaaaaaa', branch: 'main', dirty: true }) } });
    const report = compareFleetInventories(
      [
        { name: 'zion', inventory: dirtyLocal },
        { name: 'box1', inventory: clean },
        { name: 'box2', inventory: clean },
        { name: 'box3', inventory: clean },
      ],
      'zion',
    );
    const drifts = report.divergences.filter((d) => d.kind === 'repo-drift');
    expect(drifts).toHaveLength(1);
    expect(drifts[0].device).toBe('zion');
  });

  it('reports no divergence when a compared device matches the baseline exactly', () => {
    const inv = inventory({
      resources: { plugins: ['swarm'], skills: ['audit'] },
      agentVersions: { claude: ['2.1.220'] },
      repos: { agents: repo(), system: repo({ head: 'cccccccc' }) },
    });
    const report = compareFleetInventories(
      [{ name: 'zion', inventory: inv }, { name: 'box', inventory: inventory({
        resources: { plugins: ['swarm'], skills: ['audit'] },
        agentVersions: { claude: ['2.1.220'] },
        repos: { agents: repo(), system: repo({ head: 'cccccccc' }) },
      }) }],
      'zion',
    );
    expect(report.hasDivergence).toBe(false);
    expect(report.divergences).toEqual([]);
    expect(report.comparedDevices).toEqual(['box']);
  });

  it('skips (never false-flags) a device that reported no inventory', () => {
    const devices: DeviceInventory[] = [
      { name: 'zion', inventory: inventory({ resources: { plugins: ['swarm'] } }) },
      { name: 'offline-box', inventory: null },
    ];
    const report = compareFleetInventories(devices, 'zion');
    expect(report.divergences).toEqual([]);
    expect(report.hasDivergence).toBe(false);
    expect(report.skippedDevices).toEqual(['offline-box']);
    expect(report.comparedDevices).toEqual([]);
  });

  it('emits nothing when the local baseline itself has no inventory', () => {
    const devices: DeviceInventory[] = [
      { name: 'zion', inventory: null },
      { name: 'box', inventory: inventory({ resources: { plugins: ['swarm'] } }) },
    ];
    const report = compareFleetInventories(devices, 'zion');
    expect(report.hasDivergence).toBe(false);
    expect(report.divergences).toEqual([]);
    expect(report.skippedDevices).toEqual(['box']);
  });

  it('skips repo drift when only one side is a readable git repo', () => {
    const local = inventory({ repos: { agents: repo() } });
    const remote = inventory({ repos: { agents: null } });
    const report = compareFleetInventories(
      [{ name: 'zion', inventory: local }, { name: 'box', inventory: remote }],
      'zion',
    );
    expect(report.divergences.some((d) => d.kind === 'repo-drift')).toBe(false);
  });

  it('orders findings deterministically by device then kind then category then name', () => {
    const devices: DeviceInventory[] = [
      { name: 'zion', inventory: inventory({ resources: { plugins: ['swarm'], skills: ['audit'] } }) },
      { name: 'b-box', inventory: inventory({ resources: {} }) },
      { name: 'a-box', inventory: inventory({ resources: {} }) },
    ];
    const report = compareFleetInventories(devices, 'zion');
    const devicesInOrder = report.divergences.map((d) => d.device);
    const firstB = devicesInOrder.indexOf('b-box');
    const lastA = devicesInOrder.lastIndexOf('a-box');
    expect(lastA).toBeLessThan(firstB);
  });
});
