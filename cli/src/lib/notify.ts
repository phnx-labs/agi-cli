/**
 * Owner notifier — the one seam for "ping the human" messages.
 *
 * Every human-facing owner notification (feed urgent-block dispatch, monitor
 * `notify` action, `agents notify`) funnels through the single channel seam:
 * `lookupTransport(channel, meta).provider.send(text, opts)`. The recipient comes
 * from `humans.yaml` — never a hardcoded chat id — so changing the
 * owner is honoured by every path at once. `notify.transports` picks the actual
 * provider per host (rush telegram on zion, openclaw-telegram on mac-mini).
 * Best-effort: a delivery failure is returned to the caller, never thrown, so a
 * notification hiccup never blocks the agent. That is why this module resolves
 * with `lookupTransport` and not the `die()`-capable `resolveTransport` — the
 * monitor daemon and the feed-dispatch loop call in here, and `process.exit()`
 * would take them down on a typo'd channel name, bypassing their try/catch.
 */
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
  /**
   * Per-destination body composer (PHNX-3698). The owner policy fans one alert
   * out to several channels (imessage + slack, …), and only Slack can render a
   * labeled link — so when set, each destination gets the body shaped for its
   * OWN resolved provider (Slack → `mrkdwn` `<url|label>` links, everything else
   * → `plain` the human sentence, no URLs) instead of the single `text` going to
   * every channel. Absent for callers whose body is already final (urgent
   * blocks, monitor summaries): `text` is delivered verbatim to every channel.
   */
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

/**
 * Build openclaw argv for a Telegram send (used by the openclaw-telegram
 * provider and its tests). `target` is required — the recipient is always
 * resolved by the caller, never defaulted to a hardcoded number here.
 */
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

/**
 * Deliver a message to the configured owner through the one channel seam.
 * `channel`/`target` default to the normal owner channel in humans.yaml; `notify.transports`
 * selects the provider per host. A missing owner config or a delivery failure
 * (e.g. openclaw not on PATH) returns a clean `SendResult` error — never a raw
 * ENOENT — so callers surface a consistent, best-effort failure.
 *
 * When local delivery fails because THIS box structurally cannot reach the owner
 * — the rush-backed owner channel is macOS-only, so a headless Linux worker can
 * never ring the phone (PHNX-3303) — the notify is forwarded over SSH to a
 * capable fleet peer that DOES have the provider, mirroring the reroute
 * `agents message` already uses. A successful forward is returned as the result;
 * if no capable peer is reachable, the original clean local error stands.
 */
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
    // Each destination gets the body shaped for the provider it ACTUALLY
    // delivers through (the same `notify.transports` remap `lookupTransport`
    // applied), so a Slack destination turns its ticket keys + session crumb
    // into `<url|label>` links while a sibling iMessage copy stays plain
    // (PHNX-3698). Without a composer the caller's already-final `text` is used
    // for every channel.
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
    // `agents notify --dry-run --json`) can see Slack got the labeled-link
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
