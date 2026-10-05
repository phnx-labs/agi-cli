
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

export interface HostedReceiverFunnel {
  publicPort: FunnelPort;
}

export interface HostedReceiverConfig {
  bundle: string;
  port?: number;
  rateLimit?: number;
  funnel?: HostedReceiverFunnel;
}

interface DaemonWebhooksConfig {
  receivers: HostedReceiverConfig[];
}

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
  if (funnel && typeof funnel === 'object' && FUNNEL_PORTS.includes(funnel.publicPort as FunnelPort)) {
    rc.funnel = { publicPort: funnel.publicPort as FunnelPort };
  }
  return rc;
}

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

export function writeDaemonWebhooksConfig(cfg: DaemonWebhooksConfig): void {
  fs.mkdirSync(getDaemonConfigDir(), { recursive: true });
  const out = yaml.stringify({ receivers: cfg.receivers }, { sortMapEntries: false });
  atomicWriteFileSync(getDaemonWebhooksConfigPath(), out, 'utf-8');
}

export function hostedReceiverPort(receiver: HostedReceiverConfig): number {
  return receiver.port ?? DEFAULT_WEBHOOK_PORT;
}

export function addHostedReceiver(receiver: HostedReceiverConfig): DaemonWebhooksConfig {
  const port = hostedReceiverPort(receiver);
  const existing = readDaemonWebhooksConfig().receivers.filter((r) => hostedReceiverPort(r) !== port);
  const next: DaemonWebhooksConfig = { receivers: [...existing, receiver] };
  writeDaemonWebhooksConfig(next);
  return next;
}

export function removeHostedReceiver(port: number): HostedReceiverConfig | null {
  const { receivers } = readDaemonWebhooksConfig();
  const removed = receivers.find((r) => hostedReceiverPort(r) === port);
  if (!removed) return null;
  writeDaemonWebhooksConfig({ receivers: receivers.filter((r) => hostedReceiverPort(r) !== port) });
  return removed;
}

export function resolveReceiverSecrets(bundle: string): WebhookSecrets {
  // Daemon reads are broker-only; missing signing secrets fail before any public bind.
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
  count: number;
  close(): Promise<void>;
}

type Logger = (level: string, message: string) => void;

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

/**
 * Start every receiver declared in `webhooks.yaml`. A receiver that cannot start
 * — an unreadable secret (locked bundle, no webhook secret) or a failed bind
 * (the port is already taken by a foreground `agents webhooks serve`, another
 * daemon, or anything else) — is skipped with a loud WARN and does NOT take the
 * others, or the daemon, down. Returns a handle that stops them all.
 *
 * This is async because a bind failure is only observable asynchronously:
 * `server.listen()` surfaces EADDRINUSE as an `'error'` event, so a `try/catch`
 * around the start call never sees it and the event reaches the process-level
 * `uncaughtException` handler (`index.ts`), which exits 1 for the supervisor to
 * restart — a crash loop that would take the scheduler, monitors, browser IPC,
 * and self-heal down with it. `waitForListening` is what turns that into one
 * skipped receiver.
 */
export async function startHostedWebhookReceivers(opts: {
  log: Logger;
  resolveSecrets?: (bundle: string) => WebhookSecrets;
}): Promise<HostedWebhookReceivers> {
  // Receiver config is per-box; one failed bind closes its partial server without taking siblings down.
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
        deliveryStore: createFileDeliveryStore(
          path.join(getRuntimeStateDir(), 'webhook', `deliveries-${port}.json`),
        ),
        onMatch: (webhook, matchedJobNames, matchedHandlerNames) => {
          const parts: string[] = [];
          if (matchedJobNames.length) parts.push(`routines ${matchedJobNames.join(', ')}`);
          if (matchedHandlerNames.length) parts.push(`handlers ${matchedHandlerNames.join(', ')}`);
          log('INFO', `webhook ${webhook.source}:${webhook.event} ${parts.length ? `fired ${parts.join('; ')}` : 'no match'}`);
        },
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
      server?.close(() => {});
      log('WARN', `webhook receiver on :${port} failed to bind: ${(err as Error).message}`);
    }
  }

  return {
    count: servers.length,
    close: () =>
      Promise.all(
        servers.map(async ({ server, sockets }) => {
          const closing = closeServerBounded(server);
          for (const socket of sockets) socket.destroy();
          await closing;
        }),
      ).then(() => undefined),
  };
}
