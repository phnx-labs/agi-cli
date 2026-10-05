import { composeBroadcastMessage, type FeedBroadcastContext } from './feed-broadcast.js';
import { resolvePostIdentity } from './feed-post.js';
import { getSessionById, resolveFullSessionId } from './session/db.js';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import type { SinkMessageFormat } from './sink-format.js';

interface OwnerMessageOptions {
  title?: string;
  sessionId?: string;
  format?: SinkMessageFormat;
}

function ownerMessageContext(rawText: string, opts: OwnerMessageOptions = {}): FeedBroadcastContext {
  // Resolve a short session id and its identity once, then render that context for every destination.
  const identity = resolvePostIdentity({ sessionId: opts.sessionId });
  const session = resolveFullSessionId(identity?.sessionId);
  const ticket = session ? getSessionById(session)?.ticketId : undefined;
  return {
    ...(opts.title?.trim() ? { title: opts.title.trim() } : {}),
    text: rawText,
    level: 'important',
    ...(ticket ? { ticket, ticketUrl: linearIssueUrl(ticket) } : {}),
    ...(identity?.agent ? { agent: identity.agent } : {}),
    ...(identity?.host ? { host: identity.host } : {}),
    ...(session ? { session } : {}),
  };
}

export function composeOwnerMessage(rawText: string, opts: OwnerMessageOptions = {}): string {
  return composeBroadcastMessage(ownerMessageContext(rawText, opts), opts.format ?? 'plain');
}

export function ownerMessageComposer(
  rawText: string,
  opts: OwnerMessageOptions = {},
): (format: SinkMessageFormat) => string {
  const ctx = ownerMessageContext(rawText, opts);
  return (format: SinkMessageFormat) => composeBroadcastMessage(ctx, format);
}
