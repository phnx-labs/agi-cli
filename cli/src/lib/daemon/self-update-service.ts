/** Daemon self-update (PHNX-3695): the daemon opted out of auto-update, so R5 wasn't held for it.
 * Verify-then-exit: install and byte-verify, then `process.exit(0)` for the OS supervisor. Fail
 * closed: any failed step leaves the old daemon running; never exit into unverified code. */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getCliVersion, getCliVersionFresh } from '../version.js';
import { isDevVersionStamp } from '../startup/dev-build.js';
import { detectAgentsBinaryShadows } from '../binary-shadow.js';
import { compareVersions } from '../agent-spec/primitives.js';
import {
  NPM_PACKAGE_NAME,
  deriveGlobalPrefix,
  detectPackageManager,
  downloadVerifiedTarball,
  ensureGlobalBinLinks,
  installPackageIntoPrefix,
  installLooksSettled,
  installPackageWithBun,
  refreshAliasShims,
  resolveRunningPackageRoot,
  sweepStaleInstallStaging,
  verifyInstalledVersion,
} from '../self-update.js';
import { tryAutoPullSystemRepo } from '../git.js';
import { getSystemAgentsDir } from '../state.js';
import { runUmbrellaSync } from '../sync-umbrella.js';
import { upgradeOutdatedClis, type CliUpgradeResult } from '../cli-resources.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Runs roughly every 75 minutes — self-update is not urgent (unlike self-heal's 6h drift repair, it changes running code, so it stays well under a day but still infrequent). */
const SELF_UPDATE_TICK_MS = 75 * 60_000;
/** Hard cap per tick: download + install + verify can take minutes on a slow link; 15 minutes is
 * short relative to the ~75min cadence. Exported so triggerSelfUpdateInBackground bounds its
 * `AbortController` on the same budget. */
const SELF_UPDATE_DEADLINE_MS = 15 * 60_000;
/** First tick fires 5 minutes after boot, longer than self-heal's 30s: self-update can replace the
 * package and exit, so it must not be the first thing a fresh daemon does while shims, PATH and
 * other services settle. Later ticks use the normal cadence. */
const SELF_UPDATE_STARTUP_DELAY_MS = 5 * 60_000;

interface SelfUpdateOutcome {
  updated: boolean;
  reason?: string;
}

interface NpmLatestMetadata {
  version: string;
  integrity: string;
  tarball: string;
}

/** Dependency seam so `self-update-service.test.ts` can drive a real install against a fixture
 * prefix/tarball. Production always uses defaultSelfUpdateDeps; the exported logic has no
 * test-only branch. */
export interface SelfUpdateDeps {
  /** The version this process BOOTED with (memoized at startup). */
  currentVersion(): string;
  /** The version of the install on disk right now — differs from `currentVersion` once another process upgraded it. */
  installedVersion(): string;
  /** True when the install on disk looks complete (see `installLooksSettled`) — the gate before relaunching onto a version another process wrote. */
  installedIsSettled(): boolean;
  isDevBuild(): boolean;
  detectShadow(): boolean;
  packageRoot(): string;
  fetchLatestMetadata(signal: AbortSignal): Promise<NpmLatestMetadata>;
  installAndVerify(metadata: NpmLatestMetadata, packageRoot: string, signal: AbortSignal): Promise<void>;
  syncSystemRepo(): Promise<void>;
  syncLocal(): Promise<void>;
}

