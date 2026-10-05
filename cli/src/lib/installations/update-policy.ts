/** Settings gating the automatic update pass (PHNX-3940): the operator switch `updates.auto` /
 * `updates.<agent>.auto` (central, typed in `CONFIG_KEYS`) and per-installation `updatePolicy`.
 * The global switch is a hard kill switch that no per-harness `true` overrides. */

import { getConfigValue, setConfigValue, unsetConfigValue } from '../device-config.js';
import { withFileLockAsync } from '../fs-atomic.js';
import type { AgentId } from '../types.js';
import * as fs from 'node:fs';
import { ensureInstallationLocked, installationDir, writeInstallation } from './store.js';
import { installationLockTarget, INSTALLATION_LOCK_OPTIONS } from './installation-lock.js';
import type { Installation, UpdatePolicy } from './types.js';

function agentAutoKey(agent: AgentId): string {
  return `updates.${agent}.auto`;
}

export function rawGlobalAutoUpdateSetting(): boolean | undefined {
  return getConfigValue('updates.auto').value as boolean | undefined;
}

export function setGlobalAutoUpdateEnabled(enabled: boolean): void {
  setConfigValue('updates.auto', enabled);
}

export function unsetGlobalAutoUpdateEnabled(): void {
  unsetConfigValue('updates.auto');
}

export function isGlobalAutoUpdateEnabled(): boolean {
  return rawGlobalAutoUpdateSetting() !== false;
}

export function rawAgentAutoUpdateSetting(agent: AgentId): boolean | undefined {
  return getConfigValue(agentAutoKey(agent)).value as boolean | undefined;
}

export function setAgentAutoUpdateEnabled(agent: AgentId, enabled: boolean): void {
  setConfigValue(agentAutoKey(agent), enabled);
}

export function unsetAgentAutoUpdateEnabled(agent: AgentId): void {
  unsetConfigValue(agentAutoKey(agent));
}

/** Whether the automatic-update pass may consider this agent. `updates.auto=false` is a hard
 * kill switch that wins over `updates.<agent>.auto=true`; with the global switch on (default),
 * an explicit per-harness switch refines it, else the harness is enabled. */
export function isAutoUpdateEnabledForAgent(agent: AgentId): boolean {
  // The global switch is an emergency stop that no per-agent setting may override.
  if (!isGlobalAutoUpdateEnabled()) return false;
  const perAgent = rawAgentAutoUpdateSetting(agent);
  return perAgent !== false;
}

/** The effective policy for one installation; absent (legacy data or never set) means `'latest'`
 * (see Installation.updatePolicy). Read through this rather than comparing the field. */
export function effectiveUpdatePolicy(installation: Pick<Installation, 'updatePolicy'>): UpdatePolicy {
  return installation.updatePolicy ?? 'latest';
}

/** Persist an installation's update policy under the same lock `updateInstallation` holds, since
 * a manual pin racing an automatic `recordRelease` could revert one write. Reloads under the
 * lock and writes only the policy field, with INSTALLATION_LOCK_OPTIONS. */
export async function setInstallationUpdatePolicy(agent: AgentId, label: string, policy: UpdatePolicy): Promise<Installation> {
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
  // Guarantee `installation.json` exists and is valid before locking, migrating a legacy pre-frozen
  // dir (same as launch-gate.ts); a label never installed throws its own clear "no installation
  // directory" error, a caller bug, not a race.
  const recordPath = installationLockTarget(agent, label);
  return withFileLockAsync(recordPath, () => {
    const current = ensureInstallationLocked(agent, label);
    if (!current) {
      throw new Error(`No installation record for ${agent}@${label} — cannot set its update policy.`);
    }
    const next: Installation = { ...current, updatePolicy: policy, updatedAt: new Date().toISOString() };
    writeInstallation(next);
    return next;
  }, INSTALLATION_LOCK_OPTIONS);
}
