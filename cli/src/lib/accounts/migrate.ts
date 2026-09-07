/**
 * Fold N per-account installations into 1 harness install + N credential slots
 * (PHNX-3940 T7).
 *
 * Homes are moved, never copied. Empty logged-out homes and duplicate identities
 * go to `agents trash` (restore reverses). Session transcript paths are re-indexed
 * in the same transaction as the moves. A running/leased home is deferred, never
 * moved. `--apply` is explicit; dry-run (and the upgrade hook) touch nothing.
 *
 * Native OAuth files stay inside the moved home on this device. Nothing here
 * reads or writes a reserved store, a setup-token, or a worker bundle.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_AGENT_IDS, credentialPresence, getAccountInfo, type AccountInfo } from '../agents.js';
import { nativeAccountCapability, nativeIdentityKey } from '../account-capabilities.js';
import {
  addNativeAccount,
  bindAccount,
  findNativeAccountByIdentity,
  listNativeAccounts,
  type NativeAccount,
} from '../account-registry.js';
import { isLaunchableSignedIn } from '../accounting/rotate.js';
import { compareVersions } from '../agent-spec/primitives.js';
import { isInstallationLikelyActive } from '../installations/active-check.js';
import {
  getGlobalDefault,
  getVersionDir,
  getVersionHomePath,
  invalidateInstalledVersionsCache,
  isVersionIsolated,
  listInstalledVersionDirs,
  readInstallation,
  setGlobalDefault,
  softDeleteVersionDir,
} from '../installations/versions.js';
import { removeVersionedAlias } from '../installations/shims.js';
import { countSessionsWithFilePrefix, reindexMovedSessionPaths } from '../session/db.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { getHistoryDir, readMeta, updateMeta } from '../state.js';
import type { AgentId, DeviceAccountSlot } from '../types.js';
import { recordSlot, slotDir } from './slots.js';

export const ACCOUNT_MIGRATION_SCHEMA = 1;

export type MigrationActionKind = 'canonical' | 'slot' | 'trash' | 'defer' | 'skip';

export interface InstallationInventory {
  agent: AgentId;
  label: string;
  release: string;
  dir: string;
  home: string;
  hasBinary: boolean;
  isolated: boolean;
  launchable: boolean;
  signedIn: boolean;
  hasCredential: boolean;
  identityKey: string | null;
  email: string | null;
  accountKey: string | null;
  accountId: string | null;
  sessionCount: number;
  busy: boolean;
}

export interface MigrationAction {
  kind: MigrationActionKind;
  label: string;
  release: string;
  reason: string;
  accountId?: string;
  accountName?: string;
  slotDir?: string;
  identityKey?: string | null;
  email?: string | null;
  sessionCount: number;
  /** Planned filesystem remap for sessions.db (from prefix → to prefix). */
  pathMoves: Array<{ from: string; to: string }>;
}

export interface HarnessMigrationPlan {
  agent: AgentId;
  canonical: string | null;
  defaultBefore: string | null;
  inventory: InstallationInventory[];
  actions: MigrationAction[];
  counts: { installations: number; keep: number; slots: number; trash: number; deferred: number; skipped: number };
}

export interface AccountMigrationPlan {
  at: string;
  harnesses: HarnessMigrationPlan[];
  totals: { installations: number; keep: number; slots: number; trash: number; deferred: number; skipped: number };
}

export type AccountMigrationManifestStatus = 'planned' | 'complete';

export interface AccountMigrationManifest {
  schema: number;
  at: string;
  dryRun: boolean;
  /** `planned` until every irreversible step finishes; `complete` is last. */
  status: AccountMigrationManifestStatus;
  /** Full plan, written before the first move so a crash still names the intent. */
  plan: AccountMigrationPlan;
  harnesses: Record<string, {
    canonical: string | null;
    slots: Array<{ oldLabel: string; accountId: string; accountName: string; slotDir: string }>;
    trashed: Array<{ label: string; reason: string; trashPath: string }>;
    deferred: Array<{ label: string; reason: string }>;
  }>;
  /** old `agent@label` → new slot dir (or trash path). */
  map: Record<string, string>;
}

