
import { BaseDaemonService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { FeedHubServer } from '../feed/hub-server.js';
import { sharedFleetFeedHub, sharedLocalFeedHub } from '../feed/watch.js';

export class FeedStreamService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'feed-stream';

  private server: FeedHubServer | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.server = new FeedHubServer(sharedFleetFeedHub(), undefined, sharedLocalFeedHub());
    await this.server.start();
    ctx.log('INFO', 'Feed stream hub listening (fan-out starts on first reader)');
  }

  protected async onStop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
  }
}
