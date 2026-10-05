/** The shared feed collector exposed to other processes over a UNIX socket (named pipe on
 * Windows) writing the same NDJSON envelopes as `agents feed watch --json`. The daemon owns it;
 * a client must never fall back to its own fan-out: streamFeedFromHub fails loud. */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { getHelpersDir } from '../state.js';
import { ipcEndpoint } from '../platform/ipc.js';
import { FeedHub } from './hub.js';
import type { FeedWatchEnvelope } from './envelope.js';

const IS_WINDOWS = process.platform === 'win32';
const SOCKET_NAME = 'feed-stream.sock';

/** Live bytes a reader may leave queued, sustained past HUB_BACKLOG_GRACE_MS, before it is
 * dropped: `socket.write()` never blocks, so a wedged reader grows the daemon's heap. Judged as a
 * sustained condition, never per burst; the catch-up snapshot is not counted. */
export const HUB_CLIENT_BACKLOG_LIMIT = 4 * 1024 * 1024;

/** How long a reader may stay past HUB_CLIENT_BACKLOG_LIMIT before it is dropped. Live queued
 * bytes are bounded by the budget plus the stream's output in this window; the snapshot and the
 * in-flight frame sit outside that figure. */
export const HUB_BACKLOG_GRACE_MS = 2_000;

/** How long a reader may leave one chunk unaccepted before it is dropped. A `false` write means
 * the reader has not read the kernel buffer; without this a paused reader would hold a large
 * snapshot's remainder in the daemon heap forever. */
export const HUB_DRAIN_STALL_MS = 30_000;

/** Bytes per socket write, small enough that the reader's backpressure paces a multi-MB snapshot
 * instead of copying it into the heap at once. */
export const HUB_WRITE_CHUNK_BYTES = 64 * 1024;

/** Optional overrides for the transport bounds. Tests exercise both bounds fast. */
export type FeedHubLimits = { backlogBytes?: number; backlogGraceMs?: number; drainStallMs?: number; chunkBytes?: number };

/** How long a reader gets to send its scope line before it is rejected. The handshake is
 * required: defaulting a missing or garbled scope to `fleet` subscribed silent readers to every
 * peer (ssh children and peer data nobody asked for). */
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

/** Why a reader was dropped; each counts on its own server counter. */
type DropReason = 'backlog' | 'stall';

/** One reader's ordered outbound queue; every line (snapshot, live events, refusal error) goes
 * through it so none lands inside another. Written in HUB_WRITE_CHUNK_BYTES chunks awaiting
 * 'drain'; dropped on a chunk stalled `drainStallMs` or a backlog over budget past the grace. */
class ReaderWriter {
  /** Lines not yet handed to the socket; `live` marks the ones the budget counts. */
  private readonly queue: Array<{ bytes: Buffer; live: boolean }> = [];
  /** Bytes queued since the snapshot finished enqueuing; the budgeted part. */
  private liveBytes = 0;
  private live = false;
  private running = false;
  private closeAfterFlush = false;
  /** Armed while the live queue is over budget; fires the drop if it still is. */
  private overBudget: NodeJS.Timeout | null = null;
  /** Bytes of the line being pumped that have not yet been handed to the socket. */
  private activeRemaining = 0;

  constructor(
    private readonly socket: net.Socket,
    private readonly limits: Required<FeedHubLimits>,
    private readonly drop: (reason: DropReason, message: string) => void,
  ) {}

  /** Unflushed bytes for this reader: queued lines, the unwritten rest of the current line, and
   * the socket buffer. A gauge of what is owed, not retained heap; a queue-only gauge read 0
   * for a paused reader with a 5 MiB frame mostly unflushed. */
  get pendingBytes(): number {
    return this.queue.reduce((sum, line) => sum + line.bytes.length, 0) + this.activeRemaining + this.socket.writableLength;
  }

  /** Everything enqueued from now on is a live event and counts against the budget. */
  startLive(): void { this.live = true; }

  write(line: string): void {
    if (this.socket.destroyed) return;
    const bytes = Buffer.from(`${line}\n`, 'utf-8');
    this.queue.push({ bytes, live: this.live });
    if (this.live) { this.liveBytes += bytes.length; this.judgeBacklog(); }
    void this.pump();
  }

  /** FIN once everything queued has been handed to the socket. */
  end(): void {
    this.closeAfterFlush = true;
    void this.pump();
  }

  /** Release the timers; the socket is gone. */
  dispose(): void {
    if (this.overBudget) { clearTimeout(this.overBudget); this.overBudget = null; }
    this.queue.length = 0;
    this.liveBytes = 0;
    this.activeRemaining = 0;
  }

