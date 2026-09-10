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
import { ALL_RESOURCE_KINDS, getDetector, getWriter, kindToCapability } from '../staleness/registry.js';
import { supports } from '../capabilities.js';
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

function projectResources(harness: AgentId, version: string, destHome: string, fromHome: string): void {
  const cwd = process.cwd();
  for (const kind of ALL_RESOURCE_KINDS) {
    if (!supports(harness, kindToCapability(kind), version).ok) continue;
    const writer = getWriter(kind, harness);
    if (!writer) continue;
    if (kind === 'rules') {
      writer.write({ version, versionHome: destHome, selection: { preset: 'default' }, cwd });
      continue;
    }
    const names = getDetector(kind, harness)?.list({ version, versionHome: fromHome, cwd }) ?? [];
    if (names.length === 0) continue;
    writer.write({ version, versionHome: destHome, selection: names, cwd });
  }
}

export interface SlotProjection {
  accountId: string;
  /** Account name as registered (`agents accounts list`). */
  name: string;
  slotDir: string;
  /** The version home the slot was projected from. */
  from: string;
  /** `<kind>/<name>` artifacts removed because the source no longer has them. */
  pruned: string[];
}

/**
 * Remove slot artifacts whose source name is gone. Only the name-keyed kinds
 * that implement `remove` (commands, skills, hooks) are pruned; wholesale kinds
 * (rules, permissions) are rewritten by the projection itself.
 */
function pruneSlotResources(harness: AgentId, version: string, slotHome: string, fromHome: string): string[] {
  const cwd = process.cwd();
  const pruned: string[] = [];
  for (const kind of ALL_RESOURCE_KINDS) {
    if (!supports(harness, kindToCapability(kind), version).ok) continue;
    const writer = getWriter(kind, harness);
    const detector = getDetector(kind, harness);
    if (!writer?.remove || !detector) continue;
    const source = new Set(detector.list({ version, versionHome: fromHome, cwd }));
    for (const name of detector.list({ version, versionHome: slotHome, cwd })) {
      if (source.has(name)) continue;
      if (writer.remove({ version, versionHome: slotHome, name, cwd }).removed) pruned.push(`${kind}/${name}`);
    }
  }
  return pruned;
}

/**
 * Re-project settings and resources into every account slot this device holds
 * for `harness`, from the harness's default version home. `ensureSlot` does
 * this once at `agents accounts add`; every reconcile calls this so a slot
 * never lags the version home it was cloned from (PHNX-3940). Credentials are
 * never touched: `carryForwardSettings` and the resource writers exclude them.
 * A slot whose directory is gone is skipped, not recreated.
 */
export function projectAccountSlots(harness: AgentId): SlotProjection[] {
  const version = sourceVersion(harness);
  if (!version) return [];
  const fromHome = getVersionHomePath(harness, version);
  if (!fs.existsSync(fromHome)) return [];
  const meta = readMeta();
  const slots = readSlots(meta);
  const native = { ...meta.accounts?.native, ...meta.deviceAccounts?.native };
  const projected: SlotProjection[] = [];
  for (const account of Object.values(native)) {
    if (account.agent !== harness) continue;
    // The slot record is device-local and written after identity capture; a
    // slot dir minted by an earlier build, or an add that stopped short of
    // recording, is still the HOME an account run uses — project it too.
    const dir = slots[account.id]?.slotDir ?? slotDir(harness, account.id);
    if (!fs.existsSync(path.join(dir, agentConfigDirName(harness)))) continue;
    carryForwardSettings(harness, fromHome, dir);
    const pruned = pruneSlotResources(harness, version, dir, fromHome);
    projectResources(harness, version, dir, fromHome);
    projected.push({ accountId: account.id, name: account.name, slotDir: dir, from: version, pruned });
  }
  return projected;
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
      projectResources(harness, version, dir, fromHome);
    }
  }

  return {
    accountId,
    slotDir: dir,
    authMode: defaultAuthMode(harness),
    verdict: 'unconfigured',
  };
}
