/** Fleet-wide device operations: pick online targets and run a command on each, for `agents fleet
 * update` / `agents fleet run`. Offline devices are skipped with a reason; per-device throws
 * become `failed` rows and never abort the rest. */

import { spawnSync } from 'child_process';
import type { DeviceProfile, DeviceRegistry } from './registry.js';
import { isSelfHost } from './self-host.js';
import { buildSshInvocation, sshTargetFor, writeAskpassShim } from './connect.js';
import type { DeviceStats } from './health.js';

export type FleetSkipReason = 'offline' | 'no-address';

/** npm dist-tags / semver pins only — rejects shell metacharacters. */
const FLEET_VERSION_RE = /^[A-Za-z0-9._-]+$/;

export interface FleetTarget {
  device: DeviceProfile;
  /** When set, this device is not reached (skip with reason). */
  skip?: FleetSkipReason;
}

export interface FleetRunResult {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  code: number | null;
  reason?: FleetSkipReason | string;
  /** Truncated combined stderr/stdout for failures. */
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

/** Classify each registered device for a fleet operation: Tailscale-offline is skipped `offline`,
 * no address is skipped `no-address`, everything else is a target, including this machine (reached
 * over ssh via its registry address). */
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

/** Remote fan-out targets for the fleet health/drift checks (`fleet status`, `doctor --check
 * --devices`): every planned device except this machine. Offline and no-address devices are kept
 * as genuine faults; their `skip` reason flows through as an `unreachable` row. */
export function remoteFleetTargets(planned: FleetTarget[], self: string): FleetTarget[] {
  // Exclude self by name and by full identity (dnsName, loopback): a device referenced by dnsName
  // slipped past the name check and dialed back to this box, orphaning on timeout and piling up
  // (RUSH-2114). `isSelfHost` matches every alias the box answers to.
  return planned.filter((t) => t.device.name !== self && !isSelfHost(t.device.name));
}

/** Decide whether a fleet-health target skips the expensive version+doctor dials. The cheap stats
 * probe (~2.5s) already tried this box; if unreachable, the 15s + 30s dials would fail the same
 * way and stall the matrix (RUSH-1964). Trusted on the default path: one ssh path (RUSH-1965). */
export function fleetHealthSkip(
  currentSkip: FleetSkipReason | string | undefined,
  stats: DeviceStats | undefined,
): FleetSkipReason | string | undefined {
  if (currentSkip) return currentSkip;
  if (stats?.reachable === false) return 'unreachable';
  return undefined;
}

/** Human label for a skip reason. */
export function skipLabel(reason: FleetSkipReason): string {
  switch (reason) {
    case 'offline':
      return 'offline';
    case 'no-address':
      return 'no address';
  }
}

/** Run `cmd` on one device via the same ssh path as `agents ssh <name>`, capturing stdout/stderr
 * for the fleet table. Throws from buildSshInvocation return a non-zero result so one
 * misconfigured device cannot abort the loop. */
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

/** Run `cmd` on this machine directly, no ssh, for {@link runFleet}'s self target: a box often
 * cannot ssh to itself (no self-authorized key). Same return shape as {@link runOnDevice}; never
 * throws. Argv is space-joined and shell-evaluated like the POSIX ssh path. */
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

/** Build `agents upgrade --yes` argv, optionally pinned to a version/dist-tag. Rejects anything but
 * a plain npm version/tag token so a pin cannot inject shell metacharacters. */
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
  /** Name of this machine. Its target runs the command locally (no ssh), since a box cannot
   * reliably ssh to itself. Omit to ssh every target. Callers pass `machineId()`. */
  self?: string;
  /** Injectable ssh runner (tests). */
  runner?: typeof runOnDevice;
  /** Injectable local runner (tests). */
  localRunner?: typeof runLocalCommand;
}

/** Execute a command across planned targets; pure orchestration over {@link runOnDevice} / {@link
 * runLocalCommand}, injectable for tests. The `self` target runs locally so `agents fleet update`
 * upgrades this machine too. A runner throw is recorded as `failed` and never aborts the rest. */
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
  /** Per-device deadline in ms: a probe not settled in time is abandoned via `Promise.race` and
   * recorded `failed` with `'timed out'`. No AbortController: the probe keeps running and
   * cancelling it is the caller's job. A backstop so one slow device cannot stall the fan-out. */
  perDeviceTimeoutMs?: number;
}

/** Run one async probe per device in parallel, preserving input order. */
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
