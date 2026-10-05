// path check: ensures the shims dir is on PATH (rc file on POSIX, user PATH registry on Windows).
// Idempotent via addShimsToPath. An already-open shell picks up the change only after reload.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { isShimsInPath, addShimsToPath, listAgentsWithNonIsolatedInstalledVersions } from '../../installations/shims.js';

export const pathCheck: HealCheck = {
  id: 'path',
  title: 'Shims directory on PATH',
  cadence: 'startup',
  async run(ctx: HealCtx): Promise<CheckResult> {
    if (listAgentsWithNonIsolatedInstalledVersions().length === 0) return resultOf([], []);
    if (isShimsInPath()) return resultOf([], []);
    if (ctx.dryRun) return resultOf(['add shims dir to PATH'], []);

    const r = addShimsToPath();
    if (r.success && !r.alreadyPresent) {
      return resultOf([`added shims to PATH (${r.location ?? r.rcFile ?? 'PATH'})`], []);
    }
    if (r.success && r.alreadyPresent) {
      return resultOf([], [`shims dir in ${r.rcFile ?? 'rc file'} but not loaded — open a new terminal`]);
    }
    return resultOf([], [`could not add shims to PATH: ${r.error ?? 'unknown'}`]);
  },
};
