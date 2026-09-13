import { describe, expect, it } from 'vitest';
import { FeedHub, FeedHubState } from './hub.js';
import { FeedWatchState, type FeedWatchEnvelope } from './envelope.js';
import type { SessionWatchRow } from '../session/watch.js';
import type { ToolSetupRow } from '../setup-tool-status.js';
import type { AttentionItem } from './attention.js';
import type { ToolRow } from './tools.js';

function agentRow(rowKey: string, scope: string): SessionWatchRow {
  return {
    rowKey, sourceDevice: scope, sessionId: `sess-${rowKey}`, kind: 'claude', status: 'running',
    context: 'terminal', previous: false, resumable: true, unwatched: true, viewingIn: null, recovery: null,
  } as unknown as SessionWatchRow;
}
function toolRow(rowKey: string, scope: string): ToolRow {
  return {
    kind: 'browser', rowKey, scope, device: scope, live: true, task: rowKey, profile: 'work',
    linkStatus: 'unlinked', startedAtMs: 1, updatedAtMs: 2, captures: [], captureCounts: {},
  };
}
function attentionItem(key: string): AttentionItem {
  return { key, sessionId: `sess-${key}` } as unknown as AttentionItem;
}
function setupRow(tool: ToolSetupRow['tool'], readiness: ToolSetupRow['readiness']): ToolSetupRow {
  return { tool, installed: true, readiness, detail: `${tool} is ${readiness}`, checkedAtMs: 10 };
}

