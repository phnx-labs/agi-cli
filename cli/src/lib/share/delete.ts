// The delete path for `agents artifacts share delete` / `agents artifacts unshare` — an authed DELETE
// to the Worker, which already implements it (worker-template.ts). Mirrors
// publish.ts: pure target-resolution logic is exported for tests, the network
// calls (a status check + a delete) sit behind an injectable DI seam.
//
// The Worker's R2 delete is idempotent — DELETE on a key that never existed still
// returns `{"ok":true}` — so `{"ok":true}` alone is never proof of a takedown.
// Every delete here is followed by a status check that must observe 404 before
// the operation is reported as successful.

import { type ShareConfig } from './config.js';
import { resolveShareBackend, type ResolveShareBackendOpts } from './backend.js';
import { buildShareKey, resolveShareUsername } from './publish.js';
import { extractShareHttpError, formatShareHttpErrorDetail } from './http-error.js';

/** DI seam for tests — override the real HTTP DELETE. `body`/`retryAfter` carry
 * the Worker's error response (read only on `!ok`) so a failed delete surfaces
 * WHY, via the bounded {@link extractShareHttpError}. */
export type DeleteFn = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ ok: boolean; status: number; body?: string; retryAfter?: string }>;

/** DI seam for tests — override the real HTTP existence check (HEAD). */
export type CheckFn = (url: string) => Promise<{ status: number }>;

/** DI seam for tests — override the real HTTP GET of the revisions listing route. */
export type RevisionsFetchFn = (url: string) => Promise<{ status: number; contentType: string; body: string }>;

interface DeleteEndpoint {
  baseUrl: string;
  token: string;
}

interface ResolvedShareTarget {
  /** R2 object key for the page, `<user>/<slug>`. */
  key: string;
  /** R2 object key for the sibling OG cover, `<user>/<slug>.png`. */
  coverKey: string;
}

/**
 * Normalize any of the three accepted target forms to the R2 key that publish
 * would have written:
 *   - a full share URL: `https://share.getrush.ai/<user>/<slug>`
 *   - `<user>/<slug>`
 *   - a bare `<slug>` — resolved against the caller's own namespace exactly as
 *     `publishToEndpoint` resolves it at publish time (resolveShareUsername +
 *     buildShareKey), so a bare slug always targets *your* published page.
 *
 * The URL and `<user>/<slug>` forms are taken as already the exact key a prior
 * publish produced (no re-sanitizing) — only the bare-slug form runs through
 * `buildShareKey`, because that's the one case where the slug hasn't already
 * been normalized by a publish.
 */
export async function resolveDeleteTarget(
  target: string,
  opts: { githubUser?: string } = {},
): Promise<ResolvedShareTarget> {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('Share target is empty.');

  let key: string;
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const segments = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (segments.length < 2) {
      throw new Error(`Not a share page URL (expected .../<user>/<slug>): ${trimmed}`);
    }
    key = segments.slice(0, 2).join('/');
  } else if (trimmed.includes('/')) {
    const segments = trimmed.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new Error(`Expected <user>/<slug>, got: ${trimmed}`);
    }
    key = segments.join('/');
  } else {
    const username = await resolveShareUsername(opts);
    key = buildShareKey(username, trimmed);
  }

  return { key, coverKey: `${key}.png` };
}

async function defaultCheck(url: string): Promise<{ status: number }> {
  const res = await fetch(url, { method: 'HEAD' });
  return { status: res.status };
}

async function defaultDelete(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; body?: string; retryAfter?: string }> {
  const res = await fetch(url, { method: 'DELETE', headers });
  if (res.ok) return { ok: true, status: res.status };
  const body = await res.text().catch(() => undefined);
  return { ok: false, status: res.status, body, retryAfter: res.headers.get('retry-after') ?? undefined };
}

async function defaultRevisionsFetch(url: string): Promise<{ status: number; contentType: string; body: string }> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
}

