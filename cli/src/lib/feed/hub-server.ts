/**
 * The shared feed collector, exposed to other processes.
 *
 * {@link FeedHub} already collapses N readers in ONE process to one fleet
 * fan-out. The readers that matter are in DIFFERENT processes — the extension's
 * leader child, the menu-bar helper, an operator's `agents feed watch --json` —
 * so the hub has to be reachable across the process boundary or each of them
 * opens its own ssh-per-peer fan-out anyway.
 *
 * This is that boundary, and it is deliberately the thinnest possible one: a
 * UNIX socket (named pipe on Windows) that writes the SAME NDJSON envelopes
 * `agents feed watch --json` has always written, one per line. A client is a
 * `readline` over the socket; there is no request/response protocol, no framing
 * of its own, and no second schema to keep in sync.
 *
 * The daemon owns the server (`FeedStreamService`), which is what makes it one
 * scheduler and one executor: the hub dials peers, the clients only render. A
 * client MUST NOT fall back to running its own fan-out when the socket is
 * absent — that is the double-connection bug this module exists to remove — so
 * {@link streamFeedFromHub} fails loud and the caller starts the daemon.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { getHelpersDir } from '../state.js';
import { ipcEndpoint } from '../platform/ipc.js';
import { FeedHub } from './hub.js';
import type { FeedWatchEnvelope } from './envelope.js';

const IS_WINDOWS = process.platform === 'win32';
const SOCKET_NAME = 'feed-stream.sock';

/**
 * Outbound bytes a single reader may leave unflushed before it is dropped.
 *
 * `socket.write()` never blocks: when a reader stops draining — a stopped
 * process, a suspended laptop, a debugger paused on a breakpoint — node buffers
 * the backlog in the DAEMON's heap, without limit. A busy fleet stream is a few
 * KB per second, so a reader wedged for an hour is tens of megabytes the daemon
 * can never reclaim, and the daemon is the process every other surface depends
 * on. A reader that cannot keep up is dropped loudly instead: it can reconnect
 * and be caught up from held state, which is cheaper than the backlog.
 */
export const HUB_CLIENT_BACKLOG_LIMIT = 4 * 1024 * 1024;

/**
 * How long a reader gets to send its scope line before it is REJECTED.
 *
 * The handshake is required, not defaulted. Silently treating a missing or
 * unparseable scope as `fleet` meant a reader that sent nothing — or sent
 * garbage, or sent its line after the grace elapsed — was quietly subscribed to
 * the whole-fleet collector: it started ssh children to every peer on behalf of a
 * client that never asked for them, and delivered peer data to a client that may
 * have wanted only this box. A boundary that guesses is worse than one that
 * refuses, so an unusable handshake is reported and the connection ends.
 */
export const HUB_HANDSHAKE_GRACE_MS = 2_000;
/** Bytes of handshake accepted before the reader is rejected outright. */
const HUB_HANDSHAKE_MAX_BYTES = 1024;
/** The scopes a reader may ask for. */
const HUB_SCOPES = new Set(['fleet', 'local']);

/** The canonical socket path (POSIX) / pipe-name key (Windows). */
export function feedHubSocketPath(): string {
  return path.join(getHelpersDir(), 'feed', SOCKET_NAME);
}

/** The address a server listens on and a client connects to. */
export function feedHubEndpoint(socketPath = feedHubSocketPath()): string {
  return ipcEndpoint(socketPath);
}

/**
 * Serve one {@link FeedHub} to other processes. Each accepted connection is one
 * subscriber; closing it detaches, and the last detach stops the fan-out.
 */
export class FeedHubServer {
  private server: net.Server | null = null;
  private readonly detachers = new Map<net.Socket, () => void>();
  /** Which collector each reader is attached to, so a failure reaches only its own. */
  private readonly attachedTo = new Map<net.Socket, FeedHub>();
  /** Readers dropped for exceeding {@link HUB_CLIENT_BACKLOG_LIMIT}. Observability. */
  droppedForBacklog = 0;
  /** Readers refused for a missing, invalid, or late scope line. Observability. */
  rejectedHandshakes = 0;

