
import { queryAffinityRollup, type AffinityRow } from './session/db.js';
import { localMachineId } from './session/origin-machine.js';
import { loadDevicesSync } from './devices/registry.js';
import { autoLaunchPreferredSet, describeAutoPool, filterAutoPool, isAutoPoolMember } from './devices/pool.js';
import { normalizeHost } from './machine-id.js';
import { probePoolSignals } from './teams/placement-probe.js';
import { pickBestDevice, type DevicePlacementSignal } from './teams/scheduler.js';
import type { AgentType } from './teams/agents.js';

const DEFAULT_AFFINITY_ALPHA = 1.3;

export interface WeightedCandidate {
  key: string;
  launches: number;
  weight: number;
}

export function affinityWeights(
  rows: AffinityRow[],
  alpha: number = DEFAULT_AFFINITY_ALPHA,
): WeightedCandidate[] {
  return rows
    .filter((r) => r.launches > 0 && r.key && r.key !== '(unknown)')
    .map((r) => ({
      key: r.key,
      launches: r.launches,
      weight: Math.max(1, Math.pow(r.launches, alpha)),
    }));
}

export function sampleWeighted(
  candidates: WeightedCandidate[],
  rng: () => number = Math.random,
): string | null {
  if (candidates.length === 0) return null;
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return candidates[0].key;
  let roll = rng() * total;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) return c.key;
  }
  return candidates[candidates.length - 1].key;
}

export function listOnlineDeviceNames(localName: string = localMachineId()): string[] {
  // Automatic placement uses the worker-role allowlist; personal machines are not implicit fallbacks.
  const names = new Set<string>([normalizeHost(localName)]);
  try {
    const reg = loadDevicesSync();
    for (const [name, d] of Object.entries(reg)) {
      if (!d || typeof d !== 'object') continue;
      const online = d.tailscale?.online;
      if (online === false) continue;
      names.add(normalizeHost(name));
    }
  } catch {
  }
  return filterAutoPool([...names]);
}

interface DeviceAffinityOptions {
  sinceDays?: number;
  alpha?: number;
  eligibleHosts?: string[];
  localMachine?: string;
  deviceAffinity?: AffinityRow[];
  rng?: () => number;
  project?: string;
}

export interface DeviceAffinityPlan {
  host: string | null;
  deviceCandidates: WeightedCandidate[];
  pickedDeviceKey: string | null;
}

interface DeviceAutoPlan {
  host: string | null;
  candidates: Array<{ key: string; loadPercent?: number; installed?: boolean; signedIn?: boolean }>;
  pickedDeviceKey: string;
}

export function formatEmptyAutoPoolError(): string {
  const marked = describeAutoPool();
  return (
    `agents: no device is eligible for automatic placement${marked ? ` (${marked})` : ''} — ` +
    'mark one with `agents devices role <name> worker`, or widen the pool with `agents config set auto.pool all`.'
  );
}

export function formatNoHealthyDeviceError(
  pool: string[],
  signals: Map<string, DevicePlacementSignal>,
  agent?: string,
): string {
  let timedOutCount = 0;
  const excluded = pool.map((key) => {
    const signal = signals.get(key);
    let reason: string;
    if (signal?.reachable === true) {
      reason = signal.headroom === 'loaded'
        ? 'overloaded'
        : signal.installed !== true || signal.signedIn !== true
          ? `no ready harness account${signal.reason ? ` (${signal.reason})` : ''}`
          : 'ineligible';
    } else if (signal?.timedOut) {
      timedOutCount++;
      reason = 'probe timed out';
    } else if (signal === undefined) {
      reason = 'no probe signal';
    } else {
      reason = 'unreachable';
    }
    return `${key} (${reason})`;
  }).join(', ');
  const target = agent ? `can run ${agent}` : "for 'run auto'";
  const marked = describeAutoPool({ roster: pool });
  const poolNote = marked ? ` [pool: ${marked}]` : '';
  const scope = timedOutCount === pool.length
    ? `every probe (${pool.length}) exceeded`
    : `${timedOutCount} of ${pool.length} probes exceeded`;
  const hint = timedOutCount > 0
    ? `; ${scope} the probe budget — those devices are likely up but slow to answer`
      + ' (relayed Tailscale paths). Retry, or check `tailscale status` for a direct path.'
    : '; earliest window resets unknown';
  return `agents: no healthy device ${target}${poolNote} — excluded: ${excluded}${hint}`;
}

