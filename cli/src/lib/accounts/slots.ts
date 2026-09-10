/**
 * Per-device account slots (PHNX-3940).
 *
 * An account is a credential slot, not an installation. The binary lives in
 * the one managed harness install; each account gets a HOME-shaped dir under
 * `~/.agents/.history/accounts/<harness>/<accountId>/` with no binary in it.
 * Native OAuth files stay in this dir on the device that minted them and are
 * never copied. Settings and resources are projected through the same writers
 * version homes use (`carryForwardSettings`, `getWriter`) — credentials are
 * excluded by those writers.
 *
 * Slot records live in the device doc (`deviceAccounts.slots`), never central.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentConfigDirName } from '../agents.js';
import { harnessAuth, harnessWorkerIsPerDevice } from '../harness-auth-capabilities.js';
import { getGlobalDefault, getVersionHomePath, listInstalledVersions } from '../installations/store.js';
import { carryForwardSettings } from '../settings-manifest.js';
import { getHistoryDir, readMeta, updateMeta } from '../state.js';
import { syncResourcesToHome, type SyncResourcesOptions } from '../installations/versions.js';
import type { ResourceSelection, SyncResult } from '../installations/versions.js';
import type { AccountAuthMode, AgentId, DeviceAccountSlot, Meta } from '../types.js';
import { isAgentId } from '../types.js';

export type { DeviceAccountSlot };

const AUTH_MODES: readonly AccountAuthMode[] = ['native', 'durable', 'per-device'];

export function slotDir(harness: AgentId, accountId: string): string {
  if (!isAgentId(harness)) throw new Error(`Unknown harness '${harness}' for a slot dir.`);
  if (!accountId || /[\\/]|\.\./.test(accountId)) {
    throw new Error(`Invalid account id '${accountId}' for a slot dir.`);
  }
  return path.join(getHistoryDir(), 'accounts', harness, accountId);
}

export function readSlots(meta: Pick<Meta, 'deviceAccounts'>): Record<string, DeviceAccountSlot> {
  return { ...(meta.deviceAccounts?.slots ?? {}) };
}

export function recordSlot(accountId: string, slot: DeviceAccountSlot): void {
  if (slot.accountId !== accountId) {
    throw new Error(`recordSlot accountId mismatch: key '${accountId}' vs slot.accountId '${slot.accountId}'.`);
  }
  if (!AUTH_MODES.includes(slot.authMode)) {
    throw new Error(`recordSlot: unknown authMode '${slot.authMode}'.`);
  }
  updateMeta((current) => ({
    ...current,
    deviceAccounts: {
      ...current.deviceAccounts,
      slots: { ...current.deviceAccounts?.slots, [accountId]: slot },
    },
  }));
}

function defaultAuthMode(harness: AgentId): AccountAuthMode {
  return harnessWorkerIsPerDevice(harness) ? 'per-device' : 'native';
}

function sourceVersion(harness: AgentId): string | null {
  return getGlobalDefault(harness) ?? listInstalledVersions(harness)[0] ?? null;
}

/** Project resources into one account slot through the installation writer. */
export function syncResourcesToSlot(
  harness: AgentId,
  version: string,
  home: string,
  selection?: ResourceSelection,
  options: SyncResourcesOptions = {},
): SyncResult {
  return syncResourcesToHome(harness, version, home, selection, options);
}

/** Reconcile every materialized account slot for one harness. */
export function syncResourcesToAccountSlots(
  harness: AgentId,
  version: string,
  selection?: ResourceSelection,
  options: SyncResourcesOptions = {},
): Array<{ accountId: string; result: SyncResult }> {
  const meta = readMeta();
  const slots = readSlots(meta);
  const results: Array<{ accountId: string; result: SyncResult }> = [];
  const accounts = [
    ...Object.values(meta.accounts?.native ?? {}),
    ...Object.values(meta.deviceAccounts?.native ?? {}),
  ];
  for (const account of accounts) {
    if (account.agent !== harness) continue;
    const slot = slots[account.id];
    if (!slot || !fs.existsSync(slot.slotDir)) continue;
    results.push({
      accountId: account.id,
      result: syncResourcesToSlot(harness, version, slot.slotDir, selection, options),
    });
  }
  return results;
}

/**
 * Create the HOME-shaped slot dir and project settings/resources from the
 * managed install. Does not copy credentials (carryForwardSettings excludes
 * them; resource writers write skills/hooks/commands, never OAuth files).
 * Does not persist the slot record — call {@link recordSlot} after identity
 * is captured.
 */
export function ensureSlot(harness: AgentId, accountId: string): DeviceAccountSlot {
  harnessAuth(harness);
  const dir = slotDir(harness, accountId);
  fs.mkdirSync(path.join(dir, agentConfigDirName(harness)), { recursive: true });

  const version = sourceVersion(harness);
  if (version) {
    const fromHome = getVersionHomePath(harness, version);
    if (fs.existsSync(fromHome)) {
      carryForwardSettings(harness, fromHome, dir);
      syncResourcesToSlot(harness, version, dir, undefined, { force: true });
    }
  }

  return {
    accountId,
    slotDir: dir,
    authMode: defaultAuthMode(harness),
    verdict: 'unconfigured',
  };
}
