import * as fs from 'node:fs';
import * as path from 'node:path';
import { deleteBundleSync, deleteKeychainTokenSync, pushBundleToHostAsync, secretsKeychainItem } from './secrets-client.js';
import type { PushBundleResult } from './secrets-types.js';
import { readReservedCredential } from './claude-account-token.js';
import { writeReservedStoreItem } from './auth-mint.js';
import { OWNER_NOTIFY_TOKEN_KEY, canHoldOwnerNotifyToken, ownerNotifyStoreName } from './reserved-stores.js';
import { PhoenixApiError, readSession } from './identity/client.js';
import { listApiTokens, mintDeviceToken, revokeApiToken, type ApiTokenSummary } from './identity/index.js';
import { isDialableDevice, loadDevicesSync, type DeviceProfile } from './devices/registry.js';
import { sshTargetFor } from './devices/connect.js';
import { isDevicePinned, isHostPinned, managedKnownHostsPath } from './devices/known-hosts.js';
import { machineId, normalizeHost } from './machine-id.js';
import { configuredDeviceRole, isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import { readFleetSharedDeviceStates, updateFleetSharedDeviceStateAsync } from './fleet-shared-state.js';
import { getCacheDir, getUserAgentsDir } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';
import { hasUsableDeviceToken } from './owner-notify.js';
import { USAGE_SYNC_INTERVAL_MS } from './accounting/usage-sync.js';

const OWNER_NOTIFY_PUSH_DEADLINE_MS = 20_000;
export const OWNER_NOTIFY_PEER_FRESH_MS = 3 * USAGE_SYNC_INTERVAL_MS;

type Role = ReturnType<typeof selfConfiguredDeviceRole>;

export async function publishOwnerNotifyState(
  opts: { device?: string; userAgentsDir?: string } = {},
): Promise<{ signedIn: boolean; deviceToken: boolean; changed: boolean }> {
  const device = opts.device ?? machineId();
  const signedIn = Boolean(readSession()?.access_token);
  const deviceToken = hasUsableDeviceToken(device);
  const write = await updateFleetSharedDeviceStateAsync(
    device,
    { ownerNotify: { signedIn, deviceToken } },
    opts.userAgentsDir ?? getUserAgentsDir(),
  );
  return { signedIn, deviceToken, changed: write.changed };
}

export function electOwnerNotifyMinter(signedInHeaded: readonly string[]): string | null {
  return [...signedInHeaded].sort((a, b) => normalizeHost(a).localeCompare(normalizeHost(b)))[0] ?? null;
}

interface OwnerNotifySyncResult {
  minter: string | null;
  minted: string[];
  pushed: string[];
  revoked: string[];
  skipped: Array<{ device: string; reason: string }>;
  errors: Array<{ device: string; message: string }>;
}

interface OwnerNotifySyncDeps {
  localName?: string;
  userAgentsDir?: string;
  cacheDir?: string;
  listDevices?: () => DeviceProfile[];
  selfRole?: () => Role;
  peerRole?: (name: string) => Role;
  isPinned?: (name: string) => boolean;
  push?: (bundle: string, host: string) => Promise<PushBundleResult>;
  sshTarget?: (device: DeviceProfile) => string;
  now?: () => number;
}

function memoPath(root: string): string {
  return path.join(root, 'owner-notify-minted.json');
}

interface MintedToken {
  id: string;
  pushedAt?: number;
  rejected?: number;
}

export const OWNER_NOTIFY_REJECT_BACKOFF_AFTER = 3;
export const OWNER_NOTIFY_REJECT_BACKOFF_MS = 6 * 60 * 60 * 1000;

type Memo = Record<string, MintedToken>;

function readMemo(root: string): Memo {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoPath(root), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter((e): e is [string, MintedToken] => typeof (e[1] as MintedToken | null)?.id === 'string'));
    }
  } catch {  }
  return {};
}

