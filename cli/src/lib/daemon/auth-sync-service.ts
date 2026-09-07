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
    const {
      publishReservedAuthVerdict,
      reconcileLocalWorkerSlots,
      syncReservedAuthBundle,
      syncReservedStores,
    } = await import('../secrets-policy.js');

    // Worker-side slot materialization FIRST (PHNX-3940 T6): for each registered
    // account whose durable key is already on this box, create the HOME-shaped
    // slot the picker and spawn read. It touches only local state — the registry
    // copy and the file-backed store — so it never waits on the git exchange
    // below. It used to sit after `if (!transport.success) return`, so a single
    // `git rebase timed out` postponed every slot on the box by another tick.
    // Self-gated on device role: a headed box returns immediately.
    try {
      const slots = reconcileLocalWorkerSlots();
      if (slots.provisioned.length > 0) ctx.log('INFO', `auth-sync: provisioned worker slot(s) for ${slots.provisioned.join(', ')}`);
      for (const err of slots.errors) ctx.log('WARN', `auth-sync: worker slot ${err.accountId}: ${err.message}`);
      // A row skipped for a key this box cannot read is the one silent outcome
      // an operator needs to see: it is what "0 slots after the daemon restart"
      // looked like on yosemite-m0 (2026-09-07), where the durable key was in
      // the bundle but the `secrets` on the daemon's PATH could not decrypt it.
      const waiting = slots.skipped.filter((s) => s.reason === 'durable key not synced yet');
      if (waiting.length > 0) {
        ctx.log('WARN', `auth-sync: ${waiting.length} registered account(s) have no readable durable key on this box yet; slot not provisioned (${waiting.map((s) => s.accountId).join(', ')})`);
      }
    } catch (err) {
      ctx.log('WARN', `auth-sync: worker slot reconcile: ${(err as Error).message}`);
    }

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

    // Generalized per-account, per-key, per-role reserved-store push (PHNX-3940
    // T6). On the elected headed publisher this pushes every portable account's
    // reserved `__<harness>__` store to the worker peers missing it. The push is
    // the only transport — provisioning (above) writes only locally (invariant 1).
    try {
      const stores = await syncReservedStores();
      if (stores.adopted.length > 0) ctx.log('INFO', `auth-sync: adopted ${stores.adopted.length} legacy reserved item(s) into their bundle: ${stores.adopted.map((a) => `${a.bundle} ${a.key}`).join(', ')}`);
      for (const p of stores.pushed) ctx.log('INFO', `auth-sync: pushed ${p.bundle} (${p.keys.length} key(s)) to ${p.device}`);
      for (const err of stores.errors) ctx.log('WARN', `auth-sync: reserved-store ${err.device}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: reserved-store sync: ${(err as Error).message}`);
    }
  }
}
