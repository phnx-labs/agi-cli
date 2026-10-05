/** The launch/update mutual exclusion (PHNX-3940): a launch and an automatic update of the same
 * installation must never both be mid-flight. Real filesystem, real `proper-lockfile` locks and
 * leases; only the vendor fetch is faked via the `UpdateStrategy` seam. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UpdateStrategy, StagedRelease } from './strategies.js';

let home: string;

async function load() {
  vi.resetModules();
  const store = await import('./store.js');
  const update = await import('./update.js');
  const launchGate = await import('./launch-gate.js');
  const shims = await import('./shims.js');
  const activeCheck = await import('./active-check.js');
  return { store, update, launchGate, shims, activeCheck };
}

function makeVersionDir(agent: string, label: string): void {
  fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', agent, label, 'home'), { recursive: true });
}

/** A strategy whose `commit()` never actually touches disk — only ordering/timing matters here. */
function fakeStrategy(opts: { onCommit?: () => Promise<void> | void } = {}): UpdateStrategy {
  return {
    id: 'npm-package',
    transactional: true,
    sharedBinary: false,
    async resolveTarget() {
      return '2.0.66';
    },
    async stage(_ctx, target): Promise<StagedRelease> {
      // A binary that genuinely launches (real `node --version`) so the
      // post-stage health probe in update.ts passes without a vendor fetch.
      return { release: target, binary: process.execPath, home: path.join(home, '.agents'), stagingDir: null };
    },
    async commit() {
      await opts.onCommit?.();
      return { undo: () => {}, finalize: () => {} };
    },
  };
}

