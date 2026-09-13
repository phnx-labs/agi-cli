/** Bounded, single-owner preview fetch with a durable requester cache and cross-process coalescing. */

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
  withSessionDBTimeout,
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
const REMOTE_PREVIEW_TOTAL_DEADLINE_MS = 10_000;
const CACHE_BUSY_TIMEOUT_MS = 250;
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

/** A changed caller cursor invalidates a good copy; failed attempts preserve both its content and cursor. */
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
  try {
    return await fetchOrServe(sessionId, normalizedDevice, opts, deps);
  } catch {
    return noCacheOutcome(normalizedDevice, 'The session preview cache is unavailable. Try again.');
  }
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
  const deadlineAt = Date.now() + REMOTE_PREVIEW_TOTAL_DEADLINE_MS;
  const accessCache = <T>(operation: () => T): T =>
    withSessionDBTimeout(Math.max(0, Math.min(CACHE_BUSY_TIMEOUT_MS, deadlineAt - Date.now())), operation);
  const now = opts.now ?? Date.now();
  const readCache = (): RemotePreviewCacheRow | undefined => {
    const stored = accessCache(() => readRemotePreviewCache(device, sessionId));
    return stored?.ok && !validateEnvelope(stored.envelope, sessionId, device).ok
      ? { ...stored, ok: false, envelope: undefined } : stored;
  };
  const cached = readCache();
  const recordFailure = (reason: string): void => {
    try { accessCache(() => writeRemotePreviewCacheFailure(device, sessionId, reason, nextAttemptBackoffMs, opts.now ?? Date.now())); }
    catch { /* The response still carries the failure and any previously read content. */ }
  };
  const revision = opts.revision !== undefined && isValidRevision(opts.revision) ? opts.revision : undefined;

  if (!opts.refresh && cached?.ok && cached.consecutiveFailures === 0) {
    const revisionConfirmedUnchanged = revision !== undefined
      && cached.lastCallerRevision !== undefined
      && revision === cached.lastCallerRevision;
    // A revision was supplied and there is no prior recorded caller revision,
    // or it DIFFERS: skip the TTL bypass below (activity-driven invalidation)
    // and fall through to a real attempt, still subject to backoff. No
    // revision supplied at all: fall back to the plain TTL freshness window,
    // unchanged from before `--revision` existed.
    const age = now - cached.fetchedAt;
    const withinFreshWindow = revision === undefined && age >= 0 && age < REMOTE_PREVIEW_FRESH_MS;
    if (revisionConfirmedUnchanged || withinFreshWindow) {
      if (validateEnvelope(cached.envelope, sessionId, device).ok) return freshFromCache(cached, device);
    }
  }
  if (!opts.refresh && cached && now < cached.nextAttemptAt) {
    // Still inside the negative-backoff window from a recent failure: honor
    // it rather than dialing again, and serve whatever the cache holds.
    const reason = cached.failureReason ?? 'peer unreachable';
    return cached.ok ? staleFromCache(cached, device, reason) : noCacheOutcome(device, reason);
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
    const afterLease = readCache();
    if (afterLease?.ok && afterLease.consecutiveFailures === 0 && afterLease.fetchedAt > beforeFetchedAt) {
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
        ? staleFromCache(afterLease, device, afterLease.failureReason ?? 'peer unreachable')
        : noCacheOutcome(device, afterLease.failureReason ?? 'peer unreachable');
    }
    if (opts.refresh && afterLease
      && afterLease.consecutiveFailures > priorConsecutiveFailures) {
      // Even under --refresh (which otherwise ignores backoff): another
      // process's OWN refresh attempt just failed while we waited for the
      // lease. Reuse that failure rather than immediately trying a third
      // time — "explicit retry" still means at most one attempt per genuinely
      // concurrent request, not one per caller.
      const reason = afterLease.failureReason ?? 'peer unreachable';
      return afterLease.ok ? staleFromCache(afterLease, device, reason) : noCacheOutcome(device, reason);
    }

    const fetchBudget = Math.min(timeoutMs, remainingMs, deadlineAt - Date.now() - CACHE_BUSY_TIMEOUT_MS - 100);
    if (fetchBudget <= 0) return cached?.ok
      ? staleFromCache(cached, device, 'another request for this session was already in flight')
      : noCacheOutcome(device, 'another request for this session was already in flight');
    const result = await deps.fetchEnvelope(sessionId, device, fetchBudget);
    if (!result.ok) {
      const reason = describeFailure(result);
      recordFailure(reason);
      if (cached?.ok) return staleFromCache(cached, device, reason);
      return noCacheOutcome(device, reason);
    }

    const validation = validateEnvelope(result.envelope, sessionId, device);
    if (!validation.ok) {
      // A peer answered, but the payload doesn't check out (wrong session id,
      // wrong schema version, malformed shape — a version-skewed or
      // misbehaving peer). Never cache it under this id/device key, and never
      // pass it through as if it were a genuine success.
      recordFailure(validation.reason);
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
      recordFailure(reason);
      if (cached?.ok) return staleFromCache(cached, device, reason);
      return noCacheOutcome(device, reason);
    }

    const fetchedAt = Math.max(opts.now ?? Date.now(), (afterLease?.fetchedAt ?? 0) + 1);
    let persistenceReason: string | null = null;
    try { accessCache(() => writeRemotePreviewCacheSuccess(device, sessionId, result.envelope, fetchedAt, revision)); }
    catch { persistenceReason = 'Session details loaded, but could not be saved for offline use.'; }
    return {
      envelope: result.envelope,
      cache: { source: 'live', fetchedAt, stale: false, state: 'fresh', device, reason: persistenceReason },
    };
  };

  try {
    return await withBoundedRemoteLease(device, sessionId, timeoutMs, deadlineAt, attempt, () => {
    // Could not acquire the lease within the interactive budget (another
    // process is holding it, presumably mid-fetch, longer than our deadline).
    // Degrade to whatever the cache holds rather than piling on a second SSH
    // attempt — bounded wait, no serial redial, no unbounded queueing.
    const current = cached;
    if (current?.ok) return staleFromCache(current, device, 'another request for this session was already in flight');
    return noCacheOutcome(device, 'another request for this session was already in flight and did not finish in time');
    });
  } catch {
    const reason = 'The session preview cache is unavailable. Try again.';
    return cached?.ok ? staleFromCache(cached, device, reason) : noCacheOutcome(device, reason);
  }
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
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
  const string = (value: unknown): boolean => typeof value === 'string';
  const number = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
  const integer = (value: unknown): boolean => Number.isSafeInteger(value);
  const boolean = (value: unknown): boolean => typeof value === 'boolean';
  type Check = (value: unknown) => boolean;
  const shape = (fields: Record<string, Check>): Check => value => object(value)
    && Object.entries(fields).every(([key, check]) => value[key] == null || check(value[key]));
  const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
  const artifact = shape({ path: string, basename: string, bucket: string });
  const request = shape({ kind: string, text: string, headline: string, turns: integer });
  const step = shape({ text: string, at: string, source: string, live: boolean, now: string,
    mix: value => object(value) && Object.values(value).every(integer) });
  const timeline = shape({ tools: integer, failed: integer, blocked: integer, spanMs: number,
    state: string, reason: string, steps: array(step), earlier: shape({ steps: integer, tools: integer, failed: integer }) });
  const files = shape({ total: integer, source: string,
    changes: array(shape({ path: string, op: string, edits: integer, at: string })) });
  const preview = shape({ firstUser: string, lastAssistant: string, artifacts: array(artifact) });
  const details = shape({ sourceRevision: string, reason: string, partial: boolean, request, timeline, files,
    messages: array(value => object(value) && typeof value.role === 'string' && ['user', 'assistant'].includes(value.role)
      && string(value.text) && (value.at == null || string(value.at))) });

  if (!object(envelope)) return { ok: false, reason: 'The device returned a preview that was not a JSON object.' };
  if (envelope.schemaVersion !== 1) return { ok: false, reason: 'The device returned an unsupported preview schema.' };
  if (!object(envelope.session) || envelope.session.id !== sessionId)
    return { ok: false, reason: 'The device returned a preview for a different or missing session ID.' };
  if (!shape({ agent: string, machine: string, project: string, cwd: string, title: string,
    lastActivity: string, lastActivityMs: number })(envelope.session))
    return { ok: false, reason: 'The device returned malformed session metadata.' };
  if (envelope.cache != null && !object(envelope.cache))
    return { ok: false, reason: 'The device returned malformed cache metadata.' };
  const owners = [envelope.session.machine, object(envelope.cache) ? envelope.cache.device : undefined]
    .filter(value => value !== undefined);
  if (owners.length === 0 || owners.some(owner => typeof owner !== 'string' || !owner.trim() || normalizeHost(owner) !== device))
    return { ok: false, reason: 'The device returned a preview without a matching owner.' };
  if ((envelope.preview != null && !preview(envelope.preview))
    || (envelope.details != null && !details(envelope.details))
    || (envelope.active != null && !shape({ status: string, lastActivityMs: number })(envelope.active))
    || (envelope.error != null && !string(envelope.error)))
    return { ok: false, reason: 'The device returned malformed session details.' };

  const digest = object(envelope.preview) ? envelope.preview : {};
  const detail = object(envelope.details) ? envelope.details : {};
  const hasContent = text(digest.firstUser) || text(digest.lastAssistant)
    || (Array.isArray(detail.messages) && detail.messages.length > 0)
    || (object(detail.request) && text(detail.request.text))
    || (object(detail.timeline) && Array.isArray(detail.timeline.steps) && detail.timeline.steps.length > 0)
    || (object(detail.files) && Array.isArray(detail.files.changes) && detail.files.changes.length > 0)
    || (Array.isArray(digest.artifacts) && digest.artifacts.length > 0);
  if (!hasContent) return { ok: false, reason: 'The device has no recorded session details available yet.' };
  return { ok: true };
}

/** Cross-process lock target for one (device, sessionId) pair. Deliberately a
 * separate lock namespace from `refresh-coordinator.ts` — different SLA,
 * different consumers, no reason to share contention. */
function leaseTarget(device: string, sessionId: string): string {
  const digest = createHash('sha256').update(`${device}::${sessionId}`).digest('hex');
  return path.join(getCacheDir(), 'remote-preview-locks', `${digest}.lock`);
}

/** Lock wait, transport, and cache writes share one deadline; no pending retry outlives the call. */
async function withBoundedRemoteLease<T>(
  device: string,
  sessionId: string,
  fetchTimeoutMs: number,
  deadlineAt: number,
  fn: (remainingMs: number) => Promise<T>,
  onDeadline: () => T,
): Promise<T> {
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
  while (!release && Date.now() < deadlineAt) {
    try {
      release = await lockfile.lock(target, {
        realpath: false, stale: staleMs, update: staleMs / 4, retries: 0,
      });
    } catch (error: any) {
      if (error?.code !== 'ELOCKED') throw error;
      const remaining = deadlineAt - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
  }
  if (!release) return onDeadline();

  const remainingMs = deadlineAt - Date.now();
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
