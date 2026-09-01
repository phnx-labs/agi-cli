import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { IS_WINDOWS, ipcEndpoint } from '../platform/index.js';
import { getHelpersDir } from '../state.js';
import { resolveBrowserTaskIdleMs } from '../device-config.js';
import { BrowserService } from './service.js';
import {
  getDaemonLogPath,
  isDaemonRunning,
  signalDaemonReload,
  startDaemon,
} from '../daemon/daemon.js';
import { getCliVersion } from '../version.js';
import { compareVersions } from '../agent-spec/primitives.js';
import { attemptSelfUpdateAndExit } from '../daemon/self-update-service.js';
import { log as daemonLog } from '../daemon/daemon.js';
import {
  isDaemonServiceEnabled,
  queueDaemonServiceRestart,
  setDaemonServiceEnabled,
} from '../daemon-services.js';
import { isFleetRemoteInvocation } from './remote-control.js';
import { resolveCallerIdentity } from './caller-identity.js';
import { actionable } from './service.js';
import type { IPCRequest, IPCResponse, RefNodeJson } from './types.js';

/**
 * Verbs that imply a page and may CREATE a task when none resolves.
 * Observation-only verbs (console/logs/…) resolve but never create — an
 * empty `agents browser logs` must not open a browser just to return [].
 */
const PAGE_CREATE_VERBS = new Set<IPCRequest['action']>([
  'navigate',
  'tab-add',
  'evaluate',
  'screenshot',
  'pdf',
  'refs',
  'click',
  'type',
  'press',
  'hover',
  'scroll',
  'set-viewport',
  'set-device',
  'wait',
  'set-download-path',
  'wait-download',
  'upload',
  'record-start',
]);

/** Task-scoped verbs that resolve identity but never create. */
const PAGE_RESOLVE_VERBS = new Set<IPCRequest['action']>([
  ...PAGE_CREATE_VERBS,
  'tab-focus',
  'tab-close',
  'tab-list',
  'console',
  'errors',
  'requests',
  'response-body',
  'getAppLogs',
  'record-stop',
]);

/** Close verbs never create a task. */
const CLOSE_VERBS = new Set<IPCRequest['action']>(['done', 'stop']);

const SOCKET_NAME = 'browser.sock';

interface SocketIdentity {
  dev: number;
  ino: number;
}

function readSocketIdentity(socketPath: string): SocketIdentity | null {
  try {
    const stat = fs.lstatSync(socketPath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function isSameSocket(socketPath: string, expected: SocketIdentity): boolean {
  const current = readSocketIdentity(socketPath);
  return current !== null && current.dev === expected.dev && current.ino === expected.ino;
}

/**
 * Backstop for {@link BrowserIPCServer.stop} — how long to wait for the socket
 * to be released before unlinking it anyway (RUSH-2421).
 *
 * This MUST stay well under the daemon's SIGTERM grace window
 * (`STOP_GRACE_MS`, daemon.ts). `handleShutdown` awaits `stop()`, so a close
 * that takes as long as the grace window means `stopDaemon` gives up waiting
 * and escalates to `killTree` — turning every graceful stop into a kill. The
 * first version of this constant was set to exactly 5000, the same value as
 * `STOP_GRACE_MS`, and did precisely that whenever a browser client held its
 * (deliberately) long-lived connection open.
 *
 * With connections now ended explicitly in `closeServer`, reaching this
 * timeout at all means a socket refused to die; 1.5s bounds that without
 * coming near the grace window.
 */
const IPC_CLOSE_TIMEOUT_MS = 1_500;

/**
 * How long {@link waitForBrowserService} waits for the browser service to come up before
 * failing loud (PHNX-3289).
 *
 * The old flat 6s ceiling was the wedge: the shared daemon's browser IPC server
 * restarts (version reconcile, supervisor restart, a hard-crashed predecessor's
 * successor claiming the socket), and a client that started its wait *during*
 * one of those restart windows could burn the whole 6s and throw
 * `Timeout waiting for browser service socket` on an otherwise-healthy daemon. A
 * browser start/navigate then failed intermittently and self-healed on the next
 * try. 15s comfortably spans a restart; the stable-probe requirement below is
 * what keeps a socket that "appears and is immediately destroyed" (#556) from
 * being mistaken for a ready daemon.
 */
const SOCKET_WAIT_TIMEOUT_MS = 15_000;

/**
 * Consecutive successful probes required before {@link waitForBrowserService} declares
 * the service ready. A single accept can land in the sliver between a restarting
 * server binding and tearing back down; requiring two accepts ~100ms apart means
 * we only return once the daemon is *staying* up, so the caller's real request
 * doesn't race a restart it happened to probe mid-flight.
 */
const SOCKET_WAIT_STABLE_PROBES = 2;

/**
 * How long a single {@link probeBrowserServiceResponsive} attempt waits for the service to
 * answer a trivial `version` request before giving up (PHNX-3411).
 *
 * A unix-socket `connect` succeeds at the KERNEL level the moment the connection
 * is queued in the listen backlog — it does NOT require the server's event loop
 * to run. So a daemon whose event loop is blocked (e.g. a long synchronous burst
 * on the shared loop) still passes {@link isBrowserServiceReachable}: the socket accepts,
 * but the request is never serviced. The live symptom on zion was exactly this —
 * `browser.sock` accepted every connection while the daemon re-indexed sessions,
 * then never replied, so cross-device browser drives hung or surfaced a confusing
 * bare socket timeout. Requiring an actual reply is the only probe that tells a
 * healthy daemon apart from a wedged one.
 */
const RESPONSIVENESS_PROBE_TIMEOUT_MS = 1_500;

/**
 * Consecutive missed {@link probeBrowserServiceResponsive} attempts before a *reachable*
 * daemon is declared wedged. One missed reply can be a transient GC pause on an
 * otherwise-healthy loop, so a single failure never condemns the daemon; a daemon
 * that cannot answer a trivial `version` request across this whole window has a
 * genuinely blocked event loop. The added latency (attempts × timeout) is paid
 * ONLY on the wedged path — where the alternative was an indefinite hang — while
 * a healthy daemon answers the first attempt in ~1ms.
 */
const RESPONSIVENESS_PROBE_ATTEMPTS = 3;

export interface IPCRequestOptions {
  autoStartDaemon?: boolean;
}

type PendingIPCResponse = {
  resolve: (response: IPCResponse) => void;
  reject: (error: Error) => void;
};

export class BrowserServiceNotRunningError extends Error {
  constructor() {
    super(formatBrowserServiceNotRunningError());
    this.name = 'BrowserServiceNotRunningError';
  }
}

export function formatBrowserServiceNotRunningError(
  daemonRunning: boolean = isDaemonRunning(),
): string {
  return [
    'Browser service is not running.',
    `Shared daemon: ${daemonRunning ? 'running (other services are unaffected)' : 'stopped'}.`,
    'Start it with: agents browser start (enables only the browser-ipc service and uses this machine\'s configured default browser)',
    'Pick / pin a profile: agents browser use <name>  (or: agents browser start --profile <name>)',
    'List profiles: agents browser profiles list',
  ].join('\n');
}

export function getSocketPath(): string {
  return path.join(getHelpersDir(), 'browser', SOCKET_NAME);
}

/**
 * The address the daemon actually listens on / clients connect to: the unix
 * socket file on POSIX, a `\\.\pipe\` named pipe on Windows. `getSocketPath`
 * stays the canonical key (and the POSIX socket path); on Windows it's only used
 * to derive a stable pipe name, never touched on disk.
 */
function getIpcEndpoint(): string {
  return ipcEndpoint(getSocketPath());
}

/** Can we open a connection to the daemon right now? Resolves false on any
 * error. This is the authoritative liveness check on every platform: a live
 * daemon accepts the connection, while a stale POSIX socket file left behind by
 * a crashed daemon (or one that "appears and is immediately destroyed", #556)
 * rejects with ECONNREFUSED and is correctly reported as not reachable —
 * something fs.existsSync can't distinguish. */
function probeBrowserService(endpoint: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); finish(true); });
    sock.on('error', () => { clearTimeout(timer); finish(false); });
  });
}

