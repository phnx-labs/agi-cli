import * as fs from 'fs';
import { AGENTS, isAgentHardDeprecated, hardDeprecationError } from '../agents.js';
import { emit } from '../feed/events.js';
import { withFileLockAsync } from '../fs-atomic.js';
import {
  getBinaryPath,
  invalidateInstalledVersionsCache,
  invalidateLiveVersionCache,
  verifyBinaryLaunches,
} from './versions.js';
import {
  assertValidRelease,
  selectUpdateStrategy,
  type StagedRelease,
  type UpdateContext,
  type UpdateStrategy,
} from './strategies.js';
import { listInstallations, readInstallation, recordRelease, writeInstallation } from './store.js';
import { effectiveUpdatePolicy, isAutoUpdateEnabledForAgent } from './update-policy.js';
import { describeInstallationActivity, formatInUseDeferral } from './active-check.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';
import type { Installation, UpdateOutcome } from './types.js';

export interface UpdateInstallationOptions {
  /** Persist together with a successfully selected release, under this transaction's lock. */
  updatePolicy?: Installation['updatePolicy'];
  /** Cooperative cancellation is honored before the swap, never during record/rollback. */
  shouldCancel?: () => boolean;
  /** `latest` (default), `oldest`, or a concrete release. */
  to?: string;
  onProgress?: (message: string) => void;
  /**
   * Replace the registry-selected strategy. The seam exists so the transaction
   * below can be exercised against a real filesystem without a vendor fetch, and
   * so a track that installs a harness differently (per-installation Cursor
   * isolation) can reuse this orchestration instead of re-implementing it.
   * Omitted in every normal call — `selectUpdateStrategy` is the default.
   */
  strategy?: UpdateStrategy;
  /**
   * Abort just before `commit()` if the installation's update policy has
   * flipped to `'pinned'` since staging began, instead of making the staged
   * release live. Set only by the automatic-update pass
   * (`update-runtime.ts`): a manual `agents update` is itself the user's
   * request and must never be undercut by a policy read mid-flight, but an
   * automatic run must not commit an update the operator pinned away from
   * while the (potentially minutes-long) stage was in flight.
   */
  abortIfPinnedBeforeCommit?: boolean;
  /**
   * Set only by the automatic-update pass (`update-runtime.ts`). Right before
   * `commit()`, re-reads the global/per-harness `updates.auto` switches
   * (`update-policy.ts`) in addition to the pin check above, aborting the
   * commit if automatic updates were turned off for this harness while the
   * (potentially minutes-long) stage was in flight. Same reasoning as
   * {@link abortIfPinnedBeforeCommit}: a manual `agents update` is itself the
   * user's own current request and must never be undercut by a policy read
   * mid-flight, so it never sets this.
   */
  abortIfAutoDisabledBeforeCommit?: boolean;
}

/**
 * Move one frozen installation to a new vendor release, preserving its identity.
 *
 * The transaction is stage → verify → commit → record, with rollback on any
 * failure after the swap:
 *
 *   1. **stage**   — fetch the target release somewhere that is not yet live.
 *   2. **verify**  — launch the STAGED binary. This is the gate that makes the
 *                    update safe: a release that cannot start is discarded while
 *                    the working one is still in place, so the failure mode is
 *                    "nothing changed", not "the agent no longer runs".
 *   3. **commit**  — swap it in, keeping the displaced release until step 4.
 *   4. **record**  — re-verify in place, then write the new release into the
 *                    installation record and drop the rollback material.
 *
 * The installation's `id` and `label` are never touched, so the global default,
 * an isolated default, a project pin, a routine's `version:`, and a profile's
 * `host.version` all keep resolving to this installation across the update —
 * that reference preservation is the whole point of freezing the label.
 *
 * Strategies whose vendor artifact is global (a self-updating binary) report
 * `transactional: false`; for those, step 3 is a no-op and a failed verify is
 * surfaced as a failed update rather than pretended to be reversible.
 */