export async function resolveDeviceAuto(
  agent?: string,
  opts: {
    eligibleHosts?: string[];
    localMachine?: string;
    accountPicker?: boolean;
    probe?: (pool: string[], agent?: AgentType) => Promise<Map<string, DevicePlacementSignal>>;
    preferred?: ReadonlySet<string>;
  } = {},
): Promise<DeviceAutoPlan> {
  // Local is probed for the same health and harness readiness as peers and participates only when pool-eligible.
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const pool = [...new Set((opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost))];
  if (!pool.includes(local) && isAutoPoolMember(local)) pool.push(local);
  // An empty default pool fails loud instead of silently launching on the personal machine.
  if (pool.length === 0) throw new Error(formatEmptyAutoPoolError());

  const signals = await (opts.probe ?? probePoolSignals)(pool, agent as AgentType | undefined);
  if (!agent && !opts.probe) {
    const { collectFleetHarnesses } = await import('../commands/ssh.js');
    const inventory = await collectFleetHarnesses({ devices: pool });
    const byHost = new Map(inventory.map((result) => [normalizeHost(result.host), result]));
    for (const key of pool) {
      const result = byHost.get(key);
      const accountEligible = !!result && !result.error && !result.skipped && result.rows.some((row) => row.ready);
      const current = signals.get(key);
      if (current) signals.set(key, { ...current, installed: accountEligible, signedIn: accountEligible });
    }
  }
  const eligiblePool = pool.filter((key) => {
    const signal = signals.get(key);
    if (signal?.reachable !== true || signal.headroom === 'loaded') return false;
    if (!agent) return opts.probe ? true : signal.installed === true && signal.signedIn === true;
    return signal.installed === true && (opts.accountPicker === true
      ? signal.pickerEligible === true
      : signal.signedIn === true);
  });
  if (eligiblePool.length === 0) {
    throw new Error(formatNoHealthyDeviceError(pool, signals, agent));
  }
  const preferred = opts.preferred ?? autoLaunchPreferredSet(pool, { roster: pool });
  const picked = pickBestDevice(eligiblePool, [], { signals, agentLabel: agent, preferred });
  return {
    host: picked === local ? null : picked,
    pickedDeviceKey: picked,
    candidates: pool.map((key) => ({
      key,
      loadPercent: signals.get(key)?.loadPercent,
      installed: signals.get(key)?.installed,
      signedIn: signals.get(key)?.signedIn,
    })),
  };
}

export function resolveDeviceAffinity(opts: DeviceAffinityOptions = {}): DeviceAffinityPlan {
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const alpha = opts.alpha ?? DEFAULT_AFFINITY_ALPHA;
  const rng = opts.rng ?? Math.random;
  const sinceDays = opts.sinceDays ?? 14;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  const usingDefaultPool = opts.eligibleHosts === undefined;
  const eligible = new Set(
    (opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost),
  );
  if (eligible.size === 0) {
    // An explicitly supplied empty affinity list retains the legacy local behavior.
    if (usingDefaultPool) throw new Error(formatEmptyAutoPoolError());
    eligible.add(local);
  }

  const deviceRows =
    opts.deviceAffinity ??
    queryAffinityRollup({
      groupBy: 'machine',
      sinceMs,
      excludeTeamOrigin: true,
      onlyCli: true,
      project: opts.project,
    });

  const launchesByHost = new Map<string, number>();
  for (const r of deviceRows) {
    const k = normalizeHost(r.key);
    if (!eligible.has(k) || k === '(unknown)') continue;
    launchesByHost.set(k, (launchesByHost.get(k) ?? 0) + r.launches);
  }
  let deviceWeights: WeightedCandidate[] = [...eligible].map((key) => {
    const launches = launchesByHost.get(key) ?? 0;
    return {
      key,
      launches,
      weight: launches > 0 ? Math.max(1, Math.pow(launches, alpha)) : 1,
    };
  });
  if (deviceWeights.length === 0) {
    deviceWeights = [{ key: local, launches: 1, weight: 1 }];
  }

  const pickedDeviceKey = sampleWeighted(deviceWeights, rng);
  const hostNorm = pickedDeviceKey ? normalizeHost(pickedDeviceKey) : local;
  const host = hostNorm === local ? null : hostNorm;

  return {
    host,
    deviceCandidates: deviceWeights,
    pickedDeviceKey,
  };
}

export function isDeviceAuto(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'auto';
}

const HOST_SLOTS = ['host', 'device', 'on', 'computer'] as const;

type DeviceAutoHostOptions = {
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  balanced?: boolean;
  strategy?: string;
};

export type DeviceAutoApplyResult = {
  attempted: boolean;
  banner?: {
    hostLabel: string;
    deviceHint: string;
    acctNote: string;
  };
};

export async function applyDeviceAutoToOptions(
  options: DeviceAutoHostOptions,
  deps: {
    resolve?: (accountPicker: boolean) => DeviceAutoPlan | Promise<DeviceAutoPlan>;
    agent?: string;
    accountPickerRequested?: boolean;
  } = {},
): Promise<DeviceAutoApplyResult> {
  const hasAuto = HOST_SLOTS.some((k) => isDeviceAuto(options[k]));
  if (!hasAuto) {
    return { attempted: false };
  }

  const accountPickerRequested = deps.accountPickerRequested ?? false;
  const resolve: (accountPicker: boolean) => DeviceAutoPlan | Promise<DeviceAutoPlan> =
    deps.resolve ?? ((accountPicker) => resolveDeviceAuto(deps.agent, { accountPicker }));
  // Placement failures propagate; never rewrite unresolved auto placement into a local launch.
  const plan = await resolve(accountPickerRequested);
  const concrete = plan.host;
  for (const k of HOST_SLOTS) {
    if (isDeviceAuto(options[k])) {
      options[k] = concrete ?? undefined;
    }
  }
  if (!accountPickerRequested && !options.strategy && !options.balanced) {
    options.balanced = true;
  }
  const hostLabel = concrete ?? 'local';
  const deviceHint = plan.candidates
    .slice(0, 4)
    .map((c) => `${c.key}:${c.loadPercent === undefined ? '?' : `${Math.round(c.loadPercent)}%`}`)
    .join(', ');
  const acctNote = accountPickerRequested ? 'accounts=picker' : 'accounts=balanced';
  return {
    attempted: true,
    banner: { hostLabel, deviceHint, acctNote },
  };
}
