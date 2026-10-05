import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { getHelpersDir } from '../state.js';
import { ipcEndpoint } from '../platform/ipc.js';
import { FeedHub } from './hub.js';
import type { FeedWatchEnvelope } from './envelope.js';

const IS_WINDOWS = process.platform === 'win32';
const SOCKET_NAME = 'feed-stream.sock';

export const HUB_CLIENT_BACKLOG_LIMIT = 4 * 1024 * 1024;

export const HUB_BACKLOG_GRACE_MS = 2_000;

export const HUB_DRAIN_STALL_MS = 30_000;

export const HUB_WRITE_CHUNK_BYTES = 64 * 1024;

export type FeedHubLimits = { backlogBytes?: number; backlogGraceMs?: number; drainStallMs?: number; chunkBytes?: number };

export const HUB_HANDSHAKE_GRACE_MS = 2_000;
const HUB_HANDSHAKE_MAX_BYTES = 1024;
const HUB_SCOPES = new Set(['fleet', 'local']);

export function feedHubSocketPath(): string {
  return path.join(getHelpersDir(), 'feed', SOCKET_NAME);
}

export function feedHubEndpoint(socketPath = feedHubSocketPath()): string {
  return ipcEndpoint(socketPath);
}

type DropReason = 'backlog' | 'stall';

class ReaderWriter {
  private readonly queue: Array<{ bytes: Buffer; live: boolean }> = [];
  private liveBytes = 0;
  private live = false;
  private running = false;
  private closeAfterFlush = false;
  private overBudget: NodeJS.Timeout | null = null;
  private activeRemaining = 0;

  constructor(
    private readonly socket: net.Socket,
    private readonly limits: Required<FeedHubLimits>,
    private readonly drop: (reason: DropReason, message: string) => void,
  ) {}

  get pendingBytes(): number {
    return this.queue.reduce((sum, line) => sum + line.bytes.length, 0) + this.activeRemaining + this.socket.writableLength;
  }

  startLive(): void { this.live = true; }

  write(line: string): void {
    if (this.socket.destroyed) return;
    const bytes = Buffer.from(`${line}\n`, 'utf-8');
    this.queue.push({ bytes, live: this.live });
    if (this.live) { this.liveBytes += bytes.length; this.judgeBacklog(); }
    void this.pump();
  }

  end(): void {
    this.closeAfterFlush = true;
    void this.pump();
  }

  dispose(): void {
    if (this.overBudget) { clearTimeout(this.overBudget); this.overBudget = null; }
    this.queue.length = 0;
    this.liveBytes = 0;
    this.activeRemaining = 0;
  }

  private judgeBacklog(): void {
    // Backlog must stay over budget for the grace period; a drain stall is judged separately.
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

export class FeedHubServer {
  private server: net.Server | null = null;
  private readonly detachers = new Map<net.Socket, () => void>();
  private readonly attachedTo = new Map<net.Socket, FeedHub>();
  private readonly writers = new Map<net.Socket, ReaderWriter>();
  private readonly limits: Required<FeedHubLimits>;
  droppedForBacklog = 0;
  droppedForStall = 0;
  rejectedHandshakes = 0;

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
    for (const collector of [hub, localHub]) {
      if (collector) collector.onFailure = (error) => this.failReaders(collector, error);
    }
  }

  private failReaders(collector: FeedHub, error: Error): void {
    for (const [socket, attached] of this.attachedTo) {
      if (attached !== collector || socket.destroyed) continue;
      const writer = this.writers.get(socket)!;
      writer.write(JSON.stringify({ v: 1, type: 'error', scope: '', error: error.message }));
      writer.end();
    }
  }

  get clientCount(): number { return this.detachers.size; }

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
      try { fs.unlinkSync(socketPath); } catch {  }
    }
    this.server = net.createServer((socket) => {
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
      socket.on('error', end);

      const writer = new ReaderWriter(socket, this.limits, (reason, message) => {
        if (socket.destroyed) return;
        if (reason === 'backlog') this.droppedForBacklog += 1; else this.droppedForStall += 1;
        socket.destroy(new Error(message));
      });
      this.writers.set(socket, writer);

      const reject = (reason: string) => {
        clearTimeout(grace);
        if (socket.destroyed) return;
        this.rejectedHandshakes += 1;
        writer.write(JSON.stringify({ v: 1, type: 'error', scope: '', error: `feed handshake rejected: ${reason}` }));
        writer.end();
      };

      const attach = (hub: FeedHub) => {
        if (socket.destroyed || this.detachers.has(socket)) return;
        // subscribe synchronously queues catch-up before this writer admits live events.
        const detach = hub.subscribe((event) => writer.write(JSON.stringify(event)));
        writer.startLive();
        this.detachers.set(socket, detach);
        this.attachedTo.set(socket, hub);
        if (hub.lastFailure) this.failReaders(hub, hub.lastFailure);
      };

      let handshake = '';
      socket.on('data', (chunk: Buffer) => {
        if (socket.destroyed) return;
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
        // Scope is mandatory: silently defaulting a local reader would trigger fleet fan-out.
        if (typeof scope !== 'string' || !HUB_SCOPES.has(scope)) {
          reject(`unknown scope ${JSON.stringify(scope)}; expected "fleet" or "local"`);
          return;
        }
        if (scope === 'local' && !this.localHub) {
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

export function streamFeedFromHub(options: {
  signal: AbortSignal;
  emit: (event: FeedWatchEnvelope) => void;
  endpoint?: string;
  scope?: 'fleet' | 'local';
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(options.endpoint ?? feedHubEndpoint());
    let aborted = false;
    let failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; socket.destroy(); };
    socket.on('error', (error) => { failure ??= error as Error; });
    const stop = () => { aborted = true; socket.destroy(); };
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();

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
        if ((event as FeedWatchEnvelope).v !== 1) continue;
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
      // Unsolicited close, including a partial frame, is failure; clients do not fall back locally.
      if (failure) { reject(failure); return; }
      if (partialBytes > 0) { reject(new Error(`feed hub closed mid-frame: ${partialBytes} chars of an unterminated line`)); return; }
      reject(new Error('feed hub closed the stream'));
    });
  });
}
