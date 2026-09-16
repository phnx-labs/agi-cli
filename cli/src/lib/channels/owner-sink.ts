/**
 * Owner-delivery-sink reachability probe (RUSH-2262).
 *
 * The feed/notify owner-delivery lane (`agents send --to owner`, `agents feed post
 * --level important` / `--blocked`) reaches the owner through the channel
 * providers registered for each configured channel in humans.yaml.
 *
 * Transport capabilities differ by channel and platform:
 *   - **imessage:** macOS only (osascript → Messages.app). Linux boxes rely on
 *     the peer-forward in owner-forward.ts to reach a macOS peer.
 *   - **slack:** requires a `SLACK_BOT_TOKEN` in env or the `webhooks` secrets
 *     bundle. Platform-independent.
 *   - **telegram / discord:** requires the Rush daemon (removed); only
 *     openclaw-telegram is available as a Telegram alternative.
 *
 * `agents send --to owner --dry-run` is NOT this probe: dry-run short-circuits
 * before the capability check. Resolvability (does the envelope build?) and
 * reachability (can this box actually deliver?) are different questions; this
 * answers the second.
 */
import { platform } from 'os';
import type { Meta } from '../types.js';
import { readOwnerDest } from './send.js';
import { RUSH_CHANNELS } from './providers/rush.js';

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
    if (process.env.SLACK_BOT_TOKEN) {
      return { configured: true, reachable: true, channel, transport };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readAndResolveBundleEnvSync } = require('../secrets-client.js') as {
        readAndResolveBundleEnvSync: (name: string, opts?: Record<string, unknown>) => { env: Record<string, string> };
      };
      const { env } = readAndResolveBundleEnvSync('webhooks', { caller: 'owner-sink-probe', agentOnly: true });
      if (env.SLACK_BOT_TOKEN) {
        return { configured: true, reachable: true, channel, transport };
      }
    } catch {
      // Bundle missing or store locked.
    }
    return { configured: true, reachable: false, channel, transport, reason: 'slack-no-token' };
  }

  // telegram / discord — daemon removed, no direct transport.
  return { configured: true, reachable: false, channel, transport, reason: 'channel-unsupported' };
}
