/**
 * The shared feed collector's lifecycle as a `DaemonService`.
 *
 * WHY THE DAEMON OWNS IT. Dialing every peer over ssh and holding those
 * connections open is an ACTION on the fleet, so by the repo's one-scheduler /
 * one-executor rule it belongs to the daemon and not to a UI surface. Before
 * this service, every consumer of `agents feed watch --json` ran its own
 * `watchFleetFeed`, which is N ssh children per peer for N readers. The daemon
 * runs one, and the readers attach over a socket (`feed/hub-server.ts`).
 *
 * The server binds on start, but the fan-out itself is DEMAND-GATED by the hub:
 * with no client connected there is no `watchFleetFeed`, so an idle box holds no
 * peer connections — the same idle-cost rule `SessionStateService` follows for
 * its gather.
 */

import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { FeedHub } from '../feed/hub.js';
import { FeedHubServer } from '../feed/hub-server.js';
import { sharedLocalFeedHub, watchFleetFeed } from '../feed/watch.js';

export class FeedStreamService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'feed-stream';

  private server: FeedHubServer | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    // Two collectors, one socket. The fleet hub holds one ssh child per peer plus
    // this box's rows; the local hub is this box ONLY and cannot fan out, so a
    // reader that wants just this machine never causes a peer dial. They are
    // separate hubs rather than one filtered stream because demand must be
    // separate too: a local-only reader must not start the fleet fan-out.
    const fleet = new FeedHub({ watch: watchFleetFeed });
    this.server = new FeedHubServer(fleet, undefined, sharedLocalFeedHub());
    await this.server.start();
    ctx.log('INFO', 'Feed stream hub listening (fan-out starts on first reader)');
  }

  protected async onStop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
  }
}
