import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { FeedHub } from './hub.js';
import { FeedHubServer, streamFeedFromHub, waitForHub, HUB_CLIENT_BACKLOG_LIMIT, HUB_HANDSHAKE_GRACE_MS } from './hub-server.js';
import { FeedWatchState, type FeedWatchEnvelope } from './envelope.js';
import type { SessionWatchRow } from '../session/watch.js';

const roots: string[] = [];
function socketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-hub-'));
  roots.push(dir);
  return path.join(dir, 'feed-stream.sock');
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function agentRow(rowKey: string, scope: string): SessionWatchRow {
  return {
    rowKey, sourceDevice: scope, sessionId: `sess-${rowKey}`, kind: 'claude', status: 'running',
    context: 'terminal', previous: false, resumable: true, unwatched: true, viewingIn: null, recovery: null,
  } as unknown as SessionWatchRow;
}

async function until(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The hub under test, with a controllable stand-in for the ssh fan-out. The
 *  assertion is on how many times the hub STARTED one, so the fan-out's own
 *  transport is deliberately not exercised here (peer-stream.test.ts covers it). */
function hubWithControllableFanOut() {
  const starts: AbortSignal[] = [];
  let publish: ((event: FeedWatchEnvelope) => void) | undefined;
  const hub = new FeedHub({
    watch: async (options) => {
      starts.push(options.signal);
      publish = options.emit;
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  });
  return { hub, starts, publish: (event: FeedWatchEnvelope) => publish!(event) };
}

describe('shared feed hub over a real unix socket', () => {
  it('serves two separate readers from one fan-out and releases it when both disconnect', async () => {
    const endpoint = socketPath();
    const { hub, starts, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    expect(fs.existsSync(endpoint)).toBe(true);
    // Bound 0600 so another local user cannot read the operator's stream.
    expect((fs.statSync(endpoint).mode & 0o777).toString(8)).toBe('600');
    expect(starts).toHaveLength(0); // demand-gated: nothing dialed with no reader

    const first: FeedWatchEnvelope[] = [];
    const second: FeedWatchEnvelope[] = [];
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstDone = streamFeedFromHub({ signal: firstController.signal, emit: (event) => first.push(event), endpoint });
    await until('the first reader to attach', () => server.clientCount === 1);
    const secondDone = streamFeedFromHub({ signal: secondController.signal, emit: (event) => second.push(event), endpoint });
    await until('the second reader to attach', () => server.clientCount === 2);

    // Two processes' worth of readers, ONE collector.
    expect(starts).toHaveLength(1);
    expect(hub.readerCount).toBe(2);

    const upstream = new FeedWatchState();
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [], setup: [] }));
    publish(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: 'a2', agent: agentRow('a2', 'zion') }));
    await until('both readers to receive both envelopes', () => first.length >= 2 && second.length >= 2);
    expect(first.map((event) => event.type)).toEqual(['reset', 'agent.upsert']);
    expect(second.map((event) => event.type)).toEqual(['reset', 'agent.upsert']);
    expect(first.every((event) => event.v === 1)).toBe(true);

    firstController.abort();
    await firstDone;
    await until('the first reader to detach', () => server.clientCount === 1);
    expect(hub.active).toBe(true);

    secondController.abort();
    await secondDone;
    await until('the fan-out to be released', () => !hub.active);
    expect(starts[0]!.aborted).toBe(true);
    await server.stop();
    expect(fs.existsSync(endpoint)).toBe(false);
  });

  it('brings a reader that attaches mid-stream up to date with no re-dial', async () => {
    const endpoint = socketPath();
    const { hub, starts, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const early: FeedWatchEnvelope[] = [];
    const earlyController = new AbortController();
    const earlyDone = streamFeedFromHub({ signal: earlyController.signal, emit: (event) => early.push(event), endpoint });
    await until('the early reader to attach', () => server.clientCount === 1);
    const upstream = new FeedWatchState();
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [], setup: [] }));
    await until('the early reader to receive the reset', () => early.length >= 1);

    const late: FeedWatchEnvelope[] = [];
    const lateController = new AbortController();
    const lateDone = streamFeedFromHub({ signal: lateController.signal, emit: (event) => late.push(event), endpoint });
    await until('the late reader to be caught up', () => late.length >= 1);
    expect(starts).toHaveLength(1);
    const reset = late[0]!;
    expect(reset.type).toBe('reset');
    expect(reset.sequence).toBe(1);
    expect(reset.type === 'reset' && reset.agents.map((row) => row.rowKey)).toEqual(['a1']);

    earlyController.abort(); lateController.abort();
    await Promise.all([earlyDone, lateDone]);
    await server.stop();
  });

  it('fails loud rather than silently running its own fan-out when the hub is absent', async () => {
    const endpoint = socketPath();
    await expect(streamFeedFromHub({ signal: new AbortController().signal, emit: () => {}, endpoint }))
      .rejects.toThrow(/ENOENT|ECONNREFUSED/);
  });

  it('rebinds over a socket file a crashed daemon left behind', async () => {
    const endpoint = socketPath();
    fs.mkdirSync(path.dirname(endpoint), { recursive: true });
    fs.writeFileSync(endpoint, 'stale');
    const { hub } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const controller = new AbortController();
    const done = streamFeedFromHub({ signal: controller.signal, emit: () => {}, endpoint });
    await until('a reader to attach to the rebound socket', () => server.clientCount === 1);
    controller.abort();
    await done;
    await server.stop();
  });
});

