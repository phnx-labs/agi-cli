import { describe, it, expect, beforeAll } from 'vitest';
import { upsertDevice } from '../devices/registry.js';
import {
  PLACEMENT_SNAPSHOT_MAX_AGE_MS,
  readPlacementSnapshot,
  writePlacementSnapshot,
  type PlacementSnapshot,
  type ReadyProbeEntry,
} from '../devices/stats-cache.js';
import type { DeviceStats } from '../devices/health.js';
import {
  confirmPlacementTarget,
  mergePlacementSignal,
  probePoolSignals,
  refreshPlacementSnapshot,
  snapshotSignal,
} from './placement-probe.js';
import { resolveDeviceAuto } from '../smart-launch.js';

const readyView = JSON.stringify([
  { agent: 'claude', runReady: { ready: true, reason: 'ready', accounts: [{ ready: true, reason: 'ready' }] }, versions: [{ version: '2.1.261' }] },
  { agent: 'codex', runReady: { ready: false, reason: 'all signed_out', accounts: [{ ready: false, reason: 'signed_out' }] }, versions: [{ version: '0.50.0' }] },
]);

function stats(host: string, fetchedAt: number): DeviceStats {
  return { host, reachable: true, loadPercent: 10, memPercent: 20, ncpu: 4, memTotalBytes: 16 * 1024 ** 3, memFreeBytes: 8 * 1024 ** 3, diskTotalBytes: 256 * 1024 ** 3, diskFreeBytes: 128 * 1024 ** 3, diskUsedPercent: 50, fetchedAt };
}

function probe(fetchedAt: number, over: Partial<ReadyProbeEntry> = {}): ReadyProbeEntry {
  return { answered: true, version: '1.23.38', view: readyView, fetchedAt, ...over };
}

function snapshot(name: string, statsAt: number, probeAt: number, over: Partial<ReadyProbeEntry> = {}): PlacementSnapshot {
  return { stats: { [name]: stats(name, statsAt) }, readiness: { [name]: probe(probeAt, over) } };
}

describe('snapshotSignal — when a persisted placement snapshot is fresh enough to skip the probe', () => {
  const now = 10 * PLACEMENT_SNAPSHOT_MAX_AGE_MS;

  it('serves a fresh device from the snapshot with the account gate read from its view', () => {
    const claude = snapshotSignal(snapshot('m5', now - 1_000, now - 1_000), 'm5', 'claude', now);
    expect(claude).toMatchObject({ reachable: true, installed: true, signedIn: true, pickerEligible: true, fromSnapshot: true });
    const codex = snapshotSignal(snapshot('m5', now - 1_000, now - 1_000), 'm5', 'codex', now);
    expect(codex).toMatchObject({ installed: true, signedIn: false, pickerEligible: true, reason: 'all signed_out' });
  });

  it('accepts an entry exactly at the max age and refuses one a millisecond older', () => {
    const edge = now - PLACEMENT_SNAPSHOT_MAX_AGE_MS;
    expect(snapshotSignal(snapshot('m5', edge, edge), 'm5', 'claude', now)).toBeDefined();
    expect(snapshotSignal(snapshot('m5', edge - 1, now), 'm5', 'claude', now)).toBeUndefined();
    expect(snapshotSignal(snapshot('m5', now, edge - 1), 'm5', 'claude', now)).toBeUndefined();
  });

  it('needs only fresh stats when no harness is asked for', () => {
    const snap: PlacementSnapshot = { stats: { m5: stats('m5', now) }, readiness: {} };
    expect(snapshotSignal(snap, 'm5', undefined, now)).toMatchObject({ reachable: true, fromSnapshot: true });
    expect(snapshotSignal(snap, 'm5', 'claude', now)).toBeUndefined();
  });

  it('reads a box without agents-cli or without the harness as not installed', () => {
    expect(snapshotSignal(snapshot('m5', now, now, { version: null }), 'm5', 'claude', now))
      .toMatchObject({ installed: false, signedIn: false });
    expect(snapshotSignal(snapshot('m5', now, now), 'm5', 'grok', now)).toMatchObject({ installed: false });
  });

  it('keeps an unanswered readiness probe unanswered instead of inventing a verdict', () => {
    const signal = snapshotSignal(snapshot('m5', now, now, { answered: false, timedOut: true, version: null, view: '' }), 'm5', 'claude', now);
    expect(signal).toMatchObject({ reachable: true, timedOut: true, installed: undefined, signedIn: undefined });
  });
});

