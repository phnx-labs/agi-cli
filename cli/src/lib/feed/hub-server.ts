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
 * line splitter over the socket; there is no request/response protocol, no framing
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
import { getHelpersDir } from '../state.js';
import { ipcEndpoint } from '../platform/ipc.js';
import { FeedHub } from './hub.js';
import type { FeedWatchEnvelope } from './envelope.js';

const IS_WINDOWS = process.platform === 'win32';
const SOCKET_NAME = 'feed-stream.sock';

/**
 * Live bytes a reader may leave queued, sustained past {@link HUB_BACKLOG_GRACE_MS},
 * before it is dropped.
 *
 * `socket.write()` never blocks: when a reader stops draining — a stopped
 * process, a suspended laptop, a debugger paused on a breakpoint — node buffers
 * the backlog in the DAEMON's heap, without limit. A busy fleet stream is a few
 * KB per second, so a reader wedged for an hour is tens of megabytes the daemon
 * can never reclaim, and the daemon is the process every other surface depends
 * on. A reader that cannot keep up is dropped loudly instead: it can reconnect
 * and be caught up from held state, which is cheaper than the backlog.
 *
 * The budget is a SUSTAINED condition on queued live events, never a verdict on
 * one envelope or one burst. A cold collector delivers every peer's reset as a
 * live event, thirteen of them inside one tick, and a healthy reader drains
 * that in milliseconds; judging the budget the instant an envelope was written
 * is how a 5 MB fleet reset was cut off after 8 KiB and delivered as one
 * unterminated line (the Menu activation failure this module's writer fixes).
 * The catch-up snapshot is never counted: it is bounded by the held state and is
 * exactly what a fresh reader is waiting for.
 */
export const HUB_CLIENT_BACKLOG_LIMIT = 4 * 1024 * 1024;

/**
 * How long a reader may stay past {@link HUB_CLIENT_BACKLOG_LIMIT} before it is
 * dropped. A healthy reader on a unix socket clears the whole budget in well
 * under this; one still over it after this long is not keeping up. The live
 * bytes queued for a reader are therefore bounded by the budget plus what the
 * stream produces in this window; the snapshot and the frame in flight sit
 * outside that figure.
 */
export const HUB_BACKLOG_GRACE_MS = 2_000;

/**
 * How long a reader may leave one chunk unaccepted before it is dropped.
 *
 * A write that returned `false` is a kernel buffer full of bytes the reader has
 * not read. A healthy reader — even one on a busy laptop — clears it in
 * milliseconds; one that has not in this long is not reading at all, and the
 * live-bytes budget alone would let a paused reader hold a large snapshot's
 * remainder in the daemon's heap forever.
 */
export const HUB_DRAIN_STALL_MS = 30_000;

/**
 * Bytes handed to the socket per write. Small enough that a reader's own
 * backpressure (`write()` returning `false`, then `'drain'`) paces a multi-MB
 * snapshot instead of dumping it into the daemon's heap in one copy.
 */
export const HUB_WRITE_CHUNK_BYTES = 64 * 1024;

/** Optional overrides for the transport bounds. Tests exercise both bounds fast. */
export type FeedHubLimits = { backlogBytes?: number; backlogGraceMs?: number; drainStallMs?: number; chunkBytes?: number };

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

/** Why a reader was dropped; each counts on its own server counter. */
type DropReason = 'backlog' | 'stall';

/**
 * One reader's ordered outbound queue.
 *
 * Every line to one socket goes through this — snapshot, live events, and the
 * error envelope that precedes a refusal — so nothing can land inside another
 * line. Lines are written in {@link HUB_WRITE_CHUNK_BYTES} chunks and the pump
 * waits for `'drain'` after every write the socket did not accept, so the socket
 * never holds more than one chunk past its high-water mark. The frame's own
 * Buffer stays allocated until its last chunk is written (`subarray` is a view),
 * so `pendingBytes` is a gauge of UNFLUSHED bytes, not of retained heap. Two
 * bounds drop the reader: a chunk left unaccepted for `drainStallMs`, and live
 * bytes queued past `backlogBytes` for longer than `backlogGraceMs`. The bound
 * on what a reader can make the daemon hold is therefore time- and
 * rate-dependent — the budget, plus the stream's ingress during the grace,
 * plus the snapshot and the frame in flight — not a hard allocation cap.
 */
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

  /**
   * Unflushed bytes for this reader: queued lines, the unwritten rest of the
   * line being pumped, and the socket's own buffer. A gauge of what is still
   * owed to the socket, not of retained heap. A 5 MiB frame to a paused reader
   * leaves the queue on its first chunk, so a queue-only gauge read 0 while
   * almost all of it was still unflushed.
   */
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

/**
 * Serve one {@link FeedHub} to other processes. Each accepted connection is one
 * subscriber; closing it detaches, and the last detach stops the fan-out.
 */
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
 *
 * Also rejects on any close the caller did not ask for. The stream has no end
 * of its own — the hub serves it until the reader leaves — so a FIN that
 * arrives before `signal` aborts is the hub refusing, failing, or dropping this
 * reader, and a FIN inside a line is a frame the hub never finished. Resolving
 * there let `agents feed watch --json` exit 0 after 8 KiB of a 5 MB reset,
 * which is indistinguishable from an empty fleet.
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
