
import type {
  HealCheck,
  HealCheckId,
  HealCadence,
  HealCtx,
  SelfHealReport,
  CheckReport,
} from './types.js';
import { resourcesCheck } from './checks/resources.js';
import { hookRuntimeCheck } from './checks/hook-runtime.js';
import { hookManifestCheck } from './checks/hook-manifest.js';
import { shimsCheck } from './checks/shims.js';
import { shadowingCheck } from './checks/shadowing.js';
import { pathCheck } from './checks/path.js';
import { installStagingCheck } from './checks/install-staging.js';
import { menubarHelperCheck } from './checks/menubar-helper.js';

export const HEAL_CHECKS: HealCheck[] = [
  shimsCheck,
  shadowingCheck,
  pathCheck,
  hookRuntimeCheck,
  hookManifestCheck,
  resourcesCheck,
  installStagingCheck,
  menubarHelperCheck,
];

interface SelfHealOptions {
  checks?: HealCheckId[];
  cadences?: HealCadence[];
  mode?: 'safe' | 'full';
  dryRun?: boolean;
  platform?: NodeJS.Platform;
}

export async function runSelfHeal(opts: SelfHealOptions = {}): Promise<SelfHealReport> {
  const platform = opts.platform ?? process.platform;
  const ctx: HealCtx = { mode: opts.mode ?? 'safe', dryRun: opts.dryRun ?? false };

  const selected = HEAL_CHECKS.filter((c) => {
    if (opts.checks && !opts.checks.includes(c.id)) return false;
    if (opts.cadences && !opts.cadences.includes(c.cadence)) return false;
    if (c.platforms && !c.platforms.includes(platform)) return false;
    return true;
  });

  const reports: CheckReport[] = [];
  for (const check of selected) {
    try {
      const result = await check.run(ctx);
      reports.push({ id: check.id, title: check.title, result });
    } catch (err) {
      reports.push({ id: check.id, title: check.title, result: null, error: (err as Error).message });
    }
  }

  return { checks: reports };
}

export function selfHealChangedAnything(report: SelfHealReport): boolean {
  return report.checks.some((c) => (c.result?.fixed.length ?? 0) > 0);
}

export function selfHealNeedsAttention(report: SelfHealReport): boolean {
  return report.checks.some((c) => (c.result?.needsAttention.length ?? 0) > 0 || Boolean(c.error));
}

export function summarizeSelfHeal(report: SelfHealReport): string {
  const parts: string[] = [];
  for (const c of report.checks) {
    if (c.error) { parts.push(`${c.id}: error (${c.error})`); continue; }
    const n = c.result?.fixed.length ?? 0;
    const a = c.result?.needsAttention.length ?? 0;
    if (n > 0 || a > 0) parts.push(`${c.id}: ${n} fixed${a > 0 ? `, ${a} to review` : ''}`);
  }
  return parts.join('; ') || 'nothing to heal';
}