  /**
   * @param hub      the FLEET collector (every reachable peer plus this box).
   * @param localHub the LOCAL-only collector, served to a reader that asks for
   *                 `scope: 'local'`. Optional: a server without one answers
   *                 every reader from the fleet hub, which is what the fleet
   *                 stream already contained.
   */
  constructor(
    private readonly hub: FeedHub,
    private readonly socketPathOverride?: string,
    private readonly localHub?: FeedHub,
  ) {
    // A collector that cannot start is reported to every reader attached to it
    // and the connection is ended, so a consumer sees a failure instead of an
    // indefinitely silent stream it cannot distinguish from an idle fleet.
    for (const collector of [hub, localHub]) {
      if (collector) collector.onFailure = (error) => this.failReaders(collector, error);
    }
  }

  /** Report a collector failure to its readers and end those connections. */
  private failReaders(collector: FeedHub, error: Error): void {
    for (const [socket, attached] of this.attachedTo) {
      if (attached !== collector || socket.destroyed) continue;
      socket.write(`${JSON.stringify({ v: 1, type: 'error', scope: '', error: error.message })}\n`);
      socket.end();
    }
  }

  /** Subscribers currently connected. Observability + tests. */
  get clientCount(): number { return this.detachers.size; }

  async start(): Promise<void> {
    const socketPath = this.socketPathOverride ?? feedHubSocketPath();
    const endpoint = this.socketPathOverride ?? feedHubEndpoint();
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!IS_WINDOWS) {
      fs.chmodSync(dir, 0o700);
      // A crashed daemon leaves the socket file behind; it accepts nothing, so
      // removing it is the only way to bind. Named pipes vanish with their owner.
      try { fs.unlinkSync(socketPath); } catch { /* nothing stale to remove */ }
    }
    this.server = net.createServer((socket) => {
      const end = () => {
        this.detachers.get(socket)?.();
        this.detachers.delete(socket);
        this.attachedTo.delete(socket);
      };
      socket.on('close', end);
      // A reader that dies mid-write surfaces as an error, not a close, and
      // leaving it subscribed would hold every peer connection open forever.
      socket.on('error', end);

      /** Refuse this reader, telling it why rather than hanging up silently. */
      const reject = (reason: string) => {
        clearTimeout(grace);
        if (socket.destroyed) return;
        this.rejectedHandshakes += 1;
        socket.write(`${JSON.stringify({ v: 1, type: 'error', scope: '', error: `feed handshake rejected: ${reason}` })}\n`);
        socket.end();
      };

      const attach = (hub: FeedHub) => {
        if (socket.destroyed || this.detachers.has(socket)) return;
        const detach = hub.subscribe((event) => {
          if (socket.destroyed) return;
          socket.write(`${JSON.stringify(event)}\n`);
          // Checked AFTER the write, so the reader is judged on a real backlog
          // rather than on one envelope's size.
          if (socket.writableLength > HUB_CLIENT_BACKLOG_LIMIT) {
            this.droppedForBacklog += 1;
            // `destroy` rather than `end`: a reader this far behind is not going
            // to drain a graceful FIN either, and the point is to release the
            // buffered bytes now. 'close' fires and detaches it.
            socket.destroy(new Error(`feed reader dropped: ${socket.writableLength} bytes unflushed exceeds the ${HUB_CLIENT_BACKLOG_LIMIT}-byte budget`));
          }
        });
        this.detachers.set(socket, detach);
        this.attachedTo.set(socket, hub);
        // A collector that ALREADY failed must not leave this reader waiting for
        // a stream that is never coming.
        if (hub.lastFailure) this.failReaders(hub, hub.lastFailure);
      };

      // The scope line is REQUIRED and must arrive within the grace window.
      let handshake = '';
      const grace = setTimeout(() => reject(`no scope line within ${HUB_HANDSHAKE_GRACE_MS}ms`), HUB_HANDSHAKE_GRACE_MS);
      grace.unref();
      socket.on('data', (chunk: Buffer) => {
        if (socket.destroyed) return;
        // A line arriving AFTER this reader is attached is a protocol error: the
        // scope is settled and a second one cannot retroactively change it.
        if (this.detachers.has(socket)) { reject('scope sent after the stream was already open'); return; }
        handshake += chunk.toString('utf-8');
        const newline = handshake.indexOf('\n');
        if (newline < 0) {
          if (handshake.length > HUB_HANDSHAKE_MAX_BYTES) reject('scope line exceeded the handshake budget');
          return;
        }
        clearTimeout(grace);
        let scope: unknown;
        try { scope = (JSON.parse(handshake.slice(0, newline)) as { scope?: unknown }).scope; }
        catch { reject('scope line is not valid JSON'); return; }
        if (typeof scope !== 'string' || !HUB_SCOPES.has(scope)) {
          reject(`unknown scope ${JSON.stringify(scope)}; expected "fleet" or "local"`);
          return;
        }
        if (scope === 'local' && !this.localHub) {
          // Serving the fleet collector instead would start peer connections a
          // local-only reader never asked for.
          reject('this server has no local collector');
          return;
        }
        attach(scope === 'local' ? this.localHub! : this.hub);
      });
      socket.once('end', () => clearTimeout(grace));
    });
    await new Promise<void>((resolve, reject) => {
      const listener = this.server!;
      listener.once('error', reject);
      if (IS_WINDOWS) { listener.listen(endpoint, () => resolve()); return; }
      // Restored on EVERY exit path. A listen error (the path is taken, the dir
      // vanished) used to leave the process umask at 0o077 for good, so every
      // later file this process created — a cache write, a journal — silently
      // became owner-only. `once` guards the double-restore when both the
      // success and error paths fire.
      const previousUmask = process.umask(0o077);
      let restored = false;
      const restoreUmask = () => { if (!restored) { restored = true; process.umask(previousUmask); } };
      listener.once('error', restoreUmask);
      listener.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); resolve(); }
        catch (error) { reject(error); }
        finally { restoreUmask(); }
      });
    });
  }

  async stop(): Promise<void> {
    for (const [socket, detach] of this.detachers) { detach(); socket.destroy(); }
    this.detachers.clear();
    this.attachedTo.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.hub.close();
    await this.localHub?.close();
  }
}

