/**
 * Fleet shared-state sync as a `PeriodicService` (PHNX-3392 usage-sync,
 * PHNX-3792 session mirror).
 *
 * This is the ONE tick that owns the bounded Git exchange over the fleet-synced
 * user repo, so every non-secret daemon-state field rides it rather than opening
 * a second committer. Each tick: (1) publishes this box's own fields into its
 * conflict-free `devices/<device>/daemon-state.json` — a headed box's Claude
 * usage snapshot, EVERY box's lightweight session digests (PHNX-3792), and the
 * reserved-auth readiness verdict (PHNX-4051, folded in from the auth-sync tick
 * so a single caller holds the shared-repo lock per tick); (2) runs one
 * serialized, timeout-bounded commit/rebase/push; (3) consumes the peer fields
 * the exchange delivered — a worker merges usage newest-wins, and every
 * non-worker box folds peers' session digests into its local index so the picker
 * renders remote-host previews inline. No tick opens a device-to-device SSH mesh.
 *
 * Why the auth verdict publishes here (PHNX-4051): auth-sync used to run its OWN
 * `syncFleetSharedStateRepo`, so on every box two ticks 30 s apart contended for
 * the one `proper-lockfile` lock (20×100 ms ≈ 2 s of retries) while a real
 * fetch/rebase/push on a drifted repo runs far longer — the usage tick then
 * failed with "Lock file is already being held" (zion logged it 95× in 24 h) and
 * workers never received a fresh usage snapshot, which the 40-min placement gate
 * turned into "no ready device". Folding the auth verdict into this single
 * committer removes the second caller entirely. Auth-sync keeps its non-git
 * duties (worker-slot reconcile + the credential SSH pushes) under its own
 * deadline and circuit breaker.
 */
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
    // Browser profile declarations (including discovered native Arc/Comet profiles)
    // are the standalone `browser` CLI's now (PHNX-4101), so the daemon no longer
    // publishes them here.
    const published = await publishUsageSnapshotToSharedStore();
    if (published.changed) ctx.log('INFO', `usage-sync: published usage snapshot to ${published.path}`);
    if (published.error) ctx.log('WARN', `usage-sync: publish: ${published.error}`);
    const mirrored = await publishSessionMirrorToSharedStore();
    if (mirrored.changed) ctx.log('INFO', `session-mirror: published ${mirrored.count} session digest(s)`);
    if (mirrored.error) ctx.log('WARN', `session-mirror: publish: ${mirrored.error}`);
    // The reserved-auth readiness verdict rides this single git exchange too
    // (PHNX-4051): it is a conflict-free field in the same owned daemon-state
    // file, so publishing it here — instead of from a second committer in
    // auth-sync — is what keeps exactly one caller of syncFleetSharedStateRepo on
    // the periodic path.
    const { publishReservedAuthVerdict } = await import('../secrets-policy.js');
    const authVerdict = await publishReservedAuthVerdict();
    if (authVerdict.error) ctx.log('WARN', `usage-sync: auth verdict: ${authVerdict.error}`);
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
