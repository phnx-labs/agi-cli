/**
 * Daemon self-update service (PHNX-3695, "Fix 2").
 *
 * The daemon (`agents __daemon-run`) is a long-running background process that
 * historically opted OUT of the CLI's interactive auto-update: `bootstrap.ts`
 * force-sets `AGENTS_CLI_DISABLE_AUTO_UPDATE=1` for `__daemon-run`, so a
 * running daemon never picked up new agents-cli code until a human ran
 * `agents daemon restart`. R5 in the root CLAUDE.md ("An installed CLI and its
 * installed helpers auto-update from the public channel") is binding for the
 * interactive CLI path (`self-update.ts` / `agents upgrade`) but was silently
 * NOT held for the one process that runs unattended for days. This service
 * closes that gap for the daemon specifically, reusing the exact same
 * verified-install primitives `agents upgrade` already uses — it does not
 * fork or reimplement them.
 *
 * Model: verify-then-exit, not swap-in-place. A daemon cannot safely hot-swap
 * its own loaded JS mid-process (in-flight ticks, open sockets, a live
 * ServiceSupervisor). Instead this tick installs + BYTE-VERIFIES the new
 * package on disk, and only once that succeeds does it `process.exit(0)` —
 * the OS supervisor (launchd `KeepAlive` / systemd `Restart=always`, see
 * `daemon/AGENTS.md`'s crash-recovery model) relaunches the daemon, which
 * then boots the new code. Clients do not need to be told anything: browser
 * IPC clients re-probe the socket via `waitForBrowserService`
 * (`browser/ipc.ts`), and the scheduler's atomic `(routine, scheduledFor)`
 * claim (see `docs/specifications.md` §Scheduling & execution singularity)
 * means a routine mid-fire at the moment of exit is deduped safely across the
 * restart rather than double-fired.
 *
 * Fail-closed is the whole point: every step below that can fail — the
 * registry check, the install, the post-install verify — leaves the OLD
 * daemon running untouched and logs a WARN/ERROR for the next tick to retry.
 * The daemon must never exit into code it has not proven is the real,
 * verified, requested version; an unverified exit would let the OS supervisor
 * relaunch-loop on a broken install.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getCliVersion } from '../version.js';
import { isDevVersionStamp } from '../startup/dev-build.js';
import { detectAgentsBinaryShadows } from '../binary-shadow.js';
import { compareVersions } from '../agent-spec/primitives.js';
import {
  NPM_PACKAGE_NAME,
  deriveGlobalPrefix,
  detectPackageManager,
  downloadVerifiedTarball,
  installPackageIntoPrefix,
  installPackageWithBun,
  refreshAliasShims,
  resolveRunningPackageRoot,
  sweepStaleInstallStaging,
  verifyInstalledVersion,
} from '../self-update.js';
import { tryAutoPullSystemRepo } from '../git.js';
import { getSystemAgentsDir } from '../state.js';
import { runUmbrellaSync } from '../sync-umbrella.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Runs roughly every 75 minutes — self-update is not urgent (unlike self-heal's 6h drift repair, it changes running code, so it stays well under a day but still infrequent). */
const SELF_UPDATE_TICK_MS = 75 * 60_000;
/** Hard cap per tick: a real download + npm/bun install + verify can legitimately take minutes on a slow link. 15 minutes matches the task's stated budget and is short relative to the ~75min cadence. */
const SELF_UPDATE_DEADLINE_MS = 15 * 60_000;
/**
 * First tick fires 5 minutes after daemon boot — deliberately longer than
 * self-heal's 30s stagger (`self-heal-service.ts`): self-heal repairs local
 * drift and is cheap/safe to run immediately, while self-update can replace
 * the running package and exit the process, which should never be the very
 * first thing a freshly-started daemon does (give the box a moment to finish
 * settling — shims, PATH, other services' startup ticks — before considering
 * a restart). Every later tick still fires on the normal cadence.
 */
const SELF_UPDATE_STARTUP_DELAY_MS = 5 * 60_000;

export interface SelfUpdateOutcome {
  updated: boolean;
  reason?: string;
}

interface NpmLatestMetadata {
  version: string;
  integrity: string;
  tarball: string;
}

/**
 * Dependency seam so `self-update-service.test.ts` can drive a REAL install
 * against a fixture npm prefix/tarball without touching the real npm
 * registry or the real running install. Production code always uses
 * {@link defaultSelfUpdateDeps} (the default parameter below) — no test-only
 * branch exists in the exported logic itself.
 */
