
import type { JobConfig, HostStrategy } from './scheduling/routines.js';
import { resolveHostStrategy } from './scheduling/routines.js';
import { machineId, normalizeHost } from './machine-id.js';
import { loadDevicesSync, type DevicePlatform } from './devices/registry.js';
import { planFleetTargets } from './devices/fleet.js';

export type PlacementTarget =
  | { mode: 'local' }
  | { mode: 'host'; host: string }
  | { mode: 'cloud' };

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
    return platform ? null : machineId();
  }
  const self = machineId();
  const selfMatch = candidates.find((n) => normalizeHost(n) === self);
  if (selfMatch) return selfMatch;
  return [...candidates].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

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
      if (normalizeHost(config.host) === machineId()) return { mode: 'local' };
      return { mode: 'host', host: config.host };
    }
    case 'fleet': {
      let picked: string | null;
      if (config.host === 'auto') {
        const resolveAuto = deps.resolveDeviceAuto
          ?? (async (agent?: string) => (await import('./smart-launch.js')).resolveDeviceAuto(agent));
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