describe('local and fleet readers share their own collectors', () => {
  it('serves two local plus two fleet readers from exactly one collector each', async () => {
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const local = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint, local.hub);
    await server.start();

    // Nothing is dialed until somebody asks — for EITHER collector.
    expect(fleet.starts).toHaveLength(0);
    expect(local.starts).toHaveLength(0);

    const seen = { fleet: [] as FeedWatchEnvelope[], local: [] as FeedWatchEnvelope[] };
    const controllers = [0, 1, 2, 3].map(() => new AbortController());
    const readers = [
      streamFeedFromHub({ signal: controllers[0]!.signal, emit: (event) => seen.fleet.push(event), endpoint, scope: 'fleet' }),
      streamFeedFromHub({ signal: controllers[1]!.signal, emit: (event) => seen.fleet.push(event), endpoint, scope: 'fleet' }),
      streamFeedFromHub({ signal: controllers[2]!.signal, emit: (event) => seen.local.push(event), endpoint, scope: 'local' }),
      streamFeedFromHub({ signal: controllers[3]!.signal, emit: (event) => seen.local.push(event), endpoint, scope: 'local' }),
    ];
    await until('all four readers to attach', () => server.clientCount === 4);
    await until('both collectors to start', () => fleet.starts.length === 1 && local.starts.length === 1);

    // Four readers, two collectors — one per topic, not one per reader.
    expect(fleet.starts).toHaveLength(1);
    expect(local.starts).toHaveLength(1);
    expect(fleet.hub.readerCount).toBe(2);
    expect(local.hub.readerCount).toBe(2);

    const upstream = new FeedWatchState();
    local.publish(upstream.emit({ type: 'reset', scope: 'this-box', capturedAt: 1, agents: [agentRow('local-1', 'this-box')], attention: [], tools: [], setup: [] }));
    await until('both local readers to receive it', () => seen.local.length >= 2);
    // A local reader must never be served fleet traffic, and vice versa.
    expect(seen.local.every((event) => event.scope === 'this-box')).toBe(true);
    expect(seen.fleet).toEqual([]);

    fleet.publish(upstream.emit({ type: 'reset', scope: 'peer-a', capturedAt: 2, agents: [], attention: [], tools: [], setup: [] }));
    await until('both fleet readers to receive it', () => seen.fleet.length >= 2);
    expect(seen.fleet.every((event) => event.scope === 'peer-a')).toBe(true);

    // Dropping the local readers releases ONLY the local collector.
    controllers[2]!.abort(); controllers[3]!.abort();
    await until('the local collector to be released', () => !local.hub.active);
    expect(fleet.hub.active).toBe(true);

    for (const controller of controllers) controller.abort();
    await Promise.all(readers);
    await server.stop();
  });

  it('REJECTS a reader that sends no scope line instead of defaulting to fleet', async () => {
    // Defaulting to fleet started ssh children to every peer on behalf of a
    // client that never asked for them, and handed peer data to a client that may
    // have wanted only this box.
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const local = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint, local.hub);
    await server.start();
    const lines: string[] = [];
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => lines.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    await until('the silent reader to receive its rejection', () => lines.join('').includes('no scope line'));
    expect(server.rejectedHandshakes).toBe(1);
    // Critically: no collector was started for it.
    expect(fleet.starts).toHaveLength(0);
    expect(local.starts).toHaveLength(0);
    expect(fleet.hub.readerCount).toBe(0);
    socket.destroy();
    await server.stop();
  });

  it('rejects an unparseable or unknown scope rather than guessing', async () => {
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint, hubWithControllableFanOut().hub);
    await server.start();
    const reject = async (payload: string, expected: RegExp) => {
      const lines: string[] = [];
      const socket = net.createConnection(endpoint);
      socket.setEncoding('utf-8');
      socket.on('data', (chunk: string) => lines.push(chunk));
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(payload);
      await until(`rejection of ${payload.trim()}`, () => expected.test(lines.join('')));
      socket.destroy();
    };
    await reject('not json at all\n', /not valid JSON/);
    await reject(`${JSON.stringify({ v: 1, scope: 'everything' })}\n`, /unknown scope/);
    await reject(`${JSON.stringify({ v: 1 })}\n`, /unknown scope/);
    await reject(`${JSON.stringify({ v: 1, scope: 7 })}\n`, /unknown scope/);
    expect(fleet.starts).toHaveLength(0);
    await server.stop();
  });

  it('rejects a scope line that arrives after the stream is already open', async () => {
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint, hubWithControllableFanOut().hub);
    await server.start();
    const lines: string[] = [];
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => lines.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`${JSON.stringify({ v: 1, scope: 'fleet' })}\n`);
    await until('the reader to attach', () => server.clientCount === 1);
    // A second scope cannot retroactively change a settled subscription.
    socket.write(`${JSON.stringify({ v: 1, scope: 'local' })}\n`);
    await until('the late scope to be rejected', () => lines.join('').includes('already open'));
    socket.destroy();
    await server.stop();
  });

  it('refuses a local reader when the server has no local collector', async () => {
    // Serving the fleet hub instead would dial peers a local-only reader never
    // asked for.
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint);
    await server.start();
    const lines: string[] = [];
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => lines.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`${JSON.stringify({ v: 1, scope: 'local' })}\n`);
    await until('the local reader to be refused', () => lines.join('').includes('no local collector'));
    expect(fleet.starts).toHaveLength(0);
    socket.destroy();
    await server.stop();
  });

  it('rejects a peer that floods the handshake without ever sending a newline', async () => {
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint);
    await server.start();
    const lines: string[] = [];
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => lines.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('x'.repeat(4096));
    await until('the flood to be rejected', () => lines.join('').includes('handshake budget'));
    expect(fleet.starts).toHaveLength(0);
    socket.destroy();
    await server.stop();
  });
});


