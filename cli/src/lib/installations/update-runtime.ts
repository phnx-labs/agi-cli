
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
  targetRelease: string | null;
  policy: UpdatePolicy;
  eligible: boolean;
  deferred: boolean;
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
  cancelled?: boolean;
}

export interface AutoUpdatePassOptions {
  agents?: AgentId[];
  onProgress?: (message: string) => void;
}

function autoUpdateStrategyFor(agent: AgentId): UpdateStrategy | null {
  let strategy: UpdateStrategy;
  try {
    strategy = selectUpdateStrategy(agent);
  } catch {
    return null;
  }
  // Unattended updates are limited to reversible, per-install npm swaps.
  return strategy.id === 'npm-package' && strategy.transactional ? strategy : null;
}

// Planning uses an ephemeral record and must not adopt or mutate a legacy installation.
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

export function listInstallationSnapshots(agent: AgentId): Installation[] {
  const out: Installation[] = [];
  for (const label of listInstallationLabels(agent)) {
    let record: Installation | null;
    try {
      record = readInstallation(agent, label);
    } catch {
      continue;
    }
    const snapshot = record ?? ephemeralInstallationSnapshot(agent, label);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

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

export async function runAutoUpdatePass(opts: AutoUpdatePassOptions = {}): Promise<AutoUpdatePassResult> {
  return withGuardedUpdateCancellation(async (cancelled) => {
    const result = await runAutoUpdatePassUntilCancelled(opts, cancelled);
    return { ...result, cancelled: cancelled() };
  });
}

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

  for (const entry of plan) {
    if (cancelled()) break;
    if (!entry.eligible || entry.deferred) continue;
    if (!entry.targetRelease || entry.targetRelease === entry.currentRelease) continue;

    try {
      const installation = await withFileLockAsync(
        installationLockTarget(entry.agent, entry.installation.label),
        () => ensureInstallationLocked(entry.agent, entry.installation.label, entry.installation.createdAt),
        INSTALLATION_LOCK_OPTIONS,
      );

      // Refresh agents-cli-owned launchers only; never adopt a user's launcher in background work.
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
