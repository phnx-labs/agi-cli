import * as fs from 'fs';
import { writerProcessView, requireWriterProcessView } from './process-view.js';
import * as path from 'path';

import { createMemoryCache } from '../memory-cache.js';
import { getCacheDir } from '../state.js';
import { backfillActiveRowsFromIndex, foldRecap, sessionProcessIsLocal, type ActiveSession } from './active.js';
import { enrichGlanceFiles } from './glance-files.js';
import { readSessionSummaryAny, readSessionTimelineAny } from './db.js';
import { isSummarizerReady } from '../summarizer/config.js';

const SNAPSHOT_FILE = '.active-sessions.json';
const IMMUTABLE_FILE = '.active-session-immutable.json';
const JOURNAL_FILE = '.active-sessions.journal.jsonl';

export const DEFAULT_ACTIVE_CACHE_MAX_AGE_MS = 15_000;

export type ActiveCacheScope = 'local' | 'fleet';

interface ActiveSessionsSnapshot {
  version: 1;
  scope: ActiveCacheScope;
  capturedAt: number;
  sessions: ActiveSession[];
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

const activeSnapshotMemory = createMemoryCache<ActiveCacheScope, ActiveSessionsSnapshot>({
  max: 2,
  ttlMs: DEFAULT_ACTIVE_CACHE_MAX_AGE_MS,
});

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

// Immutable transcript-mtime memoization must never absorb volatile status, activity, or preview truth.
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
  writtenAt: number;
}

interface ImmutableMemoFile {
  version: 1;
  entries: Record<string, ImmutableMemoEntry>;
}

export const ACTIVE_SESSIONS_READER_IDLE_WINDOW_MS = 45_000;


let snapshotPathOverride: string | null = null;
let immutablePathOverride: string | null = null;
let journalPathOverride: string | null = null;
let readerPresencePathOverride: string | null = null;

export function setActiveSessionsSnapshotPathForTest(p: string | null): string | null {
  const prev = snapshotPathOverride;
  snapshotPathOverride = p;
  activeSnapshotMemory.clear();
  return prev;
}

export function clearActiveSnapshotMemoryForTest(): void {
  activeSnapshotMemory.clear();
}

export function setImmutableMemoPathForTest(p: string | null): string | null {
  const prev = immutablePathOverride;
  immutablePathOverride = p;
  return prev;
}

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

export function noteActiveSessionsJournalReader(nowMs: number = Date.now()): void {
  try {
    const p = readerPresencePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(nowMs));
  } catch {  }
}

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

const ACTIVE_SESSIONS_READER_TRANSITION_POLL_MS = 1_000;

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
    }
    const hadPrevious = Boolean(entries[scope]);
    const previousSessions = entries[scope]?.sessions ?? [];
    entries[scope] = snap;
    const body: SnapshotFile = { version: 1, entries };
    const tmp = `${snapshotPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, snapshotPath());
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
    }
    activeSnapshotMemory.set(scope, snap);
  } catch {
  }
  return snap;
}

export function isActiveSnapshotFresh(
  capturedAt: number,
  nowMs: number,
  maxAgeMs: number = DEFAULT_ACTIVE_CACHE_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(capturedAt) || !Number.isFinite(maxAgeMs)) return false;
  if (maxAgeMs < 0) return false;
  return nowMs - capturedAt <= maxAgeMs;
}


export function pickImmutableFields(s: ActiveSession): ImmutableSessionFields {
  const out: ImmutableSessionFields = {};
  for (const k of IMMUTABLE_FIELD_KEYS) {
    const v = s[k as keyof ActiveSession];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

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
  }
  return { version: 1, entries: {} };
}

export function readImmutableMemo(
  sessionId: string,
  mtimeMs: number,
): ImmutableSessionFields | null {
  if (!sessionId || !Number.isFinite(mtimeMs)) return null;
  const file = readImmutableFile();
  const entry = file.entries[sessionId];
  if (!entry || entry.mtimeMs !== mtimeMs) return null;
  return stripLiveStatusKeys({ ...entry.fields }) as ImmutableSessionFields;
}

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
  }
}

export function stripLiveStatusKeys<T extends Record<string, unknown>>(fields: T): T {
  const out = { ...fields };
  for (const k of LIVE_STATUS_KEYS) {
    if (k in out) delete out[k];
  }
  return out;
}

export function assertNoLiveStatusFields(fields: Record<string, unknown>): boolean {
  for (const k of LIVE_STATUS_KEYS) {
    if (k in fields && fields[k as string] !== undefined) return false;
  }
  return true;
}

export function updateImmutableMemos(sessions: ReadonlyArray<ActiveSession>, nowMs: number = Date.now()): void {
  requireWriterProcessView();
  for (const s of sessions) {
    if (!s.sessionId) continue;
    const mtime = transcriptMtimeMs(s);
    if (mtime === null) continue;
    writeImmutableMemo(s.sessionId, mtime, pickImmutableFields(s), nowMs);
  }
}

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
  }
  return s;
}

export function resolveStreamSummaryState(
  current: import('@phnx-labs/sessions-cli/reader').SummaryState | undefined,
  nowMs: number = Date.now(),
): import('@phnx-labs/sessions-cli/reader').SummaryState {
  if (current) return current;
  return isSummarizerReady(nowMs) ? 'pending' : 'skipped';
}

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
      const changed = s.request?.headline !== stored.request.headline || s.request?.turns !== stored.request.turns;
      s.request = stored.request;
      if (changed) foldRecap([s]);
    }
  } catch {
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


interface LoadLocalActiveSessionsOptions {
  forceRefresh?: boolean;
  maxAgeMs?: number;
  nowMs?: number;
  gather?: () => Promise<ActiveSession[]>;
  readCache?: typeof readActiveSessionsCache;
  writeCache?: typeof writeActiveSessionsCache;
}

interface LoadLocalActiveSessionsResult {
  sessions: ActiveSession[];
  servedFromCache: boolean;
  capturedAt: number;
}

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


      const self = machineId();
      const rows = await getActiveSessions({ localOnly: true });
      for (const s of rows) if (!s.machine) s.machine = self;
      return rows;
    });

  const sessions = await gather();
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
  gather: () => Promise<{
    sessions: ActiveSession[];
    remoteDeviceCount: number;
    remoteSkipped?: string[];
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
  remoteSkipped?: string[];
  remoteDiscoveryFailed?: boolean;
}

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
  let self: string | undefined;
  try {
    const { machineId } = await import('../machine-id.js');
    self = machineId();
  } catch {
    self = undefined;
  }
  if (self !== undefined) {
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

// Daemon warm publishes this host only and never SSHes; readers may write fleet snapshots without becoming a second publisher.
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
