/**
 * Agents-owned fleet policy for the secrets engine boundary (PHNX-3989 CTX-1,
 * delta-spec OWN-1). The standalone `secrets` engine has no concept of a
 * "reserved" per-harness credential store, resource profiles, device roles, or
 * fleet election — none of that is portable secret-storage behavior, so it
 * lives here rather than in the engine. Every actual read/write against a
 * bundle or raw item resolves through the process client (`secrets-client.ts`);
 * this module only decides WHICH bundle/key, WHO may reach it, and WHERE it
 * gets pushed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  pushBundleToHostAsync,
  listBundles,
  type SecretsContext,
} from './secrets-client.js';
import type { PushBundleResult } from './secrets-types.js';
import type { AgentId, Meta, NativeAccountRecord } from './types.js';
import { filterNamesForActiveResourceProfile, getActiveResourceProfile } from './resource-profiles.js';
import { isDialableDevice, loadDevicesSync, type DeviceProfile } from './devices/registry.js';
import { sshTargetFor } from './devices/connect.js';
import { isHostPinned, isDevicePinned, managedKnownHostsPath } from './devices/known-hosts.js';
import { machineId, normalizeHost } from './session/sync/config.js';
import {
  readFleetSharedDeviceStates,
  updateFleetSharedDeviceStateAsync,
  type SharedAuthStatus,
} from './fleet-shared-state.js';
import { getCacheDir, getUserAgentsDir, readMeta } from './state.js';
import { listNativeAccounts, readSlots } from './account-registry.js';
import { claudeAccountTokenKey, provisionWorkerSlot, readReservedCredential } from './claude-account-token.js';
import { configuredDeviceRole, isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import {
  AUTH_STORE_ALIAS,
  AUTH_BUNDLE_NAME,
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

// --- reserved per-harness credential stores (PHNX-3940 / PHNX-3989) --------
//
// Re-exported from the leaf module `reserved-stores.ts` rather than declared
// here: `claude-account-token.ts` needs these constants AND is itself a
// dependency of this module's fleet-sync helpers below, so declaring them
// here would form a real circular import (reproduced as a TDZ
// ReferenceError under real ESM evaluation order, outside vitest's
// mock-tolerant transform). Keep the public surface unchanged for existing
// importers of `secrets-policy.js`.
export {
  AUTH_STORE_ALIAS,
  AUTH_BUNDLE_NAME,
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


// --- resource-profile -> allowedBundles (CTX-1) -----------------------------
//
// A resource profile scopes WHICH bundle names a run may reach. The standalone
// has no concept of a profile; agents-cli computes the allowed set from the
// full bundle listing and forwards it as `SecretsContext.allowedBundles` on
// every bounded request. Absent (no active profile) means full trust, matching
// the client's own documented default.

/** Filter `names` down to the ones the active resource profile allows for `secrets`. */
export function filterBundleNamesForActiveProfile(names: string[]): string[] {
  return filterNamesForActiveResourceProfile('secrets', names);
}

/**
 * `SecretsContext.allowedBundles` for the active resource profile, or
 * `undefined` when no profile is active (full trust — the client's default).
 * `allNames` is the caller's already-fetched full bundle listing (e.g. from
 * `listBundlesSync()`), so this stays a pure filter with no extra round trip.
 */
export function resolveAllowedBundlesForActiveProfile(allNames: string[]): string[] | undefined {
  const filtered = filterBundleNamesForActiveProfile(allNames);
  return filtered.length === allNames.length ? undefined : filtered;
}

/**
 * The `SecretsContext` a run should pass to every bundle resolution it makes:
 * the run's harness as the opaque `scope`, plus `allowedBundles` computed from
 * a fresh full bundle listing when a resource profile is active (a stale
 * listing could exclude a bundle created after the profile was set). No
 * profile active means full trust and no extra round trip.
 */
export async function resolveSecretsContextForRun(scope?: string): Promise<SecretsContext | undefined> {
  if (!getActiveResourceProfile()) return scope ? { scope } : undefined;
  const allNames = (await listBundles()).map((b) => b.name);
  return { allowedBundles: resolveAllowedBundlesForActiveProfile(allNames), scope };
}

// --- bundle@host remote-reference parsing (agents' own `--secrets` flag
// semantics, REMOTE-1) -------------------------------------------------------

