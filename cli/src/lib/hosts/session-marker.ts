/** Relate a remote-created session id back to the launching agent. Only Claude takes a forced
 * `--session-id`, so `--emit-session-id` makes the remote print a one-line stdout sentinel that
 * rides the followed log (no extra SSH); the parser takes the last occurrence. */

const MARKER_PREFIX = '@@AGENTS_SESSION_ID ';
const MARKER_SUFFIX = '@@';

/** Only characters a real agent session id can hold — no marker bytes, no spaces. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** The line the remote prints so the launcher can capture its coined session id, newline-framed
 * on both sides so it lands on its own line. */
export function sessionIdMarkerLine(sessionId: string): string {
  return `\n${MARKER_PREFIX}${sessionId}${MARKER_SUFFIX}\n`;
}

/** Extract the session id from followed remote output, or null. Scans for the last marker so an
 * earlier echo cannot mask the real sentinel, and validates the charset so a malformed frame
 * yields null rather than a bogus id. */
export function parseSessionIdMarker(text: string): string | null {
  const last = text.lastIndexOf(MARKER_PREFIX);
  if (last === -1) return null;
  const start = last + MARKER_PREFIX.length;
  const end = text.indexOf(MARKER_SUFFIX, start);
  if (end === -1) return null;
  const id = text.slice(start, end).trim();
  if (!SESSION_ID_RE.test(id)) return null;
  return id;
}
