import { randomUUID } from 'crypto';
import { ownerNotificationFromContext, type FeedBroadcastContext } from './feed-broadcast.js';
import { resolvePostIdentity } from './feed-post.js';
import { getSessionById, resolveFullSessionId } from './session/db.js';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import type { OwnerNotification } from './owner-notify.js';

interface OwnerMessageOptions {
  agent?: string;
  url?: string;
}

function ownerMessageContext(rawText: string, opts: OwnerMessageOptions): FeedBroadcastContext {
  const identity = resolvePostIdentity({});
  const session = resolveFullSessionId(identity?.sessionId);
  const ticket = session ? getSessionById(session)?.ticketId : undefined;
  const agent = opts.agent ?? identity?.agent;
  return {
    text: rawText,
    level: 'important',
    ...(ticket ? { ticket, ticketUrl: linearIssueUrl(ticket) } : {}),
    ...(agent ? { agent } : {}),
    ...(identity?.host ? { host: identity.host } : {}),
    ...(session ? { session } : {}),
    ...(opts.url ? { links: [opts.url] } : {}),
  };
}

// Each `agents send --to owner` is its own message, so its dedup key is unique per invocation.
export function ownerMessageNotification(rawText: string, opts: OwnerMessageOptions = {}): OwnerNotification {
  const notification = ownerNotificationFromContext(ownerMessageContext(rawText, opts), 'message', `send:${randomUUID()}`);
  if (!notification) throw new Error('Message is empty.');
  return notification;
}
