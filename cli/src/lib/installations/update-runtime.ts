/**
 * The automatic-update pass (PHNX-3940): decide which installations may be
 * moved to their harness's latest release with no operator in the loop, then
 * (optionally) move them.
 *
 * Split into a PLAN (`planAutoUpdates` — the `--check` dry-run and the
 * daemon's own decision step both read it; it reads through
 * {@link listInstallationSnapshots}, which NEVER mutates disk, so a preview is
 * genuinely a preview) and a RUN (`runAutoUpdatePass`, which migrates a
 * legacy installation for real, under its own lock, and regenerates its
 * already-owned shim/versioned-alias, before driving eligible plan entries
 * through the existing `updateInstallation` transaction). Both share one
 * eligibility computation so a dry-run can never report "would update" for
 * something the real run would skip, or vice versa.
 *
 * Eligibility is deliberately narrow:
 *   - Only the `npm-package` strategy is transactional AND isolated per
 *     installation (stage into a sibling dir, launch-probe it, swap, keep the
 *     displaced tree until the swap is proven) — the shape every existing
 *     safety property in `update.ts` depends on. A global-binary or
 *     install-script harness has no reversible per-installation swap to offer,
 *     so it is reported honestly as manual/vendor-managed rather than silently
 *     skipped or, worse, "updated" via an irreversible reinstall with no
 *     operator watching.
 *   - The operator switch (`updates.auto` / `updates.<agent>.auto`,
 *     `update-policy.ts`) and the per-installation policy
 *     (`Installation.updatePolicy`) must both allow it.
 *   - The installation must not look ACTIVE right now (see
 *     {@link isInstallationLikelyActive}) — a real OS process-table scan, not
 *     just this box's session registry, so a harness launched by a bare
 *     generated shim with no session bookkeeping still defers correctly.
 *
 * The latest release for a harness is resolved ONCE per pass (not once per
 * installation) — `resolveSharedTargets` below — so a fleet with a dozen
 * pinned-to-latest Claude installations issues one npm registry read, not a
 * dozen.
 */

import * as fs from 'fs';
import { AGENTS, isAgentHardDeprecated } from '../agents.js';
import { MANAGED_AGENT_IDS } from '../agent-spec/agents.js';
import { withFileLockAsync } from '../fs-atomic.js';
import type { AgentId } from '../types.js';
import {
  ensureInstallationLocked,
  installationDir,
  listInstallationLabels,
  readInstallation,
} from './store.js';
import { refreshOwnedLaunchers, hasLiveLaunchLease } from './shims.js';
import { installationLooksActive, realProcessSnapshot } from './active-check.js';
import { selectUpdateStrategy, type UpdateContext, type UpdateStrategy } from './strategies.js';
import { updateInstallation } from './update.js';
import { effectiveUpdatePolicy, isAutoUpdateEnabledForAgent } from './update-policy.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';
import { withGuardedUpdateCancellation } from './update-cancellation.js';
import { INSTALLATION_SCHEMA, type Installation, type UpdateOutcome, type UpdatePolicy } from './types.js';

export interface AutoUpdatePlanEntry {
  agent: AgentId;
  installation: Installation;
  currentRelease: string;
  /** The resolved latest release, or `null` when it could not be resolved (network error, unsupported strategy). */
  targetRelease: string | null;
  policy: UpdatePolicy;
  /** Whether the automatic pass would act on this installation at all (ignoring whether it is currently deferred). */
  eligible: boolean;
  /** Whether a live process for this installation held it back THIS pass. Independent of `eligible`. */
  deferred: boolean;
  /** Human-readable reason `eligible` is false, or `deferred` is true, or `targetRelease` is null. Unset when there is nothing to explain (already current, or a real update would run). */
  reason?: string;
}

export interface AutoUpdatePassOutcome {
  entry: AutoUpdatePlanEntry;
  outcome?: UpdateOutcome;
  error?: string;
}

