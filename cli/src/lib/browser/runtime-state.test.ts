import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import {
  writeProfileRuntime,
  readProfileRuntime,
  readProfileRuntimeMeta,
  clearProfileRuntime,
  removeProfileCache,
  listProfileCacheDirs,
  listAllProfileSnapshots,
  isProcessAlive,
  reapOrphanedProcesses,
  adoptProfileRuntimeOwner,
  isProfileInUse,
  planProfilePrune,
} from './runtime-state.js';
import { getBrowserRuntimeDir, getProfileRuntimeDir } from './profiles.js';

// `state.ts` resolves CACHE_DIR from HOME at module-load time, so we can't
// redirect with process.env.HOME from a test. Instead each test uses a
// random profile-name prefix; we track everything we touch and clean it
// up in afterEach.
let prefix: string;
const created: string[] = [];

// Use whatever `ps` reports for THIS process — that's what the matcher
// compares against at runtime. Test runners (vitest, bun) set process.title,
// which mutates /proc/<pid>/comm on Linux, so `path.basename(process.execPath)`
// disagrees with the live ps output. Fall back to execPath basename if `ps`
// is unavailable.
function currentProcessCommand(): string {
  try {
    const out = execFileSync('ps', ['-p', String(process.pid), '-o', 'comm='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return path.basename(out);
  } catch { /* fall through */ }
  return path.basename(process.execPath);
}

function uniq(base: string): string {
  const name = `${prefix}-${base}`;
  created.push(name);
  return name;
}

beforeEach(() => {
  prefix = `tst-${crypto.randomBytes(6).toString('hex')}`;
});

afterEach(() => {
  const root = getBrowserRuntimeDir();
  for (const name of created) {
    const dir = path.join(root, name);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  created.length = 0;
});

describe('writeProfileRuntime + readProfileRuntime', () => {
  it('round-trips pid/port/command for a live process', () => {
    const name = uniq('p1');
    const command = currentProcessCommand();
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command });
    const got = readProfileRuntime(name);
    expect(got).toEqual({ pid: process.pid, port: 9222, command });
  });

  it('returns null and removes files when the pid is dead', () => {
    const name = uniq('p2');
    writeProfileRuntime(name, { pid: 999999, port: 9222 });
    const got = readProfileRuntime(name);
    expect(got).toBeNull();
    const dir = getProfileRuntimeDir(name);
    expect(fs.existsSync(path.join(dir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
  });

  it('returns null when the live pid runs a different command (pid-reuse defense)', () => {
    const name = uniq('p3');
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command: 'ImpossibleBrowserName' });
    expect(readProfileRuntime(name)).toBeNull();
  });

  it('returns the runtime when pid:0 (attached to externally-launched browser)', () => {
    const name = uniq('p4');
    writeProfileRuntime(name, { pid: 0, port: 9222 });
    expect(readProfileRuntime(name)).toEqual({ pid: 0, port: 9222 });
  });

  it('returns null when no files exist', () => {
    expect(readProfileRuntime(uniq('never-written'))).toBeNull();
  });

  it('does not persist a CDP port for pipe-launched browsers', () => {
    const name = uniq('pipe');
    writeProfileRuntime(name, { pid: process.pid, command: currentProcessCommand() });
    const dir = getProfileRuntimeDir(name);

    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
    expect(readProfileRuntime(name)?.port).toBeUndefined();
    expect(readProfileRuntimeMeta(name)?.port).toBeUndefined();
  });
});

describe('clearProfileRuntime', () => {
  it('removes pid/port/command but not chrome-data', () => {
    const name = uniq('p5');
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(path.join(dir, 'chrome-data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chrome-data', 'Local State'), '{}');
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command: 'node' });

    clearProfileRuntime(name);

    expect(fs.existsSync(path.join(dir, 'pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'port'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'command'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'chrome-data', 'Local State'))).toBe(true);
  });

  it('is a no-op when files are already gone', () => {
    expect(() => clearProfileRuntime(uniq('does-not-exist'))).not.toThrow();
  });
});

describe('removeProfileCache', () => {
  it('removes the entire profile directory including chrome-data', () => {
    const name = uniq('p6');
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(path.join(dir, 'chrome-data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chrome-data', 'Local State'), '{}');

    removeProfileCache(name);

    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('listProfileCacheDirs', () => {
  it('matches the legacy non-composite dir AND every composite variant', () => {
    const base = uniq('multi');
    const root = getBrowserRuntimeDir();
    fs.mkdirSync(path.join(root, base), { recursive: true });
    fs.mkdirSync(path.join(root, `${base}@endpoint-0`), { recursive: true });
    fs.mkdirSync(path.join(root, `${base}@remote`), { recursive: true });
    created.push(`${base}@endpoint-0`, `${base}@remote`);

    const found = listProfileCacheDirs(base).map((p) => path.basename(p)).sort();
    expect(found).toEqual([base, `${base}@endpoint-0`, `${base}@remote`].sort());
  });

  it('returns an empty list when no matching dir exists', () => {
    expect(listProfileCacheDirs(uniq('absent'))).toEqual([]);
  });

  it('does not match profiles whose names share a prefix', () => {
    const base = uniq('exact');
    const root = getBrowserRuntimeDir();
    fs.mkdirSync(path.join(root, base), { recursive: true });
    fs.mkdirSync(path.join(root, `${base}-other`), { recursive: true });
    created.push(`${base}-other`);

    const found = listProfileCacheDirs(base).map((p) => path.basename(p));
    expect(found).toEqual([base]);
  });
});

describe('readProfileRuntimeMeta', () => {
  it('returns the full JSON record including daemonPid and spawnedAt', () => {
    const name = uniq('meta');
    writeProfileRuntime(name, {
      pid: process.pid,
      port: 9222,
      command: currentProcessCommand(),
      kind: 'browser',
      userDataDir: '/tmp/nope',
    });
    const meta = readProfileRuntimeMeta(name);
    expect(meta?.pid).toBe(process.pid);
    expect(meta?.kind).toBe('browser');
    expect(meta?.userDataDir).toBe('/tmp/nope');
    expect(meta?.daemonPid).toBe(process.pid);
    expect(typeof meta?.spawnedAt).toBe('number');
  });

  it('returns null when meta.json is missing', () => {
    expect(readProfileRuntimeMeta(uniq('absent'))).toBeNull();
  });
});

describe('reapOrphanedProcesses', () => {
  it('leaves records owned by THIS daemon alone', () => {
    const name = uniq('mine');
    writeProfileRuntime(name, {
      pid: 999999, // dead, but daemonPid is us so we skip
      port: 9222,
      command: 'node',
    });
    const result = reapOrphanedProcesses();
    expect(result.reaped).toBe(0);
    // Meta file still there:
    expect(readProfileRuntimeMeta(name)).not.toBeNull();
  });

  it('reaps records whose daemonPid is dead', () => {
    const name = uniq('orphan');
    // Manually write a meta.json owned by a dead daemon pid.
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        pid: 999998, // dead — kill is a no-op but cleanup must still happen
        port: 9222,
        command: 'node',
        daemonPid: 999997, // also dead
        spawnedAt: Date.now() - 10_000,
      })
    );

    reapOrphanedProcesses();
    // Cleanup should have removed the orphan's runtime files even if the
    // recorded pid was already gone.
    expect(readProfileRuntimeMeta(name)).toBeNull();
  });
});

describe('reapOrphanedProcesses preserves a live browser across daemon replacement', () => {
  /**
   * A REAL long-lived child, recorded the way a launched browser is.
   *
   * Not a mock and not a stand-in for CDP: the reaper's whole decision is
   * "is this pid alive and does it still run the command we recorded", so a real
   * process with a real recorded command is the faithful subject. The CDP/tab-target
   * half of the contract is covered by the live-browser suite.
   */
  function spawnRecorded(name: string, extra: Partial<Parameters<typeof writeProfileRuntime>[1]> = {}) {
    // `sleep` outlives the test and matches its own recorded command.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    writeProfileRuntime(name, {
      pid: child.pid!,
      port: 9222,
      command: 'sleep',
      daemonPid: 999997, // a dead daemon: the replacement case
      ...extra,
    });
    return child;
  }

  it('does NOT signal a live local browser, and leaves its record intact', async () => {
    const name = uniq('live');
    const child = spawnRecorded(name);
    try {
      const before = readProfileRuntimeMeta(name)!;
      const result = reapOrphanedProcesses();

      // The process is untouched — this is the bug: it used to be SIGTERMed.
      expect(isProcessAlive(child.pid!, 'sleep')).toBe(true);
      expect(result.reaped).toBe(0);
      expect(result.details.join(' ')).toContain(`preserved live browser ${child.pid}`);

      // The record survives whole, so the next attach can still find the port.
      const after = readProfileRuntimeMeta(name)!;
      expect(after).toEqual(before);
      // Ownership is deliberately NOT adopted here: only a proven attach may.
      expect(after.daemonPid).toBe(999997);
    } finally { child.kill('SIGKILL'); }
  });

  it('is idempotent — a second replacement still preserves it', async () => {
    const name = uniq('live-twice');
    const child = spawnRecorded(name);
    try {
      reapOrphanedProcesses();
      reapOrphanedProcesses();
      expect(isProcessAlive(child.pid!, 'sleep')).toBe(true);
      expect(readProfileRuntimeMeta(name)).not.toBeNull();
    } finally { child.kill('SIGKILL'); }
  });

  it('still clears a DEAD browser record, without signalling anything', () => {
    const name = uniq('dead');
    const dir = getProfileRuntimeDir(name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      pid: 999998, port: 9222, command: 'node', daemonPid: 999997,
    }));
    const result = reapOrphanedProcesses();
    expect(readProfileRuntimeMeta(name)).toBeNull();
    // Nothing was alive, so nothing was reaped — the record was merely stale.
    expect(result.reaped).toBe(0);
    expect(result.details.join(' ')).toContain('cleared dead browser record 999998');
  });

  it('treats a recycled pid as dead, because the command no longer matches', () => {
    const name = uniq('recycled');
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      // Alive pid, but recorded as a DIFFERENT command — not our browser.
      writeProfileRuntime(name, { pid: child.pid!, port: 9222, command: 'definitely-not-sleep', daemonPid: 999997 });
      reapOrphanedProcesses();
      // Cleared as stale, and crucially the unrelated process is left running.
      expect(readProfileRuntimeMeta(name)).toBeNull();
      expect(isProcessAlive(child.pid!, 'sleep')).toBe(true);
    } finally { child.kill('SIGKILL'); }
  });

  it('reaps a stale tunnel — that IS an orphan — and clears only that record', async () => {
    const name = uniq('tunnel');
    const tunnel = spawn('sleep', ['300'], { stdio: 'ignore' });
    writeProfileRuntime(name, {
      pid: 0,                 // a tunnel record's `pid` is the REMOTE browser
      port: 9222,
      command: 'sleep',
      kind: 'tunnel',
      tunnelPid: tunnel.pid!,
      daemonPid: 999997,
    });
    const result = reapOrphanedProcesses();
    expect(result.details.join(' ')).toContain(`reaped tunnel ${tunnel.pid}`);
    expect(result.reaped).toBe(1);
    // A local ssh -L cannot outlive its purpose, so it really is signalled.
    await vi.waitFor(() => expect(isProcessAlive(tunnel.pid!, 'sleep')).toBe(false), { timeout: 5_000 });
    expect(readProfileRuntimeMeta(name)).toBeNull();
  });

  it('reaps a stale tunnel WITHOUT touching the live browser beside it', async () => {
    // The old code shared one kill path for both, which is how a live browser got
    // caught by tunnel cleanup.
    const name = uniq('both');
    const browser = spawn('sleep', ['300'], { stdio: 'ignore' });
    const tunnel = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      writeProfileRuntime(name, {
        pid: browser.pid!, port: 9222, command: 'sleep',
        kind: 'browser', tunnelPid: tunnel.pid!, daemonPid: 999997,
      });
      reapOrphanedProcesses();
      await vi.waitFor(() => expect(isProcessAlive(tunnel.pid!, 'sleep')).toBe(false), { timeout: 5_000 });
      expect(isProcessAlive(browser.pid!, 'sleep')).toBe(true);
      // The browser record survives so it remains re-attachable.
      expect(readProfileRuntimeMeta(name)).not.toBeNull();
    } finally { browser.kill('SIGKILL'); tunnel.kill('SIGKILL'); }
  });
});

