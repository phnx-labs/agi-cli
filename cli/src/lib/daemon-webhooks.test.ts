import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AddressInfo } from 'net';
import {
  DEFAULT_WEBHOOK_PORT,
  addHostedReceiver,
  getDaemonWebhooksConfigPath,
  hostedReceiverPort,
  readDaemonWebhooksConfig,
  removeHostedReceiver,
  resolveReceiverSecrets,
  startHostedWebhookReceivers,
  writeDaemonWebhooksConfig,
} from './daemon-webhooks.js';
import { DAEMON_SERVICES, DAEMON_SERVICE_IDS } from './daemon-services.js';

let configDir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-webhooks-'));
  previousConfigDir = process.env.AGENTS_DAEMON_CONFIG_DIR;
  process.env.AGENTS_DAEMON_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.AGENTS_DAEMON_CONFIG_DIR;
  else process.env.AGENTS_DAEMON_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('daemon webhooks config', () => {
  it('hosts nothing when no config file exists', () => {
    expect(fs.existsSync(getDaemonWebhooksConfigPath())).toBe(false);
    expect(readDaemonWebhooksConfig()).toEqual({ receivers: [] });
  });

  it('round-trips a declared receiver through the real YAML file', () => {
    writeDaemonWebhooksConfig({
      receivers: [{ bundle: 'linear-webhook', port: 8788, rateLimit: 30, funnel: { publicPort: 443 } }],
    });

    const onDisk = yaml.parse(fs.readFileSync(getDaemonWebhooksConfigPath(), 'utf-8'));
    expect(onDisk.receivers).toEqual([
      { bundle: 'linear-webhook', port: 8788, rateLimit: 30, funnel: { publicPort: 443 } },
    ]);
    expect(readDaemonWebhooksConfig().receivers[0]).toEqual({
      bundle: 'linear-webhook',
      port: 8788,
      rateLimit: 30,
      funnel: { publicPort: 443 },
    });
  });

  it('reads an unreadable or malformed file as "host nothing", never a throw', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(getDaemonWebhooksConfigPath(), 'receivers: [ this: is: not: valid', 'utf-8');
    expect(readDaemonWebhooksConfig()).toEqual({ receivers: [] });
  });

  it('drops an entry with no bundle and a funnel port Tailscale cannot serve', () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      getDaemonWebhooksConfigPath(),
      yaml.stringify({
        receivers: [
          { port: 9000 },
          { bundle: 'gh', port: 8790, funnel: { publicPort: 9999 } },
        ],
      }),
      'utf-8',
    );
    const { receivers } = readDaemonWebhooksConfig();
    expect(receivers).toEqual([{ bundle: 'gh', port: 8790 }]);
  });

  it('treats the port as the receiver identity: a second add on it is an edit', () => {
    addHostedReceiver({ bundle: 'first' });
    addHostedReceiver({ bundle: 'second', port: 8788 });
    expect(readDaemonWebhooksConfig().receivers.map((r) => [r.bundle, hostedReceiverPort(r)]))
      .toEqual([['first', DEFAULT_WEBHOOK_PORT], ['second', 8788]]);

    addHostedReceiver({ bundle: 'replacement', port: 8788 });
    expect(readDaemonWebhooksConfig().receivers.map((r) => [r.bundle, hostedReceiverPort(r)]))
      .toEqual([['first', DEFAULT_WEBHOOK_PORT], ['replacement', 8788]]);
  });

  it('removes by port and reports when nothing was declared there', () => {
    addHostedReceiver({ bundle: 'first' });
    expect(removeHostedReceiver(9999)).toBeNull();
    expect(readDaemonWebhooksConfig().receivers).toHaveLength(1);
    expect(removeHostedReceiver(DEFAULT_WEBHOOK_PORT)).toEqual({ bundle: 'first' });
    expect(readDaemonWebhooksConfig().receivers).toEqual([]);
  });

  it('returns the removed entry so the caller can take its public Funnel down', () => {
    addHostedReceiver({ bundle: 'gh', port: 8790, funnel: { publicPort: 8443 } });
    expect(removeHostedReceiver(8790)).toEqual({ bundle: 'gh', port: 8790, funnel: { publicPort: 8443 } });
  });
});

describe('webhook-receiver daemon service', () => {
  it('is catalogued as a hosted service', () => {
    expect(DAEMON_SERVICE_IDS).toContain('webhook-receiver');
    const def = DAEMON_SERVICES.find((s) => s.id === 'webhook-receiver');
    expect(def?.title).toBe('Webhook receiver');
    expect(def?.description).toContain('webhooks.yaml');
  });
});

