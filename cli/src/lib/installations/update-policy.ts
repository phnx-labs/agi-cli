
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

export function isAutoUpdateEnabledForAgent(agent: AgentId): boolean {
  // The global switch is an emergency stop that no per-agent setting may override.
  if (!isGlobalAutoUpdateEnabled()) return false;
  const perAgent = rawAgentAutoUpdateSetting(agent);
  return perAgent !== false;
}

export function effectiveUpdatePolicy(installation: Pick<Installation, 'updatePolicy'>): UpdatePolicy {
  return installation.updatePolicy ?? 'latest';
}

export async function setInstallationUpdatePolicy(agent: AgentId, label: string, policy: UpdatePolicy): Promise<Installation> {
  if (!fs.existsSync(installationDir(agent, label))) throw new Error(`No installation directory for ${agent}@${label}.`);
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
