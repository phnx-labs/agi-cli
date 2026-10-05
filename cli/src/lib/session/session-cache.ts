/** Daemon-warmed cross-surface cache for live session status (RUSH-2062); each surface ran its own
 * ~9s `--active` gather. Daemons publish only their own host (no cross-host SSH, RUSH-2061).
 * Stable fields are memoized on (sessionId, transcriptMtimeMs); live status never is. */
import * as fs from 'fs';
import { writerProcessView, requireWriterProcessView } from './process-view.js';
import * as path from 'path';

import { createMemoryCache } from '../memory-cache.js';
import { getCacheDir } from '../state.js';
import { backfillActiveRowsFromIndex, foldRecap, sessionProcessIsLocal, type ActiveSession } from './active.js';
import { enrichGlanceFiles } from './glance-files.js';
import { readSessionSummaryAny, readSessionTimelineAny } from './db.js';
import { isSummarizerReady } from '../summarizer/config.js';

/** Snapshot file under `getCacheDir()` (regenerable, gitignored). */
const SNAPSHOT_FILE = '.active-sessions.json';
/** Immutable-field memo file (keyed by sessionId + transcript mtime). */
const IMMUTABLE_FILE = '.active-session-immutable.json';
const JOURNAL_FILE = '.active-sessions.journal.jsonl';

/** How long a snapshot may be served before a reader re-gathers. Short so live status does not
 * go stale. Long-lived watchers never re-gather: they read one reset then tail the writer
 * journal. */
export const DEFAULT_ACTIVE_CACHE_MAX_AGE_MS = 15_000;

/** Snapshot scope: this host only, or a fleet-wide merge written by a reader. */
export type ActiveCacheScope = 'local' | 'fleet';

