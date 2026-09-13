/**
 * Reusable device discovery.
 *
 * `agents devices sync` was the only thing that ever populated the registry,
 * and it was purely user-invoked — so the registry sat empty until someone
 * remembered to run it. This module extracts the ingest so it can be triggered
 * automatically (from `agents sync` and `agents setup`) without duplicating the
 * tailscale-parse-and-upsert loop, and exposes the pure pending-device diff the
 * curation picker and the menu-bar probe both need.
 *
 * Two failure modes, one function:
 *   - hard (default): the CLI `agents devices sync` action wants a clear error
 *     and a non-zero exit when tailscale is missing.
 *   - soft (`soft: true`): auto-callers must never abort setup/sync because a
 *     machine has no tailscale — they get a result with `ok: false` instead.
 */
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

/**
 * The login user to stamp onto newly-synced devices. Tailscale status carries a
 * node's OS and address but NOT the account you ssh in as, so we materialize the
 * local operator's username — tailnet devices are overwhelmingly one person's
 * boxes, and this is exactly the account ssh would already fall back to. Pinning
 * it in the registry makes `--device <device>` dial that account no matter which
 * machine launches the fan-out (a peer whose local user differs otherwise dials
 * the wrong account). Returns undefined when the username isn't a safe ssh
 * identifier, so a weird value never lands in the registry. */
export function localLoginUser(): string | undefined {
  let u: string | undefined;
  try {
    u = os.userInfo().username;
  } catch {
    u = process.env.USER || process.env.USERNAME || undefined;
  }
  return sanitizeLoginUser(u);
}

/**
 * Reduce a raw OS username to a safe ssh account, or undefined. Windows reports
 * the login as `COMPUTER\user` / `DOMAIN\user`; the ssh account is the bare name
 * after the backslash — without this strip the `\` fails the charset guard and
 * Windows boxes never pin a user. Pure, so the platform-specific munging is
 * unit-tested without reading the real OS user. */
export function sanitizeLoginUser(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const bare = raw.includes('\\') ? raw.slice(raw.lastIndexOf('\\') + 1) : raw;
  return /^[a-zA-Z0-9._-]+$/.test(bare) ? bare : undefined;
}

/**
 * Fill in a device's login user during sync WITHOUT ever clobbering an account
 * the user pinned. Precedence: an existing registered user wins; else the local
 * operator's username; else leave it unset (ssh's implicit local default still
 * applies). Pure so the "never overwrite an explicit user" guard is unit-tested
 * without a tailnet. */
export function withDefaultUser(
  input: DeviceInput,
  prevUser: string | undefined,
  localUser: string | undefined,
): DeviceInput {
  if (input.user || prevUser || !localUser) return input;
  return { ...input, user: localUser };
}

/**
 * bootstrap — register every non-ignored node (opt-out). First-run `agents
 *   setup` and manual `agents devices sync`, so the fleet is usable out of box.
 * refresh — only refresh reachability of already-registered nodes; a brand-new
 *   node is NOT auto-added, it is surfaced as `pending` for the user to approve
 *   (opt-in). Ongoing autosync and the daemon probe use this, so newcomers flow
 *   through the menu-bar "NEW DEVICES → Register / Ignore" gate instead of
 *   silently landing in the registry.
 */
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

/**
 * The nodes automatic discovery is allowed to see: sharee nodes (shared INTO
 * the tailnet by another user, e.g. a funnel ingress relay) are not the
 * operator's machines, so they must never be bootstrap-registered nor surfaced
 * as pending. Explicit paths (`devices register <name>`, `devices add`, the
 * `fleet:` manifest bootstrap) are deliberate user actions and stay unfiltered.
 * Pure so the policy is unit-testable without a tailnet.
 */
export function discoverableNodes(nodes: TailscaleNode[]): TailscaleNode[] {
  return nodes.filter((n) => !n.sharee);
}

/**
 * Default checked-state for a node in the interactive sync picker. Pressing
 * Enter registers every checked node, so "checked" must mean "auto-sync would
 * register this": not dismissed, and not a sharee node — unless the user
 * already deliberately registered that sharee node, in which case Enter must
 * keep the fleet as-is. Pure so the default matrix is unit-testable without a
 * prompt.
 */
export function defaultPickerChecked(
  node: TailscaleNode,
  registered: Set<string>,
  ignored: Set<string>,
): boolean {
  return !ignored.has(node.name) && (!node.sharee || registered.has(node.name));
}

/**
 * Node names present on the tailnet but neither already in the registry nor on
 * the ignore-list — i.e. genuinely new devices worth surfacing. Pure so the
 * flag matrix is unit-testable without a live tailnet.
 */
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

/**
 * Which discovered nodes to upsert this run — the mode-defining decision, pure
 * so it is unit-testable without a tailnet. Ignored nodes are always skipped.
 * In `refresh` mode a node that isn't already registered is skipped too (it
 * stays pending for approval); `bootstrap` includes every non-ignored node.
 */
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

/**
 * Ingest `tailscale status --json` into the registry. In soft mode a missing
 * tailscale binary / unreachable daemon resolves to `{ ok: false }` instead of
 * throwing, so callers wiring this into setup/sync never abort the whole run.
 * The `pending` list is computed against the registry state BEFORE this sync so
 * "new" means "not previously registered and not ignored".
 */
export async function runDeviceSync(
  opts: { soft?: boolean; mode?: DeviceSyncMode } = {},
): Promise<DeviceSyncResult> {
  const mode: DeviceSyncMode = opts.mode ?? 'bootstrap';
  // Soft mode must be non-fatal for ANY failure, not just a missing tailscale:
  // a corrupted registry/ignore file (both throw by design), a disk error, or
  // registry lock contention (plausible when many agents SessionStart-autosync
  // the same host at once) would otherwise abort the whole `agents sync`. The
  // whole body is inside the guard so the "never a sync failure" promise holds.
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

/**
 * Pure decision for `ensureDevicesRegistered`: split the wanted names into those
 * to resolve+register (missing from the registry, present on the tailnet, not
 * ignored) vs. unresolved (missing and either off-tailnet or ignored). Already-
 * registered names need nothing. Pure so the bootstrap's filter matrix is
 * unit-testable without a tailnet or registry writes.
 */
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

/**
 * Fresh-machine bootstrap for `agents apply`: given the device names a `fleet:`
 * manifest wants, register any that aren't in the local registry by resolving
 * them LIVE from Tailscale — so a freshly-cloned `agents.yaml` (which carries
 * names only, never IPs/usernames) reconstructs its roster with zero committed
 * connection details. Soft by design: a missing tailscale binary or an offline
 * name yields `unresolved` rather than throwing, so `apply` degrades to "these
 * devices aren't reachable yet" instead of aborting. Reuses the same
 * parse→withDefaultUser→upsert path as `runDeviceSync`, so a bootstrapped device
 * is identical to a synced one.
 */
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

/**
 * The register/remove/ignore decision for the interactive curation picker.
 * Pure so the highest-risk reconcile logic is unit-testable without a tailnet
 * or a live prompt. `keep` is the set the user left checked; everything else is
 * dismissed. Checked => register (and un-ignore if it was ignored). Unchecked
 * => remove from the registry if it was there, and ignore it so auto-sync never
 * re-adds it.
 */
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
