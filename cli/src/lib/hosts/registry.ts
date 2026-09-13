/**
 * Host provider registry + the single host/device resolver.
 *
 * Mirrors the cloud provider registry: a Map of provider id → implementation,
 * instantiated once. Registers `local` then `devices`; adding `rush`/`crabbox`
 * later is a one-line `providers.set(...)`.
 *
 * Resolution used to fork into two disagreeing chains — a local-provider-first
 * `resolveHost` (this file) and a devices-only `resolveSshTarget`
 * (`../devices/resolve-target.ts`). They dialed different boxes for the same
 * token (RUSH-1967). Now every caller goes through one core, {@link matchHost}:
 * it merges the two directories per-FIELD instead of letting one provider
 * shadow the other — the live devices registry supplies address/OS/presence,
 * the agents.yaml overlay supplies caps/hints, and ssh_config supplies hosts
 * Tailscale has never seen. The typed wrappers below (`resolveHost`) and in
 * resolve-target.ts (`resolveExplicitTargets`, `resolveDeviceTarget`) differ
 * only in what shape they hand back and which literal fallbacks they permit.
 */

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

// Re-export so existing importers (tests, commands) keep their path; the class
// itself lives in types.ts so providers can throw it without a circular import.
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

/**
 * A resolved host, carrying the live {@link DeviceProfile} when the token
 * matched a registered device (by normalized name). The device reference lets
 * the `agents ssh` wrapper reach auth/shell/tailscale metadata a plain `Host`
 * doesn't hold, and lets dispatch callers apply the device-only refusal
 * (password auth) without re-reading the registry.
 */
interface ResolvedHost extends Host {
  device?: DeviceProfile;
  /** True when the host is a synthesized ad-hoc `user@host` / IP / FQDN literal
   * (never registered) rather than a device or overlay/ssh-config match. Lets the
   * strict `agents ssh` wrapper accept devices + literals but still report
   * "Unknown device" for a bare ssh-config-only alias, as it always has. */
  adhoc?: boolean;
}

/** Split a `user@host` / `host` token into its login user (if any) and host part. */
export function splitUserHost(token: string): { user?: string; host: string } {
  const at = token.indexOf('@');
  return at === -1 ? { host: token } : { user: token.slice(0, at), host: token.slice(at + 1) };
}

/** True when a token is clearly a network target (a `user@`, or a dotted/IPv6
 * host / IP) rather than a bare alias. A bare unknown word is a typo, so a
 * strict caller (`agents ssh foo`) reports "Unknown device" instead of dialing
 * a literal `foo`. */
function looksLikeHostLiteral(token: string): boolean {
  return token.includes('@') || token.includes('.') || token.includes(':');
}

/**
 * Match a host part (the piece after any `user@`) to a registered device: exact
 * registry key first, then a normalized-host match so `yosemite-s0` and
 * `yosemite-s0.<tailnet>.ts.net` land on the same profile. This normalized
 * grammar used to live only in the devices chain (RUSH-1967 divergence #3/#4);
 * it is now shared by every caller.
 */
function matchDevice(host: string, reg: DeviceRegistry): DeviceProfile | undefined {
  return reg[host] ?? Object.values(reg).find((d) => normalizeHost(d.name) === normalizeHost(host));
}

/** Tailscale's own presence bit for a device, when the sync captured one. */
function deviceStatus(device: DeviceProfile): Host['status'] {
  if (!device.tailscale) return 'unknown';
  return device.tailscale.online ? 'online' : 'offline';
}

/**
 * Merge a matched device with any same-name agents.yaml overlay into one Host,
 * per-FIELD (the core of the RUSH-1967 fix). The live registry owns address, OS
 * and presence — so `agents devices sync` takes effect without re-enrolling and
 * an enrolled route can never freeze — while the overlay contributes capability
 * tags (the reason to enroll at all) and an OS hint when the device platform is
 * unknown. `dispatchable` follows the device's auth method, so a password-auth
 * device can never be made dispatchable by shadowing it with an inline entry.
 */
