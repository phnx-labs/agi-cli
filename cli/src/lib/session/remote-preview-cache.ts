/**
 * Canonical bounded loader for a REMOTE session's preview envelope
 * (PHNX-3999): exact ID + known owning device -> one bounded SSH hop ->
 * durable local cache, with cross-process request coalescing and negative
 * backoff on failure. Backs the fast path in `renderSessionPreview` for
 * `agents sessions preview <full-id> --device <owner> --json`.
 *
 * This is deliberately NOT a general resolver: it never scans/hydrates local
 * sessions and never fans out to more than the one named device. Callers that
 * do not yet know the owning device (a short id, a label, no --device) must
 * still go through the existing fleet metadata resolver.
 *
 * End-to-end latency budget (interactive-caller-facing, e.g. the Menu):
 * bounded lease wait + one SSH attempt must stay under
 * {@link REMOTE_PREVIEW_TOTAL_DEADLINE_MS} (11s, under the stated ~12s
 * ceiling). This is why the lease here is a bespoke short-stale lock, NOT
 * `refresh-coordinator.ts`'s `withRefreshLease` (whose 2-minute stale-reclaim
 * ceiling and ~240-retry wait exist for daemon/background callers with a very
 * different SLA — reusing it here would make a single lock contention event
 * blow the interactive budget by an order of magnitude).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { normalizeHost } from '../machine-id.js';
import { getCacheDir } from '../state.js';
import { isCompleteSessionId } from './discover.js';
import {
  fetchPeerPreviewEnvelope,
  type PeerPreviewEnvelopeResult,
} from './remote/remote-list.js';
import {
  readRemotePreviewCache,
  writeRemotePreviewCacheFailure,
  writeRemotePreviewCacheSuccess,
  writeRemotePreviewCallerRevision,
  REMOTE_PREVIEW_ENVELOPE_MAX_BYTES,
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

/**
 * Overall interactive budget for a call that must actually dial the peer:
 * lease-wait + SSH attempt. A caller that provides its own `timeoutMs` still
 * has this outer ceiling applied, since the lease-wait time is additive to it.
 */
const REMOTE_PREVIEW_TOTAL_DEADLINE_MS = 11_000;
/** Default SSH attempt bound for this fast path specifically — tighter than
 * the general-purpose picker's `PEER_PREVIEW_TIMEOUT_MS` (15s), which is
 * tuned for an interactive "peek" the user is already waiting on, not a
 * budget-conscious automated caller. */
const REMOTE_PREVIEW_SSH_TIMEOUT_MS = 8_000;

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
 * - `revision`, when given, is compared against the durable cache's OWN
 *   `last_caller_revision` column (`db.ts`'s `writeRemotePreviewCallerRevision`)
 *   — the LAST value a caller supplied for this exact (device, sessionId) pair
 *   — never against the envelope's own `details.sourceRevision`/
 *   `session.lastActivity`. This is deliberate: a caller's revision cursor
 *   (e.g. a feed's `lastActivityMs`, an epoch-ms number-as-string) need not
 *   share a format with the envelope's own content-revision fields (an ISO
 *   timestamp), so comparing them directly would almost never match. Instead
 *   this is pure caller-observed-value equality: the SAME value the caller
 *   passed last time means the caller has independently confirmed nothing
 *   changed, and serves the cache with zero SSH EVEN PAST
 *   {@link REMOTE_PREVIEW_FRESH_MS} — indefinitely, for as long as the caller
 *   keeps confirming the same value. A DIFFERENT value (or no prior value on
 *   record) means the caller believes something changed, so the freshness
 *   window is skipped and one bounded fetch is attempted (still subject to
 *   backoff, unless `refresh` is also set) — this is activity-driven
 *   invalidation, and it is the ONLY thing that bypasses backoff besides an
 *   explicit `refresh`. There is no polling loop here or in the Menu — the
 *   caller decides when to pass a changed revision.
 * - `refresh: true` bypasses both the freshness window and backoff for
 *   exactly one bounded attempt — the explicit single-owner refresh retry,
 *   distinct from a revision-driven refetch: `refresh` is a user asking again
 *   "right now", `revision` is a caller asserting "I already know it
 *   changed". Two literally-concurrent `refresh` calls still coalesce onto
 *   one SSH attempt (see the lease below) — refresh only means "ignore
 *   backoff", not "always redial even if someone else just did".
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
  // The caller's revision is recorded ONLY at the exact point a fetch
  // SUCCEEDS (inside `fetchOrServe`'s `attempt`), never here unconditionally.
  // A prior cut recorded it after EVERY outcome including a failed refetch:
  // rev1 cached -> caller passes rev2 (differs) -> fetch FAILS -> stale rev1
  // content served -> but rev2 got stamped as "observed" anyway, so the NEXT
  // call with rev2 would match and serve that same stale content as `fresh`
  // forever, silently skipping backoff. Persisting only alongside a genuine
  // successful fetch is what keeps "revision confirmed unchanged" meaning
  // what it says.
  return fetchOrServe(sessionId, normalizedDevice, opts, deps);
}

