
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { AGENTS } from '../../agents.js';
import {
  getPathShadowingExecutable,
  adoptShadowingLauncher,
  listAgentsWithNonIsolatedInstalledVersions,
} from '../../installations/shims.js';
import { getGlobalDefault } from '../../installations/versions.js';

export const shadowingCheck: HealCheck = {
  id: 'shadowing',
  title: 'Launcher shadowing the version-managed shim',
  platforms: ['darwin', 'linux'],
  cadence: 'frequent',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const fixed: string[] = [];
    const needsAttention: string[] = [];

    for (const agent of listAgentsWithNonIsolatedInstalledVersions()) {
      if (!getGlobalDefault(agent)) continue;
      const cmd = AGENTS[agent].cliCommand;
      const shadowedBy = getPathShadowingExecutable(agent);
      if (!shadowedBy) continue;

      if (ctx.dryRun) {
        let isSymlink = false;
        try {
          const fs = await import('node:fs');
          isSymlink = fs.lstatSync(shadowedBy).isSymbolicLink();
        } catch {  }
        if (isSymlink) fixed.push(`${cmd} launcher (${shadowedBy})`);
        else needsAttention.push(`${cmd}: real binary shadows the shim (${shadowedBy})`);
        continue;
      }

      const res = adoptShadowingLauncher(agent);

      if (res.adopted) fixed.push(`adopted ${cmd} launcher (${res.launcher})`);
      else if (res.reason === 'not-a-symlink') {
        needsAttention.push(`${cmd}: real binary shadows the shim (${shadowedBy})`);
      }
    }

    return resultOf(fixed, needsAttention);
  },
};
