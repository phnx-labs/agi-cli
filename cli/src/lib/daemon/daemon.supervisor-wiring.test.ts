
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { startDetached } from './daemon.js';
import { DIST_ENTRY, REPO_ROOT, installKeychainHermeticity } from './daemon.test-fixture.js';

installKeychainHermeticity();

function freshHome(): string {
  const tmpRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-sup-'));
  const systemDir = path.join(tmpHome, '.agents', '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  execFileSync('git', ['init', '-q', systemDir]);
  return tmpHome;
}

function killAndWait(pid: number): Promise<void> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {  }
  return (async () => {
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  })();
}

describe('runDaemon() supervisor wiring (integration: real daemon subprocess)', () => {
  it('registers session-index on the supervisor and it reports healthy shortly after boot', async () => {
    if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });

    const tmpHome = freshHome();
    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const healthPath = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'health.json');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();

    try {
      let record: { subsystem?: string; consecutiveFailures?: number } | undefined;
      for (let i = 0; i < 100 && !record; i++) {
        if (fs.existsSync(healthPath)) {
          try {
            const all = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
            if (all['session-index']) record = all['session-index'];
          } catch {  }
        }
        if (!record) await new Promise((r) => setTimeout(r, 100));
      }

      expect(record).toBeDefined();
      expect(record?.consecutiveFailures).toBe(0);
    } finally {
      if (pid) await killAndWait(pid);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('a disabled session-index service never registers, so it reports no health record', async () => {
    if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });

    const tmpHome = freshHome();
    const servicesConfigDir = path.join(tmpHome, '.agents', 'daemon');
    fs.mkdirSync(servicesConfigDir, { recursive: true });
    fs.writeFileSync(path.join(servicesConfigDir, 'services.yaml'), 'services:\n  session-index: false\n', 'utf-8');

    const runtimeDir = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon');
    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const daemonLog = path.join(runtimeDir, 'logs.jsonl');
    const healthPath = path.join(runtimeDir, 'health.json');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();

    try {
      let sawDisabledLog = false;
      for (let i = 0; i < 100 && !sawDisabledLog; i++) {
        if (fs.existsSync(daemonLog)) {
          sawDisabledLog = fs.readFileSync(daemonLog, 'utf-8').includes('Session-index warm service disabled');
        }
        if (!sawDisabledLog) await new Promise((r) => setTimeout(r, 100));
      }
      expect(sawDisabledLog).toBe(true);

      await new Promise((r) => setTimeout(r, 500));
      const all = fs.existsSync(healthPath) ? JSON.parse(fs.readFileSync(healthPath, 'utf-8')) : {};
      expect(all['session-index']).toBeUndefined();
    } finally {
      if (pid) await killAndWait(pid);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 20_000);

  const PERIODIC_SERVICE_IDS = [
    'watchdog', 'device-probe', 'self-heal', 'state-dir-check',
    'session-state', 'daemon-heartbeat', 'tmux-reap',
    'catchup',
  ] as const;

  const ALL_SUPERVISED_SERVICE_IDS = [
    'session-state', 'account-state',
    'account-auth', 'catchup', 'session-index', 'watchdog',
    'device-probe', 'self-heal', 'self-update', 'auth-sync',
    'usage-sync', 'webhook-receiver', 'daemon-heartbeat', 'tmux-reap',
    'state-dir-check', 'attention-notify',
  ] as const;

  it('registers every supervised service during a real daemon boot', async () => {
    if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });

    const tmpHome = freshHome();
    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const healthPath = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'health.json');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();

    try {
      const readHealth = (): Record<string, unknown> => {
        try { return JSON.parse(fs.readFileSync(healthPath, 'utf-8')); } catch { return {}; }
      };

      let all: Record<string, unknown> = {};
      for (let i = 0; i < 200 && ALL_SUPERVISED_SERVICE_IDS.some((id) => !all[id]); i++) {
        all = readHealth();
        if (ALL_SUPERVISED_SERVICE_IDS.some((id) => !all[id])) await new Promise((r) => setTimeout(r, 100));
      }

      for (const id of ALL_SUPERVISED_SERVICE_IDS) {
        expect(all[id], `expected a supervisor health record for '${id}'`).toBeDefined();
      }
    } finally {
      if (pid) await killAndWait(pid);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('registers every periodic maintenance service on the supervisor and each reports healthy shortly after boot', async () => {
    if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });

    const tmpHome = freshHome();
    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const healthPath = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon', 'health.json');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();

    try {
      const readHealth = (): Record<string, { consecutiveFailures?: number }> => {
        try { return JSON.parse(fs.readFileSync(healthPath, 'utf-8')); } catch { return {}; }
      };

      let all: Record<string, { consecutiveFailures?: number }> = {};
      for (let i = 0; i < 200 && PERIODIC_SERVICE_IDS.some((id) => !all[id]); i++) {
        all = readHealth();
        if (PERIODIC_SERVICE_IDS.some((id) => !all[id])) await new Promise((r) => setTimeout(r, 100));
      }

      for (const id of PERIODIC_SERVICE_IDS) {
        expect(all[id], `expected a health record for '${id}'`).toBeDefined();
        expect(all[id]?.consecutiveFailures).toBe(0);
      }
    } finally {
      if (pid) await killAndWait(pid);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('disabling every periodic maintenance service means none register or report health', async () => {
    if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });

    const tmpHome = freshHome();
    const servicesConfigDir = path.join(tmpHome, '.agents', 'daemon');
    fs.mkdirSync(servicesConfigDir, { recursive: true });
    const disabledYaml = `services:\n${PERIODIC_SERVICE_IDS.map((id) => `  ${id}: false`).join('\n')}\n`;
    fs.writeFileSync(path.join(servicesConfigDir, 'services.yaml'), disabledYaml, 'utf-8');

    const runtimeDir = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon');
    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const daemonLog = path.join(runtimeDir, 'logs.jsonl');
    const healthPath = path.join(runtimeDir, 'health.json');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();

    try {
      const expectedDisabledLines = [
        'Watchdog service disabled',
        'Device-probe service disabled',
        'Self-heal service disabled',
        'State-dir self-check disabled',
        'Live session-state service disabled',
        'Daemon heartbeat service disabled',
        'Tmux reap service disabled',
        'Catch-up recovery service disabled',
      ];
      let sawAll = false;
      for (let i = 0; i < 100 && !sawAll; i++) {
        if (fs.existsSync(daemonLog)) {
          const log = fs.readFileSync(daemonLog, 'utf-8');
          sawAll = expectedDisabledLines.every((line) => log.includes(line));
        }
        if (!sawAll) await new Promise((r) => setTimeout(r, 100));
      }
      expect(sawAll).toBe(true);

      await new Promise((r) => setTimeout(r, 500));
      const all = fs.existsSync(healthPath) ? JSON.parse(fs.readFileSync(healthPath, 'utf-8')) : {};
      for (const id of PERIODIC_SERVICE_IDS) expect(all[id]).toBeUndefined();
    } finally {
      if (pid) await killAndWait(pid);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});