/** Cap on a caller-supplied `--revision` value: it's an opaque cursor, never
 * free text, so this is a sanity bound, not a format check. */
const REVISION_MAX_CHARS = 128;

function isValidRevision(revision: string): boolean {
  return revision.length > 0 && revision.length <= REVISION_MAX_CHARS;
}

async function fetchOrServe(
  sessionId: string,
  device: string,
  opts: { refresh?: boolean; revision?: string; now?: number; timeoutMs?: number },
  deps: RemotePreviewDeps,
): Promise<RemotePreviewOutcome> {
  const now = opts.now ?? Date.now();
  const cached = readRemotePreviewCache(device, sessionId);
  const revision = opts.revision !== undefined && isValidRevision(opts.revision) ? opts.revision : undefined;

  if (!opts.refresh && cached?.ok) {
    const revisionConfirmedUnchanged = revision !== undefined
      && cached.lastCallerRevision !== undefined
      && revision === cached.lastCallerRevision;
    // A revision was supplied and there is no prior recorded caller revision,
    // or it DIFFERS: skip the TTL bypass below (activity-driven invalidation)
    // and fall through to a real attempt, still subject to backoff. No
    // revision supplied at all: fall back to the plain TTL freshness window,
    // unchanged from before `--revision` existed.
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

  // From here on we are actually about to dial the peer. This is the
  // realistic duplication case (one CLI process per user action, e.g. the
  // Menu worker shelling out a fresh `agents sessions preview` per click), so
  // this takes a bounded, OS-visible lease keyed on (device, sessionId) —
  // never an in-process-only guard, which cannot help two separate processes.
  const beforeFetchedAt = cached?.fetchedAt ?? 0;
  const timeoutMs = opts.timeoutMs ?? REMOTE_PREVIEW_SSH_TIMEOUT_MS;

  const priorConsecutiveFailures = cached?.consecutiveFailures ?? 0;

  const attempt = async (remainingMs: number): Promise<RemotePreviewOutcome> => {
    const afterLease = readRemotePreviewCache(device, sessionId);
    if (afterLease?.ok && afterLease.fetchedAt > beforeFetchedAt) {
      // Another process completed a SUCCESSFUL fetch for this exact
      // (device, id) while we waited for the lease — reuse it. True under
      // --refresh too: refresh means "current data now", and data fetched a
      // moment ago while we queued already IS current.
      return freshFromCache(afterLease, device);
    }
    if (!opts.refresh && afterLease && now < afterLease.nextAttemptAt) {
      // Another process just recorded a FAILURE (and its backoff) while we
      // waited: honor it rather than firing a second attempt right behind it.
      return afterLease.ok
        ? staleFromCache(afterLease, device, 'backoff')
        : noCacheOutcome(device, afterLease.failureReason ?? 'peer unreachable');
    }
    if (opts.refresh && afterLease && !afterLease.ok
      && afterLease.consecutiveFailures > priorConsecutiveFailures) {
      // Even under --refresh (which otherwise ignores backoff): another
      // process's OWN refresh attempt just failed while we waited for the
      // lease. Reuse that failure rather than immediately trying a third
      // time — "explicit retry" still means at most one attempt per genuinely
      // concurrent request, not one per caller.
      return noCacheOutcome(device, afterLease.failureReason ?? 'peer unreachable');
    }

    const result = await deps.fetchEnvelope(sessionId, device, Math.min(timeoutMs, remainingMs));
    if (!result.ok) {
      const reason = describeFailure(result);
      writeRemotePreviewCacheFailure(device, sessionId, reason, nextAttemptBackoffMs, now);
      if (cached?.ok) return staleFromCache(cached, device, reason);
      return noCacheOutcome(device, reason);
    }

    const validation = validateEnvelope(result.envelope, sessionId, device);
    if (!validation.ok) {
      // A peer answered, but the payload doesn't check out (wrong session id,
      // wrong schema version, malformed shape — a version-skewed or
      // misbehaving peer). Never cache it under this id/device key, and never
      // pass it through as if it were a genuine success.
      writeRemotePreviewCacheFailure(device, sessionId, validation.reason, nextAttemptBackoffMs, now);
      if (cached?.ok) return staleFromCache(cached, device, validation.reason);
      return noCacheOutcome(device, validation.reason);
    }

    const envelopeBytes = Buffer.byteLength(JSON.stringify(result.envelope), 'utf8');
    if (envelopeBytes > REMOTE_PREVIEW_ENVELOPE_MAX_BYTES) {
      // The live fetch genuinely succeeded, but the payload is too large to
      // persist AND too large to hand back unbounded. Never silently pass an
      // oversized blob through as "fresh" — degrade to the last-good stale
      // copy (explicitly labeled) when one exists, else an explicit bounded
      // error, and do not cache the oversized response either way.
      const reason = `peer response was ${envelopeBytes} bytes, over the ${REMOTE_PREVIEW_ENVELOPE_MAX_BYTES}-byte bounded-cache limit`;
      writeRemotePreviewCacheFailure(device, sessionId, reason, nextAttemptBackoffMs, now);
      if (cached?.ok) return staleFromCache(cached, device, reason);
      return noCacheOutcome(device, reason);
    }

    writeRemotePreviewCacheSuccess(device, sessionId, result.envelope, now);
    // The caller's revision is recorded ONLY here, atomically tied to a
    // genuine successful fetch — never on a failure/backoff/stale-serve path.
    // See the comment on `getRemoteSessionPreview` for why that distinction
    // is load-bearing.
    if (revision !== undefined) writeRemotePreviewCallerRevision(device, sessionId, revision);
    return {
      envelope: result.envelope,
      cache: { source: 'live', fetchedAt: now, stale: false, state: 'fresh', device, reason: null },
    };
  };

  return withBoundedRemoteLease(device, sessionId, timeoutMs, attempt, () => {
    // Could not acquire the lease within the interactive budget (another
    // process is holding it, presumably mid-fetch, longer than our deadline).
    // Degrade to whatever the cache holds rather than piling on a second SSH
    // attempt — bounded wait, no serial redial, no unbounded queueing.
    const current = readRemotePreviewCache(device, sessionId);
    if (current?.ok) return staleFromCache(current, device, 'another request for this session was already in flight');
    return noCacheOutcome(device, 'another request for this session was already in flight and did not finish in time');
  });
}

/**
 * Validate a peer's response before it is trusted at all: schema-version 1,
 * a `session` object present, its `id` an EXACT non-empty string match for
 * the id we asked for (never missing/null/numeric/mismatched), and — when the
 * peer names its own machine — that name must agree with the device we
 * actually dialed. Without these checks a version-skewed, misbehaving, or
 * misconfigured peer's response could be cached under the WRONG key (this
 * caller's requested sessionId) or attributed to the wrong owning device,
 * poisoning a later read for a completely different session/device pair.
 */
function validateEnvelope(envelope: unknown, sessionId: string, device: string): { ok: true } | { ok: false; reason: string } {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, reason: 'peer response was not a JSON object' };
  }
  const obj = envelope as { schemaVersion?: unknown; session?: { id?: unknown; machine?: unknown } };
  if (obj.schemaVersion !== 1) {
    return { ok: false, reason: `peer response has schemaVersion ${JSON.stringify(obj.schemaVersion)}, expected 1 (version skew?)` };
  }
  if (!obj.session || typeof obj.session !== 'object') {
    return { ok: false, reason: 'peer response carried no session object — refusing to cache content with no confirmed identity' };
  }
  if (typeof obj.session.id !== 'string' || obj.session.id.length === 0 || obj.session.id !== sessionId) {
    return { ok: false, reason: `peer response session id (${JSON.stringify(obj.session.id)}) did not match the requested id — refusing to cache under the wrong key` };
  }
  if (typeof obj.session.machine === 'string' && obj.session.machine.length > 0
    && normalizeHost(obj.session.machine) !== device) {
    return { ok: false, reason: `peer response claims machine "${obj.session.machine}", not the dialed device "${device}" — refusing to cache under the wrong owner` };
  }
  return { ok: true };
}