  private judgeBacklog(): void {
    if (this.liveBytes <= this.limits.backlogBytes) {
      if (this.overBudget) { clearTimeout(this.overBudget); this.overBudget = null; }
      return;
    }
    if (this.overBudget) return;
    this.overBudget = setTimeout(() => {
      this.overBudget = null;
      if (this.liveBytes > this.limits.backlogBytes) {
        this.drop('backlog', `feed reader dropped: ${this.liveBytes} live bytes queued exceeded the ${this.limits.backlogBytes}-byte budget for ${this.limits.backlogGraceMs}ms`);
      }
    }, this.limits.backlogGraceMs);
    this.overBudget.unref();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.socket.destroyed) {
        const { bytes, live } = this.queue.shift()!;
        if (live) { this.liveBytes -= bytes.length; this.judgeBacklog(); }
        for (let offset = 0; offset < bytes.length && !this.socket.destroyed; offset += this.limits.chunkBytes) {
          const end = Math.min(offset + this.limits.chunkBytes, bytes.length);
          this.activeRemaining = bytes.length - end;
          const accepted = this.socket.write(bytes.subarray(offset, end));
          if (!accepted && !await this.drained()) return;
        }
        this.activeRemaining = 0;
      }
      if (this.closeAfterFlush && !this.socket.destroyed) this.socket.end();
    } finally {
      this.running = false;
    }
  }

  /** Resolve true on `'drain'`; false when the socket closed or the stall deadline passed. */
  private drained(): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (ok: boolean) => {
        clearTimeout(stall);
        this.socket.off('drain', onDrain); this.socket.off('close', onClose);
        resolve(ok);
      };
      const onDrain = () => settle(true);
      const onClose = () => settle(false);
      const stall = setTimeout(() => {
        this.drop('stall', `feed reader dropped: no drain within ${this.limits.drainStallMs}ms with ${this.socket.writableLength} bytes unaccepted`);
        settle(false);
      }, this.limits.drainStallMs);
      stall.unref();
      this.socket.once('drain', onDrain);
      this.socket.once('close', onClose);
    });
  }
}

/** Serves one FeedHub to other processes. Each connection is one subscriber; the last detach
 * stops the fan-out. */
export class FeedHubServer {
  private server: net.Server | null = null;
  private readonly detachers = new Map<net.Socket, () => void>();
  /** Which collector each reader is attached to, so a failure reaches only its own. */
  private readonly attachedTo = new Map<net.Socket, FeedHub>();
  private readonly writers = new Map<net.Socket, ReaderWriter>();
  private readonly limits: Required<FeedHubLimits>;
  /** Readers dropped for queueing live bytes past the budget. Observability. */
  droppedForBacklog = 0;
  /** Readers dropped for not draining a chunk within the stall deadline. Observability. */
  droppedForStall = 0;
  /** Readers refused for a missing, invalid, or late scope line. Observability. */
  rejectedHandshakes = 0;

  /** `hub` is the fleet collector; `localHub` is the local-only collector served for `scope:
   * 'local'`. Without one, every reader is answered from the fleet hub. */
  constructor(
    private readonly hub: FeedHub,
    private readonly socketPathOverride?: string,
    private readonly localHub?: FeedHub,
    limits: FeedHubLimits = {},
  ) {
    this.limits = {
      backlogBytes: limits.backlogBytes ?? HUB_CLIENT_BACKLOG_LIMIT,
      backlogGraceMs: limits.backlogGraceMs ?? HUB_BACKLOG_GRACE_MS,
      drainStallMs: limits.drainStallMs ?? HUB_DRAIN_STALL_MS,
      chunkBytes: limits.chunkBytes ?? HUB_WRITE_CHUNK_BYTES,
    };
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
      const writer = this.writers.get(socket)!;
      writer.write(JSON.stringify({ v: 1, type: 'error', scope: '', error: error.message }));
      writer.end();
    }
  }

  /** Subscribers currently connected. Observability + tests. */
  get clientCount(): number { return this.detachers.size; }

  /** Bytes queued for every reader and not yet handed to a socket. Observability + tests. */
  get pendingBytes(): number {
    let total = 0;
    for (const writer of this.writers.values()) total += writer.pendingBytes;
    return total;
  }

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
      // The scope line is REQUIRED and must arrive within the grace window.
      const grace = setTimeout(() => reject(`no scope line within ${HUB_HANDSHAKE_GRACE_MS}ms`), HUB_HANDSHAKE_GRACE_MS);
      grace.unref();
      const end = () => {
        clearTimeout(grace);
        this.detachers.get(socket)?.();
        this.detachers.delete(socket);
        this.attachedTo.delete(socket);
        this.writers.get(socket)?.dispose();
        this.writers.delete(socket);
      };
      socket.on('close', end);
      // A reader that dies mid-write surfaces as an error, not a close, and
      // leaving it subscribed would hold every peer connection open forever.
      socket.on('error', end);

      const writer = new ReaderWriter(socket, this.limits, (reason, message) => {
        if (socket.destroyed) return;
        if (reason === 'backlog') this.droppedForBacklog += 1; else this.droppedForStall += 1;
        // `destroy` rather than `end`: a reader this far behind is not going
        // to drain a graceful FIN either, and the point is to release the
        // queued bytes now. 'close' fires and detaches it.
        socket.destroy(new Error(message));
      });
      this.writers.set(socket, writer);

      /** Refuse this reader, telling it why rather than hanging up silently. */
      const reject = (reason: string) => {
        clearTimeout(grace);
        if (socket.destroyed) return;
        this.rejectedHandshakes += 1;
        writer.write(JSON.stringify({ v: 1, type: 'error', scope: '', error: `feed handshake rejected: ${reason}` }));
        writer.end();
      };

      const attach = (hub: FeedHub) => {
        if (socket.destroyed || this.detachers.has(socket)) return;
        // `subscribe` emits the catch-up snapshot synchronously before it
        // returns, so every line enqueued until then is snapshot and the first
        // live event can only ever queue behind it.
        const detach = hub.subscribe((event) => writer.write(JSON.stringify(event)));
        writer.startLive();
        this.detachers.set(socket, detach);
        this.attachedTo.set(socket, hub);
        // A collector that ALREADY failed must not leave this reader waiting for
        // a stream that is never coming.
        if (hub.lastFailure) this.failReaders(hub, hub.lastFailure);
      };

      let handshake = '';
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
    });
    await new Promise<void>((resolve, reject) => {
      const listener = this.server!;
      listener.once('error', reject);
      if (IS_WINDOWS) { listener.listen(endpoint, () => resolve()); return; }
      // Restored on every exit path: a listen error used to leave the umask at 0o077, making every
      // later file this process created owner-only. `once` guards a double restore.
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
    for (const detach of this.detachers.values()) detach();
    // Every connection, including one still in its handshake: `server.close`
    // waits for open sockets, and a reader that never sent its scope line
    // would otherwise hold the daemon's shutdown for the whole grace window.
    for (const [socket, writer] of this.writers) { writer.dispose(); socket.destroy(); }
    this.detachers.clear();
    this.attachedTo.clear();
    this.writers.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await this.hub.close();
    await this.localHub?.close();
  }
}

