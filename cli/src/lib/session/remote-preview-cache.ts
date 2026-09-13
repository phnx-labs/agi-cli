/**
 * Canonical bounded loader for a REMOTE session's preview envelope
 * (PHNX-3999): exact ID + known owning device -> one bounded SSH hop ->
 * durable local cache, with in-process request coalescing and negative
 * backoff on failure. Backs the fast path in `renderSessionPreview` for
 * `agents sessions preview <full-id> --device <owner> --json`.
 *
 * This is deliberately NOT a general resolver: it never scans/hydrates local
 * sessions and never fans out to more than the one named device. Callers that
 * do not yet know the owning device (a short id, a label, no --device) must
 * still go through the existing fleet metadata resolver.
 */

import { normalizeHost } from '../machine-id.js';
import { withRefreshLease } from '../refresh-coordinator.js';
import { isCompleteSessionId } from './discover.js';
import {
  fetchPeerPreviewEnvelope,
  type PeerPreviewEnvelopeResult,
} from './remote/remote-list.js';
import {
  readRemotePreviewCache,
  writeRemotePreviewCacheFailure,
  writeRemotePreviewCacheSuccess,
  type RemotePreviewCacheRow,
} from './db.js';

/** How long a successful fetch is served with zero SSH on an ordinary call. */
const REMOTE_PREVIEW_FRESH_MS = 45_000;

/** Exponential backoff after a failed fetch, capped, so a persistently
 * unreachable/erroring peer is not re-dialed on every call. */
function nextAttemptBackoffMs(consecutiveFailures: number): number {
  const capped = Math.min(consecutiveFailures, 6);
  return Math.min(30_000 * 2 ** (capped - 1), 30 * 60_000);
}

export type RemotePreviewCacheState =
  | 'fresh'
  | 'stale-offline'
  | 'stale-error'
  | 'no-cache-offline'
  | 'no-cache-error'
  | 'invalid-id';

export interface RemotePreviewOutcome {
  envelope?: unknown;
  cache: {
    source: 'live' | 'cache';
    fetchedAt: number | null;
    stale: boolean;
    state: RemotePreviewCacheState;
    device: string;
    reason: string | null;
  };
}

/** In-process coalescing: two callers asking for the same (device, id) within
 * ONE process (e.g. a daemon tick or a batch render) while a fetch is already
 * in flight share the one result instead of dialing twice — a zero-cost check
 * before ever touching the cross-process lease below. The realistic case for
 * this feature, though, is one-CLI-process-per-user-action (the Menu worker
 * shells out a fresh `agents sessions preview` per request), so cross-process
 * duplication is the one that matters and is handled by
 * {@link withRefreshLease} inside `fetchOrServe`, not by this map. */
const inFlight = new Map<string, Promise<RemotePreviewOutcome>>();

function cacheKey(device: string, sessionId: string): string {
  return `${device}::${sessionId}`;
}

/**
 * Fetch (or serve from durable cache) the full preview envelope for one
 * session known to live on `device`. Never scans local sessions, never fans
 * out to any device other than the one named.
 *
 * - `sessionId` must be a complete id ({@link isCompleteSessionId} — a bare
 *   UUID for most harnesses, but `session_<uuid>` for kimi/rush or
 *   `ses_<ulid>` for opencode, per `discover.ts`'s measured index shapes);
 *   anything else fails fast as `invalid-id` with no cache lookup and no SSH,
 *   since a short id/label is not a stable cache key across devices.
 * - Without `refresh`, a cache row younger than {@link REMOTE_PREVIEW_FRESH_MS}
 *   is served with zero SSH. A row still inside its negative-backoff window is
 *   also served (stale if we have prior content, else an explicit failure)
 *   with zero SSH.
 * - `revision`, when given, is compared against the CACHED envelope's own
 *   content revision (`details.sourceRevision`/`session.lastActivity` — the
 *   session's last-activity stamp, not a caller-invented value). A match means
 *   the caller has independently confirmed nothing changed (e.g. a feed-watch
 *   tick that saw no new activity for this session on this device) and serves
 *   the cache with zero SSH EVEN PAST {@link REMOTE_PREVIEW_FRESH_MS} — this is
 *   the "reopening an unchanged inactive session costs nothing" path. A
 *   mismatch means the caller believes something changed, so the freshness
 *   window is skipped and one bounded fetch is attempted (still subject to
 *   backoff, unless `refresh` is also set) — this is activity-driven
 *   invalidation, and it is the ONLY thing that bypasses backoff besides an
 *   explicit `refresh`; there is no separate polling loop here or in the
 *   Menu — the caller decides when to pass a changed revision.
 * - `refresh: true` bypasses both the freshness window and backoff for
 *   exactly one bounded attempt (still capped by the existing sshCapture
 *   timeout/byte limits) — the explicit single-owner refresh retry, distinct
 *   from a revision-driven refetch: `refresh` is a user asking again "right
 *   now", `revision` is a caller asserting "I already know it changed".
 */