/** A row whose serialized form is about `kib` KiB, so a few of them make a multi-MB envelope. */
function fatRow(rowKey: string, kib: number): SessionWatchRow {
  return { ...agentRow(rowKey, 'zion'), preview: 'x'.repeat(kib * 1024) } as unknown as SessionWatchRow;
}

describe('a large snapshot reaches a healthy reader whole and in order', () => {
  // The production failure: a 5 MB fleet reset was judged against the 4 MiB
  // backlog budget the instant it was written, so a perfectly healthy reader got
  // 8 KiB of it, no newline, then EOF.
  it('delivers a reset bigger than the backlog budget, then the live event behind it', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();

    const seen: FeedWatchEnvelope[] = [];
    const controller = new AbortController();
    const done = streamFeedFromHub({ signal: controller.signal, emit: (event) => seen.push(event), endpoint });
    await until('the reader to attach', () => server.clientCount === 1);

    const upstream = new FeedWatchState();
    const agents = Array.from({ length: 20 }, (_, i) => fatRow(`fat-${i}`, 256));
    const reset = upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents, attention: [], tools: [], setup: [] });
    const resetBytes = Buffer.byteLength(JSON.stringify(reset));
    expect(resetBytes).toBeGreaterThan(HUB_CLIENT_BACKLOG_LIMIT);
    publish(reset);
    publish(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: 'after', agent: agentRow('after', 'zion') }));
    await until('the reset and the live upsert to arrive', () => seen.length >= 2, 15_000);
    expect(seen.map((event) => event.type)).toEqual(['reset', 'agent.upsert']);
    expect(seen[0]!.type === 'reset' && seen[0]!.agents.length).toBe(20);
    expect(seen[0]!.type === 'reset' && seen[0]!.agents.every((row) => (row as { preview?: string }).preview?.length === 256 * 1024)).toBe(true);
    expect(server.droppedForBacklog).toBe(0);
    expect(server.droppedForStall).toBe(0);

    // A late reader's INITIAL frame is that same >4 MiB reset, served from held
    // state, and its first live event queues behind it in order.
    const late: FeedWatchEnvelope[] = [];
    const lateController = new AbortController();
    const lateDone = streamFeedFromHub({ signal: lateController.signal, emit: (event) => late.push(event), endpoint });
    await until('the late reader to attach', () => server.clientCount === 2);
    publish(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: 'later', agent: agentRow('later', 'zion') }));
    await until('the late reader to be caught up and see the live event', () => late.length >= 2, 15_000);
    expect(late.map((event) => event.type)).toEqual(['reset', 'agent.upsert']);
    expect(late[0]!.type === 'reset' && late[0]!.agents.map((row) => row.rowKey)).toEqual([...agents.map((row) => row.rowKey), 'after']);
    expect(late[1]!.type === 'agent.upsert' && late[1]!.rowKey).toBe('later');

    controller.abort(); lateController.abort();
    await Promise.all([done, lateDone]);
    await server.stop();
  });
});