/** Cross-process lock target for one (device, sessionId) pair. Deliberately a
 * separate lock namespace from `refresh-coordinator.ts` — different SLA,
 * different consumers, no reason to share contention. */
function leaseTarget(device: string, sessionId: string): string {
  const digest = createHash('sha256').update(`${device}::${sessionId}`).digest('hex');
  return path.join(getCacheDir(), 'remote-preview-locks', `${digest}.lock`);
}

/**
 * A bounded, OS-visible cross-process lease: at most
 * {@link REMOTE_PREVIEW_TOTAL_DEADLINE_MS} total wait for the WHOLE
 * operation — lease acquisition AND the protected work `fn` together, not
 * just the acquisition. `fn` receives the REMAINING budget after acquisition
 * so it can clamp its own (e.g. SSH) timeout to what's actually left, rather
 * than the deadline racing a `fn` that can still run to its own full timeout
 * after a slow acquire. On timeout, `onDeadline` runs immediately — no
 * further waiting, no fetch of our own — and the lock, once eventually
 * obtained (if ever), is released and its marker file removed in the
 * background so neither dangles past our own interest in them. The deadline
 * timer is always cleared once the race settles, so a fast, uncontended call
 * never leaves a pending timer holding the process open.
 */
async function withBoundedRemoteLease<T>(
  device: string,
  sessionId: string,
  fetchTimeoutMs: number,
  fn: (remainingMs: number) => Promise<T>,
  onDeadline: () => T,
): Promise<T> {
  const start = Date.now();
  const target = leaseTarget(device, sessionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, '', { flag: 'wx', mode: 0o600 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }

  // Stale slightly above the fetch's own bound: a genuinely dead holder
  // (crashed mid-fetch) is reclaimed soon after its own attempt would have
  // timed out anyway; a live holder's lock never goes stale mid-fetch.
  const staleMs = fetchTimeoutMs + 2_000;
  let release: (() => Promise<void>) | undefined;
  const acquire = lockfile.lock(target, {
    realpath: false,
    stale: staleMs,
    update: staleMs / 4,
    // The retry config's own math is deliberately generous — the deadline
    // timer below is the real, guaranteed ceiling, not this.
    retries: { retries: 60, minTimeout: 75, maxTimeout: 250, factor: 1.15 },
  }).then((r) => { release = r; });

  let deadlineHit = false;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(() => { deadlineHit = true; resolve(); }, REMOTE_PREVIEW_TOTAL_DEADLINE_MS);
  });

  await Promise.race([acquire, deadline]);
  clearTimeout(deadlineTimer!);

  if (deadlineHit) {
    // Didn't get the lease within budget: release (and clean up the marker
    // file) later if/when we do, so it never sits held past our own interest.
    acquire.then(() => { if (release) return release().then(() => cleanupLeaseFile(target)); }).catch(() => {});
    return onDeadline();
  }

  const remainingMs = REMOTE_PREVIEW_TOTAL_DEADLINE_MS - (Date.now() - start);
  if (remainingMs <= 0) {
    // Acquired right at the wire: no budget left to do any real work with it.
    if (release) { await release(); await cleanupLeaseFile(target); }
    return onDeadline();
  }

  try {
    return await fn(remainingMs);
  } finally {
    if (release) {
      await release();
      await cleanupLeaseFile(target);
    }
  }
}

/** Best-effort removal of the lease marker file after release, so the
 * lock directory doesn't grow one file per (device, sessionId) pair this box
 * has ever previewed. Self-healing either way: `withBoundedRemoteLease`
 * recreates it on demand (`{ flag: 'wx' }` — a no-op if it's still there). */
async function cleanupLeaseFile(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // Another concurrent caller may already be using it, or it's already
    // gone — either way, nothing to do.
  }
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
  const offline = reason === 'device did not answer within the bounded window' || reason === 'backoff'
    || reason === 'another request for this session was already in flight';
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
  const offline = reason.includes('unreachable') || reason.includes('not answer') || reason === 'backoff'
    || reason.includes('already in flight');
  return {
    cache: {
      source: 'cache', fetchedAt: null, stale: false,
      state: offline ? 'no-cache-offline' : 'no-cache-error',
      device, reason,
    },
  };
}
