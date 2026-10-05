/** Routine placement (local / host / fleet / cloud). The scheduler decides only whether this
 * machine may fire a job; this decides where the body runs via `hostStrategy`. Fleet picks exactly
 * one online device per fire (RUSH-2035); double-fire is prevented by a `devices` firing pin. */

import type { JobConfig, HostStrategy } from './scheduling/routines.js';
import { resolveHostStrategy } from './scheduling/routines.js';
import { machineId, normalizeHost } from './machine-id.js';
import { loadDevicesSync, type DevicePlatform } from './devices/registry.js';
import { planFleetTargets } from './devices/fleet.js';

export type PlacementTarget =
  | { mode: 'local' }
  | { mode: 'host'; host: string }
  | { mode: 'cloud' };

/** Pick one online fleet device for `hostStrategy: fleet`: this machine if eligible, else the first
 * eligible by name. `config.devices` is only the FIRING allowlist, not an execution pool, or the
 * double-fire pin (`devices: [self]`) would make fleet always local. */
export function pickFleetDevice(
  _config?: Pick<JobConfig, 'devices'>,
  platform?: DevicePlatform,
): string | null {
  let reg: ReturnType<typeof loadDevicesSync>;
  try {
    reg = loadDevicesSync();
  } catch {
    return null;
  }
  const planned = planFleetTargets(reg);
  const candidates = planned
    .filter((t) => !t.skip && (!platform || t.device.platform === platform))
    .map((t) => t.device.name);
  if (candidates.length === 0) {
    // No registry or nothing online: fall back to self so a single-box fleet still runs locally,
    // but only with no platform filter; an unmet filter must fail loud so `fleet/linux` never lands
    // on a macOS box.
    return platform ? null : machineId();
  }
  const self = machineId();
  const selfMatch = candidates.find((n) => normalizeHost(n) === self);
  if (selfMatch) return selfMatch;
  return [...candidates].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

/** Resolve where a fired job's body executes; throws a readable Error if unsatisfiable. `host:
 * 'auto'` under fleet re-picks a healthy, signed-in device AT EACH FIRE via `resolveDeviceAuto`,
 * not at add time (RUSH-2719). */
export async function resolvePlacementTarget(
  config: JobConfig,
  deps: { resolveDeviceAuto?: (agent?: string) => Promise<{ pickedDeviceKey: string }> } = {},
): Promise<PlacementTarget> {
  const strategy: HostStrategy = resolveHostStrategy(config);
  switch (strategy) {
    case 'local':
      return { mode: 'local' };
    case 'host': {
      if (!config.host || config.host.trim() === '') {
        throw new Error(
          `Routine '${config.name}' has hostStrategy: host but no host: — set host: or --run-on`,
        );
      }
      // host: pointing at this machine is local execution (no SSH loop).
      if (normalizeHost(config.host) === machineId()) return { mode: 'local' };
      return { mode: 'host', host: config.host };
    }
    case 'fleet': {
      let picked: string | null;
      if (config.host === 'auto') {
        const resolveAuto = deps.resolveDeviceAuto
          ?? (async (agent?: string) => (await import('./smart-launch.js')).resolveDeviceAuto(agent));
        // resolveDeviceAuto fails loud on an empty/unhealthy pool — surface its
        // message (it names each excluded device) instead of a generic one.
        const plan = await resolveAuto(config.agent);
        picked = plan.pickedDeviceKey;
      } else {
        picked = pickFleetDevice(config);
      }
      if (!picked) {
        throw new Error(
          `Routine '${config.name}' hostStrategy: fleet — no eligible online device to place the run`,
        );
      }
      if (normalizeHost(picked) === machineId()) return { mode: 'local' };
      return { mode: 'host', host: picked };
    }
    case 'cloud':
      return { mode: 'cloud' };
  }
}
