import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDevices, isDialableDevice } from '../../devices/registry.js';
import { machineId, normalizeHost } from '../../machine-id.js';
import { shellQuote } from '../../ssh-exec.js';
import { streamFromPeer } from './peer-stream.js';
import { buildWindowsAgentsCommand, remoteShellFor } from '../../hosts/remote-cmd.js';
import { isReapableOrphan, type ActiveSession } from '../active.js';
import { querySessions, readSessionSummaryAny, readSessionTimelineAny } from '../db.js';
import { linearIssueUrl } from '../linear.js';
import { sessionAgentSupportsResume } from '../recovery.js';
import { SESSION_AGENTS, type SessionMeta } from '../types.js';
import {
  activeSessionsJournalPath,
  activeSessionJournalIdentity,
  readActiveSessionsCache,
  noteActiveSessionsJournalReader,
  resolveStreamSummaryState,
  type ActiveSessionsJournalRecord,
} from '../session-cache.js';

export const SESSION_WATCH_VERSION = 1 as const;
export const SESSION_WATCH_HEARTBEAT_MS = 15_000;
export const SESSION_WATCH_PREVIOUS_LIMIT = 50;

export type SessionWatchScopeStatus = 'available' | 'unavailable';

export type SessionWatchEnvelope =
  | { version: 1; type: 'reset'; streamId: string; sequence: number; capturedAt: number; scope: string; rows: SessionWatchRow[] }
  | { version: 1; type: 'upsert'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string; row: SessionWatchRow }
  | { version: 1; type: 'remove'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string }
  | { version: 1; type: 'scope'; streamId: string; sequence: number; capturedAt: number; scope: string; status: SessionWatchScopeStatus; reason?: string }
  | { version: 1; type: 'heartbeat'; streamId: string; sequence: number; scope: string; capturedAt: number };

export interface SessionWatchRow extends Omit<ActiveSession, 'viewingIn' | 'context'> {
  context: ActiveSession['context'] | 'recent';
  /** Flat durable branch for history rows that are not currently in a worktree. */
  branch?: string;
  rowKey: string;
  sourceDevice: string;
  /** Durable index rows are kept on the stream under a distinct identity so a
   * live row can replace/disappear without erasing its recoverable history. */
  previous: boolean;
  resumable: boolean;
  unwatched: boolean;
  viewingIn: string | null;
  recovery: { command: 'agents'; args: string[]; cwd?: string } | null;
}

/** Stable, opaque identity for one row within one device scope. */
export function sessionWatchRowKey(scope: string, row: ActiveSession): string {
  const identity = activeSessionJournalIdentity(row);
  return createHash('sha256').update(`${scope}\0${identity}`).digest('base64url').slice(0, 22);
}

export function toSessionWatchRow(scope: string, row: ActiveSession): SessionWatchRow {
  const rowKey = sessionWatchRowKey(scope, row);
  // A dead, days-stale crash-orphan is folded OUT of the reconnectable set — it
  // is not resumable, so the "Needs reconnecting" list stops ballooning with
  // leaked --device tunnel sessions (RUSH-3011 / issue #3b). A live or
  // recently-exited session stays resumable.
  const resumable = Boolean(row.sessionId) && !isReapableOrphan(row);
  const previous = row.status === 'closed'
    || row.status === 'crashed'
    || (row.status === 'abandoned' && row.pidAlive === false);
  const viewingIn = row.viewingIn
    ? [row.viewingIn.app, row.viewingIn.tab ? `tab ${row.viewingIn.tab}` : undefined].filter(Boolean).join(' ')
    : null;
  return {
    ...row,
    // The summarizer's per-row state is delivered on the stream: a live row with
    // no computed summary reads `pending` when the summarizer is on, `skipped`
    // when it is off (PHNX-3939). goal/checkpoints/summaryChecklist rode `...row`.
    summaryState: resolveStreamSummaryState(row.summaryState),
    rowKey,
    sourceDevice: scope,
    previous,
    resumable,
    unwatched: !viewingIn,
    viewingIn,
    recovery: resumable
      ? { command: 'agents', args: ['sessions', 'resume', row.sessionId!, '--device', scope], ...(row.cwd ? { cwd: row.cwd } : {}) }
      : null,
  };
}

