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

export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'unknown';

export type DeviceShell = 'powershell' | 'posix';

export type DeviceAuthMethod = 'key' | 'password';

export interface DeviceAddress {
  via: 'tailscale' | 'manual';
  dnsName?: string;
  ip?: string;
}

export interface DeviceAuth {
  method: DeviceAuthMethod;
  identityFile?: string;
  bundle?: string;
  bundleKey?: string;
}

export interface DeviceTailscale {
  online: boolean;
  direct: boolean;
  relay?: string;
  lastSeen?: string;
}

export interface DeviceReachability {
  reachable: boolean;
  via?: DeviceAddress['via'];
  checkedAt: string;
}

export interface DeviceProfile {
  name: string;
  platform: DevicePlatform;
  shell: DeviceShell;
  user?: string;
  address: DeviceAddress;
  auth: DeviceAuth;
  tailscale?: DeviceTailscale;
  reachability?: DeviceReachability;
  createdAt: string;
  updatedAt: string;
}

export function isDialableDevice(d: DeviceProfile): boolean {
  if (d.reachability?.reachable) return true;
  return !d.tailscale || d.tailscale.online === true;
}

export type DeviceRegistry = Record<string, DeviceProfile>;

function registryPath(): string {
  return getDevicesRegistryPath();
}

const DEVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const RESERVED_DEVICE_NAMES = new Set(['auto', 'interactive', 'all']);

export function assertValidDeviceName(name: string): void {
  if (!DEVICE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid device name ${JSON.stringify(name)}. Use letters, digits, '.', '_', '-' (no spaces) — e.g. 'win-mini'.`,
    );
  }
}

export function assertRegistrableDeviceName(name: string): void {
  assertValidDeviceName(name);
  if (RESERVED_DEVICE_NAMES.has(name.trim().toLowerCase())) {
    throw new Error(
      `${JSON.stringify(name)} is a reserved --device value, not a device name. ` +
        `Reserved: ${[...RESERVED_DEVICE_NAMES].join(', ')}.`,
    );
  }
}

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

export function shellForPlatform(platform: DevicePlatform): DeviceShell {

  return platform === 'windows' ? 'powershell' : 'posix';
}

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

export async function getDevice(name: string): Promise<DeviceProfile | null> {
  const reg = await loadDevices();
  return reg[name] ?? null;
}

export interface DeviceInput {
  platform?: DevicePlatform;
  user?: string;
  address?: DeviceAddress;
  auth?: DeviceAuth;
  tailscale?: DeviceTailscale;
  reachability?: DeviceReachability;
}

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
      if (!prev) continue;
      const next = updates[name];
      const cur = prev.reachability;
      if (
        cur &&
        cur.reachable === next.reachable &&
        Date.parse(cur.checkedAt) >= Date.parse(next.checkedAt)
      ) {
        continue;
      }
      reg[name] = { ...prev, reachability: next };
      changed.push(name);
    }
    if (changed.length > 0) await saveDevices(reg);
    return changed;
  });
}

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


export type { IgnoredDeviceEntry } from '../fleet/types.js';

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

function loadOwnIgnoredEntries(meta: Meta): IgnoredDeviceEntry[] {
  const raw = meta.deviceFleet?.ignored;
  if (raw === undefined) return [];
  assertIgnoredShape(raw, `devices/<machine>/agents.yaml (fleet.ignored)`);
  return raw;
}

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

export async function loadIgnored(): Promise<Set<string>> {
  return new Set(loadIgnoredEntries().map((e) => e.name));
}

export async function isIgnored(name: string): Promise<boolean> {
  return (await loadIgnored()).has(name);
}

export function withIgnoredAdded(meta: Meta, names: string[], ignoredAt: string): Meta {
  const entries = loadOwnIgnoredEntries(meta);
  const have = new Set(entries.map((e) => e.name));
  const fresh = names.filter((n) => !have.has(n));
  if (fresh.length === 0) return meta;
  const ignored: IgnoredDeviceEntry[] = [
    ...entries,
    ...fresh.map((name) => ({ name, ignoredAt, ignoredOn: machineId() })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { ...meta, deviceFleet: { ...meta.deviceFleet, ignored } };
}

export async function addIgnored(name: string): Promise<Set<string>> {
  assertValidDeviceName(name);
  updateMeta((m) => withIgnoredAdded(m, [name], new Date().toISOString()));
  return new Set(unionDeviceIgnored().map((e) => e.name));
}

export async function removeIgnored(name: string): Promise<boolean> {
  let removed = false;
  updateMeta((m) => {
    const entries = loadOwnIgnoredEntries(m);
    const next = entries.filter((e) => e.name !== name);
    if (next.length === entries.length) return m;
    removed = true;
    return { ...m, deviceFleet: { ...m.deviceFleet, ignored: next } };
  });
  return removed;
}