export interface RemotePreviewDeps {
  /** Defaults to the real bounded SSH transport ({@link fetchPeerPreviewEnvelope}).
   * Overridable so the cache/backoff/revision/lease STATE MACHINE can be tested
   * against a real SQLite DB without a live peer — this repo has no fleet in
   * CI, and the actual bounded-transport behavior (timeout, byte cap) is
   * already covered where `fetchPeerPreviewEnvelope`/`sshCapture` are defined. */
  fetchEnvelope: typeof fetchPeerPreviewEnvelope;
}

const defaultDeps: RemotePreviewDeps = { fetchEnvelope: fetchPeerPreviewEnvelope };

export async function getRemoteSessionPreview(
  sessionId: string,
  device: string,
  opts: { refresh?: boolean; revision?: string; now?: number; timeoutMs?: number } = {},
  deps: RemotePreviewDeps = defaultDeps,
): Promise<RemotePreviewOutcome> {
  if (!isCompleteSessionId(sessionId)) {
    return {
      cache: {
        source: 'cache', fetchedAt: null, stale: false, state: 'invalid-id',
        device: normalizeHost(device),
        reason: 'sessions preview --device requires a full session id (bare UUID, session_<uuid>, or ses_<ulid>) for the durable-cache fast path',
      },
    };
  }
  const normalizedDevice = normalizeHost(device);
  const key = cacheKey(normalizedDevice, sessionId);
  const running = inFlight.get(key);
  if (running && !opts.refresh) return running;

  const promise = fetchOrServe(sessionId, normalizedDevice, opts, deps).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Cap on a caller-supplied `--revision` value: it's an opaque cursor (a
 * `sourceRevision`/`lastActivity` stamp the caller read back from an earlier
 * response), never free text, so this is a sanity bound, not a format check. */
const REVISION_MAX_CHARS = 128;

/** The envelope's own content-revision cursor — `details.sourceRevision` when
 * present (set by `buildSessionDetailBlock`), else `session.lastActivity` for
 * an older peer whose response predates the `details` block. Never a
 * caller-invented value: this is always read back off a real fetched envelope. */
function extractContentRevision(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return null;
  const details = (envelope as { details?: { sourceRevision?: unknown } }).details;
  if (details && typeof details.sourceRevision === 'string') return details.sourceRevision;
  const session = (envelope as { session?: { lastActivity?: unknown } }).session;
  if (session && typeof session.lastActivity === 'string') return session.lastActivity;
  return null;
}

