/**
 * Daemon-warmed cross-surface cache for live session status (RUSH-2062).
 *
 * Problem: menubar / Factory / watchdog / CLI each independently run a full
 * `sessions --active` gather (~9s wall / ~170MB) with no sharing. Measured on
 * zion: back-to-back runs were 9.22s then 8.16s — no speedup, full SSH fan-out
 * every call.
 *
 * Pattern mirrors {@link ../devices/stats-cache.ts} / {@link ../fleet-status.ts}:
 *
 * - **Daemon publish:** each daemon publishes THIS host's local active sessions
 *   (`publishLocalActiveSessions`). Each write appends row deltas to the journal
 *   consumed by long-lived watchers. Publish-own only — no
 *   cross-host SSH from the daemon (avoids the N² fan-out of RUSH-2061).
 * - **Readers** (`loadLocalActiveSessions`, fleet path in `gatherActiveSessions`)
 *   serve the warm snapshot when it is within {@link DEFAULT_ACTIVE_CACHE_MAX_AGE_MS};
 *   `forceRefresh` / age expiry re-gathers live.
 * - **Immutable memo:** per-session fields that only change when the transcript
 *   does (topic, label, cwd, …) are keyed on `(sessionId, transcriptMtimeMs)`.
 *   Live status fields (`status`, `activity`, `preview`, `pidAlive`, …) are
 *   NEVER stored in that memo — they only ride the short-lived snapshot.
 *
 * Best-effort disk IO: a missing/corrupt cache never throws; the caller falls
 * through to a live gather.
 */
import * as fs from 'fs';
import * as path from 'path';

import { createMemoryCache } from '../memory-cache.js';
import { getCacheDir } from '../state.js';
import { backfillActiveRowsFromIndex, sessionProcessIsLocal, type ActiveSession } from './active.js';

/** Snapshot file under `getCacheDir()` (regenerable, gitignored). */
const SNAPSHOT_FILE = '.active-sessions.json';
/** Immutable-field memo file (keyed by sessionId + transcript mtime). */
const IMMUTABLE_FILE = '.active-session-immutable.json';
const JOURNAL_FILE = '.active-sessions.journal.jsonl';

/**
 * How long a snapshot may be served before a reader re-gathers.
 * Short on purpose: live status (running/idle/waiting) must not go stale.
 * One-shot readers may re-gather after this ceiling. Long-lived watchers never
 * do: they read one reset then tail the canonical writer journal.
 */
export const DEFAULT_ACTIVE_CACHE_MAX_AGE_MS = 15_000;

/** Snapshot scope: this host only, or a fleet-wide merge written by a reader. */
export type ActiveCacheScope = 'local' | 'fleet';

export interface ActiveSessionsSnapshot {
  version: 1;
  scope: ActiveCacheScope;
  /** Epoch ms the sessions array was captured. */
  capturedAt: number;
  sessions: ActiveSession[];
  /** Peer count from the last fleet gather (fleet scope only). */
  remoteDeviceCount?: number;
}

interface SnapshotFile {
  version: 1;
  entries: Partial<Record<ActiveCacheScope, ActiveSessionsSnapshot>>;
}

export interface ActiveSessionsJournalRecord {
  version: 1;
  scope: ActiveCacheScope;
  capturedAt: number;
  upserts: ActiveSession[];
  removes: string[];
}

export function activeSessionJournalIdentity(row: ActiveSession): string {
  return row.sessionId ?? `${row.context}:${row.kind}:${row.pid ?? ''}:${row.startedAtMs ?? ''}`;
}

/** Process-local L1. The atomic snapshot remains the cross-process source. */
const activeSnapshotMemory = createMemoryCache<ActiveCacheScope, ActiveSessionsSnapshot>({
  max: 2,
  ttlMs: DEFAULT_ACTIVE_CACHE_MAX_AGE_MS,
});

/**
 * Per-session fields that are stable until the transcript changes. Keyed on
 * transcript mtime so a rewrite invalidates them. Live status is intentionally
 * absent — see {@link LIVE_STATUS_KEYS}.
 */
export interface ImmutableSessionFields {
  topic?: string;
  label?: string;
  name?: string;
  cwd?: string;
  project?: string | null;
  attachments?: ActiveSession['attachments'];
  startedAtMs?: number;
  version?: string;
  pr?: ActiveSession['pr'];
  worktree?: ActiveSession['worktree'];
  ticket?: ActiveSession['ticket'];
  createdTickets?: string[];
  spawnedTeam?: string;
  sessionFile?: string;
  owner?: string;
  assignedTask?: string;
  kind?: string;
  context?: ActiveSession['context'];
}

