/**
 * auth-sync's credential-push freshness gate (PHNX-4051), which reads the
 * usage-sync exchange's freshness (`readLastSuccessfulExchangeMs`, now the
 * newest peer `receivedAt` the SSH exchange stamped — PHNX-4116) and skips the
 * peer-state-dependent pushes when that exchange is missing or older than one
 * usage-sync tick. PR 5 of PHNX-4116 moves the gate onto per-peer `receivedAt`.
 *
 * These tests drive the real `AuthSyncService.tick()` (BasePeriodicService,
 * deadline + health path included) with the leaf collaborators mocked, so they
 * assert the gate's decision without a live ~/.agents. The exchange itself is
 * covered end to end by the real CLI in usage-ingest.e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonContext } from './service.js';

const mocks = vi.hoisted(() => ({
  reconcileSlots: vi.fn(),
  syncAuthBundle: vi.fn(),
  syncStores: vi.fn(),
  readLastExchange: vi.fn(),
}));

vi.mock('../accounting/usage-sync.js', () => ({
  USAGE_SYNC_INTERVAL_MS: 15 * 60_000,
}));
vi.mock('../secrets-policy.js', () => ({
  reconcileLocalWorkerSlots: mocks.reconcileSlots,
  syncReservedAuthBundle: mocks.syncAuthBundle,
  syncReservedStores: mocks.syncStores,
}));
vi.mock('../fleet-shared-repo-sync.js', () => ({
  readLastSuccessfulExchangeMs: mocks.readLastExchange,
}));

// Imported after the mocks are registered.
const { USAGE_SYNC_TICK_MS } = await import('./usage-sync-service.js');
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
  mocks.reconcileSlots.mockReturnValue({ provisioned: [], errors: [], skipped: [] });
  mocks.syncAuthBundle.mockResolvedValue({ pushed: [], errors: [] });
  mocks.syncStores.mockResolvedValue({ adopted: [], pushed: [], errors: [] });
  // Default: the usage-sync exchange completed just now, so auth-sync's pushes
  // read fresh peer state. Individual tests override this to exercise the gate.
  mocks.readLastExchange.mockReturnValue(Date.now());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('auth-sync credential-push freshness gate (PHNX-4051)', () => {
  it('the auth-sync tick only reconciles slots and pushes credentials — no transport of its own', async () => {
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    expect(mocks.syncAuthBundle).toHaveBeenCalledTimes(1);
    expect(mocks.syncStores).toHaveBeenCalledTimes(1);
  });

  it('the credential pushes run off a FRESH prior exchange, with none in this tick', async () => {
    mocks.readLastExchange.mockReturnValue(Date.now() - 60_000); // 1 min ago, well within a tick
    mocks.syncAuthBundle.mockResolvedValue({ pushed: ['worker-b'], errors: [] });
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.syncAuthBundle).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /pushed auth to worker-b/.test(l))).toBe(true);
  });

  it('normal path: pushes when the usage-sync exchange completed within one tick interval', async () => {
    mocks.readLastExchange.mockReturnValue(Date.now() - 5 * 60_000); // 5 min ago (< 15-min interval)
    await new AuthSyncService().tick(makeCtx(), signal());

    // The slot reconcile always runs; the freshness gate lets the pushes through.
    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    expect(mocks.syncAuthBundle).toHaveBeenCalledTimes(1);
    expect(mocks.syncStores).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /skipping credential push/.test(l))).toBe(false);
  });

  it('skip-and-warn: no marker (exchange never completed) skips the pushes and WARNs', async () => {
    mocks.readLastExchange.mockReturnValue(null);
    await new AuthSyncService().tick(makeCtx(), signal());

    // Slot reconcile still runs — it reads only local durable keys, not peer verdicts.
    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    // The peer-state-dependent pushes are skipped because the delivered state is stale.
    expect(mocks.syncAuthBundle).not.toHaveBeenCalled();
    expect(mocks.syncStores).not.toHaveBeenCalled();
    expect(logs.some((l) => /WARN auth-sync: skipping credential push .* never completed/.test(l))).toBe(true);
  });

  it('skip-and-warn: a stale exchange older than one tick interval skips the pushes and WARNs', async () => {
    mocks.readLastExchange.mockReturnValue(Date.now() - 30 * 60_000); // 30 min ago (> 15-min interval)
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    expect(mocks.syncAuthBundle).not.toHaveBeenCalled();
    expect(mocks.syncStores).not.toHaveBeenCalled();
    expect(logs.some((l) => /WARN auth-sync: skipping credential push .* last completed \d+s ago/.test(l))).toBe(true);
  });

  it('the gate threshold is USAGE_SYNC_TICK_MS (the producer cadence), not auth-sync\'s own interval', async () => {
    // A marker older than the usage-sync cadence but younger than a hypothetically
    // larger AUTH_SYNC_TICK_MS is STILL stale: the delivered peer verdicts are
    // refreshed once per usage-sync exchange, so the gate must key on that cadence.
    // Sitting just past USAGE_SYNC_TICK_MS proves the threshold is the producer's,
    // and the WARN echoes that same interval back rather than auth-sync's literal.
    mocks.readLastExchange.mockReturnValue(Date.now() - (USAGE_SYNC_TICK_MS + 60_000));
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.syncAuthBundle).not.toHaveBeenCalled();
    expect(mocks.syncStores).not.toHaveBeenCalled();
    const needWithin = Math.round(USAGE_SYNC_TICK_MS / 1000);
    expect(logs.some((l) => l.includes(`need one within ${needWithin}s`))).toBe(true);
  });
});
