import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { filterAutoPool, isAutoPoolMember, listWorkerDevices, describeAutoPool, autoLaunchPreferredSet } from './pool.js';

// The pure rule (roles + mode injected) is tested directly; the stored-config path re-imports
// against a throwaway HOME to read a real agents.yaml (as device-config.test.ts does). No mocks.
// Pure calls inject `autoLaunch: {}` alongside `roles` so neither rule touches disk.

const FLEET = ['zion', 'yosemite-s0', 'yosemite-s1', 'mac-mini', 'iphone'];

describe('filterAutoPool (the allowlist rule)', () => {
  it('leaves the pool untouched when nothing is marked', () => {
    expect(filterAutoPool(FLEET, { mode: 'workers', roles: {}, autoLaunch: {} })).toEqual(FLEET);
  });

  it('narrows to the marked workers once ANY device is marked worker', () => {
    const roles = { 'yosemite-s0': 'worker', 'yosemite-s1': 'worker' } as const;
    expect(filterAutoPool(FLEET, { mode: 'workers', roles, autoLaunch: {} })).toEqual(['yosemite-s0', 'yosemite-s1']);
  });

  it('never picks a personal device, even with no worker marked', () => {
    const roles = { zion: 'personal' } as const;
    expect(filterAutoPool(FLEET, { mode: 'workers', roles, autoLaunch: {} })).toEqual(['yosemite-s0', 'yosemite-s1', 'mac-mini', 'iphone']);
  });

  it('never picks a desktop device — the headed release/credential box is off-limits too', () => {
    const roles = { 'mac-mini': 'desktop' } as const;
    expect(filterAutoPool(FLEET, { mode: 'workers', roles, autoLaunch: {} })).toEqual(['zion', 'yosemite-s0', 'yosemite-s1', 'iphone']);
  });

  it('auto.pool=all drops the worker allowlist but keeps personal AND desktop out', () => {
    const roles = { 'yosemite-s0': 'worker', zion: 'personal', 'mac-mini': 'desktop' } as const;
    expect(filterAutoPool(FLEET, { mode: 'all', roles, autoLaunch: {} })).toEqual(['yosemite-s0', 'yosemite-s1', 'iphone']);
  });

  it('drops a device the operator disabled (auto-launch.enabled = false), whatever the mode', () => {
    // `agents devices disable zion` removes it from EVERY auto path — here even
    // with no worker mark and even under auto.pool=all.
    const autoLaunch = { zion: { enabled: false } };
    expect(filterAutoPool(FLEET, { mode: 'workers', roles: {}, autoLaunch })).toEqual(['yosemite-s0', 'yosemite-s1', 'mac-mini', 'iphone']);
    expect(filterAutoPool(FLEET, { mode: 'all', roles: {}, autoLaunch })).toEqual(['yosemite-s0', 'yosemite-s1', 'mac-mini', 'iphone']);
  });

  it('a disabled worker is dropped even though it carries the worker mark', () => {
    // disable wins over the allowlist: a worker turned off is not a candidate.
    const roles = { 'yosemite-s0': 'worker', 'yosemite-s1': 'worker' } as const;
    const autoLaunch = { 'yosemite-s0': { enabled: false } };
    expect(filterAutoPool(FLEET, { mode: 'workers', roles, autoLaunch })).toEqual(['yosemite-s1']);
  });

  it('preferred does NOT narrow the pool — it only boosts ranking', () => {
    // A preference is a rank hint, never an exclusion; every device stays.
    const autoLaunch = { 'mac-mini': { preferred: true } };
    expect(filterAutoPool(FLEET, { mode: 'workers', roles: {}, autoLaunch })).toEqual(FLEET);
  });

  it('disable matches by normalized name, so an FQDN candidate is still dropped', () => {
    const autoLaunch = { zion: { enabled: false } };
    expect(filterAutoPool(['ZION', 'mac-mini'], { mode: 'workers', roles: {}, autoLaunch })).toEqual(['mac-mini']);
  });

  it('returns empty rather than widening back to the fleet when no worker is a candidate', () => {
    // Both marked workers are offline, so neither is in the candidate list. The
    // caller must fail loud; silently re-adding the laptop is the bug this pins.
    const roles = { 'yosemite-s0': 'worker', 'yosemite-s1': 'worker' } as const;
    expect(filterAutoPool(['zion', 'mac-mini'], { mode: 'workers', roles, autoLaunch: {} })).toEqual([]);
  });

  it('matches hosts by normalized name, so an FQDN candidate still resolves', () => {
    const roles = { 'yosemite-s0': 'worker' } as const;
    expect(filterAutoPool(['YOSEMITE-S0', 'zion'], { mode: 'workers', roles, autoLaunch: {} })).toEqual(['YOSEMITE-S0']);
  });

  it('isAutoPoolMember answers for one host', () => {
    const roles = { 'yosemite-s0': 'worker', zion: 'personal' } as const;
    expect(isAutoPoolMember('yosemite-s0', { mode: 'workers', roles, autoLaunch: {} })).toBe(true);
    expect(isAutoPoolMember('zion', { mode: 'workers', roles, autoLaunch: {} })).toBe(false);
    expect(isAutoPoolMember('mac-mini', { mode: 'workers', roles, autoLaunch: {} })).toBe(false);
  });

  it('isAutoPoolMember answers false for a disabled host', () => {
    const autoLaunch = { 'yosemite-s0': { enabled: false } };
    expect(isAutoPoolMember('yosemite-s0', { mode: 'all', roles: {}, autoLaunch })).toBe(false);
    expect(isAutoPoolMember('yosemite-s1', { mode: 'all', roles: {}, autoLaunch })).toBe(true);
  });

  it('describeAutoPool names the workers, and says when the mark is being ignored', () => {
    const roles = { 'yosemite-s0': 'worker', 'yosemite-s1': 'worker' } as const;
    expect(describeAutoPool({ mode: 'workers', roles })).toBe('workers: yosemite-s0, yosemite-s1');
    expect(describeAutoPool({ mode: 'all', roles })).toBe('auto.pool=all (worker marks ignored)');
    expect(describeAutoPool({ mode: 'workers', roles: {} })).toBe('');
  });

  it('listWorkerDevices returns only the worker marks', () => {
    const roles = { 'yosemite-s0': 'worker', zion: 'personal' } as const;
    expect(listWorkerDevices({ roles })).toEqual(['yosemite-s0']);
  });

  it('autoLaunchPreferredSet returns the boosted hosts, normalized', () => {
    const autoLaunch = { 'mac-mini': { preferred: true }, zion: { enabled: false } };
    const preferred = autoLaunchPreferredSet(['MAC-MINI', 'zion'], { autoLaunch });
    expect(preferred.has('mac-mini')).toBe(true);
    // A disabled-but-not-preferred device is not in the preferred set.
    expect(preferred.has('zion')).toBe(false);
    expect(preferred.size).toBe(1);
  });
});

