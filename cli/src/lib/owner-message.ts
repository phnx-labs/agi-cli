/** Composes an owner-bound phone ping through the SAME shaper `agents feed post` uses (PHNX-3698);
 * before, owner sends delivered the raw body (prose wall, dead `TEAM-N` key, no way back). Now:
 * short body, Linear-linked keys, session crumb. Identity via {@link resolvePostIdentity}. */
import { composeBroadcastMessage, type FeedBroadcastContext } from './feed-broadcast.js';
import { resolvePostIdentity } from './feed-post.js';
import { getSessionById, resolveFullSessionId } from './session/db.js';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import type { SinkMessageFormat } from './sink-format.js';

interface OwnerMessageOptions {
  /** Scannable subject line, when the caller has one (feed post does; notify does not). */
  title?: string;
  /** Explicit session id (`--session`); otherwise resolved from the run environment. */
  sessionId?: string;
  /** Rendering vocabulary for this body (PHNX-3698). Slack `mrkdwn` linkifies ticket keys and the
   * session crumb as `<url|label>`; `plain` (default) has no URLs, for iMessage / owner-scoped
   * rush. The owner fan-out passes one format per destination. */
  format?: SinkMessageFormat;
}

/** Resolves the run identity into the broadcast context an owner ping is built from (the shape
 * `feed post` uses). Built ONCE so the fan-out can render several formats (Slack vs iMessage)
 * without re-walking the pid registry per destination. */
function ownerMessageContext(rawText: string, opts: OwnerMessageOptions = {}): FeedBroadcastContext {
  const identity = resolvePostIdentity({ sessionId: opts.sessionId });
  // A footer crumb that would 404 (an 8-char short id) is upgraded to the full
  // indexed id so the console URL resolves; a full/native id passes through.
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

/** Shapes a raw owner-send body into the composed broadcast message. `format` decides how links
 * surface: `plain` (default) for iMessage / owner-scoped rush, `mrkdwn` for a Slack owner
 * destination (PHNX-3698). */
export function composeOwnerMessage(rawText: string, opts: OwnerMessageOptions = {}): string {
  return composeBroadcastMessage(ownerMessageContext(rawText, opts), opts.format ?? 'plain');
}

/** A per-format composer bound to ONE resolved context, for the owner fan-out (PHNX-3698): `agents
 * send --to owner` builds it once, uses `compose('plain')` for the envelope body and hands
 * `compose` to `sendToOwner` so each destination re-renders without re-walking the pid registry. */
export function ownerMessageComposer(
  rawText: string,
  opts: OwnerMessageOptions = {},
): (format: SinkMessageFormat) => string {
  const ctx = ownerMessageContext(rawText, opts);
  return (format: SinkMessageFormat) => composeBroadcastMessage(ctx, format);
}
