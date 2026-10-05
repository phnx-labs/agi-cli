
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
      manifest = parseHookManifest({ warn: false }) as typeof manifest;
    } catch (err) {
      return resultOf([], [`hook manifest unreadable: ${(err as Error).message}`]);
    }

    for (const [name, def] of Object.entries(manifest)) {
      // A registered critical hook can otherwise be silently omitted when its script vanishes.
      if (!def || typeof def.script !== 'string' || def.script.length === 0) continue;
      if (def.enabled === false) continue;
      if (def.script.startsWith('/')) continue;
      if (resolveHookScriptPath(def.script) === null) {
        needsAttention.push(
          `hook '${name}' declares script '${def.script}', which resolves to no file under any hooks/ root — ` +
            `it is registered but silently never installed. Move the script under hooks/ (or point the manifest at ` +
            `an entrypoint there) so the installer can find it.`
        );
      }
    }

    return resultOf([], needsAttention);
  },
};
