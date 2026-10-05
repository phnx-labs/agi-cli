/** Host provider registry and the single host/device resolver; adding `rush`/`crabbox` is one
 * `providers.set(...)`. Two chains once dialed different boxes for one token (RUSH-1967); now
 * every caller uses matchHost, merging devices registry, agents.yaml overlay and ssh_config. */

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

/** A resolved host, carrying the live DeviceProfile when the token matched a registered device,
 * so `agents ssh` can reach auth/shell/tailscale metadata and dispatch can apply the password-
 * auth refusal without re-reading the registry. */
interface ResolvedHost extends Host {
  device?: DeviceProfile;
  /** True for a synthesized ad-hoc `user@host`/IP/FQDN literal (never registered), so strict
   * `agents ssh` still reports "Unknown device" for an ssh-config-only alias. */
  adhoc?: boolean;
}

export function splitUserHost(token: string): { user?: string; host: string } {
  const at = token.indexOf('@');
  return at === -1 ? { host: token } : { user: token.slice(0, at), host: token.slice(at + 1) };
}

/** True when a token is clearly a network target (`user@`, dotted or IPv6 host) rather than a
 * bare alias; a bare unknown word is a typo, so `agents ssh foo` reports "Unknown device"
 * instead of dialing `foo`. */
function looksLikeHostLiteral(token: string): boolean {
  return token.includes('@') || token.includes('.') || token.includes(':');
}

/** Match a host part to a registered device: exact registry key first, then a normalized match
 * so `yosemite-s0` and its tailnet FQDN land on the same profile. Shared by every caller
 * (RUSH-1967 divergence #3/#4). */
function matchDevice(host: string, reg: DeviceRegistry): DeviceProfile | undefined {
  return reg[host] ?? Object.values(reg).find((d) => normalizeHost(d.name) === normalizeHost(host));
}

function deviceStatus(device: DeviceProfile): Host['status'] {
  if (!device.tailscale) return 'unknown';
  return device.tailscale.online ? 'online' : 'offline';
}

/** Merge a matched device with its agents.yaml overlay per field (RUSH-1967): the live registry
 * owns address, OS and presence so an enrolled route can't freeze; the overlay adds caps and an
 * OS hint. `dispatchable` follows the device's auth. */
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
  /** Also treat an unmatched dotted/colon literal (raw IP or FQDN, no `user@`) as ad-hoc;
   * `agents ssh 1.2.3.4` sets this, dispatch and fan-out do not, so a bare unknown stays a miss
   * and cap routing and "Unknown device" remain reachable. */
  allowBareLiteral?: boolean;
  resolveAuto?: () => DeviceAffinityPlan;
}

/** The one place a `--device` token becomes a resolved host, merging devices registry,
 * agents.yaml overlay and ssh_config per field (see deviceHost). One grammar for all callers
 * (name, `user@name`, FQDN, ssh alias). Non-throwing; resolveHost owns the password refusal. */
export async function matchHost(name: string, opts: MatchHostOptions = {}): Promise<ResolvedHost | null> {
  // Host-only callers resolve `auto` through the affinity engine here (run/team placement resolves
  // it earlier with live probes). A null plan.host means this machine: resolve it as the local
  // entry so "target is this machine" callers treat it as local.
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

/** Every host across all providers, merged by name so a device's presence/dispatchable/address
 * and an overlay's caps coexist on one row (RUSH-1967: first-wins dedup dropped the device
 * row). Provider order still decides the base row (`local` first). */
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
      // Same name from a later provider: `prev` is the overlay row, `host` the live device row.
      // Keep the overlay's caps/source/addedAt but let the device win its own fields (address,
      // user, OS, presence, dispatchable), else the frozen route returns via resolveHostByCap.
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

/** Resolve a `--device` token for dispatch (run, passthrough, teams, cloud, doctor, funnel,
 * remote secrets) via matchHost plus the device-only refusal: a password-auth device throws
 * DeviceOffloadUnsupportedError; an addressless one has nothing to dial. */
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

/** Resolve a host by capability tag (e.g. `--device gpu`): the single match, or throws on 0 or
 * >1 unless `any` is set (then the first). */
export async function resolveHostByCap(cap: string, any = false): Promise<Host> {
  const matches = (await listAllHosts()).filter((h) => h.caps?.includes(cap) && h.dispatchable !== false);
  if (matches.length === 0) throw new Error(`No host tagged "${cap}". See registered devices: agents devices list`);
  if (matches.length > 1 && !any) {
    throw new Error(`Multiple hosts tagged "${cap}": ${matches.map((h) => h.name).join(', ')}. Name one, or pass --any.`);
  }
  return matches[0];
}
