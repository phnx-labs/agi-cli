/** The update transaction on a real filesystem with a real strategy: it stages files, swaps
 * directories and runs real staged executables through the launch probe, so swap, probe and
 * rollback are production paths. A release that can't launch must never replace one that can. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CommitHandles, StagedRelease, UpdateContext, UpdateStrategy } from './strategies.js';

let home: string;

async function load() {
  vi.resetModules();
  return {
    update: await import('./update.js'),
    store: await import('./store.js'),
    strategies: await import('./strategies.js'),
    versions: await import('./versions.js'),
    shims: await import('./shims.js'),
    policy: await import('./update-policy.js'),
  };
}

function versionDir(label: string): string {
  return path.join(home, '.agents', '.history', 'versions', 'claude', label);
}

const IS_WIN = process.platform === 'win32';

/** A real, launchable stand-in for a vendor binary. Windows also gets the `.cmd` wrapper the
 * launch probe runs (`verifyBinaryLaunches`); with only the extensionless file every Windows
 * probe passed vacuously and failed-launch tests never saw a failure. */
function writeLaunchableBinary(binDir: string, release: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\necho ${release}\n`);
  fs.chmodSync(file, 0o755);
  if (IS_WIN) fs.writeFileSync(`${file}.cmd`, `@echo off\r\necho ${release}\r\n`);
}

/** A release that is present but cannot start (the gutted-install case). POSIX: no launch target
 * ("binary not found"). Windows: the `.cmd` wrapper survives and emits the "is not recognized"
 * message the probe matches (a missing `.cmd` is treated as healthy by design). */
function writeUnlaunchableBinary(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  if (IS_WIN) {
    fs.writeFileSync(
      path.join(binDir, 'claude.cmd'),
      '@echo off\r\necho \'claude.exe\' is not recognized as an internal or external command\r\nexit /b 1\r\n'
    );
  }
}

/** Remove the live launch target the way a broken install would leave it. */
function breakLiveBinary(label: string): void {
  const binDir = path.join(versionDir(label), 'node_modules', '.bin');
  fs.rmSync(path.join(binDir, 'claude'), { force: true });
  fs.rmSync(path.join(binDir, 'claude.cmd'), { force: true });
  writeUnlaunchableBinary(binDir);
}

/** Lay down an installed release the way the npm strategy's swap expects it. */
function writeLiveRelease(label: string, release: string): void {
  const dir = versionDir(label);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  writeLaunchableBinary(path.join(dir, 'node_modules', '.bin'), release);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'live', release }));
}

/** A real npm-shaped strategy: stages into a sibling dir and reuses the production commit/undo,
 * so the swap under test is the shipped one. */
function fileStrategy(
  target: string,
  opts: { launchable: boolean; commit: UpdateStrategy['commit'] }
): UpdateStrategy {
  return {
    id: 'npm-package',
    transactional: true,
    sharedBinary: false,
    async resolveTarget() { return target; },
    async stage(ctx: UpdateContext): Promise<StagedRelease> {
      const dir = versionDir(ctx.installation.label);
      const stagingDir = path.join(dir, '.staging-test');
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify({ name: 'staged', target }));
      if (opts.launchable) writeLaunchableBinary(path.join(stagingDir, 'node_modules', '.bin'), target);
      else writeUnlaunchableBinary(path.join(stagingDir, 'node_modules', '.bin'));
      return {
        release: target,
        binary: path.join(stagingDir, 'node_modules', '.bin', 'claude'),
        home: path.join(dir, 'home'),
        stagingDir,
      };
    },
    commit: opts.commit,
  };
}

describe('updateInstallation', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('moves the release forward and leaves the installation name and id untouched', async () => {
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    const outcome = await update.updateInstallation(before, {
      to: '2.1.220',
      strategy: fileStrategy('2.1.220', {
        launchable: true,
        commit: strategies.selectUpdateStrategy('claude').commit,
      }),
    });

    expect(outcome.unchanged).toBe(false);
    expect(outcome.fromRelease).toBe('2.0.65');
    expect(outcome.toRelease).toBe('2.1.220');
    expect(outcome.installation.id).toBe(before.id);
    expect(outcome.installation.label).toBe('2.0.65');
    // The swap really happened: the live binary is the staged one.
    expect(fs.readFileSync(path.join(versionDir('2.0.65'), 'node_modules', '.bin', 'claude'), 'utf-8'))
      .toContain('echo 2.1.220');
    // Staging scratch is gone, and no rollback material is left behind.
    expect(fs.readdirSync(versionDir('2.0.65')).filter((e) => e.startsWith('.staging') || e.startsWith('.rollback')))
      .toEqual([]);
  });

  it('records a requested pin together with its release before a competing automatic pass', async () => {
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');
    const strategy = fileStrategy('2.1.220', { launchable: true, commit: strategies.selectUpdateStrategy('claude').commit });
    const manual = await update.updateInstallation(before, { to: '2.1.220', updatePolicy: 'pinned', strategy });
    expect(manual.installation.updatePolicy).toBe('pinned');
    const automatic = await update.updateInstallation(before, {
      to: '2.1.221', abortIfPinnedBeforeCommit: true,
      strategy: fileStrategy('2.1.221', { launchable: true, commit: strategies.selectUpdateStrategy('claude').commit }),
    });
    expect(automatic.deferred).toBeTruthy();
    expect(store.readInstallation('claude', before.label)?.releaseVersion).toBe('2.1.220');
  });

  it('does not persist a requested pin when an active home defers the target', async () => {
    const { update, store } = await load();
    const { recordLaunchLease } = await import('./shims.js');
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');
    const release = recordLaunchLease('claude', before.label, process.pid);
    try {
      const outcome = await update.updateInstallation(before, { to: '2.1.220', updatePolicy: 'pinned' });
      expect(outcome.deferred).toBeTruthy();
      expect(store.readInstallation('claude', before.label)?.updatePolicy).toBe('latest');
      expect(store.readInstallation('claude', before.label)?.releaseVersion).toBe('2.0.65');
    } finally { release(); }
  });

  it('finishes the record safely if cancellation arrives after the binary swap', async () => {
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');
    let cancelled = false;
    const outcome = await update.updateInstallation(before, {
      to: '2.1.220', shouldCancel: () => cancelled,
      strategy: fileStrategy('2.1.220', { launchable: true, commit: async (ctx, staged) => {
        const handle = await strategies.selectUpdateStrategy('claude').commit(ctx, staged);
        cancelled = true;
        return handle;
      } }),
    });
    expect(outcome.unchanged).toBe(false);
    expect(store.readInstallation('claude', before.label)?.releaseVersion).toBe('2.1.220');
    expect(fs.readdirSync(versionDir(before.label)).filter(e => e.startsWith('.rollback'))).toEqual([]);
  });

  it('keeps every persisted reference to the installation resolving after the release moves', async () => {
    const { update, store, strategies, versions } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');
    // The reference model under test: defaults are stored as the label.
    versions.setGlobalDefault('claude', '2.0.65');

    await update.updateInstallation(before, {
      to: '2.1.220',
      strategy: fileStrategy('2.1.220', {
        launchable: true,
        commit: strategies.selectUpdateStrategy('claude').commit,
      }),
    });

    // Unchanged pointer, still pointing at a real installation carrying the new release.
    expect(versions.getGlobalDefault('claude')).toBe('2.0.65');
    expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.1.220');
    expect(versions.getVersionDir('claude', '2.0.65')).toBe(versionDir('2.0.65'));
  });

  it('discards a staged release that cannot launch and leaves the working one live', async () => {
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    await expect(update.updateInstallation(before, {
      to: '2.1.220',
      strategy: fileStrategy('2.1.220', {
        launchable: false,
        commit: strategies.selectUpdateStrategy('claude').commit,
      }),
    })).rejects.toThrow(/failed to launch/);

    // Nothing was swapped: the old release is still the live one, and the record
    // still says so.
    expect(fs.readFileSync(path.join(versionDir('2.0.65'), 'node_modules', '.bin', 'claude'), 'utf-8'))
      .toContain('echo 2.0.65');
    expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.0.65');
    expect(store.readInstallation('claude', '2.0.65')?.history).toHaveLength(1);
    expect(fs.existsSync(path.join(versionDir('2.0.65'), '.staging-test'))).toBe(false);
  });

  it('rolls back to the previous release when the swapped-in one fails its live probe', async () => {
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    const realCommit = strategies.selectUpdateStrategy('claude').commit;
    // Stage something launchable, then destroy the live binary right after the
    // swap — the real "release installed but broken on disk" failure.
    const sabotagingCommit: UpdateStrategy['commit'] = async (ctx, staged): Promise<CommitHandles> => {
      const handles = await realCommit(ctx, staged);
      breakLiveBinary(ctx.installation.label);
      return handles;
    };

    await expect(update.updateInstallation(before, {
      to: '2.1.220',
      strategy: fileStrategy('2.1.220', { launchable: true, commit: sabotagingCommit }),
    })).rejects.toThrow(/Rolled back to 2\.0\.65/);

    // The previous release is back, byte for byte, and still recorded.
    expect(fs.readFileSync(path.join(versionDir('2.0.65'), 'node_modules', '.bin', 'claude'), 'utf-8'))
      .toContain('echo 2.0.65');
    expect(JSON.parse(fs.readFileSync(path.join(versionDir('2.0.65'), 'package.json'), 'utf-8')).name).toBe('live');
    expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.0.65');
    expect(fs.readdirSync(versionDir('2.0.65')).filter((e) => e.startsWith('.rollback'))).toEqual([]);
  });

  it('restores the version directory even when the strategy is not transactional', async () => {
    // An installer-driven harness can't put the vendor binary back, but it still displaced this
    // installation's own tree; gating the undo on `transactional` left the broken release live and
    // orphaned the working one in rollback material nothing deleted.
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    const realCommit = strategies.selectUpdateStrategy('claude').commit;
    const sabotagingCommit: UpdateStrategy['commit'] = async (ctx, staged) => {
      const handles = await realCommit(ctx, staged);
      breakLiveBinary(ctx.installation.label);
      return handles;
    };
    const nonTransactional: UpdateStrategy = {
      ...fileStrategy('2.1.220', { launchable: true, commit: sabotagingCommit }),
      transactional: false,
    };

    await expect(update.updateInstallation(before, { to: '2.1.220', strategy: nonTransactional }))
      .rejects.toThrow(/repair it with: agents add claude@latest/);

    expect(fs.readFileSync(path.join(versionDir('2.0.65'), 'node_modules', '.bin', 'claude'), 'utf-8'))
      .toContain('echo 2.0.65');
    expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.0.65');
    // No orphaned rollback material.
    expect(fs.readdirSync(versionDir('2.0.65')).filter((e) => e.startsWith('.rollback'))).toEqual([]);
  });

  it('reports no change when the installer lands on the release already installed', async () => {
    // A self-updating binary that was already current: the strategy cannot know
    // the release until after it runs, so the equality check has to happen after
    // staging. Recording it would claim a change and append a bogus history row.
    const { update, store } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    const alreadyCurrent: UpdateStrategy = {
      id: 'global-binary',
      transactional: false,
      sharedBinary: true,
      async resolveTarget() { return 'latest'; },
      async stage(ctx) {
        return {
          release: '2.0.65',
          binary: path.join(versionDir(ctx.installation.label), 'node_modules', '.bin', 'claude'),
          home: path.join(versionDir(ctx.installation.label), 'home'),
          stagingDir: null,
        };
      },
      async commit() { return { undo: () => {}, finalize: () => {} }; },
    };

    const outcome = await update.updateInstallation(before, { to: 'latest', strategy: alreadyCurrent });
    expect(outcome.unchanged).toBe(true);
    expect(outcome.toRelease).toBe('2.0.65');
    expect(store.readInstallation('claude', '2.0.65')?.history).toHaveLength(1);
  });

  it('does nothing when the installation already carries the requested release', async () => {
    const { update, store, strategies } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    const outcome = await update.updateInstallation(before, {
      to: '2.0.65',
      strategy: fileStrategy('2.0.65', {
        launchable: true,
        commit: strategies.selectUpdateStrategy('claude').commit,
      }),
    });

    expect(outcome.unchanged).toBe(true);
    expect(store.readInstallation('claude', '2.0.65')?.history).toHaveLength(1);
  });

  it('rejects a release token that could escape a path or a package spec', async () => {
    const { update, store } = await load();
    writeLiveRelease('2.0.65', '2.0.65');
    const before = store.createInstallation('claude', '2.0.65', '2.0.65');

    await expect(update.updateInstallation(before, { to: '../../etc' })).rejects.toThrow(/Invalid release/);
  });

  it('records the new release on every installation that shares one global binary', async () => {
    const { update, store } = await load();
    // Two installations of a global-binary harness point at the same file, so an
    // update to one is an update to all — the record must not claim otherwise.
    for (const label of ['0.30.0', '0.31.0']) {
      fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'droid', label, 'home'), { recursive: true });
    }
    const first = store.createInstallation('droid', '0.30.0', '0.30.0');
    store.createInstallation('droid', '0.31.0', '0.31.0');

    const shared: UpdateStrategy = {
      id: 'global-binary',
      transactional: false,
      sharedBinary: true,
      async resolveTarget() { return '0.40.0'; },
      async stage(ctx) {
        // The installer already replaced the shared binary; nothing per-install.
        const binDir = path.join(home, 'shared-bin');
        writeLaunchableBinary(binDir, '0.40.0');
        return {
          release: '0.40.0',
          binary: path.join(binDir, 'claude'),
          home: path.join(versionDir(ctx.installation.label), 'home'),
          stagingDir: null,
        };
      },
      async commit() { return { undo: () => {}, finalize: () => {} }; },
    };

    // droid's live binary is global; point the post-commit probe at a real one.
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeLaunchableBinary(path.join(home, '.local', 'bin'), '0.40.0');
    fs.renameSync(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.local', 'bin', 'droid'));

    const outcome = await update.updateInstallation(first, { to: 'latest', strategy: shared });

    expect(outcome.toRelease).toBe('0.40.0');
    expect(outcome.alsoUpdated.map((i) => i.label)).toEqual(['0.31.0']);
    expect(store.readInstallation('droid', '0.31.0')?.releaseVersion).toBe('0.40.0');
    // Identity is still per-installation even though the binary is shared.
    expect(store.readInstallation('droid', '0.31.0')?.id)
      .not.toBe(store.readInstallation('droid', '0.30.0')?.id);
  });

  describe('the mandatory live-process/launch-lease check (PHNX-3940)', () => {
    it('a live launch lease held BEFORE the call blocks staging entirely, even for a manual (non-automatic) call', async () => {
      const { update, store, strategies, shims } = await load();
      writeLiveRelease('2.0.65', '2.0.65');
      const before = store.createInstallation('claude', '2.0.65', '2.0.65');
      shims.recordLaunchLease('claude', '2.0.65', process.pid); // guaranteed-alive pid

      let staged = false;
      const strategy = fileStrategy('2.1.220', {
        launchable: true,
        commit: strategies.selectUpdateStrategy('claude').commit,
      });

      // No `abortIfPinnedBeforeCommit`/`abortIfAutoDisabledBeforeCommit` set —
      // this is exactly a manual `agents update` call. The active check must
      // still fire: it is unconditional for a transactional strategy.
      const outcome = await update.updateInstallation(before, {
        to: '2.1.220',
        strategy: { ...strategy, async stage(ctx, target) { staged = true; return strategy.stage(ctx, target); } },
      });

      expect(outcome.unchanged).toBe(true);
      expect(staged).toBe(false); // never even reached stage() — the pre-stage check fired
      expect(fs.readFileSync(path.join(versionDir('2.0.65'), 'node_modules', '.bin', 'claude'), 'utf-8'))
        .toContain('echo 2.0.65');
      expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.0.65');
      expect(store.readInstallation('claude', '2.0.65')?.history).toHaveLength(1);
    });

    it('a launch lease that appears DURING staging blocks the commit, closing the plan-then-launch race', async () => {
      const { update, store, strategies, shims } = await load();
      writeLiveRelease('2.0.65', '2.0.65');
      const before = store.createInstallation('claude', '2.0.65', '2.0.65');

      const realCommit = strategies.selectUpdateStrategy('claude').commit;
      let committed = false;
      const base = fileStrategy('2.1.220', {
        launchable: true,
        commit: async (ctx, staged) => { committed = true; return realCommit(ctx, staged); },
      });
      // Simulates a launch starting mid-staging — the exact race the pre-stage
      // check alone cannot close (staging a real npm package can take minutes).
      const strategyWithLateLease: UpdateStrategy = {
        ...base,
        async stage(ctx, target) {
          const result = await base.stage(ctx, target);
          shims.recordLaunchLease('claude', '2.0.65', process.pid);
          return result;
        },
      };

      const outcome = await update.updateInstallation(before, { to: '2.1.220', strategy: strategyWithLateLease });

      expect(outcome.unchanged).toBe(true);
      expect(committed).toBe(false); // staged, but never swapped in
      expect(fs.readFileSync(path.join(versionDir('2.0.65'), 'node_modules', '.bin', 'claude'), 'utf-8'))
        .toContain('echo 2.0.65');
      expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.0.65');
    });

    it('a non-transactional strategy (no reversible swap) is not gated by the active check', async () => {
      // The active check protects a SWAP; a global-binary/install-script
      // strategy has none, so a live lease must not block it — matching the
      // eligibility narrowing `update-runtime.ts` already documents.
      const { update, store, shims } = await load();
      writeLiveRelease('2.0.65', '2.0.65');
      const before = store.createInstallation('claude', '2.0.65', '2.0.65');
      shims.recordLaunchLease('claude', '2.0.65', process.pid);

      const globalBinary: UpdateStrategy = {
        id: 'global-binary',
        transactional: false,
        sharedBinary: true,
        async resolveTarget() { return '2.1.220'; },
        async stage(ctx) {
          writeLaunchableBinary(path.join(versionDir(ctx.installation.label), 'node_modules', '.bin'), '2.1.220');
          return {
            release: '2.1.220',
            binary: path.join(versionDir(ctx.installation.label), 'node_modules', '.bin', 'claude'),
            home: path.join(versionDir(ctx.installation.label), 'home'),
            stagingDir: null,
          };
        },
        async commit() { return { undo: () => {}, finalize: () => {} }; },
      };

      const outcome = await update.updateInstallation(before, { to: '2.1.220', strategy: globalBinary });

      expect(outcome.unchanged).toBe(false);
      expect(outcome.toRelease).toBe('2.1.220');
    });
  });

  describe('recheck of updates.auto before an automatic-pass commit (PHNX-3940)', () => {
    it('turning global auto-updates off DURING staging aborts an automatic-pass commit', async () => {
      const { update, store, strategies, policy } = await load();
      writeLiveRelease('2.0.65', '2.0.65');
      const before = store.createInstallation('claude', '2.0.65', '2.0.65');

      const realCommit = strategies.selectUpdateStrategy('claude').commit;
      let committed = false;
      const base = fileStrategy('2.1.220', {
        launchable: true,
        commit: async (ctx, staged) => { committed = true; return realCommit(ctx, staged); },
      });
      const strategy: UpdateStrategy = {
        ...base,
        async stage(ctx, target) {
          const result = await base.stage(ctx, target);
          policy.setGlobalAutoUpdateEnabled(false); // the download "just finished" when the switch flips
          return result;
        },
      };

      const outcome = await update.updateInstallation(before, {
        to: '2.1.220',
        strategy,
        abortIfAutoDisabledBeforeCommit: true,
      });

      expect(outcome.unchanged).toBe(true);
      expect(committed).toBe(false);
      expect(store.readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.0.65');
      expect(store.readInstallation('claude', '2.0.65')?.history).toHaveLength(1);
    });

    it('turning the PER-HARNESS switch off DURING staging also aborts, not just the global kill switch', async () => {
      const { update, store, strategies, policy } = await load();
      writeLiveRelease('2.0.65', '2.0.65');
      const before = store.createInstallation('claude', '2.0.65', '2.0.65');

      const realCommit = strategies.selectUpdateStrategy('claude').commit;
      let committed = false;
      const base = fileStrategy('2.1.220', {
        launchable: true,
        commit: async (ctx, staged) => { committed = true; return realCommit(ctx, staged); },
      });
      const strategy: UpdateStrategy = {
        ...base,
        async stage(ctx, target) {
          const result = await base.stage(ctx, target);
          policy.setAgentAutoUpdateEnabled('claude', false);
          return result;
        },
      };

      const outcome = await update.updateInstallation(before, {
        to: '2.1.220',
        strategy,
        abortIfAutoDisabledBeforeCommit: true,
      });

      expect(outcome.unchanged).toBe(true);
      expect(committed).toBe(false);
    });

    it('a manual call ignores the updates.auto switch entirely — only the automatic pass rechecks it', async () => {
      const { update, store, strategies, policy } = await load();
      writeLiveRelease('2.0.65', '2.0.65');
      const before = store.createInstallation('claude', '2.0.65', '2.0.65');
      policy.setGlobalAutoUpdateEnabled(false);

      const outcome = await update.updateInstallation(before, {
        to: '2.1.220',
        strategy: fileStrategy('2.1.220', {
          launchable: true,
          commit: strategies.selectUpdateStrategy('claude').commit,
        }),
        // abortIfAutoDisabledBeforeCommit deliberately unset — a manual call.
      });

      expect(outcome.unchanged).toBe(false);
      expect(outcome.toRelease).toBe('2.1.220');
    });
  });
});
