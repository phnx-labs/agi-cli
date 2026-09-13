import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FeedHub } from './hub.js';
import { FeedHubServer, streamFeedFromHub } from './hub-server.js';
import { FeedWatchState, type FeedWatchEnvelope } from './watch.js';
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
    watch: (async (options: { signal: AbortSignal; emit: (event: FeedWatchEnvelope) => void }) => {
      starts.push(options.signal);
      publish = options.emit;
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
    }) as unknown as typeof import('./watch.js').watchFleetFeed,
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
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [] }));
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
    publish(upstream.emit({ type: 'reset', scope: 'zion', capturedAt: 10, agents: [agentRow('a1', 'zion')], attention: [], tools: [] }));
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