export async function updateInstallation(
  installation: Installation,
  options: UpdateInstallationOptions = {}
): Promise<UpdateOutcome> {
  const agent = installation.agent;
  if (isAgentHardDeprecated(agent)) throw new Error(hardDeprecationError(agent));

  // Serialize every update of this SAME installation — manual and automatic
  // alike — behind a cross-process lock keyed on its own record file. Without
  // it, an operator's `agents update claude@2.0.65` racing the automatic pass
  // (or two automatic passes on two boxes sharing this ~/.agents, which
  // shouldn't happen but isn't prevented at this layer) could stage two
  // releases into the same version dir and interleave their swaps. The record
  // is re-read fresh under the lock (never trusting the possibly-stale
  // `installation` the caller passed in) so a concurrent update that already
  // landed is observed before this one decides what to do; a corrupted record
  // makes `readInstallation` throw, which propagates out of the locked section
  // and fails the update closed rather than proceeding on unreadable state.
  return withFileLockAsync(
    installationLockTarget(agent, installation.label),
    () => runUpdateInstallation(agent, installation, options),
    INSTALLATION_LOCK_OPTIONS,
  );
}

async function runUpdateInstallation(
  agent: Installation['agent'],
  requestedInstallation: Installation,
  options: UpdateInstallationOptions,
): Promise<UpdateOutcome> {
  const installation = readInstallation(agent, requestedInstallation.label) ?? requestedInstallation;

  const requested = options.to ?? 'latest';
  assertValidRelease(requested);

  const strategy = options.strategy ?? selectUpdateStrategy(agent);
  const ctx: UpdateContext = { agent, installation, requested, onProgress: options.onProgress };
  const target = await strategy.resolveTarget(ctx);

  if (target === installation.releaseVersion) {
    if (options.updatePolicy) {
      installation.updatePolicy = options.updatePolicy;
      installation.updatedAt = new Date().toISOString();
      writeInstallation(installation);
    }
    options.onProgress?.(
      `${AGENTS[agent].name}@${installation.label} is already on release ${target}; nothing to update.`
    );
    return {
      installation,
      strategy: strategy.id,
      fromRelease: installation.releaseVersion,
      toRelease: target,
      unchanged: true,
      alsoUpdated: [],
    };
  }

  // Mandatory for every transactional strategy, every caller — manual
  // `agents update` included, not just the automatic pass. A transactional
  // strategy's commit is a swap of THIS installation's own directory, so a
  // live process or launch lease naming it (`active-check.ts`) means staging
  // right now risks a launch racing the swap. This is the pre-STAGE half of
  // the check, taken under the same lock this whole transaction holds — the
  // identical check runs again immediately before commit below, since staging
  // an npm package can take the better part of `INSTALL_TIMEOUT_MS` and a
  // launch can start during that window. Non-transactional strategies (a
  // global-binary/install-script harness) have no reversible swap to protect,
  // so they are unaffected by either check.
  if (options.shouldCancel?.() || (options.abortIfPinnedBeforeCommit && effectiveUpdatePolicy(installation) === 'pinned')
      || (options.abortIfAutoDisabledBeforeCommit && !isAutoUpdateEnabledForAgent(agent))) {
    return { installation, strategy: strategy.id, fromRelease: installation.releaseVersion, toRelease: target,
      unchanged: true, deferred: 'Update cancelled or automatic update policy changed.', alsoUpdated: [] };
  }
  if (strategy.transactional) {
    const activity = await describeInstallationActivity(installation);
    if (activity.active) {
      const name = `${AGENTS[agent].name}@${installation.label}`;
      options.onProgress?.(`${name} looks active right now; not staging release ${target}.`);
      return {
        installation,
        strategy: strategy.id,
        fromRelease: installation.releaseVersion,
        toRelease: target,
        unchanged: true,
        deferred: formatInUseDeferral(name, activity),
        alsoUpdated: [],
      };
    }
  }

  let staged: StagedRelease | null = null;
  try {
    staged = await strategy.stage(ctx, target);

    const stagedHealth = await verifyBinaryLaunches(staged.binary, staged.home);
    if (!stagedHealth.ok) {
      throw new Error(
        `${AGENTS[agent].name} release ${staged.release} was fetched but its binary failed to launch`
        + `${stagedHealth.detail ? ` (${stagedHealth.detail})` : ''}. `
        + `${installation.label} is unchanged and still on ${installation.releaseVersion}.`
      );
    }

    // The installer may have reported a release the installation already has
    // (a self-updating binary that was already current). Recording it would
    // claim a change that did not happen and append a bogus history entry.
    if (staged.release === installation.releaseVersion) {
      if (options.updatePolicy) {
        installation.updatePolicy = options.updatePolicy;
        installation.updatedAt = new Date().toISOString();
        writeInstallation(installation);
      }
      options.onProgress?.(
        `${AGENTS[agent].name}@${installation.label} is already on release ${staged.release}; nothing to update.`
      );
      // Deliberately NOT committed: there is no new release to make live, and
      // for a strategy that swaps the version dir a commit here would displace
      // a working tree, discard its rollback material, and skip the live probe —
      // all while reporting that nothing changed. The `finally` clears staging.
      return {
        installation,
        strategy: strategy.id,
        fromRelease: installation.releaseVersion,
        toRelease: staged.release,
        unchanged: true,
        alsoUpdated: [],
      };
    }

    // The automatic pass may have started staging while the installation was
    // still eligible, then had it pinned out from under it — staging an npm
    // package can legitimately take the better part of INSTALL_TIMEOUT_MS. Check
    // ONE more time, right before the point of no return, so a policy change
    // that lands mid-staging is honored instead of committed anyway. A manual
    // `agents update` never sets this option: the user's own invocation IS their
    // current intent, so there is nothing to defer to.
    if (options.abortIfPinnedBeforeCommit) {
      const fresh = readInstallation(agent, installation.label);
      if (fresh && effectiveUpdatePolicy(fresh) === 'pinned') {
        options.onProgress?.(
          `${AGENTS[agent].name}@${installation.label} was pinned while ${staged.release} was staging; not committing it.`
        );
        return {
          installation: fresh,
          strategy: strategy.id,
          fromRelease: fresh.releaseVersion,
          toRelease: staged.release,
          unchanged: true,
          deferred: 'Installation was pinned while the update was being prepared.',
          alsoUpdated: [],
        };
      }
    }

    // Automatic-only, same reasoning as the pin recheck above: the operator
    // may have flipped `updates.auto` / `updates.<agent>.auto` off while this
    // release was staging (minutes for a real npm install), and an automatic
    // run must honor that instead of committing an update the operator just
    // asked to stop. A manual `agents update` never sets this — the user's
    // own invocation already IS the decision to update, regardless of the
    // switch that only gates the UNATTENDED pass.
    if (options.abortIfAutoDisabledBeforeCommit && !isAutoUpdateEnabledForAgent(agent)) {
      options.onProgress?.(
        `${AGENTS[agent].name}@${installation.label}: automatic updates were turned off while ${staged.release} `
        + `was staging; not committing it.`
      );
      return {
        installation,
        strategy: strategy.id,
        fromRelease: installation.releaseVersion,
        toRelease: staged.release,
        unchanged: true,
        deferred: 'Automatic updates were turned off while the update was being prepared.',
        alsoUpdated: [],
      };
    }

    // Mandatory for every transactional strategy, every caller — see the
    // identical pre-stage check above for why this cannot be opt-in: a launch
    // that starts AFTER that first check but before this swap is exactly the
    // window this closes.
    const lateActivity = strategy.transactional ? await describeInstallationActivity(installation) : null;
    if (options.shouldCancel?.() || lateActivity?.active) {
      options.onProgress?.(
        `${AGENTS[agent].name}@${installation.label} looks active now (a process or launch lease appeared while `
        + `${staged.release} was staging); not committing it.`
      );
      return {
        installation,
        strategy: strategy.id,
        fromRelease: installation.releaseVersion,
        toRelease: staged.release,
        unchanged: true,
        deferred: lateActivity?.active
          ? formatInUseDeferral(`${AGENTS[agent].name}@${installation.label}`, lateActivity)
          : 'Update cancelled while the release was being prepared.',
        alsoUpdated: [],
      };
    }

    const handles = await strategy.commit(ctx, staged);
    try {
      // Probe what will actually execute — `getBinaryPath` is the same resolver
      // the shims and `agents run` use — not the staging copy probed above.
      const liveBinary = getBinaryPath(agent, installation.label);
      const liveHealth = await verifyBinaryLaunches(liveBinary, staged.home);
      if (!liveHealth.ok) {
        throw new Error(
          `${AGENTS[agent].name} release ${staged.release} failed to launch after being installed`
          + `${liveHealth.detail ? ` (${liveHealth.detail})` : ''}.`
        );
      }
    } catch (err) {
      // Undo unconditionally. `transactional` describes whether the VENDOR
      // artifact can be put back, not whether this directory can — gating the
      // undo on it left an installer-driven harness with the broken tree live
      // AND the previous one orphaned in rollback material nothing deletes.
      // A strategy with nothing to restore returns a no-op undo.
      handles.undo();
      throw new Error(
        strategy.transactional
          ? `${(err as Error).message} Rolled back to ${installation.releaseVersion}.`
          : `${(err as Error).message} The version directory was restored, but ${AGENTS[agent].name}'s installer `
            + `had already replaced the binary it manages globally — repair it with: agents add ${agent}@latest`
      );
    }
    // Record BEFORE finalizing the commit's rollback material — not after.
    // `finalize()` discards the only thing that can put the previous release
    // back (deletes the rollback dir / no-ops for a non-transactional
    // strategy). If `recordRelease` throws (e.g. disk full, an unwritable
    // installation.json) AFTER finalize, the new release is live on disk with
    // no rollback path AND no record of it — an installation whose directory
    // and its own metadata now disagree, with no way back. Recording first
    // means a record-write failure still has the rollback material available
    // to undo the live swap, so the failure mode stays "nothing changed"
    // instead of "half updated, unrecoverable."
    let updated: Installation;
    try {
      updated = recordRelease({ ...installation, ...(options.updatePolicy ? { updatePolicy: options.updatePolicy } : {}) }, staged.release);
    } catch (err) {
      handles.undo();
      throw new Error(
        strategy.transactional
          ? `${(err as Error).message} ${AGENTS[agent].name} release ${staged.release} could not be recorded. `
            + `Rolled back to ${installation.releaseVersion}.`
          : `${(err as Error).message} ${AGENTS[agent].name} release ${staged.release} could not be recorded. `
            + `The version directory was restored, but ${AGENTS[agent].name}'s installer had already replaced the `
            + `binary it manages globally — repair it with: agents add ${agent}@latest`
      );
    }
    handles.finalize();

    // Several installations of a global-binary harness point at the same file,
    // so the one we just replaced is live for all of them. Recording the release
    // only on the target would leave the others claiming a release that is no
    // longer on disk.
    const alsoUpdated = strategy.sharedBinary
      ? listInstallations(agent)
        .filter((other) => other.label !== installation.label && other.releaseVersion !== staged!.release)
        .map((other) => recordRelease(other, staged!.release))
      : [];

    invalidateInstalledVersionsCache(agent);
    invalidateLiveVersionCache(agent);
    // A release really was installed, so this is the right event; `installation`
    // says WHICH frozen install received it, since the label no longer equals
    // the release.
    emit('version.install', { agent, version: staged.release, installation: installation.label });

    return {
      installation: updated,
      strategy: strategy.id,
      fromRelease: installation.releaseVersion,
      toRelease: staged.release,
      unchanged: false,
      alsoUpdated,
    };
  } finally {
    if (staged?.stagingDir) fs.rmSync(staged.stagingDir, { recursive: true, force: true });
  }
}
