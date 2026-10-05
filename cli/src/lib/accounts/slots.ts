/** Per-device account slots (PHNX-3940): an account is a credential slot, not an installation. Each
 * gets a HOME-shaped dir under `~/.agents/.history/accounts/<harness>/<accountId>/` with no
 * binary; native OAuth stays on the minting device. Records live in the device doc, never central. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENTS, agentConfigDirName } from '../agents.js';
import { createLink } from '../platform/links.js';
import { harnessAuth, harnessWorkerIsPerDevice } from '../harness-auth-capabilities.js';
import { installSessionTrackerHookSync } from '../hooks/install.js';
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

/** Remove slot records from this box's device doc (`deviceAccounts.slots`), symmetric with
 * recordSlot. The slot directory is untouched: a stale worker slot keeps its dir since
 * `.claude/projects` holds transcripts (PHNX-4116). No-op for an empty list or unknown id. */
export function dropSlots(accountIds: readonly string[]): void {
  if (accountIds.length === 0) return;
  updateMeta((current) => {
    const slots = { ...current.deviceAccounts?.slots };
    for (const id of accountIds) delete slots[id];
    return { ...current, deviceAccounts: { ...current.deviceAccounts, slots } };
  });
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
      // Symlink to the version home's rules instead of composing a duplicate: a shim pinning a
      // separate config dir makes the harness load rules from both homes, doubling ~5K tokens per
      // session; one inode lets it dedup.
      const cap = AGENTS[harness].capabilities.rules;
      if (typeof cap !== 'object') continue;
      const srcFile = path.join(fromHome, agentConfigDirName(harness), cap.file);
      if (!fs.existsSync(srcFile)) {
        writer.write({ version, versionHome: destHome, selection: { preset: 'default' }, cwd });
        continue;
      }
      const destFile = path.join(destHome, agentConfigDirName(harness), cap.file);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      try {
        const st = fs.lstatSync(destFile);
        if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(destFile);
      } catch { /* did not exist */ }
      try {
        createLink(srcFile, destFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') { continue; }
        throw err;
      }
      continue;
    }
    const names = getDetector(kind, harness)?.list({ version, versionHome: fromHome, cwd }) ?? [];
    if (names.length === 0) continue;
    writer.write({ version, versionHome: destHome, selection: names, cwd });
  }
  if (supports(harness, 'hooks', version).ok) {
    const tracker = installSessionTrackerHookSync(harness, version, destHome);
    if (!tracker.installed && tracker.error) {
      console.warn(`agents: SessionStart hook not installed for ${harness} account home ${destHome}: ${tracker.error}`);
    }
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

/** Remove slot artifacts whose source name is gone. Only name-keyed kinds with `remove` (commands,
 * skills, hooks) are pruned; wholesale kinds (rules, permissions) are rewritten by projection. */
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

/** Re-project settings and resources into every slot this device holds for `harness`, from its
 * default version home, on every reconcile, so a slot never lags (PHNX-3940). Credentials are
 * never touched. A slot whose directory is gone is skipped, not recreated. */
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

/** Create the HOME-shaped slot dir and project settings/resources from the managed install, never
 * copying credentials. Does not persist the slot record; call recordSlot after identity is
 * captured. */
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
