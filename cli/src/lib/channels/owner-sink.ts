import { platform } from 'os';
import type { Meta } from '../types.js';
import { readOwnerDest } from './send.js';
import { RUSH_CHANNELS, resolveSlackToken } from './providers/rush.js';

export type OwnerSinkReason =
  | 'imessage-not-macos'
  | 'slack-no-token'
  | 'channel-unsupported';

export interface OwnerSinkStatus {
  configured: boolean;
  reachable: boolean;
  channel?: string;
  transport?: string;
  reason?: OwnerSinkReason;
}

export async function probeOwnerSink(meta: Meta): Promise<OwnerSinkStatus> {
  const dest = readOwnerDest(meta);
  if (!dest) return { configured: false, reachable: false };
  const channel = dest.channel;
  const transport = meta.notify?.transports?.[channel] ?? channel;

  if (!(RUSH_CHANNELS as readonly string[]).includes(transport)) {
    return { configured: true, reachable: true, channel, transport };
  }

  if (transport === 'imessage') {
    if (platform() !== 'darwin') {
      return { configured: true, reachable: false, channel, transport, reason: 'imessage-not-macos' };
    }
    return { configured: true, reachable: true, channel, transport };
  }

  if (transport === 'slack') {
    if (resolveSlackToken()) {
      return { configured: true, reachable: true, channel, transport };
    }
    return { configured: true, reachable: false, channel, transport, reason: 'slack-no-token' };
  }

  return { configured: true, reachable: false, channel, transport, reason: 'channel-unsupported' };
}
