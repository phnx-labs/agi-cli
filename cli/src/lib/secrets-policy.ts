/** Agents-owned fleet policy at the secrets engine boundary (PHNX-3989 CTX-1, OWN-1). The standalone
 * has no concept of reserved per-harness stores, resource profiles, device roles or fleet election,
 * so that lives here. Reads/writes go through `secrets-client.ts`. */
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

// Re-exported from the leaf module `reserved-stores.ts`: `claude-account-token.ts` needs these
// constants and is a dependency of this module's fleet-sync helpers, so declaring them here would
// form a circular import (a TDZ ReferenceError under real ESM order). Public surface unchanged.
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


// Resource profile to allowedBundles (CTX-1): a profile scopes WHICH bundle names a run may reach.
// The standalone has no profile concept, so agents-cli computes the allowed set from the full
// listing and forwards it as `SecretsContext.allowedBundles`.

/** Filter `names` down to the ones the active resource profile allows for `secrets`. */
function filterBundleNamesForActiveProfile(names: string[]): string[] {
  return filterNamesForActiveResourceProfile('secrets', names);
}

/** `SecretsContext.allowedBundles` for the active resource profile, or `undefined` (full trust, the
 * client's default). `allNames` is the caller's already-fetched listing, so this is a pure filter
 * with no round trip. */
export function resolveAllowedBundlesForActiveProfile(allNames: string[]): string[] | undefined {
  const filtered = filterBundleNamesForActiveProfile(allNames);
  return filtered.length === allNames.length ? undefined : filtered;
}

/** The `SecretsContext` a run passes to every bundle resolution: the harness as opaque `scope`, plus
 * `allowedBundles` from a FRESH full listing when a profile is active (a stale one could exclude a
 * bundle created after the profile was set). No profile means full trust and no round trip. */
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

// Fleet sync of the reserved file-backed `auth` bundle (PHNX-2371/PHNX-3609): each daemon publishes
// only a safe auth readiness verdict into its fleet-shared state file; a deterministic ready
// publisher transfers the bundle only to a peer reporting `missing`. Secret values never enter Git.

/** Each import/read-back SSH operation gets this deadline plus the SSH hard-kill grace. */
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

/** The one device that pushes credentials this tick. A ready HEADED device (`personal`/`desktop`)
 * beats any ready worker, since tokens are minted there (invariant 7); name order breaks ties so
 * every box elects the same publisher. */
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

/** Publish local readiness, elect one ready source, then asynchronously provision only the peers
 * whose shared verdict says the bundle is missing. */
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

// Reserved-store sync for every portable account (PHNX-3940 T6), per ACCOUNT and KEY, to
// `role=worker` peers only (invariant 7). A key is present on a peer only with a first-hand
// non-missing verdict AND a matching delivered fingerprint (PHNX-4116); no rows: fail closed.

const EMPTY_KEY_SET: ReadonlySet<string> = new Set();

/** Skip reason for a peer that has never sent a daemon-state reply. Logged at INFO since a new or
 * never-dialed worker legitimately has none on an early tick. Stable so the service classifies it
 * without substring matching. */
export const SKIP_REASON_NO_PEER_REPLY = 'no daemon-state reply from this peer yet';

/** Skip reason for a peer whose reply carries no `accounts.rows` (older CLI or partial state). With
 * no first-hand knowledge the plan FAILS CLOSED rather than push every key blindly; INFO, transient
 * in a rolling upgrade. An EMPTY array is a legitimate "holds nothing" and is pushed to. */
export const SKIP_REASON_NO_ACCOUNT_ROWS = 'daemon-state reply carries no account rows (fail closed)';

/** One account's durable worker credential, resolved to (bundle, key). */
export interface ReservedSyncAccount {
  accountId: string;
  harness: AgentId;
  /** Reserved store `__<harness>__`, or the legacy `auth` alias for a pre-T1 claude row. */
  bundle: string;
  /** Storage key `<ENV>_<accountId>` (or the legacy email-keyed claude key). */
  key: string;
  /** The credential's rotation fingerprint: `workerCredential.mintedAt` for a T1 row, `'legacy'` for
   * a pre-T1 claude row. A re-mint bumps it though the old token still authenticates, so presence
   * needs the peer's verdict AND a delivered-fingerprint match ({@link peerPresentKeys}). */
  fingerprint: string;
}

/** A peer as the plan sees it: its role, reachability, and the keys it is KNOWN to hold. */
export interface ReservedSyncPeer {
  name: string;
  /** `personal`/`desktop` -- receives the account row, never a durable key. */
  headed: boolean;
  reachable: boolean;
  pinned: boolean;
  /** Whether this peer has ever sent a daemon-state reply here (`devices/<peer>/daemon-state.json`
   * exists); without one there is no first-hand knowledge, so it is skipped this tick. */
  hasReply: boolean;
  /** Whether the peer's reply carried an `accounts.rows` array (even if empty). Without the field
   * (older CLI, partial state) there is no first-hand inventory, so the plan skips fail-closed. See
   * {@link SKIP_REASON_NO_ACCOUNT_ROWS}. */
  hasAccountRows: boolean;
  /** bundle -> keys the peer is KNOWN to hold: its own verdict says present AND the fingerprint last
   * delivered matches the current one. Absent means none known. */
  presentKeys: Record<string, ReadonlySet<string>>;
}

