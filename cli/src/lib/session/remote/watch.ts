import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDevices, isDialableDevice } from '../../devices/registry.js';
import { deviceIdentityArgs, sshTargetFor } from '../../devices/connect.js';
import { machineId, normalizeHost } from '../../machine-id.js';
import { SSH_OPTS, controlOpts, shellQuote } from '../../ssh-exec.js';
import { buildWindowsAgentsCommand, remoteShellFor } from '../../hosts/remote-cmd.js';
import { derivePhase, isReapableOrphan, type ActiveSession } from '../active.js';
import {
  activeSessionsJournalPath,
  activeSessionJournalIdentity,
  readActiveSessionsCache,
  noteActiveSessionsJournalReader,
  type ActiveSessionsJournalRecord,
} from '../session-cache.js';
import { querySessions } from '../db.js';
import { linearIssueUrl } from '../linear.js';
import type { SessionMeta } from '../types.js';

export const SESSION_WATCH_VERSION = 1 as const;
export const SESSION_WATCH_HEARTBEAT_MS = 15_000;

export type SessionWatchScopeStatus = 'available' | 'unavailable';

export type SessionWatchEnvelope =
  | { version: 1; type: 'reset'; streamId: string; sequence: number; capturedAt: number; scope: string; rows: SessionWatchRow[] }
  | { version: 1; type: 'upsert'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string; row: SessionWatchRow }
  | { version: 1; type: 'remove'; streamId: string; sequence: number; capturedAt: number; scope: string; rowKey: string }
  | { version: 1; type: 'scope'; streamId: string; sequence: number; capturedAt: number; scope: string; status: SessionWatchScopeStatus; reason?: string }
  | { version: 1; type: 'heartbeat'; streamId: string; sequence: number; scope: string; capturedAt: number };

export interface SessionWatchRow extends Omit<ActiveSession, 'viewingIn'> {
  rowKey: string;
  sourceDevice: string;
  resumable: boolean;
  unwatched: boolean;
  viewingIn: string | null;
  recovery: { command: 'agents'; args: string[]; cwd?: string } | null;
  /**
   * True when the row is a durable "Previous" session projected from the
   * transcript index (see {@link ActiveSession.previous}), not a live process.
   * A consumer renders these as its recoverable-history / SessionPicker list; a
   * live row for the same session id always wins the merge, so a `previous` row
   * is only ever surfaced while that session has no live process (PHNX-3621).
   */
  previous: boolean;
}

/**
 * Bounded window and cap for the durable "Previous" rows the local watch stream
 * folds in beside the live set (PHNX-3621). The AGI EXT dropped its own
 * `fetchPreviousSessions` fleet sweep, so the canonical stream owner MUST carry
 * a recoverable-history list itself rather than only the live ActiveSession
 * cache rows.
 */
export const PREVIOUS_ROW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PREVIOUS_ROW_LIMIT = 50;

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
  const viewingIn = row.viewingIn
    ? [row.viewingIn.app, row.viewingIn.tab ? `tab ${row.viewingIn.tab}` : undefined].filter(Boolean).join(' ')
    : null;
  return {
    ...row,
    rowKey,
    sourceDevice: scope,
    resumable,
    unwatched: !viewingIn,
    viewingIn,
    recovery: resumable
      ? { command: 'agents', args: ['sessions', 'resume', row.sessionId!, '--device', scope], ...(row.cwd ? { cwd: row.cwd } : {}) }
      : null,
    previous: Boolean(row.previous),
  };
}

/**
 * Project one indexed {@link SessionMeta} into a durable "Previous" row — an
 * inactive, resumable ActiveSession shaped like the SessionPicker's rows.
 * It carries the enrichment a running process cannot report (`version`,
 * `account`, `firstUserMessage`) straight off the index, plus the exact
 * producing `harness`. Status is `closed` — the process is not running — which
 * (not being `abandoned`) keeps {@link isReapableOrphan} false so the row stays
 * resumable and {@link toSessionWatchRow} emits its `recovery` command.
 */
