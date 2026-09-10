/**
 * WebDriver BiDi transport for Firefox (PHNX-4043).
 *
 * Firefox dropped the Chrome DevTools Protocol in 129, so agents drive it over
 * WebDriver BiDi — a JSON-RPC protocol on a WebSocket at
 * `ws://127.0.0.1:<port>/session`. The shape mirrors the CDP driver
 * (`drivers/local.ts`): launch or attach, hand back a live client the service
 * routes every `bidi`-backend action through.
 *
 * Launch: `firefox --remote-debugging-port <port> --profile <dir> --no-remote
 * [--headless]`. `--remote-debugging-port` is what turns BiDi on; `--no-remote`
 * forces a fresh instance bound to that profile rather than handing the URL to
 * an already-running Firefox. When a Firefox already holds the profile without a
 * debug port we cannot launch a rival (Firefox is single-instance per profile),
 * so we fail loud with the exact relaunch — the same contract
 * `attachOnlyRequiredError` states for Chromium.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WSWebSocket from 'ws';
import { findBrowserPath } from '../chrome.js';
import { writeProfileRuntime, isProcessAlive } from '../runtime-state.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

/** How agents obtain a live Firefox — matches the CDP driver's launch/attach split. */
export interface FirefoxConnection {
  bidi: FirefoxBiDiClient;
  port: number;
  /** The Firefox process pid we launched, or 0 when we attached to a running one. */
  pid: number;
  /** The BiDi session id from `session.new`. */
  sessionId: string;
}

/**
 * A verb Firefox-over-BiDi cannot serve (network capture, upload, pdf, trusted
 * key input, …). Mirrors `ArcNativeCapabilityError`: the service throws it in
 * the one place the capability is missing, and the message steers the caller to
 * a Chromium-family profile that has it.
 */
export class FirefoxCapabilityError extends Error {
  constructor(public readonly capability: string, message?: string) {
    super(
      message ??
        `Firefox (WebDriver BiDi) does not support ${capability}. ` +
          `Use a Chromium-family profile (chrome/comet/chromium/brave/edge) for that capability.`,
    );
    this.name = 'FirefoxCapabilityError';
  }
}

/** A BiDi error frame carrying the protocol error + human message. */
export class FirefoxBiDiError extends Error {
  constructor(public readonly bidiError: string, message: string) {
    super(`Firefox BiDi ${bidiError}: ${message}`);
    this.name = 'FirefoxBiDiError';
  }
}

interface BiDiPending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * Minimal WebDriver BiDi client: request/response keyed by the `id` field, with
 * events drained and ignored. Deliberately shaped like `CDPClient` so the
 * service treats a Firefox connection the same way it treats a CDP one. The
 * large `maxPayload` matches CDPClient's, so a base64 screenshot of a
 * content-rich page never trips the socket's decompressed-size cap.
 */
export class FirefoxBiDiClient {
  private ws: WSWebSocket | null = null;
  private nextId = 0;
  private pending = new Map<number, BiDiPending>();
  private closed = false;

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WSWebSocket.OPEN;
  }

  async connect(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws = new WSWebSocket(url, { maxPayload: 256 * 1024 * 1024 });
      this.ws.once('open', () => resolve());
      this.ws.once('error', () => reject(new Error('WebSocket error')));
    });
    this.ws!.on('message', (data) => this.handleMessage(String(data)));
    this.ws!.on('close', () => this.handleClose());
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // BiDi frames: type 'success' | 'error' carry an `id`; type 'event' does not.
    const id = typeof msg.id === 'number' ? (msg.id as number) : undefined;
    if (id === undefined) return; // event — nothing subscribes yet.
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    if (msg.type === 'error') {
      call.reject(
        new FirefoxBiDiError(
          String(msg.error ?? 'unknown error'),
          String(msg.message ?? 'no message'),
        ),
      );
      return;
    }
    call.resolve((msg.result as Record<string, unknown>) ?? {});
  }

  private handleClose(): void {
    this.closed = true;
    for (const [, call] of this.pending) {
      call.reject(new Error('Firefox BiDi connection closed'));
    }
    this.pending.clear();
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isOpen) {
      throw new Error(
        'Firefox BiDi connection not open — the browser was likely closed externally. ' +
          'Run `agents browser stop --profile <name>` (or restart the daemon) and try again.',
      );
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: Record<string, unknown>) => void, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }
}

