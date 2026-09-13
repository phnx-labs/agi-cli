/**
 * Rush channel providers — telegram / imessage / slack / discord.
 *
 * Addressable channels use `rush send`, which routes through the daemon's live
 * gateways. Owner-scoped iMessage uses `rush message send`; it is backed by the
 * verified Rush owner account and does not require a daemon channel registration.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const execFileAsync = promisify(execFile);

type RushChannel = 'telegram' | 'imessage' | 'slack' | 'discord';
export const RUSH_CHANNELS: RushChannel[] = ['telegram', 'imessage', 'slack', 'discord'];

/** Build the `rush send` argv (exported for tests). */
export function buildRushSendArgs(channel: RushChannel, text: string, opts: SendOptions): string[] {
  const args = ['send', text, '--channel', channel, '--id', opts.target, '--json'];
  if (opts.thread) args.push('--thread', opts.thread);
  for (const a of opts.attachments ?? []) args.push('--attachment', a);
  return args;
}

/** Build the owner-scoped iMessage argv. */
export function buildRushOwnerMessageArgs(text: string): string[] {
  return ['message', 'send', '--text', text];
}

function rushProvider(channel: RushChannel): ChannelProvider {
  return {
    name: channel,
    async send(text: string, opts: SendOptions): Promise<SendResult> {
      if (opts.dryRun) {
        return { ok: true, channel, id: opts.target, attachments: opts.attachments };
      }
      // Preflight: rush must be on PATH (mirrors notify.ts's openclaw check).
      try {
        await execFileAsync('which', ['rush']);
      } catch {
        return { ok: false, channel, id: opts.target, error: 'rush CLI not found on PATH' };
      }
      try {
        if (channel === 'imessage' && opts.ownerScoped) {
          if ((opts.attachments?.length ?? 0) > 0) {
            return {
              ok: false,
              channel,
              id: opts.target,
              error: 'owner-scoped iMessage does not support attachments',
            };
          }
          await execFileAsync('rush', buildRushOwnerMessageArgs(text));
          return { ok: true, channel, id: opts.target };
        }

        const { stdout } = await execFileAsync('rush', buildRushSendArgs(channel, text, opts));
        const parsed = JSON.parse(stdout) as { ok?: boolean; attachments?: string[] };
        return {
          ok: parsed.ok === true,
          channel,
          id: opts.target,
          attachments: parsed.attachments,
          error: parsed.ok === true ? undefined : 'rush send returned ok=false',
        };
      } catch (err) {
        // Daemon down surfaces here as the exec error (ErrDaemonDown), as does a
        // non-JSON stdout (parse throw). Fail loud — never silently reroute.
        return { ok: false, channel, id: opts.target, error: (err as Error).message };
      }
    },
  };
}

export const rushProviders: ChannelProvider[] = RUSH_CHANNELS.map(rushProvider);
