/**
 * Reserved `auth` bundle fleet sync as a `PeriodicService` (PHNX-2371).
 *
 * This tick owns only the NON-git duties of auth sync: it materializes worker
 * slots from durable keys already on the box, then (on the elected headed
 * publisher) provisions peers missing a reserved key by pushing the credential
 * over SSH. The secret never enters Git.
 *
 * It runs no transport of its own (PHNX-4051): the per-account readiness
 * verdicts it reads are published and delivered by the usage-sync tick's SSH
 * exchange, which stores each peer's reply at `devices/<peer>/daemon-state.json`
 * stamped `receivedAt`. This tick keeps its own deadline and circuit breaker, so
 * a hung peer SSH push parks only auth-sync and never the usage delivery.
 *
 * The pushes read each peer's OWN reply file (PHNX-4116 PR 5): a peer reporting
 * a `missing` verdict for an account is pushed that account's key; a peer that
 * has never sent a reply (no file) is skipped this tick and logged at INFO. The
 * push is idempotent, so a stale reply is harmless — a stale "has key" is fine,
 * a stale "missing key" costs one redundant push — which is why the per-peer
 * `receivedAt` replaced the old global freshness gate (`readLastSuccessfulExchangeMs`)
 * that skipped EVERY push when the newest exchange across the fleet went stale.
 * The reply file is first-hand and timestamped, so acting on it needs no such
 * fleet-wide gate.
 */
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

    // The pushes read each peer's OWN daemon-state reply, first-hand and
    // timestamped, so they run every tick with no fleet-wide freshness gate: a
    // peer that has replied is planned off its verdict (any age — the push is
    // idempotent), and a peer that has never replied is skipped and logged at
    // INFO below. The worker-slot reconcile above reads only local durable keys,
    // never peer verdicts, so it was never gated either.
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
      // A peer with no reply yet is informational, not a warning — a brand-new or
      // never-dialed worker legitimately has none on an early tick. One line per
      // such peer per tick.
      for (const s of stores.skipped) if (s.reason === SKIP_REASON_NO_PEER_REPLY) ctx.log('INFO', `auth-sync: ${s.device}: ${s.reason}`);
      for (const err of stores.errors) ctx.log('WARN', `auth-sync: reserved-store ${err.device}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: reserved-store sync: ${(err as Error).message}`);
    }
  }
}