describe('a cold collector delivers its initial resets to the first reader', () => {
  // The exemption for the synchronous held-state replay is not enough: the FIRST
  // reader attaches to an empty hub, and every peer's initial reset then arrives
  // as a LIVE event after `startLive()`.
  it('delivers one >4 MiB initial reset, and a same-tick burst of peer resets totalling >4 MiB, whole and in order', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const seen: FeedWatchEnvelope[] = [];
    const controller = new AbortController();
    const done = streamFeedFromHub({ signal: controller.signal, emit: (event) => seen.push(event), endpoint });
    await until('the cold first reader to attach', () => server.clientCount === 1);
    expect(hub.state.scopeNames).toEqual([]); // nothing held: everything below is live

    const upstream = new FeedWatchState();
    const big = upstream.emit({ type: 'reset', scope: 'peer-big', capturedAt: 1, agents: Array.from({ length: 20 }, (_, i) => fatRow(`big-${i}`, 256)), attention: [], tools: [], setup: [] });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(HUB_CLIENT_BACKLOG_LIMIT);
    publish(big);
    await until('the >4 MiB initial reset to land', () => seen.length >= 1, 15_000);
    expect(seen[0]!.type === 'reset' && seen[0]!.agents.length).toBe(20);

    // Thirteen peers answering at once: 6 × 1.25 MiB inside ONE tick, no
    // event-loop turn for the reader to drain in between.
    const burst = Array.from({ length: 6 }, (_, p) => upstream.emit({ type: 'reset', scope: `peer-${p}`, capturedAt: 2, agents: Array.from({ length: 5 }, (_, i) => fatRow(`p${p}-${i}`, 256)), attention: [], tools: [], setup: [] }));
    expect(burst.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)).toBeGreaterThan(HUB_CLIENT_BACKLOG_LIMIT);
    for (const event of burst) publish(event);
    await until('the whole burst to land', () => seen.length >= 7, 15_000);
    expect(seen.map((event) => event.scope)).toEqual(['peer-big', 'peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4', 'peer-5']);
    expect(server.droppedForBacklog).toBe(0);
    expect(server.droppedForStall).toBe(0);

    controller.abort();
    await done;
    await server.stop();
  });
});

