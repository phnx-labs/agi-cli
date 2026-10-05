import chalk from 'chalk';
import { hostIdentityArgs, sshTargetFor } from '../hosts/types.js';
import { matchHost, splitUserHost, type MatchHostOptions } from '../hosts/registry.js';
import { normalizeHost } from '../machine-id.js';
import { resolveRemoteOsSync } from '../hosts/remote-os.js';
import { type DeviceProfile } from './registry.js';

export { splitUserHost };

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

const SYNTH_TS = '1970-01-01T00:00:00.000Z';

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

async function toResolvedTarget(token: string): Promise<ResolvedSshTarget | undefined> {

  const host = await matchHost(token);
  if (!host) return undefined;
  let target: string;
  try {
    target = sshTargetFor(host);
  } catch {
    return undefined;
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
  return undefined;
}

export async function resolveExplicitTargets(hosts: string[]): Promise<ResolvedSshTarget[]> {
  return (await resolveExplicitTargetSet(hosts)).targets;
}

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
