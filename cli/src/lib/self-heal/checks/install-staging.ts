
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { resolveRunningPackageRoot } from '../../self-update.js';

const __installStagingDirname = path.dirname(fileURLToPath(import.meta.url));

export const STALE_INSTALL_STAGING_AGE_MS = 10 * 60 * 1000;


function findAgedInstallStaging(packageRoot: string, maxAgeMs: number, now: number): string[] {
  const resolved = path.resolve(packageRoot);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stagingPattern = new RegExp(`^\\.${escapedBase}-[a-zA-Z0-9]+$`);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const aged: string[] = [];
  for (const entry of entries) {
    if (!stagingPattern.test(entry)) continue;
    const full = path.join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs >= maxAgeMs) aged.push(full);
  }
  return aged;
}

export const installStagingCheck: HealCheck = {
  id: 'install-staging',
  title: 'Orphaned npm reify staging dir',
  cadence: 'periodic',
  async run(ctx: HealCtx): Promise<CheckResult> {
    let packageRoot: string;
    try {
      packageRoot = resolveRunningPackageRoot(__installStagingDirname);
    } catch {
      return resultOf([], []);
    }

    const aged = findAgedInstallStaging(packageRoot, STALE_INSTALL_STAGING_AGE_MS, Date.now());
    if (aged.length === 0) return resultOf([], []);

    if (ctx.dryRun) {
      return resultOf(aged.map((p) => `orphaned reify staging dir: ${p}`), []);
    }

    const fixed: string[] = [];
    const needsAttention: string[] = [];
    for (const stagingPath of aged) {
      try {
        fs.rmSync(stagingPath, { recursive: true, force: true });
        fixed.push(`removed orphaned reify staging dir ${stagingPath} — the next 'agents upgrade' can reify cleanly`);
      } catch (err) {
        needsAttention.push(
          `could not remove orphaned reify staging dir ${stagingPath}: ${(err as Error).message}`,
        );
      }
    }
    return resultOf(fixed, needsAttention);
  },
};
