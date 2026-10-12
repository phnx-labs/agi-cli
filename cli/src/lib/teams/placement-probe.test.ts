import { describe, it, expect, beforeEach } from 'vitest';
import { probePoolSignals, clearPlacementSignalCache, mergePlacementSignal, SIGNAL_TTL_MS } from './placement-probe.js';

describe('probePoolSignals — degrade + cache', () => {
  beforeEach(() => clearPlacementSignalCache());

  it('a pool of unregistered devices yields an empty signal map (no probe)', async () => {
    const signals = await probePoolSignals(['no-such-device-xyz', 'also-not-real-abc'], 'claude', {
      now: 1_000,
    });
    expect(signals.size).toBe(0);
  });

  it('reuses the cached snapshot within the TTL, refreshes after it', async () => {
    const pool = ['no-such-device-xyz'];
    const first = await probePoolSignals(pool, 'claude', { now: 1_000 });
    const withinTtl = await probePoolSignals(pool, 'claude', { now: 1_000 + SIGNAL_TTL_MS - 1 });
    expect(withinTtl).toBe(first);
    const afterTtl = await probePoolSignals(pool, 'claude', { now: 1_000 + SIGNAL_TTL_MS + 1 });
    expect(afterTtl).not.toBe(first);
  });

  it('force bypasses the cache', async () => {
    const pool = ['no-such-device-xyz'];
    const first = await probePoolSignals(pool, 'claude', { now: 2_000 });
    const forced = await probePoolSignals(pool, 'claude', { now: 2_000, force: true });
    expect(forced).not.toBe(first);
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

  it('keeps the stats timeout when the ready probe also got no answer', () => {
    const signal = mergePlacementSignal(timedOutStats, {
      answered: false, installed: undefined, signedIn: undefined, pickerEligible: undefined,
    });
    expect(signal.reachable).toBe(false);
    expect(signal.timedOut).toBe(true);
  });
});
