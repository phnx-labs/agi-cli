import { machineId, normalizeHost } from '../machine-id.js';
import type { SessionWatchRow, SessionWatchScopeStatus } from '../session/watch.js';
import type { ToolSetupRow } from '../setup-tool-status.js';
import type { AttentionItem } from './attention.js';
import type { ActivityEvent } from './activity.js';
import type { ToolRow } from './tools.js';
import { FeedWatchState, type FeedWatchEnvelope } from './envelope.js';

export const HUB_ACTIVITY_REPLAY = 50;

interface ScopeState {
  agents: Map<string, SessionWatchRow>;
  attention: Map<string, AttentionItem>;
  tools: Map<string, ToolRow>;
  setup: ToolSetupRow[];
  capturedAt: number;
  status?: { status: SessionWatchScopeStatus; reason?: string };
}

function emptyScope(): ScopeState {
  return { agents: new Map(), attention: new Map(), tools: new Map(), setup: [], capturedAt: 0 };
}

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
        scope.status = { status: event.status, ...(event.reason ? { reason: event.reason } : {}) };
        break;
      case 'activity.append':
        this.activity.push(event.event);
        if (this.activity.length > HUB_ACTIVITY_REPLAY) this.activity.shift();
        break;
      case 'heartbeat': break;
    }
  }

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
    for (const event of this.activity) {
      out.push(state.emit({ type: 'activity.append', scope: normalizeHost(machineId()), event }));
    }
    return out;
  }

  get scopeNames(): string[] { return [...this.scopes.keys()]; }
}

type Subscriber = { emit: (event: FeedWatchEnvelope) => void; state: FeedWatchState };

export type HubFanOut = (options: {
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  reconnectMs?: number;
}) => Promise<void>;

export type HubFailureListener = (error: Error) => void;

interface FeedHubOptions {
  watch: HubFanOut;
  reconnectMs?: number;
}

export class FeedHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly held = new FeedHubState();
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private generation = 0;
  lastFailure: Error | null = null;
  onFailure: HubFailureListener | null = null;
  private readonly watch: HubFanOut;

  constructor(private readonly options: FeedHubOptions) {
    this.watch = options.watch;
  }

  get readerCount(): number { return this.subscribers.size; }
  get active(): boolean { return this.controller !== null; }
  get state(): FeedHubState { return this.held; }

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

  async close(): Promise<void> {
    this.subscribers.clear();
    this.stop();
    const running = this.running;
    this.running = null;
    if (running) await running.catch(() => {  });
  }

  async settled(): Promise<void> {
    await this.running?.catch(() => {  });
  }

  private start(): void {
    if (this.controller) return;

    const generation = ++this.generation;
    this.lastFailure = null;
    const controller = new AbortController();
    this.controller = controller;
    const previous = this.running ?? Promise.resolve();
    this.running = previous
      .catch(() => {  })
      .then(() => {
        if (generation !== this.generation || controller.signal.aborted) return;
        return this.watch({
          signal: controller.signal,
          ...(this.options.reconnectMs !== undefined ? { reconnectMs: this.options.reconnectMs } : {}),
          emit: (event) => { if (generation === this.generation) this.broadcast(event); },
        });
      })
      .catch((error: unknown) => {
        if (generation === this.generation) {
          this.lastFailure = error instanceof Error ? error : new Error(String(error));
          this.onFailure?.(this.lastFailure);
        }
      })
      .finally(() => {
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
