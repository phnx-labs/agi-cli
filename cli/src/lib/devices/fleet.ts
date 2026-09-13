/**
 * Fleet-wide device operations — pick online targets and run a command on each.
 *
 * Used by `agents fleet update` / `agents fleet run` (aliases of the same
 * subcommands under `agents devices`). Offline devices are skipped with a
 * reason so a single dead node never blocks the rest of the rollout. Per-device
 * throws (misconfigured auth, etc.) become `failed` rows — they never abort
 * the remaining devices.
 */

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

/**
 * Classify each registered device for a fleet operation.
 *
 * - Tailscale-offline → skip `offline`
 * - No address → skip `no-address`
 * - Everything else is a target (including this machine, reached over ssh when
 *   it has a registry address — same path as any other box).
 */
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

/**
 * Remote fan-out targets for the fleet health/drift gates (`fleet status`,
 * `doctor --check --devices`): every planned device except this machine.
 * Offline / no-address devices are kept — those are genuine faults a gate should
 * surface — so their `skip` reason still flows through as an `unreachable` row.
 */
export function remoteFleetTargets(planned: FleetTarget[], self: string): FleetTarget[] {
  // Exclude self by name AND by full identity (tailscale dnsName, loopback): a
  // device referenced by its dnsName slipped past the bare name check and got a
  // remote version+doctor dial back to THIS box, which orphaned on timeout and
  // piled up (RUSH-2114). `isSelfHost` matches every alias the box answers to.
  return planned.filter((t) => t.device.name !== self && !isSelfHost(t.device.name));
}

/**
 * Decide whether a fleet-health target should skip the expensive version+doctor
 * dials (`agents fleet status`). The cheap stats probe (~2.5s, same registry
 * address) has already tried this box one step earlier. If it came back
 * unreachable, dialing `agents --version` (15s) + `agents doctor --json` (30s)
 * would almost certainly fail the same way — just 45s slower — so one
 * genuinely-offline box would stall the whole matrix (the ~60s hang, RUSH-1964).
 *
 * We trust the stats verdict on the DEFAULT path, not only under
 * `--refresh`/`--live`: `probeDeviceStats` and the version/doctor dials share
 * one ssh path (`fleetDialTarget`), so reachability is not per-probe. The
 * verdict is either freshly probed this run or daemon-warmed (~3min) with the
 * live write-back from RUSH-1965, so a box that came online in the last few
 * minutes is the only false-negative window — it renders `unreachable` until the
 * next stats warm, which beats letting it hang the status glance for 45s.
 *
 * An existing skip (offline/no-address from {@link planFleetTargets})
 * always wins — those are classified before any probe.
 */
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

/**
 * Run `cmd` on one device via the same ssh path as `agents ssh <name> …`.
 * Captures stdout/stderr (not inherited) so the fleet table can summarize.
 * Throws from buildSshInvocation are returned as a non-zero result so a single
 * misconfigured device cannot abort the fleet loop.
 */
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

/**
 * Run `cmd` on THIS machine directly — no ssh. Used by {@link runFleet} for the
 * self target: a box frequently can't ssh to itself (no self-authorized key, as
 * `agents fleet update` hit trying to reach zion from zion) and doesn't need to —
 * `agents upgrade` etc. runs identically as a local process. Mirrors
 * {@link runOnDevice}'s return shape and never throws. The argv is space-joined
 * and evaluated by a shell — matching the POSIX-shell ssh path (so PATH-resolved
 * `agents`, quoting, and `;`/`&&` behave the same). It does NOT replicate the
 * powershell-device encoding runOnDevice uses (`connect.ts` base64 path): a
 * Windows self runs under the default OS shell (cmd.exe), which still resolves
 * `agents` on PATH for the only self commands that matter (`agents upgrade …`).
 */
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

/**
 * Build `agents upgrade --yes` argv, optionally pinned to a version/dist-tag.
 * Rejects anything that is not a plain npm version/tag token so a version pin
 * cannot inject shell metacharacters into the remote command line.
 */
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
  /**
   * Name of THIS machine. Its target runs the command **locally** (no ssh) — a
   * box can't reliably ssh to itself and doesn't need to. Omit to ssh every
   * target (the old behaviour). Callers pass `machineId()`.
   */
  self?: string;
  /** Injectable ssh runner (tests). */
  runner?: typeof runOnDevice;
  /** Injectable local runner (tests). */
  localRunner?: typeof runLocalCommand;
}

/**
 * Execute a command across planned targets. Pure orchestration over
 * {@link runOnDevice} / {@link runLocalCommand}; testable by injecting either.
 * The `self` target runs locally so `agents fleet update` upgrades this machine
 * too instead of failing to ssh to itself. Per-device throws from a runner are
 * recorded as `failed` so one bad device never aborts the rest.
 */
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
  /**
   * Per-device deadline in milliseconds. When set, any probe that does not
   * settle within this window is abandoned via `Promise.race` against a
   * rejection timer and recorded as a `failed` result with the message
   * `'timed out'`. There is no AbortController — the underlying probe
   * continues running in the background; cancellation of the in-flight work
   * is the caller's responsibility. In practice `probeRemoteAuth` relies on
   * `sshExecAsync`'s own 15 s timer to kill the ssh child independently.
   * The per-device ssh timeout passed directly to {@link sshExecAsync} is
   * the first line of defence; this acts as a hard backstop so one slow
   * device can never stall the entire fan-out past its budget.
   */
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
