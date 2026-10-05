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
  updatePolicy?: Installation['updatePolicy'];
  shouldCancel?: () => boolean;
  to?: string;
  onProgress?: (message: string) => void;
  /** Replace the registry-selected strategy. The seam lets the transaction run against a real
   * filesystem without a vendor fetch, and lets a track that installs differently (per-
   * installation Cursor isolation) reuse this orchestration. Omitted in normal calls. */
  strategy?: UpdateStrategy;
  /** Abort just before `commit()` if the update policy flipped to `'pinned'` since staging
   * began. Set only by the automatic pass: a manual `agents update` is the user's own request,
   * but an automatic run must not commit an update the operator pinned away mid-stage. */
  abortIfPinnedBeforeCommit?: boolean;
  /** Set only by the automatic pass: right before `commit()`, re-read the `updates.auto`
   * switches and abort if automatic updates were turned off for this harness mid-stage. Same
   * reasoning as abortIfPinnedBeforeCommit; a manual `agents update` never sets it. */
  abortIfAutoDisabledBeforeCommit?: boolean;
}

/** Move one frozen installation to a new vendor release, preserving identity: stage, verify
 * (launch the staged binary), commit (swap, keeping the old), record (write the release, drop
 * rollback), rolling back on failure. `id` and `label` never change. */
export async function updateInstallation(
  installation: Installation,
  options: UpdateInstallationOptions = {}
): Promise<UpdateOutcome> {
  const agent = installation.agent;
  if (isAgentHardDeprecated(agent)) throw new Error(hardDeprecationError(agent));

  // Serialize every update of this installation behind a cross-process lock on its record file, so
  // two updates cannot stage into one version dir. Re-read the record under the lock; a corrupt
  // record throws and fails closed.
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

  // Mandatory for every transactional strategy, manual or automatic: a live process or launch lease
  // on this installation (active-check.ts) makes staging unsafe. Re-checked before commit because
  // staging can take minutes.
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

    if (staged.release === installation.releaseVersion) {
      if (options.updatePolicy) {
        installation.updatePolicy = options.updatePolicy;
        installation.updatedAt = new Date().toISOString();
        writeInstallation(installation);
      }
      options.onProgress?.(
        `${AGENTS[agent].name}@${installation.label} is already on release ${staged.release}; nothing to update.`
      );
      // Deliberately not committed: with no new release, a commit would displace a working tree,
      // discard rollback material and skip the live probe while reporting no change. The finally
      // clears staging.
      return {
        installation,
        strategy: strategy.id,
        fromRelease: installation.releaseVersion,
        toRelease: staged.release,
        unchanged: true,
        alsoUpdated: [],
      };
    }

    // Recheck the pin right before the point of no return, since staging can take minutes and a pin
    // may land mid-way. Manual updates never set this: the user's invocation is their intent.
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

    // Automatic-only: the operator may have turned auto-update off while staging ran, and the
    // unattended pass must honor that. A manual update never sets this; it is itself the decision.
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

    // Mandatory for every transactional strategy and caller: closes the window where a launch
    // starts after the pre-stage check but before the swap.
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
      const liveBinary = getBinaryPath(agent, installation.label);
      const liveHealth = await verifyBinaryLaunches(liveBinary, staged.home);
      if (!liveHealth.ok) {
        throw new Error(
          `${AGENTS[agent].name} release ${staged.release} failed to launch after being installed`
          + `${liveHealth.detail ? ` (${liveHealth.detail})` : ''}.`
        );
      }
    } catch (err) {
      // Undo unconditionally. `transactional` says whether the vendor artifact is restorable, not
      // this directory; gating undo on it left a broken tree live and the old one orphaned. No-op
      // undo if nothing to restore.
      handles.undo();
      throw new Error(
        strategy.transactional
          ? `${(err as Error).message} Rolled back to ${installation.releaseVersion}.`
          : `${(err as Error).message} The version directory was restored, but ${AGENTS[agent].name}'s installer `
            + `had already replaced the binary it manages globally — repair it with: agents add ${agent}@latest`
      );
    }
    // Record before finalize: finalize() discards the only rollback material. If recordRelease
    // threw after it, the new release would be live with no way back and no record. Recording first
    // keeps failure at nothing changed.
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
    // Persist the new release before finalize discards the only rollback material.
    handles.finalize();

    // Installations of a global-binary harness share one file, so the replaced binary is live for
    // all of them. Record the release on each, or the others claim a release no longer on disk.
    const alsoUpdated = strategy.sharedBinary
      ? listInstallations(agent)
        .filter((other) => other.label !== installation.label && other.releaseVersion !== staged!.release)
        .map((other) => recordRelease(other, staged!.release))
      : [];

    invalidateInstalledVersionsCache(agent);
    invalidateLiveVersionCache(agent);
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
