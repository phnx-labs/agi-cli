import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDevices, isDialableDevice } from '../devices/registry.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { shellQuote } from '../ssh-exec.js';
import { buildWindowsAgentsCommand, remoteShellFor } from '../hosts/remote-cmd.js';
import { getFeedDir } from '../state.js';
import { streamFromPeer } from '../session/remote/peer-stream.js';
import { watchLocalSessions, type SessionWatchEnvelope, type SessionWatchRow, type SessionWatchScopeStatus, type WatchLocalOptions } from '../session/watch.js';
import { readBlock, readResolution, blockIdForSession } from './feed.js';
import { reconcileAttention, type AttentionItem } from './attention.js';
import { type ActivityEvent } from './activity.js';
import { ActivityStream } from './activity-stream.js';
import { PR_STATUS_TTL_MS, readPullRequestStatus, withPullRequestStatus, type PullRequestStatus } from './pr-status.js';
import type { GhExec } from '../github/pr-mergeable.js';

export const FEED_WATCH_VERSION = 1 as const;
type Base = { v: 1; type: string; streamId: string; sequence: number; scope: string };
export type FeedWatchEnvelope =
  | Base & { type: 'reset'; capturedAt: number; agents: SessionWatchRow[]; attention: AttentionItem[] }
  | Base & { type: 'agent.upsert'; rowKey: string; agent: SessionWatchRow }
  | Base & { type: 'agent.remove'; rowKey: string }
  | Base & { type: 'attention.upsert'; rowKey: string; attention: AttentionItem }
  | Base & { type: 'attention.remove'; rowKey: string }
  | Base & { type: 'activity.append'; event: ActivityEvent }
  | Base & { type: 'scope'; capturedAt: number; status: SessionWatchScopeStatus; reason?: string }
  | Base & { type: 'heartbeat'; capturedAt: number };
type FeedWatchPayload = FeedWatchEnvelope extends infer Envelope
  ? Envelope extends FeedWatchEnvelope ? Omit<Envelope, 'v' | 'streamId' | 'sequence'> : never
  : never;

export class FeedWatchState {
  readonly streamId: string;
  private sequence = 0;
  constructor(streamId = randomUUID()) { this.streamId = streamId; }
  emit(event: FeedWatchPayload): FeedWatchEnvelope {
    return { v: 1, streamId: this.streamId, sequence: ++this.sequence, ...event } as unknown as FeedWatchEnvelope;
  }
}

/**
 * Live rows only: durable Previous rows share the operator stream for Sessions
 * history, but they are not live work and must never synthesize Needs-you
 * attention or a PR lookup.
 */
function isLive(agent: SessionWatchRow): boolean {
  return Boolean(agent.sessionId) && !agent.previous && agent.context !== 'recent';
}

// ActiveSession.host names the terminal app; the feed contract's host is the
// device scope. Normalize only the reconciler input so lifecycle/PR keys are
// routable across the fleet while the projected agent row stays compatible.
function reconcilerSession(agent: SessionWatchRow): import('../session/active.js').ActiveSession {
  return { ...agent, context: agent.context as import('../session/active.js').ActiveSession['context'], host: agent.sourceDevice, viewingIn: undefined };
}

/** One `gh pr view` (cached 45 s) feeds both the attention verdict and the row's `pr` status. */
async function pullRequestFor(agent: SessionWatchRow, gh?: GhExec): Promise<PullRequestStatus | undefined> {
  if (!isLive(agent) || !agent.pr) return undefined;
  return readPullRequestStatus(reconcilerSession(agent), { gh });
}

function attentionFor(agent: SessionWatchRow, pullRequest: PullRequestStatus | undefined): AttentionItem | undefined {
  if (!isLive(agent) || !agent.sessionId) return undefined;
  const blockId = blockIdForSession(agent.sessionId);
  return reconcileAttention({
    block: readBlock(blockId), session: reconcilerSession(agent),
    resolution: readResolution(blockId),
    pullRequest, nowMs: Date.now(),
  });
}

/** The row as the feed projects it: the session row with its PR status attached. */
async function projectAgent(agent: SessionWatchRow, gh?: GhExec): Promise<{ agent: SessionWatchRow; attention: AttentionItem | undefined }> {
  const pullRequest = await pullRequestFor(agent, gh);
  return { agent: withPullRequestStatus(agent, pullRequest), attention: attentionFor(agent, pullRequest) };
}