export interface AccountMigrateDeps {
  isActive?: (installation: { agent: AgentId; label: string }) => Promise<boolean>;
  now?: () => Date;
}

const OPAQUE_LABEL = /^(?:latest|main|acct-[0-9a-f]+|\d+\.\d+.*)$/i;

function defaultIsActive(installation: { agent: AgentId; label: string }): Promise<boolean> {
  return isInstallationLikelyActive(installation);
}

function readInstallRecord(agent: AgentId, label: string): { release: string } {
  try {
    const rec = readInstallation(agent, label);
    if (rec) return { release: rec.releaseVersion };
    return { release: label };
  } catch (err) {
    throw new Error(
      `Unreadable installation.json for ${agent}@${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function emailLocalpart(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0]?.trim();
  return local || null;
}

function isOpaqueInstallLabel(label: string): boolean {
  return OPAQUE_LABEL.test(label);
}

function uniqueAccountName(agent: AgentId, preferred: string, taken: Set<string>): string {
  const base = preferred.replace(/[^A-Za-z0-9@._+-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'account';
  if (!taken.has(`${agent}:${base.toLowerCase()}`)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(`${agent}:${candidate.toLowerCase()}`)) return candidate;
  }
  throw new Error(`Could not allocate a unique account name for ${agent} starting from '${preferred}'.`);
}

function invertHomes(agent: AgentId, meta: ReturnType<typeof readMeta>): Map<string, string> {
  const out = new Map<string, string>();
  const homes = meta.deviceAccounts?.homes ?? {};
  for (const [accountId, label] of Object.entries(homes)) {
    if (!label) continue;
    const row = listNativeAccounts(meta).find((a) => a.id === accountId);
    if (row && row.agent !== agent) continue;
    out.set(label, accountId);
  }
  return out;
}

function assertIdentityMatch(
  agent: AgentId,
  label: string,
  identityKey: string | null,
  row: NativeAccount,
): void {
  if (identityKey && row.identityKey !== identityKey) {
    throw new Error(
      `Identity mismatch for ${agent}@${label}: home is '${identityKey}' but account row '${row.name}' is '${row.identityKey}'.`,
    );
  }
}

async function inventoryHarness(
  agent: AgentId,
  deps: AccountMigrateDeps,
): Promise<InstallationInventory[]> {
  const dirs = listInstalledVersionDirs(agent);
  const meta = readMeta();
  const homesByLabel = invertHomes(agent, meta);
  const isActive = deps.isActive ?? defaultIsActive;
  const out: InstallationInventory[] = [];

  for (const { version: label, hasBinary } of dirs) {
    const rec = readInstallRecord(agent, label);
    const home = getVersionHomePath(agent, label);
    const info: AccountInfo = await getAccountInfo(agent, home);
    const presence = credentialPresence(agent, home);
    const launchable = isLaunchableSignedIn(info.signedIn, presence);
    const identityKey = nativeIdentityKey(info, nativeAccountCapability(agent));
    const accountIdFromHome = homesByLabel.get(label) ?? null;
    if (accountIdFromHome) {
      const row = listNativeAccounts(meta).find((a) => a.id === accountIdFromHome);
      if (row) assertIdentityMatch(agent, label, identityKey, row);
    }
    const matched = findNativeAccountByIdentity(meta, agent, info);
    out.push({
      agent,
      label,
      release: rec.release,
      dir: getVersionDir(agent, label),
      home,
      hasBinary,
      isolated: isVersionIsolated(agent, label),
      launchable,
      signedIn: info.signedIn,
      hasCredential: presence.perVersion,
      identityKey,
      email: info.email,
      accountKey: info.accountKey,
      accountId: accountIdFromHome ?? matched?.id ?? null,
      sessionCount: countSessionsWithFilePrefix(home),
      busy: await isActive({ agent, label }),
    });
  }
  return out;
}

function newestLaunchable(items: InstallationInventory[]): InstallationInventory | null {
  const launchable = items.filter((i) => i.launchable && !i.isolated);
  if (launchable.length === 0) return null;
  return [...launchable].sort((a, b) => {
    const rel = compareVersions(a.release, b.release);
    if (rel !== 0) return rel;
    return compareVersions(a.label, b.label);
  }).at(-1) ?? null;
}

function chooseCanonical(
  items: InstallationInventory[],
  defaultLabel: string | null,
  trashLabels: Set<string>,
): InstallationInventory | null {
  const eligible = items.filter((i) => !i.isolated && !trashLabels.has(i.label));
  if (defaultLabel) {
    const def = eligible.find((i) => i.label === defaultLabel);
    if (def?.launchable) return def;
  }
  const newest = newestLaunchable(eligible);
  if (newest) return newest;
  const withBinary = eligible.filter((i) => i.hasBinary);
  if (withBinary.length === 0) return eligible[0] ?? null;
  return [...withBinary].sort((a, b) => compareVersions(a.release, b.release) || compareVersions(a.label, b.label)).at(-1) ?? null;
}

async function duplicateTrashLabels(items: InstallationInventory[]): Promise<Set<string>> {
  const slotish = items.filter((i) => i.hasCredential && i.identityKey && !i.isolated);
  if (slotish.length < 2) return new Set();
  const { planDuplicatePrune } = await import('../../commands/view.js');
  const dups = planDuplicatePrune(slotish.map((i) => ({
    version: i.label,
    release: i.release,
    email: i.email,
    accountKey: i.accountKey,
    signedIn: i.signedIn,
    hasBinary: i.hasBinary,
  })));
  return new Set(dups.map((d) => d.version));
}

function plannedTrashPath(agent: AgentId, label: string): string {
  return path.join(getHistoryDir(), 'trash', 'versions', agent, label, '<stamp>');
}

function emptyDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function assertSlotAbsent(agent: AgentId, accountId: string): string {
  const dest = slotDir(agent, accountId);
  if (fs.existsSync(dest) && !emptyDir(dest)) {
    throw new Error(`Slot already exists for ${agent} account ${accountId} at ${dest}.`);
  }
  return dest;
}

/**
 * True when this device already holds a populated slot directory for the
 * account. The daemon's auth-sync provisions durable worker slots on its own
 * (PHNX-3940), so by the time an operator runs `--apply` a worker commonly has
 * a slot for every account whose legacy per-version home is still on disk.
 * A regular file at the slot path is NOT a slot: the plan keeps routing such a
 * home to `slot` so the apply-time guard fails loud on the corruption.
 */
function provisionedSlotExists(agent: AgentId, accountId: string): boolean {
  const dest = slotDir(agent, accountId);
  try {
    return fs.statSync(dest).isDirectory() && fs.readdirSync(dest).length > 0;
  } catch {
    return false;
  }
}

function takenNames(meta: ReturnType<typeof readMeta>): Set<string> {
  const taken = new Set<string>();
  for (const row of listNativeAccounts(meta)) {
    taken.add(`${row.agent}:${row.name.toLowerCase()}`);
  }
  return taken;
}

function resolveOrRegisterAccount(
  item: InstallationInventory,
  taken: Set<string>,
): NativeAccount {
  const meta = readMeta();
  if (item.accountId) {
    const row = listNativeAccounts(meta).find((a) => a.id === item.accountId);
    if (!row) throw new Error(`${item.agent}@${item.label} points at unknown account id '${item.accountId}'.`);
    assertIdentityMatch(item.agent, item.label, item.identityKey, row);
    return row;
  }
  if (!item.identityKey) {
    throw new Error(`${item.agent}@${item.label} has a credential but no inspectable identity.`);
  }
  const existing = listNativeAccounts(meta).find((a) => a.agent === item.agent && a.identityKey === item.identityKey);
  if (existing) return existing;

  const preferred = (!isOpaqueInstallLabel(item.label) ? item.label : null)
    ?? emailLocalpart(item.email)
    ?? 'account';
  const name = uniqueAccountName(item.agent, preferred, taken);
  taken.add(`${item.agent}:${name.toLowerCase()}`);
  const cap = nativeAccountCapability(item.agent);
  const scope = cap.scope === 'device' ? 'device' : 'version';
  return addNativeAccount(name, item.agent, item.identityKey, item.email ?? undefined, scope);
}

async function planHarness(
  agent: AgentId,
  deps: AccountMigrateDeps,
): Promise<HarnessMigrationPlan> {
  const inventory = await inventoryHarness(agent, deps);
  const defaultBefore = getGlobalDefault(agent);
  const trashFromDups = await duplicateTrashLabels(inventory);
  const canonical = chooseCanonical(inventory, defaultBefore, trashFromDups);
  const actions: MigrationAction[] = [];

  for (const item of inventory) {
    if (item.isolated) {
      actions.push({
        kind: 'skip',
        label: item.label,
        release: item.release,
        reason: 'isolated copy — left untouched',
        sessionCount: item.sessionCount,
        pathMoves: [],
      });
      continue;
    }
    if (item.busy) {
      actions.push({
        kind: 'defer',
        label: item.label,
        release: item.release,
        reason: 'installation is busy (live process or launch lease)',
        identityKey: item.identityKey,
        email: item.email,
        sessionCount: item.sessionCount,
        pathMoves: [],
      });
      continue;
    }
    if (trashFromDups.has(item.label)) {
      actions.push({
        kind: 'trash',
        label: item.label,
        release: item.release,
        reason: 'duplicate identity — keeping the better home via planDuplicatePrune',
        identityKey: item.identityKey,
        email: item.email,
        sessionCount: item.sessionCount,
        pathMoves: [{ from: item.dir, to: plannedTrashPath(agent, item.label) }],
      });
      continue;
    }
    if (item.hasCredential && item.accountId && provisionedSlotExists(agent, item.accountId)) {
      // The account already owns a populated slot on this device, so this
      // per-version home is a stale copy of a credential the slot now carries.
      // Routing it to `slot` would only trip `assertSlotAbsent` and abort the
      // whole apply with nothing done — the state every auth-synced worker was
      // in. Trash it instead (`agents trash restore` reverses); a busy or
      // canonical home is never moved, so the canonical case keeps its binary
      // and leaves the home where it is.
      if (canonical && item.label === canonical.label) {
        actions.push({
          kind: 'canonical',
          label: item.label,
          release: item.release,
          reason: 'canonical install (binary kept); account already holds a slot — home left in place',
          accountId: item.accountId,
          identityKey: item.identityKey,
          email: item.email,
          sessionCount: item.sessionCount,
          pathMoves: [],
        });
        continue;
      }
      actions.push({
        kind: 'trash',
        label: item.label,
        release: item.release,
        reason: 'account already holds a provisioned slot on this device — stale home trashed',
        accountId: item.accountId,
        identityKey: item.identityKey,
        email: item.email,
        sessionCount: item.sessionCount,
        pathMoves: [{ from: item.dir, to: plannedTrashPath(agent, item.label) }],
      });
      continue;
    }
    if (item.hasCredential && item.identityKey) {
      const dest = item.accountId ? slotDir(agent, item.accountId) : slotDir(agent, '<new-account>');
      actions.push({
        kind: 'slot',
        label: item.label,
        release: item.release,
        reason: item.label === canonical?.label
          ? 'credential-bearing canonical home → slot (binary stays)'
          : 'credential-bearing home → slot; binary trashed',
        accountId: item.accountId ?? undefined,
        identityKey: item.identityKey,
        email: item.email,
        slotDir: dest,
        sessionCount: item.sessionCount,
        pathMoves: [
          { from: item.home, to: dest },
          ...(item.label === canonical?.label ? [] : [{ from: item.dir, to: plannedTrashPath(agent, item.label) }]),
        ],
      });
      continue;
    }
    if (canonical && item.label === canonical.label) {
      actions.push({
        kind: 'canonical',
        label: item.label,
        release: item.release,
        reason: 'canonical install (binary kept; no credential to move)',
        sessionCount: item.sessionCount,
        pathMoves: [],
      });
      continue;
    }
    actions.push({
      kind: 'trash',
      label: item.label,
      release: item.release,
      reason: item.hasBinary ? 'empty logged-out home' : 'home-only leftover (no binary)',
      sessionCount: item.sessionCount,
      pathMoves: [{ from: item.dir, to: plannedTrashPath(agent, item.label) }],
    });
  }

  const counts = {
    installations: inventory.length,
    // A busy canonical is still the kept install — we did not move it, we
    // deferred the fold. Counting it as 0 install is a lie.
    keep: actions.filter((a) =>
      a.kind === 'canonical'
      || ((a.kind === 'slot' || a.kind === 'defer') && a.label === canonical?.label)
    ).length,
    slots: actions.filter((a) => a.kind === 'slot').length,
    trash: actions.filter((a) => a.kind === 'trash').length,
    deferred: actions.filter((a) => a.kind === 'defer').length,
    skipped: actions.filter((a) => a.kind === 'skip').length,
  };

  return { agent, canonical: canonical?.label ?? null, defaultBefore, inventory, actions, counts };
}

export async function planAccountMigration(
  agents: AgentId[] = [...ALL_AGENT_IDS],
  deps: AccountMigrateDeps = {},
): Promise<AccountMigrationPlan> {
  const harnesses: HarnessMigrationPlan[] = [];
  for (const agent of agents) {
    const plan = await planHarness(agent, deps);
    if (plan.inventory.length === 0) continue;
    harnesses.push(plan);
  }
  const totals = harnesses.reduce(
    (acc, h) => ({
      installations: acc.installations + h.counts.installations,
      keep: acc.keep + h.counts.keep,
      slots: acc.slots + h.counts.slots,
      trash: acc.trash + h.counts.trash,
      deferred: acc.deferred + h.counts.deferred,
      skipped: acc.skipped + h.counts.skipped,
    }),
    { installations: 0, keep: 0, slots: 0, trash: 0, deferred: 0, skipped: 0 },
  );
  return { at: (deps.now ?? (() => new Date()))().toISOString(), harnesses, totals };
}

function canonicalBusy(h: HarnessMigrationPlan): boolean {
  return !!h.canonical && h.actions.some((a) => a.kind === 'defer' && a.label === h.canonical);
}

export function formatMigrationPlan(plan: AccountMigrationPlan): string {
  const lines: string[] = [];
  if (plan.harnesses.length === 0 || plan.totals.installations === 0) {
    return 'No per-account installations to fold.';
  }
  for (const h of plan.harnesses) {
    if (h.counts.installations === 0) continue;
    lines.push(
      `${h.agent}: ${h.counts.installations} installation${h.counts.installations === 1 ? '' : 's'}`
      + ` → ${h.counts.keep} install + ${h.counts.slots} slot${h.counts.slots === 1 ? '' : 's'}`
      + ` + ${h.counts.trash} trashed`
      + (h.counts.deferred ? ` + ${h.counts.deferred} deferred` : '')
      + (h.canonical ? ` (canonical ${h.agent}@${h.canonical}${canonicalBusy(h) ? ' busy' : ''})` : ''),
    );
    if (h.defaultBefore && h.defaultBefore !== h.canonical) {
      lines.push(`  default ${h.agent}@${h.defaultBefore} is not launchable → repoint to ${h.canonical ?? '(none)'}`);
    }
    for (const a of h.actions) {
      const who = a.email ? ` ${a.email}` : '';
      lines.push(`  ${a.kind.padEnd(9)} ${h.agent}@${a.label}${who}  ${a.reason}`);
    }
  }
  lines.push(
    `totals: ${plan.totals.installations} installations → ${plan.totals.keep} install + ${plan.totals.slots} slots + ${plan.totals.trash} trashed`
    + (plan.totals.deferred ? ` + ${plan.totals.deferred} deferred` : ''),
  );
  return lines.join('\n');
}

function rewriteBindings(
  agent: AgentId,
  labelToAccount: Map<string, string>,
  stillPresent: Set<string>,
): void {
  const meta = readMeta();
  const targets = new Set([
    ...Object.keys(meta.accounts?.bindings ?? {}),
    ...Object.keys(meta.deviceAccounts?.bindings ?? {}),
  ]);
  const prefix = `${agent}@`;
  for (const target of targets) {
    if (!target.startsWith(prefix)) continue;
    const label = target.slice(prefix.length);
    const accountId = labelToAccount.get(label);
    if (!accountId) {
      if (stillPresent.has(label)) continue;
      throw new Error(
        `Cannot rewrite binding '${target}': ${agent}@${label} was removed and has no kept account of the same identity.`,
      );
    }
    const row = listNativeAccounts(readMeta()).find((a) => a.id === accountId);
    if (!row) {
      throw new Error(`Cannot rewrite binding '${target}': account '${accountId}' is missing.`);
    }
    // Keep the per-target key (`agent@label` → account id). Collapsing every
    // label onto one bare-agent binding would drop every account after the first.
    bindAccount(row.id, target, agent);
  }
}

function clearHomes(accountIds: string[]): void {
  if (accountIds.length === 0) return;
  updateMeta((current) => {
    const homes = { ...current.deviceAccounts?.homes };
    for (const id of accountIds) delete homes[id];
    return { ...current, deviceAccounts: { ...current.deviceAccounts, homes } };
  });
}

function moveHomeToSlot(item: InstallationInventory, dest: string): void {
  if (fs.existsSync(dest) && !emptyDir(dest)) {
    throw new Error(`Slot already exists for ${item.agent} account at ${dest}.`);
  }
  if (fs.existsSync(dest)) fs.rmdirSync(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(item.home)) {
    throw new Error(`Home ${item.home} is missing; cannot move it into a slot.`);
  }
  fs.renameSync(item.home, dest);
}

function recordMovedSlot(agent: AgentId, account: NativeAccount, dest: string): void {
  const cap = nativeAccountCapability(agent);
  const slot: DeviceAccountSlot = {
    accountId: account.id,
    slotDir: dest,
    authMode: cap.scope === 'device' ? 'per-device' : 'native',
    verdict: 'unverified',
  };
  recordSlot(account.id, slot);
}

function persistManifest(manifestPath: string, manifest: AccountMigrationManifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function harnessManifest(
  manifest: AccountMigrationManifest,
  agent: AgentId,
  canonical: string | null,
): AccountMigrationManifest['harnesses'][string] {
  const existing = manifest.harnesses[agent];
  if (existing) return existing;
  const created = { canonical, slots: [], trashed: [], deferred: [] };
  manifest.harnesses[agent] = created;
  return created;
}

export interface ApplyMigrationResult {
  plan: AccountMigrationPlan;
  manifest: AccountMigrationManifest;
  manifestPath: string;
  sessionsReindexed: number;
}

export async function applyAccountMigration(
  agents: AgentId[] = [...ALL_AGENT_IDS],
  deps: AccountMigrateDeps = {},
): Promise<ApplyMigrationResult> {
  const plan = await planAccountMigration(agents, deps);
  const now = deps.now ?? (() => new Date());
  const at = now();
  const stamp = at.toISOString();
  const manifestPath = path.join(
    getHistoryDir(),
    'accounts',
    `migration-${stamp.replace(/[:.]/g, '-')}.json`,
  );
  const manifest: AccountMigrationManifest = {
    schema: ACCOUNT_MIGRATION_SCHEMA,
    at: stamp,
    dryRun: false,
    status: 'planned',
    plan,
    harnesses: {},
    map: {},
  };
  persistManifest(manifestPath, manifest);

  const remaps: Array<{ from: string; to: string }> = [];
  const taken = takenNames(readMeta());

  for (const h of plan.harnesses) {
    const entry = harnessManifest(manifest, h.agent, h.canonical);
    const labelToAccount = new Map<string, string>();
    const identityToAccount = new Map<string, string>();
    const movedAccountIds: string[] = [];
    const stillPresent = new Set(h.inventory.map((i) => i.label));

    const byLabel = new Map(h.inventory.map((i) => [i.label, i]));
    const slotActions = h.actions.filter((a) => a.kind === 'slot');
    const trashActions = h.actions.filter((a) => a.kind === 'trash');

    for (const action of h.actions.filter((a) => a.kind === 'defer')) {
      entry.deferred.push({ label: action.label, reason: action.reason });
    }
    persistManifest(manifestPath, manifest);

    for (const action of slotActions) {
      const item = byLabel.get(action.label);
      if (!item) throw new Error(`Plan named ${h.agent}@${action.label} but inventory has no such install.`);
      const account = resolveOrRegisterAccount(item, taken);
      const dest = assertSlotAbsent(h.agent, account.id);
      moveHomeToSlot(item, dest);
      recordMovedSlot(h.agent, account, dest);
      remaps.push({ from: item.home, to: dest });
      labelToAccount.set(item.label, account.id);
      if (item.identityKey) identityToAccount.set(item.identityKey, account.id);
      movedAccountIds.push(account.id);
      entry.slots.push({ oldLabel: item.label, accountId: account.id, accountName: account.name, slotDir: dest });
      manifest.map[`${h.agent}@${item.label}`] = dest;
      persistManifest(manifestPath, manifest);

      if (item.label === h.canonical) {
        fs.mkdirSync(item.home, { recursive: true, mode: 0o700 });
      } else {
        const trashPath = softDeleteVersionDir(h.agent, item.label);
        if (!trashPath) throw new Error(`Failed to trash binary leftover ${h.agent}@${item.label}.`);
        removeVersionedAlias(h.agent, item.label);
        remaps.push({ from: item.dir, to: trashPath });
        stillPresent.delete(item.label);
        entry.trashed.push({ label: item.label, reason: 'binary leftover after home moved to slot', trashPath });
        manifest.map[`${h.agent}@${item.label}#binary`] = trashPath;
        persistManifest(manifestPath, manifest);
      }
    }

    for (const item of h.inventory) {
      if (!item.identityKey) continue;
      const kept = identityToAccount.get(item.identityKey);
      if (kept) labelToAccount.set(item.label, kept);
    }

    for (const action of trashActions) {
      const item = byLabel.get(action.label);
      if (!item) throw new Error(`Plan named ${h.agent}@${action.label} but inventory has no such install.`);
      const trashPath = softDeleteVersionDir(h.agent, item.label);
      if (!trashPath) throw new Error(`Failed to trash ${h.agent}@${item.label}.`);
      removeVersionedAlias(h.agent, item.label);
      remaps.push({ from: item.dir, to: trashPath });
      stillPresent.delete(item.label);
      if (action.accountId) {
        // A home trashed because its account already holds a slot: anything
        // bound to this version label follows the account, and the stale
        // home record clears so spawn resolves through the slot alone.
        labelToAccount.set(item.label, action.accountId);
        movedAccountIds.push(action.accountId);
      }
      entry.trashed.push({ label: item.label, reason: action.reason, trashPath });
      manifest.map[`${h.agent}@${item.label}`] = trashPath;
      persistManifest(manifestPath, manifest);
    }

    if (h.canonical) setGlobalDefault(h.agent, h.canonical);
    rewriteBindings(h.agent, labelToAccount, stillPresent);
    clearHomes(movedAccountIds);
    invalidateInstalledVersionsCache(h.agent);
  }

  const sessionsReindexed = reindexMovedSessionPaths(remaps);
  manifest.status = 'complete';
  persistManifest(manifestPath, manifest);

  return { plan, manifest, manifestPath, sessionsReindexed };
}

/**
 * Upgrade hook: print a dry-run report when leftover per-account installations
 * exist. Never applies. `--apply` stays an explicit `agents accounts migrate`
 * flag this release.
 */
export async function reportAccountSlotMigrationOnUpgrade(): Promise<void> {
  const plan = await planAccountMigration();
  const work = plan.totals.slots + plan.totals.trash + plan.totals.deferred;
  if (work === 0) return;
  const summary = formatMigrationPlan(plan);
  process.stderr.write(
    `[agents] Account model v2: ${plan.totals.installations} leftover per-account installation(s) can fold into slots.\n`
    + `${summary}\n`
    + `Dry-run (this upgrade does not move anything). Apply with: agents accounts migrate --apply\n`,
  );
}
