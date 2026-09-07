/**
 * PHNX-3605 browser lifecycle integration: real compiled clients talk to a
 * real compiled daemon over the real browser IPC socket. No lifecycle module
 * is mocked. The two package copies deliberately carry different dev tails so
 * this reproduces the exact client/daemon skew that used to call
 * stopDaemon(); startDaemon() and evict every hosted service.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { ipcEndpoint } from '../platform/index.js';
import { startDetached } from '../daemon/daemon.js';
import { DIST_ENTRY, REPO_ROOT } from '../daemon/daemon.test-fixture.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agb-life-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  execFileSync('git', ['init', '-q', systemDir]);
  return home;
}

function installCopy(root: string, name: string, version: string): string {
  const installRoot = path.join(root, name);
  fs.mkdirSync(installRoot, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'dist'), path.join(installRoot, 'dist'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as Record<string, unknown>;
  pkg.version = version;
  fs.writeFileSync(path.join(installRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8');
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(installRoot, 'node_modules'), 'dir');
  return path.join(installRoot, 'dist', 'index.js');
}

function envFor(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENTS_SKIP_MIGRATION: '1',
    AGENTS_NO_AUTOPULL: '1',
    AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
    AGENTS_DAEMON_TEST_HOME: home,
    AGENTS_DAEMON_DIR: path.join(home, '.agents', '.cache', 'helpers', 'daemon'),
    AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME: '1',
  };
}

function runCli(entry: string, home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: REPO_ROOT,
    env: envFor(home),
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function runClient(entry: string, home: string, args: string[]): ReturnType<typeof spawnSync> {
  return runCli(entry, home, ['browser', ...args]);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killAndWait(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

function responsive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let settled = false;
    let buffer = '';
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 1_000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ action: 'version' })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      try { done(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))).ok === true); }
      catch { done(false); }
    });
    socket.on('error', () => done(false));
    socket.on('close', () => done(false));
  });
}

describePosix('browser lifecycle stays service-scoped (integration: real daemon + real clients)', () => {
  it('queues a client service reload during daemon startup instead of letting SIGHUP terminate the process', async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('bash', ['scripts/build.sh', '--skip-tests'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const home = makeHome();
    const daemonEntry = installCopy(home, 'startup-daemon-install', '0.0.0-dev.startup');
    const clientEntry = installCopy(home, 'startup-client-install', '0.0.0-dev.startup');
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    const pidPath = path.join(daemonDir, 'daemon.pid');
    const daemonLog = path.join(daemonDir, 'logs.jsonl');
    const logPath = path.join(home, 'daemon-startup-stdio.log');
    const startupEnv = {
      ...envFor(home),
      AGENTS_DAEMON_TEST_STARTUP_DELAY_MS: '10000',
    };

    const { pid } = startDetached({ agentsBin: daemonEntry, logPath, env: startupEnv });
    expect(pid).toBeTruthy();
    if (!pid) throw new Error('daemon did not start');

    try {
      // The daemon has published the PID clients use for liveness, but the
      // deterministic test-only pause keeps service startup incomplete. The
      // real browser client therefore takes the live-daemon SIGHUP path.
      expect(await waitFor(() => fs.existsSync(pidPath), 5_000)).toBe(true);
      const stopped = runClient(clientEntry, home, ['stop', '--service']);
      expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);

      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);
      expect(await waitFor(() => {
        try {
          return fs.readFileSync(daemonLog, 'utf-8')
            .includes('Applying service reload requested while the daemon was starting');
        } catch { return false; }
      })).toBe(true);
    } finally {
      await killAndWait(pid);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  it('unordered dev-tail reconciliation and browser service stop/start never evict the shared daemon', async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('bash', ['scripts/build.sh', '--skip-tests'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const home = makeHome();
    const daemonEntry = installCopy(home, 'daemon-install', '0.0.0-dev.daemon');
    const clientEntry = installCopy(home, 'client-install', '0.0.0-dev.client');
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    const pidPath = path.join(daemonDir, 'daemon.pid');
    const healthPath = path.join(daemonDir, 'health.json');
    const browserSocket = path.join(home, '.agents', '.cache', 'helpers', 'browser', 'browser.sock');
    const endpoint = ipcEndpoint(browserSocket);
    const logPath = path.join(home, 'daemon-stdio.log');
    const servicesConfigPath = path.join(home, '.agents', 'daemon', 'services.yaml');

    const { pid } = startDetached({ agentsBin: daemonEntry, logPath, env: envFor(home) });
    expect(pid).toBeTruthy();
    if (!pid) throw new Error('daemon did not start');

    try {
      expect(await waitFor(() => fs.existsSync(pidPath))).toBe(true);
      expect(await waitFor(() => fs.existsSync(healthPath))).toBe(true);
      expect(await waitFor(() => {
        try {
          const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8')) as Record<string, { state?: string }>;
          return health['usage-sync']?.state === 'running' && health['session-index']?.state === 'running';
        } catch { return false; }
      })).toBe(true);
      expect(await responsive(endpoint)).toBe(true);

      // The keystone regression: compareVersions cannot order distinct dev
      // tails. The old client path treated that as permission to stop and
      // restart the whole daemon. This real client must warn and keep the
      // original process alive instead.
      const reconciled = runClient(clientEntry, home, ['prune', '--dry-run']);
      expect(reconciled.status).toBe(0);
      expect(reconciled.stderr).toContain('Continuing without evicting the daemon or its other services');
      expect(reconciled.stderr).toContain('agents daemon restart');
      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);

      // The explicit browser stop is service-scoped too. It turns off browser
      // IPC over SIGHUP, while the daemon PID and unrelated supervised services
      // stay running.
      const stopped = runClient(clientEntry, home, ['stop', '--service']);
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain('shared daemon is still running');
      expect(await waitFor(() => !fs.existsSync(browserSocket))).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);
      expect(fs.readFileSync(servicesConfigPath, 'utf-8')).toContain('browser-ipc: false');

      const stoppedStatus = runClient(clientEntry, home, ['status', '--json']);
      expect(stoppedStatus.status).toBe(1);
      const stoppedPayload = JSON.parse(stoppedStatus.stdout) as {
        service: { id: string; state: string };
        error: string;
      };
      expect(stoppedPayload.service).toEqual({ id: 'browser-ipc', state: 'stopped' });
      expect(stoppedPayload.error).toContain('Shared daemon: running');

      const routinesStatus = runCli(clientEntry, home, ['routines', 'status', '--json']);
      expect(routinesStatus.status).toBe(0);
      const routinesPayload = JSON.parse(routinesStatus.stdout) as {
        scheduler: { state: string; daemonState: string; pid: number };
      };
      expect(routinesPayload.scheduler).toMatchObject({
        state: 'running',
        daemonState: 'running',
        pid,
      });

      // A browser verb that needs IPC re-enables only that registered service.
      // `prune --dry-run` exercises the real CLI/IPC path without launching a
      // browser process or requiring a profile.
      const restarted = runClient(clientEntry, home, ['prune', '--dry-run']);
      expect(restarted.status).toBe(0);
      expect(await waitFor(() => fs.existsSync(browserSocket))).toBe(true);
      expect(await responsive(endpoint)).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);
      expect(fs.readFileSync(servicesConfigPath, 'utf-8')).toContain('browser-ipc: true');

      const runningStatus = runClient(clientEntry, home, ['status']);
      expect(runningStatus.status).toBe(0);
      expect(runningStatus.stdout).toContain('Browser service: running (shared daemon unchanged)');

      const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8')) as Record<string, { state?: string }>;
      expect(health['monitors']?.state).toBe('running');
      expect(health['usage-sync']?.state).toBe('running');
      expect(health['session-index']?.state).toBe('running');
    } finally {
      await killAndWait(pid);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
