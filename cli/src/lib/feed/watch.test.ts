import { describe, expect, it } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import type { SessionMeta } from '../session/types.js';
import { SessionWatchState, toSessionWatchRow } from '../session/watch.js';
import { FeedSessionProjection, FeedWatchState, normalizePeerEnvelope, projectSessionEnvelope, type FeedWatchEnvelope } from './watch.js';

function session(id: string, extra: Partial<ActiveSession> = {}): ActiveSession {
  return { context: 'headless', kind: 'kimi', host: 'worker-a', sessionId: id, status: 'running', ...extra } as ActiveSession;
}

describe('cross-version peer envelopes', () => {
  it('reads an older peer\'s tool-less reset as a peer with no tool rows', () => {
    // A peer on a pre-tools CLI is a correct v1 producer. Before this the
    // projection read `event.tools.map` and took the whole fan-out down with a
    // TypeError the moment one such peer connected.
    const older = { v: 1, type: 'reset', streamId: 'peer', sequence: 1, scope: 'worker', capturedAt: 1, agents: [], attention: [] } as unknown as FeedWatchEnvelope;
    const normalized = normalizePeerEnvelope(older);
    expect(normalized.type === 'reset' && normalized.tools).toEqual([]);
    // Same for `setup`, added in the same protocol-v1 extension.
    expect(normalized.type === 'reset' && normalized.setup).toEqual([]);
    expect(() => new FeedSessionProjection().apply(normalized)).not.toThrow();
  });

  it('leaves an envelope that already carries tools untouched', () => {
    const state = new FeedWatchState('peer');
    const tool = { kind: 'browser', rowKey: 't1', scope: 'worker', device: 'worker', live: true, task: 'post', profile: 'work', linkStatus: 'unlinked', startedAtMs: 1, updatedAtMs: 2, captures: [], captureCounts: {} } as const;
    const event = state.emit({ type: 'reset', scope: 'worker', capturedAt: 1, agents: [], attention: [], tools: [tool], setup: [] });
    expect(normalizePeerEnvelope(event)).toBe(event);
  });
});

describe('feed watch operator projection', () => {
  it('streams Previous rows without inventing live attention for them', async () => {
    const history = {
      id: 'history', shortId: 'history', agent: 'codex',
      timestamp: '2026-08-30T20:00:00.000Z', filePath: '/sessions/history.jsonl',
    } satisfies SessionMeta;
    const sessions = new SessionWatchState('peer-stream');
    const [projected] = await projectSessionEnvelope(
      sessions.reset('worker-a', [], [history]),
      new FeedWatchState('coordinator-stream'),
    );
    expect(projected).toMatchObject({
      type: 'reset',
      agents: [{ sessionId: 'history', previous: true }],
      attention: [],
    });
  });

  it('retains peer rows while unavailable and replaces the scope on reconnect', async () => {
    const sessions = new SessionWatchState('peer-stream');
    const feed = new FeedWatchState('coordinator-stream');
    const first = await projectSessionEnvelope(sessions.reset('worker-a', [session('s1')]), feed);
    const unavailable = await projectSessionEnvelope(sessions.scope('worker-a', 'unavailable', 'ssh exited 255'), feed);
    const reconnect = await projectSessionEnvelope(sessions.reset('worker-a', [session('s1'), session('s2')]), feed);
    expect(first[0]).toMatchObject({ type: 'reset', scope: 'worker-a', agents: [{ sessionId: 's1' }] });
    expect(unavailable).toEqual([expect.objectContaining({ type: 'scope', status: 'unavailable' })]);
    expect(unavailable.some((event) => event.type === 'attention.remove')).toBe(false);
    expect(reconnect[0]).toMatchObject({ type: 'reset', agents: [{ sessionId: 's1' }, { sessionId: 's2' }] });
    expect([first[0].sequence, unavailable[0].sequence, reconnect[0].sequence]).toEqual([1, 2, 3]);
  });

  it('emits one coordinator order for agent and attention changes', async () => {
    const sessions = new SessionWatchState('peer-stream');
    sessions.reset('worker-a', []);
    const [upsert] = sessions.update('worker-a', [session('ask', {
      activity: 'waiting_input', awaitingReason: 'plan_review',
      question: { text: 'Approve the plan?', reason: 'plan_review' }, lastActivityMs: 42,
    })]);
    const projected = await projectSessionEnvelope(upsert, new FeedWatchState('coordinator'));
    expect(projected.map((event) => event.type)).toEqual(['agent.upsert', 'attention.upsert']);
    expect(projected.map((event) => event.sequence)).toEqual([1, 2]);
    expect(projected[1]).toMatchObject({ attention: { kind: 'plan_review', source: 'lifecycle' } });
  });

  it('projects a session removal as an agent removal before attention cleanup', async () => {
    const projected = await projectSessionEnvelope({
      version: 1, type: 'remove', streamId: 'peer', sequence: 2,
      capturedAt: 2, scope: 'worker-a', rowKey: 'live-row',
    }, new FeedWatchState('coordinator'));
    expect(projected.map((event) => event.type)).toEqual(['agent.remove', 'attention.remove']);
    expect(projected.map((event) => event.rowKey)).toEqual(['live-row', 'live-row']);
  });
});


