import { describe, it, expect } from 'vitest';
import { isPidAlive } from './active';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('isPidAlive pid-reuse guard', () => {
  it('reports a live process as alive (bare existence check)', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('rejects an invalid pid', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it('reports a non-existent pid as dead', () => {
    // 2^31-ish: above any real pid, so process.kill throws ESRCH.
    expect(isPidAlive(2_000_000_000)).toBe(false);
  });

  it('keeps a live process alive when its recorded start matches now', () => {
    expect(isPidAlive(process.pid, Date.now())).toBe(true);
  });

  it('keeps a live process alive within the reuse tolerance', () => {
    // Session recorded 30s ago, process is still that one — under the 60s window.
    expect(isPidAlive(process.pid, Date.now() - 30_000)).toBe(true);
  });

  // The zombie: the pid is alive but its process began long after the session's recorded start
  // (pid recycled). An ancient startedAtMs against our own process reproduces it. Skipped on
  // Windows, where processStartMs returns null and falls back to an existence check.
  posixOnly('reports a reused pid as dead (process far newer than recorded start)', () => {
    expect(isPidAlive(process.pid, 1000)).toBe(false);
  });
});
