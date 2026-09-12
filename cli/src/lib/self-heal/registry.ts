// The self-heal registry + runner.
//
// One ordered list of HealChecks; one runner that executes the requested subset,
// isolating failures (one check throwing never aborts the rest) and aggregating a
// SelfHealReport. Both front doors — the daemon (by cadence) and `agents doctor`
// (all, or by id) — call runSelfHeal.

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

// Order matters: cheap structural fixes (shims, shadow adoption, PATH, generated
// hook wrappers) before the heavier resource reconciliation, so a freshly-
// repaired shim is in place first.
export const HEAL_CHECKS: HealCheck[] = [
  shimsCheck,
  shadowingCheck,
  pathCheck,
  hookRuntimeCheck,
  // Detect-only, after the runtime shim repair: a shim can be healthy while the
  // manifest entry that should have produced it resolves nowhere.
  hookManifestCheck,
  resourcesCheck,
  installStagingCheck,
  // Last and network-touching: the menu-bar helper's auto-update (macOS only).
  menubarHelperCheck,
];

export interface SelfHealOptions {
  /** Restrict to these check ids; omit to run every registered check. */
  checks?: HealCheckId[];
  /** Only run checks whose cadence is in this set (daemon scheduling). */
  cadences?: HealCadence[];
  /** 'safe' (daemon default) or 'full' (doctor --fix). Default 'safe'. */
  mode?: 'safe' | 'full';
  /** Detect only — never write. Default false. */
  dryRun?: boolean;
  /** Override the platform gate (tests). Default process.platform. */
  platform?: NodeJS.Platform;
}

/** Run the selected checks, isolating per-check failures. */
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

/** True if any check repaired something (for daemon logging / notification). */
export function selfHealChangedAnything(report: SelfHealReport): boolean {
  return report.checks.some((c) => (c.result?.fixed.length ?? 0) > 0);
}

/** True if any check surfaced something a human should look at. */
export function selfHealNeedsAttention(report: SelfHealReport): boolean {
  return report.checks.some((c) => (c.result?.needsAttention.length ?? 0) > 0 || Boolean(c.error));
}

/** One-line human summary, e.g. "shims: 2 fixed; path: 1 fixed". */
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