function writeMemo(root: string, memo: Memo): void {
  fs.mkdirSync(root, { recursive: true });
  atomicWriteFileSync(memoPath(root), `${JSON.stringify(memo, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

export async function syncOwnerNotifyTokens(deps: OwnerNotifySyncDeps = {}): Promise<OwnerNotifySyncResult> {
  const result: OwnerNotifySyncResult = { minter: null, minted: [], pushed: [], revoked: [], skipped: [], errors: [] };
  const localName = deps.localName ?? machineId();
  const localNorm = normalizeHost(localName);
  const selfRole = (deps.selfRole ?? selfConfiguredDeviceRole)();
  if (!isHeadedDeviceRole(selfRole) || !readSession()?.access_token) return result;

  const devices = (deps.listDevices ?? (() => Object.values(loadDevicesSync())))()
    .filter((d) => normalizeHost(d.name) !== localNorm);
  const roles = new Map(devices.map((d) => {
    try {
      return [d.name, (deps.peerRole ?? configuredDeviceRole)(d.name)] as const;
    } catch {
      return [d.name, undefined] as const;
    }
  }));
  const peerRole = (name: string): Role => roles.get(name);
  const read = readFleetSharedDeviceStates(deps.userAgentsDir ?? getUserAgentsDir());
  result.errors.push(...read.errors);
  const stateByDevice = new Map(read.states.map((s) => [normalizeHost(s.device), s]));

  const now = (deps.now ?? Date.now)();
  const signedInHeaded = [localName, ...devices
    .filter((d) => {
      const state = stateByDevice.get(normalizeHost(d.name));
      return isHeadedDeviceRole(peerRole(d.name))
        && state?.ownerNotify?.signedIn === true
        && state.receivedAt !== undefined
        && now - state.receivedAt <= OWNER_NOTIFY_PEER_FRESH_MS;
    })
    .map((d) => d.name)];
  result.minter = electOwnerNotifyMinter(signedInHeaded);
  const workers = devices.filter((d) => peerRole(d.name) === 'worker');

  const cacheDir = deps.cacheDir ?? getCacheDir();
  const memo = readMemo(cacheDir);
  if (devices.length === 0 || [...roles.values()].some((r) => r === undefined)) {
    result.skipped.push({ device: localName, reason: 'stale-token revocation needs a device registry with every role readable' });
  } else {
    const workerNames = new Set(workers.map((w) => normalizeHost(w.name)));
    for (const [name, minted] of Object.entries(memo).filter(([n]) => !workerNames.has(n))) {
      try {
        await revokeOwnerNotifyToken(name, minted.id, memo);
        result.revoked.push(name);
      } catch (err) {
        result.errors.push({ device: name, message: `revoke token of a device that is no longer a worker: ${(err as Error).message}` });
      }
    }
    if (result.revoked.length > 0) writeMemo(cacheDir, memo);
  }

  if (normalizeHost(result.minter ?? '') !== localNorm) {
    for (const d of workers) result.skipped.push({ device: d.name, reason: `${result.minter} mints owner-notify tokens` });
    return result;
  }

  const pinned = deps.isPinned ?? ((name: string) => isHostPinned(name, managedKnownHostsPath()));
  const push = deps.push ?? ((bundle: string, host: string) => pushBundleToHostAsync(bundle, host, {
    remoteBackend: 'file', operation: 'owner-notify-sync', agentOnly: true, timeoutMs: OWNER_NOTIFY_PUSH_DEADLINE_MS,
  }));
  const sshTarget = deps.sshTarget ?? sshTargetFor;

  let tokens: ApiTokenSummary[];
  try {
    tokens = (await listApiTokens()).filter((t) => t.kind === 'device' && t.device !== null && t.scopes.includes('notify'));
  } catch (err) {
    result.errors.push({ device: localName, message: `list device tokens: ${(err as Error).message}` });
    return result;
  }

  for (const worker of workers) {
    const name = normalizeHost(worker.name);
    const store = ownerNotifyStoreName(name);
    const peer = stateByDevice.get(name);
    const peerState = peer?.ownerNotify;
    if (!peerState) { result.skipped.push({ device: worker.name, reason: 'no owner-notify state from this peer yet' }); continue; }
    if (!isDialableDevice(worker)) { result.skipped.push({ device: worker.name, reason: 'unreachable' }); continue; }
    if (!isDevicePinned(worker, pinned)) {
      result.skipped.push({ device: worker.name, reason: `host key not pinned; run \`agents ssh ${worker.name}\` once` });
      continue;
    }
    if (peerState.deviceToken) {
      if (memo[name]?.rejected) {
        memo[name] = { ...memo[name], rejected: 0 };
        writeMemo(cacheDir, memo);
      }
      result.skipped.push({ device: worker.name, reason: 'token present' });
      continue;
    }
    let onServer = tokens.find((t) => normalizeHost(t.device!) === name);
    const held = memo[name];
    try {
      const holdsLive = onServer !== undefined && held?.id === onServer.id
        && readReservedCredential(store, OWNER_NOTIFY_TOKEN_KEY) !== null;
      if (holdsLive && held.pushedAt !== undefined && (peer?.receivedAt ?? 0) <= held.pushedAt) {
        result.skipped.push({ device: worker.name, reason: 'waiting for the worker to report the pushed token' });
        continue;
      }
      const rejectedSoFar = held?.rejected ?? 0;
      if (rejectedSoFar >= OWNER_NOTIFY_REJECT_BACKOFF_AFTER && held?.pushedAt !== undefined
        && now - held.pushedAt < OWNER_NOTIFY_REJECT_BACKOFF_MS) {
        result.skipped.push({
          device: worker.name,
          reason: `worker rejected ${rejectedSoFar} pushed tokens in a row; next attempt after ${new Date(held.pushedAt + OWNER_NOTIFY_REJECT_BACKOFF_MS).toISOString()}`,
        });
        continue;
      }
      const rejected = holdsLive && held.pushedAt !== undefined ? rejectedSoFar + 1 : rejectedSoFar;
      if (onServer && !(holdsLive && held.pushedAt === undefined)) {
        await revokeApiToken(onServer.id);
        onServer = undefined;
      }
      if (!onServer) {
        const minted = await mintDeviceToken(name, ['notify']);
        try {
          writeReservedStoreItem(
            store,
            OWNER_NOTIFY_TOKEN_KEY,
            minted.token,
            `Owner-notify device token for ${name} (scope notify); pushed only to that worker by the daemon.`,
          );
        } catch (err) {
          await revokeApiToken(minted.id);
          throw err;
        }
        memo[name] = { id: minted.id, rejected };
        writeMemo(cacheDir, memo);
        result.minted.push(worker.name);
      }
      const out = await push(store, sshTarget(worker));
      if (out.ok) {
        memo[name] = { ...memo[name], pushedAt: now };
        writeMemo(cacheDir, memo);
        result.pushed.push(worker.name);
      } else {
        result.errors.push({ device: worker.name, message: out.message });
      }
    } catch (err) {
      result.errors.push({ device: worker.name, message: (err as Error).message });
    }
  }
  return result;
}

