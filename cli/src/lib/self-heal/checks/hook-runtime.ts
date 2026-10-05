
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { repairManagedHookRuntimeArtifacts } from '../../hooks/install.js';

export const hookRuntimeCheck: HealCheck = {
  id: 'hook-runtime',
  title: 'Generated hook runtime shims',
  cadence: 'frequent',
  async run(ctx: HealCtx): Promise<CheckResult> {
    // One repair attempt per unique path per pass; no retries or sync recursion.
    const report = repairManagedHookRuntimeArtifacts({ dryRun: ctx.dryRun });
    return resultOf(report.fixed, report.needsAttention);
  },
};