type ReservedSyncPlanItem =
  | { action: 'push'; device: string; bundle: string; keys: string[] }
  | { action: 'skip'; device: string; reason: string };

/** Pure plan: for each worker peer, push each bundle it lacks at least one key of; deterministic
 * (sorted). A headed peer is skipped first (never receives a key); a peer with no reply, or no
 * `accounts.rows` (fail-closed), is skipped since nothing is first-hand known of what it holds. */
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

/** Every portable account's durable worker credential as (bundle, key). A T1 row carries
 * `workerCredential`; a pre-T1 claude row falls back to the legacy `auth` bundle keyed by email. */
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

// Per-account presence from the peer's own reply: its daemon-state carries a verdict row per
// account (`accounts.rows`, from `account-state-daemon-service.ts`). The envelope types rows as
// opaque, so we narrow the two fields the planner reads.

/** The subset of a peer's per-account verdict row this planner reads. */
export interface PeerAccountVerdict {
  accountId: string;
  harness: string;
  /** `missing` ⇒ no working credential on the peer; anything else ⇒ present. */
  verdict: string;
}

/** Narrow a peer's opaque `accounts.rows` to the verdict fields the planner reads. */
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

/** True when the peer's reply carried an `accounts.rows` array at all. Its absence (older CLI,
 * partial state) must NOT read as "holds nothing" or the plan would push every key blindly; an
 * EMPTY array IS a valid first-hand "holds nothing". */
export function peerHasAccountRows(state: FleetSharedDeviceState | undefined): boolean {
  return Array.isArray(state?.accounts?.rows);
}

// Publisher-side delivery memo (rotation): a peer's verdict says WHETHER it holds a working
// credential, not WHICH; a re-mint keeps the old token authenticating so the verdict never flips to
// `missing`. The publisher records the fingerprint delivered per (peer, bundle, key).

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
  } catch { /* missing/malformed → empty memo */ }
  return {};
}

function writeDeliveryMemo(memo: Record<string, string>, root = getCacheDir()): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(deliveryMemoPath(root), `${JSON.stringify(memo, null, 2)}\n`, 'utf-8');
}

/** The reserved keys a peer is KNOWN to hold per bundle (PHNX-4116): its own reply reports a
 * non-`missing` verdict, AND the fingerprint last delivered matches the current one, so a
 * re-minted key still propagates. A never-delivered key never matches. */
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
  /** Legacy raw reserved items adopted into their bundle on this box before planning (local repair). */
  adopted: Array<{ bundle: string; key: string }>;
  pushed: Array<{ device: string; bundle: string; keys: string[] }>;
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

interface ReservedStoreSyncDeps {
  listDevices?: () => DeviceProfile[];
  localName?: string;
  userAgentsDir?: string;
  /** Where the publisher-side delivery memo lives; defaults to `getCacheDir()`. */
  cacheDir?: string;
  readMetaFn?: () => Pick<Meta, 'accounts' | 'deviceAccounts'>;
  isPinned?: (name: string) => boolean;
  peerRole?: (name: string) => ReturnType<typeof selfConfiguredDeviceRole>;
  selfRole?: () => ReturnType<typeof selfConfiguredDeviceRole>;
  localReady?: boolean;
  /** Does THIS publisher hold (bundle, key) to push? Defaults to a local bundle read. */
  hasLocalKey?: (bundle: string, key: string) => boolean;
  /** Adopt pre-bundle raw reserved items locally before planning; defaults to `adoptLegacyReservedStoreItems`. */
  adoptLegacy?: (meta: Pick<Meta, 'accounts' | 'deviceAccounts'>) => Promise<{ adopted: Array<{ bundle: string; key: string }>; errors: Array<{ bundle: string; key: string; message: string }> }>;
  push?: (bundle: string, host: string) => Promise<PushBundleResult>;
  sshTarget?: (device: DeviceProfile) => string;
}

function defaultHasLocalKey(bundle: string, key: string): boolean {
  // Reserved-store aware: readReservedCredential reads a `__<harness>__` item
  // directly and a legacy/provider bundle through the normal resolver.
  return readReservedCredential(bundle, key) !== null;
}

/** Push every portable account's reserved store to the worker peers missing it, per key and role.
 * Reuses the election of {@link syncReservedAuthBundle} (one deterministic publisher), so no second
 * scheduler. The daemon runs it each tick. */
