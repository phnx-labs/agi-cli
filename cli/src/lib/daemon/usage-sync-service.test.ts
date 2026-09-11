/**
 * One git exchange per daemon tick cycle (PHNX-4051).
 *
 * auth-sync and usage-sync used to EACH call `syncFleetSharedStateRepo`, 30 s
 * apart, contending for the single `proper-lockfile` lock (20×100 ms ≈ 2 s of
 * retries) while a real fetch/rebase/push on a drifted repo runs far longer —
 * so the usage tick failed with "Lock file is already being held" and workers
 * never got a fresh usage snapshot. The fix folds the reserved-auth verdict
 * publish into the usage-sync tick and removes the exchange from auth-sync, so
 * exactly ONE caller holds the shared-repo lock per tick.
 *
 * These tests drive the real service `tick()` (BasePeriodicService, deadline +
 * health path included) with the leaf collaborators mocked, so they assert the
 * ORCHESTRATION invariant — who calls the single git committer, and in what
 * order — without a live ~/.agents. The git transport itself is covered end to
 * end against a real bare remote in fleet-shared-repo-sync.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonContext } from './service.js';

const mocks = vi.hoisted(() => ({
  publishUsage: vi.fn(),
  consumeUsage: vi.fn(),
  publishMirror: vi.fn(),
  consumeMirror: vi.fn(),
  publishProfiles: vi.fn(),
  publishAuthVerdict: vi.fn(),
  reconcileSlots: vi.fn(),
  syncAuthBundle: vi.fn(),
  syncStores: vi.fn(),
  syncRepo: vi.fn(),
}));

vi.mock('../accounting/usage-sync.js', () => ({
  publishUsageSnapshotToSharedStore: mocks.publishUsage,
  consumeUsageSnapshotsFromSharedStore: mocks.consumeUsage,
}));
vi.mock('../session/mirror.js', () => ({
  publishSessionMirrorToSharedStore: mocks.publishMirror,
  consumeSessionMirrorFromSharedStore: mocks.consumeMirror,
}));
vi.mock('../browser/profiles.js', () => ({
  publishDiscoveredProfiles: mocks.publishProfiles,
}));
vi.mock('../secrets-policy.js', () => ({
  publishReservedAuthVerdict: mocks.publishAuthVerdict,
  reconcileLocalWorkerSlots: mocks.reconcileSlots,
  syncReservedAuthBundle: mocks.syncAuthBundle,
  syncReservedStores: mocks.syncStores,
}));
vi.mock('../fleet-shared-repo-sync.js', () => ({
  syncFleetSharedStateRepo: mocks.syncRepo,
}));

// Imported after the mocks are registered.
const { UsageSyncService } = await import('./usage-sync-service.js');
const { AuthSyncService } = await import('./auth-sync-service.js');

let logs: string[] = [];
function makeCtx(): DaemonContext {
  return { log: (level, message) => { logs.push(`${level} ${message}`); } };
}
function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  logs = [];
  mocks.publishUsage.mockResolvedValue({ changed: false, error: null, path: 'devices/self/daemon-state.json' });
  mocks.consumeUsage.mockReturnValue({ merged: 0, sources: [], errors: [] });
  mocks.publishMirror.mockResolvedValue({ changed: false, count: 0, error: null });
  mocks.consumeMirror.mockReturnValue({ merged: 0, pruned: 0, sources: [], errors: [] });
  mocks.publishProfiles.mockResolvedValue({ published: [], errors: {} });
  mocks.publishAuthVerdict.mockResolvedValue({ error: null });
  mocks.reconcileSlots.mockReturnValue({ provisioned: [], errors: [], skipped: [] });
  mocks.syncAuthBundle.mockResolvedValue({ pushed: [], errors: [] });
  mocks.syncStores.mockResolvedValue({ adopted: [], pushed: [], errors: [] });
  mocks.syncRepo.mockResolvedValue({
    success: true, committed: true, pushed: true, commit: 'abc12345',
    timedOut: false, skipped: null, error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('one shared-repo committer per tick (PHNX-4051)', () => {
  it('the usage-sync tick publishes the auth verdict AND runs the git exchange, in that order', async () => {
    await new UsageSyncService().tick(makeCtx(), signal());

    expect(mocks.publishAuthVerdict).toHaveBeenCalledTimes(1);
    expect(mocks.syncRepo).toHaveBeenCalledTimes(1);
    // The verdict is a conflict-free field that must ride the exchange, so it
    // publishes BEFORE the commit/push, not after.
    expect(mocks.publishAuthVerdict.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.syncRepo.mock.invocationCallOrder[0]);
  });

  it('the auth-sync tick runs NO git exchange — it only reconciles slots and pushes credentials', async () => {
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.syncRepo).not.toHaveBeenCalled();
    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    expect(mocks.syncAuthBundle).toHaveBeenCalledTimes(1);
    expect(mocks.syncStores).toHaveBeenCalledTimes(1);
  });

  it('both services firing inside one interval hold the shared-repo lock exactly once', async () => {
    // Model the two ticks the supervisor fires within one 15-min interval.
    await new UsageSyncService().tick(makeCtx(), signal());
    await new AuthSyncService().tick(makeCtx(), signal());

    // Exactly one exchange means the lock is never contended between the two
    // services, so the "Lock file is already being held" failure cannot occur.
    expect(mocks.syncRepo).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /Lock file is already being held/.test(l))).toBe(false);
  });

  it('the credential pushes run even when this tick did not just complete an exchange', async () => {
    // Regression against gating the pushes on an in-tick transport.success: they
    // now act on the peer state the usage-sync exchange last delivered.
    mocks.syncAuthBundle.mockResolvedValue({ pushed: ['worker-b'], errors: [] });
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.syncAuthBundle).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /pushed auth to worker-b/.test(l))).toBe(true);
  });
});
