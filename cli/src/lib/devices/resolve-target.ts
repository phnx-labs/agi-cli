/**
 * Fan-out + `agents ssh` adapters over the single host/device resolver.
 *
 * Every `--device` / `--device` token becomes a concrete target through one core,
 * {@link matchHost} in ../hosts/registry.ts — the merged directory that reads the
 * devices registry, the agents.yaml overlay, AND ssh_config (RUSH-1967). This
 * module is only the two thin adapters the fan-out and interactive-ssh paths
 * need on top of that core:
 *   - {@link resolveExplicitTargets} — a token list → dialable `{target, machine,
 *     name, os}` rows, so `sessions --device` / session bundles / remote agents-json
 *     dial the exact same address (and machine id) `run --device` does.
 *   - {@link resolveDeviceTarget} — a token → the full {@link DeviceProfile}
 *     `agents ssh` needs (auth, shell, tailscale metadata), with the same
 *     grammar; a bare unregistered alias returns undefined ("Unknown device").
 *
 * The grammar is uniform across the fleet: `name`, `user@name` (same device,
 * login user overridden), a tailnet FQDN, an ssh_config alias, and an ad-hoc
 * `user@host` all resolve identically no matter which subcommand called.
 */
import chalk from 'chalk';
import { hostIdentityArgs, sshTargetFor } from '../hosts/types.js';
import { matchHost, splitUserHost, type MatchHostOptions } from '../hosts/registry.js';
import { normalizeHost } from '../machine-id.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { type DeviceProfile } from './registry.js';

export { splitUserHost };

/** A dialable peer: the ssh target, the machine id used to tag its rows, a
 * display name, and the OS family that picks the remote shell dialect. */
interface ResolvedSshTarget {
  target: string;
  machine: string;
  name: string;
  os?: string;
  extraSshArgs?: string[];
}

interface ResolvedExplicitTargetSet {
  targets: ResolvedSshTarget[];
  unresolved: string[];
}

/** Timestamps for a synthesized ad-hoc profile — never persisted, so a constant
 * keeps the value deterministic (and side-effect free) without reading the clock. */
const SYNTH_TS = '1970-01-01T00:00:00.000Z';

/** Synthesize a throwaway device profile for an ad-hoc `user@host` / `host`
 * literal so `agents ssh` can dial a box that was never registered. */
function adHocDevice(token: string, host: string, user?: string): DeviceProfile {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return {
    name: token,
    platform: 'unknown',
    shell: 'posix',
    user,
    address: { via: 'manual', dnsName: isIp ? undefined : host, ip: isIp ? host : undefined },
    auth: { method: 'key' },
    createdAt: SYNTH_TS,
    updatedAt: SYNTH_TS,
  };
}

/**
 * Resolve one token to a dialable {@link ResolvedSshTarget}, or undefined when it
 * fails the injection guard or names nothing reachable. A registered device (or
 * `user@device`) dials its live Tailscale route; an ssh_config-only alias dials
 * by its bare name (ssh applies the stanza) — now visible to the fan-out too; an
 * ad-hoc `user@host` dials the literal.
 */
async function toResolvedTarget(token: string): Promise<ResolvedSshTarget | undefined> {
  const host = await matchHost(token);
  if (!host) return undefined;
  let target: string;
  try {
    target = sshTargetFor(host);
  } catch {
    return undefined; // matched a device/host with no address to dial
  }
  const hostPart = host.device ? host.device.name : splitUserHost(host.name).host;
  const name = host.device ? host.device.name : host.name;
  const extraSshArgs = hostIdentityArgs(host);
  return {
    target,
    machine: normalizeHost(hostPart),
    name,
    os: host.os ?? resolveRemoteOsSync(name),
    ...(extraSshArgs.length > 0 ? { extraSshArgs } : {}),
  };
}

/**
 * Resolve a target token to a full {@link DeviceProfile} for `agents ssh`. Same
 * grammar as the fan-out, but returns the whole profile (auth, shell, tailscale
 * metadata) `buildSshInvocation` needs. A registered `name` / `user@device`
 * yields that profile (login user overridden by any `user@`); an ad-hoc
 * `user@host` / IP / FQDN literal yields a synthesized key-auth profile. A bare
 * unregistered alias (no `@`/dot) — or an ssh_config-only alias, which `agents
 * ssh` has never dialed — returns undefined so the caller reports "Unknown
 * device" rather than dialing a literal. `token` may also be the `auto`
 * affinity sentinel (RUSH-2185); `opts.resolveAuto` overrides the pick (tests).
 */
export async function resolveDeviceTarget(
  token: string,
  opts: Pick<MatchHostOptions, 'resolveAuto'> = {}
): Promise<DeviceProfile | undefined> {
  const host = await matchHost(token, { allowBareLiteral: true, ...opts });
  if (!host) return undefined;
  if (host.device) {
    const { user } = splitUserHost(token);
    return user ? { ...host.device, user } : host.device;
  }
  if (host.adhoc) {
    const { user, host: hostPart } = splitUserHost(token);
    return adHocDevice(token, hostPart, user);
  }
  // An overlay / ssh_config-only match is not a device — `agents ssh` stays
  // devices-and-literals only, so report it as unknown.
  return undefined;
}

/**
 * Resolve an explicit `--device`/`--device` list to dialable targets. A token that
 * fails the injection guard or names nothing reachable is skipped with a stderr
 * note (never fatal — one bad token must not blank the fan-out). Shared by every
 * cross-machine fan-out so they can never diverge onto two routes.
 */
export async function resolveExplicitTargets(hosts: string[]): Promise<ResolvedSshTarget[]> {
  return (await resolveExplicitTargetSet(hosts)).targets;
}

/** Resolve explicit tokens while retaining failures for coverage-sensitive callers. */
export async function resolveExplicitTargetSet(hosts: string[]): Promise<ResolvedExplicitTargetSet> {
  const targets: ResolvedSshTarget[] = [];
  const unresolved: string[] = [];
  for (const h of hosts) {
    const resolved = await toResolvedTarget(h);
    if (!resolved) {
      process.stderr.write(chalk.gray(`  ${h}: not a resolvable ssh target — skipped\n`));
      unresolved.push(h);
      continue;
    }
    targets.push(resolved);
  }
  return { targets, unresolved };
}
