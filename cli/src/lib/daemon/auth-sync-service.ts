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
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const {
      reconcileLocalWorkerSlots,
      syncReservedAuthBundle,
      syncReservedStores,
      SKIP_REASON_NO_PEER_REPLY,
      SKIP_REASON_NO_ACCOUNT_ROWS,
    } = await import('../secrets-policy.js');

    try {
      const slots = reconcileLocalWorkerSlots();
      if (slots.provisioned.length > 0) ctx.log('INFO', `auth-sync: provisioned worker slot(s) for ${slots.provisioned.join(', ')}`);
      for (const err of slots.errors) ctx.log('WARN', `auth-sync: worker slot ${err.accountId}: ${err.message}`);
      const waiting = slots.skipped.filter((s) => s.reason === 'durable key not synced yet');
      if (waiting.length > 0) {
        ctx.log('WARN', `auth-sync: ${waiting.length} registered account(s) have no readable durable key on this box yet; slot not provisioned (${waiting.map((s) => s.accountId).join(', ')})`);
      }
    } catch (err) {
      ctx.log('WARN', `auth-sync: worker slot reconcile: ${(err as Error).message}`);
    }

    const result = await syncReservedAuthBundle();
    if (result.pushed.length > 0) {
      ctx.log('INFO', `auth-sync: pushed auth to ${result.pushed.join(', ')}`);
    }
    for (const err of result.errors) {
      ctx.log('WARN', `auth-sync: ${err.device}: ${err.message}`);
    }

    try {
      const stores = await syncReservedStores();
      if (stores.adopted.length > 0) ctx.log('INFO', `auth-sync: adopted ${stores.adopted.length} legacy reserved item(s) into their bundle: ${stores.adopted.map((a) => `${a.bundle} ${a.key}`).join(', ')}`);
      for (const p of stores.pushed) ctx.log('INFO', `auth-sync: pushed ${p.bundle} (${p.keys.length} key(s)) to ${p.device}`);
      for (const s of stores.skipped) {
        if (s.reason === SKIP_REASON_NO_PEER_REPLY || s.reason === SKIP_REASON_NO_ACCOUNT_ROWS) {
          ctx.log('INFO', `auth-sync: ${s.device}: ${s.reason}`);
        }
      }
      for (const err of stores.errors) ctx.log('WARN', `auth-sync: reserved-store ${err.device}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: reserved-store sync: ${(err as Error).message}`);
    }

    try {
      const { syncOwnerNotifyTokens } = await import('../owner-notify-tokens.js');
      const notify = await syncOwnerNotifyTokens();
      if (notify.minted.length > 0) ctx.log('INFO', `auth-sync: minted owner-notify device token(s) for ${notify.minted.join(', ')}`);
      if (notify.pushed.length > 0) ctx.log('INFO', `auth-sync: pushed owner-notify device token(s) to ${notify.pushed.join(', ')}`);
      for (const err of notify.errors) ctx.log('WARN', `auth-sync: owner-notify ${err.device}: ${err.message}`);
    } catch (err) {
      ctx.log('WARN', `auth-sync: owner-notify token sync: ${(err as Error).message}`);
    }
  }
}
