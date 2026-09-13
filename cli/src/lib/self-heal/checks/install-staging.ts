// install-staging check — fleet-wide self-heal for the orphaned npm reify
// staging dir that dead-ends `agents upgrade` forever (PHNX-3393).
//
// `agents upgrade` itself sweeps this orphan proactively before every reify
// (sweepStaleInstallStaging in self-update.ts), so a box that runs `agents
// upgrade` regularly never accumulates one. This check exists for the box
// that does NOT: one that stopped upgrading after the crash that left the
// orphan behind, so the next manual `agents upgrade` would still hit the same
// ENOTEMPTY the sweep exists to prevent, and nothing runs `agents upgrade` to
// trigger that sweep in the meantime. Periodic cadence closes that gap
// fleet-wide (via the daemon's self-heal service) and on demand via
// `agents doctor --fix`.
//
// The age guard is load-bearing: a staging dir can be legitimately mid-write
// by a CONCURRENT upgrade this instant. Only a dir older than the guard is
// touched, so an unattended periodic run can never delete a live reify.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { resolveRunningPackageRoot } from '../../self-update.js';

const __installStagingDirname = path.dirname(fileURLToPath(import.meta.url));

/** A concurrent upgrade must be long finished before an unattended sweep may touch its staging dir. */
export const STALE_INSTALL_STAGING_AGE_MS = 10 * 60 * 1000;

/**
 * Find the retire-path staging dir(s) for `packageRoot` older than
 * `maxAgeMs`. Reimplements the same matching self-update.ts's
 * sweepStaleInstallStaging uses, so the age guard can be checked BEFORE
 * anything is deleted — the sweep helper itself removes unconditionally,
 * which is correct for the upgrade hot path (nothing else touches that
 * path while an upgrade you just started is running) but wrong for an
 * unattended periodic sweep that could race a concurrent upgrade.
 */
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
      continue; // vanished between readdir and stat — nothing to sweep
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
      // Not an npm/bun-managed install (source checkout) — nothing to sweep.
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