describe('adoptProfileRuntimeOwner', () => {
  it('rewrites daemonPid ALONE, retaining the original launch metadata', () => {
    const name = uniq('adopt');
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      writeProfileRuntime(name, {
        pid: child.pid!, port: 9333, command: 'sleep',
        userDataDir: '/tmp/udd-original', kind: 'browser',
        spawnedAt: 1_700_000_000_000, daemonPid: 999997,
      });
      const before = readProfileRuntimeMeta(name)!;

      expect(adoptProfileRuntimeOwner(name, 4242)).toBe(true);

      const after = readProfileRuntimeMeta(name)!;
      expect(after.daemonPid).toBe(4242);
      // Everything else is the ORIGINAL launch's provenance and must be intact —
      // the reaper and the hygiene pass both read these.
      expect({ ...after, daemonPid: undefined }).toEqual({ ...before, daemonPid: undefined });
    } finally { child.kill('SIGKILL'); }
  });

  it('is a no-op when this daemon already owns it', () => {
    const name = uniq('adopt-own');
    writeProfileRuntime(name, { pid: 1, port: 9334, command: 'sleep' });
    expect(readProfileRuntimeMeta(name)!.daemonPid).toBe(process.pid);
    expect(adoptProfileRuntimeOwner(name)).toBe(true);
    expect(readProfileRuntimeMeta(name)!.daemonPid).toBe(process.pid);
  });

  it('does not recreate a record that has since disappeared', () => {
    const name = uniq('adopt-gone');
    expect(adoptProfileRuntimeOwner(name)).toBe(false);
    expect(readProfileRuntimeMeta(name)).toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns true for the current process when command matches', () => {
    expect(isProcessAlive(process.pid, currentProcessCommand())).toBe(true);
  });

  it('returns false for the current process when command does NOT match', () => {
    expect(isProcessAlive(process.pid, 'NotARealBinary123')).toBe(false);
  });

  it('returns true for pid 0 (sentinel for "attached, not owned")', () => {
    expect(isProcessAlive(0)).toBe(true);
  });

  it('returns false for a definitely-dead pid', () => {
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe('fork runtime cleanup (RUSH-1528)', () => {
  it('clearProfileRuntime on a fork name removes stale fork entries from snapshots', () => {
    const base = uniq('fork-parent');
    const fork2 = `${base}.2`;
    const fork3 = `${base}.3`;
    created.push(fork2, fork3);

    writeProfileRuntime(fork2, { pid: 999990, command: 'chrome' });
    writeProfileRuntime(fork3, { pid: 999991, command: 'chrome' });

    const beforeClear = listAllProfileSnapshots().filter(
      (s) => s.name === fork2 || s.name === fork3,
    );
    expect(beforeClear).toHaveLength(2);

    clearProfileRuntime(fork2);
    clearProfileRuntime(fork3);

    const afterClear = listAllProfileSnapshots().filter(
      (s) => s.name === fork2 || s.name === fork3,
    );
    expect(afterClear.every((s) => s.meta === null)).toBe(true);
  });

  it('listProfileCacheDirs finds composite forks (.N) alongside composites', () => {
    const base = uniq('forkdir');
    const composite = `${base}@endpoint-0`;
    const fork2 = `${composite}.2`;
    const fork3 = `${composite}.3`;
    const root = getBrowserRuntimeDir();
    for (const name of [base, composite, fork2, fork3]) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      created.push(name);
    }

    const found = listProfileCacheDirs(base).map((p) => path.basename(p)).sort();
    expect(found).toEqual([base, composite, fork2, fork3].sort());
  });

  it('repeated fork write + clear leaves no stale snapshots', () => {
    const base = uniq('repeat');
    const fork = `${base}.2`;
    created.push(fork);

    for (let cycle = 0; cycle < 3; cycle++) {
      writeProfileRuntime(fork, { pid: 999980 + cycle, command: 'chrome' });
      expect(readProfileRuntimeMeta(fork)).not.toBeNull();
      clearProfileRuntime(fork);
      expect(readProfileRuntimeMeta(fork)).toBeNull();
    }

    const stale = listAllProfileSnapshots().filter(
      (s) => s.name === fork && s.meta !== null,
    );
    expect(stale).toHaveLength(0);
  });
});

describe('isProfileInUse', () => {
  it('is false for a profile with no runtime dir at all', () => {
    expect(isProfileInUse(uniq('unused'))).toBe(false);
  });

  it('is true while a live browser process is recorded', () => {
    const name = uniq('live');
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command: currentProcessCommand() });
    expect(isProfileInUse(name)).toBe(true);
  });

  it('is false once the recorded process is dead', () => {
    const name = uniq('dead');
    writeProfileRuntime(name, { pid: 999999, port: 9222, command: 'chrome' });
    expect(isProfileInUse(name)).toBe(false);
  });

  it('sees a live COMPOSITE dir, not just <name>', () => {
    // One profile owns several runtime dirs (`<name>@<endpoint>`); prune must
    // not remove a profile whose composite dir is the one that is running.
    const name = uniq('composite');
    const fork = `${name}@endpoint-0`;
    created.push(fork);
    writeProfileRuntime(fork, { pid: process.pid, port: 9222, command: currentProcessCommand() });
    expect(isProfileInUse(name)).toBe(true);
  });

  it('is true when a dir has open tasks even with no live pid', () => {
    const name = uniq('tasks');
    writeProfileRuntime(name, { pid: 999999, port: 9222, command: 'chrome' });
    fs.writeFileSync(path.join(getProfileRuntimeDir(name), 'tasks.json'), JSON.stringify(['t1']));
    expect(isProfileInUse(name)).toBe(true);
  });
});

