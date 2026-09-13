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
import type { ToolSetupRow } from '../setup-tool-status.js';
import type { AttentionItem } from './attention.js';
import type { ActivityEvent } from './activity.js';
import type { ToolRow } from './tools.js';
import { FeedWatchState, type FeedWatchEnvelope } from './envelope.js';

/** Activity events replayed to a late subscriber. The lane is a rolling view,
 *  so a bounded tail is the honest amount of history to hand over. */
export const HUB_ACTIVITY_REPLAY = 50;

interface ScopeState {
  agents: Map<string, SessionWatchRow>;
  attention: Map<string, AttentionItem>;
  tools: Map<string, ToolRow>;
  /** Whole-set, replaced at once — see the `setup.snapshot` docblock. */
  setup: ToolSetupRow[];
  capturedAt: number;
  status?: { status: SessionWatchScopeStatus; reason?: string };
}

function emptyScope(): ScopeState {
  return { agents: new Map(), attention: new Map(), tools: new Map(), setup: [], capturedAt: 0 };
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
        scope.setup = event.setup;
        scope.capturedAt = event.capturedAt;
        break;
      case 'agent.upsert': scope.agents.set(event.rowKey, event.agent); break;
      case 'agent.remove': scope.agents.delete(event.rowKey); break;
      case 'attention.upsert': scope.attention.set(event.rowKey, event.attention); break;
      case 'attention.remove': scope.attention.delete(event.rowKey); break;
      case 'tool.upsert': scope.tools.set(event.rowKey, event.tool); break;
      case 'tool.remove': scope.tools.delete(event.rowKey); break;
      case 'setup.snapshot': scope.setup = event.setup; break;
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
        agents: [...scope.agents.values()], attention: [...scope.attention.values()],
        tools: [...scope.tools.values()], setup: scope.setup,
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

/** The collector a hub owns: it runs until the signal aborts, emitting envelopes. */
export type HubFanOut = (options: {
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  reconnectMs?: number;
}) => Promise<void>;

/** Told to every attached reader when the shared fan-out cannot start. */
export type HubFailureListener = (error: Error) => void;

interface FeedHubOptions {
  /**
   * The collector to own — the fleet ssh fan-out, or the local watcher. Required
   * rather than defaulted so this module depends on neither, which is what keeps
   * `watch.ts` free to depend on THIS module for its shared local collector.
   */
  watch: HubFanOut;
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
  /**
   * Bumped on every start/stop. A fan-out's completion handler only clears state
   * when its own generation is still current, so a run winding down cannot clear
   * a newer one's controller.
   */
  private generation = 0;
  /** The most recent fan-out failure, if the current generation hit one. */
  lastFailure: Error | null = null;
  /**
   * Called when the fan-out rejects. Without this the failure lived only in a
   * dropped promise, so readers sat attached to a collector that had already died
   * and saw an idle stream instead of an error. Settable so the socket server can
   * attach after construction.
   */
  onFailure: HubFailureListener | null = null;
  private readonly watch: HubFanOut;

  constructor(private readonly options: FeedHubOptions) {
    this.watch = options.watch;
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
    if (running) await running.catch(() => { /* teardown must not throw */ });
  }

  /** Await the in-flight fan-out's teardown. Tests assert no overlap with it. */
  async settled(): Promise<void> {
    await this.running?.catch(() => { /* only the timing matters here */ });
  }

  /**
   * Start the single fan-out, waiting for any previous one to finish first.
   *
   * The wait is the whole point. `stop()` aborts and returns immediately, but the
   * fan-out it aborted is still tearing down ssh children. A reader that detaches
   * and immediately reattaches — a VS Code window reloading, a menu-bar popover
   * closing and reopening — therefore used to start a SECOND fan-out alongside
   * the dying one: two ssh children per peer, two collectors, for as long as the
   * overlap lasted. Serializing on the previous run makes that impossible.
   */
  private start(): void {
    if (this.controller) return;
    const generation = ++this.generation;
    this.lastFailure = null;
    const controller = new AbortController();
    this.controller = controller;
    const previous = this.running ?? Promise.resolve();
    this.running = previous
      .catch(() => { /* a previous run's failure must not block the next */ })
      .then(() => {
        // The readers may all have left while we waited for the old run to
        // drain; starting then would dial every peer for nobody.
        if (generation !== this.generation || controller.signal.aborted) return;
        return this.watch({
          signal: controller.signal,
          ...(this.options.reconnectMs !== undefined ? { reconnectMs: this.options.reconnectMs } : {}),
          // Generation-guarded: an aborted fan-out can still emit while it drains
          // (a peer's last buffered line, a pending promise resolving). Those
          // envelopes describe the OLD subscription and must not reach the new
          // generation's readers or mutate its held state.
          emit: (event) => { if (generation === this.generation) this.broadcast(event); },
        });
      })
      .catch((error: unknown) => {
        // Surfaced, never swallowed: a reader attached to a dead collector would
        // otherwise be indistinguishable from a quiet fleet.
        if (generation === this.generation) {
          this.lastFailure = error instanceof Error ? error : new Error(String(error));
          this.onFailure?.(this.lastFailure);
        }
      })
      .finally(() => {
        // Only clear if this is still the live run: a stop/start cycle may have
        // replaced it, and clearing then would strand the newer controller.
        if (generation === this.generation) this.controller = null;
      });
  }

  private stop(): void {
    this.generation += 1;
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
