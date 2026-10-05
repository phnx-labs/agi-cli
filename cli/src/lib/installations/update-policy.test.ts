/** The switches that gate the automatic-update pass (PHNX-3940), on a real filesystem with HOME
 * redirected so `state.ts`/`device-config.ts` resolve `agents.yaml` there. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  vi.resetModules();
  const store = await import('./store.js');
  const policy = await import('./update-policy.js');
  const fsAtomic = await import('../fs-atomic.js');
  const lock = await import('./installation-lock.js');
  return { store, policy, fsAtomic, lock };
}

function makeVersionDir(agent: string, label: string): void {
  fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', agent, label, 'home'), { recursive: true });
}

describe('update-policy', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-policy-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('effectiveUpdatePolicy', () => {
    it('legacy/absent updatePolicy defaults to latest', async () => {
      const { policy } = await load();
      expect(policy.effectiveUpdatePolicy({ updatePolicy: undefined })).toBe('latest');
      expect(policy.effectiveUpdatePolicy({})).toBe('latest');
    });

    it('reflects an explicitly pinned installation', async () => {
      const { store, policy } = await load();
      makeVersionDir('claude', '2.0.65');
      const installation = store.createInstallation('claude', '2.0.65', '2.0.65');
      expect(policy.effectiveUpdatePolicy(installation)).toBe('latest');

      const pinned = await policy.setInstallationUpdatePolicy('claude', '2.0.65', 'pinned');
      expect(policy.effectiveUpdatePolicy(pinned)).toBe('pinned');
      // Reload from disk — the write must have persisted, not just returned an in-memory copy.
      expect(policy.effectiveUpdatePolicy(store.readInstallation('claude', '2.0.65')!)).toBe('pinned');

      const unpinned = await policy.setInstallationUpdatePolicy('claude', '2.0.65', 'latest');
      expect(policy.effectiveUpdatePolicy(unpinned)).toBe('latest');
    });

    it('never touches history or releaseVersion when pinning/unpinning', async () => {
      const { store, policy } = await load();
      makeVersionDir('claude', '2.0.65');
      const installation = store.createInstallation('claude', '2.0.65', '2.0.65');
      const pinned = await policy.setInstallationUpdatePolicy('claude', '2.0.65', 'pinned');
      expect(pinned.releaseVersion).toBe('2.0.65');
      expect(pinned.history).toEqual(installation.history);
    });

    it('throws a clear error for a label with no installation directory at all', async () => {
      const { policy } = await load();
      await expect(policy.setInstallationUpdatePolicy('claude', 'does-not-exist', 'pinned')).rejects.toThrow();
    });

    it('takes the SAME lock (path + options) update.ts holds for its transaction, so a policy write QUEUES behind it instead of racing (PHNX-3940)', async () => {
      const { store, policy, fsAtomic, lock } = await load();
      makeVersionDir('claude', '2.0.65');
      store.createInstallation('claude', '2.0.65', '2.0.65');
      const recordPath = lock.installationLockTarget('claude', '2.0.65');

      let releaseHold: () => void = () => {};
      const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
      const order: string[] = [];

      // Stand in for update.ts's own long-held lock on the identical record
      // path, using the exact options it uses — the leaf both files import.
      const holderPromise = fsAtomic.withFileLockAsync(recordPath, async () => {
        order.push('holder:acquired');
        await hold;
        order.push('holder:releasing');
      }, lock.INSTALLATION_LOCK_OPTIONS);

      await new Promise((resolve) => setTimeout(resolve, 20)); // let the holder acquire first

      const policyPromise = policy.setInstallationUpdatePolicy('claude', '2.0.65', 'pinned')
        .then((result) => { order.push('policy:wrote'); return result; });

      await new Promise((resolve) => setTimeout(resolve, 20));
      // The policy write must still be queued behind the held lock — a
      // fs-atomic-default (5s) stale threshold on either side would have let
      // it break in and write concurrently instead.
      expect(order).toEqual(['holder:acquired']);

      releaseHold();
      await Promise.all([holderPromise, policyPromise]);

      expect(order).toEqual(['holder:acquired', 'holder:releasing', 'policy:wrote']);
      expect(store.readInstallation('claude', '2.0.65')?.updatePolicy).toBe('pinned');
    });
  });

  describe('global and per-harness auto-update switches', () => {
    it('defaults both on', async () => {
      const { policy } = await load();
      expect(policy.isGlobalAutoUpdateEnabled()).toBe(true);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(true);
      expect(policy.rawGlobalAutoUpdateSetting()).toBeUndefined();
      expect(policy.rawAgentAutoUpdateSetting('claude')).toBeUndefined();
    });

    it('persists an explicit false for the global switch and reads it back after reload', async () => {
      const { policy: policyA } = await load();
      policyA.setGlobalAutoUpdateEnabled(false);
      expect(policyA.isGlobalAutoUpdateEnabled()).toBe(false);

      const { policy: policyB } = await load(); // fresh module graph — forces a real disk re-read
      expect(policyB.rawGlobalAutoUpdateSetting()).toBe(false);
      expect(policyB.isGlobalAutoUpdateEnabled()).toBe(false);
    });

    it('persists an explicit false for one harness and reads it back after reload', async () => {
      const { policy: policyA } = await load();
      policyA.setAgentAutoUpdateEnabled('codex', false);
      expect(policyA.isAutoUpdateEnabledForAgent('codex')).toBe(false);
      expect(policyA.isAutoUpdateEnabledForAgent('claude')).toBe(true); // unaffected

      const { policy: policyB } = await load();
      expect(policyB.rawAgentAutoUpdateSetting('codex')).toBe(false);
      expect(policyB.isAutoUpdateEnabledForAgent('codex')).toBe(false);
    });

    it('the global switch is a HARD kill switch — off wins even over an explicit per-harness true', async () => {
      const { policy } = await load();
      policy.setAgentAutoUpdateEnabled('claude', true);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(true);

      policy.setGlobalAutoUpdateEnabled(false);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(false);
    });

    it('unset restores the default for both switches', async () => {
      const { policy } = await load();
      policy.setGlobalAutoUpdateEnabled(false);
      policy.setAgentAutoUpdateEnabled('claude', false);
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(false);

      policy.unsetGlobalAutoUpdateEnabled();
      expect(policy.rawGlobalAutoUpdateSetting()).toBeUndefined();
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(false); // per-agent false still applies

      policy.unsetAgentAutoUpdateEnabled('claude');
      expect(policy.rawAgentAutoUpdateSetting('claude')).toBeUndefined();
      expect(policy.isAutoUpdateEnabledForAgent('claude')).toBe(true);
    });
  });
});
