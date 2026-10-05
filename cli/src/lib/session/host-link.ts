
export type HostLink =
  | 'connected'
  | 'no-client'
  | 'host-gone'
  | 'unknown';

export const HOST_HEARTBEAT_STALE_MS = 10 * 60_000;

interface HostLinkInput {
  pidAlive: boolean;
  windowHeartbeatMs?: number;
  tmuxClients?: number;
  deliberatelyDetached?: boolean;
  nowMs?: number;
}

function windowGone(input: HostLinkInput): boolean {
  const now = input.nowMs ?? Date.now();
  return input.windowHeartbeatMs !== undefined && now - input.windowHeartbeatMs >= HOST_HEARTBEAT_STALE_MS;
}

export function classifyHostLink(input: HostLinkInput): HostLink {
  if (input.deliberatelyDetached) return 'connected';

  const stale = windowGone(input);

  if (stale && !input.pidAlive) return 'host-gone';

  if (!input.pidAlive) return 'connected';

  if (input.tmuxClients === 0) return 'no-client';

  if (stale) return 'no-client';

  if (input.tmuxClients !== undefined || input.windowHeartbeatMs !== undefined) return 'connected';

  return 'unknown';
}

export function hostWindowLost(input: HostLinkInput): boolean {
  if (input.deliberatelyDetached) return false;
  return input.pidAlive && windowGone(input);
}