/**
 * PHNX-3999 F08/F09 — a session is grouped under a project only when the
 * association is CONFIRMED (a registered project definition contains its cwd).
 *
 * The field has to survive the whole `agents feed watch --json` path, not just the
 * row builder: session envelope -> feed projection -> the serialized agent rows the
 * menu decodes. This pins both envelope kinds, because the reset and upsert paths
 * re-project rows separately.
 */
describe('confirmedProject rides the serialized feed stream (PHNX-3999 F08/F09)', () => {
  it('carries explicit null for an unbound directory through reset and upsert', async () => {
    // No project definitions exist under this test HOME, so nothing is confirmed —
    // and an unbound cwd must read as null (Uncategorized), never as `tmp`.
    const live = session('unbound', { cwd: '/tmp/some-loose-dir' });
    const sessions = new SessionWatchState('peer-stream');
    const feed = new FeedWatchState('coordinator-stream');

    const [reset] = await projectSessionEnvelope(sessions.reset('worker-a', [live], []), feed);
    const resetRow = JSON.parse(JSON.stringify(reset)).agents[0];
    expect(resetRow.sessionId).toBe('unbound');
    expect(resetRow.confirmedProject).toBeNull();
    // The historical join key is untouched — it is a bucket key, not a claim of
    // project membership, and consumers join rows on it.
    expect('confirmedProject' in resetRow).toBe(true);

    const [upsert] = await projectSessionEnvelope(
      sessions.update('worker-a', [session('unbound', { cwd: '/tmp/some-loose-dir', status: 'idle' })])[0],
      feed,
    );
    const upsertRow = JSON.parse(JSON.stringify(upsert)).agent
      ?? JSON.parse(JSON.stringify(upsert)).agents?.[0];
    expect(upsertRow.confirmedProject).toBeNull();
  });
});

describe('fleet feed shares canonical session ownership', () => {
  it('clears live attention when a raw removal leaves canonical history', async () => {
    const projection = new FeedSessionProjection();
    const sessions = new SessionWatchState();
    const feed = new FeedWatchState();
    const initial = (await projectSessionEnvelope(sessions.reset('worker', [session('same', { machine: 'worker', activity: 'waiting_input', awaitingReason: 'plan_review', question: { text: 'Review?', reason: 'plan_review' } })]), feed)).flatMap(event => projection.apply(event));
    const reset = initial.find(event => event.type === 'reset');
    const attentionKey = reset?.type === 'reset' ? reset.attention[0]?.key : undefined;
    expect(attentionKey).toBeTruthy();
    const results = [];
    for (const delta of sessions.update('worker', [])) for (const event of await projectSessionEnvelope(delta, feed)) results.push(...projection.apply(event));
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent.upsert', agent: expect.objectContaining({ previous: true }) }), expect.objectContaining({ type: 'attention.remove', scope: 'worker' })]));
    expect(results.filter(e => e.type === 'attention.remove').at(-1)?.rowKey).toBe(attentionKey);
  });

  it('ignores history attention cleanup while an authoritative live row remains', () => {
    const projection = new FeedSessionProjection();
    const state = new FeedWatchState();
    const live = toSessionWatchRow('worker', session('same'));
    const history = { ...live, rowKey: 'history', previous: true };
    projection.apply(state.emit({ type: 'reset', scope: 'worker', capturedAt: 1, agents: [live, history], attention: [], tools: [], setup: [] }));
    expect(projection.apply(state.emit({ type: 'agent.upsert', scope: 'worker', rowKey: history.rowKey, agent: { ...history, preview: 'new historical text' } }))).toEqual([]);
    expect(projection.apply(state.emit({ type: 'attention.remove', scope: 'worker', rowKey: history.rowKey }))).toEqual([]);
    expect(projection.apply(state.emit({ type: 'attention.remove', scope: 'worker', rowKey: live.rowKey }))).toEqual([]);
  });

  it('moves attention with the owner and converges resets, upserts and removals', async () => {
    const projection = new FeedSessionProjection();
    const launcher = new SessionWatchState('launcher');
    const owner = new SessionWatchState('owner');
    const sourceFeed = new FeedWatchState();
    const project = async (event: Parameters<typeof projectSessionEnvelope>[0]) => (await projectSessionEnvelope(event, sourceFeed)).flatMap(e => projection.apply(e));
    await project(launcher.reset('desktop', [session('same', { machine: 'worker', terminalId: 'tab' })]));
    const first = await project(owner.reset('worker', [session('same', { machine: 'worker', preview: 'worker preview', activity: 'waiting_input', awaitingReason: 'plan_review', question: { text: 'Review?', reason: 'plan_review' } })]));
    const reset = first.find(e => e.type === 'reset');
    expect(reset).toMatchObject({ scope: 'worker', agents: [{ preview: 'worker preview', sourceDevice: 'worker', observerTerminals: expect.arrayContaining([expect.objectContaining({ device: 'desktop', terminalId: 'tab' })]) }], attention: [{ sessionId: 'same' }] });
    const changes = owner.update('worker', [session('same', { machine: 'worker', preview: 'next', activity: 'waiting_input', awaitingReason: 'plan_review', question: { text: 'Next?', reason: 'plan_review' } })]);
    const events = (await Promise.all(changes.map(project))).flat();
    const upsert = events.find(e => e.type === 'agent.upsert');
    const attention = events.find(e => e.type === 'attention.upsert');
    expect(upsert).toBeDefined();
    expect(attention).toMatchObject({ scope: 'worker' });
    if (attention?.type === 'attention.upsert') expect(attention.rowKey).toBe(attention.attention.key);
    expect(attention!.sequence).toBeGreaterThan(upsert!.sequence);
    expect(await project(owner.reset('worker', []))).toMatchObject([{ type: 'reset', scope: 'worker', agents: [], attention: [] }]);
    expect(await project(launcher.reset('desktop', [session('same', { machine: 'worker' })]))).toMatchObject([{ type: 'reset', scope: 'desktop', agents: [], attention: [] }]);
  });
});

