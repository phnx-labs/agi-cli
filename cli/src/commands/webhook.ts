import type { Command } from 'commander';
import type { Server } from 'http';
import type { Socket } from 'net';
import * as path from 'path';
import chalk from 'chalk';
import { readAndResolveBundleEnv } from '../lib/secrets-client.js';
import { closeServerBounded } from '../lib/net-close.js';
import { createFileDeliveryStore, startWebhookServer, waitForListening, type WebhookSecrets } from '../lib/triggers/webhook.js';
import { getRuntimeStateDir } from '../lib/state.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function readWebhookSecrets(bundleName: string): Promise<WebhookSecrets> {

  const { env } = await readAndResolveBundleEnv(bundleName, {
    caller: 'webhooks serve',
    agentOnly: true,
  });
  const secrets: WebhookSecrets = {};
  if (env.GITHUB_WEBHOOK_SECRET) secrets.github = env.GITHUB_WEBHOOK_SECRET;
  if (env.LINEAR_WEBHOOK_SECRET) secrets.linear = env.LINEAR_WEBHOOK_SECRET;
  if (env.SLACK_SIGNING_SECRET) secrets.slack = env.SLACK_SIGNING_SECRET;
  if (!secrets.github && !secrets.linear && !secrets.slack) {
    throw new Error(
      `Bundle '${bundleName}' must contain GITHUB_WEBHOOK_SECRET, LINEAR_WEBHOOK_SECRET, or SLACK_SIGNING_SECRET.`,
    );
  }
  return secrets;
}

export async function closeWebhookServer(server: Server, sockets: Set<Socket>): Promise<void> {
  const closing = closeServerBounded(server);
  for (const socket of sockets) socket.destroy();
  await closing;
}

export function registerWebhooksCommand(program: Command): void {
  const webhooks = program
    .command('webhooks')
    .description('Run a localhost signed webhook receiver for routine triggers.');

  webhooks
    .command('serve')
    .description('Receive signed GitHub/Linear/Slack webhooks on /hooks/<source> and fire matching routines and handlers.')
    .requiredOption('--secrets-bundle <name>', 'secrets bundle containing GITHUB_WEBHOOK_SECRET, LINEAR_WEBHOOK_SECRET, and/or SLACK_SIGNING_SECRET')
    .option('--bind <addr>', `Bind address (default ${DEFAULT_HOST})`, DEFAULT_HOST)
    .option('-p, --port <n>', `Local port (default ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .option('--rate-limit <n>', 'Accepted deliveries per source per minute', '60')
    .action(async (opts: { secretsBundle: string; bind?: string; port?: string; rateLimit?: string }) => {
      let secrets: WebhookSecrets;
      try {
        secrets = await readWebhookSecrets(opts.secretsBundle);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }

      const port = positiveInt(opts.port, DEFAULT_PORT);
      const rateLimit = positiveInt(opts.rateLimit, 60);

      try {
        const server = startWebhookServer({
          host: opts.bind ?? DEFAULT_HOST,
          port,
          secrets,
          rateLimitPerMinute: rateLimit,
          deliveryStore: createFileDeliveryStore(
            path.join(getRuntimeStateDir(), 'webhook', 'deliveries.json'),
          ),
          onMatch: (webhook, matchedJobNames, matchedHandlerNames) => {
            const parts: string[] = [];
            if (matchedJobNames.length) parts.push(`routines ${matchedJobNames.join(', ')}`);
            if (matchedHandlerNames.length) parts.push(`handlers ${matchedHandlerNames.join(', ')}`);
            console.log(
              `${new Date().toISOString()} ${webhook.source}:${webhook.event} ` +
              (parts.length ? `fired ${parts.join('; ')}` : 'no match'),
            );
          },
          onDeliveryError: (webhook, err) => {
            console.error(chalk.red(
              `${new Date().toISOString()} ${webhook.source}:${webhook.event} dispatch failed after ack: ${err.message}`,
            ));
          },
        });
        const sockets = new Set<Socket>();
        server.on('connection', (socket: Socket) => {
          sockets.add(socket);
          socket.once('close', () => sockets.delete(socket));
        });
        await waitForListening(server);
        const address = server.address();
        const bound = typeof address === 'object' && address ? address.port : port;
        console.log(`${chalk.green('agents webhooks')} ${chalk.dim('→')} ${chalk.cyan(`http://${opts.bind ?? DEFAULT_HOST}:${bound}`)}`);
        console.log(chalk.dim('signed · localhost by default · endpoints: /hooks/github, /hooks/linear, /hooks/slack · acks 202 then dispatches · Ctrl-C to stop'));
        console.log(chalk.dim('for a supervised receiver that survives reboot: agents daemon webhooks add --secrets-bundle <name>'));

        let shuttingDown = false;
        const shutdown = async () => {
          if (shuttingDown) return;
          shuttingDown = true;
          await closeWebhookServer(server, sockets);
          process.exit(0);
        };
        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });
      } catch (err) {
        console.error(chalk.red(`Could not start webhook receiver: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