async function fetchOrServe(
  sessionId: string,
  device: string,
  opts: { refresh?: boolean; revision?: string; now?: number; timeoutMs?: number },
  deps: RemotePreviewDeps,
): Promise<RemotePreviewOutcome> {
  const now = opts.now ?? Date.now();
  const cached = readRemotePreviewCache(device, sessionId);
  const revision = opts.revision !== undefined && opts.revision.length > 0 && opts.revision.length <= REVISION_MAX_CHARS
    ? opts.revision
    : undefined;

  if (!opts.refresh && cached?.ok) {
    const cachedRevision = extractContentRevision(cached.envelope);
    const revisionConfirmedUnchanged = revision !== undefined && cachedRevision !== null && revision === cachedRevision;
    // A revision was supplied and DIFFERS from what we have cached: skip the
    // TTL bypass below (activity-driven invalidation) and fall through to a
    // real attempt, still subject to backoff. No revision at all: fall back to
    // the plain TTL freshness window, unchanged from before `--revision` existed.
    const withinFreshWindow = revision === undefined && now - cached.fetchedAt < REMOTE_PREVIEW_FRESH_MS;
    if (revisionConfirmedUnchanged || withinFreshWindow) {
      return freshFromCache(cached, device);
    }
  }
  if (!opts.refresh && cached && now < cached.nextAttemptAt) {
    // Still inside the negative-backoff window from a recent failure: honor
    // it rather than dialing again, and serve whatever the cache holds.
    return cached.ok ? staleFromCache(cached, device, 'backoff') : noCacheOutcome(device, cached.failureReason ?? 'peer unreachable');
  }

  // From here on we are actually about to dial the peer. This is the realistic
  // duplication case (one CLI process per user action, e.g. the Menu worker
  // shelling out a fresh `agents sessions preview` per click) — an in-process
  // Map can't help two separate processes, so this takes an OS-visible,
  // bounded-wait lease (`withRefreshLease`, `refresh-coordinator.ts`, already
  // used by the daemon/Factory/`agents view` for the identical "many processes,
  // one shared refresh" shape) keyed on (device, sessionId). A second
  // invocation arriving while the first is mid-fetch waits on the lease
  // (bounded: ~240 retries up to 500ms each, capped by a 2-minute stale-lock
  // reclaim — never an unbounded wait) rather than firing its own SSH hop, and
  // re-reads the cache after acquiring it so it can pick up the first
  // invocation's result instead of repeating the fetch.
  const beforeFetchedAt = cached?.fetchedAt ?? 0;
  return withRefreshLease<RemotePreviewOutcome>({
    scope: 'sessions-remote-preview',
    key: `${device}::${sessionId}`,
    readCompleted: () => {
      if (opts.refresh) return null; // an explicit refresh always performs its own attempt
      const afterLease = readRemotePreviewCache(device, sessionId);
      if (!afterLease) return null;
      if (afterLease.ok && afterLease.fetchedAt > beforeFetchedAt) {
        // Another process completed a SUCCESSFUL fetch for this exact
        // (device, id) while we waited for the lease: use its result instead
        // of dialing again.
        return freshFromCache(afterLease, device);
      }
      if (now < afterLease.nextAttemptAt) {
        // Another process just recorded a FAILURE (and its backoff) for this
        // exact (device, id) while we waited for the lease: honor that
        // backoff too, rather than immediately firing a second attempt right
        // behind the one that just failed.
        return afterLease.ok
          ? staleFromCache(afterLease, device, 'backoff')
          : noCacheOutcome(device, afterLease.failureReason ?? 'peer unreachable');
      }
      return null;
    },
    isCompleted: () => true,
    refresh: async () => {
      const result = opts.timeoutMs !== undefined
        ? await deps.fetchEnvelope(sessionId, device, opts.timeoutMs)
        : await deps.fetchEnvelope(sessionId, device);
      if (result.ok) {
        writeRemotePreviewCacheSuccess(device, sessionId, result.envelope, now);
        return {
          envelope: result.envelope,
          cache: { source: 'live', fetchedAt: now, stale: false, state: 'fresh', device, reason: null },
        };
      }

      const reason = describeFailure(result);
      writeRemotePreviewCacheFailure(device, sessionId, reason, nextAttemptBackoffMs, now);
      if (cached?.ok) return staleFromCache(cached, device, reason);
      return noCacheOutcome(device, reason);
    },
  });
}

function describeFailure(result: Extract<PeerPreviewEnvelopeResult, { ok: false }>): string {
  switch (result.reason) {
    case 'no-target': return 'device is not a registered, dialable peer';
    case 'unreachable': return 'device did not answer within the bounded window';
    case 'invalid-json': return 'device returned an unparsable response (version skew?)';
    default: return 'unknown failure';
  }
}

function freshFromCache(cached: RemotePreviewCacheRow, device: string): RemotePreviewOutcome {
  return {
    envelope: cached.envelope,
    cache: { source: 'cache', fetchedAt: cached.fetchedAt, stale: false, state: 'fresh', device, reason: null },
  };
}

function staleFromCache(cached: RemotePreviewCacheRow, device: string, reason: string): RemotePreviewOutcome {
  const offline = reason === 'device did not answer within the bounded window' || reason === 'backoff';
  return {
    envelope: cached.envelope,
    cache: {
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      stale: true,
      state: offline ? 'stale-offline' : 'stale-error',
      device,
      reason,
    },
  };
}

function noCacheOutcome(device: string, reason: string): RemotePreviewOutcome {
  const offline = reason.includes('unreachable') || reason.includes('not answer') || reason === 'backoff';
  return {
    cache: {
      source: 'cache', fetchedAt: null, stale: false,
      state: offline ? 'no-cache-offline' : 'no-cache-error',
      device, reason,
    },
  };
}