function previousRowFromMeta(scope: string, m: SessionMeta): ActiveSession {
  const startedAtMs = Date.parse(m.timestamp);
  const lastActivityMs = m.lastActivity ? Date.parse(m.lastActivity) : undefined;
  return {
    context: 'headless',
    kind: m.agent,
    harness: m.harness,
    sessionId: m.id,
    cwd: m.cwd,
    project: m.project ?? null,
    topic: m.topic,
    label: m.label,
    title: m.label || m.topic,
    firstUserMessage: m.firstUserMessage,
    version: m.version,
    account: m.account,
    machine: m.machine ?? scope,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : undefined,
    lastActivityMs: Number.isFinite(lastActivityMs as number)
      ? (lastActivityMs as number)
      : (Number.isFinite(startedAtMs) ? startedAtMs : undefined),
    tokenCount: m.tokenCount,
    durationMs: m.durationMs,
    subAgentCount: m.subAgentCount,
    origin: m.origin,
    routineName: m.routineName,
    ...(m.ticketId ? { ticket: { id: m.ticketId, url: linearIssueUrl(m.ticketId) } } : {}),
    ...(m.prUrl ? { pr: { url: m.prUrl, number: m.prNumber } } : {}),
    status: 'closed',
    phase: derivePhase('closed'),
    pidAlive: false,
    previous: true,
  };
}

/**
 * The bounded, durable recoverable-history set for one device scope: the last
 * {@link PREVIOUS_ROW_WINDOW_MS} of this box's own resumable sessions, capped at
 * {@link PREVIOUS_ROW_LIMIT}, read from the transcript index (PHNX-3621).
 *
 * Team-origin rows are excluded (they flood the operator's list); archived
 * (transcript-gone) and synthetic (no file, e.g. OpenClaw channel inventory)
 * rows are dropped because they are not resumable. Scoped to `machine = scope`
 * so a synced mirror of another box's session — readable here but resumable only
 * on its owner — never appears as locally recoverable. Best-effort: any index
 * error yields an empty set rather than breaking the live stream.
 */
