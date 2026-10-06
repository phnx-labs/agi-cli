import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _resetSecretsClientForTest,
  pushBundleToHost,
  readAndResolveBundleEnv,
  secretsKeychainItem,
  writeBundleWithItems,
} from './secrets-client.js';
import { ensureStandaloneSecretsBin } from '../../tests/secrets-standalone.js';

const SSHD = '/usr/sbin/sshd';
const SSH = '/usr/bin/ssh';
const TARGET = '127.0.0.1';
const RUN = `agents-push-${process.pid}-${Date.now().toString(36)}`;
const BIN = ensureStandaloneSecretsBin();
const ENV_KEYS = ['HOME', 'USERPROFILE', 'SECRETS_HOME', 'SECRETS_PASSPHRASE', 'SECRETS_BIN', 'PATH'];

let tmp = '';
let sshd: ChildProcess | undefined;
let port = 0;
let workerHome = '';
let pusherHome = '';
let clientBin = '';
let skipReason = '';
const saved: Record<string, string | undefined> = {};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(p));
    });
  });
}

function writeExec(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function asSide(home: string, root?: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.SECRETS_BIN = BIN;
  process.env.PATH = `${clientBin}${path.delimiter}${saved.PATH ?? ''}`;
  delete process.env.SECRETS_PASSPHRASE;
  if (root) process.env.SECRETS_HOME = root;
  else delete process.env.SECRETS_HOME;
  _resetSecretsClientForTest();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  if (process.platform === 'win32' || !fs.existsSync(SSHD) || !fs.existsSync(SSH)) {
    skipReason = `${SSHD} or ${SSH} is not available`;
    return;
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-push-'));
  workerHome = path.join(tmp, 'worker');
  pusherHome = path.join(tmp, 'pusher');
  const workerBin = path.join(workerHome, 'bin');
  clientBin = path.join(tmp, 'client-bin');
  for (const dir of [workerBin, pusherHome, clientBin]) fs.mkdirSync(dir, { recursive: true });

  writeExec(path.join(workerBin, 'secrets'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} "$@"\n`);
  fs.writeFileSync(path.join(workerHome, '.bash_profile'), `export PATH=${JSON.stringify(workerBin)}:"$PATH"\n`);
  const force = path.join(tmp, 'force.sh');
  writeExec(
    force,
    `#!/bin/sh\nexport HOME=${JSON.stringify(workerHome)} SECRETS_NO_AGENT=1 SECRETS_NO_USAGE_TRACK=1 SECRETS_SKIP_HELPER_INSTALL=1\n` +
      `unset SECRETS_HOME SECRETS_PASSPHRASE\nexport PATH=${JSON.stringify(workerBin)}:/usr/bin:/bin\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`,
  );

  const key = (name: string) => {
    const file = path.join(tmp, name);
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { stdio: 'ignore' });
    return file;
  };
  const hostKey = key('host_key');
  const clientKey = key('client_key');
  fs.copyFileSync(`${clientKey}.pub`, path.join(tmp, 'authorized_keys'));

  port = await freePort();
  const sshdConfig = path.join(tmp, 'sshd_config');
  fs.writeFileSync(
    sshdConfig,
    [
      `Port ${port}`,
      `ListenAddress ${TARGET}`,
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${path.join(tmp, 'authorized_keys')}`,
      `PidFile ${path.join(tmp, 'sshd.pid')}`,
      `ForceCommand ${force}`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
    ].join('\n') + '\n',
  );
  sshd = spawn(SSHD, ['-D', '-e', '-f', sshdConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
  let sshdErr = '';
  sshd.stderr?.on('data', (c: Buffer) => (sshdErr += c.toString()));

  const sshConfig = path.join(tmp, 'ssh_config');
  fs.writeFileSync(
    sshConfig,
    [`Host ${TARGET}`, `  Port ${port}`, `  User ${os.userInfo().username}`, `  IdentityFile ${clientKey}`, '  IdentitiesOnly yes', `  UserKnownHostsFile ${path.join(tmp, 'known_hosts')}`].join('\n') + '\n',
  );
  writeExec(path.join(clientBin, 'ssh'), `#!/bin/sh\nexec ${SSH} -F ${JSON.stringify(sshConfig)} "$@"\n`);

  for (let i = 0; i < 50; i++) {
    const probe = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', TARGET, 'true'], {
      env: { ...process.env, PATH: `${clientBin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    if (probe.status === 0) break;
    if (sshd.exitCode !== null || i === 49) {
      skipReason = `fixture sshd did not accept a connection: ${sshdErr.trim().split('\n').pop() ?? 'no output'}`;
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  asSide(pusherHome);
  const pin = spawnSync(process.execPath, [BIN, 'hosts', 'pin', TARGET, '--port', String(port)], { encoding: 'utf-8', env: process.env });
  if (pin.status !== 0) throw new Error(`secrets hosts pin: ${pin.stderr}`);
}, 120_000);

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetSecretsClientForTest();
  if (sshd && sshd.exitCode === null) {
    const exited = new Promise((resolve) => sshd!.once('exit', resolve));
    sshd.kill('SIGTERM');
    await exited;
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function pushFileBundle(name: string, value: string, remoteSecretsHome?: string): Promise<void> {
  asSide(pusherHome);
  await writeBundleWithItems(
    { name, backend: 'file', policy: 'never', vars: { TOKEN: 'keychain:TOKEN' } },
    new Map([[secretsKeychainItem(name, 'TOKEN'), value]]),
  );
  const result = await pushBundleToHost(name, TARGET, {
    remoteBackend: 'file',
    force: true,
    policyNever: true,
    agentOnly: true,
    operation: 'push root test',
    ...(remoteSecretsHome ? { remoteSecretsHome } : {}),
  });
  expect(result, result.message).toMatchObject({ ok: true, keyCount: 1 });
}

describe('a bundle push lands where the receiving agents-cli reads (real sshd)', () => {
  it('without remoteSecretsHome, the worker default root receives it', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    asSide(workerHome);
    await writeBundleWithItems(
      { name: `${RUN}-worker-own`, backend: 'file', policy: 'never', vars: { OWN: 'keychain:OWN' } },
      new Map([[secretsKeychainItem(`${RUN}-worker-own`, 'OWN'), 'worker-own']]),
    );
    const name = `${RUN}-default`;
    await pushFileBundle(name, 'default-root-pushed');

    asSide(workerHome);
    expect((await readAndResolveBundleEnv(name)).env).toEqual({ TOKEN: 'default-root-pushed' });
    expect(fs.existsSync(path.join(workerHome, '.agents', '.secrets'))).toBe(true);
    expect(fs.existsSync(path.join(workerHome, '.agents', '.cache', 'secrets'))).toBe(false);
  }, 120_000);

  it('an explicit remoteSecretsHome receives it instead, and the default root does not', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const name = `${RUN}-explicit`;
    await pushFileBundle(name, 'explicit-root-pushed', '~/explicit-root');

    asSide(workerHome, path.join(workerHome, 'explicit-root'));
    expect((await readAndResolveBundleEnv(name)).env).toEqual({ TOKEN: 'explicit-root-pushed' });
    asSide(workerHome);
    await expect(readAndResolveBundleEnv(name)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 120_000);
});