async function revokeOwnerNotifyToken(name: string, id: string, memo: Memo): Promise<void> {
  try {
    await revokeApiToken(id);
  } catch (err) {
    if (!(err instanceof PhoenixApiError && err.status === 404)) throw err;
  }
  if (memo[name]?.id === id) {
    delete memo[name];
    if (canHoldOwnerNotifyToken(name)) {
      const store = ownerNotifyStoreName(name);
      deleteKeychainTokenSync(secretsKeychainItem(store, OWNER_NOTIFY_TOKEN_KEY));
      deleteBundleSync(store);
    }
  }
}

export async function revokeMintedOwnerNotifyTokens(
  cacheDir = getCacheDir(),
): Promise<{ revoked: string[]; errors: Array<{ device: string; message: string }> }> {
  const out = { revoked: [] as string[], errors: [] as Array<{ device: string; message: string }> };
  const memo = readMemo(cacheDir);
  for (const [name, { id }] of Object.entries(memo)) {
    try {
      await revokeOwnerNotifyToken(name, id, memo);
      out.revoked.push(name);
    } catch (err) {
      out.errors.push({ device: name, message: (err as Error).message });
    }
  }
  if (Object.keys(memo).length > 0 || out.revoked.length > 0) writeMemo(cacheDir, memo);
  return out;
}