function deviceHost(device: DeviceProfile, user: string | undefined, overlay?: HostEntry): ResolvedHost {
  // Effective profile: the central config's ssh.*/platform keys overlay the
  // discovery record, so an operator edit via `agents devices config` is
  // honored at dispatch time.
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

/** Build a Host from a bare overlay entry (inline or ssh-config), applying any
 * `user@` override. Inline/ssh-config hosts authenticate over key / ssh-config,
 * so they are dispatchable; presence is unknown without an explicit probe. */
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

/** Synthesize an ad-hoc inline Host for a `user@host` / `host` literal so a box
 * that was never registered still dials. sshTargetFor emits `user@address`. */
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

/** Literal-fallback policy for {@link matchHost}. */
export interface MatchHostOptions {
  /**
   * Also treat an unmatched dotted/colon host literal (a raw IP or FQDN with no
   * `user@`) as an ad-hoc target. `agents ssh 1.2.3.4` sets this; dispatch and
   * fan-out leave it off, so only a `user@host` is taken as an ad-hoc literal
   * (a bare/dotted unknown is a miss, keeping capability-tag routing and the
   * "Unknown device" verdict reachable).
   */
  allowBareLiteral?: boolean;
  /** Override the affinity pick for generic `auto` host resolution in tests.
   * Harness-aware run/team placement resolves `auto` before reaching this core. */
  resolveAuto?: () => DeviceAffinityPlan;
}

/**
 * The one place a `--device` / `--device` token becomes a resolved host. Reads the
 * devices registry, the agents.yaml overlay, and ssh_config, and merges them
 * per-field (see {@link deviceHost}). One grammar for every caller: `name`,
 * `user@name`, a tailnet FQDN, an ssh_config alias, and a literal `user@host`
 * all resolve the same way regardless of which subcommand called.
 *
 * Non-throwing: returns null on an injection-guard failure or an unresolved bare
 * token. The device-only refusal (password auth) is NOT applied
 * here — that is the dispatch wrapper's job ({@link resolveHost}), so the fan-out
 * and `agents ssh` paths, which handle those cases differently, aren't forced
 * into a dispatch verdict.
 */
export async function matchHost(name: string, opts: MatchHostOptions = {}): Promise<ResolvedHost | null> {
  // Generic host-only callers resolve `auto` through the affinity engine here;
  // harness-aware run/team placement resolves it earlier with live probes. A
  // `null` plan.host means the affinity engine picked this
  // very machine; resolve that as the local device/host entry (if any) rather than
  // returning nothing — callers that already special-case "target is this
  // machine" (teams add/create, the passthrough self-host check) then treat it as
  // local exactly as they would if the user had typed the local name.
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
  // The effective host overlay is the cross-box union of every device doc's
  // `hosts:` block (PHNX-3315), plus any lingering central-legacy entry.
  const overlay = { ...readMeta().hosts, ...unionDeviceHosts() }[host];

  // 1. A registered device (normalized match) — its live address/OS/presence win.
  const device = matchDevice(host, reg);
  if (device) return deviceHost(device, user, overlay);

  // 2. An agents.yaml overlay entry keyed by the host part (inline or ssh-config).
  if (overlay) return overlayHost(host, overlay, user);

  // 3. A bare ssh_config alias Tailscale has never seen — dial by name (ssh
  //    applies the stanza). A `user@alias` is handled as a literal below so the
  //    `user@` reaches ssh, which overrides the stanza's User.
  if (!user && isSshConfigHost(host)) {
    return { name: host, provider: 'local', source: 'ssh-config', os: resolveRemoteOsSync(host), status: 'unknown', dispatchable: true };
  }

  // 4. An ad-hoc literal target. `user@host` always; a bare IP/FQDN only when the
  //    caller opted in (`agents ssh`). A bare unknown word is a miss (null).
  if (name.includes('@') || (opts.allowBareLiteral && looksLikeHostLiteral(name))) {
    assertValidSshTarget(name);
    return literalHost(name, host, user);
  }
  return null;
}

/** Every host across all registered providers, merged by name so a device's
 * presence/dispatchable/address and an overlay's caps coexist on one row
 * (RUSH-1967: first-wins dedup used to drop the device row, and its status/caps
 * with it). Provider order still decides the base row (`local` first). */
export async function listAllHosts(): Promise<Host[]> {
  const byName = new Map<string, Host>();
  for (const provider of getAllProviders()) {
    for (const host of await provider.list()) {
      const prev = byName.get(host.name);
      if (!prev) {
        byName.set(host.name, host);
        continue;
      }
      // Same name from a later provider (a device behind an enrolled overlay):
      // `prev` is the local/overlay row (`local` registers first), `host` is the
      // live device row. Keep the overlay's caps/source/addedAt as the base, but
      // the DEVICE wins every field it owns — address, user, OS, presence and
      // dispatchable — so this matches `deviceHost()`'s per-field precedence and
      // an enrolled device can never serve a frozen address. Getting this
      // backwards reintroduced the frozen route through `resolveHostByCap`,
      // which hands a `listAllHosts()` row straight to dispatch.
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

/**
 * Resolve a `--device`/`--device` token for DISPATCH — the shape every offload
 * caller consumes (`run --device`, the generic passthrough, teams placement, the
 * cloud host provider, doctor, funnel, remote secrets). Grammar and merge come
 * from {@link matchHost}; on top, this layer applies the device-only dispatch
 * refusal so it holds even when an inline overlay shadows the device:
 *   - a password-auth device throws the typed {@link DeviceOffloadUnsupportedError}
 *     (offload rides `BatchMode=yes` ssh, which can't answer a prompt);
 *   - an addressless device has nothing to dial.
 *
 * A bare unknown name returns null so capability-tag routing (`resolveHostByCap`,
 * e.g. `--device gpu`) stays reachable, and an ad-hoc `user@host` still resolves.
 */
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

/**
 * Resolve a host by capability tag (e.g. `--device gpu`). Returns the single
 * matching host, or throws on 0 or >1 matches unless `any` is set (then first).
 */
export async function resolveHostByCap(cap: string, any = false): Promise<Host> {
  // Non-dispatchable hosts (password-auth devices) are listed for honesty but
  // must never be picked as a run target.
  const matches = (await listAllHosts()).filter((h) => h.caps?.includes(cap) && h.dispatchable !== false);
  if (matches.length === 0) throw new Error(`No host tagged "${cap}". See registered devices: agents devices list`);
  if (matches.length > 1 && !any) {
    throw new Error(`Multiple hosts tagged "${cap}": ${matches.map((h) => h.name).join(', ')}. Name one, or pass --any.`);
  }
  return matches[0];
}