describe('tool-setup rows ride the local stream', () => {
  it('carries the setup cache on reset and republishes it on change, with no probe', async () => {
    const { watchLocalFeed } = await import('./watch.js');
    const rows = (readiness: 'ready' | 'stopped') => ([
      { tool: 'browser' as const, installed: true, readiness, detail: `browser ${readiness}`, checkedAtMs: 1 },
      { tool: 'computer' as const, installed: false, readiness: 'needs-setup' as const, detail: 'not installed', checkedAtMs: 1 },
      { tool: 'secrets' as const, installed: null, readiness: 'unknown' as const, detail: 'uninspectable', checkedAtMs: null },
    ]);
    let current = rows('stopped');
    let notify: ((next: typeof current) => void) | undefined;
    let reads = 0;
    const controller = new AbortController();
    const events: FeedWatchEnvelope[] = [];
    const journal = `${(await import('node:os')).tmpdir()}/feed-setup-${process.pid}.jsonl`;

    const run = watchLocalFeed({
      scope: 'm1', signal: controller.signal, emit: (event) => events.push(event),
      activityPollMs: 20,
      sessions: { readCache: () => ({ sessions: [] }) as never, readPrevious: () => [], journalPath: journal, journalPollMs: 50 },
      tools: { roots: [], sources: { browserRows: () => [], computerRows: () => [], bindings: () => [], liveTasks: () => [] } },
      setup: {
        read: () => { reads += 1; return current; },
        subscribe: (listener) => { notify = listener; return () => { notify = undefined; }; },
      },
    });

    // The reset is projected through a promise chain, so give it a turn to land.
    const deadline = Date.now() + 4_000;
    while (!events.some((event) => event.type === 'reset') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const reset = events.find((event) => event.type === 'reset');
    expect(reset?.type === 'reset' && reset.setup.map((row) => [row.tool, row.readiness])).toEqual([
      ['browser', 'stopped'], ['computer', 'needs-setup'], ['secrets', 'unknown'],
    ]);
    // Publication reads the CACHE once; it never triggers a health probe.
    expect(reads).toBe(1);

    current = rows('ready');
    notify!(current);
    while (!events.some((event) => event.type === 'setup.snapshot') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const snapshot = events.find((event) => event.type === 'setup.snapshot');
    expect(snapshot?.type === 'setup.snapshot' && snapshot.setup[0]!.readiness).toBe('ready');

    // An identical notification is not a change and publishes nothing.
    const before = events.length;
    notify!(rows('ready'));
    expect(events).toHaveLength(before);

    controller.abort();
    await run;
    // The subscription is released with the stream.
    expect(notify).toBeUndefined();
  });
});