function epochMs(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable identity for a durable Previous row. It is deliberately distinct
 * from the live row key for the same session id: both may coexist on the one
 * stream, and the presentation layer lets the live row win while it exists. */
export function previousSessionWatchRowKey(scope: string, sessionId: string): string {
  return createHash('sha256').update(`${scope}\0previous\0${sessionId}`).digest('base64url').slice(0, 22);
}

/** Project one durable indexed session into the same canonical watch contract
 * as live sessions. This is the only history backfill consumed by AGI EXT. */
export function toPreviousSessionWatchRow(scope: string, session: SessionMeta): SessionWatchRow {
  const resumable = sessionAgentSupportsResume(session.agent);
  const sourceDevice = normalizeHost(session.machine ?? scope);
  const startedAtMs = epochMs(session.timestamp);
  const lastActivityMs = epochMs(session.lastActivity) || startedAtMs;
  const worktree = session.worktreeSlug && session.cwd
    ? { slug: session.worktreeSlug, path: session.cwd, ...(session.gitBranch ? { branch: session.gitBranch } : {}) }
    : undefined;
  // Project the daemon-computed summary (PHNX-3939) onto the history row from the
  // transcript-keyed cache — the same store the live merge reads, so a closed or
  // fleet-mirrored session carries its goal/checkpoints/checklist with no
  // transcript re-parse and no model call. Prefer a value already on the meta row.
  const summary = session.goal !== undefined || session.summaryState !== undefined
    ? {
        goal: session.goal,
        checkpoints: session.checkpoints,
        summaryChecklist: session.summaryChecklist,
        summaryState: session.summaryState,
      }
    : readSessionSummaryAny(session.id);
  // Project the daemon-folded timeline onto the history row from the same
  // transcript-keyed cache the live merge reads (PHNX-3939), so a closed session
  // still shows the request it was given and what the agent did — no re-parse.
  const folded = readSessionTimelineAny(session.id);
  return {
    context: 'recent',
    kind: session.agent,
    ...(session.harness ? { harness: session.harness } : {}),
    sessionId: session.id,
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.project ? { project: session.project } : {}),
    // `request.headline` is the user's own sentence with the attachment noise
    // pulled out, so it beats the raw `topic` for the row title — a `/model` echo
    // or a skill body can no longer become a session's name (PHNX-3939).
    ...(session.label
      ? { label: session.label, title: session.label }
      : folded?.request?.headline
        ? { title: folded.request.headline }
        : session.topic ? { title: session.topic } : {}),
    ...(session.topic ? { topic: session.topic } : {}),
    ...(session.firstUserMessage ? { firstUserMessage: session.firstUserMessage } : {}),
    ...(session.version ? { version: session.version } : {}),
    ...(session.account ? { account: session.account } : {}),
    ...(session.accountKey ? { accountKey: session.accountKey } : {}),
    ...(session.prUrl ? { pr: { url: session.prUrl, number: session.prNumber } } : {}),
    ...(worktree ? { worktree } : {}),
    ...(session.gitBranch ? { branch: session.gitBranch } : {}),
    ...(session.ticketId ? { ticket: { id: session.ticketId, url: linearIssueUrl(session.ticketId) } } : {}),
    ...(session.createdTickets ? { createdTickets: session.createdTickets } : {}),
    ...(session.spawnedTeam ? { spawnedTeam: session.spawnedTeam } : {}),
    ...(session.tokenCount != null ? { tokenCount: session.tokenCount } : {}),
    ...(session.durationMs != null ? { durationMs: session.durationMs } : {}),
    ...(session.subAgentCount != null ? { subAgentCount: session.subAgentCount } : {}),
    ...(summary?.goal ? { goal: summary.goal } : {}),
    ...(summary?.checkpoints ? { checkpoints: summary.checkpoints } : {}),
    ...(summary?.summaryChecklist ? { summaryChecklist: summary.summaryChecklist } : {}),
    summaryState: resolveStreamSummaryState(summary?.summaryState),
    ...(folded?.request ? { request: folded.request } : {}),
    ...(folded?.timeline ? { timeline: folded.timeline } : {}),
    ...(folded?.files ? { files: folded.files } : {}),
    startedAtMs,
    lastActivityMs,
    status: 'closed',
    phase: 'done',
    pidAlive: false,
    rowKey: previousSessionWatchRowKey(scope, session.id),
    sourceDevice,
    previous: true,
    resumable,
    unwatched: true,
    viewingIn: null,
    recovery: resumable
      ? { command: 'agents', args: ['sessions', 'resume', session.id, '--device', sourceDevice], ...(session.cwd ? { cwd: session.cwd } : {}) }
      : null,
  };
}

