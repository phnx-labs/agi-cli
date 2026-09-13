import type { Readable, Writable } from 'stream';
// The `ws` client, NOT the platform (undici) WebSocket: undici enforces a
// non-configurable max decompressed message size, and a CDP response carrying
// a base64 screenshot of a content-rich page blows past it — the socket dies
// with code 1006 ("Max decompressed message size exceeded") while the command
// is pending. `ws` offers no permessage-deflate by default and takes an
// explicit payload cap. (Reproduced live against a remote Edge over
// `browser --device`: fresh blank newtab passed, reused content-rich newtab
// failed on every Page.captureScreenshot.)
import WSWebSocket from 'ws';

interface CDPPipeTransport {
  read: Readable;
  write: Writable;
}

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;
type TransportKind = 'websocket' | 'pipe';

const pipeTransports = new Map<string, CDPPipeTransport>();

export function registerPipeTransport(transport: CDPPipeTransport): string {
  const id = `pipe://${process.pid}/${pipeTransports.size + 1}`;
  pipeTransports.set(id, transport);
  return id;
}

export class CDPClient {
  private ws: WSWebSocket | null = null;
  private pipe: CDPPipeTransport | null = null;
  private pipeBuffer = Buffer.alloc(0);
  private transport: TransportKind | null = null;
  private messageId = 0;
  private pending = new Map<number, PendingCall>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private pipeDataHandler: ((chunk: Buffer) => void) | null = null;
  private pipeErrorHandler: ((err: Error) => void) | null = null;
  private pipeCloseHandler: (() => void) | null = null;

  async connect(endpoint: string): Promise<void> {
    if (endpoint.startsWith('pipe://')) {
      const transport = pipeTransports.get(endpoint);
      if (!transport) {
        throw new Error('CDP pipe transport is not available in this process');
      }
      pipeTransports.delete(endpoint);
      this.connectPipe(transport);
      return;
    }

    return new Promise((resolve, reject) => {
      this.ws = new WSWebSocket(endpoint, { maxPayload: 256 * 1024 * 1024 });
      this.transport = 'websocket';

      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket error'));
      this.ws.onclose = () => this.handleClose();
      this.ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    });
  }

  connectPipe(transport: CDPPipeTransport): void {
    this.pipe = transport;
    this.transport = 'pipe';
    this.pipeBuffer = Buffer.alloc(0);

    this.pipeDataHandler = (chunk) => this.handlePipeData(chunk);
    this.pipeErrorHandler = (err) => this.handleClose(err);
    this.pipeCloseHandler = () => this.handleClose();

    transport.read.on('data', this.pipeDataHandler);
    transport.read.on('error', this.pipeErrorHandler);
    transport.read.on('close', this.pipeCloseHandler);
    transport.write.on('error', this.pipeErrorHandler);
    transport.write.on('close', this.pipeCloseHandler);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T> {
    if (!this.isOpen) {
      // Reached when the underlying browser was killed externally between
      // the daemon establishing the connection and a CDP call going out.
      // The service-layer healthcheck normally catches this on the next
      // `start`, so seeing this in the wild means a request landed against
      // an in-flight conn that just died — tell the user how to recover.
      throw new Error(
        'CDP connection not open — the browser was likely closed externally. ' +
          'Run `agents browser stop --profile <name>` (or restart the daemon) and try again.'
      );
    }

    const id = ++this.messageId;
    const message = sessionId
      ? JSON.stringify({ id, method, params, sessionId })
      : JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      if (this.transport === 'pipe') {
        this.pipe!.write.write(message + '\0');
      } else {
        this.ws!.send(message);
      }
    });
  }

  on(event: string, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pipe) {
      if (this.pipeDataHandler) this.pipe.read.off('data', this.pipeDataHandler);
      if (this.pipeErrorHandler) {
        this.pipe.read.off('error', this.pipeErrorHandler);
        this.pipe.write.off('error', this.pipeErrorHandler);
      }
      if (this.pipeCloseHandler) {
        this.pipe.read.off('close', this.pipeCloseHandler);
        this.pipe.write.off('close', this.pipeCloseHandler);
      }
      this.pipe.write.end();
      this.pipe = null;
    }
    this.transport = null;
  }

  get connected(): boolean {
    return (
      (this.ws !== null && this.ws.readyState === WSWebSocket.OPEN) ||
      (this.pipe !== null && !this.pipe.write.destroyed)
    );
  }

  get isOpen(): boolean {
    return this.connected;
  }

  private handlePipeData(chunk: Buffer): void {
    this.pipeBuffer = Buffer.concat([this.pipeBuffer, chunk]);
    let idx = this.pipeBuffer.indexOf(0);
    while (idx !== -1) {
      const frame = this.pipeBuffer.subarray(0, idx).toString('utf8');
      this.pipeBuffer = this.pipeBuffer.subarray(idx + 1);
      if (frame.length > 0) this.handleMessage(frame);
      idx = this.pipeBuffer.indexOf(0);
    }
  }

  private handleMessage(data: string): void {
    const msg = JSON.parse(data);

    if ('id' in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error.message || 'CDP error'));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ('method' in msg) {
      const handlers = this.eventHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params || {}, msg.sessionId);
        }
      }
    }
  }

  private handleClose(err?: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err ?? new Error('CDP connection closed'));
    }
    this.pending.clear();
    this.ws = null;
    this.pipe = null;
    this.transport = null;
  }
}

