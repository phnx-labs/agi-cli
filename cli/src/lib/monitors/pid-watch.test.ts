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
    // process.pid is this test runner — guaranteed alive for the duration of the call.
    const out = execFileSync('/bin/sh', ['-c', pidLivenessCommand(process.pid, marker)], { encoding: 'utf-8' }).trim();
    expect(out).toBe(PID_WATCH_RUNNING_TOKEN);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reports "notyetspawned" (not "exited") for a dead pid never seen running', () => {
    const marker = tmpMarker('never-seen');
    // A real, guaranteed-dead pid: spawned and waited on already.
    const dead = execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
    const deadPid = Number.parseInt(dead.trim().split('\n')[0], 10);

    const out = execFileSync('/bin/sh', ['-c', pidLivenessCommand(deadPid, marker)], { encoding: 'utf-8' }).trim();

    // PHNX-3023 review finding: a pid that has never been observed alive must
    // NOT report the exit token — a --force watch armed before the process
    // spawns must not look identical to "it ran and then exited".
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

/** PHNX-3023's acceptance bar: a REAL watcher on a REAL backgrounded process must fire when it
 * exits, with only the engine's own poll (`evaluateMonitorOnce`, as `MonitorEngine.tick` does) and
 * no harness hook. The ticket's dead scenario: "5 shells still running" that never alert. */
describe('--watch-pid arms a watcher that actually fires on exit (PHNX-3023)', () => {
  const names: string[] = [];
  afterEach(() => {
    for (const n of names.splice(0)) {
      try { fs.rmSync(getMonitorHistoryDir(n), { recursive: true, force: true }); } catch { /* ignore */ }
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

    // Alive: the source observes 'running', the condition never matches → no fire.
    // This is the "5 shells still running" state — armed, but correctly quiet.
    const aliveOnce = await evaluateMonitorOnce(config);
    expect(aliveOnce.observation?.raw).toBe(PID_WATCH_RUNNING_TOKEN);
    expect(aliveOnce.decision?.fire).toBe(false);

    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    // Dead: the exact same poll the daemon's engine runs on its own schedule now
    // observes the exit and fires — the notify/re-invoke path that never ran
    // for an exit-based hook watching a process that outlives the session.
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
      // The real engine, so state persists across polls as in the daemon. This exposed the bug:
      // match-mode's `hasChanged` treats no prior state as changed, so a first-poll "exited" fired
      // at once and became the baseline, silencing the real exit forever.
      const engine = new MonitorEngine();

      // A pid guaranteed not to belong to any process right now — the --force
      // "arm before it spawns" scenario the review flagged.
      const reserved = execFileSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
      const notYetSpawnedPid = Number.parseInt(reserved.trim().split('\n')[0], 10);
      const beforeConfig = pidWatchMonitor(name, notYetSpawnedPid);

      // Poll before the real process exists: must NOT fire and must NOT
      // record a fire — the exact false positive the review caught.
      await engine.runMonitor(beforeConfig);
      expect(listFires(name)).toHaveLength(0);

      // The real process now spawns and is watched under the SAME monitor
      // name/marker path (pid reuse isn't controllable from a test, so a
      // freshly spawned child stands in for "the pid the caller meant").
      const child = spawn('sleep', ['30']);
      const liveConfig = pidWatchMonitor(name, child.pid!);

      await engine.runMonitor(liveConfig);
      expect(listFires(name)).toHaveLength(0); // running — still no fire

      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));

      await engine.runMonitor(liveConfig);
      // Exactly one fire, and it's the real exit.
      const fires = listFires(name);
      expect(fires).toHaveLength(1);
      expect(fires[0].summary).toContain(PID_WATCH_EXITED_TOKEN);

      // A subsequent poll must not re-fire (dedupe holds once persisted).
      await engine.runMonitor(liveConfig);
      expect(listFires(name)).toHaveLength(1);
    },
  );
});