const BIDI_CONNECT_ATTEMPTS = 120; // 120 × 250ms ≈ 30s — cold snap Firefox first-run is slow.
const BIDI_CONNECT_INTERVAL_MS = 250;

function bidiUrl(port: number): string {
  return `ws://127.0.0.1:${port}/session`;
}

/** Open a BiDi socket + session against a port, or null when nothing is there yet. */
async function tryOpenSession(port: number): Promise<{ bidi: FirefoxBiDiClient; sessionId: string } | null> {
  const bidi = new FirefoxBiDiClient();
  try {
    await bidi.connect(bidiUrl(port));
  } catch {
    return null;
  }
  try {
    const result = await bidi.send<{ sessionId?: string }>('session.new', { capabilities: {} });
    return { bidi, sessionId: String(result.sessionId ?? '') };
  } catch (err) {
    bidi.close();
    // A live BiDi endpoint that refuses session.new is a real, surfaced failure
    // (e.g. a session already exists) — never swallow it as "nothing listening".
    throw err;
  }
}

/**
 * The loud error raised when a Firefox already holds this profile but exposes no
 * BiDi port, so agents cannot attach and must not launch a rival (Firefox is
 * single-instance per profile dir). Mirrors `attachOnlyRequiredError` in
 * `drivers/local.ts`: name the exact relaunch that makes the running instance
 * attachable. Exported so the contract is unit-testable without a real Firefox.
 */
export function firefoxAttachRequiredError(
  profile: Pick<BrowserProfile, 'name'> & { firefox?: { profileName: string } },
  port: number,
  profileDir: string,
): Error {
  return new Error(
    `Profile "${profile.name}" is a Firefox profile and nothing is serving WebDriver BiDi on ` +
      `ws://127.0.0.1:${port}/session. A Firefox is already running on this profile directory ` +
      `without a debug port, and Firefox is single-instance per profile — agents will not launch ` +
      `a second one. Quit that Firefox, then relaunch it with remote debugging on this port:\n` +
      `  firefox --remote-debugging-port ${port} --profile ${profileDir} --no-remote\n` +
      `and retry. Or close it entirely and let agents launch it headless for you.`,
  );
}

/**
 * Whether a Firefox is currently holding `profileDir`. Firefox writes a `lock`
 * symlink (POSIX: `<dir>/lock` → `<ip>:+<pid>`; macOS: `.parentlock`; Windows:
 * `parent.lock`) while the profile is open. We only treat it as held when the
 * lock resolves to a live pid, so a stale lock from a crash never wedges launch.
 */
function firefoxHoldsProfile(profileDir: string): boolean {
  const link = path.join(profileDir, 'lock');
  try {
    const target = fs.readlinkSync(link); // e.g. "127.0.0.1:+3685166"
    const pid = Number(target.split('+').pop());
    if (Number.isFinite(pid) && pid > 0) return isProcessAlive(pid);
  } catch {
    /* no POSIX lock symlink */
  }
  // macOS/Windows lock files are plain files, not symlinks with a pid. Their mere
  // presence is a weak signal (they can be stale), so we do not block on them —
  // a launch that collides fails loud below via the connect timeout instead.
  return false;
}

/**
 * Connect a Firefox profile over BiDi: attach if the port is already served,
 * otherwise launch Firefox and wait for it. Fails loud when a Firefox holds the
 * profile without a port.
 */
