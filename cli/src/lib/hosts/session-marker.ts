
const MARKER_PREFIX = '@@AGENTS_SESSION_ID ';
const MARKER_SUFFIX = '@@';

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export function sessionIdMarkerLine(sessionId: string): string {
  return `\n${MARKER_PREFIX}${sessionId}${MARKER_SUFFIX}\n`;
}

export function parseSessionIdMarker(text: string): string | null {
  // The last validated frame wins so echoed agent output cannot spoof an earlier identity.
  const last = text.lastIndexOf(MARKER_PREFIX);
  if (last === -1) return null;
  const start = last + MARKER_PREFIX.length;
  const end = text.indexOf(MARKER_SUFFIX, start);
  if (end === -1) return null;
  const id = text.slice(start, end).trim();
  if (!SESSION_ID_RE.test(id)) return null;
  return id;
}
