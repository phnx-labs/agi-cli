import type { OpenBlock } from './feed/feed.js';
import type { SendResult } from './channels/registry.js';
import {
  describeOwnerResult,
  postOwnerNotification,
  resolveOwnerCredential,
  OwnerNotSignedInError,
  type OwnerNotification,
} from './owner-notify.js';

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

export async function sendToOwner(
  notification: OwnerNotification,
  options: { dryRun?: boolean } = {},
): Promise<SendResult> {
  try {
    if (options.dryRun) {
      if (!resolveOwnerCredential()) throw new OwnerNotSignedInError();
      return { ok: true, channel: 'owner', id: notification.dedupKey, body: notification.body };
    }
    const result = await postOwnerNotification(notification);
    const partial = result.skipped.length > 0 && result.delivered.length + result.queued.length > 0;
    const reachedNobody = result.suppressed === null && result.delivered.length + result.queued.length === 0;
    return {
      ok: !reachedNobody,
      channel: 'owner',
      id: result.dispatchId ?? notification.dedupKey,
      body: notification.body,
      msgId: describeOwnerResult(result),
      ...(partial || reachedNobody ? { error: describeOwnerResult(result) } : {}),
    };
  } catch (err) {
    return { ok: false, channel: 'owner', id: notification.dedupKey, error: (err as Error).message };
  }
}

export async function notifyUrgentBlock(
  block: OpenBlock,
  options: { dryRun?: boolean } = {},
): Promise<NotifyResult> {
  if (block.notifiedAt) {
    return { ok: true, skipped: true };
  }

  if (options.dryRun) {
    return { ok: true, skipped: true };
  }

  const q = block.questions[0];
  const result = await sendToOwner({
    event: 'needs_you',
    title: q?.header?.trim() || 'Agent needs input',
    body: formatUrgentBlockMessage(block),
    sessionId: block.sessionId,
    ...(block.ticket ? { ticket: block.ticket } : {}),
    dedupKey: `block:${block.blockId}`,
    source: { device: block.host },
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
