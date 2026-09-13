/**
 * One fleet fan-out, many readers.
 *
 * THE COST THIS EXISTS TO AVOID. `watchFleetFeed` opens a persistent
 * `ssh <peer> agents feed watch --json --local` per dialable device — that is
 * correct, and it is also per CALLER. Every consumer that wanted the operator
 * stream ran its own copy: the extension's leader child, a menu-bar helper, an
 * operator's `agents feed watch --json`. Three readers on a thirteen-device
 * fleet is thirty-nine long-lived ssh children carrying byte-identical NDJSON,
 * three copies of the local activity cursor, and three independent backoff
 * ladders that each re-dial the same offline box.
 *
 * WHAT REPLACES IT. The hub owns exactly ONE {@link watchFleetFeed} — so one ssh
 * child per reachable peer, one collector, one backoff ladder — and broadcasts
 * to every subscriber. The fan-out starts on the FIRST subscriber and stops on
 * the LAST, so an idle box with no reader open holds no peer connections at all.
 *
 * A LATE SUBSCRIBER COSTS NOTHING. The hub keeps the per-scope row state the
 * stream has delivered so far, so subscriber two is served a synthesized reset
 * per scope out of that state — no second fan-out, no re-dial, no waiting for
 * the peers to re-announce. Its `streamId`/`sequence` are its own and start at
 * 1, which is exactly what the published contract ("order by streamId +
 * sequence") lets a consumer rely on.
 *
 * RESET SEMANTICS ARE PRESERVED, NOT REINVENTED. A peer's reset replaces that
 * ONE scope's rows in the held state and is forwarded verbatim; a peer going
 * unavailable forwards the `scope` event and leaves its rows in place, so a
 * reader that attaches while a box is offline still sees that box's last-known
 * rows marked unavailable rather than an empty fleet.
 */
import { machineId, normalizeHost } from '../machine-id.js';
import type { SessionWatchRow, SessionWatchScopeStatus } from '../session/watch.js';
import type { AttentionItem } from './attention.js';
import type { ActivityEvent } from './activity.js';
import type { ToolRow } from './tools.js';
import { FeedWatchState, watchFleetFeed, type FeedWatchEnvelope } from './watch.js';

/** Activity events replayed to a late subscriber. The lane is a rolling view,
 *  so a bounded tail is the honest amount of history to hand over. */
export const HUB_ACTIVITY_REPLAY = 50;

interface ScopeState {
  agents: Map<string, SessionWatchRow>;
  attention: Map<string, AttentionItem>;
  tools: Map<string, ToolRow>;
  capturedAt: number;
  status?: { status: SessionWatchScopeStatus; reason?: string };
}

function emptyScope(): ScopeState {
  return { agents: new Map(), attention: new Map(), tools: new Map(), capturedAt: 0 };
}

/**
 * The per-scope row state the hub has observed. This is a projection of the
 * events already delivered, never an independent gather: nothing here reads a
 * file, runs a command, or dials a peer.
 */
export class FeedHubState {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly activity: ActivityEvent[] = [];

  private scope(name: string): ScopeState {
    const key = normalizeHost(name);
    let scope = this.scopes.get(key);
    if (!scope) { scope = emptyScope(); this.scopes.set(key, scope); }
    return scope;
  }

  apply(event: FeedWatchEnvelope): void {
    const scope = this.scope(event.scope);
    switch (event.type) {
      case 'reset':
        // One scope only. A peer reconnecting must not erase another's rows.
        scope.agents = new Map(event.agents.map((agent) => [agent.rowKey, agent]));
        scope.attention = new Map(event.attention.map((item) => [item.key, item]));
        scope.tools = new Map(event.tools.map((tool) => [tool.rowKey, tool]));
        scope.capturedAt = event.capturedAt;
        break;
      case 'agent.upsert': scope.agents.set(event.rowKey, event.agent); break;
      case 'agent.remove': scope.agents.delete(event.rowKey); break;
      case 'attention.upsert': scope.attention.set(event.rowKey, event.attention); break;
      case 'attention.remove': scope.attention.delete(event.rowKey); break;
      case 'tool.upsert': scope.tools.set(event.rowKey, event.tool); break;
      case 'tool.remove': scope.tools.delete(event.rowKey); break;
      case 'scope':
        // Rows are deliberately RETAINED: transient fleet loss is not session
        // death, the same rule `watchLocalSessions` states for its own scope.
        scope.status = { status: event.status, ...(event.reason ? { reason: event.reason } : {}) };
        break;
      case 'activity.append':
        this.activity.push(event.event);
        if (this.activity.length > HUB_ACTIVITY_REPLAY) this.activity.shift();
        break;
      case 'heartbeat': break;
    }
  }