/** Parse a `--secrets` flag value into its bundle name and optional `@host`. */
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

/** A remote (bundle@host) reference does not yet support key-subset or expiry overrides. */
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

// ---------------------------------------------------------------------------
// Fleet sync of the reserved file-backed `auth` bundle (PHNX-2371/PHNX-3609).
//
// Every daemon publishes only a safe auth readiness verdict into its owned
// fleet-shared state file. A deterministic ready publisher reads those
// verdicts and transfers the actual bundle only to a peer reporting `missing`.
// Secret values never enter Git; the exceptional provisioning transfer is SSH,
// async and kill-bounded so it never blocks the daemon event loop.
// ---------------------------------------------------------------------------

/** Each import/read-back SSH operation gets this deadline plus the SSH hard-kill grace. */
export const AUTH_SYNC_PUSH_DEADLINE_MS = 20_000;

export interface AuthSyncDevice {
  name: string;
  reachable: boolean;
  pinned: boolean;
  remoteAuth: SharedAuthStatus | 'unknown';
}

export type AuthSyncPlanItem =
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

export interface AuthSyncResult {
  publisher: string | null;
  stateChanged: boolean;
  pushed: string[];
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

export interface AuthSyncDeps {
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

/**
 * The one device that pushes credentials this tick. A ready HEADED device
 * (`personal`/`desktop`) wins over any ready worker: the headed box is where
 * tokens are minted (invariant 7), so it is the copy of record; a worker holds
 * only what was once pushed to it. Name order breaks ties so every box elects
 * the same publisher from the same shared verdicts. Before this rule the sort
 * was by name alone, which elected `mac-mini` (a worker with a 6-day-old copy)
 * over `zion`, and zion then skipped every peer as a non-publisher.
 */
export function electPublisher(
  ready: readonly string[],
  roleOf: (name: string) => ReturnType<typeof selfConfiguredDeviceRole>,
): string | null {
  const rank = (name: string): number => (isHeadedDeviceRole(roleOf(name)) ? 0 : 1);
  return [...ready].sort((a, b) => rank(a) - rank(b) || normalizeHost(a).localeCompare(normalizeHost(b)))[0] ?? null;
}

export interface PublishAuthVerdictOptions {
  inspectLocal?: () => { exists: boolean; ok: boolean };
  localName?: string;
  userAgentsDir?: string;
}

export interface PublishAuthVerdictResult {
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

/** Publish only safe readiness metadata; useful immediately before a repo push. */
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

/**
 * Publish local readiness, elect one ready source, then asynchronously provision
 * only peers whose shared verdict says the bundle is missing.
 */
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

// ---------------------------------------------------------------------------
// Reserved-store sync, generalized to every portable account (PHNX-3940 T6).
//
// The path above pushes ONE bundle (`auth`) to peers reporting a bundle-coarse
// `missing` verdict. That under-pushes: a peer already holding `auth` (verdict
// `ready`) never receives a newly-added account's key, so a new account never
// propagates. It also pushes to any peer regardless of role, and a headed peer
// must never receive a durable key (owner invariant 7).
//
// The functions below fix both. The plan is per ACCOUNT and per KEY
// (`<ENV>_<accountId>`), not per bundle, and targets `role=worker` peers only.
//
// INVARIANT 1 (transport, retain nothing): materializing a worker slot happens
// on the box where the key LANDED (`reconcileLocalWorkerSlots` ->
// `provisionWorkerSlot`); the credential itself only ever moves over the
// existing encrypted SSH bundle push (the client's `pushBundleToHostAsync`),
// which writes nothing on the sender beyond its existing store. A native
// OAuth/session file is never transported (`fleet/auth-sync.ts`
// `isCredentialSafeToPropagate` stays false).
// ---------------------------------------------------------------------------

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

/** One account's durable worker credential, resolved to (bundle, key). */
export interface ReservedSyncAccount {
  accountId: string;
  harness: AgentId;
  /** Reserved store `__<harness>__`, or the legacy `auth` alias for a pre-T1 claude row. */
  bundle: string;
  /** Storage key `<ENV>_<accountId>` (or the legacy email-keyed claude key). */
  key: string;
  /**
   * `workerCredential.mintedAt` -- a re-mint bumps it, so a delivered-memo hit on
   * the old value re-pushes. `'legacy'` for a pre-T1 claude row with no field.
   */
  fingerprint: string;
}

/** A peer as the plan sees it: its role, reachability, and the keys it is KNOWN to hold. */
export interface ReservedSyncPeer {
  name: string;
  /** `personal`/`desktop` -- receives the account row, never a durable key. */
  headed: boolean;
  reachable: boolean;
  pinned: boolean;
  /** bundle -> keys the peer already holds at the current fingerprint. Absent ⇒ none known. */
  presentKeys: Record<string, ReadonlySet<string>>;
}

export type ReservedSyncPlanItem =
  | { action: 'push'; device: string; bundle: string; keys: string[] }
  | { action: 'skip'; device: string; reason: string };

/**
 * Pure plan: for each worker peer, push each bundle it is missing at least one
 * key of. Deterministic (peers and bundles sorted) so it pins exactly in tests.
 * A headed peer is skipped BEFORE any key comparison -- it never receives a key.
 */
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

/**
 * Every portable account's durable worker credential, resolved to (bundle, key).
 * A T1 row carries `workerCredential`; a claude row predating T1 has none, so it
 * falls back to the legacy `auth` bundle keyed by the account email -- the
 * legacy fallback for claude rows that predate T1. An account with no derivable
 * durable credential (per-device harness, or a non-claude row with no
 * `workerCredential`) is not a sync target.
 */
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

// --- publisher-side delivery memo -----------------------------------------
// A push sends a WHOLE bundle; the receiver reports no per-key inventory today
// (that is T3's per-account verdict seam). So the publisher records what it has
// delivered to each peer, keyed by the credential's fingerprint, to answer "does
// the peer already have this key" without re-pushing an unchanged bundle every
// tick. A new account (no memo entry) or a re-mint (fingerprint change) is not a
// hit, so it propagates within one tick. The memo is LOCAL publisher bookkeeping,
// never synced.

function deliveryMemoPath(root = getCacheDir()): string {
  return path.join(root, 'reserved-sync-delivered.json');
}

function memoKey(peer: string, bundle: string, key: string): string {
  return `${normalizeHost(peer)} ${bundle} ${key}`;
}

export function readDeliveryMemo(root?: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(deliveryMemoPath(root), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch { /* missing/malformed → empty memo */ }
  return {};
}

function writeDeliveryMemo(memo: Record<string, string>, root = getCacheDir()): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(deliveryMemoPath(root), `${JSON.stringify(memo, null, 2)}\n`, 'utf-8');
}

/**
 * The keys a peer is KNOWN to hold, per bundle, from what we have delivered to it
 * (memo, matched by fingerprint) plus the coarse legacy-`auth` verdict: a peer
 * reporting `auth.status === 'ready'` is known to hold every legacy `auth` key.
 * Reserved `__<harness>__` bundles have no coarse verdict, so their presence comes
 * from the memo alone -- which is what makes a newly-added reserved account push.
 */
export function peerPresentKeys(
  peer: string,
  accounts: ReservedSyncAccount[],
  memo: Record<string, string>,
  legacyAuthReady: boolean,
): Record<string, ReadonlySet<string>> {
  const present: Record<string, Set<string>> = {};
  for (const account of accounts) {
    const known = memo[memoKey(peer, account.bundle, account.key)] === account.fingerprint
      || (legacyAuthReady && account.bundle === AUTH_STORE_ALIAS);
    if (!known) continue;
    (present[account.bundle] ??= new Set()).add(account.key);
  }
  return present;
}

export interface ReservedStoreSyncResult {
  publisher: string | null;
  pushed: Array<{ device: string; bundle: string; keys: string[] }>;
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

export interface ReservedStoreSyncDeps {
  listDevices?: () => DeviceProfile[];
  localName?: string;
  userAgentsDir?: string;
  cacheDir?: string;
  readMetaFn?: () => Pick<Meta, 'accounts' | 'deviceAccounts'>;
  isPinned?: (name: string) => boolean;
  peerRole?: (name: string) => ReturnType<typeof selfConfiguredDeviceRole>;
  selfRole?: () => ReturnType<typeof selfConfiguredDeviceRole>;
  localReady?: boolean;
  /** Does THIS publisher hold (bundle, key) to push? Defaults to a local bundle read. */
  hasLocalKey?: (bundle: string, key: string) => boolean;
  push?: (bundle: string, host: string) => Promise<PushBundleResult>;
  sshTarget?: (device: DeviceProfile) => string;
}

function defaultHasLocalKey(bundle: string, key: string): boolean {
  // Reserved-store aware: readReservedCredential reads a `__<harness>__` item
  // directly and a legacy/provider bundle through the normal resolver.
  return readReservedCredential(bundle, key) !== null;
}

/**
 * Push every portable account's reserved store to the worker peers that are
 * missing it, per key and per role. Reuses the same election as
 * {@link syncReservedAuthBundle} (one deterministic ready publisher pushes) so
 * there is no second scheduler. The daemon runs this each tick.
 */
export async function syncReservedStores(deps: ReservedStoreSyncDeps = {}): Promise<ReservedStoreSyncResult> {
  const result: ReservedStoreSyncResult = { publisher: null, pushed: [], skipped: [], errors: [] };
  const localName = deps.localName ?? machineId();
  const localNorm = normalizeHost(localName);
  const root = deps.userAgentsDir ?? getUserAgentsDir();
  const meta = (deps.readMetaFn ?? readMeta)();

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
  const peers: ReservedSyncPeer[] = devices.map((d) => ({
    name: d.name,
    headed: isHeadedDeviceRole(peerRole(d.name)),
    reachable: isDialableDevice(d),
    pinned: isDevicePinned(d, pinned),
    presentKeys: peerPresentKeys(d.name, targets, memo, stateByDevice.get(normalizeHost(d.name))?.auth?.status === 'ready'),
  }));

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

export interface ReconcileWorkerSlotsResult {
  provisioned: string[];
  skipped: Array<{ accountId: string; reason: string }>;
  errors: Array<{ accountId: string; message: string }>;
}

export interface ReconcileWorkerSlotsDeps {
  selfRole?: ReturnType<typeof selfConfiguredDeviceRole>;
  readMetaFn?: () => Pick<Meta, 'accounts' | 'deviceAccounts'>;
  hasLocalKey?: (bundle: string, key: string) => boolean;
  provision?: (account: NativeAccountRecord) => void;
}

/**
 * Worker-side: after a durable key lands, materialize a slot for each portable
 * account whose credential is now present locally. Runs only on a NON-headed
 * (worker or unmarked) device -- a headed device provisions its slots from an
 * interactive native login (`accounts add`), never from an injected durable key
 * (invariant 7). Idempotent: an account already backed by a `durable` slot is
 * skipped.
 */
export function reconcileLocalWorkerSlots(deps: ReconcileWorkerSlotsDeps = {}): ReconcileWorkerSlotsResult {
  const result: ReconcileWorkerSlotsResult = { provisioned: [], skipped: [], errors: [] };
  const role = deps.selfRole ?? selfConfiguredDeviceRole();
  if (isHeadedDeviceRole(role)) return result; // headed boxes provision via native login
  const meta = (deps.readMetaFn ?? readMeta)();
  const slots = readSlots(meta as Pick<Meta, 'deviceAccounts'>);
  const hasLocalKey = deps.hasLocalKey ?? defaultHasLocalKey;
  const provision = deps.provision ?? provisionWorkerSlot;
  const byId = new Map(listNativeAccounts(meta).map((account) => [account.id, account]));
  // Resolve each account to the one (bundle, key) the push plan uses: a T1 row's
  // reserved `__<harness>__` key, or the legacy `auth` key by email for a claude
  // row predating T1. Both are worker credentials this box may already hold, so
  // both get a slot. Skipping the legacy rows here is what left every registered
  // pre-T1 account without a slot on every worker while its token sat in `auth`:
  // the picker then fell back to identity-less version homes and Claude showed a
  // login screen on a headless box (the mac-mini 2026-09-06 incident).
  for (const target of reservedSyncTargets(meta)) {
    const account = byId.get(target.accountId);
    if (!account) continue;
    if (!hasLocalKey(target.bundle, target.key)) { result.skipped.push({ accountId: account.id, reason: 'durable key not synced yet' }); continue; }
    if (slots[account.id]?.authMode === 'durable') { result.skipped.push({ accountId: account.id, reason: 'slot already provisioned' }); continue; }
    try { provision(account); result.provisioned.push(account.id); }
    catch (err) { result.errors.push({ accountId: account.id, message: (err as Error).message }); }
  }
  return result;
}
