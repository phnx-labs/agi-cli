// hook-manifest check: finds manifest hooks whose `script:` resolves outside <root>/hooks/, which
// are dropped silently. main-branch-guard reached 0 of 25 settings files this way; a guard that
// silently never runs is worse than none.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { parseHookManifest, resolveHookScriptPath } from '../../hooks/install.js';

export const hookManifestCheck: HealCheck = {
  id: 'hook-manifest',
  title: 'Hook manifest scripts resolve',
  cadence: 'periodic',
  async run(_ctx: HealCtx): Promise<CheckResult> {
    const needsAttention: string[] = [];

    let manifest: Record<string, { script?: string; enabled?: boolean }>;
    try {
      // warn:false — this check reports, it does not double-log.
      manifest = parseHookManifest({ warn: false }) as typeof manifest;
    } catch (err) {
      return resultOf([], [`hook manifest unreadable: ${(err as Error).message}`]);
    }

    for (const [name, def] of Object.entries(manifest)) {
      if (!def || typeof def.script !== 'string' || def.script.length === 0) continue;
      if (def.enabled === false) continue;
      // An absolute script (a subrule-composed hook) is used as-is by the
      // installer, so only relative manifest paths go through the hooks/ root
      // resolver that can silently return null.
      if (def.script.startsWith('/')) continue;
      if (resolveHookScriptPath(def.script) === null) {
        needsAttention.push(
          `hook '${name}' declares script '${def.script}', which resolves to no file under any hooks/ root — ` +
            `it is registered but silently never installed. Move the script under hooks/ (or point the manifest at ` +
            `an entrypoint there) so the installer can find it.`
        );
      }
    }

    // Report only. Repair would mean guessing where the author meant the script
    // to live, and a wrong guess would wire the wrong file into a PreToolUse
    // gate. Naming the broken entry is the fix that belongs here.
    return resultOf([], needsAttention);
  },
};
