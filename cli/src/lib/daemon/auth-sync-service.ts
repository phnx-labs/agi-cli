/**
 * Reserved `auth` bundle fleet sync as a `PeriodicService` (PHNX-2371).
 *
 * This tick owns only the NON-git duties of auth sync: it materializes worker
 * slots from durable keys already on the box, then (on the elected headed
 * publisher) provisions peers whose LAST-DELIVERED verdict says `missing` by
 * pushing the credential over SSH. The secret never enters Git.
 *
 * It no longer runs its own `syncFleetSharedStateRepo` (PHNX-4051). The verdict
 * this tick's decisions read is published and delivered by the single git
 * committer, the usage-sync tick — folding both publishes into one caller is
 * what stops the two ticks (30 s apart) from contending for the one shared-repo
 * lock and starving the usage snapshot workers depend on. This tick keeps its
 * own deadline and circuit breaker, so a hung peer SSH push parks only auth-sync
 * and never the usage delivery. The pushes read the peer verdicts the last
 * usage-sync exchange wrote into the local checkout; they are idempotent
 * (push only when a peer is missing a key), so acting on at-most-one-tick-old
 * data converges exactly as the in-tick exchange did. To keep "at-most-one-tick-
 * old" true, the pushes are gated on the exchange's freshness marker
 * (`readLastSuccessfulExchangeMs`): when the last usage-sync exchange is missing
 * or older than one tick interval, this tick skips the pushes and WARNs instead
 * of acting on peer state that may no longer hold.
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
      reconcileLocalWorkerSlots,
      syncReservedAuthBundle,
      syncReservedStores,
    } = await import('../secrets-policy.js');

    // Worker-side slot materialization FIRST (PHNX-3940 T6): for each registered
    // account whose durable key is already on this box, create the HOME-shaped
    // slot the picker and spawn read. It touches only local state — the registry
    // copy and the file-backed store — so it never waits on any git exchange. It
    // used to sit after this tick's own `if (!transport.success) return`, so a
    // single `git rebase timed out` postponed every slot on the box by another
    // tick; that exchange has since moved to the usage-sync tick (PHNX-4051).
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

    // The verdict this tick's pushes read is published by the usage-sync tick,
    // the single git committer (PHNX-4051), and delivered into the local checkout
    // by its exchange. The pushes below act on that last-delivered peer state, so
    // they are only sound while that state is fresh. Gate them on the exchange's
    // freshness: if the last successful usage-sync exchange is missing or older
    // than one tick interval, the delivered peer verdicts may be stale — a peer
    // that already received the key still reads `missing`, or a cleared `missing`
    // still reads stale — so skip the pushes and WARN rather than pushing off it.
    // The worker-slot reconcile above is NOT gated: it reads only local durable
    // keys, never delivered peer verdicts.
    const { readLastSuccessfulExchangeMs } = await import('../fleet-shared-repo-sync.js');
    const lastExchangeMs = readLastSuccessfulExchangeMs();
    const ageMs = lastExchangeMs === null ? null : Date.now() - lastExchangeMs;
    if (ageMs === null || ageMs > this.intervalMs) {
      const age = ageMs === null ? 'never completed' : `last completed ${Math.round(ageMs / 1000)}s ago`;
      ctx.log('WARN', `auth-sync: skipping credential push — usage-sync exchange ${age} (need one within ${Math.round(this.intervalMs / 1000)}s); peer verdicts may be stale`);
      return;
    }

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
