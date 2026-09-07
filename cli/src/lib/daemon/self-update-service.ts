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
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Runs roughly every 75 minutes — self-update is not urgent (unlike self-heal's 6h drift repair, it changes running code, so it stays well under a day but still infrequent). */
const SELF_UPDATE_TICK_MS = 75 * 60_000;
/**
 * Hard cap per tick: a real download + npm/bun install + verify can
 * legitimately take minutes on a slow link. 15 minutes matches the task's
 * stated budget and is short relative to the ~75min cadence. Exported so the
 * on-demand `request-self-update` IPC handler (`browser/ipc.ts`) can bound
 * its own `AbortController` on the SAME budget the periodic tick runs under —
 * one deadline, not two independently-tuned numbers that could drift apart.
 */
export const SELF_UPDATE_DEADLINE_MS = 15 * 60_000;
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
 * Install + byte-verify `metadata` into `packageRoot`'s install, exactly the
 * sequence `bootstrap.ts`'s `installResolvedPackage` runs for `agents
 * upgrade` (download+integrity-verify -> sweep stale staging -> package-
 * manager install -> verify installed version -> refresh alias shims).
 * `bootstrap.ts` cannot be imported here — it runs side-effecting top-level
 * code (argv parsing, command registration) on import, which the daemon must
 * never trigger — so this is the same primitives from `self-update.ts`
 * composed directly, not a fork of the upgrade logic.
 *
 * `signal` is threaded into EVERY step's own `signal` option
 * (`downloadVerifiedTarball` / `installPackageIntoPrefix` /
 * `installPackageWithBun`, all in `self-update.ts`) rather than raced against
 * from the outside: those primitives kill the underlying fetch/child process
 * on abort and their promise rejects only once that real cancellation has
 * happened. A wrapper that merely stopped AWAITING an unkillable operation
 * (the prior approach here) left an orphaned `npm install -g`/`bun add -g`
 * writing into the shared global prefix — which the very next tick's fresh
 * install (started as soon as the supervisor's backoff fires, seconds later)
 * would then race into the same directory. Real cancellation is what makes
 * `attemptSelfUpdateAndExit`'s `inFlightAttempt` dedupe (below) an actual
 * guarantee instead of a guard whose lifetime is shorter than the operation
 * it's guarding (found in review, PHNX-3695).
 */
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

  // PHNX-2768: mirror `bootstrap.ts`'s `installResolvedPackage` — an
  // `--ignore-scripts` install (both package-manager paths above) can leave
  // the package.json at the new version but the global bin links
  // (agents/ag/browser/computer) GONE. Without this, a self-update tick could
  // exit `updated: true` while every operator-typed `agents` command on that
  // box now reads "command not found," with no signal anywhere pointing at
  // why. Same fail-loud contract as the interactive path: a link that cannot
  // be made to resolve fails the whole attempt rather than reporting success.
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

export function defaultSelfUpdateDeps(): SelfUpdateDeps {
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
  // One decline source for the periodic tick and the on-demand IPC path
  // (`selfUpdateSyncDeclineReason`): dev build; shadowed install — except when
  // the install on disk is already newer than the running code, because a
  // relaunch installs nothing and a second `agents` on the box is irrelevant to
  // it (otherwise a shadowed worker never leaves the release it booted on).
  const syncDecline = selfUpdateSyncDeclineReason(deps);
  if (syncDecline) return { updated: false, reason: syncDecline };

  // Another agents process (an operator's `agents` command auto-updating, an
  // `agents upgrade`, the installer) may already have replaced the install
  // under this daemon. The code on disk is then newer than the code in memory
  // and there is nothing to download — that path verified its install before
  // it returned. Exit for the OS-supervisor relaunch, once the install has
  // settled: npm's reify is atomic but bun's is not, so a version bump alone
  // could be bun mid-extraction (`installLooksSettled`). Waiting one tick is
  // cheap; relaunching into a half-written tree is a supervisor crash-loop.
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

/** How long `scheduleSelfUpdateExit` waits before `process.exit(0)` — long enough for an IPC handler's `socket.write` to flush to the OS. */
const SELF_UPDATE_EXIT_DELAY_MS = 250;

let exitScheduled = false;

/**
 * Schedule the process exit for a verified self-update, exactly once, no
 * matter how many callers observe `outcome.updated` on the shared
 * `inFlightAttempt` promise. The periodic tick and an on-demand
 * `request-self-update` IPC call (`browser/ipc.ts`) can both be awaiting that
 * SAME promise — if the tick's continuation ran an immediate `process.exit(0)`
 * while the IPC handler's continuation had not yet reached `socket.write`,
 * the tick's exit could win the race and the client would see a closed socket
 * before any response (found in review, PHNX-3695). Routing every caller
 * through this one guarded, always-delayed scheduling point means the delay
 * protects EVERY caller's in-flight response, not just the IPC handler's own.
 */
export function scheduleSelfUpdateExit(): void {
  if (exitScheduled) return;
  exitScheduled = true;
  setTimeout(() => process.exit(0), SELF_UPDATE_EXIT_DELAY_MS);
}

/**
 * Fire the on-demand self-update in the BACKGROUND and return its (bounded)
 * promise WITHOUT the caller having to await it. This is what keeps the
 * `request-self-update` IPC handler (`browser/ipc.ts`) from parking a
 * version-skewed `agents browser` verb behind the full
 * check→download→install→verify: that handler routes through
 * `reconcileDaemonVersion` on every version-skewed call, so awaiting the whole
 * install there reintroduces exactly the client-stall PHNX-3605 was written to
 * prevent (tens of seconds, worst case ~15 min). The handler instead responds
 * "triggered" immediately and lets this run in the background — the daemon does
 * install→verify→exit(0) on its own, the OS supervisor relaunches it, and the
 * browser reconnects.
 *
 * The work still shares the module-level {@link attemptSelfUpdateAndExit}
 * `inFlightAttempt` guard, so a concurrent trigger (or the periodic tick) can't
 * race a second install into the same prefix. It is bounded by
 * {@link SELF_UPDATE_DEADLINE_MS} via an `AbortController` nobody awaits (the
 * timer is `unref`'d so it never keeps the daemon alive on its own and never
 * dangles in a test). Fail-closed is preserved end to end:
 * `runSelfUpdateAttempt` already turns an install/verify failure into a
 * not-updated outcome that leaves the running daemon untouched. The caller
 * schedules the one decoupled {@link scheduleSelfUpdateExit} off the returned
 * promise once `updated` is true, so the exit still fires after the IPC
 * response has flushed.
 */
export function triggerSelfUpdateInBackground(
  ctx: DaemonContext,
  deps: SelfUpdateDeps = defaultSelfUpdateDeps(),
): Promise<SelfUpdateOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SELF_UPDATE_DEADLINE_MS);
  if (typeof timeout.unref === 'function') timeout.unref();
  return attemptSelfUpdateAndExit(ctx, controller.signal, deps).finally(() => clearTimeout(timeout));
}

/**
 * The subset of self-update decline checks that are INSTANT and network-free —
 * a dev build, or a shadowed install. The on-demand IPC handler
 * (`request-self-update`) runs these SYNCHRONOUSLY so a version-skewed browser
 * client gets the PHNX-3605 "nothing changed, not evicting" advisory
 * immediately, instead of a "triggered" it would never act on. The remaining
 * checks (registry probe, already-current, install/verify) stay inside the
 * backgrounded {@link attemptSelfUpdateAndExit} so the handler never blocks on
 * the network or the install. This is the single source of the two instant
 * decline reasons — {@link runSelfUpdateAttempt} calls it too, so the on-demand
 * decline text can never drift from the periodic tick's. Returns the decline
 * reason, or `null` to proceed to the (backgrounded) install path.
 */
export function selfUpdateSyncDeclineReason(deps: SelfUpdateDeps = defaultSelfUpdateDeps()): string | null {
  if (deps.isDevBuild()) return DEV_BUILD_DECLINE;
  // A stale install is never declined by a shadow: the relaunch installs nothing.
  // (Whether that install has SETTLED is the attempt's call, not a decline.)
  if (deps.detectShadow() && !installedIsNewerThanRunning(deps.installedVersion(), deps.currentVersion())) {
    return SHADOW_DECLINE;
  }
  return null;
}

export const DEV_BUILD_DECLINE = 'dev build — self-update is a no-op';
export const SHADOW_DECLINE = 'another agents binary shadows this install — self-update is a no-op';

/** True when the package on disk is a strictly newer release than the one this process booted with. */
export function installedIsNewerThanRunning(installed: string, running: string): boolean {
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
  }
}
