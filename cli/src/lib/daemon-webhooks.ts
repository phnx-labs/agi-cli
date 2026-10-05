/** Per-box hosted webhook receivers (RUSH-2548): `~/.agents/daemon/webhooks.yaml` declares the
 * signed receivers this box hosts (bundle, port, rate limit, optional Funnel port). The
 * `webhook-receiver` service binds one per entry, reading secrets via the `secrets` CLI. */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { exec } from 'child_process';
import type { Server } from 'http';
import type { Socket } from 'net';
import { getDaemonConfigDir, getRuntimeStateDir } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { closeServerBounded } from './net-close.js';
import { readAndResolveBundleEnvSync } from './secrets-client.js';
import { startWebhookServer, createFileDeliveryStore, waitForListening, type WebhookSecrets } from './triggers/webhook.js';
import { buildFunnelUpCommand, FUNNEL_PORTS, type FunnelPort } from './funnel.js';

export const DEFAULT_WEBHOOK_PORT = 8787;
export const DEFAULT_WEBHOOK_RATE_LIMIT = 60;

/** Optional public exposure for a hosted receiver via Tailscale Funnel. */
export interface HostedReceiverFunnel {
  /** Public HTTPS port (Funnel allows 443 / 8443 / 10000). */
  publicPort: FunnelPort;
}

/** One receiver this box hosts. */
export interface HostedReceiverConfig {
  /** Secrets bundle holding GITHUB_WEBHOOK_SECRET, LINEAR_WEBHOOK_SECRET, and/or
   *  SLACK_SIGNING_SECRET (a Slack receiver also carries SLACK_BOT_TOKEN when the
   *  agent replies with the Slack Web API rather than `agents send`). */
  bundle: string;
  /** Local bind port (default 8787). */
  port?: number;
  /** Accepted deliveries per source per minute (default 60). */
  rateLimit?: number;
  /** Public Funnel exposure; omit to bind localhost only. */
  funnel?: HostedReceiverFunnel;
}

interface DaemonWebhooksConfig {
  receivers: HostedReceiverConfig[];
}

/** Path to `~/.agents/daemon/webhooks.yaml`. */
export function getDaemonWebhooksConfigPath(): string {
  return path.join(getDaemonConfigDir(), 'webhooks.yaml');
}

function coerceReceiver(item: unknown): HostedReceiverConfig | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.bundle !== 'string' || obj.bundle.length === 0) return null;
  const rc: HostedReceiverConfig = { bundle: obj.bundle };
  if (typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port > 0) rc.port = obj.port;
  if (typeof obj.rateLimit === 'number' && Number.isInteger(obj.rateLimit) && obj.rateLimit > 0) rc.rateLimit = obj.rateLimit;
  const funnel = obj.funnel as Record<string, unknown> | undefined;
  // A publicPort Funnel cannot serve is dropped rather than carried forward — the
  // receiver still binds localhost, and `daemon webhooks add` rejects it up front.
  if (funnel && typeof funnel === 'object' && FUNNEL_PORTS.includes(funnel.publicPort as FunnelPort)) {
    rc.funnel = { publicPort: funnel.publicPort as FunnelPort };
  }
  return rc;
}

/** Read the hosted-receivers config; a missing or malformed file yields an empty list, never
 * throws. */
