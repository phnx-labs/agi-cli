import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { waitForExit, hasExited, isAlive } from './index.js';


function spawnSleeper(seconds: number) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${seconds * 1000})`], {
    stdio: 'ignore',
  });
  return child;
}

describe.skipIf(process.platform === 'win32')('waitForExit — the wait stopDaemon relies on', () => {
  it('returns true once a SIGTERMed process is actually gone', () => {
    const child = spawnSleeper(30);
    expect(isAlive(child.pid!)).toBe(true);
    process.kill(child.pid!, 'SIGTERM');
    const exited = waitForExit(child.pid!, 5000);
    expect(exited).toBe(true);
    expect(hasExited(child.pid!)).toBe(true);
  });

  it('reports false for a process that ignores SIGTERM, so the caller escalates', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 30000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    process.kill(child.pid!, 'SIGTERM');
    const exited = waitForExit(child.pid!, 300);
    expect(exited).toBe(false);
    expect(hasExited(child.pid!)).toBe(false);
    process.kill(child.pid!, 'SIGKILL');
    expect(waitForExit(child.pid!, 5000)).toBe(true);
  });

  it('returns immediately for a pid that is already gone', () => {
    const child = spawnSleeper(30);
    const pid = child.pid!;
    process.kill(pid, 'SIGKILL');
    waitForExit(pid, 5000);
    const started = Date.now();
    expect(waitForExit(pid, 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
