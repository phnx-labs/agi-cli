/**
 * ONE bounded extractor for the share Worker's error responses.
 *
 * Every share HTTP call (publish PUT, list/revisions GET, delete DELETE)
 * previously threw on `!ok` with only the status code, discarding the JSON error
 * body the Worker actually returns (`{"error":"…"}` for a 400/413/429, plus a
 * `Retry-After` on a 429). The result: a rate-limited or quota-exceeded publish
 * surfaced as a bare "Publish failed (429)" with no reason. This pulls the
 * server's own `error` string and preserves the status + `Retry-After`, so the
 * user sees why.
 *
 * Bounded and safe by construction: it parses at most {@link MAX_ERROR_BODY_BYTES}
 * of the body, only lifts a string `error` field, caps its length, and NEVER
 * surfaces an arbitrary body — a non-JSON or oversized body yields no message,
 * so an HTML error page or a huge payload can't leak into a CLI error string.
 */

/** The raw pieces a caller's fetch wrapper hands in — status plus the (optional)
 * response body text and `Retry-After` header value. */
interface ShareHttpResponse {
  status: number;
  /** The response body text, when the caller read it (only on `!ok` paths). */
  body?: string;
  /** The `Retry-After` header value, when present (a 429 carries it). */
  retryAfter?: string;
}

/** The extracted, bounded error facts. `serverMessage` is present only when the
 * body parsed as JSON carrying a non-empty string `error`. */
interface ShareHttpError {
  status: number;
  serverMessage?: string;
  retryAfter?: string;
}

/** Never parse more than this many chars of a body — a legitimate `{"error":"…"}`
 * is tiny; a larger body is an HTML page or noise we deliberately don't surface. */
export const MAX_ERROR_BODY_BYTES = 4096;

/** Cap the surfaced message so even a pathological (but valid-JSON) `error`
 * string can't blow up the CLI output. */
export const MAX_ERROR_MESSAGE_CHARS = 300;

/**
 * Extract the bounded error facts from a share Worker response. Pulls a string
 * `error` field from a small JSON body, preserves status + `Retry-After`, and
 * never surfaces an arbitrary body.
 */
export function extractShareHttpError(res: ShareHttpResponse): ShareHttpError {
  const out: ShareHttpError = { status: res.status };
  const retryAfter = res.retryAfter?.trim();
  if (retryAfter) out.retryAfter = retryAfter;

  const raw = res.body;
  if (raw && raw.length <= MAX_ERROR_BODY_BYTES) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const err = (parsed as { error?: unknown }).error;
        if (typeof err === 'string' && err.trim()) {
          out.serverMessage = err.trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
        }
      }
    } catch {
      // Not JSON (an HTML error page, a proxy body, truncated bytes) — deliberately
      // surface nothing rather than dump an arbitrary body into the CLI error.
    }
  }
  return out;
}

/**
 * A one-line suffix summarizing the server's structured error, or `''` when the
 * response carried nothing extractable. Appended after the status-bearing prefix
 * a caller already builds, e.g.:
 *   `Publish failed (429) for <url>` + `formatShareHttpErrorDetail(err)`
 *   → `Publish failed (429) for <url> — rate limit exceeded; retry after 37s`
 */
export function formatShareHttpErrorDetail(err: ShareHttpError): string {
  const parts: string[] = [];
  if (err.serverMessage) parts.push(err.serverMessage);
  if (err.retryAfter) parts.push(`retry after ${err.retryAfter}s`);
  return parts.length ? ` — ${parts.join('; ')}` : '';
}
