
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';

export const resourcesCheck: HealCheck = {
  id: 'resources',
  title: 'Resource sync (commands, skills, hooks, rules, plugins)',
  cadence: 'periodic',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const { heal } = await import('../../heal.js');
    const result = await heal({ mode: ctx.mode, dryRun: ctx.dryRun });

    const fixed: string[] = [];
    const needsAttention: string[] = [];

    let healed = 0;
    for (const v of result.versions) {
      healed += v.healed.length;
      for (const s of v.skipped) {
        needsAttention.push(`${v.agent}@${v.version}: ${s.kind}/${s.name} (${s.reason})`);
      }
    }
    if (healed > 0) fixed.push(`${healed} resource(s) reconciled`);
    for (const m of result.repairedManifests) {
      fixed.push(`plugin ${m.plugin}: dropped ${m.droppedFields.join(', ')}`);
    }
    for (const p of result.refreshedPlugins) {
      fixed.push(`plugin ${p.plugin}: ${p.from} -> ${p.to}`);
    }
    for (const s of result.skippedPlugins) {
      needsAttention.push(`plugin ${s.plugin}: ${s.reason} (${s.from} vs ${s.upstream})`);
    }

    return resultOf(fixed, needsAttention);
  },
};