/** Is the daemon reachable? A real connect probe on every platform — a socket
 * file existing on disk is not proof a daemon is listening on it. */
export async function isBrowserServiceReachable(): Promise<boolean> {
  return probeBrowserService(getIpcEndpoint());
}

/**
 * Can the daemon actually REPLY right now? Opens a connection and requires a
 * parseable response to a `version` request within `timeoutMs`. Unlike
 * {@link probeBrowserService} (which resolves on the kernel-level `connect`), this only
 * succeeds when the daemon's event loop is running and services the request — so
 * it is the one probe that distinguishes a healthy daemon from a wedged one whose
 * loop is blocked (PHNX-3411). Resolves false on connect error, timeout, an early
 * close, or an unparseable reply. `version` is the right probe: its handler is
 * trivial and synchronous (never touches the browser), so a slow reply means the
 * loop is blocked, not that a real action is in flight.
 */
function probeBrowserServiceResponsive(endpoint: string, timeoutMs = RESPONSIVENESS_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    let buffer = '';
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on('connect', () => { sock.write(JSON.stringify({ action: 'version' }) + '\n'); });
    sock.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx === -1) return;
      try {
        const resp = JSON.parse(buffer.slice(0, idx)) as IPCResponse;
        finish(resp.ok === true);
      } catch {
        finish(false);
      }
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}

/**
 * Is a *reachable* daemon actually responsive, or is its event loop wedged
 * (PHNX-3411)? Retries {@link probeBrowserServiceResponsive} up to
 * {@link RESPONSIVENESS_PROBE_ATTEMPTS} times so a single transient miss (a GC
 * pause) never condemns a healthy daemon; returns true as soon as any attempt
 * gets a reply, and false only when every attempt fails.
 */
export async function isBrowserServiceResponsive(
  endpoint: string = getIpcEndpoint(),
  attempts: number = RESPONSIVENESS_PROBE_ATTEMPTS,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probeBrowserServiceResponsive(endpoint)) return true;
  }
  return false;
}

/**
 * Wait until the browser service is genuinely reachable, or throw.
 *
 * Re-probes across the whole window rather than latching on the first accept, so
 * it survives an IPC-server restart that happens mid-wait (PHNX-3289): a restart
 * just resets the consecutive-accept counter, and the loop keeps going until the
 * daemon is *stably* up or the deadline passes. Bounded and fail-loud — a daemon
 * that never comes up throws a message naming the endpoint and the budget, never
 * a silent hang.
 */
