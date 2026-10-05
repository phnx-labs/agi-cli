import { machineId } from '../machine-id.js';
import type { Headroom } from '../devices/health.js';

export interface DevicePlacementSignal {
  reachable?: boolean;
  timedOut?: boolean;
  headroom?: Headroom;
  loadPercent?: number;
  memPercent?: number;
  installed?: boolean;
  signedIn?: boolean;
  pickerEligible?: boolean;
  reason?: string;
}

interface PlacementTeam {
  devices?: string[];
}

interface PlacementOptions {
  defaultDevices?: string[];
  maxConcurrent?: Record<string, number>;
  signals?: Map<string, DevicePlacementSignal>;
  agentLabel?: string;
  preferred?: ReadonlySet<string>;
}

type ExclusionReason = 'unreachable' | 'probe-timed-out' | 'overloaded' | 'capped' | 'not-installed';

interface ExcludedDevice {
  device: string;
  reason: ExclusionReason;
  detail?: string;
}

export class NoViableDeviceError extends Error {
  readonly excluded: ExcludedDevice[];
  readonly agentLabel?: string;
  constructor(excluded: ExcludedDevice[], agentLabel?: string) {
    super(formatNoViableMessage(excluded, agentLabel));
    this.name = 'NoViableDeviceError';
    this.excluded = excluded;
    this.agentLabel = agentLabel;
  }
}

export function isTransientPlacementBlock(error: unknown): error is NoViableDeviceError {
  return error instanceof NoViableDeviceError
    && error.excluded.some((entry) => entry.reason === 'capped' || entry.reason === 'overloaded');
}

export function formatNoViableMessage(excluded: ExcludedDevice[], agentLabel?: string): string {
  const anyNotInstalled = excluded.some((e) => e.reason === 'not-installed');
  const allCapped = excluded.length > 0 && excluded.every((e) => e.reason === 'capped');
  const agent = agentLabel ?? 'the requested agent';
  const perDevice = excluded
    .map((e) => (e.detail ? `${e.device} (${e.reason} ${e.detail})` : `${e.device} (${e.reason})`))
    .join(', ');
  const head = anyNotInstalled
    ? `No device in the team pool can run ${agent}.`
    : allCapped
      ? `Every device in the pool is at its agents.max-concurrent cap:`
    : `No viable device in the team pool for ${agent}.`;
  const anyUnreachable = excluded.some((e) => e.reason === 'unreachable');
  const hint = anyNotInstalled
    ? " Run 'agents devices ping' to see which devices have the agent installed + signed in, or add the agent to a pool device."
    : anyUnreachable
      ? " Add a device to the pool, raise a cap, or wait for the pool to free up / come back online ('agents devices ping')."
      : allCapped
        ? " Raise a cap with 'agents devices config <name> agents.max-concurrent N' or add a device to the pool."
        : ' Add a device to the pool, raise a cap, or bring an overloaded box under load.';
  const reasons = allCapped
    ? excluded.map((e) => `${e.device} (${e.detail})`).join(', ')
    : perDevice;
  return `${head} ${reasons}.${hint}`;
}

export interface RosterEntry {
  hostName: string | null;
  status: string;
}

function isLocalDevice(device: string): boolean {
  return device.toLowerCase() === machineId();
}

function loadByDevice(devices: string[], roster: RosterEntry[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const d of devices) load.set(d, 0);
  for (const r of roster) {
    if (r.status !== 'running') continue;
    const host = r.hostName ? r.hostName : devices.find((d) => isLocalDevice(d));
    if (!host) continue;
    if (load.has(host)) load.set(host, (load.get(host) ?? 0) + 1);
  }
  return load;
}

export function cappedDevices(
  devices: string[],
  roster: RosterEntry[],
  maxConcurrent: Record<string, number>,
): Array<{ device: string; running: number; cap: number }> {
  const load = loadByDevice(devices, roster);
  const capped: Array<{ device: string; running: number; cap: number }> = [];
  for (const d of devices) {
    const cap = maxConcurrent[d];
    if (cap === undefined) continue;
    const running = load.get(d) ?? 0;
    if (running >= cap) capped.push({ device: d, running, cap });
  }
  return capped;
}

export function pickLeastLoaded(
  devices: string[],
  roster: RosterEntry[],
  maxConcurrent?: Record<string, number>,
): string {
  if (devices.length === 0) {
    throw new Error('pickLeastLoaded called with an empty device pool');
  }
  const load = loadByDevice(devices, roster);
  const capped = new Set(
    maxConcurrent ? cappedDevices(devices, roster, maxConcurrent).map((c) => c.device) : [],
  );
  const eligible = devices.filter((d) => !capped.has(d));
  if (eligible.length === 0) {
    throw new NoViableDeviceError(devices.map((device) => ({
      device,
      reason: 'capped' as const,
      detail: `${load.get(device) ?? 0}/${maxConcurrent![device]}`,
    })));
  }
  let best = eligible[0];
  let bestLoad = load.get(best) ?? 0;
  for (const d of eligible) {
    const l = load.get(d) ?? 0;
    if (l < bestLoad) {
      best = d;
      bestLoad = l;
    }
  }
  return best;
}