export async function projectSessionEnvelope(event: SessionWatchEnvelope, state: FeedWatchState, gh?: GhExec): Promise<FeedWatchEnvelope[]> {
  if (event.type === 'reset') {
    const projected = await Promise.all(event.rows.map((row) => projectAgent(row, gh)));
    const attention = projected.map((p) => p.attention).filter((item): item is AttentionItem => item !== undefined);
    return [state.emit({ type: 'reset', capturedAt: event.capturedAt, scope: event.scope, agents: projected.map((p) => p.agent), attention })];
  }
  if (event.type === 'upsert') {
    const { agent, attention } = await projectAgent(event.row, gh);
    return [
      state.emit({ type: 'agent.upsert', scope: event.scope, rowKey: event.rowKey, agent }),
      attention
        ? state.emit({ type: 'attention.upsert', scope: event.scope, rowKey: event.rowKey, attention })
        : state.emit({ type: 'attention.remove', scope: event.scope, rowKey: event.rowKey }),
    ];
  }
  if (event.type === 'remove') return [
    state.emit({ type: 'agent.remove', scope: event.scope, rowKey: event.rowKey }),
    state.emit({ type: 'attention.remove', scope: event.scope, rowKey: event.rowKey }),
  ];
  if (event.type === 'scope') return [state.emit({ type: 'scope', capturedAt: event.capturedAt, scope: event.scope, status: event.status, ...(event.reason ? { reason: event.reason } : {}) })];
  return [state.emit({ type: 'heartbeat', capturedAt: event.capturedAt, scope: event.scope })];
}

/**
 * Watch the feed dirs that can change attention without a session event: an
 * `agents feed post --blocked` writes a block, `feed answer` writes a
 * resolution. Both are external processes, so nothing on the session stream
 * announces them — this is what lets the reconcile pass be event-driven instead
 * of a poll over every row twice a second.
 */