/** Keys stored in the immutable memo (transcript-stable). */
export const IMMUTABLE_FIELD_KEYS = [
  'topic',
  'label',
  'name',
  'cwd',
  'project',
  'attachments',
  'startedAtMs',
  'version',
  'pr',
  'worktree',
  'ticket',
  'createdTickets',
  'spawnedTeam',
  'sessionFile',
  'owner',
  'assignedTask',
  'kind',
  'context',
] as const satisfies ReadonlyArray<keyof ImmutableSessionFields>;

/**
 * Live / volatile fields that MUST NOT be served from the immutable memo.
 * They either change without a transcript write (pid death, attach state) or
 * are short-window signals (preview, tok/s). The short snapshot TTL is the
 * only cache that may carry them — and only as a whole-row snapshot.
 */
export const LIVE_STATUS_KEYS = [
  'status',
  'activity',
  'preview',
  'tokPerSec',
  'awaitingReason',
  'question',
  'todos',
  'tail',
  'lastActivityMs',
  'hostLink',
  'presence',
  'pidAlive',
  'tmuxClients',
  'windowHeartbeatMs',
  'provenance',
  'rateLimited',
  'plan',
] as const satisfies ReadonlyArray<keyof ActiveSession>;

interface ImmutableMemoEntry {
  mtimeMs: number;
  fields: ImmutableSessionFields;
  /** When this memo row was written (debug / eviction). */
  writtenAt: number;
}

interface ImmutableMemoFile {
  version: 1;
  /** sessionId → memo. */
  entries: Record<string, ImmutableMemoEntry>;
}

// ── path overrides (test seam) ─────────────────────────────────────────────

let snapshotPathOverride: string | null = null;
let immutablePathOverride: string | null = null;
let journalPathOverride: string | null = null;

/** Test seam: redirect the snapshot file. Returns the previous override. */
export function setActiveSessionsSnapshotPathForTest(p: string | null): string | null {
  const prev = snapshotPathOverride;
  snapshotPathOverride = p;
  activeSnapshotMemory.clear();
  return prev;
}

/** Test seam: isolate process-local entries between fixtures. */
export function clearActiveSnapshotMemoryForTest(): void {
  activeSnapshotMemory.clear();
}

/** Test seam: redirect the immutable-memo file. Returns the previous override. */
export function setImmutableMemoPathForTest(p: string | null): string | null {
  const prev = immutablePathOverride;
  immutablePathOverride = p;
  return prev;
}

/** Test seam: redirect the append-only live-state journal. */
export function setActiveSessionsJournalPathForTest(p: string | null): string | null {
  const prev = journalPathOverride;
  journalPathOverride = p;
  return prev;
}

function snapshotPath(): string {
  return snapshotPathOverride ?? path.join(getCacheDir(), SNAPSHOT_FILE);
}

function immutablePath(): string {
  return immutablePathOverride ?? path.join(getCacheDir(), IMMUTABLE_FILE);
}

export function activeSessionsJournalPath(): string {
  return journalPathOverride
    ?? (snapshotPathOverride ? `${snapshotPathOverride}.journal.jsonl` : path.join(getCacheDir(), JOURNAL_FILE));
}

// ── snapshot read / write ──────────────────────────────────────────────────

