/**
 * Compose an owner-bound phone ping through the SAME shaper `agents feed post`
 * uses, so `agents send --to owner` stop shipping a raw body
 * dump (PHNX-3698).
 *
 * Before this, an owner send delivered the body verbatim: a long wall of prose,
 * a `TEAM-N` key iMessage renders as dead text, and no way back to the session.
 * Routing the body through {@link composeBroadcastMessage} makes an owner ping
 * identical to an important feed post of the same event — short-shaped body,
 * every ticket key linkified to its Linear URL, and the current session's
 * `…/console/sessions/<id>` page as a tappable crumb.
 *
 * The session/agent/host are resolved the same way a feed post resolves them
 * ({@link resolvePostIdentity} — the pid-registry / env walk), so a `notify`
 * run inside an agent session inherits that session with no flag. Outside a
 * session (a human at a shell) identity is undefined: the ping still gets
 * short-shaping and ticket linkification, just no session crumb.
 */
import { composeBroadcastMessage, type FeedBroadcastContext } from './feed-broadcast.js';
import { resolvePostIdentity } from './feed-post.js';
import { getSessionById, resolveFullSessionId } from './session/db.js';
import { linearIssueUrl } from './session/linear.js';
import type { SinkMessageFormat } from './sink-format.js';

export interface OwnerMessageOptions {
  /** Scannable subject line, when the caller has one (feed post does; notify does not). */
  title?: string;
  /** Explicit session id (`--session`); otherwise resolved from the run environment. */
  sessionId?: string;
  /**
   * Rendering vocabulary for this body (PHNX-3698). Slack `mrkdwn` linkifies the
   * ticket keys and the session crumb as `<url|label>`; `plain` (the default)
   * keeps the human sentence with no URLs, for iMessage / owner-scoped rush.
   * The owner fan-out passes one format per destination.
   */
  format?: SinkMessageFormat;
}

/**
 * Resolve the run identity into the broadcast context an owner ping is built
 * from — the shared shape a `feed post` uses. Pure except for the identity/index
 * reads that {@link resolvePostIdentity} / {@link getSessionById} already perform
 * for feed posts. Built ONCE so the owner fan-out can render it in more than one
 * format (Slack vs iMessage) without re-walking the pid registry per destination.
 */
export function ownerMessageContext(rawText: string, opts: OwnerMessageOptions = {}): FeedBroadcastContext {
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

/**
 * Shape a raw owner-send body into the composed broadcast message. `format`
 * decides how links surface — `plain` (default) for iMessage / owner-scoped rush,
 * `mrkdwn` for a Slack owner destination (PHNX-3698).
 */
export function composeOwnerMessage(rawText: string, opts: OwnerMessageOptions = {}): string {
  return composeBroadcastMessage(ownerMessageContext(rawText, opts), opts.format ?? 'plain');
}

/**
 * A per-format composer bound to ONE resolved context — the shape the owner
 * fan-out wants (PHNX-3698). `agents send --to owner` build
 * this once, use `compose('plain')` for the envelope's display body, and hand
 * `compose` to `sendToOwner` so each policy destination re-renders in its own
 * format without re-walking the pid registry.
 */
export function ownerMessageComposer(
  rawText: string,
  opts: OwnerMessageOptions = {},
): (format: SinkMessageFormat) => string {
  const ctx = ownerMessageContext(rawText, opts);
  return (format: SinkMessageFormat) => composeBroadcastMessage(ctx, format);
}