describe('launch/update mutual exclusion', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-launch-gate-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a live launch lease makes the installation read as active', async () => {
    const { store, shims, activeCheck } = await load();
    makeVersionDir('claude', '2.0.65');
    const installation = store.createInstallation('claude', '2.0.65', '2.0.65');

    expect(shims.hasLiveLaunchLease('claude', '2.0.65')).toBe(false);
    await expect(activeCheck.isInstallationLikelyActive(installation)).resolves.toBe(false);

    // Our own pid is guaranteed alive for the duration of this test.
    shims.recordLaunchLease('claude', '2.0.65', process.pid);
    expect(shims.hasLiveLaunchLease('claude', '2.0.65')).toBe(true);
    await expect(activeCheck.isInstallationLikelyActive(installation)).resolves.toBe(true);
  });

  it('does not migrate a record while a first install holds its mutation lock', async () => {
    const { store, launchGate } = await load();
    const { withFileLockAsync } = await import('../fs-atomic.js');
    const { installationLockTarget, INSTALLATION_LOCK_OPTIONS } = await import('./installation-lock.js');
    let gate: Promise<void> | undefined;
    await withFileLockAsync(installationLockTarget('claude', 'main'), async () => {
      // Publishing the directory happens only AFTER lock acquisition.
      expect(store.listInstallations('claude')).toEqual([]);
      makeVersionDir('claude', 'main');
      gate = launchGate.withLaunchGate('claude', 'main', () => {});
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(store.readInstallation('claude', 'main')).toBeNull();
      expect(store.listInstallations('claude')).toEqual([]);
      expect(store.readInstallation('claude', 'main')).toBeNull();
      store.createInstallation('claude', 'main', '2.1.220', 'pinned');
    }, INSTALLATION_LOCK_OPTIONS);
    await gate;
    expect(store.readInstallation('claude', 'main')?.releaseVersion).toBe('2.1.220');
    expect(store.readInstallation('claude', 'main')?.updatePolicy).toBe('pinned');
  });

  it('keeps labels ending in .lock disjoint from another installation lock', async () => {
    const { withFileLockAsync, withFileLock } = await import('../fs-atomic.js');
    const { installationLockTarget, INSTALLATION_LOCK_OPTIONS } = await import('./installation-lock.js');
    await withFileLockAsync(installationLockTarget('codex', 'foo'), () => {
      withFileLock(installationLockTarget('codex', 'foo.lock'), () => {},
        { ...INSTALLATION_LOCK_OPTIONS, acquireTimeoutMs: 0 });
    }, INSTALLATION_LOCK_OPTIONS);
  });

  it('refuses a clean repair while an account is leased without removing data or leases', async () => {
    const { store, shims } = await load();
    const { installVersion } = await import('./versions.js');
    makeVersionDir('claude', 'main');
    const before = store.createInstallation('claude', 'main', '2.1.220');
    const record = fs.readFileSync(store.installationRecordPath('claude', 'main'), 'utf8');
    const release = shims.recordLaunchLease('claude', 'main', process.pid);
    try {
      const result = await installVersion('claude', before.releaseVersion, undefined, { installationLabel: 'main', clean: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('in use');
      expect(fs.readFileSync(store.installationRecordPath('claude', 'main'), 'utf8')).toBe(record);
      expect(shims.hasLiveLaunchLease('claude', 'main')).toBe(true);
    } finally { release(); }
  });

  it('a stale lease (dead pid) is pruned and does not defer', async () => {
    const { store, shims } = await load();
    makeVersionDir('claude', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');

    // A pid essentially guaranteed not to be alive right now.
    shims.recordLaunchLease('claude', '2.0.65', 999_999);
    expect(shims.hasLiveLaunchLease('claude', '2.0.65')).toBe(false);
  });

  it('keeps the launcher leased across the pre-spawn gap without holding the update lock', async () => {
    const { store, launchGate, shims } = await load();
    makeVersionDir('claude', 'main');
    store.createInstallation('claude', 'main', '2.0.65');
    await launchGate.withInstallationLease('claude', 'main', async () => {
      await launchGate.withLaunchGate('claude', 'main', () => {});
      expect(shims.hasLiveLaunchLease('claude', 'main')).toBe(true);
    });
    expect(shims.hasLiveLaunchLease('claude', 'main')).toBe(false);
  });

  it('refuses to launch if a durable lease cannot be written', async () => {
    const { store, launchGate } = await load();
    makeVersionDir('claude', 'main');
    store.createInstallation('claude', 'main', '2.0.65');
    fs.writeFileSync(path.join(home, '.agents', '.history', 'versions', 'claude', 'main', '.launch-leases'), 'occupied');
    let launched = false;
    await expect(launchGate.withInstallationLease('claude', 'main', async () => { launched = true; })).rejects.toThrow();
    expect(launched).toBe(false);
  });

  it('does not treat a recycled PID as the leased process', async () => {
    const { store, shims } = await load();
    makeVersionDir('claude', 'main');
    store.createInstallation('claude', 'main', '2.0.65');
    const dir = path.join(home, '.agents', '.history', 'versions', 'claude', 'main', '.launch-leases');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, birth: 'definitely-not-this-process' }));
    expect(shims.hasLiveLaunchLease('claude', 'main')).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([`${process.pid}.json`]); // read-only preview
  });

  it('a launch (withLaunchGate) waits for an in-progress update of the SAME installation to finish', async () => {
    const { store, update, launchGate } = await load();
    makeVersionDir('claude', '2.0.65');
    const installation = store.createInstallation('claude', '2.0.65', '2.0.65');

    let commitStarted = false;
    let commitFinished = false;
    let reachedCommit!: () => void;
    const commitReached = new Promise<void>((resolve) => { reachedCommit = resolve; });
    const updatePromise = update
      .updateInstallation(installation, {
        strategy: fakeStrategy({
          onCommit: async () => {
            commitStarted = true;
            reachedCommit();
            await new Promise((r) => setTimeout(r, 300));
            commitFinished = true;
          },
        }),
      })
      .catch(() => { /* the post-commit live-probe fails in this fake setup — only timing matters here */ });

    await commitReached;
    expect(commitStarted).toBe(true);
    expect(commitFinished).toBe(false);

    const waitStartedAt = Date.now();
    await launchGate.withLaunchGate('claude', '2.0.65', () => {});
    const waitedMs = Date.now() - waitStartedAt;

    // The launch gate could only resolve once the update released the lock —
    // i.e. after commit() finished, not while it was in flight.
    expect(commitFinished).toBe(true);
    expect(waitedMs).toBeGreaterThanOrEqual(200);

    await updatePromise;
  });

  it('an in-flight launch gate blocks a concurrent update from even starting its transaction', async () => {
    const { store, update, launchGate } = await load();
    makeVersionDir('claude', '2.0.65');
    const installation = store.createInstallation('claude', '2.0.65', '2.0.65');

    let releaseGate: () => void = () => {};
    const gateAcquired = new Promise<void>((resolveAcquired) => {
      void launchGate.withLaunchGate('claude', '2.0.65', () => {
        resolveAcquired();
        return new Promise<void>((r) => { releaseGate = r; });
      });
    });
    await gateAcquired;

    let updateResolved = false;
    const updatePromise = update
      .updateInstallation(installation, { strategy: fakeStrategy() })
      .then(() => { updateResolved = true; })
      .catch(() => { updateResolved = true; });

    await new Promise((r) => setTimeout(r, 200));
    expect(updateResolved).toBe(false); // still waiting on the lock the launch gate holds

    releaseGate();
    await updatePromise;
    expect(updateResolved).toBe(true);
  });
});
