/** Parse the `agents://` deep-link scheme. An artifact embeds `agents://session/<id>` (optionally
 * `?host=<name>`); the OS hands it to the registered handler (register.ts), which runs `agents
 * _callback <url>`. Strict: only `agents://session/<valid-id>`; the id goes as argv, never shell. */

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

/** Session-id shapes accepted from a deep link: hex short-id (>=6 chars), UUID (optionally
 * `session_`-prefixed), OpenCode `ses_<ulid>`, or `ag-...-<8hex>` tmux alias. Mirrors
 * `looksLikeSessionId` without importing it, to keep `open` cold-start cheap. */
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

/** Parse an `agents://...` URL into an AgentsSessionLink, or an AgentsUrlError with a reason. Never
 * throws. */
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
