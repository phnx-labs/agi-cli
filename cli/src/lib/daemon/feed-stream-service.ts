
import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { FeedHub } from '../feed/hub.js';
import { FeedHubServer } from '../feed/hub-server.js';
import { sharedLocalFeedHub, watchFleetFeed } from '../feed/watch.js';

export class FeedStreamService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'feed-stream';

  private server: FeedHubServer | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
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