async function fetchLatestNpmMetadata(signal: AbortSignal): Promise<NpmLatestMetadata> {
  const response = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`, { signal });
  if (!response.ok) {
    throw new Error(`registry.npmjs.org responded ${response.status}`);
  }
  const data = await response.json() as {
    version?: unknown;
    dist?: { integrity?: unknown; tarball?: unknown };
  };
  if (
    typeof data.version !== 'string'
    || typeof data.dist?.integrity !== 'string'
    || typeof data.dist?.tarball !== 'string'
  ) {
    throw new Error('npm registry response did not include version, integrity, and tarball');
  }
  return { version: data.version, integrity: data.dist.integrity, tarball: data.dist.tarball };
}

/** Install and byte-verify `metadata` into `packageRoot`, the same sequence as `bootstrap.ts`'s
 * `installResolvedPackage` (bootstrap cannot be imported: side-effecting top level). `signal` goes
 * into each step so abort kills the fetch/child; an orphan races the next install (PHNX-3695). */
export async function installAndVerifyDefault(
  metadata: NpmLatestMetadata,
  packageRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const tarball = await downloadVerifiedTarball(metadata.tarball, metadata.integrity, 60_000, signal);
  try {
    await sweepStaleInstallStaging(packageRoot);
    if (detectPackageManager(packageRoot) === 'bun') {
      await installPackageWithBun(tarball, signal);
    } else {
      await installPackageIntoPrefix(tarball, deriveGlobalPrefix(packageRoot), signal);
    }
  } finally {
    try {
      await fs.promises.rm(path.dirname(tarball), { recursive: true, force: true });
    } catch {
      /* leave it for the OS temp sweep */
    }
  }
  await verifyInstalledVersion(packageRoot, metadata.version);
  await refreshAliasShims(packageRoot, signal);

  // PHNX-2768: mirror `installResolvedPackage`. An `--ignore-scripts` install can leave
  // package.json at the new version with the global bin links gone. A link that cannot be made to
  // resolve fails the attempt instead of reporting `updated: true`.
  if (detectPackageManager(packageRoot) !== 'bun' && process.platform !== 'win32') {
    const prefix = deriveGlobalPrefix(packageRoot);
    const repairs = await ensureGlobalBinLinks(packageRoot, prefix);
    const failed = repairs.filter((r) => r.action === 'failed');
    if (failed.length > 0) {
      const relink = failed
        .map((r) => `ln -sf ${path.relative(path.dirname(r.linkPath), r.target)} ${r.linkPath}`)
        .join(' && ');
      throw new Error(
        `upgraded to ${metadata.version} but could not restore the ` +
          `${failed.map((r) => r.name).join(', ')} command link${failed.length === 1 ? '' : 's'} in ` +
          `${path.join(prefix, 'bin')} (${failed.map((r) => r.error).join('; ')}). ` +
          `The box has the new package but no working \`agents\` — relink manually: ${relink}`,
      );
    }
  }
}

function defaultSelfUpdateDeps(): SelfUpdateDeps {
  return {
    currentVersion: () => getCliVersion(),
    installedVersion: () => getCliVersionFresh(),
    installedIsSettled: () => installLooksSettled(resolveRunningPackageRoot(__dirname)),
    isDevBuild: () => isDevVersionStamp(getCliVersion()),
    detectShadow: () => detectAgentsBinaryShadows().length > 0,
    packageRoot: () => resolveRunningPackageRoot(__dirname),
    fetchLatestMetadata: fetchLatestNpmMetadata,
    installAndVerify: installAndVerifyDefault,
    syncSystemRepo: async () => {
      const result = await tryAutoPullSystemRepo(getSystemAgentsDir());
      if (result.refused) {
        throw new Error(`system repo origin '${result.actualRemote}' is not the expected system remote — refused`);
      }
      if (result.error) {
        throw new Error(result.error);
      }
    },
    syncLocal: async () => {
      // Reconcile-only (no fetch — the .system pull above already fetched);
      // best-effort, same as the system-repo pull: a declined resource here
      // is not a self-update failure.
      await runUmbrellaSync({
        flags: { local: true },
        log: () => {},
        yes: true,
        quiet: true,
      });
    },
  };
}

/** Dedupes concurrent callers (periodic tick, on-demand request, several skewed clients) onto one
 * in-flight attempt; two concurrent installs would race on the same install directory.
 * Process-wide since production shares one `defaultSelfUpdateDeps()` target. */
let inFlightAttempt: Promise<SelfUpdateOutcome> | null = null;

