import { describe, expect, it } from 'vitest';
import { FeedHub, FeedHubState } from './hub.js';
import { FeedWatchState, type FeedWatchEnvelope } from './watch.js';
import type { SessionWatchRow } from '../session/watch.js';
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

describe('shared feed hub', () => {
  it('runs ONE fan-out for two readers and stops it when the last detaches', async () => {
    const starts: AbortSignal[] = [];
    let publish: ((event: FeedWatchEnvelope) => void) | undefined;
    const hub = new FeedHub({
      watch: (async (options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void }) => {
        starts.push(options.signal);
        publish = options.emit;
        await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      }) as unknown as typeof import('./watch.js').watchFleetFeed,
    });

    expect(hub.active).toBe(false);
    const first: FeedWatchEnvelope[] = [];
    const second: FeedWatchEnvelope[] = [];
    const detachFirst = hub.subscribe((event) => first.push(event));
    const detachSecond = hub.subscribe((event) => second.push(event));

    // The whole point: two readers, one collector, so one ssh child per peer.
    expect(starts).toHaveLength(1);
    expect(hub.readerCount).toBe(2);
    expect(hub.active).toBe(true);

    const upstream = new FeedWatchState();
    publish!(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [toolRow('t1', 'zion')] }));
    publish!(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: 'a2', agent: agentRow('a2', 'zion') }));

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

  it('serves a late reader from held state without a second fan-out', async () => {
    const starts: AbortSignal[] = [];
    let publish: ((event: FeedWatchEnvelope) => void) | undefined;
    const hub = new FeedHub({
      watch: (async (options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void }) => {
        starts.push(options.signal);
        publish = options.emit;
        await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      }) as unknown as typeof import('./watch.js').watchFleetFeed,
    });
    const detachFirst = hub.subscribe(() => {});
    const upstream = new FeedWatchState();
    publish!(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [attentionItem('k1')], tools: [toolRow('t1', 'zion')] }));
    publish!(upstream.emit({ type: 'reset', scope: 'mark-1', capturedAt: 11, agents: [agentRow('b1', 'mark-1')], attention: [], tools: [] }));
    publish!(upstream.emit({ type: 'scope', scope: 'mark-1', capturedAt: 12, status: 'unavailable', reason: 'ssh exited 255' }));
    publish!(upstream.emit({ type: 'tool.remove', scope: 'zion', rowKey: 't1' }));

    const late: FeedWatchEnvelope[] = [];
    const detachLate = hub.subscribe((event) => late.push(event));
    expect(starts).toHaveLength(1); // no re-dial for the second reader

    const resets = late.filter((event) => event.type === 'reset');
    expect(resets.map((event) => event.scope).sort()).toEqual(['mark-1', 'zion']);
    const zion = resets.find((event) => event.scope === 'zion')!;
    expect(zion.type === 'reset' && zion.agents.map((row) => row.rowKey)).toEqual(['a1']);
    expect(zion.type === 'reset' && zion.attention.map((item) => item.key)).toEqual(['k1']);
    // The removed tool row is genuinely gone from the replay.
    expect(zion.type === 'reset' && zion.tools).toEqual([]);
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
    held.apply(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 1, agents: [agentRow('a1', 'zion')], attention: [], tools: [toolRow('t1', 'zion')] }));
    held.apply(upstream.emit({ type: 'reset', scope: 'mark-1', capturedAt: 2, agents: [agentRow('b1', 'mark-1')], attention: [], tools: [] }));
    // mark-1 reconnects with nothing: zion must be untouched.
    held.apply(upstream.emit({ type: 'reset', scope: 'mark-1', capturedAt: 3, agents: [], attention: [], tools: [] }));
    const snapshot = held.snapshot(new FeedWatchState()).filter((event) => event.type === 'reset');
    const zion = snapshot.find((event) => event.scope === 'zion')!;
    expect(zion.type === 'reset' && zion.agents).toHaveLength(1);
    expect(zion.type === 'reset' && zion.tools).toHaveLength(1);
    const mark = snapshot.find((event) => event.scope === 'mark-1')!;
    expect(mark.type === 'reset' && mark.agents).toHaveLength(0);
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
