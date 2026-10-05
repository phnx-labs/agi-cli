/** Device registry: persistent SSH device profiles at ~/.agents/.history/devices/registry.json
 * (platform, login user, address, auth). Per-machine runtime state like the team registry, so it
 * lives under .history/ and is not pushed by `agents repo push`. */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { getDevicesRegistryPath, readMeta, updateMeta } from '../state.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { machineId } from '../machine-id.js';
import type { Meta } from '../types.js';
import type { IgnoredDeviceEntry } from '../fleet/types.js';
import { addIgnoredEntry, unionDeviceIgnored } from './device-docs.js';
import { logAndContinueOnLockCompromised } from '../lock-compromise.js';
import { removeStatsCacheEntry } from './stats-cache.js';

/** Operating-system family of a device, used to pick the remote shell. */
export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'unknown';

/** Remote shell dialect derived from the platform. */
export type DeviceShell = 'powershell' | 'posix';

/** How `agents ssh` authenticates to a device. Both are first-class, fully
 * non-interactive: `key` uses the ssh agent / on-disk keys, `password` pulls
 * the secret from a Keychain-backed secrets bundle via an askpass shim. */
export type DeviceAuthMethod = 'key' | 'password';

/** How to reach a device on the network. */
export interface DeviceAddress {
  /** Where the address came from: a Tailscale node, or a manual entry. */
  via: 'tailscale' | 'manual';
  /** Fully-qualified DNS name (Tailscale MagicDNS), without a trailing dot. */
  dnsName?: string;
  /** Raw IP address (IPv4 preferred). */
  ip?: string;
}

/** Authentication settings for a device. */
export interface DeviceAuth {
  method: DeviceAuthMethod;
  /** Explicit private-key path passed to OpenSSH for key authentication. */
  identityFile?: string;
  /** Secrets bundle holding the password (when method === 'password'). */
  bundle?: string;
  /** Key within the bundle whose value is the password. Defaults to 'password'. */
  bundleKey?: string;
}

/** Last-known Tailscale reachability snapshot for a device. */
export interface DeviceTailscale {
  online: boolean;
  /** True when the last handshake was a direct (non-relayed) connection. */
  direct: boolean;
  /** DERP relay region code (e.g. 'sfo'); empty when direct. */
  relay?: string;
  lastSeen?: string;
}

/** Verdict of the last live SSH reachability probe (RUSH-1965), persisted so the online/offline
 * word reads a fresh probe instead of the stale {@link DeviceTailscale.online} snapshot. A
 * `via:"manual"` device, with no tailscale entry, gets a verdict this way too. */
export interface DeviceReachability {
  /** Whether the last live probe reached the device. */
  reachable: boolean;
  /** Transport the verdict came through — the address kind used to dial it. */
  via?: DeviceAddress['via'];
  /** ISO-8601 timestamp of the probe that produced this verdict. */
  checkedAt: string;
}

/** A single registered device. */
export interface DeviceProfile {
  name: string;
  platform: DevicePlatform;
  shell: DeviceShell;
  user?: string;
  address: DeviceAddress;
  auth: DeviceAuth;
  tailscale?: DeviceTailscale;
  /** Last live SSH-probe reachability verdict (RUSH-1965). Preferred over the
   * cached {@link DeviceTailscale.online} snapshot when rendering online/offline,
   * because the live probe reflects whether the box answered right now. */
  reachability?: DeviceReachability;
  createdAt: string;
  updatedAt: string;
}

/** Whether a fan-out should dial this device: the live SSH probe ({@link
 * DeviceProfile.reachability}) wins over cached {@link DeviceTailscale.online}. Reading only
 * `online` skipped manual devices forever and dialed sleeping boxes into a false "unreachable". */