/** Core self-update decision and action, shared by the periodic tick and
 * triggerSelfUpdateInBackground, so both run the same fail-closed logic. Returns rather than
 * throws so callers pick their exit timing (see scheduleSelfUpdateExit). */
export async function attemptSelfUpdateAndExit(
  ctx: DaemonContext,
  signal: AbortSignal,
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): Promise<SelfUpdateOutcome> {
  if (inFlightAttempt) return inFlightAttempt;
  const attempt = runSelfUpdateAttempt(ctx, signal, deps);
  inFlightAttempt = attempt;
  try {
    return await attempt;
  } finally {
    if (inFlightAttempt === attempt) inFlightAttempt = null;
  }
}

async function runSelfUpdateAttempt(
  ctx: DaemonContext,
  signal: AbortSignal,
  deps: SelfUpdateDeps,
): Promise<SelfUpdateOutcome> {
  // One decline source for the periodic tick and the on-demand path
  // (`selfUpdateSyncDeclineReason`): dev build, or shadowed install unless the disk install is
  // already newer than the running code, since a relaunch installs nothing.
  const syncDecline = selfUpdateSyncDeclineReason(deps);
  if (syncDecline) return { updated: false, reason: syncDecline };

  // Another process (operator `agents`, `agents upgrade`, installer) may have already replaced the
  // install, so disk is newer than memory and there is nothing to download. Exit for the
  // supervisor relaunch once the install has settled (npm's reify is atomic, bun's is not).
  const current = deps.currentVersion();
  const installed = deps.installedVersion();
  if (installedIsNewerThanRunning(installed, current)) {
    if (!deps.installedIsSettled()) {
      ctx.log('INFO', `self-update: the install on disk is ${installed} (this daemon is running ${current}) but it is still settling; relaunch deferred to the next tick`);
      return { updated: false, reason: 'installed version still settling' };
    }
    ctx.log(
      'INFO',
      `self-update: the install on disk is ${installed} but this daemon is still running ${current}; ` +
        'exiting for OS-supervisor relaunch onto the installed code',
    );
    return { updated: true };
  }

  let metadata: NpmLatestMetadata;
  try {
    metadata = await deps.fetchLatestMetadata(signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('WARN', `self-update: registry check failed, staying on ${current}: ${message}`);
    return { updated: false, reason: 'registry check failed' };
  }

  if (compareVersions(metadata.version, current) <= 0) {
    return { updated: false, reason: `already current (${current})` };
  }

  const packageRoot = deps.packageRoot();
  try {
    await deps.installAndVerify(metadata, packageRoot, signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('ERROR', `self-update: install/verify of ${metadata.version} failed, staying on ${current}: ${message}`);
    return { updated: false, reason: 'install or verify failed' };
  }

  // Best-effort from here: the CLI is already installed and verified, so a failure pulling the
  // .system repo or reconciling resources must not undo the upgrade or block the exit. It is
  // logged and retried on the next tick, which runs on the new code.
  try {
    await deps.syncSystemRepo();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('WARN', `self-update: .system repo pull failed: ${message}`);
  }
  try {
    await deps.syncLocal();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('WARN', `self-update: local reconcile ('agents sync --local') failed: ${message}`);
  }

  ctx.log('INFO', `self-update: verified ${current} -> ${metadata.version}; exiting for OS-supervisor relaunch`);
  return { updated: true };
}

/** How long `scheduleSelfUpdateExit` waits before `process.exit(0)` — long enough for an IPC handler's `socket.write` to flush to the OS. */
const SELF_UPDATE_EXIT_DELAY_MS = 250;

let exitScheduled = false;

/** Schedule the exit for a verified self-update exactly once, however many callers await the shared
 * `inFlightAttempt`. An immediate tick exit could win the race against an on-demand caller still
 * flushing its client response (PHNX-3695), so all go through this one delayed point. */
export function scheduleSelfUpdateExit(): void {
  if (exitScheduled) return;
  exitScheduled = true;
  setTimeout(() => process.exit(0), SELF_UPDATE_EXIT_DELAY_MS);
}

/** Fire an on-demand self-update in the background and return its bounded promise without awaiting,
 * so a trigger can respond to a client before the daemon exits. Awaiting inline would stall the
 * caller up to ~15 min (PHNX-3605). Shares the inFlightAttempt guard; stays fail-closed. */
export function triggerSelfUpdateInBackground(
  ctx: DaemonContext,
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): Promise<SelfUpdateOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELF_UPDATE_DEADLINE_MS);
  if (typeof timeout.unref === 'function') timeout.unref();
  return attemptSelfUpdateAndExit(ctx, controller.signal, deps).finally(() => clearTimeout(timeout));
}