export interface SelfUpdateDeps {
  currentVersion(): string;
  isDevBuild(): boolean;
  detectShadow(): boolean;
  packageRoot(): string;
  fetchLatestMetadata(signal: AbortSignal): Promise<NpmLatestMetadata>;
  installAndVerify(metadata: NpmLatestMetadata, packageRoot: string, signal: AbortSignal): Promise<void>;
  syncSystemRepo(): Promise<void>;
  syncLocal(): Promise<void>;
}

export async function fetchLatestNpmMetadata(signal: AbortSignal): Promise<NpmLatestMetadata> {
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

/**
 * Reject when `signal` aborts, so a tick that exceeds its deadline can unwind
 * out of a step whose own primitive (`downloadVerifiedTarball`,
 * `installPackageIntoPrefix`/`installPackageWithBun` in `self-update.ts`)
 * predates this service and does not accept an `AbortSignal` itself. The
 * underlying operation keeps running in the background until it settles —
 * this only stops AWAITING it — but that is exactly what the `PeriodicService`
 * contract asks for (`service.ts`): the supervisor parks/backs off on abort
 * rather than blocking forever, instead of the tick leaking a runaway install.
 */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('self-update aborted (tick deadline exceeded)'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('self-update aborted (tick deadline exceeded)'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Install + byte-verify `metadata` into `packageRoot`'s install, exactly the
 * sequence `bootstrap.ts`'s `installResolvedPackage` runs for `agents
 * upgrade` (download+integrity-verify -> sweep stale staging -> package-
 * manager install -> verify installed version -> refresh alias shims).
 * `bootstrap.ts` cannot be imported here — it runs side-effecting top-level
 * code (argv parsing, command registration) on import, which the daemon must
 * never trigger — so this is the same primitives from `self-update.ts`
 * composed directly, not a fork of the upgrade logic.
 */
export async function installAndVerifyDefault(
  metadata: NpmLatestMetadata,
  packageRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const tarball = await raceSignal(downloadVerifiedTarball(metadata.tarball, metadata.integrity), signal);
  try {
    sweepStaleInstallStaging(packageRoot);
    if (detectPackageManager(packageRoot) === 'bun') {
      await raceSignal(installPackageWithBun(tarball), signal);
    } else {
      await raceSignal(installPackageIntoPrefix(tarball, deriveGlobalPrefix(packageRoot)), signal);
    }
  } finally {
    try {
      fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
    } catch {
      /* leave it for the OS temp sweep */
    }
  }
  verifyInstalledVersion(packageRoot, metadata.version);
  refreshAliasShims(packageRoot);
}

export function defaultSelfUpdateDeps(): SelfUpdateDeps {
  return {
    currentVersion: () => getCliVersion(),
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

/**
 * Dedupes concurrent callers onto ONE in-flight attempt. The periodic tick
 * and an on-demand `request-self-update` IPC call (possibly several, if more
 * than one version-skewed client reconnects at once) can overlap in the same
 * process — without this, two concurrent `installAndVerify` calls race on the
 * same package-manager install directory. Keyed process-wide (not per-deps)
 * since production always shares one `defaultSelfUpdateDeps()` install target;
 * tests inject distinct `deps` per case and don't run concurrently with each
 * other, so this never cross-contaminates test outcomes.
 */
let inFlightAttempt: Promise<SelfUpdateOutcome> | null = null;

/**
 * Core self-update decision + action, shared by the periodic tick
 * ({@link SelfUpdateService.onTick}) and the on-demand IPC path
 * (`request-self-update`, `browser/ipc.ts`) — one implementation, so a
 * version-skew client asking "update now" runs exactly the same fail-closed
 * logic as the scheduled sweep. Returns rather than throws so callers decide
 * their own exit timing (the periodic service exits immediately; the IPC
 * handler must respond to the client on the socket BEFORE exiting, or the
 * client hangs on a socket that is closing mid-write). Concurrent callers
 * share one in-flight attempt rather than racing separate installs.
 */
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
  if (deps.isDevBuild()) {
    return { updated: false, reason: 'dev build — self-update is a no-op' };
  }
  if (deps.detectShadow()) {
    return { updated: false, reason: 'another agents binary shadows this install — self-update is a no-op' };
  }

  const current = deps.currentVersion();
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

  // Best-effort from here: the CLI package itself is already installed and
  // byte-verified, so a failure pulling the companion .system repo or
  // reconciling resources must not undo a good CLI upgrade or block the exit
  // that lets the OS supervisor relaunch onto it — it is logged and left for
  // the NEXT tick (which runs on the new code) to retry.
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
    const outcome = await attemptSelfUpdateAndExit(ctx, signal);
    if (outcome.updated) {
      // Exit immediately once verified — the periodic path owns no open
      // socket response to flush, unlike the on-demand IPC path in
      // browser/ipc.ts, which delays its own exit until after replying.
      process.exit(0);
    }
  }
}
