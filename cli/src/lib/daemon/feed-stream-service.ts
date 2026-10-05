/** The shared feed collector's lifecycle as a `DaemonService`. The daemon owns it because dialing
 * every peer over ssh is an action on the fleet (one-scheduler / one-executor rule); before, each
 * `agents feed watch --json` reader ran its own N ssh children. Readers now attach over a socket. */

import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { FeedHub } from '../feed/hub.js';
import { FeedHubServer } from '../feed/hub-server.js';
import { sharedLocalFeedHub, watchFleetFeed } from '../feed/watch.js';

export class FeedStreamService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'feed-stream';

  private server: FeedHubServer | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    // Two collectors, one socket. The fleet hub holds one ssh child per peer plus this box's rows;
    // the local hub is this box only and can't fan out. They are separate hubs because demand must
    // be separate: a local-only reader must not start the fleet fan-out.
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
