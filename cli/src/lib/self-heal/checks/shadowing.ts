// shadowing check: when a harness's launcher shadows our shim on PATH, adopt it (symlink-only,
// reversible). A real native binary is never moved, only surfaced as needsAttention. POSIX-only;
// Windows resolves via the registry PATH.

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

    // Skip isolated-only agents: adoption repoints the user's own launcher at our shim, the
    // opposite of what `--isolated` promises. Gate on the installs themselves, not on the global
    // default, so no path that pins a default can re-arm adoption.
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
      // Adopt managed symlinks automatically, but surface real binaries for human resolution.
      if (res.adopted) fixed.push(`adopted ${cmd} launcher (${res.launcher})`);
      else if (res.reason === 'not-a-symlink') {
        needsAttention.push(`${cmd}: real binary shadows the shim (${shadowedBy})`);
      }
    }

    return resultOf(fixed, needsAttention);
  },
};
