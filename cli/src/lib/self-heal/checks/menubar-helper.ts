// menubar-helper check: keeps the installed AGI Menu on the newest published build. Runs
// periodically in the daemon and after `agents upgrade`. Detect-only under dryRun; repair is the
// verified download + atomic swap + restart in `updateMenubarHelperIfNewer`.

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
      case 'updated': return resultOf([r.detail], []);
      case 'failed': return resultOf([], [`AGI Menu ${r.installed ?? '?'} → ${r.available}: ${r.detail}`]);
      default: return resultOf([], []);
    }
  },
};