function loadCost(s: DevicePlacementSignal | undefined): number | undefined {
  if (!s) return undefined;
  const vals = [s.loadPercent, s.memPercent].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.max(...vals) : undefined;
}

function headroomTier(h: Headroom | undefined): number {
  switch (h) {
    case 'idle': return 0;
    case 'light': return 1;
    case 'busy': return 3;
    default: return 2;
  }
}

export function classifyExclusions(
  devices: string[],
  roster: RosterEntry[],
  opts?: PlacementOptions,
): { eligible: string[]; excluded: ExcludedDevice[] } {
  const load = loadByDevice(devices, roster);
  const caps = opts?.maxConcurrent ?? {};
  const signals = opts?.signals;
  const eligible: string[] = [];
  const excluded: ExcludedDevice[] = [];
  for (const d of devices) {
    const s = signals?.get(d);
    if (s?.reachable === false) {
      excluded.push({ device: d, reason: s.timedOut ? 'probe-timed-out' : 'unreachable' });
      continue;
    }
    if (s?.installed === false) {
      excluded.push({ device: d, reason: 'not-installed' });
      continue;
    }
    if (s?.headroom === 'loaded') {
      excluded.push({ device: d, reason: 'overloaded' });
      continue;
    }
    const cap = caps[d];
    if (cap !== undefined && (load.get(d) ?? 0) >= cap) {
      excluded.push({ device: d, reason: 'capped', detail: `${load.get(d) ?? 0}/${cap}` });
      continue;
    }
    eligible.push(d);
  }
  return { eligible, excluded };
}

export function pickBestDevice(
  devices: string[],
  roster: RosterEntry[],
  opts?: PlacementOptions,
): string {
  if (devices.length === 0) {
    throw new Error('pickBestDevice called with an empty device pool');
  }
  const load = loadByDevice(devices, roster);
  const { eligible, excluded } = classifyExclusions(devices, roster, opts);
  if (eligible.length === 0) {
    const onlyUnreachable = excluded.every((e) => e.reason === 'unreachable');
    if (!onlyUnreachable) {
      throw new NoViableDeviceError(excluded, opts?.agentLabel);
    }
    let fallback = devices[0];
    let fallbackLoad = load.get(fallback) ?? 0;
    for (const d of devices) {
      const l = load.get(d) ?? 0;
      if (l < fallbackLoad) {
        fallback = d;
        fallbackLoad = l;
      }
    }
    return fallback;
  }
  const signals = opts?.signals;
  const order = new Map(devices.map((d, i) => [d, i]));
  return [...eligible].sort((a, b) => {
    const sa = signals?.get(a);
    const sb = signals?.get(b);
    const signedIn = (sa?.signedIn === true ? 0 : 1) - (sb?.signedIn === true ? 0 : 1);
    if (signedIn !== 0) return signedIn;
    const preferred = opts?.preferred;
    if (preferred && preferred.size > 0) {
      const pref = (preferred.has(a) ? 0 : 1) - (preferred.has(b) ? 0 : 1);
      if (pref !== 0) return pref;
    }
    const tier = headroomTier(sa?.headroom) - headroomTier(sb?.headroom);
    if (tier !== 0) return tier;
    const teammates = (load.get(a) ?? 0) - (load.get(b) ?? 0);
    if (teammates !== 0) return teammates;
    const cost = (loadCost(sa) ?? 50) - (loadCost(sb) ?? 50);
    if (cost !== 0) return cost;
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  })[0];
}

export function resolvePlacement(
  team: PlacementTeam,
  explicitDevice: string | null,
  roster: RosterEntry[],
  opts?: PlacementOptions,
): { device: string | null } {
  if (explicitDevice) {
    return { device: isLocalDevice(explicitDevice) ? null : explicitDevice };
  }
  const pool = team.devices?.length ? team.devices : (opts?.defaultDevices ?? []);
  if (pool.length === 0) throw new NoViableDeviceError([], opts?.agentLabel);
  if (pool.length === 1) {
    if (opts?.signals?.get(pool[0])?.installed === false) {
      throw new NoViableDeviceError([{ device: pool[0], reason: 'not-installed' }], opts.agentLabel);
    }
    return { device: isLocalDevice(pool[0]) ? null : pool[0] };
  }
  const picked = opts?.signals
    ? pickBestDevice(pool, roster, opts)
    : pickLeastLoaded(pool, roster, opts?.maxConcurrent);
  return { device: isLocalDevice(picked) ? null : picked };
}
