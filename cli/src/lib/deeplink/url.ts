
interface AgentsSessionLink {
  kind: 'session';
  id: string;
  host?: string;
}

interface AgentsUrlError {
  error: string;
}

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