  /** The envelopes that bring a fresh subscriber to the current state. */
  snapshot(state: FeedWatchState): FeedWatchEnvelope[] {
    const out: FeedWatchEnvelope[] = [];
    for (const [name, scope] of this.scopes) {
      out.push(state.emit({
        type: 'reset', scope: name, capturedAt: scope.capturedAt || Date.now(),
        agents: [...scope.agents.values()], attention: [...scope.attention.values()], tools: [...scope.tools.values()],
      }));
      if (scope.status) out.push(state.emit({ type: 'scope', scope: name, capturedAt: Date.now(), ...scope.status }));
    }
    // Chronological, matching the order they were first delivered in.
    for (const event of this.activity) {
      out.push(state.emit({ type: 'activity.append', scope: normalizeHost(machineId()), event }));
    }
    return out;
  }

  /** Scopes the hub has seen. Observability + tests. */
  get scopeNames(): string[] { return [...this.scopes.keys()]; }
}

type Subscriber = { emit: (event: FeedWatchEnvelope) => void; state: FeedWatchState };

interface FeedHubOptions {
  /** The fleet fan-out to own. Injectable so a test drives a recorded stream. */
  watch?: typeof watchFleetFeed;
  /** Forwarded to the fan-out. */
  reconnectMs?: number;
}

/**
 * The shared collector. Construct one per process; call {@link subscribe} per
 * reader.
 */
export class FeedHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly held = new FeedHubState();
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private readonly watch: typeof watchFleetFeed;

  constructor(private readonly options: FeedHubOptions = {}) {
    this.watch = options.watch ?? watchFleetFeed;
  }

  /** Readers currently attached. The fan-out runs iff this is > 0. */
  get readerCount(): number { return this.subscribers.size; }
  /** Is the single shared fan-out running right now? */
  get active(): boolean { return this.controller !== null; }
  /** The held per-scope state, for observability and tests. */
  get state(): FeedHubState { return this.held; }

  /**
   * Attach a reader. It is immediately served a snapshot of the held state, then
   * every later event. Returns the detach function; the fan-out stops when the
   * last reader detaches.
   */
  subscribe(emit: (event: FeedWatchEnvelope) => void): () => void {
    const subscriber: Subscriber = { emit, state: new FeedWatchState() };
    this.subscribers.add(subscriber);
    for (const event of this.held.snapshot(subscriber.state)) emit(event);
    this.start();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Stop the fan-out and detach every reader. */
  async close(): Promise<void> {
    this.subscribers.clear();
    this.stop();
    const running = this.running;
    this.running = null;
    if (running) await running;
  }

  private start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.watch({
      signal: controller.signal,
      ...(this.options.reconnectMs !== undefined ? { reconnectMs: this.options.reconnectMs } : {}),
      emit: (event) => this.broadcast(event),
    }).finally(() => {
      // Only clear if this is still the live run: a stop/start cycle may have
      // replaced it, and clearing then would strand the newer controller.
      if (this.controller === controller) this.controller = null;
    });
  }

  private stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private broadcast(event: FeedWatchEnvelope): void {
    this.held.apply(event);
    const { v: _v, streamId: _streamId, sequence: _sequence, ...payload } = event;
    for (const subscriber of this.subscribers) {
      subscriber.emit(subscriber.state.emit(payload as Parameters<FeedWatchState['emit']>[0]));
    }
  }
}