function watchAttentionStores(onChange: () => void): () => void {
  const feedDir = getFeedDir();
  const watchers: fs.FSWatcher[] = [];
  for (const dir of [feedDir, path.join(feedDir, 'resolutions')]) {
    try {
      const watcher = fs.watch(dir, () => onChange());
      // A directory that disappears must not take the watcher process down; the
      // PR-status cadence below still reconciles on its own timer.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* the dir appears with the first block; the timed pass covers it */ }
  }
  return () => { for (const watcher of watchers) watcher.close(); };
}

export interface WatchLocalFeedOptions {
  scope: string;
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  /** Activity drain cadence. */
  activityPollMs?: number;
  /** Attention reconcile cadence when nothing has announced a change. */
  reconcileMs?: number;
  /** Session-watch inputs, forwarded verbatim to {@link watchLocalSessions}. */
  sessions?: Pick<WatchLocalOptions, 'readCache' | 'readPrevious' | 'journalPath' | 'journalPollMs' | 'heartbeatMs'>;
  /** The `gh` runner behind PR status; a test passes a recorded table. */
  gh?: GhExec;
}

export async function watchLocalFeed(options: WatchLocalFeedOptions): Promise<void> {
  const state = new FeedWatchState();
  // The stream's opening scan registers every log past its own bytes, so the
  // cursor has to be taken *after* it: a record appended while the scan was
  // walking the directory is unreadable from the byte cursor, and only a
  // timestamp taken after the scan classifies it as history rather than
  // dropping it from a window the caller believes was covered.
  const activity = new ActivityStream();
  let activityCursor = Date.now();
  const agents = new Map<string, SessionWatchRow>();
  const attention = new Map<string, string>();
  // The PR status last projected onto each row, so a merge or a check verdict
  // that lands between session events still reaches the row's consumers.
  const prStatus = new Map<string, string>();
  let pending = Promise.resolve();
  const reconcileRows = async () => {
    for (const [rowKey, raw] of agents) {
      const { agent, attention: item } = await projectAgent(raw, options.gh);
      const nextPr = agent.pr ? JSON.stringify(agent.pr) : '';
      if (agent.pr && prStatus.get(rowKey) !== nextPr) {
        prStatus.set(rowKey, nextPr);
        options.emit(state.emit({ type: 'agent.upsert', scope: options.scope, rowKey, agent }));
      }
      const next = item ? JSON.stringify(item) : '';
      if (attention.get(rowKey) === next) continue;
      attention.set(rowKey, next);
      options.emit(item
        ? state.emit({ type: 'attention.upsert', scope: options.scope, rowKey, attention: item })
        : state.emit({ type: 'attention.remove', scope: options.scope, rowKey }));
    }
  };
  // Attention is reconciled when something can actually have changed it — a row
  // moved, a block/resolution file was written — or when the PR-status TTL has
  // expired and the cached verdicts are stale. Re-running it every 500 ms cost
  // two file reads per row per tick and changed nothing.
  const reconcileMs = options.reconcileMs ?? PR_STATUS_TTL_MS;
  let attentionDirty = true;
  let lastReconcileMs = 0;
  const markAttentionDirty = () => { attentionDirty = true; };
  const stopAttentionWatch = watchAttentionStores(markAttentionDirty);
  const activityTimer = setInterval(() => {
    pending = pending.then(async () => {
      const nowMs = Date.now();
      const events = activity.read(activityCursor + 1, nowMs).reverse();
      for (const event of events) {
        activityCursor = Math.max(activityCursor, Date.parse(event.ts));
        options.emit(state.emit({ type: 'activity.append', scope: options.scope, event }));
      }
      if (!attentionDirty && nowMs - lastReconcileMs < reconcileMs) return;
      attentionDirty = false;
      lastReconcileMs = nowMs;
      await reconcileRows();
    });
  }, options.activityPollMs ?? 500);
  const stopActivity = () => { clearInterval(activityTimer); stopAttentionWatch(); activity.close(); };
  options.signal.addEventListener('abort', stopActivity, { once: true });
  try {
    await watchLocalSessions({ ...options.sessions, scope: options.scope, signal: options.signal, emit: (event) => {
      if (event.type === 'reset') {
        agents.clear();
        for (const row of event.rows) agents.set(row.rowKey, row);
      } else if (event.type === 'upsert') agents.set(event.rowKey, event.row);
      else if (event.type === 'remove') { agents.delete(event.rowKey); attention.delete(event.rowKey); prStatus.delete(event.rowKey); }
      pending = pending.then(() => projectSessionEnvelope(event, state, options.gh)).then((events) => {
        for (const projected of events) {
          if (projected.type === 'reset') {
            attention.clear();
            prStatus.clear();
            for (const row of projected.agents) { attention.set(row.rowKey, ''); if (row.pr) prStatus.set(row.rowKey, JSON.stringify(row.pr)); }
            for (const item of projected.attention) {
              const row = projected.agents.find((agent) => agent.sessionId === item.sessionId);
              if (row) attention.set(row.rowKey, JSON.stringify(item));
            }
          } else if (projected.type === 'agent.upsert') {
            if (projected.agent.pr) prStatus.set(projected.rowKey, JSON.stringify(projected.agent.pr));
          } else if (projected.type === 'attention.upsert') attention.set(projected.rowKey, JSON.stringify(projected.attention));
          else if (projected.type === 'attention.remove') attention.set(projected.rowKey, '');
          options.emit(projected);
        }
      });
    } });
    await pending;
  } finally { stopActivity(); }
}

function remoteFeedWatchCommand(os: string): string {
  const args = ['feed', 'watch', '--json', '--local'];
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsAgentsCommand({ args })
    : `bash -lc ${shellQuote(`agents ${args.map(shellQuote).join(' ')}`)}`;
}

export async function watchFleetFeed(options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void; reconnectMs?: number }): Promise<void> {
  const coordinator = new FeedWatchState();
  const forward = (event: FeedWatchEnvelope) => {
    const { v: _v, streamId: peerStreamId, sequence: peerSequence, ...payload } = event;
    options.emit(coordinator.emit({ ...payload, peerStreamId, peerSequence } as unknown as FeedWatchPayload));
  };
  const local = watchLocalFeed({ scope: machineId(), signal: options.signal, emit: forward });
  let devices: Awaited<ReturnType<typeof loadDevices>>;
  try { devices = await loadDevices(); } catch { await local; return; }
  const self = machineId();
  const peers = Object.values(devices).filter((device) => isDialableDevice(device) && normalizeHost(device.name) !== self && ['windows', 'linux', 'macos'].includes(device.platform));
  const tasks = peers.map((device) => {
    const scope = normalizeHost(device.name);
    return streamFromPeer({
      device,
      signal: options.signal,
      command: remoteFeedWatchCommand(device.platform),
      backoffBaseMs: options.reconnectMs,
      onLine: (line) => {
        try {
          const event = JSON.parse(line) as FeedWatchEnvelope;
          if (event.v !== 1) return false;
          forward(event);
          return true;
        } catch { return false; /* protocol only */ }
      },
      onUnavailable: (reason) => options.emit(coordinator.emit({ type: 'scope', capturedAt: Date.now(), scope, status: 'unavailable', reason })),
    });
  });
  await Promise.all([local, ...tasks]);
}