/** Waits until the hub accepts a connection or the deadline passes. `ensureDaemonStarted()`
 * returns when the process is spawned, before it binds this socket, so an immediate retry raced
 * the bind and reported "shared feed stream is unavailable" on a healthy daemon. */
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

/** Reads the shared stream from the hub until `signal` aborts. Rejects when the hub is
 * unreachable (no own `watchFleetFeed` fan-out; start the daemon and retry), and on any close
 * before abort: an early FIN once exited 0 after 8 KiB of a 5 MB reset. */
export function streamFeedFromHub(options: {
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  endpoint?: string;
  /** Which collector to attach to. Defaults to the whole fleet. */
  scope?: 'fleet' | 'local';
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(options.endpoint ?? feedHubEndpoint());
    let aborted = false;
    let failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; socket.destroy(); };
    // Registered before anything else touches the socket: a connect failure on
    // a missing socket path is emitted as an 'error' with no listener attached
    // yet, which node raises as an uncaught exception rather than rejecting.
    socket.on('error', (error) => { failure ??= error as Error; });
    const stop = () => { aborted = true; socket.destroy(); };
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();

    // Pieces of the line in progress; only the newest chunk is searched for a
    // newline, so an 8 MB reset arriving in 64 KiB chunks is not rescanned from
    // its start on every chunk.
    const partial: string[] = [];
    let partialBytes = 0;
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      let rest = chunk;
      for (;;) {
        const newline = rest.indexOf('\n');
        if (newline < 0) { partial.push(rest); partialBytes += rest.length; return; }
        partial.push(rest.slice(0, newline));
        const line = partial.join('');
        partial.length = 0; partialBytes = 0;
        rest = rest.slice(newline + 1);
        if (!line) continue;
        let event: unknown;
        try { event = JSON.parse(line); }
        catch { fail(new Error(`feed hub sent a line that is not JSON (${line.length} chars)`)); return; }
        if (typeof event !== 'object' || event === null) { fail(new Error(`feed hub sent a line that is not an envelope: ${line.slice(0, 80)}`)); return; }
        // Protocol only: an unversioned line is not a feed envelope.
        if ((event as FeedWatchEnvelope).v !== 1) continue;
        // A consumer that throws ends the read as a failure of THIS promise; left
        // to escape the socket's 'data' handler it is an uncaught exception.
        try { options.emit(event as FeedWatchEnvelope); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ v: 1, scope: options.scope ?? 'fleet' })}\n`);
    });
    socket.on('close', () => {
      options.signal.removeEventListener('abort', stop);
      if (aborted) { resolve(); return; }
      if (failure) { reject(failure); return; }
      if (partialBytes > 0) { reject(new Error(`feed hub closed mid-frame: ${partialBytes} chars of an unterminated line`)); return; }
      reject(new Error('feed hub closed the stream'));
    });
  });
}