export async function connectFirefox(
  profile: BrowserProfile,
  key: ConnectionKey,
  port: number,
  opts: { profileDir: string; headless?: boolean } = { profileDir: '' },
): Promise<FirefoxConnection> {
  const profileDir = opts.profileDir || profile.userDataDir || '';
  if (!profileDir) {
    throw new Error(`Firefox profile "${profile.name}" has no profile directory to launch with.`);
  }

  // 1. Already serving BiDi on the port → attach (pid 0, we did not launch it).
  const attached = await tryOpenSession(port);
  if (attached) {
    return { bidi: attached.bidi, port, pid: 0, sessionId: attached.sessionId };
  }

  // 2. A Firefox holds the profile but exposes no port → fail loud (never a rival).
  if (firefoxHoldsProfile(profileDir)) {
    throw firefoxAttachRequiredError(profile, port, profileDir);
  }

  // 3. Launch our own headless Firefox bound to this profile + port.
  const binary = findBrowserPath('firefox', profile.binary);
  const headless = opts.headless ?? profile.chrome?.headless ?? true;
  const args = [
    '--remote-debugging-port',
    String(port),
    '--profile',
    profileDir,
    '--no-remote',
    ...(headless ? ['--headless'] : []),
  ];
  const child: ChildProcess = spawn(binary, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  child.unref();
  const pid = child.pid ?? 0;

  writeProfileRuntime(key, {
    pid,
    port,
    command: path.basename(binary),
    userDataDir: profileDir,
    kind: 'browser',
  });

  for (let i = 0; i < BIDI_CONNECT_ATTEMPTS; i++) {
    // A Firefox handed the URL to an already-running instance exits almost
    // immediately without ever opening the port — detect that and fail loud
    // rather than waiting out the full timeout.
    if (pid && !isProcessAlive(pid) && i > 4) {
      throw firefoxAttachRequiredError(profile, port, profileDir);
    }
    const session = await tryOpenSession(port);
    if (session) {
      return { bidi: session.bidi, port, pid, sessionId: session.sessionId };
    }
    await new Promise((r) => setTimeout(r, BIDI_CONNECT_INTERVAL_MS));
  }

  try {
    if (pid) process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  throw new Error(
    `Firefox for profile "${profile.name}" never exposed WebDriver BiDi on ` +
      `ws://127.0.0.1:${port}/session within ${(BIDI_CONNECT_ATTEMPTS * BIDI_CONNECT_INTERVAL_MS) / 1000}s. ` +
      `Check that Firefox is installed (\`${binary}\`) and that the profile directory is not locked.`,
  );
}

// ─── BiDi value (de)serialization ──────────────────────────────────────────────
//
// `script.evaluate` returns a structured RemoteValue, not a raw JS value. This
// converts the subset our verbs produce — primitives, arrays, plain objects,
// dates — back into a plain JS value, matching what a CDP `returnByValue`
// evaluate would have handed back.

type RemoteValue = { type: string; value?: unknown };

export function deserializeBidi(remote: unknown): unknown {
  if (!remote || typeof remote !== 'object') return remote;
  const rv = remote as RemoteValue;
  switch (rv.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return rv.value;
    case 'number': {
      // BiDi encodes ±Infinity / NaN as strings.
      if (rv.value === 'Infinity') return Infinity;
      if (rv.value === '-Infinity') return -Infinity;
      if (rv.value === 'NaN') return NaN;
      return rv.value;
    }
    case 'bigint':
      return typeof rv.value === 'string' ? BigInt(rv.value) : rv.value;
    case 'date':
      return rv.value;
    case 'array':
    case 'set':
      return Array.isArray(rv.value) ? rv.value.map(deserializeBidi) : [];
    case 'object':
    case 'map': {
      const out: Record<string, unknown> = {};
      if (Array.isArray(rv.value)) {
        for (const pair of rv.value as Array<[unknown, unknown]>) {
          const rawKey = pair[0];
          const key = typeof rawKey === 'string' ? rawKey : String(deserializeBidi(rawKey));
          out[key] = deserializeBidi(pair[1]);
        }
      }
      return out;
    }
    default:
      // node / regexp / window / … — no JS value to hand back.
      return undefined;
  }
}

// ─── BiDi operation helpers ────────────────────────────────────────────────────
//
// Thin wrappers over the raw protocol so the service's `bidi` branches read like
// its CDP ones. Each takes the live client and a context (BiDi's stable tab id).

/** One top-level browsing context (a tab), flattened from `browsingContext.getTree`. */
export interface BiDiContext {
  context: string;
  url: string;
}

/** Every top-level tab currently open in this Firefox. */
export async function bidiTopLevelContexts(bidi: FirefoxBiDiClient): Promise<BiDiContext[]> {
  const tree = await bidi.send<{ contexts?: Array<{ context: string; url: string }> }>(
    'browsingContext.getTree',
    {},
  );
  return (tree.contexts ?? []).map((c) => ({ context: c.context, url: c.url }));
}

/** Open a fresh tab and return its context id. */
export async function bidiCreateTab(bidi: FirefoxBiDiClient): Promise<string> {
  const created = await bidi.send<{ context: string }>('browsingContext.create', { type: 'tab' });
  return created.context;
}

/** Navigate a context and wait for the document to finish loading. */
export async function bidiNavigate(bidi: FirefoxBiDiClient, context: string, url: string): Promise<void> {
  await bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
}

/** Reload a context in place, waiting for load. */
export async function bidiReload(bidi: FirefoxBiDiClient, context: string): Promise<void> {
  await bidi.send('browsingContext.reload', { context, wait: 'complete' });
}

/** Close a tab. */
export async function bidiCloseTab(bidi: FirefoxBiDiClient, context: string): Promise<void> {
  await bidi.send('browsingContext.close', { context });
}

/** Bring a tab to the foreground (explicit focus only). */
export async function bidiActivate(bidi: FirefoxBiDiClient, context: string): Promise<void> {
  await bidi.send('browsingContext.activate', { context });
}

/**
 * Evaluate an expression in a context and return the deserialized value.
 * `awaitPromise` mirrors the CDP evaluate contract; a thrown/rejected value
 * surfaces as an Error rather than a silent undefined.
 */
export async function bidiEvaluate(
  bidi: FirefoxBiDiClient,
  context: string,
  expression: string,
): Promise<unknown> {
  const result = await bidi.send<{
    type: string;
    result?: RemoteValue;
    exceptionDetails?: { text?: string; exception?: RemoteValue };
  }>('script.evaluate', {
    expression,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none',
  });
  if (result.type === 'exception') {
    const ex = result.exceptionDetails;
    const value = ex?.exception ? deserializeBidi(ex.exception) : undefined;
    throw new Error(ex?.text || (typeof value === 'string' ? value : 'evaluate failed'));
  }
  return deserializeBidi(result.result);
}

/** Capture a screenshot of the viewport as raw bytes. `quality` is 0–1 for JPEG. */
export async function bidiScreenshot(
  bidi: FirefoxBiDiClient,
  context: string,
  format: { type: 'image/png' } | { type: 'image/jpeg'; quality: number },
): Promise<Buffer> {
  const shot = await bidi.send<{ data: string }>('browsingContext.captureScreenshot', {
    context,
    origin: 'viewport',
    format,
  });
  return Buffer.from(shot.data, 'base64');
}

/**
 * A real, trusted left click at viewport coordinates via `input.performActions`
 * — the pointer path CDP `Input.dispatchMouseEvent` gives Chromium, which Arc
 * (Apple Events) never had. The service resolves a ref to (x, y) first, exactly
 * as the CDP click path does.
 */
export async function bidiClickAt(
  bidi: FirefoxBiDiClient,
  context: string,
  x: number,
  y: number,
): Promise<void> {
  await bidi.send('input.performActions', {
    context,
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: Math.round(x), y: Math.round(y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
}