export function isDialableDevice(d: DeviceProfile): boolean {
  // Union, deliberately: either signal saying "go" is enough; a probe may only add a peer, never
  // remove one. The probe is untrustworthy for exclusion (short SSH budget; false negatives on a
  // congested tailnet), and the snapshot alone skips manual devices.
  if (d.reachability?.reachable) return true;
  return !d.tailscale || d.tailscale.online === true;
}
// `commands/apply.ts` (`devices: all`) and `commands/output.ts` (`--all-hosts`) still gate on bare
// `tailscale.online === true` and skip manual devices. Left alone on purpose: neither is a session
// surface and changing `agents apply` targeting deserves its own PR.

/** Map of device name to profile. */
export type DeviceRegistry = Record<string, DeviceProfile>;

function registryPath(): string {
  return getDevicesRegistryPath();
}

/** Valid logical device name: the ssh-alias charset, so it renders into an
 * unambiguous `Host` stanza and is safe as an ssh target. */
const DEVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** `--device` values that mean "resolve me", not a box name. A real device under one of these would
 * be unreachable, and pinning `interactive.host` to one must fail at write time; otherwise the
 * read side can only say "none is set", sending the user back to the command they just ran. */
export const RESERVED_DEVICE_NAMES = new Set(['auto', 'interactive', 'all']);

/** Throw if `name` is not usable as an ssh alias (no spaces, quotes, etc.). Shape only, safe on
 * read paths, which must keep working for an already-registered name this version would refuse to
 * create. */