describe('roles read from the per-device docs', () => {
  let TMP = '';

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-pool-test-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'yosemite-s0';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  async function freshPool() {
    vi.resetModules();
    const deviceConfig = await import('../device-config.js');
    const pool = await import('./pool.js');
    return { ...deviceConfig, ...pool };
  }

  it('a role written by `devices role` narrows the pool on the next read', async () => {
    const mod = await freshPool();
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    mod.setConfiguredDeviceRole('yosemite-s1', 'worker');
    mod.setConfiguredDeviceRole('zion', 'personal');

    expect(mod.listConfiguredDeviceRoles()).toEqual({
      'yosemite-s0': 'worker',
      'yosemite-s1': 'worker',
      zion: 'personal',
    });
    expect(mod.filterAutoPool(FLEET)).toEqual(['yosemite-s0', 'yosemite-s1']);

    // It lands in the per-device tracked doc — conflict-free, syncs via repo push/pull.
    const yaml = fs.readFileSync(path.join(TMP, '.agents', 'devices', 'yosemite-s0', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('role: worker');
  });

  it('clearing the mark restores the unmarked pool', async () => {
    const mod = await freshPool();
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    expect(mod.filterAutoPool(FLEET)).toEqual(['yosemite-s0']);
    mod.setConfiguredDeviceRole('yosemite-s0', undefined);
    expect(mod.configuredDeviceRole('yosemite-s0')).toBeUndefined();
    expect(mod.filterAutoPool(FLEET)).toEqual(FLEET);
  });

  it('a fleet-default role reaches every device in the pool, doc-less devices included', async () => {
    const mod = await freshPool();
    // A write creates the peer doc; keep another key so unsetting the
    // device-layer role does not delete the folder.
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    mod.setConfigValue('notes', ['keep the doc'], { device: 'yosemite-s0' });
    mod.unsetConfigValue('role', { device: 'yosemite-s0' });
    mod.setConfigValue('role', 'personal', { fleet: true });
    // The bare, doc-scan-only read still sees only the device with a doc.
    expect(mod.listConfiguredDeviceRoles()).toEqual({ 'yosemite-s0': 'personal' });
    // filterAutoPool passes its own candidate pool as the roster, so the fleet default reaches
    // every device in FLEET (none has a doc) and the whole fleet is excluded as personal.
    expect(mod.filterAutoPool(FLEET)).toEqual([]);
  });

  it('a fleet-default worker role reaches a device with no per-device doc at all', async () => {
    const mod = await freshPool();
    mod.setConfigValue('role', 'worker', { fleet: true });
    // No device in FLEET has ever had a doc written.
    expect(mod.listConfiguredDeviceRoles()).toEqual({});
    // filterAutoPool must still narrow to the whole fleet as workers — the
    // exact gap #2622's non-author review flagged as a blocker: a fleet-wide
    // worker default silently dropped a doc-less device from the allowlist.
    expect(mod.filterAutoPool(FLEET)).toEqual(FLEET);
  });

  it('describeAutoPool and listWorkerDevices reach a doc-less device via an explicit roster', async () => {
    const mod = await freshPool();
    mod.setConfigValue('role', 'worker', { fleet: true });
    // No device has ever had a doc written — the bare (no-roster) reads must
    // stay blind to the fleet default, mirroring filterAutoPool's own gap.
    expect(mod.describeAutoPool()).toBe('');
    expect(mod.listWorkerDevices()).toEqual([]);
    // Callers with a real candidate list (formatNoHealthyDeviceError has its
    // own `pool` param) pass it as the roster and the fleet default resolves.
    expect(mod.describeAutoPool({ roster: FLEET })).toBe(`workers: ${FLEET.join(', ')}`);
  });

  it('auto.pool=all widens past the worker marks', async () => {
    const mod = await freshPool();
    mod.setConfiguredDeviceRole('yosemite-s0', 'worker');
    mod.setConfigValue('auto.pool', 'all');
    expect(mod.autoPoolMode()).toBe('all');
    expect(mod.filterAutoPool(FLEET)).toEqual(FLEET);
  });

  it('rejects a role outside the vocabulary', async () => {
    const mod = await freshPool();
    expect(() => mod.setConfigValue('role', 'buildbox', { device: 'yosemite-s0' })).toThrow(/worker \| personal/);
  });

  it('refuses control — this shared config key only accepts worker | personal | desktop', async () => {
    const mod = await freshPool();
    expect(() => mod.setConfigValue('role', 'control', { device: 'iphone' })).toThrow(/worker \| personal \| desktop/);
  });

  it('accepts desktop and keeps it out of the auto pool', async () => {
    const mod = await freshPool();
    mod.setConfiguredDeviceRole('mac-mini', 'desktop');
    expect(mod.configuredDeviceRole('mac-mini')).toBe('desktop');
    // A desktop box is never an auto-placement candidate, like personal.
    expect(mod.filterAutoPool(FLEET)).toEqual(['zion', 'yosemite-s0', 'yosemite-s1', 'iphone']);
  });

  it('rejects an auto.pool mode outside the vocabulary', async () => {
    const mod = await freshPool();
    expect(() => mod.setConfigValue('auto.pool', 'some')).toThrow(/workers \| all/);
  });

  it('`devices disable` (auto-launch.enabled off) drops the box from the pool on the next read', async () => {
    // The acceptance path: `agents devices disable zion` removes zion from
    // candidates. `setAutoLaunchEnabled(false)` is exactly what the CLI verb writes.
    const mod = await freshPool();
    mod.setAutoLaunchEnabled('zion', false);
    expect(mod.isAutoLaunchEnabled('zion')).toBe(false);
    expect(mod.filterAutoPool(FLEET)).toEqual(['yosemite-s0', 'yosemite-s1', 'mac-mini', 'iphone']);
    // Re-enabling restores it.
    mod.setAutoLaunchEnabled('zion', true);
    expect(mod.filterAutoPool(FLEET)).toEqual(FLEET);
  });

  it('`devices prefer` (auto-launch.preferred on) surfaces in the preferred set, without narrowing the pool', async () => {
    // `agents devices prefer mac-mini` boosts ranking — it never drops a box.
    const mod = await freshPool();
    mod.setAutoLaunchPreferred('mac-mini', true);
    expect(mod.isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(mod.autoLaunchPreferredSet(FLEET).has('mac-mini')).toBe(true);
    expect(mod.filterAutoPool(FLEET)).toEqual(FLEET);
  });

  it('a fleet-default disable reaches a doc-less device via the candidate roster', async () => {
    const mod = await freshPool();
    mod.setConfigValue('auto-launch.enabled', false, { fleet: true });
    // No device has a doc; filterAutoPool passes its pool as the roster, so the
    // fleet-wide disable empties the whole fleet.
    expect(mod.filterAutoPool(FLEET)).toEqual([]);
  });
});