describe('a stalled reader cannot grow the daemon without bound', () => {
  it('drops a reader still over the live budget after the grace, and the bytes it held are released', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const graceMs = 300;
    const server = new FeedHubServer(hub, endpoint, undefined, { backlogGraceMs: graceMs });
    await server.start();

    // A raw socket that connects, asks for the stream, and then NEVER reads.
    const socket = net.createConnection(endpoint);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`${JSON.stringify({ v: 1, scope: 'fleet' })}\n`);
    socket.pause();
    await until('the stalled reader to attach', () => server.clientCount === 1);

    // Live events paced across ticks, the way a real stream arrives, until the
    // budget is crossed and the grace has run out.
    const upstream = new FeedWatchState();
    const fat = fatRow('fat', 256);
    const eventBytes = Buffer.byteLength(JSON.stringify(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: 'probe', agent: fat }))) + 1;
    let peakPending = 0;
    let published = 0;
    let crossedAt: number | null = null;
    const started = Date.now();
    while (server.droppedForBacklog === 0) {
      if (Date.now() - started > 10_000) throw new Error('the stalled reader was never dropped');
      publish(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: `fat-${published}`, agent: fat }));
      published += 1;
      const pending = server.pendingBytes;
      peakPending = Math.max(peakPending, pending);
      if (crossedAt === null && pending > HUB_CLIENT_BACKLOG_LIMIT) crossedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Dropped within the grace window (plus pacing slack) of crossing the budget…
    expect(crossedAt).not.toBeNull();
    expect(Date.now() - crossedAt!).toBeLessThan(graceMs + 500);
    // …so the daemon never held more than the budget plus what the stream
    // produced during that window — the true bound, counting the in-flight
    // frame and the socket's own unflushed buffer, not just the queue.
    const ingressDuringGrace = Math.ceil((graceMs + 500) / 20) * eventBytes;
    expect(peakPending).toBeGreaterThan(HUB_CLIENT_BACKLOG_LIMIT);
    expect(peakPending).toBeLessThanOrEqual(HUB_CLIENT_BACKLOG_LIMIT + ingressDuringGrace);
    // `destroy()` detaches on the socket's 'close', which lands a tick later,
    // and everything held for the reader goes with it.
    await until('the dropped reader to be detached', () => server.clientCount === 0);
    expect(server.pendingBytes).toBe(0);
    // The collector is released with it, so a wedged reader cannot pin the fleet.
    await until('the collector to be released', () => !hub.active);

    socket.destroy();
    await server.stop();
  });

  it('reports the bytes of a stalled in-flight frame, not zero once the queue is empty', async () => {
    // A single 5 MiB snapshot to a paused reader: the queue empties the moment
    // the pump takes the line, so a queue-only gauge would read 0 while the
    // daemon still holds the whole frame.
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint, undefined, { drainStallMs: 60_000 });
    await server.start();
    const seed: FeedWatchEnvelope[] = [];
    const seedController = new AbortController();
    const seedDone = streamFeedFromHub({ signal: seedController.signal, emit: (event) => seed.push(event), endpoint });
    await until('the seeding reader to attach', () => server.clientCount === 1);
    const upstream = new FeedWatchState();
    const reset = upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: Array.from({ length: 20 }, (_, i) => fatRow(`fat-${i}`, 256)), attention: [], tools: [], setup: [] });
    const resetBytes = Buffer.byteLength(JSON.stringify(reset)) + 1;
    publish(reset);
    await until('the seed reset to land', () => seed.length >= 1, 15_000);
    expect(server.pendingBytes).toBe(0);

    const stalled = net.createConnection(endpoint);
    await new Promise((resolve) => stalled.once('connect', resolve));
    stalled.write(`${JSON.stringify({ v: 1, scope: 'fleet' })}\n`);
    stalled.pause();
    await until('the stalled reader to attach', () => server.clientCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The kernel took what its buffers hold; the rest is still the daemon's.
    // Only what the socket has accepted so far is unaccounted for, and that
    // is bounded by one chunk plus node's high-water mark.
    const held = server.pendingBytes;
    expect(held).toBeGreaterThan(resetBytes - 2 * 1024 * 1024);
    expect(held).toBeLessThanOrEqual(resetBytes);

    stalled.destroy();
    await until('the stalled reader to be detached', () => server.clientCount === 1);
    expect(server.pendingBytes).toBe(0);
    seedController.abort();
    await seedDone;
    await server.stop();
  });

  it('drops a reader that stops draining a large snapshot, without waiting on the live budget', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    // A short stall deadline so the test observes the bound, not the 30 s default.
    const server = new FeedHubServer(hub, endpoint, undefined, { drainStallMs: 300 });
    await server.start();

    // Seed a >4 MiB held reset through a healthy reader.
    const seed: FeedWatchEnvelope[] = [];
    const seedController = new AbortController();
    const seedDone = streamFeedFromHub({ signal: seedController.signal, emit: (event) => seed.push(event), endpoint });
    await until('the seeding reader to attach', () => server.clientCount === 1);
    const upstream = new FeedWatchState();
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: Array.from({ length: 20 }, (_, i) => fatRow(`fat-${i}`, 256)), attention: [], tools: [], setup: [] }));
    await until('the seed reset to land', () => seed.length >= 1, 15_000);

    // A reader that asks for the stream and never reads a byte of its snapshot.
    const stalled = net.createConnection(endpoint);
    await new Promise((resolve) => stalled.once('connect', resolve));
    stalled.write(`${JSON.stringify({ v: 1, scope: 'fleet' })}\n`);
    stalled.pause();
    await until('the stalled reader to attach', () => server.clientCount === 2);
    const started = Date.now();
    await until('the stalled reader to be dropped for not draining', () => server.droppedForStall > 0, 5_000);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(server.droppedForBacklog).toBe(0); // no live event was ever queued for it
    await until('the dropped reader to be detached', () => server.clientCount === 1);
    // The healthy reader is untouched.
    expect(seed).toHaveLength(1);

    stalled.destroy();
    seedController.abort();
    await seedDone;
    await server.stop();
  });
});

