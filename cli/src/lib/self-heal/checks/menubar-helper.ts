
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';

export const menubarHelperCheck: HealCheck = {
  id: 'menubar-helper',
  title: 'AGI Menu helper is the newest published build',
  platforms: ['darwin'],
  cadence: 'periodic',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const { updateMenubarHelperIfNewer } = await import('../../menubar/install-menubar.js');
    const r = await updateMenubarHelperIfNewer({ dryRun: ctx.dryRun });
    switch (r.outcome) {
      case 'available':
      case 'updated': return resultOf([r.detail], []);
      case 'failed': return resultOf([], [`AGI Menu ${r.installed ?? '?'} → ${r.available}: ${r.detail}`]);
      default: return resultOf([], []);
    }
  },
};
