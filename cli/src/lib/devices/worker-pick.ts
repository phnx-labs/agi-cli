import { normalizeHost } from '../machine-id.js';
import { localMachineId } from '../session/origin-machine.js';
import { loadDevicesSync } from './registry.js';
import { autoLaunchPreferredSet, isAutoPoolMember } from './pool.js';
import { blocksPlacement } from './health.js';
import {
  formatEmptyAutoPoolError,
  listOnlineDeviceNames,
} from '../smart-launch.js';
import { pickBestDevice, type DevicePlacementSignal } from '../teams/scheduler.js';
import { probePoolSignals } from '../teams/placement-probe.js';

export interface WorkerExclusion {
  device: string;
  reason: 'unreachable' | 'probe timed out' | 'overloaded' | 'disk low' | 'wrong-platform' | 'interactive';
}

interface WorkerPickPlan {
  device: string;
  isLocal: boolean;
  candidates: Array<{ device: string; loadPercent?: number; headroom?: string }>;
  excluded: WorkerExclusion[];
}

interface WorkerPickOptions {
  platforms?: string[];
  eligibleHosts?: string[];
  localMachine?: string;
  probe?: (pool: string[], force?: boolean) => Promise<Map<string, DevicePlacementSignal>>;
  preferred?: ReadonlySet<string>;
}

const POSIX_PLATFORMS = ['linux', 'macos'] as const;

export async function resolveWorkerDevice(opts: WorkerPickOptions = {}): Promise<WorkerPickPlan> {

  const local = normalizeHost(opts.localMachine ?? localMachineId());

  const pool = [...new Set((opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost))];
  if (!pool.includes(local) && isAutoPoolMember(local)) pool.push(local);
  if (pool.length === 0) throw new Error(formatEmptyAutoPoolError());

  const excluded: WorkerExclusion[] = [];

  const wanted = new Set((opts.platforms ?? POSIX_PLATFORMS).map((p) => p.toLowerCase()));
  const reg = loadDevicesSync();
  const platformOf = (name: string): string | undefined => {
    const d = reg[name] ?? reg[normalizeHost(name)]
      ?? Object.values(reg).find((p) => p && normalizeHost(p.name) === normalizeHost(name));
    return d?.platform ? String(d.platform).toLowerCase() : undefined;
  };

  const onPlatform = pool.filter((device) => {
    const platform = platformOf(device);
    if (platform && !wanted.has(platform)) {
      excluded.push({ device, reason: 'wrong-platform' });
      return false;
    }
    return true;
  });
  if (onPlatform.length === 0) throw new Error(formatNoWorkerError(excluded, wanted));

  const probe = opts.probe ?? ((p: string[], force?: boolean) => probePoolSignals(p, undefined, { force }));
  let signals = await probe(onPlatform);
  if (!onPlatform.some((device) => isWorkerEligible(signals.get(device))) && [...signals.values()].some((s) => s.fromSnapshot)) {
    signals = await probe(onPlatform, true);
  }
  const eligible = onPlatform.filter((device) => {
    const signal = signals.get(device);

    if (signal?.reachable !== true) {
      excluded.push({ device, reason: signal?.timedOut ? 'probe timed out' : 'unreachable' });
      return false;
    }
    if (blocksPlacement(signal.headroom)) {
      excluded.push({ device, reason: signal.headroom === 'disk-low' ? 'disk low' : 'overloaded' });
      return false;
    }
    return true;
  });
  if (eligible.length === 0) throw new Error(formatNoWorkerError(excluded, wanted));

  const preferred = opts.preferred ?? autoLaunchPreferredSet(onPlatform, { roster: onPlatform });
  const device = pickBestDevice(eligible, [], { signals, preferred });
  return {
    device,
    isLocal: normalizeHost(device) === local,
    candidates: onPlatform.map((key) => ({
      device: key,
      loadPercent: signals.get(key)?.loadPercent,
      headroom: signals.get(key)?.headroom,
    })),
    excluded,
  };
}

function isWorkerEligible(signal: DevicePlacementSignal | undefined): boolean {
  return signal?.reachable === true && !blocksPlacement(signal.headroom);
}

export function formatNoWorkerError(excluded: WorkerExclusion[], platforms: Set<string>): string {
  const detail = excluded.length
    ? excluded.map((e) => `${e.device} (${e.reason})`).join(', ')
    : 'none';
  return (
    `agents: no worker device is available for offloaded work `
    + `[platforms: ${[...platforms].sort().join(', ')}] — excluded: ${detail}. `
    + 'Mark a worker with `agents devices role <name> worker`, or name one explicitly.'
  );
}