interface ActiveSessionsSnapshot {
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

/** Per-session fields stable until the transcript changes, keyed on transcript mtime so a
 * rewrite invalidates them. Live status is intentionally absent (see LIVE_STATUS_KEYS). */
interface ImmutableSessionFields {
  topic?: string;
  firstUserMessage?: string;
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
  'firstUserMessage',
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

/** Live/volatile fields that must not be served from the immutable memo: they change without a
 * transcript write (pid death, attach state) or are short-window signals. Only the short
 * snapshot TTL may carry them, as a whole row. */
export const LIVE_STATUS_KEYS = [
  'status',
  'activity',
  'model',
  'failures',
  'activityHistogram',
  'userTurns',
  'subagents',
  'preview',
  'tokPerSec',
  'awaitingReason',
  'question',
  'todos',
  'tail',
  'lastActivityMs',
  'lastEventMs',
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

/** How long after the last reader heartbeat the daemon skips the expensive `ps`+`lsof` gather. Must
 * well exceed SESSION_WATCH_HEARTBEAT_MS (15s) to avoid false idle; three ticks cuts load within
 * ~45s. */
export const ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS = 45_000;

// ── path overrides (test seam) ─────────────────────────────────────────────

let snapshotPathOverride: string | null = null;
let immutablePathOverride: string | null = null;
let journalPathOverride: string | null = null;
let readerPresencePathOverride: string | null = null;

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

/** Test seam: redirect the reader-presence file. Returns the previous override. */
export function setActiveSessionsReaderPresencePathForTest(p: string | null): string | null {
  const prev = readerPresencePathOverride;
  readerPresencePathOverride = p;
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

const READER_PRESENCE_FILE = '.active-sessions-reader.presence';

function readerPresencePath(): string {
  return readerPresencePathOverride ?? path.join(getCacheDir(), READER_PRESENCE_FILE);
}

/** Record that a journal consumer is active now. Called by watchLocalSessions on startup and
 * each heartbeat so the daemon warm tick can skip the expensive `ps`+`lsof` gather when no
 * watcher has checked in. */
export function noteActiveSessionsJournalReader(nowMs: number = Date.now()): void {
  try {
    const p = readerPresencePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(nowMs));
  } catch { /* best-effort: a failed write does not block the caller */ }
}

/** True when a journal consumer signalled within ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS. An idle
 * box with no watcher skips the gather; a new watcher calls noteActiveSessionsJournalReader
 * and the next tick gathers. */
export function isActiveSessionsJournalReaderRecent(
  nowMs: number = Date.now(),
  idleWindowMs: number = ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS,
): boolean {
  try {
    const content = fs.readFileSync(readerPresencePath(), 'utf8').trim();
    const ts = Number(content);
    if (!Number.isFinite(ts)) return false;
    return nowMs - ts < idleWindowMs;
  } catch {
    return false;
  }
}

/** Default poll cadence for {@link watchActiveSessionsReaderPresence}. */
const ACTIVE_SESSIONS_READER_TRANSITION_POLL_MS = 1_000;

/** Fire `onConnect` out of band when a reader goes absent/idle to present (RUSH-2484), instead of
 * waiting up to a warm tick. Polls the tiny presence file and fires only on the idle->recent edge,
 * so an idle box never gathers (RUSH-3193). Returns a disposer. */
export function watchActiveSessionsReaderPresence(
  onConnect: () => void,
  opts: { pollMs?: number; idleWindowMs?: number; nowMs?: () => number } = {},
): () => void {
  const pollMs = opts.pollMs ?? ACTIVE_SESSIONS_READER_TRANSITION_POLL_MS;
  const now = opts.nowMs ?? Date.now;
  let lastRecent = isActiveSessionsJournalReaderRecent(now(), opts.idleWindowMs);
  const timer = setInterval(() => {
    const recent = isActiveSessionsJournalReaderRecent(now(), opts.idleWindowMs);
    if (recent && !lastRecent) onConnect();
    lastRecent = recent;
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
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

/** Persist a snapshot for one scope (best-effort), preserving other scopes so a local warm
 * never drops a fleet snapshot a reader just wrote. */
export function writeActiveSessionsCache(
  scope: ActiveCacheScope,
  sessions: ActiveSession[],
  opts: { capturedAt?: number; remoteDeviceCount?: number } = {},
): ActiveSessionsSnapshot {
  requireWriterProcessView();
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

/** True when a snapshot is within the freshness window. Pure; the staleness invariant for live
 * status lives here. */
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

/** Transcript mtime used as the memo key: prefer `lastActivityMs`, fall back to `startedAtMs`.
 * Null when neither is known, in which case the caller must not memoize. */
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

/** Read memoized immutable fields for `(sessionId, mtimeMs)`. Null when missing or the stored
 * mtime differs, so a transcript rewrite forces re-derivation. */
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

/** True when `fields` has no live-status key. The invariant the tests pin: the immutable memo
 * never carries status, activity, preview and the like. */
export function assertNoLiveStatusFields(fields: Record<string, unknown>): boolean {
  for (const k of LIVE_STATUS_KEYS) {
    if (k in fields && fields[k as string] !== undefined) return false;
  }
  return true;
}

/** Write immutable memos for every session with an id and transcript mtime, after a live
 * gather, so the next gather with an unchanged mtime can refill identity fields. */
export function updateImmutableMemos(sessions: ReadonlyArray<ActiveSession>, nowMs: number = Date.now()): void {
  requireWriterProcessView();
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const mtime = transcriptMtimeMs(s);
    if (mtime === null) continue;
    writeImmutableMemo(s.sessionId, mtime, pickImmutableFields(s), nowMs);
  }
}

/** Fill missing immutable fields on a live row from the memo when the transcript mtime matches.
 * Never overwrites a field the gather set and never copies live-status keys. */
/** Merge the daemon-computed summary (PHNX-3939) onto a live row from `session_summaries`: one
 * by-id read, never a model call. The `pending`/`skipped` default is applied at the watch-stream
 * boundary. Best-effort on DB error. */
function mergeSessionSummary(s: ActiveSession): ActiveSession {
  if (!s.sessionId) return s;
  try {
    const stored = readSessionSummaryAny(s.sessionId);
    if (!stored) return s;
    if (s.goal === undefined && stored.goal !== undefined) s.goal = stored.goal;
    if (s.checkpoints === undefined && stored.checkpoints !== undefined) s.checkpoints = stored.checkpoints;
    if (s.summaryChecklist === undefined && stored.summaryChecklist !== undefined) s.summaryChecklist = stored.summaryChecklist;
    if (s.summaryState === undefined) s.summaryState = stored.summaryState;
  } catch {
    // best-effort: never let the summary merge break the gather path.
  }
  return s;
}

/** The `summaryState` for a watch-stream row the merge left unset: `pending` when the summarizer is
 * ready (enabled and has an endpoint), `skipped` when off or unconfigured. The only read-path use
 * of the readiness flag, and memoized (PHNX-3939). */
export function resolveStreamSummaryState(
  current: import('@phnx-labs/sessions-cli/reader').SummaryState | undefined,
  nowMs: number = Date.now(),
): import('@phnx-labs/sessions-cli/reader').SummaryState {
  if (current) return current;
  return isSummarizerReady(nowMs) ? 'pending' : 'skipped';
}

/** Merge the daemon-folded timeline (PHNX-3939) onto a live row from `session_timelines`; same
 * contract as mergeSessionSummary: one by-id read of the bounded projection, no parse, no
 * model call. `runTimelinePass` is the only producer. Best-effort. */
export function mergeSessionTimeline(s: ActiveSession): ActiveSession {
  if (!s.sessionId) return s;
  try {
    const stored = readSessionTimelineAny(s.sessionId);
    if (!stored) return s;
    for (const key of ['model', 'failures', 'activityHistogram', 'userTurns', 'attachments', 'subagents'] as const) {
      if (stored[key] !== undefined) Object.assign(s, { [key]: stored[key] });
    }
    if (s.subagents) s.subAgentCount = s.subagents.length;
    if (s.timeline === undefined) s.timeline = stored.timeline;
    if (s.files === undefined && stored.files !== undefined) s.files = stored.files;
    if (stored.request) {
      // `request` is the one field where the fold wins: the index lags a live session by up to a
      // scan, while the daemon fold read the transcript this tick. The recap is re-derived so
      // title and `userPromptClean` stay consistent.
      const changed = s.request?.headline !== stored.request.headline || s.request?.turns !== stored.request.turns;
      s.request = stored.request;
      if (changed) foldRecap([s]);
    }
  } catch {
    // best-effort: never let the timeline merge break the gather path.
  }
  return s;
}

export function applyImmutableMemo(s: ActiveSession): ActiveSession {
  if (!s.sessionId) return s;
  mergeSessionSummary(s);
  mergeSessionTimeline(s);
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

interface LoadLocalActiveSessionsOptions {
  /** Skip the cache and re-gather (the force-refresh path). */
  forceRefresh?: boolean;
  /** Freshness window; defaults to {@link DEFAULT_ACTIVE_CACHE_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Clock (injectable for tests). */
  nowMs?: number;
  /** Live gather. Defaults to `getActiveSessions({ localOnly: true })` so a warm never dials a
   * remote-host teammate (RUSH-2118). */
  gather?: () => Promise<ActiveSession[]>;
  /** Injectable cache IO for tests. */
  readCache?: typeof readActiveSessionsCache;
  writeCache?: typeof writeActiveSessionsCache;
}

interface LoadLocalActiveSessionsResult {
  sessions: ActiveSession[];
  /** True when the row set came from the warm snapshot, not a live gather. */
  servedFromCache: boolean;
  capturedAt: number;
}

/** Cache-first load of this host's active sessions: serves the daemon-warmed snapshot when
 * fresh; `forceRefresh` or expiry re-gathers and rewrites the cache. */
export async function loadLocalActiveSessions(
  opts: LoadLocalActiveSessionsOptions = {},
): Promise<LoadLocalActiveSessionsResult> {
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_ACTIVE_CACHE_MAX_AGE_MS;
  const readCache = opts.readCache ?? readActiveSessionsCache;
  const writeCache = opts.writeCache ?? writeActiveSessionsCache;

  if (!writerProcessView()) {
    const cached = readCache('local');
    if (cached) return { sessions: cached.sessions, servedFromCache: true, capturedAt: cached.capturedAt };
    requireWriterProcessView();
  }

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
      const [{ getActiveSessions }, { machineId }] = await Promise.all([
        import('./active.js'),
        import('../machine-id.js'),
      ]);
      // Stamp this box like every other gatherer: a row with no machine fails
      // isRunningLiveSession, so a daemon-published snapshot read `--active` empty.
      const self = machineId();
      const rows = await getActiveSessions({ localOnly: true });
      for (const s of rows) if (!s.machine) s.machine = self;
      return rows;
    });

  const sessions = await gather();
  // The index owns transcript-derived labels (Claude custom-title / ai-title).
  // Enrich before publishing so the canonical watch snapshot carries the same
  // label as one-shot `sessions --active` output.
  backfillActiveRowsFromIndex(sessions);
  for (const s of sessions) applyImmutableMemo(s);
  enrichGlanceFiles(sessions, now);
  updateImmutableMemos(sessions, now);
  const snap = writeCache('local', sessions, { capturedAt: now });
  return { sessions, servedFromCache: false, capturedAt: snap.capturedAt };
}

interface LoadFleetActiveSessionsOptions {
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

interface LoadFleetActiveSessionsResult {
  sessions: ActiveSession[];
  remoteDeviceCount: number;
  servedFromCache: boolean;
  capturedAt: number;
  /** Diagnostics from the gather that produced this result. Only set on a live gather: a cache
   * hit leaves them undefined ('not probed') rather than falsely claiming a clean fleet. */
  remoteSkipped?: string[];
  remoteDiscoveryFailed?: boolean;
}

/** Cache-first load of the fleet-wide active set. A gather by any surface that paid the SSH
 * cost leaves a snapshot that menubar, Factory, CLI and watchdog share within the freshness
 * window. */
export async function loadFleetActiveSessions(
  opts: LoadFleetActiveSessionsOptions,
): Promise<LoadFleetActiveSessionsResult> {
  const now = opts.nowMs ?? Date.now();
  const maxAge = opts.maxAgeMs ?? DEFAULT_ACTIVE_CACHE_MAX_AGE_MS;
  const readCache = opts.readCache ?? readActiveSessionsCache;
  const writeCache = opts.writeCache ?? writeActiveSessionsCache;

  if (!writerProcessView()) {
    const cached = readCache('fleet');
    if (cached) return { sessions: cached.sessions, remoteDeviceCount: cached.remoteDeviceCount ?? 0, servedFromCache: true, capturedAt: cached.capturedAt };
    requireWriterProcessView();
  }

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
  // Always rewrite the local slice when self is known, even if empty: leaving a fresh snapshot
  // with ghost rows would make watchdog and `--local` report dead sessions (RUSH-2062, PR #2116).
  if (self !== undefined) {
    // 'Local' means the process is on this box, not `machine === self`: an offloaded run's shim
    // runs here (RUSH-2479). `loadLocalActiveSessions` keeps that shim, so comparing `machine`
    // would make `--local` flip by last warmer.
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

/** Daemon warm entry point: live-gather this host and write the local snapshot. Never SSHes.
 * Returns the published row count for the daemon log. */
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