describe('the client tells a truncated stream from a finished one', () => {
  it('rejects when the hub goes away before the reader asked to leave', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const seen: FeedWatchEnvelope[] = [];
    const controller = new AbortController();
    const client = streamFeedFromHub({ signal: controller.signal, emit: (event) => seen.push(event), endpoint });
    await until('the client to attach', () => server.clientCount === 1);
    const upstream = new FeedWatchState();
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [], setup: [] }));
    await until('the reset to land', () => seen.length >= 1);
    // The daemon stops without the client asking: a FIN the client did not
    // initiate is a failure, never a clean end — `agents feed watch` must not
    // exit 0 on it.
    await server.stop();
    await expect(client).rejects.toThrow(/feed hub closed the stream/);
    expect(seen.map((event) => event.type)).toEqual(['reset']);
  });

  it('rejects a FIN inside a line as a truncated frame instead of exiting as if the stream ended cleanly', async () => {
    // The production symptom: 8 KiB of a reset, no newline, EOF — and the old
    // readline client discarded the partial line and resolved. Only a peer that
    // hangs up mid-line can produce that deterministically, so this is a bare
    // socket peer: the client cannot tell what process is on the other end.
    const endpoint = socketPath();
    const upstream = new FeedWatchState();
    const whole = `${JSON.stringify(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 1, agents: [agentRow('a1', 'zion')], attention: [], tools: [], setup: [] }))}\n`;
    const half = JSON.stringify(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 2, agents: [fatRow('fat', 64)], attention: [], tools: [], setup: [] })).slice(0, 8192);
    const peer = net.createServer((socket) => {
      // One complete line, then 8 KiB of the next with no newline, then FIN.
      socket.once('data', () => { socket.write(whole); socket.write(half); socket.end(); });
    });
    await new Promise<void>((resolve) => peer.listen(endpoint, resolve));
    const seen: FeedWatchEnvelope[] = [];
    const client = streamFeedFromHub({ signal: new AbortController().signal, emit: (event) => seen.push(event), endpoint });
    await expect(client).rejects.toThrow(/closed mid-frame: 8192 chars/);
    // The complete frame was delivered; the truncated one was never emitted.
    expect(seen.map((event) => [event.type, event.sequence])).toEqual([['reset', 1]]);
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  });

  it('rejects, and closes the socket, when the consumer throws or the hub sends a non-object line', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const upstream = new FeedWatchState();

    // A consumer that throws: the throw must land on THIS promise, not escape
    // the socket's 'data' handler as an uncaught exception.
    const throwing = streamFeedFromHub({ signal: new AbortController().signal, emit: () => { throw new Error('renderer exploded'); }, endpoint });
    await until('the throwing reader to attach', () => server.clientCount === 1);
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 1, agents: [], attention: [], tools: [], setup: [] }));
    await expect(throwing).rejects.toThrow('renderer exploded');
    await until('the throwing reader to be detached', () => server.clientCount === 0);

    // A `null` line is valid JSON and not an envelope; it used to throw on `.v`.
    const peer = net.createServer((socket) => { socket.once('data', () => { socket.write('null\n'); }); });
    const nullEndpoint = socketPath();
    await new Promise<void>((resolve) => peer.listen(nullEndpoint, resolve));
    const seen: FeedWatchEnvelope[] = [];
    await expect(streamFeedFromHub({ signal: new AbortController().signal, emit: (event) => seen.push(event), endpoint: nullEndpoint }))
      .rejects.toThrow(/not an envelope: null/);
    expect(seen).toEqual([]);
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await server.stop();
  });

  it('stops promptly with a reader still in its handshake, closing it', async () => {
    const endpoint = socketPath();
    const server = new FeedHubServer(hubWithControllableFanOut().hub, endpoint);
    await server.start();
    const silent = net.createConnection(endpoint);
    await new Promise((resolve) => silent.once('connect', resolve));
    const closed = new Promise<void>((resolve) => silent.once('close', () => resolve()));
    // `server.close` waits for open sockets; a never-handshaking one held the
    // daemon's shutdown for the whole 2 s grace.
    const started = Date.now();
    await server.stop();
    await closed;
    expect(Date.now() - started).toBeLessThan(HUB_HANDSHAKE_GRACE_MS / 2);
    expect(server.rejectedHandshakes).toBe(0); // the grace timer was cleared, not fired
    expect(server.clientCount).toBe(0);
  });

  it('rejects a server-side refusal after surfacing its error envelope', async () => {
    const endpoint = socketPath();
    const server = new FeedHubServer(hubWithControllableFanOut().hub, endpoint);
    await server.start();
    const seen: FeedWatchEnvelope[] = [];
    // `local` on a server with no local collector is refused with a reason.
    const client = streamFeedFromHub({ signal: new AbortController().signal, emit: (event) => seen.push(event), endpoint, scope: 'local' });
    await expect(client).rejects.toThrow(/feed hub closed the stream/);
    expect(seen.map((event) => event.type)).toEqual(['error']);
    await server.stop();
  });

  it('resolves cleanly on abort and releases the server side', async () => {
    const endpoint = socketPath();
    const { hub } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const controller = new AbortController();
    const client = streamFeedFromHub({ signal: controller.signal, emit: () => {}, endpoint });
    await until('the reader to attach', () => server.clientCount === 1);
    controller.abort();
    await expect(client).resolves.toBeUndefined();
    await until('the server to detach the aborted reader', () => server.clientCount === 0);
    await until('the collector to be released', () => !hub.active);
    expect(server.pendingBytes).toBe(0);
    // Aborting before the connect lands resolves too, never hangs.
    const early = new AbortController();
    early.abort();
    await expect(streamFeedFromHub({ signal: early.signal, emit: () => {}, endpoint })).resolves.toBeUndefined();
    await server.stop();
  });
});