async function settle(): Promise<void> {
  // The fan-out start is deliberately serialized behind any previous teardown, so
  // it lands after the promise chain drains rather than inside `subscribe()`.
  for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A hub over a controllable collector. The collector is a real async function
 * honouring the abort signal — what the tests assert on is how many times the hub
 * STARTED one, and whether a dying one can still reach the new generation.
 */
function controllable() {
  const starts: AbortSignal[] = [];
  const emitters: Array<(event: FeedWatchEnvelope) => void> = [];
  let failNext: Error | null = null;
  const hub = new FeedHub({
    watch: async (options) => {
      starts.push(options.signal);
      emitters.push(options.emit);
      if (failNext) { const error = failNext; failNext = null; throw error; }
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) { resolve(); return; }
        options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  return {
    hub, starts, emitters,
    publish: (event: FeedWatchEnvelope) => emitters[emitters.length - 1]!(event),
    failOnce: (error: Error) => { failNext = error; },
  };
}

describe('shared feed hub', () => {
  it('runs ONE fan-out for two readers and stops it when the last detaches', async () => {
    const { hub, starts, publish } = controllable();
    expect(hub.active).toBe(false);
    const first: FeedWatchEnvelope[] = [];
    const second: FeedWatchEnvelope[] = [];
    const detachFirst = hub.subscribe((event) => first.push(event));
    const detachSecond = hub.subscribe((event) => second.push(event));
    await settle();

    // The whole point: two readers, one collector, so one ssh child per peer.
    expect(starts).toHaveLength(1);
    expect(hub.readerCount).toBe(2);
    expect(hub.active).toBe(true);

    const upstream = new FeedWatchState();
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [toolRow('t1', 'zion')], setup: [] }));
    publish(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: 'a2', agent: agentRow('a2', 'zion') }));

    // Both readers see the same events, each on its OWN monotonic stream.
    expect(first.map((event) => event.type)).toEqual(['reset', 'agent.upsert']);
    expect(second.map((event) => event.type)).toEqual(['reset', 'agent.upsert']);
    expect(first.map((event) => event.sequence)).toEqual([1, 2]);
    expect(second.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first[0]!.streamId).not.toBe(second[0]!.streamId);

    detachFirst();
    expect(hub.active).toBe(true); // one reader left: the fan-out stays up
    detachSecond();
    expect(hub.active).toBe(false); // no readers: no peer connections at all
    expect(starts[0]!.aborted).toBe(true);
    await hub.close();
  });

  it('never overlaps two fan-outs across a rapid detach/reattach', async () => {
    // The bug: `stop()` aborts and returns, but the aborted fan-out is still
    // tearing down ssh children. Reattaching immediately started a SECOND one
    // alongside it — two children per peer for the length of the overlap.
    const starts: AbortSignal[] = [];
    let live = 0;
    let maxLive = 0;
    let releaseTeardown: (() => void) | undefined;
    const hub = new FeedHub({
      watch: async (options) => {
        starts.push(options.signal);
        live += 1;
        maxLive = Math.max(maxLive, live);
        await new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => {
            // A slow teardown, which is what makes the overlap observable.
            releaseTeardown = resolve;
          }, { once: true });
        });
        live -= 1;
      },
    });

    const detach = hub.subscribe(() => {});
    await settle();
    expect(starts).toHaveLength(1);
    expect(live).toBe(1);

    // Detach and immediately reattach while the first teardown is still pending.
    detach();
    const detachAgain = hub.subscribe(() => {});
    await settle();
    // The second fan-out must NOT have started yet — it is queued behind the
    // teardown that has not finished.
    expect(live).toBe(1);
    expect(maxLive).toBe(1);

    releaseTeardown!();
    await settle();
    expect(starts).toHaveLength(2);
    // Never two at once, which is the invariant.
    expect(maxLive).toBe(1);

    detachAgain();
    releaseTeardown?.();
    await hub.close();
  });

  it('drops emissions from a superseded fan-out', async () => {
    const { hub, emitters, starts } = controllable();
    const received: FeedWatchEnvelope[] = [];
    const detach = hub.subscribe(() => {});
    await settle();
    const stale = emitters[0]!;
    detach();

    // A new generation, with a different reader.
    const detachNew = hub.subscribe((event) => received.push(event));
    await settle();
    expect(starts).toHaveLength(2);

    // The OLD fan-out emits while draining. It describes a subscription that no
    // longer exists and must reach neither the new reader nor the held state.
    const upstream = new FeedWatchState();
    stale(upstream.emit({ type: 'reset', scope: 'ghost', capturedAt: 1, agents: [agentRow('old', 'ghost')], attention: [], tools: [], setup: [] }));
    expect(received).toEqual([]);
    expect(hub.state.scopeNames).not.toContain('ghost');

    detachNew();
    await hub.close();
  });

  it('reports a fan-out that cannot start instead of looking like a quiet fleet', async () => {
    const { hub, failOnce } = controllable();
    const failures: Error[] = [];
    hub.onFailure = (error) => failures.push(error);
    failOnce(new Error('device registry unreadable'));
    const detach = hub.subscribe(() => {});
    await settle();
    await hub.settled();
    expect(failures.map((error) => error.message)).toEqual(['device registry unreadable']);
    expect(hub.lastFailure?.message).toBe('device registry unreadable');
    detach();
    await hub.close();
  });

  it('serves a late reader from held state without a second fan-out', async () => {
    const { hub, starts, publish } = controllable();
    const detachFirst = hub.subscribe(() => {});
    await settle();
    const upstream = new FeedWatchState();
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [attentionItem('k1')], tools: [toolRow('t1', 'zion')], setup: [setupRow('browser', 'ready')] }));
    publish(upstream.emit({ type: 'reset', scope: 'mark-1', capturedAt: 11, agents: [agentRow('b1', 'mark-1')], attention: [], tools: [], setup: [] }));
    publish(upstream.emit({ type: 'scope', scope: 'mark-1', capturedAt: 12, status: 'unavailable', reason: 'ssh exited 255' }));
    publish(upstream.emit({ type: 'tool.remove', scope: 'zion', rowKey: 't1' }));

    const late: FeedWatchEnvelope[] = [];
    const detachLate = hub.subscribe((event) => late.push(event));
    await settle();
    expect(starts).toHaveLength(1); // no re-dial for the second reader

    const resets = late.filter((event) => event.type === 'reset');
    expect(resets.map((event) => event.scope).sort()).toEqual(['mark-1', 'zion']);
    const zion = resets.find((event) => event.scope === 'zion')!;
    expect(zion.type === 'reset' && zion.agents.map((row) => row.rowKey)).toEqual(['a1']);
    expect(zion.type === 'reset' && zion.attention.map((item) => item.key)).toEqual(['k1']);
    // The removed tool row is genuinely gone from the replay.
    expect(zion.type === 'reset' && zion.tools).toEqual([]);
    // Setup rows ride the replay too, so a Settings pane needs no extra request.
    expect(zion.type === 'reset' && zion.setup.map((row) => row.tool)).toEqual(['browser']);
    // An unavailable scope keeps its rows AND replays its status.
    const markReset = resets.find((event) => event.scope === 'mark-1')!;
    expect(markReset.type === 'reset' && markReset.agents.map((row) => row.rowKey)).toEqual(['b1']);
    expect(late.some((event) => event.type === 'scope' && event.scope === 'mark-1' && event.status === 'unavailable')).toBe(true);

    detachFirst(); detachLate();
    await hub.close();
  });

  it('keeps one scope\'s reset from erasing another\'s rows', () => {
    const held = new FeedHubState();
    const upstream = new FeedWatchState();
    held.apply(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 1, agents: [agentRow('a1', 'zion')], attention: [], tools: [toolRow('t1', 'zion')], setup: [setupRow('computer', 'stopped')] }));
    held.apply(upstream.emit({ type: 'reset', scope: 'mark-1', capturedAt: 2, agents: [agentRow('b1', 'mark-1')], attention: [], tools: [], setup: [] }));
    // mark-1 reconnects with nothing: zion must be untouched.
    held.apply(upstream.emit({ type: 'reset', scope: 'mark-1', capturedAt: 3, agents: [], attention: [], tools: [], setup: [] }));
    const snapshot = held.snapshot(new FeedWatchState()).filter((event) => event.type === 'reset');
    const zion = snapshot.find((event) => event.scope === 'zion')!;
    expect(zion.type === 'reset' && zion.agents).toHaveLength(1);
    expect(zion.type === 'reset' && zion.tools).toHaveLength(1);
    expect(zion.type === 'reset' && zion.setup.map((row) => row.tool)).toEqual(['computer']);
    const mark = snapshot.find((event) => event.scope === 'mark-1')!;
    expect(mark.type === 'reset' && mark.agents).toHaveLength(0);
  });

  it('replaces a scope\'s setup set wholesale on a snapshot', () => {
    const held = new FeedHubState();
    const upstream = new FeedWatchState();
    held.apply(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 1, agents: [], attention: [], tools: [], setup: [setupRow('browser', 'stopped')] }));
    held.apply(upstream.emit({ type: 'setup.snapshot', scope: 'zion', capturedAt: 2, setup: [setupRow('browser', 'ready'), setupRow('secrets', 'unknown')] }));
    const reset = held.snapshot(new FeedWatchState()).find((event) => event.type === 'reset')!;
    // The whole set is replaced: one coherent reading of the box, never a mix.
    expect(reset.type === 'reset' && reset.setup.map((row) => [row.tool, row.readiness]))
      .toEqual([['browser', 'ready'], ['secrets', 'unknown']]);
  });

  it('bounds the activity history a late reader is replayed', () => {
    const held = new FeedHubState();
    const upstream = new FeedWatchState();
    for (let i = 0; i < 120; i++) {
      held.apply(upstream.emit({ type: 'activity.append', scope: 'zion', event: { sessionId: 's', event: 'file.edited', ts: new Date(i * 1_000).toISOString(), detail: `e${i}` } as never }));
    }
    const replayed = held.snapshot(new FeedWatchState()).filter((event) => event.type === 'activity.append');
    expect(replayed).toHaveLength(50);
    // The tail, newest last — the order they were delivered in.
    expect(replayed[replayed.length - 1]!.type === 'activity.append' && (replayed[replayed.length - 1]! as { event: { detail: string } }).event.detail).toBe('e119');
  });
});
