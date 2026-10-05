/** Reusable device discovery. `agents devices sync` was the only registry populator, so the
 * registry sat empty; this extracts the ingest so `agents sync` and `agents setup` trigger it, and
 * exposes the pending diff. Soft mode returns `ok: false`, never aborting setup/sync. */
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

/** The login user to stamp onto newly-synced devices. Tailscale status has the node's OS and
 * address but not the ssh account, so use the local operator's username. Pinning it makes
 * `--device <device>` dial that account from any machine. */
export function localLoginUser(): string | undefined {
  let u: string | undefined;
  try {
    u = os.userInfo().username;
  } catch {
    u = process.env.USER || process.env.USERNAME || undefined;
  }
  return sanitizeLoginUser(u);
}

/** Reduce a raw OS username to a safe ssh account, or undefined. Windows reports `COMPUTER\user` /
 * `DOMAIN\user`; strip to the name after the backslash, else `\` fails the charset guard and
 * Windows boxes never pin a user. Pure. */
export function sanitizeLoginUser(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const bare = raw.includes('\\') ? raw.slice(raw.lastIndexOf('\\') + 1) : raw;
  return /^[a-zA-Z0-9._-]+$/.test(bare) ? bare : undefined;
}

/** Fill in a device's login user during sync without clobbering a pinned account. Precedence:
 * existing registered user, then the local operator's username, else unset (ssh's implicit default
 * applies). Pure. */
export function withDefaultUser(
  input: DeviceInput,
  prevUser: string | undefined,
  localUser: string | undefined,
): DeviceInput {
  if (input.user || prevUser || !localUser) return input;
  return { ...input, user: localUser };
}

/** bootstrap: register every non-ignored node (opt-out), for first-run `agents setup` and manual
 * `agents devices sync`. refresh: only refresh reachability of registered nodes; a new node is
 * surfaced as `pending` for approval (opt-in). Autosync and the daemon probe use this. */
type DeviceSyncMode = 'bootstrap' | 'refresh';

interface DeviceSyncResult {
  /** False when discovery could not run (e.g. tailscale absent) in soft mode. */
  ok: boolean;
  /** Number of tailscale nodes upserted into the registry. */
  synced: number;
  /** Names upserted, for explicit onboarding surfaces to persist approval. */
  syncedNames: string[];
  /** Nodes discovered but neither registered-before nor ignored (name+platform). */
  pending: PendingDevice[];
  /** Populated when ok is false: why discovery was skipped. */
  reason?: string;
}

/** The nodes automatic discovery may see: sharee nodes (shared into the tailnet by another user)
 * are not the operator's machines and are never bootstrap-registered or surfaced as pending.
 * Explicit paths (`devices register`, `devices add`, `fleet:` bootstrap) stay unfiltered. Pure. */
export function discoverableNodes(nodes: TailscaleNode[]): TailscaleNode[] {
  return nodes.filter((n) => !n.sharee);
}

/** Default checked-state for a node in the interactive sync picker. Enter registers every checked
 * node, so "checked" means "auto-sync would register this": not dismissed, not a sharee node
 * unless the user already registered it, in which case Enter keeps the fleet as-is. Pure. */
export function defaultPickerChecked(
  node: TailscaleNode,
  registered: Set<string>,
  ignored: Set<string>,
): boolean {
  return !ignored.has(node.name) && (!node.sharee || registered.has(node.name));
}

/** Node names on the tailnet that are neither in the registry nor on the ignore-list: genuinely new
 * devices worth surfacing. Pure. */
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

/** Which discovered nodes to upsert this run, the mode-defining decision (pure). Ignored nodes are
 * always skipped; `refresh` also skips unregistered nodes (they stay pending); `bootstrap`
 * includes every non-ignored node. */
export function selectNodesToUpsert(
  nodes: TailscaleNode[],
  registered: Set<string>,
  ignored: Set<string>,
  mode: DeviceSyncMode,
): TailscaleNode[] {
  return nodes.filter((n) => {
    if (ignored.has(n.name)) return false;
    if (mode === 'refresh' && !registered.has(n.name)) return false;
    return true;
  });
}

/** Ingest `tailscale status --json` into the registry. Soft mode resolves a missing binary or
 * unreachable daemon to `{ ok: false }` so callers in setup/sync never abort. `pending` is
 * computed against the registry before this sync: not previously registered and not ignored. */
export async function runDeviceSync(
  opts: { soft?: boolean; mode?: DeviceSyncMode } = {},
): Promise<DeviceSyncResult> {
  const mode: DeviceSyncMode = opts.mode ?? 'bootstrap';
  // Soft mode must be non-fatal for any failure, not just missing tailscale: a corrupted
  // registry/ignore file (both throw by design), a disk error, or lock contention (many agents
  // autosyncing one host) would abort `agents sync`. The whole body is inside the guard.
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
    if (opts.soft) {
      return { ok: false, synced: 0, syncedNames: [], pending: [], reason: err?.message ?? String(err) };
    }
    throw err;
  }
}

interface EnsureDevicesResult {
  /** Names newly resolved from Tailscale and upserted into the registry. */
  registered: string[];
  /** Names that could not be resolved (not on the tailnet / tailscale absent). */
  unresolved: string[];
}

/** Pure decision for `ensureDevicesRegistered`: split wanted names into those to resolve and
 * register (missing, on the tailnet, not ignored) versus unresolved (missing and off-tailnet or
 * ignored). Registered names need nothing. */
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

/** Fresh-machine bootstrap for `agents apply`: register any device a `fleet:` manifest wants that
 * is missing locally by resolving it live from Tailscale, so a names-only `agents.yaml` rebuilds
 * its roster. Soft: no tailscale or an offline name yields `unresolved`, never a throw. */
export async function ensureDevicesRegistered(wantedNames: string[]): Promise<EnsureDevicesResult> {
  const registryBefore = await loadDevices();
  const registered = new Set(Object.keys(registryBefore));
  const missing = wantedNames.filter((n) => !registered.has(n));
  if (missing.length === 0) return { registered: [], unresolved: [] };

  let nodes: TailscaleNode[];
  try {
    nodes = parseTailscaleStatus(tailscaleStatusJson());
  } catch {
    // Tailscale absent/unreachable — nothing resolvable; report all missing.
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

/** The register/remove/ignore decision for the interactive curation picker; pure because it is the
 * highest-risk reconcile logic. `keep` is what the user left checked. Checked registers (and
 * un-ignores); unchecked removes from the registry and ignores so auto-sync never re-adds it. */
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
