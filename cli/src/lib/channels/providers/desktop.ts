/**
 * Desktop provider — the local machine's native notification centre.
 *
 * The only channel with no external dependency: no network, no login, no vendor
 * CLI. On the Mac the operator is sitting at it works when every other channel is
 * dead, which is exactly when a blocked agent most needs to reach them.
 *
 * Delivery reuses `notifyDesktop` (lib/menubar/notify-desktop.ts), so a message
 * sent here is attributed to MenubarHelper.app and carries the agents-cli mark —
 * the same path that produces the "agents-cli / <title> / <body>" entries already
 * in Notification Center.
 *
 * WHY THIS ISN'T A THIN PASSTHROUGH: `notifyDesktop` is deliberately
 * fire-and-forget — it spawns detached and swallows every failure so a hiccup can
 * never take the daemon down. A channel provider cannot inherit that: a sink that
 * always reports `ok: true` would make an undelivered notification look delivered,
 * which is the precise class of silent failure this whole subsystem exists to
 * kill. So the provider resolves *deliverability* up front — is there a notifier
 * on this platform at all — and fails loud when there is not. It reports what it
 * can actually know: on a platform with no notifier, nothing will arrive.
 */
import * as os from 'os';
import { spawnSync } from 'child_process';
import { notifyDesktop } from '../../menubar/notify-desktop.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const NAME = 'desktop';

/** Longest title before macOS truncates it in the banner. Keeps the ask readable. */
const TITLE_MAX = 64;

/**
 * Split one message into the notification's title and body.
 *
 * A broadcast sink hands us `composeBroadcastMessage`'s shape — a title line, a
 * blank line, then the body (and a `Sent from …` footer) — so honouring the first
 * newline puts the scannable head in the title and the rest in the body, which is
 * how the existing daemon notifications already read. (Desktop is a plain sink, so
 * the message carries no URLs to split off.)
 *
 * Notification banners show roughly two lines before an ellipsis, so a long
 * single-line message is split at the title boundary rather than truncated away:
 * the head becomes the title and the remainder still arrives in the body.
 */
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
  // Break on the last word boundary inside the limit so the title doesn't end
  // mid-word; fall back to a hard cut when there is no space to break on.
  const head = trimmed.slice(0, TITLE_MAX);
  const cut = head.lastIndexOf(' ');
  const at = cut > TITLE_MAX / 2 ? cut : TITLE_MAX;
  return { title: trimmed.slice(0, at).trim(), body: trimmed.slice(at).trim() };
}

/**
 * Which native notifier this platform wires, or undefined when it wires none.
 *
 * macOS always ships `osascript`, and `notifyDesktop` prefers the branded
 * MenubarHelper when installed and degrades to osascript otherwise — either way
 * something delivers. Linux depends on `notify-send`, which is NOT guaranteed
 * (a headless box typically lacks it), so the platform answer alone is not proof
 * there — see `desktopDeliverable`. Every other platform has no wired notifier at
 * all (`notifyDesktop` is a documented no-op), so sending there must fail loud.
 *
 * Pure and platform-injectable so the gate is testable without spawning.
 */
export function desktopNotifier(platform: NodeJS.Platform = os.platform()): string | undefined {
  if (platform === 'darwin') return 'menubar-or-osascript';
  if (platform === 'linux') return 'notify-send';
  return undefined;
}

/**
 * Whether a notification sent right now would actually arrive.
 *
 * On Linux the notifier is a separate binary that is frequently absent, and
 * `notifyDesktop` spawns it detached — an ENOENT surfaces asynchronously and is
 * swallowed. Reporting `ok` off the platform name alone would therefore mark an
 * undelivered notification as delivered, which is the same silent failure this
 * provider exists to remove, just relocated. So probe for the binary.
 *
 * macOS needs no probe: `osascript` is part of the OS, so the degrade path is
 * always available even when MenubarHelper is not installed.
 */
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
    // `target` is meaningless for a local notification — the recipient is whoever
    // is at this machine — but it is echoed for --json parity with every other
    // provider, and `agents notify` still requires notify.owner.to to be set.
    const id = opts.target || os.hostname();

    // Order matters, and CI caught it: validate the CALLER first, then honour
    // dry-run, and only then probe the platform.
    //
    // An empty message is a caller error on every platform, so it must not be
    // masked by "this box has no notifier" — the specific, actionable error wins.
    // And `--dry-run` means "resolve + build but do not send", so it must not
    // depend on the ability to send; the sibling rush provider likewise returns
    // ok for a dry run before its own `which rush` check (providers/rush.ts).
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