export function readDaemonWebhooksConfig(): DaemonWebhooksConfig {
  try {
    const raw = fs.readFileSync(getDaemonWebhooksConfigPath(), 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown> | null;
    const list = parsed && Array.isArray(parsed.receivers) ? parsed.receivers : [];
    const receivers = list.map(coerceReceiver).filter((r): r is HostedReceiverConfig => r !== null);
    return { receivers };
  } catch {
    return { receivers: [] };
  }
}

/** Write the hosted-receivers config, creating the daemon config dir if needed. */
export function writeDaemonWebhooksConfig(cfg: DaemonWebhooksConfig): void {
  fs.mkdirSync(getDaemonConfigDir(), { recursive: true });
  const out = yaml.stringify({ receivers: cfg.receivers }, { sortMapEntries: false });
  atomicWriteFileSync(getDaemonWebhooksConfigPath(), out, 'utf-8');
}

/** The port a receiver binds — its identity, since one port hosts one receiver. */
export function hostedReceiverPort(receiver: HostedReceiverConfig): number {
  return receiver.port ?? DEFAULT_WEBHOOK_PORT;
}

/** Declare a receiver, replacing any entry on the same port. Port is the identity since two
 * receivers can't bind one port, so a second `add` is an edit, never a silently ignored duplicate. */
export function addHostedReceiver(receiver: HostedReceiverConfig): DaemonWebhooksConfig {
  const port = hostedReceiverPort(receiver);
  const existing = readDaemonWebhooksConfig().receivers.filter((r) => hostedReceiverPort(r) !== port);
  const next: DaemonWebhooksConfig = { receivers: [...existing, receiver] };
  writeDaemonWebhooksConfig(next);
  return next;
}

/** Drop the receiver bound to `port`; returns the removed entry or null. The caller must take down
 * any public Funnel it declared, else a public `https://<host>.ts.net` route points at a port
 * nothing serves. */
export function removeHostedReceiver(port: number): HostedReceiverConfig | null {
  const { receivers } = readDaemonWebhooksConfig();
  const removed = receivers.find((r) => hostedReceiverPort(r) === port);
  if (!removed) return null;
  writeDaemonWebhooksConfig({ receivers: receivers.filter((r) => hostedReceiverPort(r) !== port) });
  return removed;
}

/** Resolve a receiver's signing secrets from its bundle via `agentOnly` read (no Touch ID; SEC-13).
 * A locked bundle throws the unlock message, failing the receiver loud rather than binding without
 * verifiable signatures. Throws if neither secret is present. */
export function resolveReceiverSecrets(bundle: string): WebhookSecrets {
  const { env } = readAndResolveBundleEnvSync(bundle, { caller: 'daemon webhook-receiver', agentOnly: true });
  const secrets: WebhookSecrets = {};
  if (env.GITHUB_WEBHOOK_SECRET) secrets.github = env.GITHUB_WEBHOOK_SECRET;
  if (env.LINEAR_WEBHOOK_SECRET) secrets.linear = env.LINEAR_WEBHOOK_SECRET;
  if (env.SLACK_SIGNING_SECRET) secrets.slack = env.SLACK_SIGNING_SECRET;
  if (!secrets.github && !secrets.linear && !secrets.slack) {
    throw new Error(
      `bundle '${bundle}' has none of GITHUB_WEBHOOK_SECRET, LINEAR_WEBHOOK_SECRET, or SLACK_SIGNING_SECRET`,
    );
  }
  return secrets;
}

export interface HostedWebhookReceivers {
  /** Number of receivers actually bound. */
  count: number;
  /** Stop every hosted receiver. Idempotent. */
  close(): Promise<void>;
}

type Logger = (level: string, message: string) => void;

/** Best-effort funnel reconcile: bring the declared public port up, log on failure. */
function reconcileFunnel(publicPort: FunnelPort, localPort: number, log: Logger): void {
  let command: string;
  try {
    command = buildFunnelUpCommand(publicPort, localPort);
  } catch (err) {
    log('WARN', `webhook funnel skipped (port ${publicPort}): ${(err as Error).message}`);
    return;
  }
  exec(command, (err) => {
    if (err) {
      log('WARN', `webhook funnel reconcile failed (public ${publicPort} -> localhost:${localPort}); binding localhost only: ${err.message}`);
    } else {
      log('INFO', `webhook funnel up: public ${publicPort} -> localhost:${localPort}`);
    }
  });
}

/** Start every receiver in `webhooks.yaml`. One that can't start (unreadable secret, or a taken
 * port) is skipped with a WARN and doesn't take down the others or the daemon. Async because
 * EADDRINUSE arrives as an `'error'` event try/catch never sees; it once crash-looped the daemon. */
export async function startHostedWebhookReceivers(opts: {
  log: Logger;
  /** How a receiver's signing secrets resolve; defaults to `resolveReceiverSecrets`. Injectable
   * (like `FireWebhookOptions.dispatch`) so tests can exercise the bind path on real sockets
   * without a local secrets bundle. */
  resolveSecrets?: (bundle: string) => WebhookSecrets;
}): Promise<HostedWebhookReceivers> {
  const { log } = opts;
  const resolveSecrets = opts.resolveSecrets ?? resolveReceiverSecrets;
  const { receivers } = readDaemonWebhooksConfig();
  const servers: Array<{ server: Server; sockets: Set<Socket> }> = [];

  for (const receiver of receivers) {
    const port = receiver.port ?? DEFAULT_WEBHOOK_PORT;
    let secrets: WebhookSecrets;
    try {
      secrets = resolveSecrets(receiver.bundle);
    } catch (err) {
      log('WARN', `webhook receiver on :${port} skipped: ${(err as Error).message}`);
      continue;
    }
    let server: Server | null = null;
    try {
      server = startWebhookServer({
        host: '127.0.0.1',
        port,
        secrets,
        rateLimitPerMinute: receiver.rateLimit ?? DEFAULT_WEBHOOK_RATE_LIMIT,
        // Per-port durable delivery dedup so replays survive a daemon restart and
        // two receivers on distinct ports never share a dedup ledger.
        deliveryStore: createFileDeliveryStore(
          path.join(getRuntimeStateDir(), 'webhook', `deliveries-${port}.json`),
        ),
        // Logged at MATCH time, before dispatch — a `run.command` handler can
        // block on a shelled-out agent run for minutes, and that must never
        // delay the log that says a delivery fired (RUSH-2722).
        onMatch: (webhook, matchedJobNames, matchedHandlerNames) => {
          const parts: string[] = [];
          if (matchedJobNames.length) parts.push(`routines ${matchedJobNames.join(', ')}`);
          if (matchedHandlerNames.length) parts.push(`handlers ${matchedHandlerNames.join(', ')}`);
          log('INFO', `webhook ${webhook.source}:${webhook.event} ${parts.length ? `fired ${parts.join('; ')}` : 'no match'}`);
        },
        // The 202 ack means no HTTP status carries a settle failure — the daemon
        // log is where it surfaces, so it is never swallowed.
        onDeliveryError: (webhook, err) => {
          log('WARN', `webhook ${webhook.source}:${webhook.event} dispatch failed after ack: ${err.message}`);
        },
      });
      const sockets = new Set<Socket>();
      server.on('connection', (socket: Socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      await waitForListening(server);
      servers.push({ server, sockets });
      log('INFO', `webhook receiver bound on 127.0.0.1:${port} (bundle ${receiver.bundle})`);
      if (receiver.funnel) reconcileFunnel(receiver.funnel.publicPort, port, log);
    } catch (err) {
      // Close the half-started server so a failed bind leaks no handle, and keep
      // going: one unusable receiver must not cost the others their ingress.
      server?.close(() => {});
      log('WARN', `webhook receiver on :${port} failed to bind: ${(err as Error).message}`);
    }
  }

  return {
    count: servers.length,
    close: () =>
      Promise.all(
        servers.map(async ({ server, sockets }) => {
          // Stop accepting first, then force every persistent HTTP connection
          // closed so keep-alive cannot hold daemon shutdown open indefinitely.
          const closing = closeServerBounded(server);
          for (const socket of sockets) socket.destroy();
          await closing;
        }),
      ).then(() => undefined),
  };
}