describe('probePoolSignals over the persisted snapshot', () => {
  beforeAll(async () => {
    await upsertDevice('snap-box', {
      platform: 'linux',
      user: 'someone',
      address: { via: 'tailscale', dnsName: 'snap-box.probe-must-fail.invalid' },
      auth: { method: 'key' },
    });
  });

  it('a pool of unregistered devices yields an empty signal map (no probe)', async () => {
    const signals = await probePoolSignals(['no-such-device-xyz', 'also-not-real-abc'], 'claude', { now: 1_000 });
    expect(signals.size).toBe(0);
  });

  it('serves a fresh snapshot without dialing the device', async () => {
    const now = Date.now();
    writePlacementSnapshot(snapshot('snap-box', now, now));
    const started = Date.now();
    const signals = await probePoolSignals(['snap-box'], 'claude', { now });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signals.get('snap-box')).toMatchObject({ reachable: true, signedIn: true, fromSnapshot: true });
  });

  it('only --device auto placement arms the background refresh', async () => {
    writePlacementSnapshot({ demandAt: 1 });
    await probePoolSignals(['snap-box'], 'claude');
    expect(readPlacementSnapshot().demandAt).toBe(1);
    const now = Date.now();
    writePlacementSnapshot(snapshot('snap-box', now, now));
    const plan = await resolveDeviceAuto('claude', { localMachine: 'local', eligibleHosts: ['snap-box'], confirm: async () => true });
    expect(plan.host).toBe('snap-box');
    expect(readPlacementSnapshot().demandAt).toBeGreaterThanOrEqual(now);
  });

  it('probes live when the snapshot is stale and persists what it found', async () => {
    const now = Date.now();
    const stale = now - PLACEMENT_SNAPSHOT_MAX_AGE_MS - 1;
    writePlacementSnapshot(snapshot('snap-box', stale, stale));
    const signals = await probePoolSignals(['snap-box'], 'claude', { now });
    expect(signals.get('snap-box')?.fromSnapshot).toBeUndefined();
    expect(signals.get('snap-box')?.reachable).toBe(false);
    const persisted = readPlacementSnapshot();
    expect(persisted.readiness['snap-box']).toMatchObject({ answered: false });
    expect(persisted.readiness['snap-box'].fetchedAt).toBeGreaterThanOrEqual(now);
    expect(persisted.stats['snap-box']).toMatchObject({ reachable: false });
  });

  it('force skips a fresh snapshot', async () => {
    const now = Date.now();
    writePlacementSnapshot(snapshot('snap-box', now, now));
    const signals = await probePoolSignals(['snap-box'], 'claude', { now, force: true });
    expect(signals.get('snap-box')?.reachable).toBe(false);
  });

  it('the background refresh runs only while placement was asked for recently', async () => {
    writePlacementSnapshot({ demandAt: 1 });
    expect(await refreshPlacementSnapshot(['snap-box'])).toBeNull();
    writePlacementSnapshot({ demandAt: Date.now() });
    expect(await refreshPlacementSnapshot(['snap-box'])).toBe(1);
  });

  it('a snapshot pick that no longer answers is marked so the next launch skips it', async () => {
    const now = Date.now();
    writePlacementSnapshot(snapshot('snap-box', now, now));
    expect(await confirmPlacementTarget('snap-box')).toBe(false);
    expect(snapshotSignal(readPlacementSnapshot(), 'snap-box', 'claude', Date.now())).toMatchObject({ installed: undefined, timedOut: true });
  });
});

describe('mergePlacementSignal', () => {
  const timedOutStats = { host: 'm6', reachable: false, timedOut: true, fetchedAt: 0 };
  const ready = { answered: true, installed: true, signedIn: true, pickerEligible: true };

  it('a host that answered the ready probe is reachable even when its stats probe timed out', () => {
    const signal = mergePlacementSignal(timedOutStats, ready);
    expect(signal.reachable).toBe(true);
    expect(signal.timedOut).toBeUndefined();
    expect(signal.headroom).toBe('unknown');
    expect(signal.signedIn).toBe(true);
  });

  it('carries a timed-out ready probe on a reachable host and the box reason', () => {
    const reachableStats = { host: 'm5', reachable: true, fetchedAt: 0 };
    const unanswered = { answered: false, installed: undefined, signedIn: undefined, pickerEligible: undefined, timedOut: true };
    expect(mergePlacementSignal(reachableStats, unanswered)).toMatchObject({ reachable: true, timedOut: true, installed: undefined });
    const refused = { answered: true, installed: true, signedIn: false, pickerEligible: false, reason: 'all signed_out' };
    expect(mergePlacementSignal(reachableStats, refused).reason).toBe('all signed_out');
  });

  it('keeps the stats timeout when the ready probe also got no answer', () => {
    const signal = mergePlacementSignal(timedOutStats, {
      answered: false, installed: undefined, signedIn: undefined, pickerEligible: undefined,
    });
    expect(signal.reachable).toBe(false);
    expect(signal.timedOut).toBe(true);
  });
});
