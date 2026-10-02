/**
 * Parse the `agents://` deep-link scheme.
 *
 * A rendered artifact (a plan or report) embeds `agents://session/<id>` in its
 * provenance line. Clicking it hands the URL to the OS, which routes it to the
 * registered handler (see register.ts) that runs the machine-only `agents _callback
 * <url>` verb (`open` remains a hidden back-compat alias). This module turns that URL
 * into a validated {@link AgentsSessionLink} the resume dispatcher consumes.
 *
 * Parsing is deliberately strict: the session id is the only thing that ever
 * reaches a child process, and the `_callback` command passes it as argv (never
 * interpolated into a shell), so a hostile URL cannot inject a command. Anything
 * that is not `agents://session/<valid-id>` is rejected with a reason.
 *
 * URL shape:
 *   agents://session/<id>              — resume <id>, owner host resolved from the id
 *   agents://session/<id>?host=<name>  — the same, with a routing hint
 */

interface AgentsSessionLink {
  kind: 'session';
  /** The session id (or short-id/alias) to resume. */
  id: string;
  /** Optional owning-host hint; resume self-resolves the owner from the id regardless. */
  host?: string;
}

interface AgentsUrlError {
  error: string;
}

/**
 * Session-id shapes accepted from a deep link. Mirrors `looksLikeSessionId`
 * (lib/session/discover.ts) WITHOUT importing the heavy session module, so the
 * `open` command stays cold-start cheap: a bare hex short-id/prefix (>=6 chars),
 * a UUID (optionally `session_`-prefixed), a `ses_<ulid>` (OpenCode), or an
 * `ag-…-<8hex>` tmux alias. The upper length bound is a sanity cap, not a format
 * rule.
 */
const HEX_ID = /^[0-9a-f-]{6,}$/i;
const SES_ULID = /^ses_[0-9a-hjkmnp-tv-z]{26}$/i;
import { AG_TMUX_NAME_RE as AG_ALIAS } from '@phnx-labs/sessions-cli/reader';
const HOST_HINT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isDeepLinkSessionId(raw: string): boolean {
  const id = (raw ?? '').trim();
  if (!id || id.length > 128) return false;
  const bare = id.replace(/^session_/i, '');
  return HEX_ID.test(bare) || SES_ULID.test(id) || AG_ALIAS.test(id);
}

/**
 * Parse an `agents://…` URL into a {@link AgentsSessionLink}, or return an
 * {@link AgentsUrlError} with a human reason. Never throws.
 */
export function parseAgentsUrl(input: string): AgentsSessionLink | AgentsUrlError {
  const raw = (input ?? '').trim();
  if (!raw) return { error: 'empty URL' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `not a URL: ${truncate(raw)}` };
  }

  if (url.protocol !== 'agents:') {
    return { error: `unsupported scheme: ${url.protocol}// (expected agents://)` };
  }

  // agents://session/<id> → hostname="session", pathname="/<id>". The authority
  // is compared case-insensitively because some browsers normalize its casing.
  const verb = url.hostname.toLowerCase();
  if (verb !== 'session') {
    return { error: `unknown agents:// target "${verb || '(none)'}" (expected agents://session/<id>)` };
  }

  let id: string;
  try {
    id = decodeURIComponent(url.pathname.replace(/^\/+/, '')).trim();
  } catch {
    return { error: 'malformed session id encoding' };
  }
  if (!isDeepLinkSessionId(id)) {
    return { error: `invalid session id: ${truncate(id) || '(none)'}` };
  }

  const hostParam = url.searchParams.get('host')?.trim();
  const host = hostParam && HOST_HINT.test(hostParam) ? hostParam : undefined;

  return host ? { kind: 'session', id, host } : { kind: 'session', id };
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
