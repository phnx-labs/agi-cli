import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  pidLivenessCommand,
  PID_WATCH_EXITED_TOKEN,
  PID_WATCH_NOT_YET_SPAWNED_TOKEN,
  PID_WATCH_RUNNING_TOKEN,
} from './pid-watch.js';
import { evaluateMonitorOnce, MonitorEngine } from './engine.js';
import { getMonitorHistoryDir, listFires } from './state.js';
import type { MonitorConfig } from './config.js';

function tmpMarker(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `pid-watch-${tag}-`)), 'seen-running');
}

describe('pidLivenessCommand (PHNX-3023)', () => {
  it.skipIf(process.platform === 'win32')('reports "running" for a live pid that touches the marker', () => {
    const marker = tmpMarker('live');
    const out = execFileSync('/bin/sh', ['-c', pidLivenessCommand(process.pid, marker)], { encoding: 'utf-8' }).trim();
    expect(out).toBe(PID_WATCH_RUNNING_TOKEN);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reports "notyetspawned" (not "exited") for a dead pid never seen running', () => {
    const marker = tmpMarker('never-seen');
    const dead = execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
    const deadPid = Number.parseInt(dead.trim().split('\n')[0], 10);

    const out = execFileSync('/bin/sh', ['-c', pidLivenessCommand(deadPid, marker)], { encoding: 'utf-8' }).trim();

    expect(out).toBe(PID_WATCH_NOT_YET_SPAWNED_TOKEN);
    expect(out).not.toBe(PID_WATCH_EXITED_TOKEN);
  });

  it.skipIf(process.platform === 'win32')('reports "exited" only after the marker proves it was seen running', () => {
    const marker = tmpMarker('was-alive');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const dead = execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
    const deadPid = Number.parseInt(dead.trim().split('\n')[0], 10);

    const out = execFileSync('/bin/sh', ['-c', pidLivenessCommand(deadPid, marker)], { encoding: 'utf-8' }).trim();

    expect(out).toBe(PID_WATCH_EXITED_TOKEN);
  });
});

describe('--watch-pid arms a watcher that actually fires on exit (PHNX-3023)', () => {
  const names: string[] = [];
  afterEach(() => {
    for (const n of names.splice(0)) {
      try { fs.rmSync(getMonitorHistoryDir(n), { recursive: true, force: true }); } catch {  }
    }
  });

  function pidWatchMonitor(name: string, pid: number): MonitorConfig {
    const marker = path.join(getMonitorHistoryDir(name), 'pid-watch-seen-running');
    return {
      name,
      enabled: true,
      source: { type: 'command', command: pidLivenessCommand(pid, marker) },
      condition: { mode: 'match', match: PID_WATCH_EXITED_TOKEN },
      action: { type: 'notify', notifyChannel: 'telegram' },
    };
  }

  it.skipIf(process.platform === 'win32')('stays silent while the watched process is alive, fires once it exits', async () => {
    const child = spawn('sleep', ['30']);
    const pid = child.pid!;
    const name = `test-pidwatch-${process.pid}-${Date.now()}`;
    names.push(name);
    const config = pidWatchMonitor(name, pid);

    const aliveOnce = await evaluateMonitorOnce(config);
    expect(aliveOnce.observation?.raw).toBe(PID_WATCH_RUNNING_TOKEN);
    expect(aliveOnce.decision?.fire).toBe(false);

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const deadOnce = await evaluateMonitorOnce(config);
    expect(deadOnce.observation?.raw).toBe(PID_WATCH_EXITED_TOKEN);
    expect(deadOnce.decision?.fire).toBe(true);
    expect(deadOnce.decision?.event?.summary).toContain(PID_WATCH_EXITED_TOKEN);
  });

  it.skipIf(process.platform === 'win32')(
    '--force on a not-yet-spawned pid: no false fire before spawn, fires exactly once on the REAL exit (review regression)',
    async () => {
      const name = `test-pidwatch-force-${process.pid}-${Date.now()}`;
      names.push(name);
      const engine = new MonitorEngine();

      const reserved = execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
      const notYetSpawnedPid = Number.parseInt(reserved.trim().split('\n')[0], 10);
      const beforeConfig = pidWatchMonitor(name, notYetSpawnedPid);

      await engine.runMonitor(beforeConfig);
      expect(listFires(name)).toHaveLength(0);

      const child = spawn('sleep', ['30']);
      const liveConfig = pidWatchMonitor(name, child.pid!);

      await engine.runMonitor(liveConfig);
      expect(listFires(name)).toHaveLength(0);

      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));

      await engine.runMonitor(liveConfig);
      const fires = listFires(name);
      expect(fires).toHaveLength(1);
      expect(fires[0].summary).toContain(PID_WATCH_EXITED_TOKEN);

      await engine.runMonitor(liveConfig);
      expect(listFires(name)).toHaveLength(1);
    },
  );
});