function demoteWatchRow(scope: string, row: SessionWatchRow): SessionWatchRow | null {
  if (!row.sessionId || row.rowKey === previousSessionWatchRowKey(scope, row.sessionId)) return null;
  const sourceDevice = row.sourceDevice || scope;
  return {
    ...row,
    context: 'recent',
    status: 'closed',
    phase: 'done',
    pidAlive: false,
    rowKey: previousSessionWatchRowKey(scope, row.sessionId),
    previous: true,
    unwatched: true,
    viewingIn: null,
    recovery: row.resumable
      ? { command: 'agents', args: ['sessions', 'resume', row.sessionId, '--device', sourceDevice], ...(row.cwd ? { cwd: row.cwd } : {}) }
      : null,
  };
}

function isDurablePreviousRow(scope: string, row: SessionWatchRow): boolean {
  return Boolean(row.sessionId) && row.rowKey === previousSessionWatchRowKey(scope, row.sessionId!);
}

function rowRecency(row: SessionWatchRow): number {
  return row.lastActivityMs ?? row.startedAtMs ?? 0;
}

function sameRow(a: SessionWatchRow, b: SessionWatchRow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Stream-local sequencer and convergent row diff. */
export class SessionWatchState {
  readonly streamId: string;
  private sequence = 0;
  private readonly rows = new Map<string, Map<string, SessionWatchRow>>();

  constructor(streamId: string = randomUUID()) { this.streamId = streamId; }

  private base<T extends SessionWatchEnvelope['type']>(type: T): { version: 1; type: T; streamId: string; sequence: number; capturedAt: number } {
    return { version: SESSION_WATCH_VERSION, type, streamId: this.streamId, sequence: ++this.sequence, capturedAt: Date.now() };
  }

  /** Keep one visible Previous row per session and the newest bounded window.
   * Returns removed keys so delta callers can converge already-connected clients. */
  private prunePrevious(scope: string, rows: Map<string, SessionWatchRow>): string[] {
    const removed: string[] = [];
    const bySession = new Map<string, SessionWatchRow>();
    for (const row of rows.values()) {
      if (!row.previous || !row.sessionId) continue;
      const existing = bySession.get(row.sessionId);
      if (!existing) {
        bySession.set(row.sessionId, row);
        continue;
      }
      const keepRow = rowRecency(row) > rowRecency(existing)
        || (rowRecency(row) === rowRecency(existing) && isDurablePreviousRow(scope, row));
      const drop = keepRow ? existing : row;
      const keep = keepRow ? row : existing;
      if (rows.delete(drop.rowKey)) removed.push(drop.rowKey);
      bySession.set(row.sessionId, keep);
    }
    const previous = [...bySession.values()].sort((a, b) => rowRecency(b) - rowRecency(a));
    for (const row of previous.slice(SESSION_WATCH_PREVIOUS_LIMIT)) {
      if (rows.delete(row.rowKey)) removed.push(row.rowKey);
    }
    return removed;
  }

  reset(scope: string, sourceRows: ActiveSession[], indexedRows: SessionMeta[] = []): SessionWatchEnvelope {
    const liveRows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    const sourceIds = new Set(liveRows.map((row) => row.sessionId).filter((id): id is string => Boolean(id)));
    const rows = new Map<string, SessionWatchRow>(liveRows.map((row) => [row.rowKey, row]));
    for (const indexed of indexedRows) {
      if (sourceIds.has(indexed.id)) continue;
      const row = toPreviousSessionWatchRow(scope, indexed);
      rows.set(row.rowKey, row);
    }
    this.prunePrevious(scope, rows);
    this.rows.set(scope, rows);
    return { ...this.base('reset'), scope, rows: [...rows.values()] };
  }

  update(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope[] {
    const previous = this.rows.get(scope) ?? new Map<string, SessionWatchRow>();
    const nextRows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    const activeIds = new Set(nextRows.filter((row) => !row.previous).map((row) => row.sessionId).filter((id): id is string => Boolean(id)));
    const next = new Map(
      [...previous.values()]
        .filter((row) => isDurablePreviousRow(scope, row) && (!row.sessionId || !activeIds.has(row.sessionId)))
        .map((row) => [row.rowKey, row]),
    );
    for (const row of nextRows) next.set(row.rowKey, row);
    const events: SessionWatchEnvelope[] = [];
    for (const [rowKey, row] of next) {
      if (!previous.has(rowKey) || !sameRow(previous.get(rowKey)!, row)) {
        events.push({ ...this.base('upsert'), scope, rowKey, row });
      }
    }
    for (const [rowKey, row] of previous) {
      if (next.has(rowKey)) continue;
      if (isDurablePreviousRow(scope, row) && (!row.sessionId || !activeIds.has(row.sessionId))) continue;
      events.push({ ...this.base('remove'), scope, rowKey });
      const demoted = demoteWatchRow(scope, row);
      if (demoted && (!next.has(demoted.rowKey) || !sameRow(next.get(demoted.rowKey)!, demoted))) {
        next.set(demoted.rowKey, demoted);
        events.push({ ...this.base('upsert'), scope, rowKey: demoted.rowKey, row: demoted });
      }
    }
    for (const rowKey of this.prunePrevious(scope, next)) {
      events.push({ ...this.base('remove'), scope, rowKey });
    }
    this.rows.set(scope, next);
    return events;
  }

  patch(scope: string, upserts: ActiveSession[], removes: string[]): SessionWatchEnvelope[] {
    const current = new Map(this.rows.get(scope) ?? []);
    const events: SessionWatchEnvelope[] = [];
    for (const source of upserts) {
      const row = toSessionWatchRow(scope, source);
      if (!row.previous && row.sessionId) {
        const previousKey = previousSessionWatchRowKey(scope, row.sessionId);
        if (current.delete(previousKey)) events.push({ ...this.base('remove'), scope, rowKey: previousKey });
      }
      if (!current.has(row.rowKey) || !sameRow(current.get(row.rowKey)!, row)) {
        current.set(row.rowKey, row);
        events.push({ ...this.base('upsert'), scope, rowKey: row.rowKey, row });
      }
    }
    for (const identity of removes) {
      const rowKey = createHash('sha256').update(`${scope}\0${identity}`).digest('base64url').slice(0, 22);
      const removed = current.get(rowKey);
      if (!current.delete(rowKey)) continue;
      events.push({ ...this.base('remove'), scope, rowKey });
      const demoted = removed ? demoteWatchRow(scope, removed) : null;
      if (demoted && (!current.has(demoted.rowKey) || !sameRow(current.get(demoted.rowKey)!, demoted))) {
        current.set(demoted.rowKey, demoted);
        events.push({ ...this.base('upsert'), scope, rowKey: demoted.rowKey, row: demoted });
      }
    }
    for (const rowKey of this.prunePrevious(scope, current)) {
      events.push({ ...this.base('remove'), scope, rowKey });
    }
    this.rows.set(scope, current);
    return events;
  }

  scope(scope: string, status: SessionWatchScopeStatus, reason?: string): SessionWatchEnvelope {
    // Deliberately retain rows while unavailable. A reconnecting scope replaces
    // them with a reset; transient fleet loss must not look like session death.
    return { ...this.base('scope'), scope, status, ...(reason ? { reason } : {}) };
  }

  heartbeat(scope: string, capturedAt: number = Date.now()): SessionWatchEnvelope {
    return { ...this.base('heartbeat'), scope, capturedAt };
  }
}

export interface WatchLocalOptions {
  scope: string;
  signal: AbortSignal;
  emit: (event: SessionWatchEnvelope) => void;
  refreshMs?: number;
  heartbeatMs?: number;
  readCache?: typeof readActiveSessionsCache;
  readPrevious?: (scope: string) => SessionMeta[];
  journalPath?: string;
  journalPollMs?: number;
}

/** One bounded index read when the watch starts. The stream then owns this
 * projection: active rows update through the journal, and removals demote into
 * Previous rows without another transcript/index poll. */
export function readPreviousSessionsForWatch(scope: string): SessionMeta[] {
  try {
    return querySessions({
      machine: normalizeHost(scope),
      // Every harness that writes a discoverable transcript. The list used to be
      // four, so a Kimi/Grok/Cursor/Droid session simply never appeared as a
      // Previous row — and after PHNX-3939 it would also have been the only rows
      // with no request/timeline. Kept explicit (not `SESSION_AGENTS`) so
      // `openclaw`, which has no transcript to project, stays out.
      agents: SESSION_AGENTS.filter((agent) => agent !== 'openclaw'),
      sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
      excludeTeamOrigin: true,
    })
      .filter((session) => !session.archived && Boolean(session.filePath))
      .slice(0, SESSION_WATCH_PREVIOUS_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Keep one local subscription alive. Startup reads one canonical reset snapshot;
 * steady state tails the canonical writer journal and never invokes a gather.
 */
export async function watchLocalSessions(options: WatchLocalOptions): Promise<void> {
  const state = new SessionWatchState();
  const readCache = options.readCache ?? readActiveSessionsCache;
  const readPrevious = options.readPrevious ?? readPreviousSessionsForWatch;
  const journal = options.journalPath ?? activeSessionsJournalPath();
  const heartbeatMs = options.heartbeatMs ?? SESSION_WATCH_HEARTBEAT_MS;
  let offset = 0;
  try { offset = fs.statSync(journal).size; } catch { /* first publication */ }
  const initial = readCache('local');
  options.emit(state.reset(options.scope, initial?.sessions ?? [], readPrevious(options.scope)));
  // Known gap (out of scope for RUSH-2484): a present cache alone marks
  // 'available' with no staleness/age check, so a reconnect can briefly render
  // a stale snapshot as live before the out-of-band gather this file triggers
  // (see watchActiveSessionsReaderPresence in session-cache.ts) replaces it.
  options.emit(state.scope(options.scope, initial ? 'available' : 'unavailable', initial ? undefined : 'awaiting publisher'));
  if (options.signal.aborted) return;
  // Signal the daemon that a consumer is live so it does not skip the gather.
  noteActiveSessionsJournalReader();
  await new Promise<void>((resolve) => {
    let partial = '';
    let reading = false;
    const readAppended = () => {
      if (reading || options.signal.aborted) return;
      reading = true;
      try {
        const size = fs.statSync(journal).size;
        if (size < offset) { offset = 0; partial = ''; }
        if (size === offset) return;
        const fd = fs.openSync(journal, 'r');
        try {
          const buffer = Buffer.alloc(size - offset);
          fs.readSync(fd, buffer, 0, buffer.length, offset);
          offset = size;
          const lines = (partial + buffer.toString('utf8')).split('\n');
          partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line) continue;
            try {
              const record = JSON.parse(line) as ActiveSessionsJournalRecord;
              if (record.version !== 1 || record.scope !== 'local' || !Array.isArray(record.upserts) || !Array.isArray(record.removes)) continue;
              for (const event of state.patch(options.scope, record.upserts, record.removes)) options.emit(event);
              options.emit(state.scope(options.scope, 'available'));
            } catch { /* partial/corrupt journal lines are not state */ }
          }
        } finally { fs.closeSync(fd); }
      } catch { /* journal may not exist until the first publisher write */ }
      finally { reading = false; }
    };
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const journalListener = () => readAppended();
    fs.watchFile(journal, { interval: options.journalPollMs ?? 250 }, journalListener);
    const heartbeatTimer = setInterval(() => {
      noteActiveSessionsJournalReader();
      options.emit(state.heartbeat(options.scope));
    }, heartbeatMs);
    const stop = () => { fs.unwatchFile(journal, journalListener); clearInterval(heartbeatTimer); resolve(); };
    options.signal.addEventListener('abort', stop, { once: true });
    // Close the offset/read/watch handoff: a publisher may append after the
    // startup offset is captured but before watchFile is registered.
    readAppended();
  });
}

export interface WatchFleetOptions {
  signal: AbortSignal;
  emit: (event: SessionWatchEnvelope) => void;
  reconnectMs?: number;
}

function remoteWatchCommand(os: string): string {
  const args = ['sessions', 'watch', '--json', '--local'];
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsAgentsCommand({ args })
    : `bash -lc ${shellQuote(`agents ${args.map(shellQuote).join(' ')}`)}`;
}

/**
 * Subscribe to every dialable compute device with one persistent SSH process.
 * A peer disconnect emits `scope: unavailable` but no removes; reconnecting
 * peer resets only its own scope. There is no recurring fleet list command.
 */
export async function watchFleetSessions(options: WatchFleetOptions): Promise<void> {
  const local = watchLocalSessions({ scope: machineId(), signal: options.signal, emit: options.emit });
  let devices: Awaited<ReturnType<typeof loadDevices>>;
  try { devices = await loadDevices(); }
  catch { await local; return; }
  const self = machineId();
  const peers = Object.values(devices).filter((device) =>
    isDialableDevice(device)
    && normalizeHost(device.name) !== self
    && ['windows', 'linux', 'macos'].includes(device.platform),
  );
  const peerTasks = peers.map(async (device) => {
    const scope = normalizeHost(device.name);
    const state = new SessionWatchState();
    await streamFromPeer({
      device,
      signal: options.signal,
      command: remoteWatchCommand(device.platform),
      backoffBaseMs: options.reconnectMs,
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as SessionWatchEnvelope;
          if (event.version !== SESSION_WATCH_VERSION || typeof event.sequence !== 'number') return false;
          options.emit(event);
          return true;
        } catch { return false; /* incomplete/non-protocol peer output is not state */ }
      },
      onUnavailable: (reason) => options.emit(state.scope(scope, 'unavailable', reason)),
    });
  });
  await Promise.all([local, ...peerTasks]);
}
