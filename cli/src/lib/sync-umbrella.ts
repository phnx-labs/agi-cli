/**
 * Umbrella `agents sync` orchestration — "make this machine current".
 *
 * Bare `agents sync` fetches the config repos then reconciles them into every
 * installed agent's version home. Secrets are an opt-in stage (`--secrets`) —
 * see `planUmbrellaStages` for why it's off by default. Each stage is an
 * existing exported library function; this module only sequences them and
 * decides — from the flags — which stages run. The planner is pure so the
 * flag matrix is unit-tested without any I/O.
 *
 * Stage backends:
 *   repos    -> git pull of ~/.agents + enabled ~/.agents-* extras (pullRepo)
 *   secrets  -> listRemoteBundles + pullBundle (needs a passphrase; skipped
 *               cleanly when none is available — tokenized non-interactive auth
 *               arrives with `agents secrets vault unlock`, #366/#367)
 *   reconcile-> refresh({ skipPrompts }) — re-materialize resources into homes
 */

import { pullRepo, adoptUserRepoIfNeeded } from './git.js';
import { getUserAgentsDir, getEnabledExtraRepos } from './state.js';
import { listRemoteBundles, pullBundle } from './secrets-client.js';
import { SYNC_PASSPHRASE_ENV } from './sync-passphrase.js';

/** The umbrella flags off `agents sync`. */
export interface UmbrellaFlags {
  repos?: boolean;
  secrets?: boolean;
  cloud?: boolean;
  local?: boolean;
}

/** Which stages a given flag combination runs. */
export interface UmbrellaPlan {
  fetchRepos: boolean;
  fetchSecrets: boolean;
  reconcile: boolean;
}

/**
 * Decide which stages run. Pure — no I/O. Semantics:
 *   bare (no flags)        fetch repos, then reconcile
 *   --local                reconcile only, no fetch
 *   --cloud                fetch repos (or the selected subset), skip reconcile
 *   --repos/--secrets      fetch only the selected types, then reconcile
 * `--local` wins over everything; `--cloud` suppresses reconcile.
 *
 * Secrets are NOT part of the bare default — they are opt-in via `--secrets`.
 * Pulling every secret bundle onto the machine on a bare `agents sync` is more
 * blast radius than the verb should carry by default.
 */
export function planUmbrellaStages(f: UmbrellaFlags): UmbrellaPlan {
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
  // No per-type selector: bare = repos + reconcile; --cloud = repos, no
  // reconcile. Secrets stay off unless explicitly selected above.
  return { fetchRepos: true, fetchSecrets: false, reconcile: !f.cloud };
}

export interface UmbrellaResult {
  plan: UmbrellaPlan;
  repos?: { pulled: number; errors: string[] };
  secrets?: { pulled: number; skipped: boolean; reason?: string; errors: string[] };
  devices?: { synced: number; pending: number; skipped: boolean };
  reconciled: boolean;
  /**
   * Resources the reconcile stage refused to write, as user-facing sentences.
   * Empty when nothing was declined — never conflated with "nothing to do".
   */
  declined: string[];
  /**
   * The (agent, version) pairs the reconcile stage actually wrote into — the set
   * the caller re-verifies for residual drift so the `✓ sync: reconciled` line is
   * never printed while drift it was asked to fix stays put (PHNX-3186).
   */
  reconciledVersions: Array<{ agent: string; version: string }>;
}

export interface RunUmbrellaArgs {
  flags: UmbrellaFlags;
  /** Progress sink (already quiet-aware in the caller). */
  log: (msg: string) => void;
  /** Pass `skipPrompts` through to reconcile / non-interactive behavior. */
  yes: boolean;
  /** Secrets passphrase, if available (env var or prompt). Undefined => skip secrets. */
  passphrase?: string;
  /**
   * Suppress human progress from the reconcile stage (`refresh`). Required so
   * `agents sync --json` / fleet fan-out leave stdout as a single JSON object.
   */
  quiet?: boolean;
}

/**
 * Execute the planned stages in order: repos -> secrets -> reconcile.
 * A failure in one fetch stage is recorded and does not abort the others or the
 * reconcile — `agents sync` should make as much current as it can in one pass.
 */
export async function runUmbrellaSync(args: RunUmbrellaArgs): Promise<UmbrellaResult> {
  const { flags, log, yes, passphrase, quiet = false } = args;
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
      // A box where `~/.agents` is present but not a git repo (or lost its
      // `.git`) is a partial install: `pullRepo` there silently fails while the
      // umbrella still reported `✓ reconciled`, so fleet dotfiles/resources never
      // propagated and nothing said so (PHNX-3239, m0). Adopt it in place first —
      // the same self-heal `agents sync user` runs (PHNX-3301) — so the pull has a
      // real repo to fast-forward. A box that cannot be adopted (no recorded
      // remote) fails LOUD into `errors` with the reason, never a silent no-op.
      if (alias === 'user') {
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
    const refreshed = await refresh({ skipPrompts: yes, quiet });
    result.reconciled = true;
    result.declined = refreshed.declined;
    result.reconciledVersions = refreshed.reconciled;

    // Keep already-registered devices' reachability current, and surface newly
    // appeared tailnet nodes as "pending" for the menu-bar Register/Ignore gate
    // rather than silently adding them (refresh mode). Soft: a machine without
    // tailscale is a clean no-op, never a sync failure. First-run population is
    // `agents setup` / manual `agents devices sync` (bootstrap).
    const { runDeviceSync } = await import('./devices/sync.js');
    const { reconcilePendingSentinels } = await import('./devices/pending.js');
    const dev = await runDeviceSync({ soft: true, mode: 'refresh' });
    if (dev.ok) await reconcilePendingSentinels(dev.pending);
    result.devices = { synced: dev.synced, pending: dev.pending.length, skipped: !dev.ok };
    if (dev.ok) {
      log(`devices: ${dev.synced} refreshed${dev.pending.length ? `, ${dev.pending.length} new pending` : ''}`);
    }
  }

  return result;
}
