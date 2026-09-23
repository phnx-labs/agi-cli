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

/**
 * Remove slot records from THIS box's device doc (`deviceAccounts.slots`).
 * Symmetric with {@link recordSlot}. The slot DIRECTORY is not touched — a
 * caller that also wants the on-disk home gone removes it separately; a stale
 * worker slot keeps its dir because `.claude/projects` holds transcripts
 * (PHNX-4116). A no-op for an empty list or an id with no record.
 */
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
      // Symlink to the version home's rules instead of composing a duplicate.
      // Harnesses whose shim pins a separate config dir (e.g. CLAUDE_CONFIG_DIR
      // → account slot) cause the harness to load rules from both the version
      // home (~/.claude/) and the slot, doubling ~5 K tokens per session.
      // A symlink gives both paths the same inode so the harness can dedup.
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
