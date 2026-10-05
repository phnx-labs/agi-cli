
import { startHostedWebhookReceivers, type HostedWebhookReceivers } from '../daemon-webhooks.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { BaseDaemonService, type DaemonContext } from './service.js';

export class WebhookReceiverService extends BaseDaemonService {
  readonly id: DaemonServiceId = 'webhook-receiver';

  private receivers: HostedWebhookReceivers | null = null;

  protected async onStart(ctx: DaemonContext): Promise<void> {
    this.receivers = await startHostedWebhookReceivers({ log: ctx.log });
    ctx.log(
      'INFO',
      this.receivers.count > 0
        ? `Webhook receiver hosting ${this.receivers.count} receiver(s)`
        : 'Webhook receiver service enabled; no receivers declared in daemon/webhooks.yaml',
    );
  }

  protected async onStop(): Promise<void> {
    await this.receivers?.close();
    this.receivers = null;
  }
}
