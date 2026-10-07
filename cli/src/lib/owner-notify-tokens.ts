/**
 * Worker device tokens for owner notifications (PHNX-4267).
 *
 * A worker holds no Phoenix session, so a signed-in headed box mints one
 * `notify`-scoped device token per `role=worker` peer and pushes it through the
 * ordinary reserved-store bundle push into `__notify-<worker>__`. The token is
 * durable, non-rotating, revocable per device, and can call nothing but the
 * three owner-notify routes (credential-management.md invariant 3). It never
 * reaches a headed peer (invariant 7).
 *
 * Exactly one headed box mints, because minting for a device replaces that
 * device's previous token server-side: two minters would revoke each other.
 * The minter is the first signed-in headed device by name (each box publishes
 * `ownerNotify.signedIn` in its daemon-state envelope), and it never replaces a
 * token another box minted. Revoking a token from the account frees the slot,
 * and the next tick mints a fresh one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pushBundleToHostAsync } from './secrets-client.js';
import type { PushBundleResult } from './secrets-types.js';
import { readReservedCredential } from './claude-account-token.js';
import { writeReservedStoreItem } from './auth-mint.js';
import { OWNER_NOTIFY_TOKEN_KEY, ownerNotifyStoreName } from './reserved-stores.js';
import { readSession } from './identity/client.js';
import { listApiTokens, mintDeviceToken, type ApiTokenSummary } from './identity/index.js';
import { isDialableDevice, loadDevicesSync, type DeviceProfile } from './devices/registry.js';
import { sshTargetFor } from './devices/connect.js';
import { isDevicePinned, isHostPinned, managedKnownHostsPath } from './devices/known-hosts.js';
import { machineId, normalizeHost } from './machine-id.js';
import { configuredDeviceRole, isHeadedDeviceRole, selfConfiguredDeviceRole } from './device-config.js';
import { readFleetSharedDeviceStates, updateFleetSharedDeviceStateAsync } from './fleet-shared-state.js';
import { getCacheDir, getUserAgentsDir } from './state.js';

const OWNER_NOTIFY_PUSH_DEADLINE_MS = 20_000;

type Role = ReturnType<typeof selfConfiguredDeviceRole>;

export async function publishOwnerNotifyState(
  opts: { device?: string; userAgentsDir?: string } = {},
): Promise<{ signedIn: boolean; deviceToken: boolean; changed: boolean }> {
  const device = opts.device ?? machineId();
  const signedIn = Boolean(readSession()?.access_token);
  const deviceToken = readReservedCredential(ownerNotifyStoreName(normalizeHost(device)), OWNER_NOTIFY_TOKEN_KEY) !== null;
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
}

function memoPath(root: string): string {
  return path.join(root, 'owner-notify-minted.json');
}

function readMemo(root: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(memoPath(root), 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch {  }
  return {};
}

function writeMemo(root: string, memo: Record<string, string>): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(memoPath(root), `${JSON.stringify(memo, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

export async function syncOwnerNotifyTokens(deps: OwnerNotifySyncDeps = {}): Promise<OwnerNotifySyncResult> {
  const result: OwnerNotifySyncResult = { minter: null, minted: [], pushed: [], skipped: [], errors: [] };
  const localName = deps.localName ?? machineId();
  const localNorm = normalizeHost(localName);
  const selfRole = (deps.selfRole ?? selfConfiguredDeviceRole)();
  const peerRole = deps.peerRole ?? configuredDeviceRole;
  if (!isHeadedDeviceRole(selfRole) || !readSession()?.access_token) return result;

  const devices = (deps.listDevices ?? (() => Object.values(loadDevicesSync())))()
    .filter((d) => normalizeHost(d.name) !== localNorm);
  const read = readFleetSharedDeviceStates(deps.userAgentsDir ?? getUserAgentsDir());
  result.errors.push(...read.errors);
  const stateByDevice = new Map(read.states.map((s) => [normalizeHost(s.device), s]));

  const signedInHeaded = [localName, ...devices
    .filter((d) => isHeadedDeviceRole(peerRole(d.name)) && stateByDevice.get(normalizeHost(d.name))?.ownerNotify?.signedIn === true)
    .map((d) => d.name)];
  result.minter = electOwnerNotifyMinter(signedInHeaded);
  const workers = devices.filter((d) => peerRole(d.name) === 'worker');
  if (normalizeHost(result.minter ?? '') !== localNorm) {
    for (const d of workers) result.skipped.push({ device: d.name, reason: `${result.minter} mints owner-notify tokens` });
    return result;
  }

  const cacheDir = deps.cacheDir ?? getCacheDir();
  const memo = readMemo(cacheDir);
  const pinned = deps.isPinned ?? ((name: string) => isHostPinned(name, managedKnownHostsPath()));
  const push = deps.push ?? ((bundle: string, host: string) => pushBundleToHostAsync(bundle, host, {
    remoteBackend: 'file', operation: 'owner-notify-sync', agentOnly: true, timeoutMs: OWNER_NOTIFY_PUSH_DEADLINE_MS,
  }));
  const sshTarget = deps.sshTarget ?? sshTargetFor;

  let tokens: ApiTokenSummary[];
  try {
    tokens = (await listApiTokens()).filter((t) => t.kind === 'device');
  } catch (err) {
    result.errors.push({ device: localName, message: `list device tokens: ${(err as Error).message}` });
    return result;
  }

  for (const worker of workers) {
    const name = normalizeHost(worker.name);
    const peerState = stateByDevice.get(name)?.ownerNotify;
    if (!peerState) { result.skipped.push({ device: worker.name, reason: 'no owner-notify state from this peer yet' }); continue; }
    if (!isDialableDevice(worker)) { result.skipped.push({ device: worker.name, reason: 'unreachable' }); continue; }
    if (!isDevicePinned(worker, pinned)) {
      result.skipped.push({ device: worker.name, reason: `host key not pinned; run \`agents ssh ${worker.name}\` once` });
      continue;
    }
    const onServer = tokens.find((t) => t.device !== null && normalizeHost(t.device) === name);
    if (onServer && memo[name] !== onServer.id) {
      result.skipped.push({ device: worker.name, reason: 'its token was minted by another device' });
      continue;
    }
    if (onServer && peerState.deviceToken) { result.skipped.push({ device: worker.name, reason: 'token present' }); continue; }
    try {
      if (!onServer) {
        const minted = await mintDeviceToken(name, ['notify']);
        writeReservedStoreItem(
          ownerNotifyStoreName(name),
          OWNER_NOTIFY_TOKEN_KEY,
          minted.token,
          `Owner-notify device token for ${name} (scope notify); pushed only to that worker by the daemon.`,
        );
        memo[name] = minted.id;
        writeMemo(cacheDir, memo);
        result.minted.push(worker.name);
      }
      const out = await push(ownerNotifyStoreName(name), sshTarget(worker));
      if (out.ok) result.pushed.push(worker.name);
      else result.errors.push({ device: worker.name, message: out.message });
    } catch (err) {
      result.errors.push({ device: worker.name, message: (err as Error).message });
    }
  }
  return result;
}
