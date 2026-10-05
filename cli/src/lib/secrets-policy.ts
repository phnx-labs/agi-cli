import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  pushBundleToHostAsync,
  listBundles,
  type SecretsContext,
} from './secrets-client.js';
import type { PushBundleResult } from './secrets-types.js';
import type { AgentId, DeviceAccountSlot, Meta, NativeAccountRecord } from './types.js';
import { filterNamesForActiveResourceProfile, getActiveResourceProfile } from './resource-profiles.js';
import { isDialableDevice, loadDevicesSync, type DeviceProfile } from './devices/registry.js';
import { sshTargetFor } from './devices/connect.js';
import { isHostPinned, isDevicePinned, managedKnownHostsPath } from './devices/known-hosts.js';
import { machineId, normalizeHost } from './session/sync/config.js';
import {
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceStateAsync,
  type FleetSharedDeviceState,
  type SharedAuthStatus,
} from './fleet-shared-state.js';
import { getCacheDir, getUserAgentsDir, readMeta } from './state.js';
import { dropSlots, listNativeAccounts, readSlots } from './account-registry.js';
import { claudeAccountTokenKey, isClaudeWorkerHomeSeeded, provisionWorkerSlot, readReservedCredential } from './claude-account-token.js';
import { configuredDeviceRole, isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import {
  AUTH_STORE_ALIAS,
  AUTH_BUNDLE_BACKEND,
  RESERVED_BUNDLE_NAMES,
  isReservedBundleName,
  ReservedBundleWrongBackendError,
  assertReservedAuthBackend,
  isReservedBundleBackendError,
  RESERVED_STORES,
  reservedStoreName,
  isReservedStoreName,
  assertStorableCredentialKind,
  inspectReservedAuthBundle,
  type StorableCredentialKind,
} from './reserved-stores.js';

export {
  AUTH_STORE_ALIAS,
  AUTH_BUNDLE_BACKEND,
  RESERVED_BUNDLE_NAMES,
  isReservedBundleName,
  ReservedBundleWrongBackendError,
  assertReservedAuthBackend,
  isReservedBundleBackendError,
  RESERVED_STORES,
  reservedStoreName,
  isReservedStoreName,
  assertStorableCredentialKind,
  inspectReservedAuthBundle,
  type StorableCredentialKind,
};



function filterBundleNamesForActiveProfile(names: string[]): string[] {
  return filterNamesForActiveResourceProfile('secrets', names);
}

export function resolveAllowedBundlesForActiveProfile(allNames: string[]): string[] | undefined {


  const filtered = filterBundleNamesForActiveProfile(allNames);
  return filtered.length === allNames.length ? undefined : filtered;
}

export async function resolveSecretsContextForRun(scope?: string): Promise<SecretsContext | undefined> {
  if (!getActiveResourceProfile()) return scope ? { scope } : undefined;
  const allNames = (await listBundles()).map((b) => b.name);
  return { allowedBundles: resolveAllowedBundlesForActiveProfile(allNames), scope };
}


export function splitBundleRef(ref: string): { bundle: string; host?: string } {
  const at = ref.indexOf('@');
  if (at === -1) return { bundle: ref };
  const bundle = ref.slice(0, at);
  const host = ref.slice(at + 1);
  if (!bundle || !host) {
    throw new Error(`Invalid remote bundle reference ${JSON.stringify(ref)}. Expected 'bundle@host'.`);
  }
  return { bundle, host };
}

export function assertRemoteBundleFlagsUnsupported(
  bundleName: string,
  host: string,
  opts: { keys?: string[]; allowExpired?: boolean },
  flagLabels: { keysFlag: string; allowExpiredFlag: string },
): void {
  const hasKeys = Array.isArray(opts.keys) && opts.keys.length > 0;
  if (!hasKeys && !opts.allowExpired) return;
  throw new Error(
    `Bundle '${bundleName}@${host}': ${flagLabels.keysFlag} and ${flagLabels.allowExpiredFlag} are not supported for remote (bundle@host) bundles yet. ` +
      `Drop the flag or resolve the bundle locally.`,
  );
}


const AUTH_SYNC_PUSH_DEADLINE_MS = 20_000;

export interface AuthSyncDevice {
  name: string;
  reachable: boolean;
  pinned: boolean;
  remoteAuth: SharedAuthStatus | 'unknown';
}

type AuthSyncPlanItem =
  | { action: 'push'; device: string }
  | { action: 'skip'; device: string; reason: string };

export function planAuthBundlePush(
  localAuthOk: boolean,
  localIsPublisher: boolean,
  devices: AuthSyncDevice[],
): AuthSyncPlanItem[] {
  if (!localAuthOk) {
    return devices.map((device) => ({ action: 'skip', device: device.name, reason: 'no local file-backed auth bundle' }));
  }
  if (!localIsPublisher) {
    return devices.map((device) => ({ action: 'skip', device: device.name, reason: 'another ready device is the elected auth publisher' }));
  }
  return devices.map((device) => {
    if (!device.reachable) return { action: 'skip', device: device.name, reason: 'unreachable' };
    if (!device.pinned) {
      return { action: 'skip', device: device.name, reason: `host key not pinned; run \`agents ssh ${device.name}\` once` };
    }
    if (device.remoteAuth === 'ready') return { action: 'skip', device: device.name, reason: 'already present' };
    if (device.remoteAuth === 'invalid') return { action: 'skip', device: device.name, reason: 'remote auth bundle uses the wrong backend' };
    if (device.remoteAuth === 'unknown') {
      return { action: 'skip', device: device.name, reason: 'no shared auth verdict has arrived from this peer' };
    }
    return { action: 'push', device: device.name };
  });
}

interface AuthSyncResult {
  publisher: string | null;
  stateChanged: boolean;
  pushed: string[];
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

interface AuthSyncDeps {
  inspectLocal?: () => { exists: boolean; ok: boolean };
  listDevices?: () => DeviceProfile[];
  localName?: string;
  userAgentsDir?: string;
  isPinned?: (name: string) => boolean;
  peerRole?: (name: string) => ReturnType<typeof selfConfiguredDeviceRole>;
  selfRole?: () => ReturnType<typeof selfConfiguredDeviceRole>;
  push?: (bundle: string, host: string) => Promise<PushBundleResult>;
  sshTarget?: (device: DeviceProfile) => string;
}

export function electPublisher(
  ready: readonly string[],
  roleOf: (name: string) => ReturnType<typeof selfConfiguredDeviceRole>,
): string | null {


  const rank = (name: string): number => (isHeadedDeviceRole(roleOf(name)) ? 0 : 1);
  return [...ready].sort((a, b) => rank(a) - rank(b) || normalizeHost(a).localeCompare(normalizeHost(b)))[0] ?? null;
}

interface PublishAuthVerdictOptions {
  inspectLocal?: () => { exists: boolean; ok: boolean };
  localName?: string;
  userAgentsDir?: string;
}

interface PublishAuthVerdictResult {
  device: string;
  status: SharedAuthStatus;
  changed: boolean;
  error: string | null;
}

function defaultDevices(): DeviceProfile[] {
  return Object.values(loadDevicesSync());
}

function authStatus(local: { exists: boolean; ok: boolean }): SharedAuthStatus {
  if (!local.exists) return 'missing';
  return local.ok ? 'ready' : 'invalid';
}

export async function publishReservedAuthVerdict(
  options: PublishAuthVerdictOptions = {},
): Promise<PublishAuthVerdictResult> {
  const local = (options.inspectLocal ?? inspectReservedAuthBundle)();
  const status = authStatus(local);
  const device = options.localName ?? machineId();
  try {
    const write = await updateFleetSharedDeviceStateAsync(
      device,
      { auth: { status } },
      options.userAgentsDir ?? getUserAgentsDir(),
    );
    return { device, status, changed: write.changed, error: null };
  } catch (err) {
    return { device, status, changed: false, error: (err as Error).message };
  }
}

export async function syncReservedAuthBundle(deps: AuthSyncDeps = {}): Promise<AuthSyncResult> {
  const result: AuthSyncResult = { publisher: null, stateChanged: false, pushed: [], skipped: [], errors: [] };
  const published = await publishReservedAuthVerdict(deps);
  const localStatus = published.status;
  const localName = published.device;
  const localNorm = normalizeHost(localName);
  const root = deps.userAgentsDir ?? getUserAgentsDir();
  const devices = (deps.listDevices ?? defaultDevices)().filter((device) => normalizeHost(device.name) !== localNorm);
  result.stateChanged = published.changed;
  if (published.error) result.errors.push({ device: localName, message: `could not publish auth verdict: ${published.error}` });

  const read = readFleetSharedDeviceStates(root);
  result.errors.push(...read.errors);
  const stateByDevice = new Map(read.states.map((state) => [normalizeHost(state.device), state]));
  const registered = new Map(devices.map((device) => [normalizeHost(device.name), device]));
  const readyPublishers = read.states
    .filter((state) => {
      if (state.auth?.status !== 'ready') return false;
      if (normalizeHost(state.device) === localNorm) return localStatus === 'ready';
      const device = registered.get(normalizeHost(state.device));
      return !!device && isDialableDevice(device);
    })
    .map((state) => state.device);
  if (localStatus === 'ready' && !readyPublishers.some((name) => normalizeHost(name) === localNorm)) {
    readyPublishers.push(localName);
  }
  const peerRole = deps.peerRole ?? configuredDeviceRole;
  const selfRole = deps.selfRole ?? selfConfiguredDeviceRole;
  result.publisher = electPublisher(readyPublishers, (name) => (normalizeHost(name) === localNorm ? selfRole() : peerRole(name)));
  const localIsPublisher = result.publisher !== null && normalizeHost(result.publisher) === localNorm;

  const pinned = deps.isPinned ?? ((name: string) => isHostPinned(name, managedKnownHostsPath()));
  const plan = planAuthBundlePush(
    localStatus === 'ready',
    localIsPublisher,
    devices.map((device) => ({
      name: device.name,
      reachable: isDialableDevice(device),
      pinned: isDevicePinned(device, pinned),
      remoteAuth: stateByDevice.get(normalizeHost(device.name))?.auth?.status ?? 'unknown',
    })),
  );
  const byName = new Map(devices.map((device) => [device.name, device]));
  const push = deps.push ?? ((bundle: string, host: string) => pushBundleToHostAsync(bundle, host, {
    remoteBackend: 'file',
    operation: 'auth-sync',
    agentOnly: true,
    timeoutMs: AUTH_SYNC_PUSH_DEADLINE_MS,
  }));
  const targetOf = deps.sshTarget ?? sshTargetFor;

  const outcomes = await Promise.all(plan.map(async (item) => {
    if (item.action === 'skip') return { kind: 'skip' as const, device: item.device, message: item.reason };
    const profile = byName.get(item.device);
    if (!profile) return { kind: 'skip' as const, device: item.device, message: 'not in registry' };
    try {
      const out = await push(AUTH_STORE_ALIAS, targetOf(profile));
      return out.ok
        ? { kind: 'pushed' as const, device: item.device, message: out.message }
        : { kind: 'error' as const, device: item.device, message: out.message };
    } catch (err) {
      return { kind: 'error' as const, device: item.device, message: (err as Error).message };
    }
  }));
  for (const outcome of outcomes) {
    if (outcome.kind === 'pushed') result.pushed.push(outcome.device);
    else if (outcome.kind === 'skip') result.skipped.push({ device: outcome.device, reason: outcome.message });
    else result.errors.push({ device: outcome.device, message: outcome.message });
  }
  return result;
}


const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

export const SKIP_REASON_NO_PEER_REPLY = 'no daemon-state reply from this peer yet';

export const SKIP_REASON_NO_ACCOUNT_ROWS = 'daemon-state reply carries no account rows (fail closed)';

export interface ReservedSyncAccount {
  accountId: string;
  harness: AgentId;
  bundle: string;
  key: string;
  fingerprint: string;
}

export interface ReservedSyncPeer {
  name: string;
  headed: boolean;
  reachable: boolean;
  pinned: boolean;
  hasReply: boolean;
  hasAccountRows: boolean;
  presentKeys: Record<string, ReadonlySet<string>>;
}

type ReservedSyncPlanItem =
  | { action: 'push'; device: string; bundle: string; keys: string[] }
  | { action: 'skip'; device: string; reason: string };

// Durable credentials flow headed-to-worker only; missing peer/account role truth fails closed.
export function planReservedStoreSync(
  accounts: ReservedSyncAccount[],
  peers: ReservedSyncPeer[],
): ReservedSyncPlanItem[] {


  const keysByBundle = new Map<string, Set<string>>();
  for (const account of accounts) {
    let keys = keysByBundle.get(account.bundle);
    if (!keys) keysByBundle.set(account.bundle, (keys = new Set()));
    keys.add(account.key);
  }
  const bundles = [...keysByBundle.keys()].sort();
  const items: ReservedSyncPlanItem[] = [];
  for (const peer of [...peers].sort((a, b) => a.name.localeCompare(b.name))) {
    if (peer.headed) {
      items.push({ action: 'skip', device: peer.name, reason: 'headed device receives the account row, never a durable key' });
      continue;
    }
    if (!peer.hasReply) { items.push({ action: 'skip', device: peer.name, reason: SKIP_REASON_NO_PEER_REPLY }); continue; }
    if (!peer.hasAccountRows) { items.push({ action: 'skip', device: peer.name, reason: SKIP_REASON_NO_ACCOUNT_ROWS }); continue; }
    if (!peer.reachable) { items.push({ action: 'skip', device: peer.name, reason: 'unreachable' }); continue; }
    if (!peer.pinned) {
      items.push({ action: 'skip', device: peer.name, reason: `host key not pinned; run \`agents ssh ${peer.name}\` once` });
      continue;
    }
    let missingAny = false;
    for (const bundle of bundles) {
      const wanted = keysByBundle.get(bundle)!;
      const present = peer.presentKeys[bundle] ?? EMPTY_KEY_SET;
      const missing = [...wanted].filter((key) => !present.has(key)).sort();
      if (missing.length > 0) {
        items.push({ action: 'push', device: peer.name, bundle, keys: missing });
        missingAny = true;
      }
    }
    if (!missingAny) items.push({ action: 'skip', device: peer.name, reason: 'all reserved credentials present' });
  }
  return items;
}

export function reservedSyncTargets(meta: Pick<Meta, 'accounts' | 'deviceAccounts'>): ReservedSyncAccount[] {
  const out: ReservedSyncAccount[] = [];
  for (const account of listNativeAccounts(meta)) {
    const cred = account.workerCredential;
    if (cred) {
      out.push({ accountId: account.id, harness: account.agent, bundle: cred.bundle, key: cred.key, fingerprint: cred.mintedAt });
    } else if (account.agent === 'claude' && account.identityLabel) {
      out.push({ accountId: account.id, harness: 'claude', bundle: AUTH_STORE_ALIAS, key: claudeAccountTokenKey(account.identityLabel), fingerprint: 'legacy' });
    }
  }
  return out;
}


export interface PeerAccountVerdict {
  accountId: string;
  harness: string;
  verdict: string;
}

export function readPeerAccountVerdicts(state: FleetSharedDeviceState | undefined): PeerAccountVerdict[] {
  const rows = state?.accounts?.rows;
  if (!Array.isArray(rows)) return [];
  const out: PeerAccountVerdict[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.accountId === 'string' && typeof r.harness === 'string' && typeof r.verdict === 'string') {
      out.push({ accountId: r.accountId, harness: r.harness, verdict: r.verdict });
    }
  }
  return out;
}

export function peerHasAccountRows(state: FleetSharedDeviceState | undefined): boolean {
  return Array.isArray(state?.accounts?.rows);
}


function deliveryMemoPath(root = getCacheDir()): string {
  return path.join(root, 'reserved-sync-delivered.json');
}

function memoKey(peer: string, bundle: string, key: string): string {
  return `${normalizeHost(peer)} ${bundle} ${key}`;
}

function readDeliveryMemo(root?: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(deliveryMemoPath(root), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch {  }
  return {};
}

function writeDeliveryMemo(memo: Record<string, string>, root = getCacheDir()): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(deliveryMemoPath(root), `${JSON.stringify(memo, null, 2)}\n`, 'utf-8');
}

export function peerPresentKeys(
  accounts: ReservedSyncAccount[],
  verdicts: PeerAccountVerdict[],
  delivered: (bundle: string, key: string) => string | undefined,
): Record<string, ReadonlySet<string>> {


  const held = new Set(
    verdicts.filter((v) => v.verdict !== 'missing').map((v) => `${v.harness}:${v.accountId}`),
  );
  const present: Record<string, Set<string>> = {};
  for (const account of accounts) {
    if (!held.has(`${account.harness}:${account.accountId}`)) continue;
    if (delivered(account.bundle, account.key) !== account.fingerprint) continue;
    (present[account.bundle] ??= new Set()).add(account.key);
  }
  return present;
}

interface ReservedStoreSyncResult {
  publisher: string | null;
  adopted: Array<{ bundle: string; key: string }>;
  pushed: Array<{ device: string; bundle: string; keys: string[] }>;
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

interface ReservedStoreSyncDeps {
  listDevices?: () => DeviceProfile[];
  localName?: string;
  userAgentsDir?: string;
  cacheDir?: string;
  readMetaFn?: () => Pick<Meta, 'accounts' | 'deviceAccounts'>;
  isPinned?: (name: string) => boolean;
  peerRole?: (name: string) => ReturnType<typeof selfConfiguredDeviceRole>;
  selfRole?: () => ReturnType<typeof selfConfiguredDeviceRole>;
  localReady?: boolean;
  hasLocalKey?: (bundle: string, key: string) => boolean;
  adoptLegacy?: (meta: Pick<Meta, 'accounts' | 'deviceAccounts'>) => Promise<{ adopted: Array<{ bundle: string; key: string }>; errors: Array<{ bundle: string; key: string; message: string }> }>;
  push?: (bundle: string, host: string) => Promise<PushBundleResult>;
  sshTarget?: (device: DeviceProfile) => string;
}

function defaultHasLocalKey(bundle: string, key: string): boolean {
  return readReservedCredential(bundle, key) !== null;
}

export async function syncReservedStores(deps: ReservedStoreSyncDeps = {}): Promise<ReservedStoreSyncResult> {
  const result: ReservedStoreSyncResult = { publisher: null, adopted: [], pushed: [], skipped: [], errors: [] };
  const localName = deps.localName ?? machineId();
  const localNorm = normalizeHost(localName);
  const root = deps.userAgentsDir ?? getUserAgentsDir();
  const meta = (deps.readMetaFn ?? readMeta)();

  const adopt = deps.adoptLegacy ?? (async (m) => (await import('./auth-mint.js')).adoptLegacyReservedStoreItems(m));
  try {
    const adoption = await adopt(meta);
    result.adopted.push(...adoption.adopted);
    for (const err of adoption.errors) result.errors.push({ device: localName, message: `adopt ${err.bundle} ${err.key}: ${err.message}` });
  } catch (err) {
    result.errors.push({ device: localName, message: `adopt legacy reserved items: ${(err as Error).message}` });
  }

  const hasLocalKey = deps.hasLocalKey ?? defaultHasLocalKey;
  const targets = reservedSyncTargets(meta).filter((t) => hasLocalKey(t.bundle, t.key));

  const devices = (deps.listDevices ?? defaultDevices)().filter((d) => normalizeHost(d.name) !== localNorm);
  const read = readFleetSharedDeviceStates(root);
  result.errors.push(...read.errors);
  const stateByDevice = new Map(read.states.map((s) => [normalizeHost(s.device), s]));
  const registered = new Map(devices.map((d) => [normalizeHost(d.name), d]));

  const localReady = deps.localReady ?? inspectReservedAuthBundle().ok;
  const readyPublishers = read.states
    .filter((s) => {
      if (s.auth?.status !== 'ready') return false;
      if (normalizeHost(s.device) === localNorm) return localReady;
      const d = registered.get(normalizeHost(s.device));
      return !!d && isDialableDevice(d);
    })
    .map((s) => s.device);
  if (localReady && !readyPublishers.some((n) => normalizeHost(n) === localNorm)) readyPublishers.push(localName);
  const peerRole = deps.peerRole ?? configuredDeviceRole;
  const selfRole = deps.selfRole ?? selfConfiguredDeviceRole;
  result.publisher = electPublisher(readyPublishers, (name) => (normalizeHost(name) === localNorm ? selfRole() : peerRole(name)));
  const localIsPublisher = result.publisher !== null && normalizeHost(result.publisher) === localNorm;
  if (targets.length === 0 || !localIsPublisher) {
    for (const d of devices) {
      result.skipped.push({ device: d.name, reason: targets.length === 0 ? 'no portable account with a durable credential' : 'another ready device is the elected publisher' });
    }
    return result;
  }

  const memo = readDeliveryMemo(deps.cacheDir);
  const pinned = deps.isPinned ?? ((name: string) => isHostPinned(name, managedKnownHostsPath()));
  const peers: ReservedSyncPeer[] = devices.map((d) => {
    const state = stateByDevice.get(normalizeHost(d.name));
    return {
      name: d.name,
      headed: isHeadedDeviceRole(peerRole(d.name)),
      reachable: isDialableDevice(d),
      pinned: isDevicePinned(d, pinned),
      hasReply: state !== undefined,
      hasAccountRows: peerHasAccountRows(state),
      presentKeys: peerPresentKeys(
        targets,
        readPeerAccountVerdicts(state),
        (bundle, key) => memo[memoKey(d.name, bundle, key)],
      ),
    };
  });

  const plan = planReservedStoreSync(targets, peers);
  const byName = new Map(devices.map((d) => [d.name, d]));
  const push = deps.push ?? ((bundle: string, host: string) => pushBundleToHostAsync(bundle, host, {
    remoteBackend: 'file', operation: 'reserved-sync', agentOnly: true, timeoutMs: AUTH_SYNC_PUSH_DEADLINE_MS,
  }));
  const sshTarget = deps.sshTarget ?? sshTargetFor;

  for (const item of plan) {
    if (item.action === 'skip') { result.skipped.push({ device: item.device, reason: item.reason }); continue; }
    const profile = byName.get(item.device);
    if (!profile) { result.skipped.push({ device: item.device, reason: 'not in registry' }); continue; }
    try {
      const out = await push(item.bundle, sshTarget(profile));
      if (out.ok) {
        result.pushed.push({ device: item.device, bundle: item.bundle, keys: item.keys });
        for (const key of item.keys) {
          const fp = targets.find((t) => t.bundle === item.bundle && t.key === key)?.fingerprint;
          if (fp) memo[memoKey(item.device, item.bundle, key)] = fp;
        }
      } else {
        result.errors.push({ device: item.device, message: out.message });
      }
    } catch (err) {
      result.errors.push({ device: item.device, message: (err as Error).message });
    }
  }
  writeDeliveryMemo(memo, deps.cacheDir ?? getCacheDir());
  return result;
}

interface ReconcileWorkerSlotsResult {
  provisioned: string[];
  dropped: string[];
  skipped: Array<{ accountId: string; reason: string }>;
  errors: Array<{ accountId: string; message: string }>;
}

interface ReconcileWorkerSlotsDeps {
  selfRole?: ReturnType<typeof selfConfiguredDeviceRole>;
  readMetaFn?: () => Pick<Meta, 'accounts' | 'deviceAccounts'>;
  hasLocalKey?: (bundle: string, key: string) => boolean;
  provision?: (account: NativeAccountRecord) => void;
  slotSeeded?: (harness: AgentId, slotDir: string) => boolean;
  dropSlots?: (accountIds: readonly string[]) => void;
  log?: (level: 'INFO' | 'WARN', message: string) => void;
}

function defaultWorkerSlotLog(level: 'INFO' | 'WARN', message: string): void {
  void import('./daemon/daemon.js').then((m) => m.log(level, message)).catch(() => {});
}

function defaultSlotSeeded(harness: AgentId, slotDir: string): boolean {
  return harness === 'claude' ? isClaudeWorkerHomeSeeded(slotDir) : true;
}

// Delete a stale worker credential before its registry row, but retain the slot directory for transcripts.
export function reconcileLocalWorkerSlots(deps: ReconcileWorkerSlotsDeps = {}): ReconcileWorkerSlotsResult {
  const result: ReconcileWorkerSlotsResult = { provisioned: [], dropped: [], skipped: [], errors: [] };
  const role = 'selfRole' in deps ? deps.selfRole : selfConfiguredDeviceRole();
  if (isHeadedDeviceRole(role)) return result;
  const meta = (deps.readMetaFn ?? readMeta)();
  const slots = readSlots(meta as Pick<Meta, 'deviceAccounts'>);
  const hasLocalKey = deps.hasLocalKey ?? defaultHasLocalKey;
  const provision = deps.provision ?? provisionWorkerSlot;
  const slotSeeded = deps.slotSeeded ?? defaultSlotSeeded;
  const byId = new Map(listNativeAccounts(meta).map((account) => [account.id, account]));

  if (role === 'worker' && byId.size > 0) {
    const stale = Object.values(slots).filter((slot) => !byId.has(slot.accountId));
    const droppable: DeviceAccountSlot[] = [];
    for (const slot of stale) {
      try {
        fs.rmSync(path.join(slot.slotDir, '.claude', '.oauth_token'), { force: true });
        droppable.push(slot);
      } catch (err) {
        result.errors.push({ accountId: slot.accountId, message: `stale slot credential not removed, slot kept: ${(err as Error).message}` });
      }
    }
    if (droppable.length > 0) {
      (deps.dropSlots ?? dropSlots)(droppable.map((slot) => slot.accountId));
      const log = deps.log ?? defaultWorkerSlotLog;
      for (const slot of droppable) {
        result.dropped.push(slot.accountId);
        log('INFO', `worker-slot: dropped stale slot ${slot.accountId} — no longer a registered account; removed its credential, kept ${slot.slotDir} for transcripts`);
      }
    }
  }
  for (const target of reservedSyncTargets(meta)) {
    const account = byId.get(target.accountId);
    if (!account) continue;
    if (!hasLocalKey(target.bundle, target.key)) { result.skipped.push({ accountId: account.id, reason: 'durable key not synced yet' }); continue; }
    const existing = slots[account.id];
    const reseed = existing?.authMode === 'durable';
    if (reseed && slotSeeded(account.agent, existing.slotDir)) {
      result.skipped.push({ accountId: account.id, reason: 'slot already provisioned' });
      continue;
    }
    try {
      provision(account);
      if (reseed && !slotSeeded(account.agent, existing.slotDir)) {
        result.errors.push({ accountId: account.id, message: `slot ${existing.slotDir} is still not fully seeded after re-provisioning; a config file there exists but cannot be parsed` });
        continue;
      }
      result.provisioned.push(account.id);
    } catch (err) { result.errors.push({ accountId: account.id, message: (err as Error).message }); }
  }
  return result;
}