/** The instant, network-free decline checks: dev build, or shadowed install. The on-demand handler
 * runs these synchronously so a skewed client gets the PHNX-3605 "nothing changed" advisory
 * immediately; runSelfUpdateAttempt calls it too. Returns the reason, or null. */
export function selfUpdateSyncDeclineReason(deps: SelfUpdateDeps = defaultSelfUpdateDeps()): string | null {
  if (deps.isDevBuild()) return DEV_BUILD_DECLINE;
  // A stale install is never declined by a shadow: the relaunch installs nothing.
  // (Whether that install has SETTLED is the attempt's call, not a decline.)
  if (deps.detectShadow() && !installedIsNewerThanRunning(deps.installedVersion(), deps.currentVersion())) {
    return SHADOW_DECLINE;
  }
  return null;
}

const DEV_BUILD_DECLINE = 'dev build — self-update is a no-op';
const SHADOW_DECLINE = 'another agents binary shadows this install — self-update is a no-op';

/** True when the package on disk is a strictly newer release than the one this process booted with. */
function installedIsNewerThanRunning(installed: string, running: string): boolean {
  if (installed === 'unknown' || running === 'unknown') return false;
  return compareVersions(installed, running) > 0;
}

/** The shadow decline is logged once per daemon process — a silent permanent no-op is how eight workers sat on stale code unnoticed (2026-09-07). */
let shadowDeclineLogged = false;

export class SelfUpdateService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'self-update';
  readonly intervalMs = SELF_UPDATE_TICK_MS;
  readonly deadlineMs = SELF_UPDATE_DEADLINE_MS;
  readonly startupDelayMs = SELF_UPDATE_STARTUP_DELAY_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick checks the registry fresh.
  }

  protected async onStop(): Promise<void> {
    // Nothing to release — the supervisor's timer teardown is the only cleanup needed.
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    const deadlineAt = Date.now() + this.deadlineMs;
    const outcome = await attemptSelfUpdateAndExit(ctx, signal);
    if (outcome.updated) {
      scheduleSelfUpdateExit();
      return;
    }
    if (outcome.reason === SHADOW_DECLINE && !shadowDeclineLogged) {
      shadowDeclineLogged = true;
      ctx.log(
        'WARN',
        `self-update: ${outcome.reason}; this daemon will only move to a new release after another agents ` +
          'process upgrades the install (`agents doctor` lists the shadow copy)',
      );
    }
    await upgradeHostClis(ctx, signal, deadlineAt);
  }
}

export async function upgradeHostClis(ctx: DaemonContext, signal: AbortSignal, deadlineAt: number, cwd?: string): Promise<void> {
  let results: CliUpgradeResult[];
  try {
    results = await upgradeOutdatedClis({ signal, deadlineAt, cwd });
  } catch (err) {
    ctx.log('WARN', `host-cli upgrade: could not read CLI manifests: ${(err as Error).message}`);
    return;
  }
  for (const r of results) {
    if (r.status === 'upgraded') ctx.log('INFO', `host-cli upgrade: ${r.name} ${r.from} -> ${r.to}`);
    else if (r.status === 'failed') ctx.log('WARN', `host-cli upgrade: ${r.name} failed, left as is: ${r.reason}`);
    else if (r.status === 'skipped' && r.reason.startsWith('outdated')) ctx.log('WARN', `host-cli upgrade: ${r.name} ${r.reason}`);
  }
}