describe('startup readiness', () => {
  it('waits for a hub that binds slightly late instead of failing the first probe', async () => {
    const endpoint = socketPath();
    const { hub } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    // Nothing is listening yet: the immediate probe must fail...
    expect(await waitForHub(endpoint, 0, 5)).toBe(false);
    // ...and the bounded wait must succeed once the bind lands, which is the
    // race `ensureDaemonStarted()` + an immediate retry used to lose.
    const late = setTimeout(() => { void server.start(); }, 150);
    expect(await waitForHub(endpoint, 5_000, 25)).toBe(true);
    clearTimeout(late);
    await server.stop();
  });

  it('gives up after the deadline rather than waiting forever', async () => {
    const started = Date.now();
    expect(await waitForHub(socketPath(), 120, 20)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe('a collector that cannot start is reported to its readers', () => {
  it('tells the reader and ends the connection instead of going silent', async () => {
    const endpoint = socketPath();
    const hub = new FeedHub({ watch: async () => { throw new Error('device registry unreadable'); } });
    const server = new FeedHubServer(hub, endpoint);
    await server.start();
    const lines: string[] = [];
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => lines.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`${JSON.stringify({ v: 1, scope: 'fleet' })}\n`);
    await until('the failure to reach the reader', () => lines.join('').includes('device registry unreadable'));
    expect(lines.join('')).toContain('"type":"error"');
    socket.destroy();
    await server.stop();
  });
});
