import * as os from 'os';
import { spawnSync } from 'child_process';
import { notifyDesktop } from '../../menubar/notify-desktop.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const NAME = 'desktop';

const TITLE_MAX = 64;

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

export function desktopNotifier(platform: NodeJS.Platform = os.platform()): string | undefined {
  if (platform === 'darwin') return 'menubar-or-osascript';
  if (platform === 'linux') return 'notify-send';
  return undefined;
}

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

    const { title, body } = splitDesktopMessage(text);
    if (!title) {
      return { ok: false, channel: NAME, id, error: 'refusing to send an empty notification' };
    }

    if (opts.dryRun) {

      return { ok: true, channel: NAME, id };
    }

    const deliverable = desktopDeliverable();
    if (!deliverable.ok) {
      return { ok: false, channel: NAME, id, error: deliverable.reason };
    }


    notifyDesktop({ title, body });
    return { ok: true, channel: NAME, id };
  },
};
