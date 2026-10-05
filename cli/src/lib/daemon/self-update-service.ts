
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

const SELF_UPDATE_TICK_MS = 75 * 60_000;
const SELF_UPDATE_DEADLINE_MS = 15 * 60_000;
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

export interface SelfUpdateDeps {
  currentVersion(): string;
  installedVersion(): string;
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

// Exit is allowed only after tarball, installed version, shims, and global bin links are verified.
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
    }
  }
  await verifyInstalledVersion(packageRoot, metadata.version);
  await refreshAliasShims(packageRoot, signal);

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
      await runUmbrellaSync({
        flags: { local: true },
        log: () => {},
        yes: true,
        quiet: true,
      });
    },
  };
}

// Periodic and on-demand triggers share the actual in-flight install, not merely its caller's wait.
let inFlightAttempt: Promise<SelfUpdateOutcome> | null = null;

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
  const syncDecline = selfUpdateSyncDeclineReason(deps);
  if (syncDecline) return { updated: false, reason: syncDecline };

  const current = deps.currentVersion();
  const installed = deps.installedVersion();
  // Bun writes incrementally, so a newer on-disk version is trusted only after the install settles.
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

  // Post-install repo and local reconciliation is best-effort after install verification succeeds.
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

// Give an on-demand caller's IPC response time to flush before the supervised process exits.
const SELF_UPDATE_EXIT_DELAY_MS = 250;

let exitScheduled = false;

export function scheduleSelfUpdateExit(): void {
  if (exitScheduled) return;
  exitScheduled = true;
  setTimeout(() => process.exit(0), SELF_UPDATE_EXIT_DELAY_MS);
}

export function triggerSelfUpdateInBackground(
  ctx: DaemonContext,
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): Promise<SelfUpdateOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELF_UPDATE_DEADLINE_MS);
  if (typeof timeout.unref === 'function') timeout.unref();
  return attemptSelfUpdateAndExit(ctx, controller.signal, deps).finally(() => clearTimeout(timeout));
}

export function selfUpdateSyncDeclineReason(deps: SelfUpdateDeps = defaultSelfUpdateDeps()): string | null {
  if (deps.isDevBuild()) return DEV_BUILD_DECLINE;
  if (deps.detectShadow() && !installedIsNewerThanRunning(deps.installedVersion(), deps.currentVersion())) {
    return SHADOW_DECLINE;
  }
  return null;
}

const DEV_BUILD_DECLINE = 'dev build — self-update is a no-op';
const SHADOW_DECLINE = 'another agents binary shadows this install — self-update is a no-op';

function installedIsNewerThanRunning(installed: string, running: string): boolean {
  if (installed === 'unknown' || running === 'unknown') return false;
  return compareVersions(installed, running) > 0;
}

let shadowDeclineLogged = false;

export class SelfUpdateService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'self-update';
  readonly intervalMs = SELF_UPDATE_TICK_MS;
  readonly deadlineMs = SELF_UPDATE_DEADLINE_MS;
  readonly startupDelayMs = SELF_UPDATE_STARTUP_DELAY_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
  }

  protected async onStop(): Promise<void> {
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
