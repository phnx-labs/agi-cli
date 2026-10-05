import { SessionProjection } from '../session/projection.js';
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
import { collectToolRows, watchToolActivity, type ToolDiff } from './tool-activity.js';
import { type ToolRow } from './tools.js';
import { FeedWatchState, type FeedWatchEnvelope } from './envelope.js';
import { FeedHub } from './hub.js';
import { getCachedToolSetup, subscribeToolSetup, type ToolSetupRow } from '../setup-tool-status.js';
import { PR_STATUS_TTL_MS, readPullRequestStatus, withPullRequestStatus, type PullRequestStatus } from './pr-status.js';
import type { GhExec } from '../github/pr-mergeable.js';
export { FeedWatchState, type FeedWatchEnvelope, type FeedWatchPayload } from './envelope.js';

/** Reuse session ownership reconciliation for the combined operator stream. */
export class FeedSessionProjection {
  private readonly sessions = new SessionProjection();
  private readonly observations = new Map<string, Map<string, AttentionItem>>();
  private projectedAttention = new Map<string, { scope: string; item: AttentionItem }>();
  /** Tool rows per observing scope. A reset replaces one scope's rows without touching
   * another's, so a reconnecting peer cannot erase the local machine's tasks. */
  private readonly toolsByScope = new Map<string, Map<string, ToolRow>>();
  /** Whole-set per scope; see the `setup.snapshot` docblock in `envelope.ts`. */
  private readonly setupByScope = new Map<string, ToolSetupRow[]>();
  constructor(private readonly state = new FeedWatchState()) {}

  apply(event: FeedWatchEnvelope): FeedWatchEnvelope[] {
    const scope = normalizeHost(event.scope);
    const base = { version: 1 as const, streamId: event.streamId, sequence: event.sequence, capturedAt: 'capturedAt' in event ? event.capturedAt : Date.now(), scope };
    let sessionEvent: SessionWatchEnvelope | undefined;
    if (event.type === 'reset') {
      sessionEvent = { ...base, type: 'reset', rows: event.agents };
      const attention = new Map<string, AttentionItem>();
      for (const row of event.agents) {
        const item = event.attention.find(item => item.sessionId === row.sessionId);
        if (item && !row.previous) attention.set(row.rowKey, item);
      }
      this.observations.set(scope, attention);
      this.toolsByScope.set(scope, new Map(event.tools.map((tool) => [tool.rowKey, tool])));
      this.setupByScope.set(scope, event.setup);
    } else if (event.type === 'agent.upsert') {
      sessionEvent = { ...base, type: 'upsert', rowKey: event.rowKey, row: event.agent };
    } else if (event.type === 'agent.remove') {
      sessionEvent = { ...base, type: 'remove', rowKey: event.rowKey };
      this.observations.get(scope)?.delete(event.rowKey);
    } else if (event.type === 'attention.upsert') {
      if (!this.observations.has(scope)) this.observations.set(scope, new Map());
      this.observations.get(scope)!.set(event.rowKey, event.attention);
    } else if (event.type === 'attention.remove') {
      this.observations.get(scope)?.delete(event.rowKey);
    } else if (event.type === 'tool.upsert') {
      if (!this.toolsByScope.has(scope)) this.toolsByScope.set(scope, new Map());
      this.toolsByScope.get(scope)!.set(event.rowKey, event.tool);
      return [this.state.emit({ type: 'tool.upsert', scope, rowKey: event.rowKey, tool: event.tool })];
    } else if (event.type === 'tool.remove') {
      this.toolsByScope.get(scope)?.delete(event.rowKey);
      return [this.state.emit({ type: 'tool.remove', scope, rowKey: event.rowKey })];
    } else if (event.type === 'setup.snapshot') {
      this.setupByScope.set(scope, event.setup);
      return [this.state.emit({ type: 'setup.snapshot', scope, capturedAt: event.capturedAt, setup: event.setup })];
    } else {
      const { v: _v, streamId: _streamId, sequence: _sequence, ...payload } = event;
      return [this.state.emit(payload)];
    }
    const projected = sessionEvent ? this.sessions.apply(sessionEvent) : [];
    const next = new Map<string, { scope: string; item: AttentionItem }>();
    for (const [observer, items] of this.observations) for (const [rowKey, item] of items) {
      const row = this.sessions.rowForObservation(observer, rowKey);
      if (row && !row.previous && row.sourceDevice === observer) next.set(item.key, { scope: observer, item });
    }
    const result: FeedWatchEnvelope[] = [];
    const resetScopes = new Set<string>();
    for (const rowEvent of projected) {
      if (rowEvent.type === 'reset') {
        resetScopes.add(rowEvent.scope);
        result.push(this.state.emit({ type: 'reset', scope: rowEvent.scope, capturedAt: rowEvent.capturedAt, agents: rowEvent.rows,
          attention: [...next.values()].filter(value => value.scope === rowEvent.scope).map(value => value.item),
          tools: [...(this.toolsByScope.get(rowEvent.scope)?.values() ?? [])],
          setup: this.setupByScope.get(rowEvent.scope) ?? [] }));
      } else if (rowEvent.type === 'upsert') {
        result.push(this.state.emit({ type: 'agent.upsert', scope: rowEvent.scope, rowKey: rowEvent.rowKey, agent: rowEvent.row }));
      } else if (rowEvent.type === 'remove') {
        result.push(this.state.emit({ type: 'agent.remove', scope: rowEvent.scope, rowKey: rowEvent.rowKey }));
      }
    }
    // Attention has its own stable generation key, also used by feed answer.
    // Never substitute the projected agent row key: reset consumers key by item.key.
    for (const [key, previous] of this.projectedAttention) {
      if (!next.has(key) && !resetScopes.has(previous.scope)) result.push(this.state.emit({ type: 'attention.remove', scope: previous.scope, rowKey: key }));
    }
    for (const [key, value] of next) {
      if (!resetScopes.has(value.scope) && JSON.stringify(this.projectedAttention.get(key)) !== JSON.stringify(value)) {
        result.push(this.state.emit({ type: 'attention.upsert', scope: value.scope, rowKey: key, attention: value.item }));
      }
    }
    this.projectedAttention = next;
    return result;
  }
}

