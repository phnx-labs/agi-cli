
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { AGENTS } from '../../agents.js';
import {
  createShim,
  ensureShimCurrent,
  ensureVersionedAliasCurrent,
  isShimCurrent,
  isVersionedAliasCurrent,
  removeShim,
  shimExists,
  shimPointsAtLiveInstall,
  removeLegacyUserShim,
  listAgentsWithInstalledVersions,
  listAgentsWithNonIsolatedInstalledVersions,
  listShimFileNames,
  pruneOrphanedCommandShim,
} from '../../installations/shims.js';
import { listInstalledVersions } from '../../installations/versions.js';

export const shimsCheck: HealCheck = {
  id: 'shims',
  title: 'Dispatch shims + versioned aliases',
  cadence: 'frequent',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const fixed: string[] = [];
    const agentsWithBareShims = new Set(listAgentsWithNonIsolatedInstalledVersions());

    for (const agent of listAgentsWithInstalledVersions()) {
      const cmd = AGENTS[agent].cliCommand;

      if (agentsWithBareShims.has(agent)) {
        if (!isShimCurrent(agent)) {
          if (!ctx.dryRun) ensureShimCurrent(agent);
          fixed.push(`${cmd} shim`);
        } else if (!shimPointsAtLiveInstall(agent)) {
          if (!ctx.dryRun) createShim(agent);
          fixed.push(`${cmd} shim (repointed to current install)`);
        }
      } else if (shimExists(agent)) {
        if (!ctx.dryRun) removeShim(agent);
        fixed.push(`removed ${cmd} shim (isolated-only)`);
      }

      for (const version of listInstalledVersions(agent)) {
        if (!isVersionedAliasCurrent(agent, version)) {
          if (!ctx.dryRun) ensureVersionedAliasCurrent(agent, version);
          fixed.push(`${cmd}@${version} alias`);
        }
      }

      if (!ctx.dryRun && removeLegacyUserShim(agent)) fixed.push(`removed legacy ${cmd} shim`);
    }

    if (!ctx.dryRun) {
      for (const name of listShimFileNames()) {
        if (pruneOrphanedCommandShim(name)) fixed.push(`pruned orphaned ${name} shim`);
      }
    }

    return resultOf(fixed, []);
  },
};
