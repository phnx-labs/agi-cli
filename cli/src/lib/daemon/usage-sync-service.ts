/**
 * Fleet shared-state sync as a `PeriodicService` (PHNX-3392 usage-sync,
 * PHNX-3792 session mirror).
 *
 * This is the one tick that owns the bounded Git exchange over the fleet-synced
 * user repo, so every non-secret daemon-state field rides it rather than opening
 * a second committer. Each tick: (1) publishes this box's own fields into its
 * conflict-free `devices/<device>/daemon-state.json` — a headed box's Claude
 * usage snapshot, and EVERY box's lightweight session digests (PHNX-3792);
 * (2) runs one serialized, timeout-bounded commit/rebase/push; (3) consumes the
 * peer fields the exchange delivered — a worker merges usage newest-wins, and
 * every non-worker box folds peers' session digests into its local index so the
 * picker renders remote-host previews inline. No tick opens a device-to-device
 * SSH mesh.
 */
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

import { USAGE_SYNC_INTERVAL_MS } from '../accounting/usage-sync.js';

export const USAGE_SYNC_TICK_MS = USAGE_SYNC_INTERVAL_MS;
const USAGE_SYNC_DEADLINE_MS = 2 * 60_000;
/**
 * Offset from auth-sync's 60s kickoff so the two never contend for the
 * shared-repo lock. Auth fires at T+1m, T+16m, …; usage at T+8m, T+23m, …
 * The git exchange deadline is 45s, so a 7-minute gap is the whole point.
 */
export const USAGE_SYNC_KICKOFF_MS = 8 * 60_000;

export class UsageSyncService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'usage-sync';
  readonly intervalMs = USAGE_SYNC_TICK_MS;
  readonly deadlineMs = USAGE_SYNC_DEADLINE_MS;
  readonly startupDelayMs = USAGE_SYNC_KICKOFF_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections to open — each tick re-reads the local cache + registry.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup.
  }

  protected async onTick(ctx: DaemonContext): Promise<void> {
    const { consumeUsageSnapshotsFromSharedStore, publishUsageSnapshotToSharedStore } = await import('../accounting/usage-sync.js');
    const { consumeSessionMirrorFromSharedStore, publishSessionMirrorToSharedStore } = await import('../session/mirror.js');
    // Publish every owned field BEFORE the single git exchange so they ride one commit.
    // Discovered native browser profiles (Arc Spaces, Comet profiles) go into this
    // device's declaration first, so every other box lists them with WHERE=<here>
    // and routes a `--profile` for one of them to this machine (PHNX-4042).
    const { publishDiscoveredProfiles } = await import('../browser/profiles.js');
    const profiles = await publishDiscoveredProfiles().catch((error: unknown) => ({
      published: [] as string[],
      errors: { publish: error instanceof Error ? error.message : String(error) },
    }));
    if (profiles.published.length > 0) ctx.log('INFO', `browser-profiles: published ${profiles.published.join(', ')} to this device's declaration`);
    for (const [browser, message] of Object.entries(profiles.errors)) ctx.log('WARN', `browser-profiles: ${browser}: ${message}`);
    const published = await publishUsageSnapshotToSharedStore();
    if (published.changed) ctx.log('INFO', `usage-sync: published usage snapshot to ${published.path}`);
    if (published.error) ctx.log('WARN', `usage-sync: publish: ${published.error}`);
    const mirrored = await publishSessionMirrorToSharedStore();
    if (mirrored.changed) ctx.log('INFO', `session-mirror: published ${mirrored.count} session digest(s)`);
    if (mirrored.error) ctx.log('WARN', `session-mirror: publish: ${mirrored.error}`);
    const { syncFleetSharedStateRepo } = await import('../fleet-shared-repo-sync.js');
    const transport = await syncFleetSharedStateRepo();
    if (transport.skipped) ctx.log('WARN', `usage-sync: ${transport.skipped}`);
    if (transport.error) ctx.log('WARN', `usage-sync: shared-store transport: ${transport.error}`);
    if (transport.untrackedBackedUp?.length) {
      ctx.log('WARN', `usage-sync: backed up ${transport.untrackedBackedUp.length} untracked shared-store collision(s) to ${transport.untrackedBackupDir}: ${transport.untrackedBackedUp.join(', ')}`);
    }
    if (!transport.success) return;
    const consumed = consumeUsageSnapshotsFromSharedStore();
    if (consumed.merged > 0) {
      ctx.log('INFO', `usage-sync: merged ${consumed.merged} row(s) from ${consumed.sources.join(', ')}`);
    }
    for (const err of consumed.errors) ctx.log('WARN', `usage-sync: ${err.device}: ${err.message}`);
    const foldedIn = consumeSessionMirrorFromSharedStore();
    if (foldedIn.merged > 0) {
      ctx.log('INFO', `session-mirror: folded ${foldedIn.merged} session(s) from ${foldedIn.sources.join(', ')}`);
    }
    if (foldedIn.pruned > 0) ctx.log('INFO', `session-mirror: pruned ${foldedIn.pruned} stale mirror row(s)`);
    for (const err of foldedIn.errors) ctx.log('WARN', `session-mirror: ${err.device}: ${err.message}`);
  }
}