export interface AutoUpdatePassResult {
  plan: AutoUpdatePlanEntry[];
  outcomes: AutoUpdatePassOutcome[];
  /** True when the pass stopped early on a cancellation request (deadline, daemon shutdown, IPC, or SIGINT/SIGTERM) rather than exhausting the plan. */
  cancelled?: boolean;
}

export interface AutoUpdatePassOptions {
  /** Scope to these agents only. Default: every non-hard-deprecated managed agent. */
  agents?: AgentId[];
  onProgress?: (message: string) => void;
}

/** The only strategy shape the automatic pass will ever touch — see the module docblock. */
function autoUpdateStrategyFor(agent: AgentId): UpdateStrategy | null {
  let strategy: UpdateStrategy;
  try {
    strategy = selectUpdateStrategy(agent);
  } catch {
    return null;
  }
  return strategy.id === 'npm-package' && strategy.transactional ? strategy : null;
}

/**
 * Build the record a real migration (`ensureInstallation`, `store.ts`) would
 * mint for a legacy version dir that has no `installation.json` yet — the
 * same fields (schema, label-as-release, history seeded from the directory's
 * own mtime) — but never persisted, and never carrying the real
 * `mintInstallationId()` format, so nothing downstream can mistake it for an
 * id that survived a lock-protected migration. Returns null when the
 * directory itself is gone mid-scan, tolerated the same way
 * `listInstallations` tolerates that.
 */
function ephemeralInstallationSnapshot(agent: AgentId, label: string): Installation | null {
  const dir = installationDir(agent, label);
  let createdAt: string;
  try {
    createdAt = fs.statSync(dir).mtime.toISOString();
  } catch {
    return null;
  }
  return {
    schema: INSTALLATION_SCHEMA,
    id: `preview:${agent}:${label}`,
    agent,
    label,
    releaseVersion: label,
    createdAt,
    updatedAt: createdAt,
    history: [{ releaseVersion: label, at: createdAt }],
  };
}

/**
 * Read-only enumeration of installations — the ONLY listing {@link planAutoUpdates}
 * may use. `listInstallations` (`store.ts`) migrates a legacy version dir's
 * `installation.json` into existence via `ensureInstallation` as a side
 * effect of merely being READ, which made `agents update --check` (a
 * "preview") write to disk. A legacy dir with no persisted record yet gets an
 * {@link ephemeralInstallationSnapshot} instead — real fields, but never
 * written and never a real id. The real run migrates it for real, under this
 * installation's own lock, immediately before acting on it — see
 * {@link runAutoUpdatePass}.
 */
