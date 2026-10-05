/** Owner notifier: the one seam for "ping the human" (urgent feed blocks, monitor `notify`, `agents
 * send --to owner`) via `lookupTransport`. Recipient from `humans.yaml`. Best-effort: failures are
 * returned; `die()`-capable resolveTransport is avoided (it would kill the daemon). */
import type { OpenBlock } from './feed/feed.js';
import type { Meta } from './types.js';
import { readMeta } from './state.js';
import { getOwnerNotifyDestinationsFromHumans } from './humans.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import { lookupTransport } from './channels/resolve.js';
import { forwardOwnerNotifyToPeer } from './channels/owner-forward.js';
import type { SendResult } from './channels/registry.js';
import { sinkMessageFormat, type SinkMessageFormat } from './sink-format.js';

export interface OwnerNotifyOptions {
  /** Config source (defaults to `readMeta()`); lets callers/tests inject it. */
  meta?: Meta;
  /** Override the owner channel resolved from humans.yaml. */
  channel?: string;
  /** Override the owner target resolved from humans.yaml. */
  target?: string;
  /** Resolve + build the delivery but do not actually send. */
  dryRun?: boolean;
  thread?: string;
  attachments?: string[];
  from?: string;
  /** Per-destination body composer (PHNX-3698): only Slack renders labeled links, so each
   * destination gets the body shaped for its resolved provider. Absent when the body is final
   * (urgent blocks, monitor summaries): `text` goes verbatim to every channel. */
  composeForFormat?: (format: SinkMessageFormat) => string;
}

export interface NotifyResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export function formatUrgentBlockMessage(block: OpenBlock): string {
  const q = block.questions[0];
  const header = q?.header ? `[${q.header}] ` : '';
  const text = q?.text ?? 'Agent needs input';
  const host = block.host ? ` on ${block.host}` : '';
  const cls = block.blockClass ?? 'approval';
  const cost = block.costOfDelay ?? 'low';
  return `URGENT ${cls.toUpperCase()}${host}: ${header}${text} (cost: ${cost}, id: ${block.blockId})`;
}

/** Builds openclaw argv for a Telegram send (the openclaw-telegram provider and its tests).
 * `target` is required: the caller always resolves the recipient; no hardcoded default number. */
export function buildOpenClawNotifyArgs(
  text: string,
  opts: { target: string; channel?: string; account?: string },
): string[] {
  const channel = opts.channel ?? 'telegram';
  const account = opts.account ?? 'default';
  return [
    'message',
    'send',
    '--channel',
    channel,
    '--account',
    account,
    '--target',
    opts.target,
    '--message',
    text,
  ];
}

/** Delivers a message to the owner via the one channel seam; `channel`/`target` default to
 * humans.yaml. Failures return a clean `SendResult`, not an ENOENT. If THIS box can't reach the
 * owner (macOS-only channel, headless Linux, PHNX-3303), it forwards over SSH to a capable peer. */
export async function sendToOwner(text: string, options: OwnerNotifyOptions = {}): Promise<SendResult> {
  const meta = options.meta ?? readMeta();
  const canonical = getOwnerNotifyDestinationsFromHumans();
  const legacy = meta.notify?.owner ? [meta.notify.owner] : [];
  const configured = canonical.length > 0 ? canonical : legacy;
  const destinations = options.target
    ? [{ channel: options.channel ?? configured[0]?.channel, to: options.target }]
    : options.channel
      ? [configured.find((dest) => dest.channel === options.channel) ?? {
          channel: options.channel,
          to: configured[0]?.to,
        }]
      : configured;
  const addressable = destinations.filter((dest): dest is { channel: string; to: string } => Boolean(dest.channel && dest.to));
  if (addressable.length === 0) {
    return {
      ok: false,
      channel: options.channel ?? 'unknown',
      id: options.target ?? '',
      error: 'No addressable owner channel configured in humans.yaml or legacy notify.owner',
    };
  }
  registerBuiltinProviders();
  const deliveries: SendResult[] = [];
  for (const { channel, to: target } of addressable) {
    const { provider, providerName, error } = lookupTransport(channel, meta);
    // Each destination gets the body shaped for the provider it ACTUALLY delivers through (the
    // `notify.transports` remap), so Slack gets `<url|label>` links while a sibling iMessage copy
    // stays plain (PHNX-3698). Without a composer the caller's final `text` goes to every channel.
    const body = options.composeForFormat
      ? options.composeForFormat(sinkMessageFormat(providerName))
      : text;
    let result: SendResult;
    try {
      result = provider
        ? await provider.send(body, {
            target,
            ownerScoped: options.target === undefined,
            dryRun: options.dryRun,
            thread: options.thread,
            attachments: options.attachments,
            from: options.from,
          })
        : { ok: false, channel, id: target, error };
    } catch (err) {
      result = { ok: false, channel, id: target, error: (err as Error).message };
    }
    // A dry-run never delivers, and an override target is an explicit recipient
    // (not the fleet-wide owner) — neither should hop to a peer.
    if (!result.ok && !options.dryRun && options.target === undefined) {
      if (options.attachments?.length) {
        result = {
          ...result,
          error: `${result.error ?? 'local delivery failed'}; owner attachments cannot be forwarded to another device`,
        };
      } else {
        result = await forwardOwnerNotifyToPeer(body, channel, target, meta, {
          envelope: { thread: options.thread, from: options.from },
        }) ?? result;
      }
    }
    // Echo the exact per-destination body delivered, so a caller (and
    // `agents send --to owner --dry-run --json`) can see Slack got the labeled-link
    // variant and iMessage the plain one — the observable proof of PHNX-3698.
    deliveries.push({ ...result, body });
  }
  if (deliveries.length === 1) return deliveries[0];
  const failures = deliveries.filter((result) => !result.ok);
  return {
    ok: deliveries.some((result) => result.ok),
    channel: 'owner',
    id: deliveries.map((result) => `${result.channel}:${result.id}`).join(','),
    ...(failures.length > 0
      ? { error: failures.map((result) => `${result.channel}: ${result.error ?? 'failed'}`).join('; ') }
      : {}),
    deliveries,
  };
}

export async function notifyUrgentBlock(
  block: OpenBlock,
  options: OwnerNotifyOptions = {},
): Promise<NotifyResult> {
  if (block.notifiedAt) {
    return { ok: true, skipped: true };
  }

  if (options.dryRun) {
    return { ok: true, skipped: true };
  }

  const result = await sendToOwner(formatUrgentBlockMessage(block), options);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