export async function waitForBrowserService(
  _socketPath: string,
  timeoutMs: number = SOCKET_WAIT_TIMEOUT_MS,
): Promise<void> {
  const endpoint = getIpcEndpoint();
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    if (await probeBrowserService(endpoint)) {
      consecutive += 1;
      if (consecutive >= SOCKET_WAIT_STABLE_PROBES) return;
    } else {
      // A dropped probe means a restart (or the daemon isn't up yet) — start the
      // stability count over rather than counting accepts from before the gap.
      consecutive = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timeout waiting for browser service socket after ${Math.round(timeoutMs / 1000)}s (${endpoint}).`,
  );
}

/** Outcome of {@link stopBrowserService} — what the service-scoped stop did. */
export interface BrowserServiceStopResult {
  /** The browser IPC service was reachable before the stop was requested. */
  wasRunning: boolean;
  /** The shared daemon stayed running while only browser IPC was stopped. */
  daemonRunning: boolean;
  /** A leftover `browser.sock` file was unlinked (POSIX only). */
  socketCleared: boolean;
}

/** How long {@link stopBrowserService} waits for the endpoint to go quiet after
 * signalling the daemon-owned service transition. Bounded so a wedged daemon
 * fails loud instead of leaving the client hung on a control request. */
const SERVICE_STOP_QUIESCE_MS = 5_000;

/**
 * Stop only the daemon-hosted browser IPC service so a subsequent `start` comes
 * up clean (PHNX-3605). The short-lived browser client persists the
 * `browser-ipc` service off and asks the daemon to apply that transition over
 * its existing SIGHUP control path. It never stops or restarts the shared
 * supervisor, so routines, usage sync, secrets, and every sibling service keep
 * their process and in-flight work.
 *
 * Once the endpoint is quiet, a stale socket left by a hard-crashed browser
 * service is removed. If the daemon event loop itself is wedged and cannot
 * consume SIGHUP, the endpoint remains reachable and this fails loud with the
 * deliberate operator-owned whole-daemon restart command; the client never
 * escalates into that process-wide action itself.
 */
export async function stopBrowserService(): Promise<BrowserServiceStopResult> {
  const endpoint = getIpcEndpoint();
  const wasRunning = await probeBrowserService(endpoint);
  const daemonRunning = isDaemonRunning();

  setDaemonServiceEnabled('browser-ipc', false);
  if (daemonRunning && !signalDaemonReload()) {
    throw new Error(
      actionable(
        'Browser service stop could not be delivered to the shared daemon.',
        `Endpoint: ${endpoint}`,
        'Next: agents daemon restart   (operator-owned recovery when SIGHUP is unavailable)',
      ),
    );
  }

  // Wait for the listener to actually release the endpoint. We must decide
  // reachability BEFORE touching the socket file: unlinking a path out from
  // under a live server makes new connects ENOENT (so it would *look* cleared)
  // while the server keeps running — the two-servers orphan the eviction
  // protocol exists to prevent. So a still-reachable endpoint fails loud here,
  // and only a genuinely dead one gets its stale file removed below.
  const deadline = Date.now() + SERVICE_STOP_QUIESCE_MS;
  let reachable = wasRunning;
  while (reachable && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    reachable = await probeBrowserService(endpoint);
  }

  if (reachable) {
    throw new Error(
      actionable(
        'Browser service is still reachable after its stop request — the shared daemon did not apply the transition.',
        `Endpoint: ${endpoint}`,
        'Next: agents daemon restart   (operator-owned recovery for a wedged daemon event loop)',
      ),
    );
  }

  // Nothing is listening now — clear the leftover socket file a hard-crashed
  // daemon left behind, so the next `start` binds clean instead of unlinking it
  // blindly. (Named pipes vanish with their owning process, so Windows has no
  // stale file to clear.)
  const socketCleared = IS_WINDOWS ? false : await clearDeadSocketFile(endpoint, getSocketPath());

  return { wasRunning, daemonRunning, socketCleared };
}

/**
 * Remove a leftover browser socket FILE, but only when nothing is listening on
 * it — re-probing liveness IMMEDIATELY before the unlink to close the TOCTOU
 * window (PHNX-3289 review). Between {@link stopBrowserService}'s quiesce loop
 * deciding the endpoint was unreachable and this unlink, a concurrent
 * `browser start` could bind a NEW listener on the same path; an unconditional
 * unlink would then delete a LIVE daemon's socket — the exact two-servers orphan
 * this function exists to prevent. A listener seen here means the wedge is already
 * resolved (a fresh daemon owns the path), so its socket is left intact. Returns
 * true only when a genuinely dead file was removed.
 */
export async function clearDeadSocketFile(endpoint: string, socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;
  // A listener bound again since the quiesce loop → do not touch its socket.
  if (await probeBrowserService(endpoint)) return false;
  try {
    fs.unlinkSync(socketPath);
    return true;
  } catch {
    // Raced with a fresh start that already claimed it — the goal (no stale
    // socket) still holds, so report cleared only when it is genuinely gone.
    return !fs.existsSync(socketPath);
  }
}

/**
 * One long-lived connection to the existing browser service. Requests are
 * serialized so the daemon's newline-delimited responses always map to the
 * caller that produced them, while the process and socket stay warm between
 * actions.
 */
export class BrowserIPCConnection {
  private buffer = '';
  private pending: PendingIPCResponse | undefined;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.on('data', (data) => this.handleData(data));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      this.fail(new Error('Browser service connection closed'));
    });
  }

  request(request: IPCRequest): Promise<IPCResponse> {
    const stamped = stampCallerIdentity(request);
    const result = this.tail.then(() => this.requestOnce(stamped));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    await this.tail;
    if (this.closed || this.socket.destroyed) return;

    await new Promise<void>((resolve) => {
      this.socket.once('close', resolve);
      this.socket.end();
    });
  }

  private requestOnce(request: IPCRequest): Promise<IPCResponse> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error('Browser service connection is closed'));
    }

    return new Promise<IPCResponse>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        if (this.pending?.reject === reject) this.pending = undefined;
        reject(error);
      });
    });
  }

  private handleData(data: Buffer | string): void {
    this.buffer += data.toString();

    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index === -1) return;

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;

      const pending = this.pending;
      if (!pending) {
        this.socket.destroy();
        this.fail(new Error('Browser service sent an unexpected response'));
        return;
      }

      this.pending = undefined;
      try {
        pending.resolve(JSON.parse(line) as IPCResponse);
      } catch {
        const error = new Error('Browser service returned invalid JSON');
        pending.reject(error);
        this.socket.destroy();
        this.fail(error);
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

export class BrowserIPCServer {
  private server: net.Server | null = null;
  /** Filesystem identity of the POSIX binding this server created. */
  private socketIdentity: SocketIdentity | null = null;
  private service: BrowserService;
  /** Live client connections, so {@link stop} can end them rather than wait. */
  private connections = new Set<net.Socket>();
  /** In-flight stop, so a second SIGTERM awaits the same close, never skips it. */
  private stopping: Promise<void> | null = null;
  constructor(service: BrowserService) {
    this.service = service;
  }

  async start(): Promise<void> {
    const socketPath = getSocketPath();
    const endpoint = getIpcEndpoint();
    const socketDir = path.dirname(socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

    if (!IS_WINDOWS) {
      fs.chmodSync(socketDir, 0o700);
      // Remove a stale unix socket from a prior crash. (Named pipes are not
      // filesystem objects and vanish with their owning process.)
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    }

    this.server = net.createServer((socket) => {
      // `net.Server.close()` stops accepting but does not complete until every
      // EXISTING connection ends, and clients here hold one open on purpose
      // ("the process and socket stay warm between actions"). Tracking them is
      // what lets stop() end them deliberately instead of waiting out a timeout.
      this.connections.add(socket);
      socket.on('close', () => this.connections.delete(socket));

      let buffer = '';

      socket.on('data', async (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const request = JSON.parse(line) as IPCRequest;
            const response = await this.handleRequest(request);
            socket.write(JSON.stringify(response) + '\n');
          } catch (err) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            socket.write(JSON.stringify({ ok: false, error }) + '\n');
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected
      });
    });

    return new Promise((resolve, reject) => {
      if (IS_WINDOWS) {
        // Windows named pipe: no umask/chmod — filesystem perms don't apply and
        // pipe ACLs default to the creating user.
        this.server!.listen(endpoint, () => resolve());
        this.server!.on('error', (err) => reject(err));
        return;
      }
      // Lock down the browser socket dir before opening the socket; on macOS
      // the parent dir is the real local-user boundary for AF_UNIX sockets.
      const prevUmask = process.umask(0o077);
      let restored = false;
      const restoreUmask = () => {
        if (restored) return;
        restored = true;
        process.umask(prevUmask);
      };
      this.server!.listen(socketPath, () => {
        try {
          fs.chmodSync(socketPath, 0o600);
          this.socketIdentity = readSocketIdentity(socketPath);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          restoreUmask();
        }
      });
      this.server!.on('error', (err) => {
        restoreUmask();
        reject(err);
      });
    });
  }

  /**
   * Stop accepting, release the binding, and only then resolve.
   *
   * RUSH-2421: this used to call `server.close()` and move on. `close()` is
   * asynchronous — it stops accepting immediately but the binding is not
   * actually released until the `'close'` event fires — so `stop()` resolved
   * while the socket (or named pipe) was still held. The daemon's
   * `handleShutdown` awaits this before it exits, and a successor's
   * `claimDaemonInstance` waits for that exit as its proof the predecessor's
   * resources are free (SING-11). Resolving early made that proof false: the
   * newcomer could bind before the incumbent's binding was gone, which is the
   * two-servers-on-one-socket orphan the eviction protocol exists to prevent.
   *
   * The first version of this waited out a timeout instead, and that made every
   * graceful daemon stop escalate to `killTree`: `close()` does not complete
   * while a connection is open, browser clients hold one open on purpose, and
   * the timeout was set equal to the daemon's own SIGTERM grace window
   * (`STOP_GRACE_MS`) — so `handleShutdown` was still inside `stop()` when
   * `stopDaemon` gave up waiting and killed it. So we END the connections
   * rather than wait for them: `close()` stops accepting, destroying the
   * tracked sockets lets it complete, and the timeout is only a backstop for a
   * socket that will not die, deliberately far below `STOP_GRACE_MS`.
   */
  async stop(): Promise<void> {
    // A second SIGTERM must await the SAME stop, not skip past it because
    // `this.server` was already nulled by the first.
    if (!this.stopping) this.stopping = this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    const socketPath = getSocketPath();
    const owned = this.socketIdentity;
    let preservedReplacement: string | null = null;

    if (!IS_WINDOWS && owned && readSocketIdentity(socketPath) && !isSameSocket(socketPath, owned)) {
      // Node/libuv remembers the pathname passed to listen() and unlinks that
      // pathname during server.close(). If a successor has already replaced the
      // directory entry, an inode check AFTER close is too late: libuv has
      // deleted the successor. Move the replacement aside for the close and put
      // it back before returning. The listening socket stays live across rename.
      preservedReplacement = `${socketPath}.preserved-${process.pid}-${Date.now()}`;
      fs.renameSync(socketPath, preservedReplacement);
    }

    try {
      await this.closeServer();
    } finally {
      if (preservedReplacement && fs.existsSync(preservedReplacement) && !fs.existsSync(socketPath)) {
        fs.renameSync(preservedReplacement, socketPath);
      }
    }

    if (!IS_WINDOWS) {
      this.socketIdentity = null;
      if (owned && isSameSocket(socketPath, owned)) {
        fs.unlinkSync(socketPath);
      }
    }

    await this.service.shutdown();
  }

  /** Release the listening binding, resolving only once it is genuinely gone. */
  private closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); resolve(); };
      // Backstop only, for a socket that refuses to die. Far below the daemon's
      // SIGTERM grace window so a slow close can never be what gets the daemon
      // killed — the whole point is that the graceful path stays graceful.
      const timer = setTimeout(done, IPC_CLOSE_TIMEOUT_MS);
      // `close()` reports an error when the server was never listening —
      // nothing to release, so that is a completed close, not a failure.
      server.close(() => done());
      // `close()` waits for existing connections; ending them is what lets it
      // finish now instead of at the timeout.
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
    });
  }

  /**
   * Resolve `request.task` from caller identity when omitted. Page verbs may
   * create; done/stop never create. Returns an error response to short-circuit
   * the action, or undefined when the request is ready (task filled in).
   */
  private async bindTask(
    request: IPCRequest,
  ): Promise<IPCResponse | undefined> {
    const createIfMissing = PAGE_CREATE_VERBS.has(request.action);
    const isClose = CLOSE_VERBS.has(request.action);

    // stop with --profile only (no task) is handled by the stop case itself.
    if (request.action === 'stop' && request.profile && !request.task) return undefined;

    try {
      const resolved = await this.service.resolveOrCreateTask({
        task: request.task,
        profile: request.profile,
        actor: request.actor,
        launchId: request.launchId,
        sessionId: request.sessionId,
        fleetRemote: request.fleetRemote,
        createIfMissing,
        title: request.title,
        url: request.url,
      });
      if (!resolved) {
        if (isClose) {
          return { ok: true, message: 'nothing to close' };
        }
        return {
          ok: false,
          error: actionable(
            'No browser task for this session.',
            'Next: agents browser navigate <url>  |  agents browser start',
          ),
        };
      }
      request.task = resolved.task.name;
      if (resolved.created && resolved.picked) {
        (request as IPCRequest & { picked?: string }).picked = resolved.picked;
      }
      return undefined;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleRequest(request: IPCRequest): Promise<IPCResponse> {
    if ((request.action as string) === 'upload-stage') {
      const source = (request as IPCRequest & { source?: string }).source;
      if (!source) {
        return { ok: false, error: 'Source required' };
      }
      const result = this.service.stageUpload(source);
      return { ok: true, path: result.path };
    }

    // Task-scoped actions: resolve identity / create / refuse once here.
    if (PAGE_RESOLVE_VERBS.has(request.action) || CLOSE_VERBS.has(request.action)) {
      const early = await this.bindTask(request);
      if (early) return early;
    }

    switch (request.action) {
      case 'version': {
        return { ok: true, version: getCliVersion() };
      }

      // On-demand self-update, triggered by a client that noticed version
      // skew (reconcileDaemonVersion below). Runs the exact same fail-closed
      // check/install/verify path SelfUpdateService's periodic tick runs — no
      // duplicated logic — just off-schedule. The client must get its
      // response before the process exits, or it hangs on a closing socket,
      // so the exit (only on a verified update) is scheduled AFTER this
      // handler returns and the caller has written the response to the
      // socket (BrowserIPCServer's `socket.write` right after `handleRequest`
      // resolves) — a short setTimeout, not setImmediate, to give the actual
      // OS-level socket write time to flush before the process ends.
      case 'request-self-update': {
        const controller = new AbortController();
        const outcome = await attemptSelfUpdateAndExit({ log: daemonLog }, controller.signal);
        if (outcome.updated) {
          setTimeout(() => process.exit(0), 250);
        }
        return { ok: true, updated: outcome.updated, reason: outcome.reason };
      }

      case 'show': {
        // Task-less by design — see BrowserService.showUrl. Absent from both
        // PAGE_CREATE_VERBS and PAGE_RESOLVE_VERBS, so bindTask never ran above
        // and this request carries no task.
        if (!request.url) {
          return { ok: false, error: actionable('URL required.', 'Next: agents browser navigate <url>') };
        }
        if (!request.profile) {
          return { ok: false, error: actionable('Profile required.', 'Next: agents browser profiles list') };
        }
        const shown = await this.service.showUrl(request.profile, request.url, {
          fleetRemote: request.fleetRemote,
          actor: request.actor,
        });
        return { ok: true, tabId: shown.tabId, message: shown.picked };
      }

      case 'start': {
        if (!request.profile) {
          return { ok: false, error: actionable('Profile required.', 'Next: agents browser profiles list') };
        }
        const result = await this.service.start(request.profile, {
          taskName: request.taskName,
          url: request.url,
          endpointName: request.endpoint,
          skipDomainSkill: request.skipDomainSkill,
          fresh: request.fresh,
          actor: request.actor,
          launchId: request.launchId,
          sessionId: request.sessionId,
          fleetRemote: request.fleetRemote,
          title: request.title,
        });
        return {
          ok: true,
          task: result.name,
          tabId: result.tabId,
          windowTargetId: result.windowId,
          skill: result.skill,
          message: result.picked,
        };
      }

      // The out-of-process seam onto the abandoned-task reaper: the daemon
      // owns the live BrowserService, so a CLI verb (`agents browser prune`) can
      // only reach `reapAbandoned` through IPC. The daemon's own periodic tick
      // calls the service method directly.
      case 'gc': {
        // 0 is the "disable idle reaping" signal (browser.task-idle-minutes),
        // not a zero-ms window — translate it to reapAbandoned's `null` rather
        // than let it hit the idleMs<=0 guard. Omitting the flag falls back to
        // this box's own configured default (or 30 minutes when unset).
        const idleMs =
          request.idleMinutes !== undefined
            ? (request.idleMinutes === 0 ? null : request.idleMinutes * 60_000)
            : resolveBrowserTaskIdleMs();
        const reaped = await this.service.reapAbandoned({ idleMs, dryRun: request.dryRun });
        return { ok: true, reaped };
      }

      case 'done': {
        if (!request.task) {
          return { ok: true, message: 'nothing to close' };
        }
        const result = await this.service.done(request.task);
        return {
          ok: result.ok,
          error: result.ok
            ? undefined
            : actionable(
                `Task "${request.task}" not found.`,
                'Next: agents browser status',
              ),
          task: result.ok ? request.task : undefined,
        };
      }

      case 'stop': {
        if (request.task) {
          const result = await this.service.stop(request.task);
          return {
            ok: result.ok,
            error: result.ok
              ? undefined
              : actionable(
                  `Task "${request.task}" not found.`,
                  'Next: agents browser status',
                ),
            task: result.ok ? request.task : undefined,
          };
        }
        if (request.profile) {
          try {
            await this.service.stopProfile(request.profile, {
              fleetRemote: request.fleetRemote,
              actor: request.actor,
            });
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          return { ok: true };
        }
        return {
          ok: false,
          error: actionable(
            'Task or profile required.',
            'Next: agents browser status  |  agents browser stop --profile <name>',
          ),
        };
      }

      case 'status': {
        const profiles = await this.service.status(request.profile);
        return { ok: true, profiles };
      }

      case 'history': {
        const history = await this.service.getHistory(request.limit ?? 10);
        return { ok: true, history };
      }

      case 'navigate': {
        if (!request.url) {
          return {
            ok: false,
            error: actionable(
              'URL required.',
              'Next: agents browser navigate <url>',
            ),
          };
        }
        if (!request.task) {
          return {
            ok: false,
            error: actionable(
              'No browser task for this session.',
              'Next: agents browser navigate <url>  |  agents browser start',
            ),
          };
        }
        const result = await this.service.navigate(
          request.task,
          request.url,
          request.profile
        );
        const picked = (request as IPCRequest & { picked?: string }).picked;
        return { ok: true, tabId: result.tabId, task: request.task, message: picked };
      }

      case 'tab-add': {
        if (!request.task || !request.url) {
          return { ok: false, error: 'Task and URL required' };
        }
        const result = await this.service.tabAdd(request.task, request.url, request.profile);
        return { ok: true, tabId: result.tabId };
      }

      case 'tab-focus': {
        if (!request.task || !request.tabId) {
          return { ok: false, error: 'Task and tabId required' };
        }
        const result = await this.service.tabFocus(request.task, request.tabId);
        return { ok: true, tabId: result.tabId };
      }

      case 'tab-close': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.tabClose(request.task, request.tabId);
        return { ok: true };
      }

      case 'tab-list': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const tabs = await this.service.tabList(request.task);
        return { ok: true, tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, task: request.task! })) };
      }

      case 'evaluate': {
        if (!request.task || !request.expr) {
          return { ok: false, error: 'Task and expression required' };
        }
        const result = await this.service.evaluate(
          request.task,
          request.tabId,
          request.expr
        );
        return { ok: true, result };
      }

      case 'record-start': {
        if (!request.task) return { ok: false, error: 'Task required' };
        try {
          const r = await this.service.recordStart(request.task, request.tabId, {
            fps: request.fps,
            duration: request.duration,
            maxMb: request.maxMb,
          });
          return { ok: true, path: r.path, fps: r.fps, durationCapSec: r.durationCapSec, maxMb: r.maxMb };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'record-stop': {
        if (!request.task) return { ok: false, error: 'Task required' };
        try {
          const r = await this.service.recordStop(request.task);
          return { ok: true, path: r.path, bytes: r.bytes, durationMs: r.durationMs, stopReason: r.reason as 'manual' | 'duration-cap' | 'size-cap' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'screenshot': {
        if (!request.task) {
          return {
            ok: false,
            error: actionable(
              'No browser task for this session.',
              'Next: agents browser navigate <url>  |  agents browser start',
            ),
          };
        }
        const shot = await this.service.screenshot(
          request.task,
          request.tabId,
          request.path,
          request.quality
        );
        return {
          ok: true,
          path: shot.path,
          bytes: shot.bytes,
          width: shot.width,
          height: shot.height,
          task: request.task,
        };
      }

      case 'pdf': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const doc = await this.service.printToPdf(
          request.task,
          request.tabId,
          request.path
        );
        return { ok: true, path: doc.path, bytes: doc.bytes };
      }

      case 'refs': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const { refs, nodeMap } = await this.service.refs(request.task, request.tabId, {
          interactive: request.interactive ?? true,
          limit: request.limit ?? 500,
        });
        const nodes: RefNodeJson[] = Array.from(nodeMap.values()).map(n => {
          const entry: RefNodeJson = { ref: n.ref, role: n.role, name: n.name, attrs: n.attrs };
          if (n.editor !== undefined) entry.editor = n.editor;
          return entry;
        });
        return { ok: true, refs, nodes };
      }

      case 'click': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        // Coordinate click (`--at X,Y`) bypasses ref resolution entirely.
        if (request.atX !== undefined && request.atY !== undefined) {
          await this.service.clickAt(request.task, request.atX, request.atY, request.tabId);
          return { ok: true };
        }
        if (request.ref === undefined) {
          return { ok: false, error: 'Task and ref (or --at X,Y) required' };
        }
        const { healed } = await this.service.click(request.task, request.ref, request.tabId);
        if (healed) {
          return {
            ok: true,
            message: `self-healed ref ${healed.from} -> ${healed.to} (${healed.role} "${healed.name}")`,
          };
        }
        return { ok: true };
      }

      case 'type': {
        if (!request.task || request.ref === undefined || !request.text) {
          return { ok: false, error: 'Task, ref, and text required' };
        }
        await this.service.type(request.task, request.ref, request.text, request.tabId, request.clear);
        return { ok: true };
      }

      case 'press': {
        if (!request.task || !request.key) {
          return { ok: false, error: 'Task and key required' };
        }
        await this.service.press(request.task, request.key, request.tabId);
        return { ok: true };
      }

      case 'hover': {
        if (!request.task || request.ref === undefined) {
          return { ok: false, error: 'Task and ref required' };
        }
        await this.service.hover(request.task, request.ref, request.tabId);
        return { ok: true };
      }

      case 'scroll': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        await this.service.scroll(
          request.task,
          request.scrollX ?? 0,
          request.scrollY ?? 0,
          request.scrollAtX,
          request.scrollAtY,
          request.tabId
        );
        return { ok: true };
      }

      case 'set-viewport': {
        if (!request.task || !request.width || !request.height) {
          return { ok: false, error: 'Task, width, and height required' };
        }
        await this.service.setViewport(request.task, request.width, request.height, {
          mobile: request.mobile,
          deviceScaleFactor: request.deviceScaleFactor,
          tabHint: request.tabId,
        });
        return { ok: true };
      }

      case 'set-device': {
        if (!request.task || !request.deviceName) {
          return { ok: false, error: 'Task and device name required' };
        }
        await this.service.setDevice(request.task, request.deviceName, request.tabId);
        return { ok: true };
      }

      case 'console': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const logs = await this.service.getConsoleLogs(request.task, {
          level: request.level,
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, logs };
      }

      case 'errors': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const errors = await this.service.getErrors(request.task, {
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, errors };
      }

      case 'requests': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const requests = await this.service.getNetworkRequests(request.task, {
          filter: request.filter,
          clear: request.clear,
          tabHint: request.tabId,
        });
        return { ok: true, requests };
      }

      case 'response-body': {
        if (!request.task || !request.urlPattern) {
          return { ok: false, error: 'Task and URL pattern required' };
        }
        const body = await this.service.getResponseBody(request.task, request.urlPattern, {
          timeout: request.timeout,
          maxChars: request.maxChars,
          tabHint: request.tabId,
        });
        return { ok: true, body };
      }

      case 'wait': {
        if (!request.task || !request.waitType || request.waitValue === undefined) {
          return { ok: false, error: 'Task, wait type, and wait value required' };
        }
        await this.service.wait(request.task, request.waitType, request.waitValue, {
          timeout: request.timeout,
          tabHint: request.tabId,
        });
        return { ok: true };
      }

      case 'set-download-path': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        // downloadPath optional: omitted → service defaults to the profile's downloads dir.
        const resolved = await this.service.setDownloadPath(request.task, request.downloadPath, request.tabId);
        return { ok: true, downloadPath: resolved };
      }

      case 'wait-download': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const downloadPath = await this.service.waitForDownload(request.task, request.timeout);
        return { ok: true, downloadPath };
      }

      case 'getAppLogs': {
        if (!request.task) {
          return { ok: false, error: 'Task required' };
        }
        const appLogs = await this.service.getAppLogs(request.task, {
          lines: request.lines,
          level: request.appLevel,
          filter: request.filter,
          message: request.message,
          source: request.source,
          since: request.since,
          until: request.until,
        });
        return { ok: true, appLogs };
      }

      case 'upload': {
        if (!request.task || !request.files || request.files.length === 0) {
          return { ok: false, error: 'Task and at least one file required' };
        }
        const result = await this.service.upload(request.task, request.files, {
          ref: request.ref,
          trigger: request.trigger,
          mode: request.uploadMode,
          tabHint: request.tabId,
          timeout: request.timeout,
        });
        return { ok: true, uploadMode: result.mode };
      }

      default:
        return { ok: false, error: `Unknown action: ${request.action}` };
    }
  }
}

let versionReconciledThisProcess = false;

/**
 * Decide whether a running daemon is stale enough to name an operator refresh.
 *
 * FORWARD ONLY: recommend a refresh when the daemon is *older* than this CLI.
 * An older CLI rides a newer daemon without noise. A client never performs the
 * refresh itself — two installs sharing one daemon dir (keyed off $HOME) must
 * not flap the daemon or interrupt one another's hosted services.
 *
 * `undefined`/`'unknown'` means the daemon is too old to answer the `version`
 * action reliably — don't recommend an action on that ambiguous signal.
 *
 * When numeric compare cannot order two distinct strings (e.g. two
 * `0.0.0-dev.*` builds), surface the mismatch without deciding either client
 * owns the shared process.
 */
export function shouldRecommendDaemonRefresh(
  daemonVersion: string | undefined,
  clientVersion: string
): boolean {
  if (!daemonVersion || daemonVersion === 'unknown') return false;
  if (daemonVersion === clientVersion) return false;
  const cmp = compareVersions(daemonVersion, clientVersion);
  if (cmp < 0) return true; // daemon older than client → upgrade forward
  if (cmp > 0) return false; // daemon newer → older CLI rides it
  // cmp === 0 but strings differ (unorderable tails like 0.0.0-dev.abc)
  return true;
}

/**
 * Reconcile the running daemon's version with ours without evicting it. If the
 * daemon is serving stale code, ask the daemon to run its OWN self-update path
 * (`request-self-update`, same fail-closed check/install/verify/exit
 * SelfUpdateService's periodic tick runs, self-update-service.ts) rather than
 * telling a human to run `agents daemon restart` by hand. A browser client
 * still owns neither the shared supervisor nor its sibling services, so
 * version skew can never be permission for THIS client to stop or restart
 * that process directly (PHNX-3605 holds) — it only asks the daemon to run a
 * path the daemon already runs on its own schedule, which only exits once the
 * daemon itself has verified the new version is good. If self-update declines
 * (dev build, shadowed install, already current, or a real failure) this
 * degrades to the same "nothing changed" outcome PHNX-3605 shipped.
 */
async function reconcileDaemonVersion(): Promise<void> {
  if (versionReconciledThisProcess) return;
  versionReconciledThisProcess = true;

  let daemon: string | undefined;
  try {
    const resp = await sendRawIPCRequest({ action: 'version' }, { autoStartDaemon: false });
    daemon = resp.version;
  } catch {
    // Daemon unreachable or too old to speak 'version' — leave it alone.
    return;
  }

  const client = getCliVersion();
  if (!shouldRecommendDaemonRefresh(daemon, client)) return;

  process.stderr.write(
    `\nBrowser service is running on shared daemon ${daemon}, while this CLI is ${client}. `
      + 'Asking the daemon to self-update (verify-then-exit; the OS supervisor relaunches it onto the new code)...\n',
  );
  try {
    const resp = await sendRawIPCRequest({ action: 'request-self-update' }, { autoStartDaemon: false });
    if (resp.updated) {
      process.stderr.write('Daemon self-update triggered — it will restart shortly.\n\n');
    } else {
      process.stderr.write(
        `Daemon self-update did not run${resp.reason ? ` (${resp.reason})` : ''}. `
          + 'Continuing without evicting the daemon or its other services. '
          + 'To load current daemon code when it is safe to interrupt every hosted service: agents daemon restart\n\n',
      );
    }
  } catch (err) {
    process.stderr.write(
      `Could not reach the daemon to request a self-update (${err instanceof Error ? err.message : String(err)}). `
        + 'To load current daemon code when it is safe to interrupt every hosted service: agents daemon restart\n\n',
    );
  }
}

export async function sendIPCRequest(
  request: IPCRequest,
  opts: IPCRequestOptions = {}
): Promise<IPCResponse> {
  // Stamp caller identity ONCE here so the 28+ call sites don't each have to.
  // The daemon cannot resolve the caller's actor/session itself.
  const stamped = stampCallerIdentity(request);
  return sendRawIPCRequest(stamped, opts);
}

/**
 * Fill actor / launchId / sessionId from the calling process when the request
 * left them blank. Explicit values on the request always win.
 */
export function stampCallerIdentity(
  request: IPCRequest,
  env: NodeJS.ProcessEnv = process.env,
): IPCRequest {
  // The consent marker is stamped FIRST, above the identity early-return: a
  // request that already carries a full identity (every streamed request does)
  // would otherwise skip stamping entirely and reach the daemon unmarked.
  // OR-ed, never overwritten — a client may assert the marker but must not be
  // able to clear one this environment sets.
  const fleetRemote = isFleetRemoteInvocation(env) || request.fleetRemote === true;
  const marked: IPCRequest =
    request.fleetRemote === fleetRemote ? request : { ...request, fleetRemote };

  if (marked.actor && marked.launchId && marked.sessionId) return marked;
  const id = resolveCallerIdentity();
  return {
    ...marked,
    actor: marked.actor ?? id.actor,
    launchId: marked.launchId ?? id.launchId,
    sessionId: marked.sessionId ?? id.sessionId,
  };
}

/**
 * Open one connection that can serve many browser operations. This uses the
 * same daemon readiness and version-reconciliation path as sendIPCRequest;
 * only the client process and IPC socket lifetime differ.
 */
export async function connectBrowserIPC(
  opts: IPCRequestOptions = {}
): Promise<BrowserIPCConnection> {
  const autoStartDaemon = opts.autoStartDaemon ?? true;
  await prepareIPC('status', opts);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(getIpcEndpoint());

    const onError = (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (!autoStartDaemon && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) {
        reject(new BrowserServiceNotRunningError());
        return;
      }
      reject(new Error(`IPC error: ${error.message}`));
    };

    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(new BrowserIPCConnection(socket));
    });
  });
}

async function sendRawIPCRequest(
  request: IPCRequest,
  opts: IPCRequestOptions = {}
): Promise<IPCResponse> {
  const endpoint = getIpcEndpoint();
  const autoStartDaemon = opts.autoStartDaemon ?? true;

  await prepareIPC(request.action, opts);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const response = JSON.parse(buffer.slice(0, idx)) as IPCResponse;
        socket.end();
        resolve(response);
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!autoStartDaemon && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) {
        reject(new BrowserServiceNotRunningError());
        return;
      }
      reject(new Error(`IPC error: ${err.message}`));
    });

    socket.on('close', () => {
      if (!buffer.includes('\n')) {
        reject(new Error('Connection closed before response'));
      }
    });
  });
}

async function prepareIPC(
  action: IPCRequest['action'],
  opts: IPCRequestOptions
): Promise<void> {
  const socketPath = getSocketPath();
  const autoStartDaemon = opts.autoStartDaemon ?? true;

  if (!(await isBrowserServiceReachable())) {
    if (!autoStartDaemon) {
      throw new BrowserServiceNotRunningError();
    }
    const serviceEnabled = isDaemonServiceEnabled('browser-ipc');
    if (!serviceEnabled) setDaemonServiceEnabled('browser-ipc', true);

    if (!IS_WINDOWS) {
      await fs.promises.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await fs.promises.chmod(path.dirname(socketPath), 0o700);
    }
    if (isDaemonRunning()) {
      // A stopped service is enabled by the config transition. An enabled but
      // absent service is failed/parked, so request a supervised restart. Both
      // actions are daemon-owned and in-flight-gated by ServiceSupervisor.
      if (serviceEnabled) queueDaemonServiceRestart('browser-ipc');
      if (!signalDaemonReload()) {
        throw new Error(
          actionable(
            'Browser service is not running and its start request could not be delivered.',
            `Endpoint: ${getIpcEndpoint()}`,
            'Next: agents daemon restart   (operator-owned recovery when SIGHUP is unavailable)',
          ),
        );
      }
    } else {
      startDaemon();
    }
    if (!(await isBrowserServiceReachable())) {
      await waitForBrowserService(socketPath);
    }
    if (!(await isBrowserServiceReachable())) {
      throw new Error(
        actionable(
          'Failed to start browser service.',
          `Log: ${getDaemonLogPath()}`,
          'Next: agents doctor   (checks for a second agents-cli install)',
        ),
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // The socket accepts connections — but a unix-socket `connect` succeeds at the
  // kernel level even when the daemon's event loop is blocked and never services
  // the request (PHNX-3411). Require a real reply before treating the daemon as
  // usable, so a wedged daemon fails LOUD with an accurate, actionable error
  // instead of the confusing bare socket timeout / indefinite hang the browser
  // verb would otherwise hit (including inside reconcileDaemonVersion's own
  // version probe, which has no response timeout). Skipped for callers that opt
  // out of auto-start — they want the clean BrowserServiceNotRunningError instead.
  if (autoStartDaemon && !(await isBrowserServiceResponsive(getIpcEndpoint()))) {
    throw new Error(
      actionable(
        'Browser service is running but unresponsive — the shared daemon event loop is blocked, so it accepts the connection but never replies.',
        `Endpoint: ${getIpcEndpoint()}`,
        `Log: ${getDaemonLogPath()}`,
        'Next: agents browser stop --service   (stops only browser IPC; if SIGHUP cannot run, it names the operator-owned daemon recovery)',
      ),
    );
  }

  // Before serving a real request, make sure the daemon isn't running stale
  // code. Skips the internal `version` probe (avoids recursion) and callers
  // that opt out of auto-start. No-ops once reconciled or when versions match.
  if (action !== 'version' && autoStartDaemon) {
    await reconcileDaemonVersion();
  }
}