/**
 * Wait until the hub accepts a connection, or the deadline passes.
 *
 * `ensureDaemonStarted()` returns as soon as the daemon PROCESS is spawned, which
 * is well before that process has loaded its services and bound this socket.
 * Retrying immediately therefore raced the bind and failed on a daemon that was
 * about to be perfectly healthy — reported to the operator as "the shared feed
 * stream is unavailable". Resolves true once a connect succeeds.
 */
export async function waitForHub(endpoint = feedHubEndpoint(), deadlineMs = 10_000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(endpoint);
      const settle = (ok: boolean) => { probe.destroy(); resolve(ok); };
      probe.once('connect', () => settle(true));
      probe.once('error', () => settle(false));
    });
    if (reachable) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Read the shared stream from the hub until `signal` aborts.
 *
 * Rejects when the hub is not reachable. That is deliberate: a client that
 * quietly ran its own `watchFleetFeed` instead would restore the per-caller
 * ssh fan-out, so the caller starts the daemon and retries rather than
 * degrading into the thing this replaced.
 */
export function streamFeedFromHub(options: {
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  endpoint?: string;
  /** Which collector to attach to. Defaults to the whole fleet. */
  scope?: 'fleet' | 'local';
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(options.endpoint ?? feedHubEndpoint());
    let connected = false;
    // Registered before anything else touches the socket: a connect failure on
    // a missing socket path is emitted as an 'error' with no listener attached
    // yet, which node raises as an uncaught exception rather than rejecting.
    socket.on('error', (error) => finish(error as Error));
    const stop = () => { socket.destroy(); };
    options.signal.addEventListener('abort', stop, { once: true });
    const finish = (error?: Error) => {
      options.signal.removeEventListener('abort', stop);
      reader.close();
      if (error && !connected) reject(error); else resolve();
    };
    const reader = createInterface({ input: socket });
    // `readline.Interface` re-emits its input stream's error on ITSELF, and an
    // Interface with no 'error' listener raises it as an uncaught exception —
    // so handling it on the socket alone is not enough. Routed to the same
    // `finish` so a mid-stream input failure ends the read once.
    reader.on('error', (error: Error) => finish(error));
    reader.on('line', (line) => {
      if (!line) return;
      try {
        const event = JSON.parse(line) as FeedWatchEnvelope;
        // Protocol only: an unversioned line is not a feed envelope.
        if (event.v === 1) options.emit(event);
      } catch { /* a partial/foreign line is not state */ }
    });
    socket.on('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ v: 1, scope: options.scope ?? 'fleet' })}\n`);
    });
    socket.on('close', () => finish());
  });
}
