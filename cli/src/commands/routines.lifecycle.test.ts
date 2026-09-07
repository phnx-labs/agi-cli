/**
 * PHNX-3605 scheduler lifecycle integration. Drives the real routines CLI
 * against a real compiled daemon and proves stop/start are SIGHUP service
 * transitions, not aliases for whole-daemon teardown.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { startDetached } from '../lib/daemon/daemon.js';
import { DIST_ENTRY, REPO_ROOT } from '../lib/daemon/daemon.test-fixture.js';
import { CLI_ENTRYPOINT, TSX_IMPORT } from './daemon-test-harness.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'agr-life-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  execFileSync('git', ['init', '-q', systemDir]);
  return home;
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
    AGENTS_SYNC_MACHINE_ID: 'routine-lifecycle',
  };
}

function runRoutines(home: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'routines', ...args], {
    cwd: REPO_ROOT,
    env: envFor(home),
    encoding: 'utf-8',
    timeout: 30_000,
  });
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

describePosix('routines lifecycle stays scheduler-scoped (integration: real daemon + real CLI)', () => {
  it('stop disables only scheduler, then add re-enables it and fires without changing daemon PID', async () => {
    if (!fs.existsSync(DIST_ENTRY)) {
      execFileSync('bash', ['scripts/build.sh', '--skip-tests'], { cwd: REPO_ROOT, stdio: 'ignore' });
    }

    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    const pidPath = path.join(daemonDir, 'daemon.pid');
    const daemonLog = path.join(daemonDir, 'logs.jsonl');
    const healthPath = path.join(daemonDir, 'health.json');
    const servicesConfigPath = path.join(home, '.agents', 'daemon', 'services.yaml');
    const firedPath = path.join(home, 'wake-after-stop-fired');
    const { pid } = startDetached({
      agentsBin: DIST_ENTRY,
      logPath: path.join(home, 'daemon-stdio.log'),
      env: envFor(home),
    });
    expect(pid).toBeTruthy();
    if (!pid) throw new Error('daemon did not start');

    const logText = (): string => {
      try { return fs.readFileSync(daemonLog, 'utf-8'); } catch { return ''; }
    };
    const logOccurrences = (message: string): number => logText().split(message).length - 1;

    try {
      expect(await waitFor(() => fs.existsSync(pidPath) && fs.existsSync(healthPath))).toBe(true);

      const stopped = runRoutines(home, ['stop']);
      expect(stopped.status).toBe(0);
      expect(stopped.stdout).toContain('shared daemon is still running');
      expect(await waitFor(() => logText().includes('stopping the scheduler; no routines will fire'))).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);
      expect(fs.readFileSync(servicesConfigPath, 'utf-8')).toContain('scheduler: false');

      const stoppedStatus = runRoutines(home, ['status', '--json']);
      expect(stoppedStatus.status).toBe(0);
      const stoppedPayload = JSON.parse(stoppedStatus.stdout) as {
        scheduler: { state: string; serviceEnabled: boolean; daemonState: string; pid: number };
      };
      expect(stoppedPayload.scheduler).toMatchObject({
        state: 'stopped',
        serviceEnabled: false,
        daemonState: 'running',
        pid,
      });

      const bootsBeforeAdd = logOccurrences('booting the scheduler');
      const added = runRoutines(home, [
        'add',
        'wake-after-stop',
        '--schedule',
        '*/2 * * * * *',
        '--command',
        `printf fired > ${firedPath}`,
      ]);
      expect(added.status).toBe(0);
      expect(added.stdout).toContain('Scheduler service enabled and reloaded');
      expect(await waitFor(() => logOccurrences('booting the scheduler') > bootsBeforeAdd)).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);
      expect(fs.readFileSync(servicesConfigPath, 'utf-8')).toContain('scheduler: true');
      expect(await waitFor(() => fs.existsSync(firedPath))).toBe(true);
      expect(fs.readFileSync(firedPath, 'utf-8')).toBe('fired');

      const addedStatus = runRoutines(home, ['status', '--json']);
      expect(addedStatus.status).toBe(0);
      const addedPayload = JSON.parse(addedStatus.stdout) as {
        scheduler: { state: string; serviceEnabled: boolean; daemonState: string; pid: number };
        routines: Array<{ name: string; enabled: boolean }>;
      };
      expect(addedPayload.scheduler).toMatchObject({
        state: 'running',
        serviceEnabled: true,
        daemonState: 'running',
        pid,
      });
      expect(addedPayload.routines).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'wake-after-stop', enabled: true }),
      ]));

      const stoppedAgain = runRoutines(home, ['stop']);
      expect(stoppedAgain.status).toBe(0);
      expect(stoppedAgain.stdout).toContain('shared daemon is still running');
      expect(await waitFor(() => fs.readFileSync(servicesConfigPath, 'utf-8').includes('scheduler: false'))).toBe(true);
      expect(alive(pid)).toBe(true);

      const bootsBeforeExplicitStart = logOccurrences('booting the scheduler');
      const started = runRoutines(home, ['start']);
      expect(started.status).toBe(0);
      expect(started.stdout).toContain('Scheduler service enabled');
      expect(await waitFor(() => logOccurrences('booting the scheduler') > bootsBeforeExplicitStart)).toBe(true);
      expect(alive(pid)).toBe(true);
      expect(Number(fs.readFileSync(pidPath, 'utf-8').trim())).toBe(pid);
      expect(fs.readFileSync(servicesConfigPath, 'utf-8')).toContain('scheduler: true');

      const startedStatus = runRoutines(home, ['status', '--json']);
      expect(startedStatus.status).toBe(0);
      const startedPayload = JSON.parse(startedStatus.stdout) as {
        scheduler: { state: string; serviceEnabled: boolean; daemonState: string; pid: number };
      };
      expect(startedPayload.scheduler).toMatchObject({
        state: 'running',
        serviceEnabled: true,
        daemonState: 'running',
        pid,
      });

      const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8')) as Record<string, { state?: string }>;
      expect(health['browser-ipc']?.state).toBe('running');
      expect(health['monitors']?.state).toBe('running');
      expect(health['usage-sync']?.state).toBe('running');

      // The device-level scheduler gate is independent of the daemon-service
      // toggle. Status must report the effective service as stopped while the
      // shared daemon and scheduler service configuration remain up.
      const deviceDir = path.join(home, '.agents', 'devices', 'routine-lifecycle');
      fs.mkdirSync(deviceDir, { recursive: true });
      fs.writeFileSync(
        path.join(deviceDir, 'agents.yaml'),
        'config:\n  schedulerEnabled: false\n',
        'utf-8',
      );
      process.kill(pid, 'SIGHUP');
      expect(await waitFor(() => logText().includes('scheduler.enabled is now off'))).toBe(true);

      const deviceDisabledStatus = runRoutines(home, ['status', '--json']);
      expect(deviceDisabledStatus.status).toBe(0);
      const deviceDisabledPayload = JSON.parse(deviceDisabledStatus.stdout) as {
        scheduler: {
          state: string;
          serviceEnabled: boolean;
          deviceEnabled: boolean;
          daemonState: string;
          pid: number;
        };
      };
      expect(deviceDisabledPayload.scheduler).toMatchObject({
        state: 'stopped',
        serviceEnabled: true,
        deviceEnabled: false,
        daemonState: 'running',
        pid,
      });
      expect(alive(pid)).toBe(true);
    } finally {
      await killAndWait(pid);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