/** Live rows only: durable Previous rows share the stream for Sessions history but are not live
 * work and must never synthesize Needs-you or a PR lookup. */
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

export async function projectSessionEnvelope(event: SessionWatchEnvelope, state: FeedWatchState, gh?: GhExec, tools: ToolRow[] = [], setup: ToolSetupRow[] = []): Promise<FeedWatchEnvelope[]> {
  if (event.type === 'reset') {
    const projected = await Promise.all(event.rows.map((row) => projectAgent(row, gh)));
    const attention = projected.map((p) => p.attention).filter((item): item is AttentionItem => item !== undefined);
    return [state.emit({ type: 'reset', capturedAt: event.capturedAt, scope: event.scope, agents: projected.map((p) => p.agent), attention, tools, setup })];
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

/** Watches the feed dirs that change attention without a session event: `feed post --blocked`
 * writes a block and `feed answer` a resolution, both from external processes. This keeps
 * reconcile event-driven instead of polling every row twice a second. */
function watchAttentionStores(onChange: () => void): () => void {
  const feedDir = getFeedDir();
  const watchers: fs.FSWatcher[] = [];
  for (const dir of [feedDir, path.join(feedDir, 'resolutions')]) {
    try {
      // `resolutions` is created lazily, so a fresh feed dir has none to watch. Create it up front,
      // or fs.watch throws ENOENT, is swallowed and never retried, silently downgrading resolutions
      // to the 45 s PR-status fallback.
      fs.mkdirSync(dir, { recursive: true });
      const watcher = fs.watch(dir, () => onChange());
      // A directory that disappears must not take the watcher process down; the
      // PR-status cadence below still reconciles on its own timer.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* best-effort: the timed pass still reconciles on its own cadence */ }
  }
  return () => { for (const watcher of watchers) watcher.close(); };
}

interface WatchLocalFeedOptions {
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
  /** Tool-activity inputs, forwarded verbatim to {@link watchToolActivity}. */
  tools?: Pick<Parameters<typeof watchToolActivity>[0], 'sweepMs' | 'roots' | 'sources'>;
  /** Tool-setup readers. The setup teammate owns detection (`lib/setup-tool-status.ts`); this
   * stream publishes only what its cache holds and never probes. */
  setup?: {
    read?: typeof getCachedToolSetup;
    subscribe?: typeof subscribeToolSetup;
  };
}

export async function watchLocalFeed(options: WatchLocalFeedOptions): Promise<void> {
  const state = new FeedWatchState();
  // The opening scan registers every log past its own bytes, so the cursor must be taken after it:
  // a record appended during the scan is unreadable from the byte cursor, and only a post-scan
  // timestamp classifies it as history instead of dropping it.
  const activity = new ActivityStream();
  let activityCursor = Date.now();
  // The tool rows as last projected, held here rather than re-collected per reset: a session-watch
  // reconnect would otherwise re-read the browser tree and ledger, reintroducing the per-render
  // cost `tool-activity.ts` removes.
  let toolRows: ToolRow[] = collectToolRows(options.scope, options.tools?.sources).rows;
  // Setup rows come from the setup teammate's cache, never from a probe here:
  // `getCachedToolSetup` reads metadata plus the last EXPLICIT health check, so
  // publishing it costs no subprocess and cannot unlock a secret store.
  const readSetup = options.setup?.read ?? getCachedToolSetup;
  let setupRows: ToolSetupRow[] = (() => {
    try { return readSetup(); } catch { return []; }
  })();
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
  // Attention is reconciled when something can have changed it (a row moved, a block/resolution
  // written) or the PR-status TTL expired. Running it every 500 ms cost two file reads per row per
  // tick and changed nothing.
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
  const toolWatch = watchToolActivity({
    ...options.tools, scope: options.scope, signal: options.signal, initial: toolRows,
    onDiff: (diff: ToolDiff) => {
      for (const tool of diff.upserts) {
        toolRows = [...toolRows.filter((row) => row.rowKey !== tool.rowKey), tool];
        options.emit(state.emit({ type: 'tool.upsert', scope: options.scope, rowKey: tool.rowKey, tool }));
      }
      for (const rowKey of diff.removes) {
        toolRows = toolRows.filter((row) => row.rowKey !== rowKey);
        options.emit(state.emit({ type: 'tool.remove', scope: options.scope, rowKey }));
      }
    },
  });
  // The setup cache is file-backed and notifies on change, so a Settings pane
  // costs no polling: `subscribeToolSetup` is the invalidation the setup side
  // publishes for exactly this consumer.
  const stopSetupWatch = (options.setup?.subscribe ?? subscribeToolSetup)((rows) => {
    const next = JSON.stringify(rows);
    if (next === JSON.stringify(setupRows)) return;
    setupRows = rows;
    options.emit(state.emit({ type: 'setup.snapshot', scope: options.scope, capturedAt: Date.now(), setup: rows }));
  });
  const stopActivity = () => { clearInterval(activityTimer); stopAttentionWatch(); activity.close(); toolWatch.stop(); stopSetupWatch(); };
  options.signal.addEventListener('abort', stopActivity, { once: true });
  try {
    await watchLocalSessions({ ...options.sessions, scope: options.scope, signal: options.signal, emit: (event) => {
      if (event.type === 'reset') {
        agents.clear();
        for (const row of event.rows) agents.set(row.rowKey, row);
      } else if (event.type === 'upsert') agents.set(event.rowKey, event.row);
      else if (event.type === 'remove') { agents.delete(event.rowKey); attention.delete(event.rowKey); prStatus.delete(event.rowKey); }
      pending = pending.then(() => projectSessionEnvelope(event, state, options.gh, toolRows, setupRows)).then((events) => {
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

/** The one ingress for an envelope from another agents-cli. `tools` was added to `reset` within
 * protocol v1, so an older peer is a correct producer with no tool rows. Normalized here so
 * downstream treats it as present and a mixed-version fleet does not break the fan-out. */
export function normalizePeerEnvelope(event: FeedWatchEnvelope): FeedWatchEnvelope {
  if (event.type !== 'reset') return event;
  if (Array.isArray(event.tools) && Array.isArray(event.setup)) return event;
  return { ...event, tools: event.tools ?? [], setup: event.setup ?? [] };
}

/** The process-wide local collector, shared by refcount: each `watchLocalFeed` builds its own
 * cursors and watchers, and a daemon box has two callers. Process-wide, not machine-wide, so the
 * `--local` command peers run over ssh never depends on a healthy daemon. */
let sharedLocal: FeedHub | null = null;

/** The shared local collector, constructed on first use. Exposed for tests. */
export function sharedLocalFeedHub(): FeedHub {
  return sharedLocal ??= new FeedHub({
    watch: (hubOptions) => watchLocalFeed({
      scope: machineId(), signal: hubOptions.signal, emit: hubOptions.emit,
    }),
  });
}

/** Reset the shared collector. Tests only — it must not leak across cases. */
export async function resetSharedLocalFeedHub(): Promise<void> {
  const hub = sharedLocal;
  sharedLocal = null;
  await hub?.close();
}

/**
 * Subscribe to this machine's rows through the shared collector, until abort.
 */
export function subscribeSharedLocalFeed(options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void }): Promise<void> {
  const detach = sharedLocalFeedHub().subscribe(options.emit);
  return new Promise<void>((resolve) => {
    if (options.signal.aborted) { detach(); resolve(); return; }
    options.signal.addEventListener('abort', () => { detach(); resolve(); }, { once: true });
  });
}

export async function watchFleetFeed(options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void; reconnectMs?: number }): Promise<void> {
  const coordinator = new FeedWatchState();
  const projection = new FeedSessionProjection(coordinator);
  const forward = (event: FeedWatchEnvelope) => {
    for (const projected of projection.apply(event)) options.emit(projected);
  };
  const local = subscribeSharedLocalFeed({ signal: options.signal, emit: forward });
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
          forward(normalizePeerEnvelope(event));
          return true;
        } catch { return false; /* protocol only */ }
      },
      onUnavailable: (reason) => options.emit(coordinator.emit({ type: 'scope', capturedAt: Date.now(), scope, status: 'unavailable', reason })),
    });
  });
  await Promise.all([local, ...tasks]);
}