/**
 * List the R2 keys of a slug's retained revisions via the Worker's
 * `?revisions=json` route (worker-template.ts `renderRevisions`). Best-effort:
 * any failure to reach or parse the route (an endpoint provisioned before
 * revisions existed, a network blip) yields an empty list rather than
 * throwing — purging revisions is a safety improvement on top of the primary
 * delete contract (take the canonical page down), never a reason to fail it.
 */
async function listRevisionKeys(
  endpoint: DeleteEndpoint,
  key: string,
  fetchRevisions: RevisionsFetchFn,
): Promise<string[]> {
  try {
    const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/${key}?revisions=json`;
    const res = await fetchRevisions(url);
    if (res.status !== 200 || !/application\/json/i.test(res.contentType)) return [];
    const data = JSON.parse(res.body) as { revisions?: Array<{ key?: unknown }> };
    if (!Array.isArray(data.revisions)) return [];
    return data.revisions.map((r) => String(r.key ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

interface DeleteObjectResult {
  key: string;
  url: string;
  /** Whether the object resolved (non-404) before the DELETE was issued. */
  existedBefore: boolean;
  /** Whether the Worker's DELETE call itself reported ok. */
  deleted: boolean;
  /** The postcondition: a follow-up check resolved 404 after the DELETE. */
  verified404: boolean;
}

/**
 * Delete one R2 object behind the share Worker and assert the postcondition.
 * `{"ok":true}` from the Worker is not evidence a page came down — R2 delete is
 * idempotent, so a DELETE on a key that was never there also returns `ok:true`.
 * This checks existence before (so callers can tell "deleted" from "was never
 * there") and re-checks after (so callers can tell "deleted" from "still public").
 */
export async function deleteObject(
  endpoint: DeleteEndpoint,
  key: string,
  opts: { deleter?: DeleteFn; checker?: CheckFn } = {},
): Promise<DeleteObjectResult> {
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/${key}`;
  const check = opts.checker ?? defaultCheck;
  const del = opts.deleter ?? defaultDelete;

  const before = await check(url);
  const existedBefore = before.status !== 404;

  const r = await del(url, { authorization: `Bearer ${endpoint.token}` });
  if (!r.ok) {
    const detail = formatShareHttpErrorDetail(
      extractShareHttpError({ status: r.status, body: r.body, retryAfter: r.retryAfter }),
    );
    throw new Error(
      `Delete failed (${r.status}) for ${url}${detail}. Check the bearer (Phoenix session or WRITE_TOKEN), or that 'agents artifacts setup' completed.`,
    );
  }

  const after = await check(url);
  const verified404 = after.status === 404;

  return { key, url, existedBefore, deleted: r.ok, verified404 };
}

interface DeleteShareOptions {
  /** Skip deleting the sibling `<slug>.png` OG cover (default: delete it too). */
  keepCover?: boolean;
  /** Skip deleting the target's retained revisions (`<key>/rev-*`, RUSH-2683
   * revision retention) — default: delete them too. A republished-then-deleted
   * share would otherwise leave its prior world-readable versions live for up
   * to the bucket's lifecycle max-age (see docs/distribution.md). */
  keepRevisions?: boolean;
  /** Treat an already-missing target as a no-op success instead of an error
   * (mirrors SQL's `DROP ... IF EXISTS`). Default: missing target is an error. */
  ifExists?: boolean;
  /** Override the GitHub username used to resolve a bare-slug target. */
  githubUser?: string;
  /** DI seam for tests — override the persisted share endpoint config. */
  config?: ShareConfig;
  /** DI seam for tests — override the keychain-backed write token. Selects BYO. */
  writeToken?: string;
  /** DI seam for tests — override `readSession()`. `null` means signed out. */
  session?: import('../identity/client.js').PhoenixSession | null;
  /** Force the BYO Cloudflare path even when signed in. */
  byo?: boolean;
  /** DI seam for tests — override the real HTTP DELETE. */
  deleter?: DeleteFn;
  /** DI seam for tests — override the real HTTP existence check. */
  checker?: CheckFn;
  /** DI seam for tests — override the real HTTP GET of the revisions listing route. */
  fetchRevisions?: RevisionsFetchFn;
}

export interface DeleteShareResult {
  key: string;
  url: string;
  existedBefore: boolean;
  verified404: boolean;
  /** True when `ifExists` was set and the target was already gone — nothing ran. */
  skipped?: boolean;
  cover?: {
    key: string;
    url: string;
    existedBefore: boolean;
    verified404: boolean;
  };
  /** Retained revisions of this target that were also deleted (omitted when
   * there were none, or `keepRevisions` was passed). */
  revisions?: Array<{
    key: string;
    url: string;
    existedBefore: boolean;
    verified404: boolean;
  }>;
}

/** Delete one share target (page + by default its OG cover) and verify both
 * are gone. Throws on an unverified takedown — never reports success for an
 * object that still resolves. */
export async function deleteShare(target: string, opts: DeleteShareOptions = {}): Promise<DeleteShareResult> {
  const backend = resolveShareBackend(opts as ResolveShareBackendOpts);
  const githubUser =
    backend.kind === 'managed'
      ? backend.namespace
      : opts.githubUser || backend.namespace || undefined;
  const resolved = await resolveDeleteTarget(target, { githubUser });
  const endpoint: DeleteEndpoint = { baseUrl: backend.baseUrl, token: backend.token };

  const page = await deleteObject(endpoint, resolved.key, { deleter: opts.deleter, checker: opts.checker });

  if (!page.existedBefore) {
    if (opts.ifExists) {
      return { key: page.key, url: page.url, existedBefore: false, verified404: page.verified404, skipped: true };
    }
    throw new Error(
      `Nothing to delete — ${page.url} was already not found. Pass --if-exists to treat this as a no-op instead of an error.`,
    );
  }

  if (!page.verified404) {
    throw new Error(
      `Delete reported success but ${page.url} still resolves — takedown NOT verified. Retry, or investigate the Worker/R2 directly.`,
    );
  }

  const result: DeleteShareResult = {
    key: page.key,
    url: page.url,
    existedBefore: page.existedBefore,
    verified404: page.verified404,
  };

  if (!opts.keepCover) {
    const cover = await deleteObject(endpoint, resolved.coverKey, { deleter: opts.deleter, checker: opts.checker });
    result.cover = {
      key: cover.key,
      url: cover.url,
      existedBefore: cover.existedBefore,
      verified404: cover.verified404,
    };
    // A missing cover is normal (non-HTML publishes, or --no-cover at publish
    // time never made one) — only a cover that existed and is still up is a bug.
    if (cover.existedBefore && !cover.verified404) {
      throw new Error(
        `Cover delete reported success but ${cover.url} still resolves — takedown NOT verified. Retry, or pass --keep-cover and delete it manually.`,
      );
    }
  }

  if (!opts.keepRevisions) {
    const revisionKeys = await listRevisionKeys(endpoint, resolved.key, opts.fetchRevisions ?? defaultRevisionsFetch);
    if (revisionKeys.length > 0) {
      const revisions: NonNullable<DeleteShareResult['revisions']> = [];
      for (const revisionKey of revisionKeys) {
        const rev = await deleteObject(endpoint, revisionKey, { deleter: opts.deleter, checker: opts.checker });
        revisions.push({ key: rev.key, url: rev.url, existedBefore: rev.existedBefore, verified404: rev.verified404 });
      }
      result.revisions = revisions;
      const stillUp = revisions.filter((r) => r.existedBefore && !r.verified404);
      if (stillUp.length > 0) {
        throw new Error(
          `Delete reported success but ${stillUp.length} retained revision(s) still resolve — takedown NOT verified. Retry, or pass --keep-revisions and delete them manually.`,
        );
      }
    }
  }

  return result;
}