export async function syncReservedStores(deps: ReservedStoreSyncDeps = {}): Promise<ReservedStoreSyncResult> {
  const result: ReservedStoreSyncResult = { publisher: null, adopted: [], pushed: [], skipped: [], errors: [] };
  const localName = deps.localName ?? machineId();
  const localNorm = normalizeHost(localName);
  const root = deps.userAgentsDir ?? getUserAgentsDir();
  const meta = (deps.readMetaFn ?? readMeta)();

  // Local repair first: a reserved key written by 1.22.84–1.22.89 is a bare
  // file item with no bundle record, which the push below cannot read. Adopt
  // it into its bundle here so the plan sees it; nothing leaves the box.
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
        // Record the fingerprint delivered so an UNCHANGED key is not re-pushed
        // next tick; a re-mint (new fingerprint) or a removed key (verdict flips
        // `missing`) still re-pushes.
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
  /** Stale slots removed from the device doc (accountId no longer registered). */
  dropped: string[];
  skipped: Array<{ accountId: string; reason: string }>;
  errors: Array<{ accountId: string; message: string }>;
}

interface ReconcileWorkerSlotsDeps {
  selfRole?: ReturnType<typeof selfConfiguredDeviceRole>;
  readMetaFn?: () => Pick<Meta, 'accounts' | 'deviceAccounts'>;
  hasLocalKey?: (bundle: string, key: string) => boolean;
  provision?: (account: NativeAccountRecord) => void;
  /** True when an existing durable slot already carries everything provisioning seeds. */
  slotSeeded?: (harness: AgentId, slotDir: string) => boolean;
  /** Remove stale slot records from the device doc. Default: {@link dropSlots}. */
  dropSlots?: (accountIds: readonly string[]) => void;
  /** Emit an operational log line. Default: the daemon log (fire-and-forget). */
  log?: (level: 'INFO' | 'WARN', message: string) => void;
}

/** Fire-and-forget the daemon log without pulling its module graph into every consumer:
 * `reconcileLocalWorkerSlots` is synchronous and runs only in the daemon, so the dynamic import is
 * paid only on the rare tick that drops a slot. */
function defaultWorkerSlotLog(level: 'INFO' | 'WARN', message: string): void {
  void import('./daemon/daemon.js').then((m) => m.log(level, message)).catch(() => {});
}

function defaultSlotSeeded(harness: AgentId, slotDir: string): boolean {
  return harness === 'claude' ? isClaudeWorkerHomeSeeded(slotDir) : true;
}

/** Worker-side: after a durable key lands, materialize a slot for each portable account whose
 * credential is now local. Only on a NON-headed device (a headed one provisions from an
 * interactive native login, invariant 7). Idempotent. */
export function reconcileLocalWorkerSlots(deps: ReconcileWorkerSlotsDeps = {}): ReconcileWorkerSlotsResult {
  const result: ReconcileWorkerSlotsResult = { provisioned: [], dropped: [], skipped: [], errors: [] };
  // `'selfRole' in deps` (not `??`) so a caller can inject an explicit `undefined`
  // to mean "unmarked device"; a caller that omits it reads the real machine role.
  const role = 'selfRole' in deps ? deps.selfRole : selfConfiguredDeviceRole();
  if (isHeadedDeviceRole(role)) return result; // headed boxes provision via native login
  const meta = (deps.readMetaFn ?? readMeta)();
  const slots = readSlots(meta as Pick<Meta, 'deviceAccounts'>);
  const hasLocalKey = deps.hasLocalKey ?? defaultHasLocalKey;
  const provision = deps.provision ?? provisionWorkerSlot;
  const slotSeeded = deps.slotSeeded ?? defaultSlotSeeded;
  const byId = new Map(listNativeAccounts(meta).map((account) => [account.id, account]));

  // Drop stale worker slots (PHNX-4116) whose accountId is no longer registered: delete the
  // credential, keep the dir (session transcripts). Fail closed on an empty registry, and run only
  // on a device explicitly marked `worker`, never an unmarked one.
  if (role === 'worker' && byId.size > 0) {
    const stale = Object.values(slots).filter((slot) => !byId.has(slot.accountId));
    const droppable: DeviceAccountSlot[] = [];
    for (const slot of stale) {
      try {
        // force ignores an already-absent token; a real failure (EACCES) keeps
        // the slot so the record is never dropped while its credential lingers.
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
  // Resolve each account to the one (bundle, key) the push plan uses: a T1 row's `__<harness>__`
  // key, or the legacy `auth` key by email for a pre-T1 claude row. Both are worker credentials
  // this box may hold, so both get a slot.
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
      // A re-seed that still reads as unseeded is a slot file this box cannot
      // repair (a .claude.json that exists but does not parse is left alone by
      // the seeder). Surface it instead of logging "provisioned" every tick.
      if (reseed && !slotSeeded(account.agent, existing.slotDir)) {
        result.errors.push({ accountId: account.id, message: `slot ${existing.slotDir} is still not fully seeded after re-provisioning; a config file there exists but cannot be parsed` });
        continue;
      }
      result.provisioned.push(account.id);
    } catch (err) { result.errors.push({ accountId: account.id, message: (err as Error).message }); }
  }
  return result;
}
