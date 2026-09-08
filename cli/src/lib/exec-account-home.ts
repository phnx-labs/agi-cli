/**
 * Spawn-time native-account HOME resolution (PHNX-3940 T5).
 *
 * Order: existing slot → provisionable worker slot → recorded leftover `homes`
 * label → identity match across installed version homes → fail loud with the
 * T4 hint. Never a wrong home that looks like success. Identity matching is
 * the pre-T5 fallback (`resolveAccountVersion` over each installed home's own
 * credential file) so a native account whose backfill never wrote a `homes`
 * label still spawns from the home that actually holds its login.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listNativeAccounts, nativeAccountHome, type NativeAccount } from './account-registry.js';
import { readSlots } from './accounts/slots.js';
import { workerProvisioningHint, workerApiKeyEnv } from './accounts/add.js';
import { AGENTS, credentialPresence, getAccountInfo } from './agents.js';
import { AUTH_BUNDLE, claudeAccountTokenKey, provisionWorkerSlot, readReservedCredential } from './claude-account-token.js';
import { isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import { harnessWorkerKinds } from './harness-auth-capabilities.js';
import { getAgentConfigPath, isSymlinkAdoptedHarness, repointAdoptedConfigToHome } from './installations/shims.js';
import { getVersionHomePath, listInstalledVersions } from './installations/versions.js';
import type { AgentId, DeviceAccountSlot, Meta } from './types.js';

export { isAccountSlotDir } from './agents.js';
export { isSymlinkAdoptedHarness };

export type SpawnHomeSource = 'slot' | 'legacy-home' | 'provisioned';

export interface NativeSpawnHome {
  execHome: string;
  source: SpawnHomeSource;
  slot?: DeviceAccountSlot;
  /** Installation label when `source` is `legacy-home`. */
  label?: string;
}

/**
 * The env a DURABLE slot injects at spawn (PHNX-3940 T5/T6). A worker's slot
 * for an api-key harness (codex/grok/cursor/opencode/droid) holds no file — the
 * daemon pushed the account's worker API key into the reserved
 * `__<harness>__` store and `provisionWorkerSlot` recorded the slot as
 * `durable`; the key rides the harness's own env var (`CURSOR_API_KEY`, …)
 * on every launch. Anything else — a native login in the slot on a headed
 * device, a claude durable slot (its setup-token is a `.oauth_token` file the
 * adapter reads), a harness with no api-key worker kind — injects nothing.
 * Without this, `agents run cursor#gmail` on a worker reached Cursor with an
 * empty env and got `Authentication required … set CURSOR_API_KEY`.
 */
export function durableSlotEnv(
  agent: AgentId,
  account: { id: string },
  resolved: Pick<NativeSpawnHome, 'slot'>,
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): Record<string, string> {
  if (resolved.slot?.authMode !== 'durable') return {};
  const envName = workerApiKeyEnv(agent);
  if (!envName) return {};
  const row = nativeRow(account.id, meta);
  const cred = row?.workerCredential;
  if (!cred || cred.kind !== 'api-key') return {};
  const value = readReservedCredential(cred.bundle, cred.key);
  if (!value) return {};
  return { [envName]: value };
}

export function missingSlotHint(agent: AgentId, name: string): string {
  const role = selfConfiguredDeviceRole();
  if (!isHeadedDeviceRole(role)) {
    return `${agent}#${name} has no slot on this device. `
      + `Add the account on your personal device with \`agents accounts add ${agent} ${name}\`; `
      + `workers are provisioned from the durable credential automatically `
      + `(${agent}: ${workerProvisioningHint(agent)}).`;
  }
  return `${agent}#${name} has no slot on this device. Sign in with: agents accounts login ${agent}#${name}`;
}

export function symlinkAdoptedAccountError(agent: AgentId, name: string, defaultName: string | undefined): string {
  if (!defaultName) {
    return `${agent} holds one active account per device (adopted ~/.<config> symlink). `
      + `Set the default first: agents accounts default ${agent} ${name}`;
  }
  return `${agent} holds one active account per device (adopted ~/.<config> symlink). `
    + `'${name}' is not the default ('${defaultName}'). `
    + `Switch with: agents accounts default ${agent} ${name}`;
}

export function adoptedSymlinkMismatchError(agent: AgentId, name: string, execHome: string): string {
  return `${agent} default is '${name}' but the adopted ~/.<config> does not point at that account's home (${execHome}). `
    + `Switch with: agents accounts default ${agent} ${name}`;
}

/** The adopted `~/.<config>` symlink's resolved target, or null when missing / not a symlink. */
export function adoptedConfigTarget(agent: AgentId): string | null {
  const configPath = getAgentConfigPath(agent);
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isSymbolicLink()) return null;
    return path.resolve(path.dirname(configPath), fs.readlinkSync(configPath));
  } catch {
    return null;
  }
}

