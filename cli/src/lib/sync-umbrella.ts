
import { pullRepo, adoptUserRepoIfNeeded } from './git.js';
import { getUserAgentsDir, getEnabledExtraRepos } from './state.js';
import { listRemoteBundles, pullBundle } from './secrets-client.js';
import { SYNC_PASSPHRASE_ENV } from './sync-passphrase.js';
import type { ResourceSelection } from './installations/versions.js';

export interface UmbrellaFlags {
  repos?: boolean;
  secrets?: boolean;
  cloud?: boolean;
  local?: boolean;
}

interface UmbrellaPlan {
  fetchRepos: boolean;
  fetchSecrets: boolean;
  reconcile: boolean;
}

export function planUmbrellaStages(f: UmbrellaFlags): UmbrellaPlan {
  // Bare sync fetches repos and reconciles; secrets stay explicit because of their fleet-wide blast radius.
  if (f.local) {
    return { fetchRepos: false, fetchSecrets: false, reconcile: true };
  }
  const anySelector = !!(f.repos || f.secrets);
  if (anySelector) {
    return {
      fetchRepos: !!f.repos,
      fetchSecrets: !!f.secrets,
      reconcile: !f.cloud,
    };
  }
  return { fetchRepos: true, fetchSecrets: false, reconcile: !f.cloud };
}

interface UmbrellaResult {
  plan: UmbrellaPlan;
  repos?: { pulled: number; errors: string[] };
  secrets?: { pulled: number; skipped: boolean; reason?: string; errors: string[] };
  devices?: { synced: number; pending: number; skipped: boolean };
  reconciled: boolean;
  declined: string[];
  reconciledVersions: Array<{ agent: string; version: string }>;
}

interface RunUmbrellaArgs {
  flags: UmbrellaFlags;
  log: (msg: string) => void;
  yes: boolean;
  passphrase?: string;
  quiet?: boolean;
  selection?: ResourceSelection;
  allowExecSurfaces?: boolean;
}

export async function runUmbrellaSync(args: RunUmbrellaArgs): Promise<UmbrellaResult> {
  const { flags, log, yes, passphrase, quiet = false, selection, allowExecSurfaces = false } = args;
  const plan = planUmbrellaStages(flags);
  const result: UmbrellaResult = { plan, reconciled: false, declined: [], reconciledVersions: [] };

  if (plan.fetchRepos) {
    const dirs = [
      { alias: 'user', dir: getUserAgentsDir() },
      ...getEnabledExtraRepos().map((e) => ({ alias: e.alias, dir: e.dir })),
    ];
    let pulled = 0;
    const errors: string[] = [];
    for (const { alias, dir } of dirs) {
      if (alias === 'user') {
        // Adopt a non-git user store before pull; missing remote is loud, never a false reconciled result.
        const adopted = await adoptUserRepoIfNeeded(dir);
        if (adopted && !adopted.success) {
          const hint = adopted.needsUrl ? ' — git-back it: agents repo pull user <git-url>' : '';
          errors.push(`${alias}: ${adopted.error}${hint}`);
          continue;
        }
        if (adopted?.success) {
          log(`repos: ${alias} adopted in place → ${adopted.commit} (${adopted.materialized} file(s) materialized)`);
        }
      }
      const r = await pullRepo(dir);
      if (r.success) {
        pulled++;
        log(`repos: ${alias} → ${r.commit}`);
      } else {
        errors.push(`${alias}: ${r.error ?? 'unknown error'}`);
      }
    }
    result.repos = { pulled, errors };
    if (!errors.some((error) => error.startsWith('user:'))) {
      const { reconcileDeviceDiscoveryPolicies } = await import('./devices/discovery-policy.js');
      await reconcileDeviceDiscoveryPolicies();
    }
  }

  // Fetch-stage failures accumulate so independent stages still run.
  if (plan.fetchSecrets) {
    if (!passphrase) {
      result.secrets = {
        pulled: 0,
        skipped: true,
        reason: `no passphrase — set ${SYNC_PASSPHRASE_ENV} or run \`agents secrets vault unlock\` (#366)`,
        errors: [],
      };
      log(`secrets: skipped (no passphrase — set ${SYNC_PASSPHRASE_ENV})`);
    } else {
      let pulled = 0;
      const errors: string[] = [];
      try {
        const remote = await listRemoteBundles();
        for (const b of remote) {
          try {
            await pullBundle(b.name, { passphrase, force: true });
            pulled++;
            log(`secrets: ${b.name}`);
          } catch (err) {
            errors.push(`${b.name}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        errors.push((err as Error).message);
      }
      result.secrets = { pulled, skipped: false, errors };
    }
  }

  if (plan.reconcile) {
    const { refresh } = await import('./refresh.js');
    const refreshed = await refresh({
      skipPrompts: yes,
      quiet,
      skipClis: selection !== undefined,
      selection,
      allowExecSurfaces,
    });
    result.reconciled = true;
    result.declined = refreshed.declined;
    result.reconciledVersions = refreshed.reconciled;

    // Device refresh discovers pending devices rather than silently registering them.
    if (!selection) {
      const { runDeviceSync } = await import('./devices/sync.js');
      const { reconcilePendingSentinels } = await import('./devices/pending.js');
      const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
      if (dev.ok) await reconcilePendingSentinels(dev.pending);
      result.devices = { synced: dev.synced, pending: dev.pending.length, skipped: !dev.ok };
      if (dev.ok) {
        log(`devices: ${dev.synced} refreshed${dev.pending.length ? `, ${dev.pending.length} new pending` : ''}`);
      }
    }
  }

  return result;
}
