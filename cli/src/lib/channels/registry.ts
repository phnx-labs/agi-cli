/** Channel-provider registry for `agents send`. Providers register at module load; the command
 * layer only calls `resolveChannelProvider(name).send(...)`. */

export interface SendOptions {
  /** Channel-specific recipient id: a chat id, a mailbox/agent id, a Slack C0…, etc. */
  target: string;
  /** Channel thread id / timestamp (slack/telegram threads). */
  thread?: string;
  /** Absolute paths to file attachments. */
  attachments?: string[];
  /** Sender label (used by the mailbox provider). */
  from?: string;
  /** Destination was resolved through the verified owner alias. */
  ownerScoped?: boolean;
  /** Resolve + build the delivery but do not actually send. */
  dryRun?: boolean;
}

export interface SendResult {
  ok: boolean;
  /** Channel/provider name as surfaced back to the caller. */
  channel: string;
  /** Resolved recipient id, echoed for --json parity with `rush send`. */
  id: string;
  error?: string;
  /** Echoed attachment paths (rush shape parity). */
  attachments?: string[];
  /** Mailbox provider returns the enqueued message id. */
  msgId?: string;
  /** Exact body handed to the provider for this destination, set by the owner fan-out so
   * per-destination compose (Slack mrkdwn vs plain iMessage) is observable (PHNX-3698). */
  body?: string;
  /** Per-destination results when the owner policy selects multiple channels. */
  deliveries?: SendResult[];
}

export interface ChannelProvider {
  /** Stable name used in `--channel` and as a `notify.transports` value. */
  name: string;
  send(text: string, opts: SendOptions): Promise<SendResult>;
}

const REGISTRY = new Map<string, ChannelProvider>();

export function registerChannelProvider(p: ChannelProvider): void {
  REGISTRY.set(p.name, p);
}

export function resolveChannelProvider(name: string): ChannelProvider | undefined {
  return REGISTRY.get(name);
}

export function listChannelProviders(): string[] {
  return [...REGISTRY.keys()].sort();
}
