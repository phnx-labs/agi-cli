import type { NetworkRequest } from './types.js';

/**
 * Minimal HAR 1.2 shapes. We only produce what our request buffer can back —
 * fields the buffer doesn't populate (headers, cookies, bodies, timings) are
 * emitted with the spec-mandated empty defaults or `-1` sentinels so validators
 * still accept the document.
 *
 * Spec: http://www.softwareishard.com/blog/har-12-spec/
 */
interface HarLog {
  version: '1.2';
  creator: { name: string; version: string };
  pages: HarPage[];
  entries: HarEntry[];
}

interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: { onContentLoad: number; onLoad: number };
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: HarTimings;
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: never[];
  headers: never[];
  queryString: Array<{ name: string; value: string }>;
  headersSize: number;
  bodySize: number;
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: never[];
  headers: never[];
  content: { size: number; mimeType: string; text?: string };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

interface HarTimings {
  send: number;
  wait: number;
  receive: number;
}

interface BuildHarOptions {
  creatorName?: string;
  creatorVersion?: string;
}

/**
 * Serialize a buffered `NetworkRequest[]` into a HAR 1.2 document.
 *
 * The buffer only records `url`, `method`, `status`, `mimeType`, `timestamp`.
 * Everything downstream — cookies, headers, bodies, per-phase timings — is
 * unknown and must be emitted as the spec's "unknown" sentinels: `-1` for
 * sizes / timings, empty arrays for cookies / headers. HAR validators accept
 * this shape (browsers do the same for opaque cross-origin responses).
 */
export function buildHar(
  requests: NetworkRequest[],
  opts: BuildHarOptions = {}
): { log: HarLog } {
  const creator = {
    name: opts.creatorName ?? 'agents-cli',
    version: opts.creatorVersion ?? '',
  };

  const startedAt = requests.length > 0 ? Math.min(...requests.map((r) => r.timestamp)) : Date.now();

  const page: HarPage = {
    startedDateTime: new Date(startedAt).toISOString(),
    id: 'page_1',
    title: 'agents browser session',
    pageTimings: { onContentLoad: -1, onLoad: -1 },
  };

  const entries: HarEntry[] = requests.map((r) => {
    const queryString = extractQueryString(r.url);
    const mimeType = r.mimeType ?? '';
    return {
      startedDateTime: new Date(r.timestamp).toISOString(),
      time: -1,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        queryString,
        headersSize: -1,
        bodySize: -1,
      },
      response: {
        status: r.status ?? 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [],
        content: { size: -1, mimeType },
        redirectURL: '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: -1 },
    };
  });

  return {
    log: {
      version: '1.2',
      creator,
      pages: [page],
      entries,
    },
  };
}

/**
 * Pull `?a=1&b=2` off a URL into HAR's `queryString` array. Returns `[]` when
 * the URL has no query or fails to parse (opaque URLs like `data:` shouldn't
 * abort the whole HAR).
 */
function extractQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    const out: Array<{ name: string; value: string }> = [];
    u.searchParams.forEach((value, name) => out.push({ name, value }));
    return out;
  } catch {
    return [];
  }
}