export interface BrowserDiscovery {
  wsUrl: string;
  browser: string;
}

export class BrowserCdpConnectionError extends Error {
  constructor(
    readonly port: number,
    readonly profileName: string = '<name>',
    readonly host = 'localhost'
  ) {
    super(formatBrowserCdpConnectionError(port, profileName, host));
    this.name = 'BrowserCdpConnectionError';
  }
}

export function formatBrowserCdpConnectionError(
  port: number,
  profileName = '<name>',
  host = 'localhost'
): string {
  const target = host === 'localhost' || host === '127.0.0.1'
    ? `port ${port}`
    : `${host}:${port}`;
  return [
    `Could not connect to Chrome on ${target}.`,
    `- Is Chrome running with --remote-debugging-port=${port}?`,
    `- Try: agents browser start --profile ${profileName}`,
  ].join('\n');
}

export async function discoverBrowserWsUrl(
  port: number,
  host = 'localhost',
  profileName = '<name>'
): Promise<BrowserDiscovery> {
  // Node's fetch has no default timeout — a port that ACKs the TCP connect
  // but never sends an HTTP response will hang here indefinitely. Bound the
  // discovery probe so the caller can surface an actionable error in seconds,
  // not minutes.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let response: Response;
  try {
    response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
  } catch {
    throw new BrowserCdpConnectionError(port, profileName, host);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new BrowserCdpConnectionError(port, profileName, host);
  }
  const data = (await response.json()) as {
    webSocketDebuggerUrl: string;
    Browser?: string;
    Product?: string;
  };
  const browserField = data.Browser || data.Product || '';
  return {
    wsUrl: data.webSocketDebuggerUrl,
    browser: normalizeBrowserName(browserField),
  };
}

export function normalizeBrowserName(s: string): string {
  if (!s) return 'unknown';
  return s.split('/')[0].trim().toLowerCase().replace(/\s+/g, '-');
}

export function verifyBrowserIdentity(
  reported: string,
  expected: string,
  port: number,
  host = 'localhost'
): void {
  if (expected === 'custom') return;
  if (reported === 'unknown') return;

  const matches: Record<string, string[]> = {
    chrome: ['chrome', 'google-chrome', 'headlesschrome'],
    chromium: ['chromium', 'headlesschrome', 'chrome'],
    // Comet reports itself as plain "Chrome/<version>" in /json/version — it
    // doesn't override the Chromium branding. Accept chrome here so attaching
    // to a Comet instance doesn't trip a false "identity mismatch".
    comet: ['comet', 'chrome'],
    // Arc reports itself as plain "Chrome/<version>" in /json/version (verified
    // live: Arc 1.15x → "Chrome/151"), so accept chrome to avoid a false
    // identity mismatch when attaching to a real Arc.
    arc: ['arc', 'chrome'],
    brave: ['brave', 'brave-browser', 'chrome'],
    // Windows/Chromium Edge reports its /json/version "Browser" field as
    // "Edg/<version>" (the `Edg` token, not `Edge`), which normalizeBrowserName
    // reduces to "edg". Accept it so attaching to a real Edge doesn't trip a
    // false identity mismatch (the profile enum only allows "edge").
    edge: ['edge', 'edg', 'microsoft-edge', 'msedge', 'chrome'],
  };

  const accepted = matches[expected] || [expected];
  if (accepted.includes(reported)) return;

  const target = host === 'localhost' || host === '127.0.0.1' ? `port ${port}` : `${host}:${port}`;
  throw new Error(
    `Browser identity mismatch: profile expects "${expected}" but ${target} is serving "${reported}". ` +
      `Stop the running browser (e.g. \`pkill -f ${reported}\`) or update the profile to browser=${reported}, then retry.`
  );
}

export async function listTargets(
  port: number,
  host = 'localhost'
): Promise<Array<{ id: string; type: string; title: string; url: string }>> {
  const response = await fetch(`http://${host}:${port}/json`);
  if (!response.ok) {
    throw new Error(`Failed to list targets: ${response.status}`);
  }
  return response.json() as Promise<Array<{ id: string; type: string; title: string; url: string }>>;
}
