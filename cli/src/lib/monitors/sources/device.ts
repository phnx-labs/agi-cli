
import { loadDevices } from '../../devices/registry.js';
import { probeDeviceStats, probeLocalStats, headroom } from '../../devices/health.js';
import { machineId, normalizeHost } from '../../machine-id.js';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

export async function evaluate(source: MonitorSource): Promise<Observation | null> {
  const name = source.device;
  if (!name) return null;

  const registry = await loadDevices();
  const wanted = normalizeHost(name);
  const entry = Object.entries(registry).find(([k]) => normalizeHost(k) === wanted);

  if (!entry) {
    return {
      raw: `error\tdevice not registered: ${name}`,
      meta: { error: true, reachable: false, device: name },
    };
  }

  const stats = normalizeHost(entry[0]) === machineId()
    ? await probeLocalStats(name)
    : await probeDeviceStats(entry[1]);

  const bucket = headroom(stats);
  return {
    raw: `${stats.reachable ? 'reachable' : 'unreachable'}\t${bucket}`,
    meta: {
      reachable: stats.reachable,
      headroom: bucket,
      loadPercent: stats.loadPercent,
      memPercent: stats.memPercent,
      ncpu: stats.ncpu,
    },
  };
}
