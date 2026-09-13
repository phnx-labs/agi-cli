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
import type { FeedWatchEnvelope } from './watch.js';

const IS_WINDOWS = process.platform === 'win32';
const SOCKET_NAME = 'feed-stream.sock';

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

  constructor(private readonly hub: FeedHub, private readonly socketPathOverride?: string) {}

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
      const detach = this.hub.subscribe((event) => {
        // A client that has gone away must not keep the fan-out alive; the
        // 'close' handler below is what detaches it.
        if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
      });
      this.detachers.set(socket, detach);
      const end = () => {
        this.detachers.get(socket)?.();
        this.detachers.delete(socket);
      };
      socket.on('close', end);
      // A reader that dies mid-write surfaces as an error, not a close, and
      // leaving it subscribed would hold every peer connection open forever.
      socket.on('error', end);
    });
    await new Promise<void>((resolve, reject) => {
      const listener = this.server!;
      listener.once('error', reject);
      if (IS_WINDOWS) { listener.listen(endpoint, () => resolve()); return; }
      const previousUmask = process.umask(0o077);
      listener.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); resolve(); }
        catch (error) { reject(error); }
        finally { process.umask(previousUmask); }
      });
    });
  }

  async stop(): Promise<void> {
    for (const [socket, detach] of this.detachers) { detach(); socket.destroy(); }
    this.detachers.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.hub.close();
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
    socket.on('connect', () => { connected = true; });
    socket.on('close', () => finish());
  });
}
