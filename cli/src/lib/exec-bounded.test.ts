import { describe, it, expect } from 'vitest';
import { execFileBounded } from './exec-bounded.js';

// Real subprocesses, no mocks. POSIX-only assertions guard the process-group
// behaviour; the Windows tree-kill path is exercised by the live Windows e2e
// lane, not this Linux-required suite.
const posix = process.platform !== 'win32';

describe('execFileBounded', () => {
  it('captures stdout, stderr and a zero exit code from a normal run', async () => {
    const res = await execFileBounded('node', ['-e', 'process.stdout.write("out");process.stderr.write("err")'], { timeoutMs: 5_000 });
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe('out');
    expect(res.stderr).toBe('err');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const res = await execFileBounded('node', ['-e', 'process.exit(3)'], { timeoutMs: 5_000 });
    expect(res.code).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  it('reports a spawn error (missing binary) instead of throwing', async () => {
    const res = await execFileBounded('this-binary-does-not-exist-xyz', [], { timeoutMs: 5_000 });
    expect(res.code).toBeNull();
    expect(res.stderr).toMatch(/ENOENT|not found|spawn/i);
  });

  it('times out a slow child and flags timedOut', async () => {
    const start = Date.now();
    const res = await execFileBounded('node', ['-e', 'setTimeout(()=>{}, 60_000)'], { timeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(res.timedOut).toBe(true);
    // Killed well before its 60s sleep; generous ceiling for CI jitter.
    expect(elapsed).toBeLessThan(10_000);
  });

  it.runIf(posix)('kills the whole process group, not just the direct child', async () => {
    // Parent forks a detached grandchild that writes its pid, then the parent
    // sleeps. On timeout we SIGKILL the GROUP — the grandchild must die too.
    const script = `
      const { spawn } = require('child_process');
      const gc = spawn('node', ['-e', 'process.stdout.write(String(process.pid));setTimeout(()=>{},60000)'], { stdio: ['ignore','pipe','ignore'] });
      gc.stdout.on('data', d => process.stdout.write('GC:'+d));
      setTimeout(()=>{}, 60000);
    `;
    const res = await execFileBounded('node', ['-e', script], { timeoutMs: 800 });
    expect(res.timedOut).toBe(true);
    const m = res.stdout.match(/GC:(\d+)/);
    expect(m).not.toBeNull();
    const gcPid = Number(m![1]);
    // Give the group kill a beat to propagate to the grandchild.
    await new Promise((r) => setTimeout(r, 500));
    let gcAlive = true;
    try { process.kill(gcPid, 0); } catch { gcAlive = false; }
    expect(gcAlive).toBe(false);
  });

  it('does NOT block the event loop while the child runs', async () => {
    // A synchronous execFileSync of this sleep would freeze the loop for its whole duration, so a
    // timer scheduled alongside could not fire until it returned. With execFileBounded the loop
    // stays live: the timer fires while the child is still running.
    let timerFired = false;
    const t = setTimeout(() => { timerFired = true; }, 100);
    const execPromise = execFileBounded('node', ['-e', 'setTimeout(()=>{}, 700)'], { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(timerFired).toBe(true); // loop was never frozen
    clearTimeout(t);
    const res = await execPromise;
    expect(res.code).toBe(0);
  });
});