export function adoptedConfigPointsAtHome(agent: AgentId, home: string): boolean {
  if (!isSymlinkAdoptedHarness(agent)) return true;
  const current = adoptedConfigTarget(agent);
  if (!current) return false;
  const configDirName = path.relative(os.homedir(), AGENTS[agent].configDir);
  return current === path.resolve(home, configDirName);
}

/**
 * For a symlink-adopted harness, point `~/.<config>` at this account's slot
 * or throw. Does not write the harness default — the caller records that only
 * after this succeeds.
 */
export function ensureAdoptedDefaultRepoint(
  agent: AgentId,
  account: { id: string; name: string; agent: AgentId },
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): void {
  if (!isSymlinkAdoptedHarness(agent)) return;
  const slot = readSlots(meta)[account.id];
  if (!slot || !fs.existsSync(slot.slotDir)) {
    throw new Error(
      `${agent}#${account.name} has no slot on this device, so the adopted ~/.<config> cannot be pointed at it. `
      + missingSlotHint(agent, account.name),
    );
  }
  const result = repointAdoptedConfigToHome(agent, slot.slotDir);
  if (!result.success) {
    throw new Error(result.error ?? `Failed to point ${agent} at account '${account.name}'.`);
  }
}

function nativeRow(accountId: string, meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): NativeAccount | undefined {
  return listNativeAccounts(meta).find((row) => row.id === accountId);
}

function isProvisionableWorker(account: NativeAccount): boolean {
  if (isHeadedDeviceRole(selfConfiguredDeviceRole())) return false;
  const durable = harnessWorkerKinds(account.agent).some(
    (kind) => kind === 'setup-token' || kind.startsWith('api-key'),
  );
  if (!durable) return false;
  if (account.workerCredential) {
    return readReservedCredential(account.workerCredential.bundle, account.workerCredential.key) != null;
  }
  // Pre-T1 Claude rows key the legacy `auth` bundle by email.
  if (account.agent === 'claude' && account.identityLabel) {
    return readReservedCredential(AUTH_BUNDLE, claudeAccountTokenKey(account.identityLabel)) != null;
  }
  return false;
}

async function matchLegacyIdentityHome(
  agent: AgentId,
  account: { id: string; name: string; agent: AgentId },
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'>,
): Promise<{ home: string; label: string } | null> {
  const row = nativeRow(account.id, meta);
  const needles = [row?.identityKey, row?.identityLabel]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (needles.length === 0) return null;
  const needleSet = new Set(needles);
  const preferred = nativeAccountHome(account.id, meta);
  const versions = listInstalledVersions(agent);
  const ordered = preferred && versions.includes(preferred)
    ? [preferred, ...versions.filter((version) => version !== preferred)]
    : versions;
  for (const label of ordered) {
    const home = getVersionHomePath(agent, label);
    if (!fs.existsSync(home)) continue;
    const info = await getAccountInfo(agent, home);
    const presence = credentialPresence(agent, home);
    if (!info.signedIn) continue;
    if (presence.knownLocation && !presence.perVersion) continue;
    const keys = [info.accountKey, info.email]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => value.toLowerCase());
    if (keys.some((key) => needleSet.has(key))) return { home, label };
  }
  return null;
}

/**
 * Resolve the spawn HOME for a native account on THIS device.
 * Existing slot, then a provisionable worker slot, then a leftover `homes`
 * label, then identity match across installed homes, then fail loud.
 */
export async function resolveNativeSpawnHome(
  agent: AgentId,
  account: { id: string; name: string; agent: AgentId },
  meta: Pick<Meta, 'accounts' | 'deviceAccounts'> = { accounts: undefined, deviceAccounts: undefined },
): Promise<NativeSpawnHome> {
  const slot = readSlots(meta)[account.id];
  if (slot && fs.existsSync(slot.slotDir)) {
    return { execHome: slot.slotDir, source: 'slot', slot };
  }

  const row = nativeRow(account.id, meta);
  if (row && isProvisionableWorker(row)) {
    const provisioned = provisionWorkerSlot(row);
    return { execHome: provisioned.slotDir, source: 'provisioned', slot: provisioned };
  }

  const label = nativeAccountHome(account.id, meta);
  if (label) {
    const legacyHome = getVersionHomePath(agent, label);
    if (fs.existsSync(legacyHome)) {
      return { execHome: legacyHome, source: 'legacy-home', label };
    }
  }

  const matched = await matchLegacyIdentityHome(agent, account, meta);
  if (matched) {
    return { execHome: matched.home, source: 'legacy-home', label: matched.label };
  }

  throw new Error(missingSlotHint(agent, account.name));
}