export function listInstallationSnapshots(agent: AgentId): Installation[] {
  const out: Installation[] = [];
  for (const label of listInstallationLabels(agent)) {
    let record: Installation | null;
    try {
      record = readInstallation(agent, label);
    } catch {
      continue; // corrupted record — not an installation this pass can act on
    }
    const snapshot = record ?? ephemeralInstallationSnapshot(agent, label);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

/**
 * Build the automatic-update plan: one entry per installation of every scoped
 * agent, with eligibility, deferral, and the resolved target release already
 * computed. Never mutates anything — reads only through
 * {@link listInstallationSnapshots} — so it is genuinely safe to call from
 * `--check` or before every real pass.
 */
export async function planAutoUpdates(opts: AutoUpdatePassOptions = {}): Promise<AutoUpdatePlanEntry[]> {
  const agents = (opts.agents ?? MANAGED_AGENT_IDS).filter((agent) => !isAgentHardDeprecated(agent));
  let commandLines: string[] | null = null;
  let processScanError: string | undefined;
  try {
    commandLines = await realProcessSnapshot.listCommandLines();
  } catch (err) {
    processScanError = err instanceof Error ? err.message : String(err);
  }

  const plan: AutoUpdatePlanEntry[] = [];

  for (const agent of agents) {
    const installations = listInstallationSnapshots(agent);
    if (installations.length === 0) continue;

    const strategy = autoUpdateStrategyFor(agent);
    const agentAutoEnabled = isAutoUpdateEnabledForAgent(agent);

    // Resolve the latest release ONCE per agent — not once per installation —
    // and only when at least the strategy/switch preconditions hold, so a
    // harness nobody enabled auto-updates for never triggers a registry read.
    let target: string | null = null;
    let resolveError: string | undefined;
    if (strategy && agentAutoEnabled) {
      try {
        const ctx: UpdateContext = {
          agent,
          installation: installations[0],
          requested: 'latest',
          onProgress: opts.onProgress,
        };
        target = await strategy.resolveTarget(ctx);
      } catch (err) {
        resolveError = err instanceof Error ? err.message : String(err);
      }
    }

    for (const installation of installations) {
      const policy = effectiveUpdatePolicy(installation);
      let eligible = true;
      let reason: string | undefined;

      if (!strategy) {
        eligible = false;
        reason = `${AGENTS[agent].name} is manual/vendor-managed for updates (no isolated, reversible per-installation swap) — update it yourself.`;
      } else if (!agentAutoEnabled) {
        eligible = false;
        reason = 'automatic updates are disabled for this harness (updates.auto / updates.<agent>.auto).';
      } else if (policy === 'pinned') {
        eligible = false;
        reason = 'installation is pinned to a concrete release (agents update … --to <release> unpins with --to latest).';
      } else if (resolveError) {
        eligible = false;
        reason = `could not resolve the latest release: ${resolveError}`;
      }

      let deferred = false;
      if (eligible) {
        if (hasLiveLaunchLease(installation.agent, installation.label)) {
          deferred = true;
          reason = 'a launch is in flight for this installation (live launch lease); deferring.';
        } else if (commandLines) {
          deferred = installationLooksActive(installation, commandLines);
          if (deferred) reason = 'the installation appears to have a process running right now; deferring.';
        } else {
          // The process scan itself failed — fail closed for every installation
          // this pass would otherwise touch, not just the ones a scan would have
          // flagged as active.
          deferred = true;
          reason = `could not confirm no process is running (${processScanError}); deferring.`;
        }
      }

      plan.push({
        agent,
        installation,
        currentRelease: installation.releaseVersion,
        targetRelease: target,
        policy,
        eligible,
        deferred,
        reason,
      });
    }
  }

  return plan;
}

/**
 * Run the automatic-update pass: plan, then drive every eligible,
 * non-deferred, actually-behind entry through {@link updateInstallation}.
 * Installations update sequentially — this runs from a bounded daemon-spawned
 * child process (`harness-update-service.ts`) on its own schedule, not a
 * user-facing wait, so there is no reason to parallelize and every reason not
 * to (concurrent npm installs sharing this box's npm cache have a history of
 * corrupting each other).
 *
 * `abortIfPinnedBeforeCommit` / `abortIfAutoDisabledBeforeCommit: true` on
 * every call: this is the ONE caller for whom a policy or switch change
 * mid-staging must cancel the commit (see `update.ts`'s docblock on those
 * options) — a manual `agents update` never routes through here.
 */
export async function runAutoUpdatePass(opts: AutoUpdatePassOptions = {}): Promise<AutoUpdatePassResult> {
  // Cancellation is wired from IPC (the daemon's cross-platform request),
  // channel `disconnect` (daemon gone), and SIGTERM/SIGINT — never a forced
  // process kill (see `update-cancellation.ts`). The guard it holds is what lets
  // `index.ts` defer its SIGINT hard-exit while a swap is in flight.
  return withGuardedUpdateCancellation(async (cancelled) => {
    const result = await runAutoUpdatePassUntilCancelled(opts, cancelled);
    return { ...result, cancelled: cancelled() };
  });
}

/**
 * The hidden `__harness-update-run` verb the daemon spawns with an IPC channel
 * (dispatched in `index.ts`). Runs ONE auto-update pass with the cooperative,
 * cross-platform cancellation above, writes a compact JSON summary to stdout for
 * the daemon's log, and returns the process exit code.
 *
 * Exit code mirrors the manual `agents update --auto` path
 * (`commands/update.ts`): a per-installation error is a NORMAL tick outcome (a
 * bad vendor release) surfaced as a non-zero exit the daemon logs as a warning,
 * not a service failure. A cooperative cancel is not itself an error, so it does
 * not force a non-zero exit — the child exits on its own and the daemon observes
 * that true completion rather than reading a killed process.
 */
export async function runHarnessUpdateChild(): Promise<number> {
  const result = await runAutoUpdatePass({});
  const anyError = result.outcomes.some((o) => o.error);
  const summary = {
    v: 1,
    cancelled: result.cancelled ?? false,
    outcomes: result.outcomes.map((o) => ({
      agent: o.entry.agent,
      label: o.entry.installation.label,
      fromRelease: o.outcome?.fromRelease ?? null,
      toRelease: o.outcome?.toRelease ?? null,
      unchanged: o.outcome?.unchanged ?? null,
      deferred: o.outcome?.deferred ?? null,
      error: o.error ?? null,
    })),
  };
  process.stdout.write(JSON.stringify(summary));
  return anyError ? 1 : 0;
}

async function runAutoUpdatePassUntilCancelled(opts: AutoUpdatePassOptions, cancelled: () => boolean): Promise<AutoUpdatePassResult> {
  const plan = await planAutoUpdates(opts);
  const outcomes: AutoUpdatePassOutcome[] = [];
  // One shim resolves every installation of an agent dynamically at launch
  // time, so regenerating it once per agent (not once per installation) this
  // pass touches is enough — a second entry for the same agent would just
  // redo `ensureShimCurrent`'s own no-op "already current" check.

  for (const entry of plan) {
    if (cancelled()) break;
    if (!entry.eligible || entry.deferred) continue;
    if (!entry.targetRelease || entry.targetRelease === entry.currentRelease) continue;

    try {
      // The plan above is deliberately read-only (`listInstallationSnapshots`),
      // so a legacy version dir with no persisted `installation.json` yet is
      // represented there by an ephemeral, never-written snapshot. A REAL
      // pass must migrate it for real before acting on it — done here, under
      // the SAME per-installation lock `updateInstallation` itself takes
      // (`INSTALLATION_LOCK_OPTIONS`), so two concurrent real passes can never
      // mint two different ids for the same legacy install. Already-migrated
      // installations round-trip through this unchanged (`ensureInstallation`
      // is a plain read when a record already exists).
      const installation = await withFileLockAsync(
        installationLockTarget(entry.agent, entry.installation.label),
        () => ensureInstallationLocked(entry.agent, entry.installation.label, entry.installation.createdAt),
        INSTALLATION_LOCK_OPTIONS,
      );

      // Regenerate only what this pass already owns — the agent's generated
      // shim, and this installation's versioned alias if it was installed
      // isolated — using the existing upgrade-in-place helpers
      // (`ensureShimCurrent`/`ensureVersionedAliasCurrent`). Deliberately
      // NEVER `adoptShadowingLauncher`: that seizes a launcher this pass does
      // not own (a user's own PATH entry, or another install's), and is an
      // operator-triggered `doctor --fix` action, not something an unattended
      // background pass may do on its own. Real-pass-only, same reason as the
      // migration above — a `--check` preview must not touch PATH or a
      // config-dir symlink.
      refreshOwnedLaunchers(entry.agent, installation.label);

      const outcome = await updateInstallation(installation, {
        to: entry.targetRelease,
        onProgress: opts.onProgress,
        abortIfPinnedBeforeCommit: true,
        abortIfAutoDisabledBeforeCommit: true,
        shouldCancel: cancelled,
      });
      outcomes.push({ entry, outcome });
    } catch (err) {
      outcomes.push({ entry, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { plan, outcomes };
}
