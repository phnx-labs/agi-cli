/** Channel-provider registry for `agents send`. Providers register at module load; the command
 * layer only calls `resolveChannelProvider(name).send(...)`. */

export interface SendOptions {
  target: string;
  thread?: string;
  attachments?: string[];
  from?: string;
  ownerScoped?: boolean;
  dryRun?: boolean;
}

export interface SendResult {
  ok: boolean;
  channel: string;
  id: string;
  error?: string;
  attachments?: string[];
  msgId?: string;
  /** Exact body handed to the provider for this destination, set by the owner fan-out so
   * per-destination compose (Slack mrkdwn vs plain iMessage) is observable (PHNX-3698). */
  body?: string;
  deliveries?: SendResult[];
}

export interface ChannelProvider {
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
