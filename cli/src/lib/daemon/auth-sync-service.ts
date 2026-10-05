/** Reserved `auth` bundle fleet sync as a `PeriodicService` (PHNX-2371): materialize worker slots;
 * the elected headed publisher pushes missing keys over SSH per each peer's own reply (PHNX-4116),
 * with no transport of its own (PHNX-4051). Secret never enters Git; no-reply peers fail closed. */
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

export const AUTH_SYNC_TICK_MS = 15 * 60_000;
const AUTH_SYNC_DEADLINE_MS = 2 * 60_000;
export const AUTH_SYNC_KICKOFF_MS = 60_000;

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
      SKIP_REASON_NO_PEER_REPLY,
      SKIP_REASON_NO_ACCOUNT_ROWS,
    } = await import('../secrets-policy.js');

    // Worker-side slot materialization first (PHNX-3940 T6): for each registered account whose
    // durable key is on this box, create the HOME-shaped slot. It touches only local state, so it
    // never waits on a git exchange (a `git rebase timed out` once postponed every slot).
    try {
      const slots = reconcileLocalWorkerSlots();
      if (slots.provisioned.length > 0) ctx.log('INFO', `auth-sync: provisioned worker slot(s) for ${slots.provisioned.join(', ')}`);
      for (const err of slots.errors) ctx.log('WARN', `auth-sync: worker slot ${err.accountId}: ${err.message}`);
      // A row skipped for a key this box can't read is the one silent outcome an operator needs to
      // see: it looked like "0 slots after the daemon restart" on yosemite-m0 (2026-09-07), where
      // `secrets` could not decrypt the durable key.
      const waiting = slots.skipped.filter((s) => s.reason === 'durable key not synced yet');
      if (waiting.length > 0) {
        ctx.log('WARN', `auth-sync: ${waiting.length} registered account(s) have no readable durable key on this box yet; slot not provisioned (${waiting.map((s) => s.accountId).join(', ')})`);
      }
    } catch (err) {
      ctx.log('WARN', `auth-sync: worker slot reconcile: ${(err as Error).message}`);
    }

    // The pushes read each peer's own first-hand, timestamped daemon-state reply and run every
    // tick with no fleet-wide gate: a replied peer is planned off its verdict (any age; pushes are
    // idempotent), a never-replied peer is skipped at INFO.
    const result = await syncReservedAuthBundle();
    if (result.pushed.length > 0) {
      ctx.log('INFO', `auth-sync: pushed auth to ${result.pushed.join(', ')}`);
    }
    for (const err of result.errors) {
      ctx.log('WARN', `auth-sync: ${err.device}: ${err.message}`);
    }

    // Generalized per-account, per-key, per-role reserved-store push (PHNX-3940 T6): the elected
    // headed publisher pushes every portable account's `__<harness>__` store to worker peers
    // missing it. The push is the only transport; provisioning writes locally (invariant 1).
    try {
      const stores = await syncReservedStores();
      if (stores.adopted.length > 0) ctx.log('INFO', `auth-sync: adopted ${stores.adopted.length} legacy reserved item(s) into their bundle: ${stores.adopted.map((a) => `${a.bundle} ${a.key}`).join(', ')}`);
      for (const p of stores.pushed) ctx.log('INFO', `auth-sync: pushed ${p.bundle} (${p.keys.length} key(s)) to ${p.device}`);
      // A peer with no reply, or a reply with no account rows (older CLI, fail-closed), is
      // informational, not a warning: a new worker legitimately has none early, and the no-rows
      // skip is transient during a rolling upgrade.
      for (const s of stores.skipped) {
        if (s.reason === SKIP_REASON_NO_PEER_REPLY || s.reason === SKIP_REASON_NO_ACCOUNT_ROWS) {
          ctx.log('INFO', `auth-sync: ${s.device}: ${s.reason}`);
        }
      }
      for (const err of stores.errors) ctx.log('WARN', `auth-sync: reserved-store ${err.device}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: reserved-store sync: ${(err as Error).message}`);
    }
  }
}
