import { describe, expect, it, vi } from 'vitest';
import { resolveWorkerDevice, formatNoWorkerError, type WorkerExclusion } from './worker-pick.js';
import type { DevicePlacementSignal } from '../teams/scheduler.js';

const probeFrom = (table: Record<string, DevicePlacementSignal>) =>
  async (pool: string[]) =>
    new Map(pool.filter((k) => k in table).map((k) => [k, table[k]]));

const healthy = (loadPercent: number): DevicePlacementSignal =>
  ({ reachable: true, headroom: 'idle', loadPercent });

describe('resolveWorkerDevice', () => {
  it('picks the least-loaded reachable worker', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b', 'worker-c'],
      localMachine: 'laptop',
      probe: probeFrom({
        'worker-a': healthy(60),
        'worker-b': healthy(4),
        'worker-c': healthy(31),
      }),
    });
    expect(plan.device).toBe('worker-b');
    expect(plan.isLocal).toBe(false);
  });

  it('drops an unreachable box and says so, rather than picking it', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b'],
      localMachine: 'laptop',
      probe: probeFrom({ 'worker-a': { reachable: false, loadPercent: 1 }, 'worker-b': healthy(70) }),
    });
    expect(plan.device).toBe('worker-b');
    expect(plan.excluded).toContainEqual<WorkerExclusion>({ device: 'worker-a', reason: 'unreachable' });
  });

  it('reports a timed-out probe as a timeout, not as unreachable (PHNX-3682)', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b'],
      localMachine: 'laptop',
      probe: probeFrom({
        'worker-a': { reachable: false, timedOut: true, loadPercent: 1 },
        'worker-b': healthy(70),
      }),
    });
    expect(plan.device).toBe('worker-b');
    expect(plan.excluded).toContainEqual<WorkerExclusion>({ device: 'worker-a', reason: 'probe timed out' });
  });

  it('drops a saturated box even when it answers the probe', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b'],
      localMachine: 'laptop',
      probe: probeFrom({
        'worker-a': { reachable: true, headroom: 'loaded', loadPercent: 2 },
        'worker-b': healthy(55),
      }),
    });
    expect(plan.device).toBe('worker-b');
    expect(plan.excluded).toContainEqual<WorkerExclusion>({ device: 'worker-a', reason: 'overloaded' });
  });

  it('throws instead of degrading when every candidate is excluded', async () => {
    await expect(resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b'],
      localMachine: 'laptop',
      probe: probeFrom({
        'worker-a': { reachable: false },
        'worker-b': { reachable: true, headroom: 'loaded' },
      }),
    })).rejects.toThrow(/no worker device is available/);
  });

  it('names every exclusion and its reason in the failure', async () => {
    const err = await resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b'],
      localMachine: 'laptop',
      probe: probeFrom({
        'worker-a': { reachable: false },
        'worker-b': { reachable: true, headroom: 'loaded' },
      }),
    }).catch((e: Error) => e.message);
    expect(err).toContain('worker-a (unreachable)');
    expect(err).toContain('worker-b (overloaded)');
  });

  it('reports isLocal when the pick is this machine', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a'],
      localMachine: 'worker-a',
      probe: probeFrom({ 'worker-a': healthy(3) }),
    });
    expect(plan.device).toBe('worker-a');
    expect(plan.isLocal).toBe(true);
  });

  it('returns every candidate with its load, not just the winner', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a', 'worker-b'],
      localMachine: 'laptop',
      probe: probeFrom({ 'worker-a': healthy(12), 'worker-b': healthy(80) }),
    });
    expect(plan.candidates.map((c) => c.device).sort()).toEqual(['laptop', 'worker-a', 'worker-b']);
    expect(plan.candidates.find((c) => c.device === 'worker-b')?.loadPercent).toBe(80);
  });

  it('adds the local box to the pool only when no role excludes it', async () => {
    const plan = await resolveWorkerDevice({
      eligibleHosts: ['worker-a'],
      localMachine: 'laptop',
      probe: probeFrom({ 'laptop': healthy(2), 'worker-a': healthy(90) }),
    });
    expect(plan.device).toBe('laptop');
    expect(plan.isLocal).toBe(true);
  });
});

describe('formatNoWorkerError', () => {
  it('names the allowed platforms so a windows-only fleet reads as such', () => {
    const msg = formatNoWorkerError(
      [{ device: 'win-mini', reason: 'wrong-platform' }],
      new Set(['linux', 'macos']),
    );
    expect(msg).toContain('platforms: linux, macos');
    expect(msg).toContain('win-mini (wrong-platform)');
  });

  it('says "none" rather than an empty list when nothing was excluded', () => {
    expect(formatNoWorkerError([], new Set(['linux']))).toContain('excluded: none');
  });
});
