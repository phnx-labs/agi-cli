import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { FeedHub } from './hub.js';
import { FeedHubServer, streamFeedFromHub, waitForHub, HUB_CLIENT_BACKLOG_LIMIT } from './hub-server.js';
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

  it('defaults a reader that sends no scope line to the fleet collector', async () => {
    const endpoint = socketPath();
    const fleet = hubWithControllableFanOut();
    const local = hubWithControllableFanOut();
    const server = new FeedHubServer(fleet.hub, endpoint, local.hub);
    await server.start();
    // A pre-handshake client: connect, send nothing, expect the fleet stream.
    const socket = net.createConnection(endpoint);
    await new Promise((resolve) => socket.once('connect', resolve));
    await until('the silent reader to be attached to the fleet hub', () => fleet.hub.readerCount === 1);
    expect(local.hub.readerCount).toBe(0);
    socket.destroy();
    await server.stop();
  });
});

describe('a stalled reader cannot grow the daemon without bound', () => {
  it('drops a reader whose backlog exceeds the budget', async () => {
    const endpoint = socketPath();
    const { hub, publish } = hubWithControllableFanOut();
    const server = new FeedHubServer(hub, endpoint);
    await server.start();

    // A raw socket that connects, asks for the stream, and then NEVER reads.
    const socket = net.createConnection(endpoint);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(`${JSON.stringify({ v: 1, scope: 'fleet' })}\n`);
    socket.pause();
    await until('the stalled reader to attach', () => server.clientCount === 1);

    // A row big enough that a bounded number of envelopes exceeds the budget.
    const upstream = new FeedWatchState();
    const fat = { ...agentRow('fat', 'zion'), preview: 'x'.repeat(256 * 1024) } as typeof agentRow extends never ? never : ReturnType<typeof agentRow>;
    for (let i = 0; i < 64 && server.clientCount > 0; i++) {
      publish(upstream.emit({ type: 'agent.upsert', scope: 'zion', rowKey: `fat-${i}`, agent: fat }));
    }
    await until('the stalled reader to be dropped', () => server.droppedForBacklog > 0);
    // `destroy()` detaches on the socket's 'close', which lands a tick later.
    await until('the dropped reader to be detached', () => server.clientCount === 0);
    // The collector is released with it, so a wedged reader cannot pin the fleet.
    await until('the collector to be released', () => !hub.active);
    expect(HUB_CLIENT_BACKLOG_LIMIT).toBeGreaterThan(0);

    socket.destroy();
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