/** Read one scope from the snapshot file (best-effort; missing/corrupt → null). */
export function readActiveSessionsCache(scope: ActiveCacheScope): ActiveSessionsSnapshot | null {
  const memory = activeSnapshotMemory.get(scope);
  if (memory) return memory;
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath(), 'utf-8')) as SnapshotFile;
    if (!parsed || parsed.version !== 1 || !parsed.entries) return null;
    const entry = parsed.entries[scope];
    if (!entry || !Array.isArray(entry.sessions) || typeof entry.capturedAt !== 'number') return null;
    activeSnapshotMemory.set(scope, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Persist a snapshot for one scope (best-effort). Other scopes are preserved
 * so a local warm never drops a fleet snapshot a reader just wrote.
 */
export function writeActiveSessionsCache(
  scope: ActiveCacheScope,
  sessions: ActiveSession[],
  opts: { capturedAt?: number; remoteDeviceCount?: number } = {},
): ActiveSessionsSnapshot {
  const snap: ActiveSessionsSnapshot = {
    version: 1,
    scope,
    capturedAt: opts.capturedAt ?? Date.now(),
    sessions,
    ...(opts.remoteDeviceCount !== undefined ? { remoteDeviceCount: opts.remoteDeviceCount } : {}),
  };
  try {
    const dir = path.dirname(snapshotPath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let entries: SnapshotFile['entries'] = {};
    try {
      const prev = JSON.parse(fs.readFileSync(snapshotPath(), 'utf-8')) as SnapshotFile;
      if (prev?.entries && typeof prev.entries === 'object') entries = { ...prev.entries };
    } catch {
      // empty
    }
    const hadPrevious = Boolean(entries[scope]);
    const previousSessions = entries[scope]?.sessions ?? [];
    entries[scope] = snap;
    const body: SnapshotFile = { version: 1, entries };
    // Atomic replace so a concurrent reader never sees a partial write.
    const tmp = `${snapshotPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, snapshotPath());
    // The snapshot writer is the canonical publisher. Watchers tail this
    // append-only journal and compute stream deltas; they never trigger their
    // own full active-session gather on a timer.
    const previous = new Map(previousSessions.map((row) => [activeSessionJournalIdentity(row), row]));
    const next = new Map(sessions.map((row) => [activeSessionJournalIdentity(row), row]));
    const upserts = sessions.filter((row) => {
      const before = previous.get(activeSessionJournalIdentity(row));
      return !before || JSON.stringify(before) !== JSON.stringify(row);
    });
    const removes = [...previous.keys()].filter((key) => !next.has(key));
    try {
      if (!hadPrevious || upserts.length > 0 || removes.length > 0) {
        fs.appendFileSync(activeSessionsJournalPath(), `${JSON.stringify({
          version: 1, scope, capturedAt: snap.capturedAt, upserts, removes,
        } satisfies ActiveSessionsJournalRecord)}\n`);
      }
    } catch {
      // Journal delivery is best-effort; the canonical snapshot remains valid.
    }
    activeSnapshotMemory.set(scope, snap);
  } catch {
    // best-effort
  }
  return snap;
}

/**
 * True when a snapshot is still within the freshness window. Pure — the
 * staleness invariant for live status lives here.
 */
export function isActiveSnapshotFresh(
  capturedAt: number,
  nowMs: number,
  maxAgeMs: number = DEFAULT_ACTIVE_CACHE_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(capturedAt) || !Number.isFinite(maxAgeMs)) return false;
  if (maxAgeMs < 0) return false;
  return nowMs - capturedAt <= maxAgeMs;
}

// ── immutable memo ─────────────────────────────────────────────────────────

/** Pull only the transcript-stable fields from a live row. */
export function pickImmutableFields(s: ActiveSession): ImmutableSessionFields {
  const out: ImmutableSessionFields = {};
  for (const k of IMMUTABLE_FIELD_KEYS) {
    const v = s[k as keyof ActiveSession];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Transcript mtime used as the memo key. Prefer {@link ActiveSession.lastActivityMs}
 * (the transcript's last write); fall back to `startedAtMs` when no activity
 * stamp exists. Returns null when neither is known — caller must not memoize.
 */
export function transcriptMtimeMs(s: ActiveSession): number | null {
  if (typeof s.lastActivityMs === 'number' && Number.isFinite(s.lastActivityMs)) return s.lastActivityMs;
  if (typeof s.startedAtMs === 'number' && Number.isFinite(s.startedAtMs)) return s.startedAtMs;
  return null;
}

function readImmutableFile(): ImmutableMemoFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(immutablePath(), 'utf-8')) as ImmutableMemoFile;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    // missing/corrupt
  }
  return { version: 1, entries: {} };
}

/**
 * Read memoized immutable fields for `(sessionId, mtimeMs)`.
 * Returns null when missing OR when the stored mtime does not match — a
 * transcript rewrite must force re-derivation of topic/label/etc.
 */
export function readImmutableMemo(
  sessionId: string,
  mtimeMs: number,
): ImmutableSessionFields | null {
  if (!sessionId || !Number.isFinite(mtimeMs)) return null;
  const file = readImmutableFile();
  const entry = file.entries[sessionId];
  if (!entry || entry.mtimeMs !== mtimeMs) return null;
  // Defence in depth: strip any live-status key that snuck into a bad write.
  return stripLiveStatusKeys({ ...entry.fields }) as ImmutableSessionFields;
}

/** Persist immutable fields for `(sessionId, mtimeMs)`. Live keys are stripped. */
export function writeImmutableMemo(
  sessionId: string,
  mtimeMs: number,
  fields: ImmutableSessionFields,
  nowMs: number = Date.now(),
): void {
  if (!sessionId || !Number.isFinite(mtimeMs)) return;
  try {
    const dir = path.dirname(immutablePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = readImmutableFile();
    file.entries[sessionId] = {
      mtimeMs,
      fields: stripLiveStatusKeys({ ...fields }) as ImmutableSessionFields,
      writtenAt: nowMs,
    };
    const tmp = `${immutablePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, immutablePath());
  } catch {
    // best-effort
  }
}

/** Drop every live-status key from a field bag (defence in depth). */
export function stripLiveStatusKeys<T extends Record<string, unknown>>(fields: T): T {
  const out = { ...fields };
  for (const k of LIVE_STATUS_KEYS) {
    if (k in out) delete out[k];
  }
  return out;
}

/**
 * True when `fields` contains no live-status key. The invariant the tests pin:
 * the immutable memo never carries status/activity/preview/etc.
 */
export function assertNoLiveStatusFields(fields: Record<string, unknown>): boolean {
  for (const k of LIVE_STATUS_KEYS) {
    if (k in fields && fields[k as string] !== undefined) return false;
  }
  return true;
}

/**
 * Write immutable memos for every session that has an id + transcript mtime.
 * Called after a live gather so the next gather (when mtime is unchanged) can
 * refill identity fields without re-deriving them.
 */
export function updateImmutableMemos(sessions: ReadonlyArray<ActiveSession>, nowMs: number = Date.now()): void {
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const mtime = transcriptMtimeMs(s);
    if (mtime === null) continue;
    writeImmutableMemo(s.sessionId, mtime, pickImmutableFields(s), nowMs);
  }
}

/**
 * Fill missing immutable fields on a live row from the memo when the transcript
 * mtime matches. Never overwrites a field the live gather already set, and
 * never copies live-status keys.
 */
export function applyImmutableMemo(s: ActiveSession): ActiveSession {
  if (!s.sessionId) return s;
  const mtime = transcriptMtimeMs(s);
  if (mtime === null) return s;
  const memo = readImmutableMemo(s.sessionId, mtime);
  if (!memo) return s;
  for (const k of IMMUTABLE_FIELD_KEYS) {
    if (s[k as keyof ActiveSession] === undefined && memo[k] !== undefined) {
      (s as unknown as Record<string, unknown>)[k] = memo[k];
    }
  }
  return s;
}

// ── cache-first load ───────────────────────────────────────────────────────

export interface LoadLocalActiveSessionsOptions {
  /** Skip the cache and re-gather (the force-refresh path). */
  forceRefresh?: boolean;
  /** Freshness window; defaults to {@link DEFAULT_ACTIVE_CACHE_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Clock (injectable for tests). */
  nowMs?: number;
  /**
   * Live gather. Defaults to `getActiveSessions({ localOnly: true })` so a
   * warm never dials a remote-host teammate (RUSH-2118).
   */
  gather?: () => Promise<ActiveSession[]>;
  /** Injectable cache IO for tests. */
  readCache?: typeof readActiveSessionsCache;
  writeCache?: typeof writeActiveSessionsCache;
}

export interface LoadLocalActiveSessionsResult {
  sessions: ActiveSession[];
  /** True when the row set came from the warm snapshot, not a live gather. */
  servedFromCache: boolean;
  capturedAt: number;
}

/**
 * Cache-first load of THIS host's active sessions. Default path serves the
 * daemon-warmed snapshot when fresh; `forceRefresh` or an expired snapshot
 * re-gathers and rewrites the cache.
 */
export async function loadLocalActiveSessions(
  opts: LoadLocalActiveSessionsOptions = {},
): Promise<LoadLocalActiveSessionsResult> {
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_ACTIVE_CACHE_MAX_AGE_MS;
  const readCache = opts.readCache ?? readActiveSessionsCache;
  const writeCache = opts.writeCache ?? writeActiveSessionsCache;

  if (!opts.forceRefresh) {
    const cached = readCache('local');
    if (cached && isActiveSnapshotFresh(cached.capturedAt, now, maxAge)) {
      return {
        sessions: cached.sessions,
        servedFromCache: true,
        capturedAt: cached.capturedAt,
      };
    }
  }

  const gather =
    opts.gather ??
    (async () => {
      const { getActiveSessions } = await import('./active.js');
      return getActiveSessions({ localOnly: true });
    });

  const sessions = await gather();
  // The index owns transcript-derived labels (Claude custom-title / ai-title).
  // Enrich before publishing so the canonical watch snapshot carries the same
  // label as one-shot `sessions --active` output.
  backfillActiveRowsFromIndex(sessions);
  for (const s of sessions) applyImmutableMemo(s);
  updateImmutableMemos(sessions, now);
  const snap = writeCache('local', sessions, { capturedAt: now });
  return { sessions, servedFromCache: false, capturedAt: snap.capturedAt };
}

export interface LoadFleetActiveSessionsOptions {
  forceRefresh?: boolean;
  maxAgeMs?: number;
  nowMs?: number;
  /** Live fleet gather (local + remote). Required — this module does not own SSH. */
  gather: () => Promise<{
    sessions: ActiveSession[];
    remoteDeviceCount: number;
    /** Peer names that went unheard on this gather (RUSH-2507). Undefined when the gather didn't compute it. */
    remoteSkipped?: string[];
    /** True when the device list itself could not be loaded — no peer was even attempted. */
    remoteDiscoveryFailed?: boolean;
  }>;
  readCache?: typeof readActiveSessionsCache;
  writeCache?: typeof writeActiveSessionsCache;
}

export interface LoadFleetActiveSessionsResult {
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  servedFromCache: boolean;
  capturedAt: number;
  /**
   * Diagnostics from the gather that produced this result. Only populated on a
   * live gather (`servedFromCache: false`) — a cache hit serves a prior
   * snapshot that never persisted these fields, so they read `undefined`
   * ("not probed this call") rather than falsely claiming a clean fleet.
   */
  remoteSkipped?: string[];
  remoteDiscoveryFailed?: boolean;
}

/**
 * Cache-first load of the fleet-wide active set. A prior gather (or any surface
 * that just paid the SSH cost) leaves a fleet snapshot; subsequent menubar /
 * Factory / CLI / watchdog calls within the freshness window share it.
 */
export async function loadFleetActiveSessions(
  opts: LoadFleetActiveSessionsOptions,
): Promise<LoadFleetActiveSessionsResult> {
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_ACTIVE_CACHE_MAX_AGE_MS;
  const readCache = opts.readCache ?? readActiveSessionsCache;
  const writeCache = opts.writeCache ?? writeActiveSessionsCache;

  if (!opts.forceRefresh) {
    const cached = readCache('fleet');
    if (cached && isActiveSnapshotFresh(cached.capturedAt, now, maxAge)) {
      return {
        sessions: cached.sessions,
        remoteDeviceCount: cached.remoteDeviceCount ?? 0,
        servedFromCache: true,
        capturedAt: cached.capturedAt,
      };
    }
  }

  const live = await opts.gather();
  for (const s of live.sessions) applyImmutableMemo(s);
  updateImmutableMemos(live.sessions, now);
  const snap = writeCache('fleet', live.sessions, {
    capturedAt: now,
    remoteDeviceCount: live.remoteDeviceCount,
  });
  // Also refresh the local slice so a `--local` reader benefits from this gather.
  // Identity is machineId() when available; fall back to "rows with no machine
  // stamp" so a pure-local gather that never set machine still warms the cache.
  let self: string | undefined;
  try {
    const { machineId } = await import('../machine-id.js');
    self = machineId();
  } catch {
    self = undefined;
  }
  // Always rewrite the local slice when we know self — including the empty
  // case. If the last local session just died, leaving a still-fresh snapshot
  // with ghost rows would make watchdog / `--local` report sessions that are
  // gone (review on RUSH-2062 / PR #2116).
  if (self !== undefined) {
    // "Local" here means the PROCESS is on this box, which is not `machine ===
    // self` for an offloaded run: its shim runs here while the agent executes on
    // the peer (RUSH-2479). The other writer of this same key,
    // `loadLocalActiveSessions`, seeds from `getActiveSessions({localOnly:true})`
    // and keeps that shim — so comparing `machine` here would make the two
    // disagree and leave `--local` showing or hiding the row depending on which
    // surface last warmed the 15s cache.
    const localOnly = live.sessions.filter((s) => sessionProcessIsLocal(s, self));
    writeCache('local', localOnly, { capturedAt: now });
  }
  return {
    sessions: live.sessions,
    remoteDeviceCount: live.remoteDeviceCount,
    servedFromCache: false,
    capturedAt: snap.capturedAt,
    remoteSkipped: live.remoteSkipped,
    remoteDiscoveryFailed: live.remoteDiscoveryFailed,
  };
}

/**
 * Daemon warm entry point: live-gather THIS host and write the local snapshot.
 * Never SSHes. Returns the published row count for the daemon log line.
 */
export async function publishLocalActiveSessions(
  opts: { gather?: () => Promise<ActiveSession[]>; nowMs?: number } = {},
): Promise<{ sessions: ActiveSession[]; capturedAt: number }> {
  const result = await loadLocalActiveSessions({
    forceRefresh: true,
    gather: opts.gather,
    nowMs: opts.nowMs,
  });
  return { sessions: result.sessions, capturedAt: result.capturedAt };
}