describe('startHostedWebhookReceivers', () => {
  it('binds nothing when no receiver is declared', async () => {
    const logs: string[] = [];
    const hosted = await startHostedWebhookReceivers({ log: (level, msg) => logs.push(`${level} ${msg}`) });
    try {
      expect(hosted.count).toBe(0);
      expect(logs).toEqual([]);
    } finally {
      await hosted.close();
    }
  });

  it('survives a bind failure: the conflicting receiver is skipped, the rest still bind', async () => {
    const squatter = http.createServer(() => {});
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const takenPort = (squatter.address() as AddressInfo).port;
    const freePort = takenPort + 1;

    const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-webhooks-secrets-'));
    const previousStateDir = process.env.AGENTS_STATE_DIR;
    process.env.AGENTS_STATE_DIR = bundleDir;
    writeDaemonWebhooksConfig({
      receivers: [{ bundle: 'conflicting', port: takenPort }, { bundle: 'healthy', port: freePort }],
    });

    const logs: { level: string; message: string }[] = [];
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    const hosted = await startHostedWebhookReceivers({
      log: (level, message) => logs.push({ level, message }),
      resolveSecrets: () => ({ linear: 'test-secret' }),
    });
    try {
      expect(hosted.count).toBe(1);
      const warn = logs.find((l) => l.level === 'WARN');
      expect(warn?.message).toContain(`:${takenPort} failed to bind`);
      expect(warn?.message).toMatch(/EADDRINUSE|address already in use/i);
      expect(logs.some((l) => l.level === 'INFO' && l.message.includes(`127.0.0.1:${freePort}`))).toBe(true);
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      await hosted.close();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
      if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
      else process.env.AGENTS_STATE_DIR = previousStateDir;
      fs.rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it('closes promptly and destroys HTTP keep-alive sockets', async () => {
    const previousStateDir = process.env.AGENTS_STATE_DIR;
    process.env.AGENTS_STATE_DIR = configDir;
    const portProbe = http.createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const port = (portProbe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));

    writeDaemonWebhooksConfig({ receivers: [{ bundle: 'keep-alive', port }] });
    const hosted = await startHostedWebhookReceivers({
      log: () => {},
      resolveSecrets: () => ({ linear: 'test-secret' }),
    });
    const agent = new http.Agent({ keepAlive: true });
    let clientSocket: import('net').Socket | undefined;

    try {
      const body = JSON.stringify({ type: 'Issue', webhookTimestamp: Date.now() });
      const signature = crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
      await new Promise<void>((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port,
          path: '/hooks/linear',
          method: 'POST',
          agent,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'linear-signature': signature,
          },
        }, (response) => {
          expect(response.statusCode).toBe(202);
          response.resume();
          response.once('end', resolve);
        });
        request.once('socket', (socket) => { clientSocket = socket; });
        request.once('error', reject);
        request.end(body);
      });
      expect(clientSocket).toBeDefined();
      const socket = clientSocket!;
      expect(socket.destroyed).toBe(false);

      const clientClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hosted webhook close exceeded 500ms')), 500);
        Promise.all([hosted.close(), clientClosed]).then(
          () => { clearTimeout(timer); resolve(); },
          (error) => { clearTimeout(timer); reject(error); },
        );
      });

      expect(socket.destroyed).toBe(true);
    } finally {
      agent.destroy();
      await hosted.close();
      if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
      else process.env.AGENTS_STATE_DIR = previousStateDir;
    }
  });

  it('fails a receiver LOUD when its signing secret cannot be resolved', async () => {
    addHostedReceiver({ bundle: 'daemon-webhooks-test-absent-bundle', port: 8791 });
    const logs: { level: string; message: string }[] = [];
    const hosted = await startHostedWebhookReceivers({ log: (level, message) => logs.push({ level, message }) });
    try {
      expect(hosted.count).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('WARN');
      expect(logs[0].message).toContain(':8791 skipped');
    } finally {
      await hosted.close();
    }
  });

  it('throws rather than returning empty secrets when the standalone is unavailable', () => {
    expect(() => resolveReceiverSecrets('daemon-webhooks-test-absent-bundle')).toThrow();
  });
});

const REAL_SECRETS_BIN = process.env.AGENTS_TEST_SECRETS_BIN;

describe.skipIf(!REAL_SECRETS_BIN)('resolveReceiverSecrets (real standalone)', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SECRETS_BIN', 'HOME', 'SECRETS_HOME', 'SECRETS_NO_AGENT'];

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-webhooks-real-'));
    process.env.SECRETS_BIN = REAL_SECRETS_BIN;
    process.env.HOME = home;
    process.env.SECRETS_HOME = path.join(home, '.agents');
    process.env.SECRETS_NO_AGENT = '1';
    const { _resetSecretsClientForTest } = await import('./secrets-client.js');
    _resetSecretsClientForTest();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    const { _resetSecretsClientForTest } = await import('./secrets-client.js');
    _resetSecretsClientForTest();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('throws a real engine error for an absent bundle, not just a missing-binary error', () => {
    expect(() => resolveReceiverSecrets('daemon-webhooks-test-absent-bundle')).toThrow();
    try {
      resolveReceiverSecrets('daemon-webhooks-test-absent-bundle');
    } catch (err) {
      expect((err as Error).message).not.toContain('was not found');
    }
  });
});