export function buildPreviousRows(
  scope: string,
  opts: { windowMs?: number; limit?: number; nowMs?: number } = {},
): ActiveSession[] {
  const windowMs = opts.windowMs ?? PREVIOUS_ROW_WINDOW_MS;
  const limit = opts.limit ?? PREVIOUS_ROW_LIMIT;
  const now = opts.nowMs ?? Date.now();
  let metas: SessionMeta[];
  try {
    metas = querySessions({ machine: scope, sinceMs: now - windowMs, excludeTeamOrigin: true, limit });
  } catch {
    return [];
  }
  const rows: ActiveSession[] = [];
  for (const m of metas) {
    if (!m.id || !m.filePath || m.archived) continue;
    rows.push(previousRowFromMeta(scope, m));
  }
  return rows;
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

  reset(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope {
    const rows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    this.rows.set(scope, new Map(rows.map((row) => [row.rowKey, row])));
    return { ...this.base('reset'), scope, rows };
  }

  update(scope: string, sourceRows: ActiveSession[]): SessionWatchEnvelope[] {
    const previous = this.rows.get(scope) ?? new Map<string, SessionWatchRow>();
    const nextRows = sourceRows.map((row) => toSessionWatchRow(scope, row));
    const next = new Map(nextRows.map((row) => [row.rowKey, row]));
    const events: SessionWatchEnvelope[] = [];
    for (const [rowKey, row] of next) {
      if (!previous.has(rowKey) || !sameRow(previous.get(rowKey)!, row)) {
        events.push({ ...this.base('upsert'), scope, rowKey, row });
      }
    }
    for (const rowKey of previous.keys()) {
      if (!next.has(rowKey)) events.push({ ...this.base('remove'), scope, rowKey });
    }
    this.rows.set(scope, next);
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
  /**
   * The durable "Previous" set for this scope (PHNX-3621). Defaults to
   * {@link buildPreviousRows}; injected in tests to exercise the merge without a
   * real index. Re-read on every publication seam, so a newly-ended session that
   * the index has just picked up appears without a consumer poll.
   */
  readPrevious?: (scope: string) => ActiveSession[];
  journalPath?: string;
  journalPollMs?: number;
}

/**
 * Keep one local subscription alive. Startup reads one canonical reset snapshot
 * (the live ActiveSession cache) merged with the durable "Previous" set from the
 * transcript index; steady state tails the canonical writer journal and never
 * invokes a live gather.
 *
 * The reset and every subsequent upsert carry BOTH the live rows and the bounded
 * recoverable-history rows (PHNX-3621): a live row always wins by session id, and
 * the Previous set is re-derived on each journal record and heartbeat — the same
 * publication seam the live snapshot rides — so a session that just ended
 * transitions in place from its live row to its durable Previous row with no
 * consumer polling.
 */
export async function watchLocalSessions(options: WatchLocalOptions): Promise<void> {
  const state = new SessionWatchState();
  const readCache = options.readCache ?? readActiveSessionsCache;
  const readPrevious = options.readPrevious ?? buildPreviousRows;
  const journal = options.journalPath ?? activeSessionsJournalPath();
  const heartbeatMs = options.heartbeatMs ?? SESSION_WATCH_HEARTBEAT_MS;

  // The live set, keyed by journal identity, kept in sync from the cache reset
  // and the journal's incremental upserts/removes. The merged desired set is
  // live ∪ Previous, with a Previous row dropped whenever its session id is live.
  const liveByIdentity = new Map<string, ActiveSession>();
  const setLive = (rows: ActiveSession[]) => {
    liveByIdentity.clear();
    for (const row of rows) liveByIdentity.set(activeSessionJournalIdentity(row), row);
  };
  const mergeDesired = (): ActiveSession[] => {
    const liveIds = new Set<string>();
    for (const row of liveByIdentity.values()) if (row.sessionId) liveIds.add(row.sessionId);
    let previous: ActiveSession[] = [];
    try { previous = readPrevious(options.scope).filter((p) => !p.sessionId || !liveIds.has(p.sessionId)); }
    catch { previous = []; }
    return [...liveByIdentity.values(), ...previous];
  };

  let offset = 0;
  try { offset = fs.statSync(journal).size; } catch { /* first publication */ }
  const initial = readCache('local');
  setLive(initial?.sessions ?? []);
  options.emit(state.reset(options.scope, mergeDesired()));
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
              for (const source of record.upserts) liveByIdentity.set(activeSessionJournalIdentity(source), source);
              for (const identity of record.removes) liveByIdentity.delete(identity);
              // A full convergent diff over live ∪ Previous: a just-removed live
              // row reappears as its durable Previous row (same session id, same
              // rowKey) in one upsert, so the transition is seamless.
              for (const event of state.update(options.scope, mergeDesired())) options.emit(event);
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
      // Re-derive Previous on the heartbeat too, so an index update with no live
      // churn (a session aging out of the 7-day window, or one indexed after its
      // live row was already gone) still converges. state.update emits nothing
      // when the merged set is unchanged, so an idle heartbeat stays quiet.
      for (const event of state.update(options.scope, mergeDesired())) options.emit(event);
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
  const reconnectMs = options.reconnectMs ?? 2_000;
  const peerTasks = peers.map(async (device) => {
    const scope = normalizeHost(device.name);
    const state = new SessionWatchState();
    while (!options.signal.aborted) {
      let target: string;
      try { target = sshTargetFor(device); }
      catch (error) {
        options.emit(state.scope(scope, 'unavailable', error instanceof Error ? error.message : String(error)));
        break;
      }
      const child = spawn('ssh', [
        ...SSH_OPTS, ...controlOpts(), ...deviceIdentityArgs(device), target, remoteWatchCommand(device.platform),
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      const stop = () => child.kill('SIGTERM');
      options.signal.addEventListener('abort', stop, { once: true });
      const reader = createInterface({ input: child.stdout! });
      reader.on('line', (line) => {
        try {
          const event = JSON.parse(line) as SessionWatchEnvelope;
          if (event.version === SESSION_WATCH_VERSION && typeof event.sequence === 'number') options.emit(event);
        } catch { /* incomplete/non-protocol peer output is not state */ }
      });
      const code = await new Promise<number | null>((resolve) => {
        child.once('error', () => resolve(null));
        child.once('close', resolve);
      });
      reader.close();
      options.signal.removeEventListener('abort', stop);
      if (options.signal.aborted) break;
      options.emit(state.scope(scope, 'unavailable', code === null ? 'ssh failed' : `ssh exited ${code}`));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, reconnectMs);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  });
  await Promise.all([local, ...peerTasks]);
}
