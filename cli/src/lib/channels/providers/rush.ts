/**
 * Channel providers formerly backed by the Rush daemon's live gateways.
 *
 * The desktop-era `rush message send` (iMessage) and `rush send --channel`
 * (Slack/Telegram/Discord) commands were removed with the daemon in the
 * thin-client trim (PHNX-3839/3933). This module now delivers directly:
 *
 *   - **imessage:** `osascript` → Messages.app (macOS only; Linux boxes
 *     rely on the peer-forward in owner-forward.ts to reach a macOS peer).
 *   - **slack:** Slack Web API `chat.postMessage` via `fetch()`, reading
 *     `SLACK_BOT_TOKEN` from env or the `webhooks` secrets bundle.
 *   - **telegram / discord:** error — no direct transport; openclaw-telegram
 *     is available as a separate provider for Telegram.
 */
import { execFile } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const execFileAsync = promisify(execFile);

export type RushChannel = 'telegram' | 'imessage' | 'slack' | 'discord';
export const RUSH_CHANNELS: RushChannel[] = ['telegram', 'imessage', 'slack', 'discord'];

// ── iMessage via osascript ──────────────────────────────────────────────

/** Build the osascript argv for sending an iMessage. */
export function buildImessageOsascriptArgs(text: string, phone: string): string[] {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "Messages"',
    `  set targetBuddy to buddy "${phone}" of (first account whose service type is iMessage)`,
    `  send "${escaped}" to targetBuddy`,
    'end tell',
  ].join('\n');
  return ['-e', script];
}

async function sendImessage(text: string, opts: SendOptions): Promise<SendResult> {
  const channel = 'imessage';
  if (opts.dryRun) return { ok: true, channel, id: opts.target };

  if (platform() !== 'darwin') {
    return { ok: false, channel, id: opts.target, error: 'iMessage requires macOS (peer-forward handles Linux delivery)' };
  }
  if ((opts.attachments?.length ?? 0) > 0) {
    return { ok: false, channel, id: opts.target, error: 'iMessage attachments not supported via osascript' };
  }
  try {
    await execFileAsync('osascript', buildImessageOsascriptArgs(text, opts.target), { timeout: 10_000 });
    return { ok: true, channel, id: opts.target };
  } catch (err) {
    return { ok: false, channel, id: opts.target, error: (err as Error).message };
  }
}

// ── Slack via Web API ───────────────────────────────────────────────────

let _slackToken: string | undefined;

function resolveSlackToken(): string | undefined {
  if (_slackToken) return _slackToken;

  // 1. Environment variable (set by `secrets exec` or the daemon).
  if (process.env.SLACK_BOT_TOKEN) {
    _slackToken = process.env.SLACK_BOT_TOKEN;
    return _slackToken;
  }

  // 2. Secrets bundle — the webhook receiver bundle carries SLACK_BOT_TOKEN
  //    when a Slack app is configured for this fleet.
  try {
    // Dynamic import to avoid a hard dependency on the secrets subsystem in
    // contexts where it is unavailable (CI, containers without a secrets store).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readAndResolveBundleEnvSync } = require('../../secrets-client.js') as {
      readAndResolveBundleEnvSync: (name: string, opts?: Record<string, unknown>) => { env: Record<string, string> };
    };
    const { env } = readAndResolveBundleEnvSync('webhooks', { caller: 'slack-provider', agentOnly: true });
    if (env.SLACK_BOT_TOKEN) {
      _slackToken = env.SLACK_BOT_TOKEN;
      return _slackToken;
    }
  } catch {
    // Bundle missing, store locked, or secrets CLI not available — not fatal.
  }
  return undefined;
}

/** Build the Slack chat.postMessage payload (exported for tests). */
export function buildSlackPayload(channel: string, text: string, thread?: string): Record<string, string> {
  const payload: Record<string, string> = { channel, text };
  if (thread) payload.thread_ts = thread;
  return payload;
}

async function sendSlack(text: string, opts: SendOptions): Promise<SendResult> {
  const channel = 'slack';
  if (opts.dryRun) return { ok: true, channel, id: opts.target };

  const token = resolveSlackToken();
  if (!token) {
    return {
      ok: false,
      channel,
      id: opts.target,
      error: 'No SLACK_BOT_TOKEN — set it in env or the webhooks secrets bundle',
    };
  }

  try {
    const payload = buildSlackPayload(opts.target, text, opts.thread);
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as { ok?: boolean; error?: string; ts?: string };
    if (!body.ok) {
      return { ok: false, channel, id: opts.target, error: `Slack API: ${body.error ?? 'unknown error'}` };
    }
    return { ok: true, channel, id: opts.target };
  } catch (err) {
    return { ok: false, channel, id: opts.target, error: (err as Error).message };
  }
}

// ── Unsupported (daemon-era only) ───────────────────────────────────────

function unsupportedProvider(name: RushChannel): ChannelProvider {
  return {
    name,
    async send(_text: string, opts: SendOptions): Promise<SendResult> {
      if (opts.dryRun) return { ok: true, channel: name, id: opts.target };
      return {
        ok: false,
        channel: name,
        id: opts.target,
        error: `${name} delivery requires the Rush daemon (removed); use openclaw-telegram for Telegram`,
      };
    },
  };
}

// ── Provider registry ───────────────────────────────────────────────────

const PROVIDERS: Record<RushChannel, ChannelProvider> = {
  imessage: { name: 'imessage', send: sendImessage },
  slack: { name: 'slack', send: sendSlack },
  telegram: unsupportedProvider('telegram'),
  discord: unsupportedProvider('discord'),
};

export const rushProviders: ChannelProvider[] = RUSH_CHANNELS.map((ch) => PROVIDERS[ch]);
