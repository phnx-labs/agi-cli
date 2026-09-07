/**
 * Reserved `auth` bundle fleet sync as a `PeriodicService` (PHNX-2371).
 *
 * Each daemon publishes a safe readiness verdict to the fleet-shared user repo,
 * then runs the same serialized, timeout-bounded git exchange as usage sync.
 * One deterministic ready device asynchronously provisions peers whose delivered
 * verdict says `missing`; the secret never enters Git.
 */
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

const AUTH_SYNC_TICK_MS = 15 * 60_000;
const AUTH_SYNC_DEADLINE_MS = 2 * 60_000;
const AUTH_SYNC_KICKOFF_MS = 60_000;

export class AuthSyncService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'auth-sync';
  readonly intervalMs = AUTH_SYNC_TICK_MS;
  readonly deadlineMs = AUTH_SYNC_DEADLINE_MS;
  readonly startupDelayMs = AUTH_SYNC_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections to open — each tick re-reads the local bundle + registry.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { publishReservedAuthVerdict, syncReservedAuthBundle } = await import('../secrets-policy.js');
    const published = await publishReservedAuthVerdict();
    if (published.error) ctx.log('WARN', `auth-sync: verdict: ${published.error}`);
    const { syncFleetSharedStateRepo } = await import('../fleet-shared-repo-sync.js');
    const transport = await syncFleetSharedStateRepo();
    if (transport.skipped) ctx.log('WARN', `auth-sync: ${transport.skipped}`);
    if (transport.error) ctx.log('WARN', `auth-sync: shared-store transport: ${transport.error}`);
    if (transport.untrackedBackedUp?.length) {
      ctx.log('WARN', `auth-sync: backed up ${transport.untrackedBackedUp.length} untracked shared-store collision(s) to ${transport.untrackedBackupDir}: ${transport.untrackedBackedUp.join(', ')}`);
    }
    if (!transport.success) return;
    const result = await syncReservedAuthBundle();
    if (result.pushed.length > 0) {
      ctx.log('INFO', `auth-sync: pushed auth to ${result.pushed.join(', ')}`);
    }
    for (const err of result.errors) {
      ctx.log('WARN', `auth-sync: ${err.device}: ${err.message}`);
    }

    // Generalized per-account, per-key, per-role reserved-store sync (PHNX-3940
    // T6). On the elected headed publisher this pushes every portable account's
    // reserved `__<harness>__` store to the worker peers missing it; on a worker
    // it materializes a slot for each account whose durable key has landed. Each
    // self-gates on device role, so exactly one arm acts per box. The push is the
    // only transport — provisioning writes only locally (invariant 1).
    const { syncReservedStores, reconcileLocalWorkerSlots } = await import('../secrets-policy.js');
    try {
      const stores = await syncReservedStores();
      for (const p of stores.pushed) ctx.log('INFO', `auth-sync: pushed ${p.bundle} (${p.keys.length} key(s)) to ${p.device}`);
      for (const err of stores.errors) ctx.log('WARN', `auth-sync: reserved-store ${err.device}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: reserved-store sync: ${(err as Error).message}`);
    }
    try {
      const slots = reconcileLocalWorkerSlots();
      if (slots.provisioned.length > 0) ctx.log('INFO', `auth-sync: provisioned worker slot(s) for ${slots.provisioned.join(', ')}`);
      for (const err of slots.errors) ctx.log('WARN', `auth-sync: worker slot ${err.accountId}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: worker slot reconcile: ${(err as Error).message}`);
    }
  }
}
