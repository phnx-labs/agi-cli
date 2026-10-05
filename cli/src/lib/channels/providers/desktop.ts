/** Desktop provider: the local native notification centre, with no network or login dependency.
 * Unlike fire-and-forget `notifyDesktop`, it resolves deliverability up front and fails loud, so
 * an undelivered notification never reads as delivered. */
import * as os from 'os';
import { spawnSync } from 'child_process';
import { notifyDesktop } from '../../menubar/notify-desktop.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const NAME = 'desktop';

const TITLE_MAX = 64;

/** Split a message into notification title and body at the first newline; a long single line splits
 * at the title boundary rather than being truncated. */
export function splitDesktopMessage(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const newline = trimmed.indexOf('\n');
  if (newline !== -1) {
    return {
      title: trimmed.slice(0, newline).trim().slice(0, TITLE_MAX),
      body: trimmed.slice(newline + 1).trim(),
    };
  }
  if (trimmed.length <= TITLE_MAX) {
    return { title: trimmed, body: '' };
  }
  const head = trimmed.slice(0, TITLE_MAX);
  const cut = head.lastIndexOf(' ');
  const at = cut > TITLE_MAX / 2 ? cut : TITLE_MAX;
  return { title: trimmed.slice(0, at).trim(), body: trimmed.slice(at).trim() };
}

/** The native notifier for this platform, or undefined. macOS always has osascript; Linux needs
 * notify-send, which a headless box may lack; other platforms have none and must fail loud. Pure
 * and platform-injectable for testing. */
export function desktopNotifier(platform: NodeJS.Platform = os.platform()): string | undefined {
  if (platform === 'darwin') return 'menubar-or-osascript';
  if (platform === 'linux') return 'notify-send';
  return undefined;
}

/** Whether a notification sent now would arrive. Linux probes for notify-send because its ENOENT
 * surfaces asynchronously and is swallowed; macOS needs no probe. */
export function desktopDeliverable(
  platform: NodeJS.Platform = os.platform(),
): { ok: true } | { ok: false; reason: string } {
  const notifier = desktopNotifier(platform);
  if (!notifier) {
    return { ok: false, reason: `no desktop notifier on ${platform} — nothing would be delivered` };
  }
  if (platform === 'linux') {
    const probe = spawnSync('which', ['notify-send'], { stdio: 'ignore' });
    if (probe.status !== 0) {
      return { ok: false, reason: 'notify-send not on PATH — nothing would be delivered' };
    }
  }
  return { ok: true };
}

export const desktopProvider: ChannelProvider = {
  name: NAME,
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    const id = opts.target || os.hostname();

    // Order matters (CI caught it): validate the caller first, then honour dry-run, then probe the
    // platform. An empty message is a caller error everywhere, and `--dry-run` must not depend on
    // the ability to send.
    const { title, body } = splitDesktopMessage(text);
    if (!title) {
      return { ok: false, channel: NAME, id, error: 'refusing to send an empty notification' };
    }

    if (opts.dryRun) {
      // Dry-run validates shape only; it does not prove notifier reachability or delivery.
      return { ok: true, channel: NAME, id };
    }

    const deliverable = desktopDeliverable();
    if (!deliverable.ok) {
      return { ok: false, channel: NAME, id, error: deliverable.reason };
    }

    // Desktop notification APIs are fire-and-forget, so success is enqueueing, not confirmation.
    notifyDesktop({ title, body });
    return { ok: true, channel: NAME, id };
  },
};
