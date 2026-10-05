import * as os from 'os';
import {
  loadDevices,
  loadIgnored,
  upsertDevice,
  type DeviceInput,
} from './registry.js';
import {
  nodeToDeviceInput,
  parseTailscaleStatus,
  tailscaleStatusJson,
  type TailscaleNode,
} from './tailscale.js';
import type { PendingDevice } from './pending.js';

export function localLoginUser(): string | undefined {
  let u: string | undefined;
  try {
    u = os.userInfo().username;
  } catch {
    u = process.env.USER || process.env.USERNAME || undefined;
  }
  return sanitizeLoginUser(u);
}

export function sanitizeLoginUser(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const bare = raw.includes('\\') ? raw.slice(raw.lastIndexOf('\\') + 1) : raw;
  return /^[a-zA-Z0-9._-]+$/.test(bare) ? bare : undefined;
}

export function withDefaultUser(
  input: DeviceInput,
  prevUser: string | undefined,
  localUser: string | undefined,
): DeviceInput {
  // Discovery may supply a default, but it never overwrites an explicit or previously pinned SSH user.
  if (input.user || prevUser || !localUser) return input;
  return { ...input, user: localUser };
}

type DeviceSyncMode = 'bootstrap' | 'refresh';

interface DeviceSyncResult {
  ok: boolean;
  synced: number;
  syncedNames: string[];
  pending: PendingDevice[];
  reason?: string;
}

export function discoverableNodes(nodes: TailscaleNode[]): TailscaleNode[] {
  // Shared ingress nodes are never implicit fleet machines.
  return nodes.filter((n) => !n.sharee);
}

export function defaultPickerChecked(
  node: TailscaleNode,
  registered: Set<string>,
  ignored: Set<string>,
): boolean {
  return !ignored.has(node.name) && (!node.sharee || registered.has(node.name));
}

export function computePendingDevices(
  nodes: TailscaleNode[],
  registered: Iterable<string>,
  ignored: Iterable<string>,
): string[] {
  const known = new Set<string>(registered);
  const skip = new Set<string>(ignored);
  return nodes
    .map((n) => n.name)
    .filter((name) => !known.has(name) && !skip.has(name));
}

export function selectNodesToUpsert(
  nodes: TailscaleNode[],
  registered: Set<string>,
  ignored: Set<string>,
  mode: DeviceSyncMode,
): TailscaleNode[] {
  // Bootstrap may enroll own-tailnet peers; refresh may only update routes already in the registry.
  return nodes.filter((n) => {
    if (ignored.has(n.name)) return false;
    if (mode === 'refresh' && !registered.has(n.name)) return false;
    return true;
  });
}

export async function runDeviceSync(
  opts: { soft?: boolean; mode?: DeviceSyncMode } = {},
): Promise<DeviceSyncResult> {
  const mode: DeviceSyncMode = opts.mode ?? 'bootstrap';
  try {
    const nodes = discoverableNodes(parseTailscaleStatus(tailscaleStatusJson()));
    const [registeredBefore, ignored] = await Promise.all([loadDevices(), loadIgnored()]);
    const registered = new Set(Object.keys(registeredBefore));
    const pendingNames = computePendingDevices(nodes, registered, ignored);
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const pending: PendingDevice[] = pendingNames.map((name) => ({
      name,
      platform: byName.get(name)?.platform ?? 'unknown',
    }));

    const toUpsert = selectNodesToUpsert(nodes, registered, ignored, mode);
    const localUser = localLoginUser();
    for (const node of toUpsert) {
      const input = withDefaultUser(nodeToDeviceInput(node), registeredBefore[node.name]?.user, localUser);
      await upsertDevice(node.name, input);
    }

    return { ok: true, synced: toUpsert.length, syncedNames: toUpsert.map((node) => node.name), pending };
  } catch (err: any) {
    // Daemon callers request soft mode so every discovery or registry failure is contained in the result.
    if (opts.soft) {
      return { ok: false, synced: 0, syncedNames: [], pending: [], reason: err?.message ?? String(err) };
    }
    throw err;
  }
}

interface EnsureDevicesResult {
  registered: string[];
  unresolved: string[];
}

interface WantedPartition {
  toRegister: string[];
  unresolved: string[];
}

export function partitionWantedDevices(
  wanted: string[],
  registered: Set<string>,
  tailscaleNames: Set<string>,
  ignored: Set<string>,
): WantedPartition {
  const out: WantedPartition = { toRegister: [], unresolved: [] };
  for (const name of wanted) {
    if (registered.has(name)) continue;
    if (tailscaleNames.has(name) && !ignored.has(name)) out.toRegister.push(name);
    else out.unresolved.push(name);
  }
  return out;
}

export async function ensureDevicesRegistered(wantedNames: string[]): Promise<EnsureDevicesResult> {
  // Apply resolves missing approved routes from live Tailscale state instead of persisting connection details.
  const registryBefore = await loadDevices();
  const registered = new Set(Object.keys(registryBefore));
  const missing = wantedNames.filter((n) => !registered.has(n));
  if (missing.length === 0) return { registered: [], unresolved: [] };

  let nodes: TailscaleNode[];
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch {
    return { registered: [], unresolved: missing };
  }

  const ignored = await loadIgnored();
  const tailscaleNames = new Set(nodes.map((n) => n.name));
  const { toRegister, unresolved } = partitionWantedDevices(missing, registered, tailscaleNames, ignored);

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const localUser = localLoginUser();
  const done: string[] = [];
  for (const name of toRegister) {
    const input = withDefaultUser(nodeToDeviceInput(byName.get(name)!), registryBefore[name]?.user, localUser);
    await upsertDevice(name, input);
    done.push(name);
  }
  return { registered: done, unresolved };
}

interface DeviceReconciliation {
  toRegister: string[];
  toUnignore: string[];
  toRemove: string[];
  toIgnore: string[];
}

export function planDeviceReconciliation(
  allNames: Iterable<string>,
  keep: Iterable<string>,
  registered: Iterable<string>,
  ignored: Iterable<string>,
): DeviceReconciliation {
  const keepSet = new Set(keep);
  const regSet = new Set(registered);
  const ignSet = new Set(ignored);
  const out: DeviceReconciliation = { toRegister: [], toUnignore: [], toRemove: [], toIgnore: [] };
  for (const name of allNames) {
    if (keepSet.has(name)) {
      out.toRegister.push(name);
      if (ignSet.has(name)) out.toUnignore.push(name);
    } else {
      if (regSet.has(name)) out.toRemove.push(name);
      out.toIgnore.push(name);
    }
  }
  return out;
}
