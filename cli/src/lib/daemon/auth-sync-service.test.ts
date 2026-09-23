/**
 * The auth-sync tick's non-git duties (PHNX-4116 PR 5). This service no longer
 * gates its credential pushes on a fleet-wide exchange-freshness marker: the old
 * `readLastSuccessfulExchangeMs` gate that skipped EVERY push when the newest
 * exchange across the fleet went stale is gone. Each tick now reconciles worker
 * slots and runs both push arms unconditionally; the arms plan per peer off that
 * peer's OWN first-hand daemon-state reply, and a peer that has never replied is
 * surfaced at INFO, not WARN.
 *
 * These tests drive the real `AuthSyncService.tick()` (BasePeriodicService,
 * deadline + health path included) with the leaf collaborators mocked, so they
 * assert the tick's orchestration without a live ~/.agents. The per-peer planning
 * itself is unit-tested in `secrets-policy.test.ts`, and the exchange end to end
 * in `usage-ingest.e2e.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonContext } from './service.js';

const mocks = vi.hoisted(() => ({
  reconcileSlots: vi.fn(),
  syncAuthBundle: vi.fn(),
  syncStores: vi.fn(),
}));

vi.mock('../secrets-policy.js', () => ({
  reconcileLocalWorkerSlots: mocks.reconcileSlots,
  syncReservedAuthBundle: mocks.syncAuthBundle,
  syncReservedStores: mocks.syncStores,
  SKIP_REASON_NO_PEER_REPLY: 'no daemon-state reply from this peer yet',
  SKIP_REASON_NO_ACCOUNT_ROWS: 'daemon-state reply carries no account rows (fail closed)',
}));

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
  mocks.syncAuthBundle.mockResolvedValue({ pushed: [], skipped: [], errors: [] });
  mocks.syncStores.mockResolvedValue({ adopted: [], pushed: [], skipped: [], errors: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('auth-sync tick (PHNX-4116 PR 5 — no fleet-wide freshness gate)', () => {
  it('every tick reconciles slots and runs BOTH push arms, unconditionally', async () => {
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    expect(mocks.syncAuthBundle).toHaveBeenCalledTimes(1);
    expect(mocks.syncStores).toHaveBeenCalledTimes(1);
    // No fleet-wide freshness gate: the happy path never logs a WARN, and both
    // push arms ran (asserted above) rather than being short-circuited.
    expect(logs.every((l) => l.startsWith('INFO'))).toBe(true);
  });

  it('reports what each arm pushed', async () => {
    mocks.syncAuthBundle.mockResolvedValue({ pushed: ['worker-b'], skipped: [], errors: [] });
    mocks.syncStores.mockResolvedValue({ adopted: [], pushed: [{ device: 'worker-b', bundle: '__claude__', keys: ['K1'] }], skipped: [], errors: [] });
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(logs.some((l) => /INFO auth-sync: pushed auth to worker-b/.test(l))).toBe(true);
    expect(logs.some((l) => /INFO auth-sync: pushed __claude__ \(1 key\(s\)\) to worker-b/.test(l))).toBe(true);
  });

  it('a peer that has never sent a reply is logged at INFO, not WARN', async () => {
    mocks.syncStores.mockResolvedValue({
      adopted: [],
      pushed: [],
      skipped: [
        { device: 'fresh-worker', reason: 'no daemon-state reply from this peer yet' },
        { device: 'other', reason: 'all reserved credentials present' },
      ],
      errors: [],
    });
    await new AuthSyncService().tick(makeCtx(), signal());

    // The no-reply peer surfaces once, at INFO.
    expect(logs).toContain('INFO auth-sync: fresh-worker: no daemon-state reply from this peer yet');
    // An ordinary "already present" skip stays silent — it is not noise-logged.
    expect(logs.some((l) => /other/.test(l))).toBe(false);
    // Nothing about it is a warning.
    expect(logs.some((l) => /WARN.*fresh-worker/.test(l))).toBe(false);
  });

  it('a peer whose reply carries no account rows (older CLI) is logged at INFO, fail-closed', async () => {
    mocks.syncStores.mockResolvedValue({
      adopted: [],
      pushed: [],
      skipped: [{ device: 'old-worker', reason: 'daemon-state reply carries no account rows (fail closed)' }],
      errors: [],
    });
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(logs).toContain('INFO auth-sync: old-worker: daemon-state reply carries no account rows (fail closed)');
    expect(logs.some((l) => /WARN.*old-worker/.test(l))).toBe(false);
  });

  it('surfaces reserved-store push errors at WARN', async () => {
    mocks.syncStores.mockResolvedValue({ adopted: [], pushed: [], skipped: [], errors: [{ device: 'worker-b', message: 'ssh refused' }] });
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(logs.some((l) => /WARN auth-sync: reserved-store worker-b: ssh refused/.test(l))).toBe(true);
  });

  it('the slot reconcile still runs even when an arm throws', async () => {
    mocks.syncStores.mockRejectedValue(new Error('boom'));
    await new AuthSyncService().tick(makeCtx(), signal());

    expect(mocks.reconcileSlots).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /WARN auth-sync: reserved-store sync: boom/.test(l))).toBe(true);
  });
});
