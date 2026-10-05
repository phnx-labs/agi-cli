
import { spawnSync } from 'child_process';
import type { DeviceProfile, DeviceRegistry } from './registry.js';
import { isSelfHost } from './self-host.js';
import { buildSshInvocation, sshTargetFor, writeAskpassShim } from './connect.js';
import type { DeviceStats } from './health.js';

export type FleetSkipReason = 'offline' | 'no-address';

const FLEET_VERSION_RE = /^[A-Za-z0-9._-]+$/;

export interface FleetTarget {
  device: DeviceProfile;
  skip?: FleetSkipReason;
}

export interface FleetRunResult {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  code: number | null;
  reason?: FleetSkipReason | string;
  detail?: string;
}

export interface FanOutDeviceTarget {
  name: string;
  skip?: FleetSkipReason | string;
}

export interface FanOutDeviceResult<T> {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  value?: T;
  error?: string;
  reason?: FleetSkipReason | string;
}

export function planFleetTargets(reg: DeviceRegistry): FleetTarget[] {
  const names = Object.keys(reg).sort();
  return names.map((name) => {
    const device = reg[name];
    if (device.tailscale && !device.tailscale.online) {
      return { device, skip: 'offline' as const };
    }
    try {
      sshTargetFor(device);
    } catch {
      return { device, skip: 'no-address' as const };
    }
    return { device };
  });
}

export function remoteFleetTargets(planned: FleetTarget[], self: string): FleetTarget[] {
  return planned.filter((t) => t.device.name !== self && !isSelfHost(t.device.name));
}

export function fleetHealthSkip(
  currentSkip: FleetSkipReason | string | undefined,
  stats: DeviceStats | undefined,
): FleetSkipReason | string | undefined {

  if (currentSkip) return currentSkip;
  if (stats?.reachable === false) return 'unreachable';
  return undefined;
}

export function skipLabel(reason: FleetSkipReason): string {
  switch (reason) {
    case 'offline':
      return 'offline';
    case 'no-address':
      return 'no address';
  }
}

export function runOnDevice(
  device: DeviceProfile,
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): { code: number | null; stdout: string; stderr: string } {
  try {
    const shim = writeAskpassShim();
    const { args, env } = buildSshInvocation(device, cmd, shim);
    const res = spawnSync('ssh', args, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: opts.timeoutMs ?? 600_000,
    });
    return {
      code: res.status,
      stdout: res.stdout?.toString() ?? '',
      stderr: (res.stderr?.toString() ?? '') + (res.error ? String(res.error.message) : ''),
    };
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runLocalCommand(
  cmd: string[],
  opts: { timeoutMs?: number } = {},
): { code: number | null; stdout: string; stderr: string } {
  try {
    const res = spawnSync(cmd.join(' '), {
      shell: true,
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? 600_000,
    });
    return {
      code: res.status,
      stdout: res.stdout?.toString() ?? '',
      stderr: (res.stderr?.toString() ?? '') + (res.error ? String(res.error.message) : ''),
    };
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

export function upgradeCommand(version?: string): string[] {
  if (version !== undefined && version !== '') {
    if (!FLEET_VERSION_RE.test(version)) {
      throw new Error(
        `Invalid version '${version}'. Use a semver or dist-tag (letters, digits, . _ - only).`,
      );
    }
    return ['agents', 'upgrade', version, '--yes'];
  }
  return ['agents', 'upgrade', '--yes'];
}

interface RunFleetOptions {
  self?: string;
  runner?: typeof runOnDevice;
  localRunner?: typeof runLocalCommand;
}

export function runFleet(
  targets: FleetTarget[],
  cmd: string[],
  opts: RunFleetOptions = {},
): FleetRunResult[] {
  const runner = opts.runner ?? runOnDevice;
  const localRunner = opts.localRunner ?? runLocalCommand;
  const results: FleetRunResult[] = [];
  for (const t of targets) {
    if (t.skip) {
      results.push({
        name: t.device.name,
        status: 'skipped',
        code: null,
        reason: t.skip,
      });
      continue;
    }
    try {
      const isSelf = (opts.self !== undefined && t.device.name === opts.self) || isSelfHost(t.device.name);
      const res = isSelf ? localRunner(cmd) : runner(t.device, cmd);
      const ok = res.code === 0;
      const detail = (res.stderr || res.stdout).trim().slice(0, 200);
      results.push({
        name: t.device.name,
        status: ok ? 'ok' : 'failed',
        code: res.code,
        detail: ok ? undefined : detail || undefined,
      });
    } catch (err) {
      results.push({
        name: t.device.name,
        status: 'failed',
        code: 1,
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
  return results;
}

interface FanOutDeviceOptions {
  perDeviceTimeoutMs?: number;
}

export async function fanOutDevices<T, Target extends FanOutDeviceTarget = FanOutDeviceTarget>(
  targets: Target[],
  probe: (target: Target) => Promise<T>,
  opts: FanOutDeviceOptions = {},
): Promise<FanOutDeviceResult<T>[]> {
  return Promise.all(targets.map(async (target) => {
    if (target.skip) {
      return {
        name: target.name,
        status: 'skipped' as const,
        reason: target.skip,
      };
    }
    try {
      let probePromise = probe(target);
      if (opts.perDeviceTimeoutMs) {
        const timeoutMs = opts.perDeviceTimeoutMs;
        probePromise = Promise.race([
          probePromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timed out')), timeoutMs),
          ),
        ]);
      }
      return {
        name: target.name,
        status: 'ok' as const,
        value: await probePromise,
      };
    } catch (err) {
      return {
        name: target.name,
        status: 'failed' as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
}
