
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
  const tmpHome = fs.mkdtempSync(path.join(tmpRoot, 'agd-svclive-'));
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

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

describe('agents daemon services enable/disable/restart live path (integration: real daemon subprocess)', () => {
  it('SIGHUP reload stops, restarts, and restarts-live a supervisor-managed service without a daemon restart', async () => {
    if (!fs.existsSync(DIST_ENTRY)) execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' });

    const tmpHome = freshHome();
    const servicesConfigDir = path.join(tmpHome, '.agents', 'daemon');
    const servicesConfigPath = path.join(servicesConfigDir, 'services.yaml');
    const actionsPath = path.join(servicesConfigDir, 'service-actions.json');
    fs.mkdirSync(servicesConfigDir, { recursive: true });

    const runtimeDir = path.join(tmpHome, '.agents', '.cache', 'helpers', 'daemon');
    const logPath = path.join(tmpHome, 'daemon-stdio.log');
    const daemonLog = path.join(runtimeDir, 'logs.jsonl');
    const healthPath = path.join(runtimeDir, 'health.json');
    const childEnv = { ...process.env, HOME: tmpHome };
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;

    const { pid } = startDetached({ agentsBin: DIST_ENTRY, logPath, env: childEnv });
    expect(pid).toBeTruthy();
    if (!pid) throw new Error('daemon did not start');

    const readHealth = (): Record<string, { state?: string; consecutiveFailures?: number; lastOkAt?: string | null }> => {
      try { return JSON.parse(fs.readFileSync(healthPath, 'utf-8')); } catch { return {}; }
    };
    const readLog = (): string => { try { return fs.readFileSync(daemonLog, 'utf-8'); } catch { return ''; } };

    try {
      await waitFor(() => readHealth()['session-index']?.state === 'running');
      expect(readHealth()['session-index']?.state).toBe('running');

      fs.writeFileSync(servicesConfigPath, 'services:\n  session-index: false\n', 'utf-8');
      process.kill(pid, 'SIGHUP');
      await waitFor(() => readLog().includes(`Service 'session-index' stopped live (SIGHUP reload)`));
      expect(readLog()).toContain(`Service 'session-index' stopped live (SIGHUP reload)`);
      expect(readHealth()['session-index']?.state).toBe('stopped');

      fs.writeFileSync(servicesConfigPath, 'services:\n  session-index: true\n', 'utf-8');
      process.kill(pid, 'SIGHUP');
      await waitFor(() => readLog().includes(`Service 'session-index' started live (SIGHUP reload)`));
      expect(readLog()).toContain(`Service 'session-index' started live (SIGHUP reload)`);
      expect(readHealth()['session-index']?.state).toBe('running');

      fs.mkdirSync(path.dirname(actionsPath), { recursive: true });
      fs.writeFileSync(actionsPath, JSON.stringify({ restart: ['session-index'] }), 'utf-8');
      process.kill(pid, 'SIGHUP');
      await waitFor(() => readLog().includes(`Service 'session-index' restarted live (SIGHUP reload)`));
      expect(readLog()).toContain(`Service 'session-index' restarted live (SIGHUP reload)`);
      expect(readHealth()['session-index']?.state).toBe('running');
      expect(fs.existsSync(actionsPath)).toBe(false);
    } finally {
      if (pid) await killAndWait(pid);
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30_000);
});