export function assertValidDeviceName(name: string): void {
  if (!DEVICE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid device name ${JSON.stringify(name)}. Use letters, digits, '.', '_', '-' (no spaces) — e.g. 'win-mini'.`,
    );
  }
}

/** Throw if `name` can't name a new device: bad shape or a reserved routing sentinel. Called
 * only from `agents devices add` and device-pointing config keys (`interactive.host`), never from
 * upsertDevice/addIgnored/discovery: one observed node named `auto` would abort the whole sync. */
export function assertRegistrableDeviceName(name: string): void {
  assertValidDeviceName(name);
  if (RESERVED_DEVICE_NAMES.has(name.trim().toLowerCase())) {
    throw new Error(
      `${JSON.stringify(name)} is a reserved --device value, not a device name. ` +
        `Reserved: ${[...RESERVED_DEVICE_NAMES].join(', ')}.`,
    );
  }
}

/** Map a Tailscale `OS` field to our platform enum. */
export function platformFromOs(os: string | undefined): DevicePlatform {
  switch ((os ?? '').toLowerCase()) {
    case 'windows':
      return 'windows';
    case 'linux':
      return 'linux';
    case 'macos':
    case 'darwin':
      return 'macos';
    default:
      return 'unknown';
  }
}

/** The remote shell a platform speaks. */
export function shellForPlatform(platform: DevicePlatform): DeviceShell {
  return platform === 'windows' ? 'powershell' : 'posix';
}

/** Run `fn` holding an exclusive cross-process lock on the registry file (proper-lockfile needs the
 * target to exist, so touch it first). Stale locks from crashed callers expire after `stale` ms. */
async function withRegistryLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!fsSync.existsSync(p)) {
    try {
      await fs.writeFile(p, '{}', { flag: 'wx' });
    } catch (err: any) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  const release = await lockfile.lock(p, {
    retries: { retries: 60, minTimeout: 25, maxTimeout: 250, factor: 1.5 },
    stale: 10_000,
    onCompromised: logAndContinueOnLockCompromised('devices registry'),
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Load all devices; an empty object only when the file does not exist. A malformed file is a hard
 * error, since returning {} would let the next write wipe the user's device list. */
export async function loadDevices(): Promise<DeviceRegistry> {
  const p = registryPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as DeviceRegistry;
  } catch (err: any) {
    throw new Error(
      `Device registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

/** Synchronous {@link loadDevices} for sync paths (e.g. the `agents sessions --device` fan-out
 * building ssh strings that need the target's platform). Same missing-file/corruption contract. */
export function loadDevicesSync(): DeviceRegistry {
  const p = registryPath();
  let raw: string;
  try {
    raw = fsSync.readFileSync(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as DeviceRegistry;
  } catch (err: any) {
    throw new Error(
      `Device registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

async function saveDevices(reg: DeviceRegistry): Promise<void> {
  atomicWriteJsonSync(registryPath(), reg);
}

/** Get a single device profile, or null if it is not registered. */
export async function getDevice(name: string): Promise<DeviceProfile | null> {
  const reg = await loadDevices();
  return reg[name] ?? null;
}

/** Fields a caller may supply when creating or updating a device. */
export interface DeviceInput {
  platform?: DevicePlatform;
  user?: string;
  address?: DeviceAddress;
  auth?: DeviceAuth;
  tailscale?: DeviceTailscale;
  reachability?: DeviceReachability;
}

/** Create the device if absent, otherwise merge the supplied fields into the profile. `shell` is
 * always re-derived from the (possibly new) platform so they cannot drift. Returns the profile. */
export async function upsertDevice(name: string, input: DeviceInput): Promise<DeviceProfile> {
  assertValidDeviceName(name);
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    const now = new Date().toISOString();
    const prev = reg[name];
    const platform = input.platform ?? prev?.platform ?? 'unknown';
    const merged: DeviceProfile = {
      name,
      platform,
      shell: shellForPlatform(platform),
      user: input.user ?? prev?.user,
      address: input.address ?? prev?.address ?? { via: 'manual' },
      auth: input.auth ?? prev?.auth ?? { method: 'key' },
      tailscale: input.tailscale ?? prev?.tailscale,
      reachability: input.reachability ?? prev?.reachability,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    reg[name] = merged;
    await saveDevices(reg);
    return merged;
  });
}

/** Persist live reachability verdicts for many devices in one locked pass (RUSH-1965). A no-op
 * verdict (same `reachable`, not newer) is skipped so a cache-served render does not churn the
 * registry. Does not bump `updatedAt`: reachability is transient liveness, not a profile edit. */
export async function writeReachability(
  updates: Record<string, DeviceReachability>,
): Promise<string[]> {
  const names = Object.keys(updates);
  if (names.length === 0) return [];
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    const changed: string[] = [];
    for (const name of names) {
      const prev = reg[name];
      if (!prev) continue; // never resurrect a device the user removed
      const next = updates[name];
      const cur = prev.reachability;
      if (
        cur &&
        cur.reachable === next.reachable &&
        Date.parse(cur.checkedAt) >= Date.parse(next.checkedAt)
      ) {
        continue; // unchanged verdict, no fresher timestamp — skip the write
      }
      reg[name] = { ...prev, reachability: next };
      changed.push(name);
    }
    if (changed.length > 0) await saveDevices(reg);
    return changed;
  });
}

/** Remove a device. Returns false if it was not registered. */
export async function removeDevice(name: string): Promise<boolean> {
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    if (!reg[name]) return false;
    delete reg[name];
    await saveDevices(reg);
    removeStatsCacheEntry(name);
    return true;
  });
}

/** The ignore-list: tailscale node names the user dismissed from auto-discovery. A dismissed node
 * is not a device, so it lives in the tracked central `agents.yaml` `fleet.ignored`, synced
 * fleet-wide so one dismissal stops the suggestion everywhere (RUSH-3062). */

// `fleet.ignored` is declared on FleetManifest itself (lib/fleet/types.ts), not as a local
// intersection: an intersection hid the field from other consumers, so the migration's
// emptied-block guard omitted it and would have deleted dismissals fleet-wide.
export type { IgnoredDeviceEntry } from '../fleet/types.js';

/** The full ignore-list entries (who, when, which box), the typed read side for `agents devices
 * ignored`. Absent `fleet.ignored` is []. A malformed block is a hard error, since returning []
 * would let the next write wipe the user's dismissals. */
/** Validate a raw ignore-list block, or throw with `where` naming the file. */
function assertIgnoredShape(raw: unknown, where: string): asserts raw is IgnoredDeviceEntry[] {
  if (
    !Array.isArray(raw) ||
    raw.some(
      (e) =>
        !e ||
        typeof e.name !== 'string' ||
        typeof e.ignoredAt !== 'string' ||
        typeof e.ignoredOn !== 'string',
    )
  ) {
    throw new Error(
      `Device ignore-list corrupted in ${where}: expected a list of { name, ignoredAt, ignoredOn } entries. Inspect and repair it.`,
    );
  }
}

/** This box's own dismissals: the writable slice in `meta.deviceFleet.ignored` (the device doc).
 * `withIgnoredAdded`/`removeIgnored` operate on it so a box only edits its own folder (PHNX-3315).
 * Absent is []. */
function loadOwnIgnoredEntries(meta: Meta): IgnoredDeviceEntry[] {
  const raw = meta.deviceFleet?.ignored;
  if (raw === undefined) return [];
  assertIgnoredShape(raw, `devices/<machine>/agents.yaml (fleet.ignored)`);
  return raw;
}

/** The effective ignore-list: the union of every box's device doc `fleet.ignored` (deduped by node
 * name, newest `ignoredAt` wins) plus any lingering central-legacy block. Order-independent. */
export function loadIgnoredEntries(meta: Meta = readMeta()): IgnoredDeviceEntry[] {
  const byName = new Map<string, IgnoredDeviceEntry>();
  const central = meta.fleet?.ignored;
  if (central !== undefined) {
    assertIgnoredShape(central, `agents.yaml (fleet.ignored)`);
    for (const e of central) addIgnoredEntry(byName, e);
  }
  for (const e of unionDeviceIgnored()) addIgnoredEntry(byName, e);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Load the set of ignored node names. Same corruption contract as
 * {@link loadIgnoredEntries}. */
export async function loadIgnored(): Promise<Set<string>> {
  return new Set(loadIgnoredEntries().map((e) => e.name));
}

/** True if `name` is on the ignore-list. */
export async function isIgnored(name: string): Promise<boolean> {
  return (await loadIgnored()).has(name);
}

/** Union `names` into the meta's ignore-list, stamping new entries with `ignoredAt` and this
 * machine's id. Existing entries keep their original who/when, so re-adding is a no-op; returns
 * the input unchanged when no name is new. Also used by the legacy migration. */
export function withIgnoredAdded(meta: Meta, names: string[], ignoredAt: string): Meta {
  const entries = loadOwnIgnoredEntries(meta); // throws on a corrupted block — never wipe it
  const have = new Set(entries.map((e) => e.name));
  const fresh = names.filter((n) => !have.has(n));
  if (fresh.length === 0) return meta;
  const ignored: IgnoredDeviceEntry[] = [
    ...entries,
    ...fresh.map((name) => ({ name, ignoredAt, ignoredOn: machineId() })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { ...meta, deviceFleet: { ...meta.deviceFleet, ignored } };
}

/** Add a node name to this box's ignore-list (device doc), idempotently; returns the cross-box
 * union of dismissed names. Reads only device docs, so a corrupt central-legacy block surfaces on
 * {@link loadIgnoredEntries} and never blocks this per-box write. */
export async function addIgnored(name: string): Promise<Set<string>> {
  assertValidDeviceName(name);
  updateMeta((m) => withIgnoredAdded(m, [name], new Date().toISOString()));
  return new Set(unionDeviceIgnored().map((e) => e.name));
}

/** Remove a node name from the ignore-list (un-ignore). Returns false if it was
 * not ignored. */
export async function removeIgnored(name: string): Promise<boolean> {
  let removed = false;
  updateMeta((m) => {
    const entries = loadOwnIgnoredEntries(m); // only this box's own dismissals are ours to drop
    const next = entries.filter((e) => e.name !== name);
    if (next.length === entries.length) return m;
    removed = true;
    return { ...m, deviceFleet: { ...m.deviceFleet, ignored: next } };
  });
  return removed;
}