describe('planProfilePrune', () => {
  const local = (name: string, launchableHere: boolean) =>
    ({ name, scope: 'identity' as const, launchableHere });

  it('never prunes a misfiled profile even when the binary is missing', () => {
    const name = uniq('misfiled-binary');
    const plan = planProfilePrune(
      [{ name, scope: 'fungible' as const, launchableHere: false, misfiledWhy: 'loopback endpoint' }],
    );
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].misfiled).toBe(true);
  });

  it('marks a misfiled profile with a structured flag, not a substring of the reason', () => {
    const name = uniq('misfiled-structured');
    const plan = planProfilePrune([
      { name, scope: 'fungible' as const, launchableHere: true, misfiledWhy: 'loopback endpoint' },
    ]);
    expect(plan.kept[0].misfiled).toBe(true);
    const cleanName = uniq('clean');
    writeProfileRuntime(cleanName, { pid: 999999, port: 9222, command: 'chrome' });
    const clean = planProfilePrune([{ name: cleanName, scope: 'fungible' as const, launchableHere: true }]);
    expect(clean.kept[0].misfiled).toBeUndefined();
  });

  it('reports a misfiled identity profile in the kept reason', () => {
    // Prune never deletes a peer's declaration. A dry run still has to surface
    // the mismatch so the operator sees it.
    const name = uniq('misfiled');
    const plan = planProfilePrune([
      { name, scope: 'fungible' as const, launchableHere: true, misfiledWhy: 'loopback endpoint' },
    ]);
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].why).toContain('MISFILED');
    expect(plan.kept[0].why).toContain('loopback endpoint');
  });

  it('prunes a dead locally-declared profile even when other devices also declare the name', () => {
    const name = uniq('shared');
    const plan = planProfilePrune([{ name, scope: 'fungible' as const, launchableHere: true }]);
    expect(plan.candidates.map((c) => c.name)).toEqual([name]);
    expect(plan.candidates[0].reason).toBe('never-used');
  });

  it('removes a local profile whose browser is not installed here', () => {
    const name = uniq('nobinary');
    // Give it a runtime dir so the verdict is binary-missing, not never-used.
    writeProfileRuntime(name, { pid: 999999, port: 9222, command: 'chrome' });
    const plan = planProfilePrune([local(name, false)]);
    expect(plan.candidates.map((c) => c.name)).toEqual([name]);
    expect(plan.candidates[0].reason).toBe('binary-missing');
  });

  it('removes a local profile that has never been started', () => {
    const name = uniq('neverused');
    const plan = planProfilePrune([local(name, true)]);
    expect(plan.candidates.map((c) => c.name)).toEqual([name]);
    expect(plan.candidates[0].reason).toBe('never-used');
  });

  it('keeps a healthy profile — installed browser plus runtime state', () => {
    const name = uniq('healthy');
    writeProfileRuntime(name, { pid: 999999, port: 9222, command: 'chrome' });
    const plan = planProfilePrune([local(name, true)]);
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].why).toMatch(/healthy/);
  });

  it('never removes a profile that is in use, even with no binary here', () => {
    const name = uniq('busy');
    writeProfileRuntime(name, { pid: process.pid, port: 9222, command: currentProcessCommand() });
    const plan = planProfilePrune([local(name, false)]);
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].why).toMatch(/in use/);
  });

  it('never removes the auto `default` profile', () => {
    const plan = planProfilePrune([local('default', false)]);
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].why).toMatch(/auto-detected default/);
  });

  it("never removes this machine's configured default", () => {
    const name = uniq('mydefault');
    const plan = planProfilePrune([local(name, false)], { configuredDefault: name });
    expect(plan.candidates).toEqual([]);
    expect(plan.kept[0].why).toMatch(/configured default/);
  });



  it('reports the cache dirs it would remove, composites included', () => {
    const name = uniq('withcache');
    const fork = `${name}@endpoint-0`;
    created.push(fork);
    writeProfileRuntime(name, { pid: 999999, port: 9222, command: 'chrome' });
    writeProfileRuntime(fork, { pid: 999998, port: 9223, command: 'chrome' });

    const plan = planProfilePrune([local(name, false)]);
    expect(plan.candidates[0].cacheDirs.map((d) => path.basename(d)).sort()).toEqual(
      [name, fork].sort(),
    );
  });
});
