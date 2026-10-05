
import type { Host, HostProvider, HostProviderId } from './types.js';
import type { HostEntry } from '../types.js';
import { DeviceOffloadUnsupportedError } from './types.js';
import { LocalHostProvider } from './providers/local.js';
import { DevicesHostProvider } from './providers/devices.js';
import { assertValidSshTarget } from '../ssh-exec.js';
import { normalizeHost } from '../machine-id.js';
import { readMeta } from '../state.js';
import { unionDeviceHosts } from '../devices/device-docs.js';
import { isSshConfigHost } from './ssh-config.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { loadDevices, type DeviceProfile, type DeviceRegistry } from '../devices/registry.js';
import { resolveDeviceProfile } from '../devices/resolve-profile.js';
import { isDeviceAuto, resolveDeviceAffinity, type DeviceAffinityPlan } from '../smart-launch.js';
import {
  isDeviceInteractive,
  resolveInteractiveDevice,
  interactiveUnsetError,
} from '../devices/interactive-host.js';
import { localMachineId } from '../session/origin-machine.js';

export { DeviceOffloadUnsupportedError };

const providers: Map<HostProviderId, HostProvider> = new Map();

function initProviders(): void {
  if (providers.size > 0) return;
  providers.set('local', new LocalHostProvider());
  providers.set('devices', new DevicesHostProvider());
}

export function getProvider(id: HostProviderId): HostProvider {
  initProviders();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`Unknown host provider: ${id}. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider;
}

export function getAllProviders(): HostProvider[] {
  initProviders();
  return [...providers.values()];
}

interface ResolvedHost extends Host {
  device?: DeviceProfile;
  adhoc?: boolean;
}

export function splitUserHost(token: string): { user?: string; host: string } {
  const at = token.indexOf('@');
  return at === -1 ? { host: token } : { user: token.slice(0, at), host: token.slice(at + 1) };
}

function looksLikeHostLiteral(token: string): boolean {
  return token.includes('@') || token.includes('.') || token.includes(':');
}

function matchDevice(host: string, reg: DeviceRegistry): DeviceProfile | undefined {
  return reg[host] ?? Object.values(reg).find((d) => normalizeHost(d.name) === normalizeHost(host));
}

function deviceStatus(device: DeviceProfile): Host['status'] {
  if (!device.tailscale) return 'unknown';
  return device.tailscale.online ? 'online' : 'offline';
}

function deviceHost(device: DeviceProfile, user: string | undefined, overlay?: HostEntry): ResolvedHost {
  // Live device identity owns address/auth/presence; overlays add capabilities and unknown-platform OS.
  const resolved = resolveDeviceProfile(device);
  const address = resolved.address.dnsName ?? resolved.address.ip;
  return {
    name: resolved.name,
    provider: 'devices',
    source: 'inline',
    ...(address ? { address } : {}),
    user: user ?? resolved.user,
    identityFile: resolved.auth.identityFile,
    os: resolved.platform !== 'unknown' ? resolved.platform : overlay?.os,
    ...(overlay?.caps?.length ? { caps: overlay.caps } : {}),
    enrolled: true,
    status: deviceStatus(resolved),
    dispatchable: resolved.auth.method !== 'password',
    device: resolved,
  };
}

function overlayHost(name: string, entry: HostEntry, user?: string): ResolvedHost {
  return {
    name,
    provider: 'local',
    enrolled: true,
    source: entry.source,
    ...(entry.address ? { address: entry.address } : {}),
    user: user ?? entry.user,
    ...(entry.os ? { os: entry.os } : {}),
    ...(entry.caps?.length ? { caps: entry.caps } : {}),
    ...(entry.addedAt ? { addedAt: entry.addedAt } : {}),
    status: 'unknown',
    dispatchable: true,
  };
}

function literalHost(token: string, host: string, user?: string): ResolvedHost {
  return {
    name: token,
    provider: 'local',
    source: 'inline',
    address: host,
    ...(user ? { user } : {}),
    status: 'unknown',
    dispatchable: true,
    adhoc: true,
  };
}

export interface MatchHostOptions {
  allowBareLiteral?: boolean;
  resolveAuto?: () => DeviceAffinityPlan;
}

export async function matchHost(name: string, opts: MatchHostOptions = {}): Promise<ResolvedHost | null> {
  // Bare literal fallback is caller-scoped so typos and capability tokens are never silently dialed.
  if (isDeviceInteractive(name)) {
    const pinned = resolveInteractiveDevice();
    if (!pinned) throw new Error(interactiveUnsetError());
    name = pinned;
  }

  if (isDeviceAuto(name)) {
    const plan = (opts.resolveAuto ?? (() => resolveDeviceAffinity({})))();
    const picked = plan.host ?? normalizeHost(localMachineId());
    return matchHost(picked, opts);
  }

  try {
    assertValidSshTarget(name);
  } catch {
    return null;
  }
  const { user, host } = splitUserHost(name);

  let reg: DeviceRegistry;
  try {
    reg = await loadDevices();
  } catch {
    reg = {};
  }
  const overlay = { ...readMeta().hosts, ...unionDeviceHosts() }[host];

  const device = matchDevice(host, reg);
  if (device) return deviceHost(device, user, overlay);

  if (overlay) return overlayHost(host, overlay, user);

  if (!user && isSshConfigHost(host)) {
    return { name: host, provider: 'local', source: 'ssh-config', os: resolveRemoteOsSync(host), status: 'unknown', dispatchable: true };
  }

  if (name.includes('@') || (opts.allowBareLiteral && looksLikeHostLiteral(name))) {
    assertValidSshTarget(name);
    return literalHost(name, host, user);
  }
  return null;
}

export async function listAllHosts(): Promise<Host[]> {
  // Provider precedence preserves live device dispatchability when registrations collide.
  const byName = new Map<string, Host>();
  for (const provider of getAllProviders()) {
    for (const host of await provider.list()) {
      const prev = byName.get(host.name);
      if (!prev) {
        byName.set(host.name, host);
        continue;
      }
      byName.set(host.name, {
        ...prev,
        address: host.address ?? prev.address,
        user: host.user ?? prev.user,
        os: host.os ?? prev.os,
        status: host.status ?? prev.status,
        dispatchable: host.dispatchable ?? prev.dispatchable,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveHost(name: string): Promise<Host | null> {
  const host = await matchHost(name);
  if (!host) return null;
  if (host.device) {
    if (host.device.auth.method === 'password') {
      throw new DeviceOffloadUnsupportedError(host.device.name);
    }
    if (!host.address) {
      throw new Error(`Device "${host.device.name}" has no address (Tailscale DNS name or IP) to reach it by.`);
    }
  }
  return host;
}

export async function resolveHostByCap(cap: string, any = false): Promise<Host> {
  const matches = (await listAllHosts()).filter((h) => h.caps?.includes(cap) && h.dispatchable !== false);
  if (matches.length === 0) throw new Error(`No host tagged "${cap}". See registered devices: agents devices list`);
  if (matches.length > 1 && !any) {
    throw new Error(`Multiple hosts tagged "${cap}": ${matches.map((h) => h.name).join(', ')}. Name one, or pass --any.`);
  }
  return matches[0];
}
