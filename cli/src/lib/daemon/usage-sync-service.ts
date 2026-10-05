import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { USAGE_SYNC_INTERVAL_MS } from '../accounting/usage-sync.js';

/**
 * The usage-sync tick cadence. Exported because auth-sync's credential-push
 * freshness gate is the CONSUMER of this producer's cadence: it skips the
 * pushes when the last exchange is older than one usage-sync interval, so it
 * must track this constant rather than its own equal-by-coincidence literal.
 * Sourced from `usage-sync.ts`'s `USAGE_SYNC_INTERVAL_MS` rather than a
 * second literal, so the two files can't drift out of sync with each other.
 */
export const USAGE_SYNC_TICK_MS = USAGE_SYNC_INTERVAL_MS;
const USAGE_SYNC_DEADLINE_MS = 2 * 60_000;
export const USAGE_SYNC_KICKOFF_MS = 90_000;

export class UsageSyncService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'usage-sync';
  readonly intervalMs = USAGE_SYNC_TICK_MS;
  readonly deadlineMs = USAGE_SYNC_DEADLINE_MS;
  readonly startupDelayMs = USAGE_SYNC_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { exchangeFleetStateWithPeers, publishOwnFleetState } = await import('../accounting/usage-sync.js');
    const { isHeadedDeviceRole, selfConfiguredDeviceRole } = await import('../device-config.js');
    const published = await publishOwnFleetState();
    if (published.usage.changed) ctx.log('INFO', `usage-sync: published usage snapshot to ${published.usage.path}`);
    if (published.mirror.changed) ctx.log('INFO', `session-mirror: published ${published.mirror.count} session digest(s)`);
    for (const err of published.errors) ctx.log('WARN', `usage-sync: publish ${err}`);
    if (!isHeadedDeviceRole(selfConfiguredDeviceRole())) {
      ctx.log('INFO', 'usage-sync: not a headed device; peers dial in with `agents __usage-ingest --reply`, nothing to send');
      return;
    }
    const exchange = await exchangeFleetStateWithPeers();
    if (exchange.skipped) ctx.log('WARN', `usage-sync: ${exchange.skipped}`);
    const delivered = exchange.outcomes.filter((o) => o.delivered);
    if (delivered.length > 0) {
      ctx.log('INFO', `usage-sync: exchanged with ${delivered.map((o) => `${o.device}${o.merged ? ` (+${o.merged} usage row(s))` : ''}`).join(', ')}`);
    }
    for (const o of exchange.outcomes) {
      if (o.error) ctx.log('WARN', `usage-sync: ${o.device}: ${o.error}`);
      for (const err of o.peerErrors) ctx.log('WARN', `usage-sync: ${o.device} reported: ${err}`);
    }
    const { consumeSessionMirrorFromSharedStore } = await import('../session/mirror.js');
    const foldedIn = consumeSessionMirrorFromSharedStore();
    if (foldedIn.merged > 0) {
      ctx.log('INFO', `session-mirror: folded ${foldedIn.merged} session(s) from ${foldedIn.sources.join(', ')}`);
    }
    if (foldedIn.pruned > 0) ctx.log('INFO', `session-mirror: pruned ${foldedIn.pruned} stale mirror row(s)`);
    for (const err of foldedIn.errors) ctx.log('WARN', `session-mirror: ${err.device}: ${err.message}`);
  }
}
