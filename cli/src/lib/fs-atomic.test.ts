// proper-lockfile clamps stale windows to 2000ms; tests stay above that floor and include a no-heartbeat negative control.
// The atomic-JSON failure test blocks sibling-temp creation, which naive overwrite bypasses; the contended timer proves acquisition stays asynchronous.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { withFileLock, withFileLockAsync, ensureLockTarget, sleepSync, atomicWriteJsonSync } from './fs-atomic.js';

const PROPER_LOCKFILE_MIN_STALE_MS = 2_000;
const STALE_MS = PROPER_LOCKFILE_MIN_STALE_MS + 500;
const HOLD_MS = STALE_MS + 1_500;

function peerVerdictAfterSyncHold(beat: ((heartbeat: () => void) => void) | null): 'stole' | 'blocked' {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-hb-'));
  const target = path.join(dir, 'target');
  ensureLockTarget(target);
  try {
    let verdict: 'stole' | 'blocked' = 'blocked';
    try {
      withFileLock(target, (heartbeat) => {
        const deadline = Date.now() + HOLD_MS;
        while (Date.now() < deadline) {
          if (beat) beat(heartbeat);
          sleepSync(250);
        }
        try {
          const release = lockfile.lockSync(target, { stale: STALE_MS });
          release();
          verdict = 'stole';
        } catch {
          verdict = 'blocked';
        }
      }, { staleMs: STALE_MS, acquireTimeoutMs: 100 });
    } catch (err) {
      if (!/was broken by another process/.test((err as Error).message)) throw err;
      expect(verdict).toBe('stole');
    }
    return verdict;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('withFileLock heartbeat', () => {
  it('pins the proper-lockfile stale floor these tests depend on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-floor-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      const release = lockfile.lockSync(target, { stale: 50 });
      sleepSync(400);
      let peerSawStale = false;
      try { lockfile.lockSync(target, { stale: 50 })(); peerSawStale = true; } catch {  }
      release();
      expect(peerSawStale).toBe(false);
      expect(STALE_MS).toBeGreaterThan(PROPER_LOCKFILE_MIN_STALE_MS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a synchronous hold that outlives the stale window stays un-stealable when it heartbeats', () => {
    expect(peerVerdictAfterSyncHold((heartbeat) => heartbeat())).toBe('blocked');
  });

  it('the same hold IS stolen without the heartbeat — proving the test can fail', () => {
    expect(peerVerdictAfterSyncHold(null)).toBe('stole');
  });

  it('a short hold needs no heartbeat — the lock is held for the whole critical section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-short-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      let blocked = false;
      withFileLock(target, () => {
        try { const release = lockfile.lockSync(target, { stale: 5_000 }); release(); }
        catch { blocked = true; }
      });
      expect(blocked).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ENOTDIR stale-lock self-healing', () => {
  function plantStaleRegularFileLock(target: string): string {
    const lockPath = `${fs.realpathSync(target)}.lock`;
    fs.writeFileSync(lockPath, 'stale');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    return lockPath;
  }

  it('withFileLock recovers when the lock path is a regular file instead of a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-enotdir-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    const lockPath = plantStaleRegularFileLock(target);
    try {
      const result = withFileLock(target, () => 'ok', { acquireTimeoutMs: 10_000 });
      expect(result).toBe('ok');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('withFileLockAsync recovers when the lock path is a regular file instead of a directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-enotdir-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    const lockPath = plantStaleRegularFileLock(target);
    try {
      const result = await withFileLockAsync(target, () => 'ok', { acquireTimeoutMs: 10_000 });
      expect(result).toBe('ok');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('atomicWriteJsonSync()', () => {
  function tmpBase(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-json-'));
  }

  it('round-trips data as pretty-printed JSON', () => {
    const dir = tmpBase();
    try {
      const target = path.join(dir, 'file.json');
      atomicWriteJsonSync(target, { a: 1, b: [2, 3] });
      expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ a: 1, b: [2, 3] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no stray tmp file behind on a normal, uninterrupted write', () => {
    const dir = tmpBase();
    try {
      atomicWriteJsonSync(path.join(dir, 'file.json'), { v: 1 });
      expect(fs.readdirSync(dir)).toEqual(['file.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate(
    'a write that fails leaves the destination with its previous valid content, and no tmp file behind',
    () => {
      const dir = tmpBase();
      try {
        const target = path.join(dir, 'registry.json');
        atomicWriteJsonSync(target, { version: 1 });
        const before = fs.readFileSync(target, 'utf-8');
        expect(JSON.parse(before)).toEqual({ version: 1 });

        fs.chmodSync(dir, 0o555);
        try {
          expect(() => atomicWriteJsonSync(target, { version: 2 })).toThrow();

          const after = fs.readFileSync(target, 'utf-8');
          expect(after).toBe(before);
          expect(JSON.parse(after)).toEqual({ version: 1 });
        } finally {
          fs.chmodSync(dir, 0o755);
        }

        expect(fs.readdirSync(dir)).toEqual(['registry.json']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('withFileLockAsync (non-blocking acquisition)', () => {
  it('runs the critical section and returns its value under the lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-async-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      const held = await withFileLockAsync(target, () => {
        fs.writeFileSync(target, 'written-under-lock');
        return 42;
      });
      expect(held).toBe(42);
      expect(fs.readFileSync(target, 'utf-8')).toBe('written-under-lock');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT freeze the event loop while waiting for a contended lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-async-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      const release = await lockfile.lock(target, { stale: STALE_MS });
      const releaseAt = Date.now() + 600;
      setTimeout(() => { void release(); }, 600);

      let timerFiredAt = 0;
      const t = setTimeout(() => { timerFiredAt = Date.now(); }, 100);

      const acquiredValue = await withFileLockAsync(target, () => 'got-it', { acquireTimeoutMs: 10_000 });
      clearTimeout(t);

      expect(acquiredValue).toBe('got-it');
      expect(timerFiredAt).toBeGreaterThan(0);
      expect(timerFiredAt).toBeLessThan(releaseAt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
