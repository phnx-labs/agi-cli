import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  DAEMON_TESTS_SUPPORTED,
  makeHome,
  run,
} from './daemon-test-harness.js';

const describeDaemon = DAEMON_TESTS_SUPPORTED ? describe : describe.skip;

describeDaemon('agents daemon — doctor, logs, stop, reload', () => {
  it('status --json reports stopped with no pid when no daemon is running for THIS install', () => {
    const res = run(makeHome(), ['status', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.state).toBe('stopped');
    expect(payload.pid).toBeNull();
    expect(payload.duplicates).toEqual([]);
    expect(payload.daemonEnabled).toBe(true);
    expect(payload.services.secretsBroker).toHaveProperty('reachable', false);
    expect(payload.services.browserIpc).toBeUndefined();
    expect(payload.scheduler).toEqual(
      expect.objectContaining({
        routineCount: 0,
        enabledCount: 0,
        failingCount: 0,
      }),
    );
  });
  it('logs reports no matching lines when no daemon has ever logged', () => {
    const res = run(makeHome(), ['logs']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('No matching log lines');
  });
  it('logs --json returns an empty array, not a crash, with no log file', () => {
    const res = run(makeHome(), ['logs', '--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual([]);
  });
  it('logs level sets and reads back the daemon log level, and --level debug shows debug lines with their data', () => {
    const home = makeHome();
    const set = run(home, ['logs', 'level', 'debug', '--json']);
    expect(set.status).toBe(0);
    expect(JSON.parse(String(set.stdout).trim())).toMatchObject({ level: 'debug' });
    expect(fs.readFileSync(path.join(home, '.agents', 'daemon', 'services.yaml'), 'utf-8')).toContain('logLevel: debug');
    expect(String(run(home, ['logs', 'level']).stdout).trim()).toBe('debug');

    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'logs.jsonl'), [
      JSON.stringify({ ts: new Date().toISOString(), level: 'DEBUG', message: 'tick ok', data: { event: 'tick.ok', durMs: 4 } }),
      JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', message: 'vitals', data: { event: 'vitals' } }),
    ].join('\n') + '\n');
    const all = JSON.parse(String(run(home, ['logs', '--json']).stdout).trim());
    expect(all.map((e: { level: string }) => e.level)).toEqual(['DEBUG', 'INFO']);
    const debug = JSON.parse(String(run(home, ['logs', '--level', 'debug', '--json']).stdout).trim());
    expect(debug[0]).toMatchObject({ level: 'DEBUG', data: { event: 'tick.ok', durMs: 4 } });
    const infoUp = JSON.parse(String(run(home, ['logs', '--level', 'info', '--json']).stdout).trim());
    expect(infoUp.map((e: { level: string }) => e.level)).toEqual(['INFO']);
  });

  it('logs rejects an unknown --level and logs level rejects an unknown level, instead of guessing', () => {
    const home = makeHome();
    const filter = run(home, ['logs', '--level', 'verbose']);
    expect(filter.status).not.toBe(0);
    expect(String(filter.stderr)).toContain('--level must be one of debug, info, warn, error');
    const set = run(home, ['logs', 'level', 'verbose']);
    expect(set.status).not.toBe(0);
    expect(String(set.stderr)).toContain('log level must be one of debug, info, warn, error');
  });

  it('doctor exits non-zero and names the problem when the daemon should be running but is not', () => {
    const res = run(makeHome(), ['doctor']);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Daemon is not running');
  });

  it('doctor reports an open auto-start circuit breaker, with the recorded cause', () => {
    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'health.json'), JSON.stringify({
      'daemon-start': {
        subsystem: 'daemon-start',
        lastError: 'start issued; no daemon has reported healthy since',
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 5,
        lastOkAt: null,
      },
    }), 'utf-8');

    const res = run(home, ['doctor', '--json']);
    expect(res.status).toBe(1);
    const problems: string[] = JSON.parse(res.stdout).problems;
    const breaker = problems.find((p) => p.includes('auto-start is disabled'));
    expect(breaker).toBeDefined();
    expect(breaker).toContain('5 consecutive');
    expect(breaker).toContain('start issued; no daemon has reported healthy since');
  });

  it('doctor does not report a sub-threshold start streak while the daemon is running', () => {
    const home = makeHome();
    const daemonDir = path.join(home, '.agents', '.cache', 'helpers', 'daemon');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonDir, 'health.json'), JSON.stringify({
      'daemon-start': {
        subsystem: 'daemon-start',
        lastError: 'start issued; no daemon has reported healthy since',
        lastErrorAt: new Date().toISOString(),
        consecutiveFailures: 1,
        lastOkAt: null,
      },
    }), 'utf-8');
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(daemon.pid), 'utf-8');

      const res = run(home, ['doctor', '--json']);
      const problems: string[] = JSON.parse(res.stdout).problems;
      expect(problems.some((p) => p.includes('consecutive failure'))).toBe(false);
      expect(problems.some((p) => p.includes('Daemon is not running'))).toBe(false);
    } finally {
      daemon.kill('SIGKILL');
    }
  });
  it('doctor does not flag "not running" once the daemon is disabled for this device', () => {
    const home = makeHome();
    run(home, ['disable']);
    const res = run(home, ['doctor']);
    expect(res.stdout).not.toContain('Daemon is not running');
  });
  it('stop on a device with no running daemon is a clean no-op', () => {
    const res = run(makeHome(), ['stop']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not running');
  });
  it('reload with no running daemon reports nothing to reload rather than crashing', () => {
    const res = run(makeHome(), ['reload']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('not running');
  });
});
