/**
 * Device placement for `--device auto`.
 *
 * Explicit auto placement probes live fleet health and harness readiness.
 * Historical affinity remains for generic host resolution callers.
 * Account selection is separate (`--strategy balanced` / rotate.ts).
 */

import { queryAffinityRollup, type AffinityRow } from './session/db.js';
import { localMachineId } from './session/origin-machine.js';
import { loadDevicesSync } from './devices/registry.js';
import { autoLaunchPreferredSet, describeAutoPool, filterAutoPool, isAutoPoolMember } from './devices/pool.js';
import { normalizeHost } from './machine-id.js';
import { probePoolSignals } from './teams/placement-probe.js';
import { pickBestDevice, type DevicePlacementSignal } from './teams/scheduler.js';
import type { AgentType } from './teams/agents.js';

/** Peakiness of usage weights; >1 amplifies the most-used option. */
export const DEFAULT_AFFINITY_ALPHA = 1.3;

export interface WeightedCandidate {
  key: string;
  launches: number;
  weight: number;
}

/**
 * Convert affinity rows into positive weights: launches^α (floor 1 for any
 * row with launches > 0 so a single-use host still participates).
 */
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

/**
 * Weighted random sample. Returns null when candidates is empty.
 * Pure — inject `rng` for tests.
 */
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

/**
 * Online device names from the local registry (+ local), narrowed to the
 * automatic-placement pool.
 *
 * The pool rule lives in `devices/pool.ts` and is an allowlist once any device
 * is marked `role=worker`: this is the single place both automatic-placement
 * paths (`resolveDeviceAuto`, `resolveDeviceAffinity`) get their candidates, so
 * marking workers moves every `--device auto` at once instead of one surface.
 *
 * It CAN return an empty list — a fleet where every marked worker is
 * offline, or where this box is the only candidate and is marked `personal`. That is a
 * real answer, and both callers fail loud on it rather than falling back to the
 * local machine (which would be the exact box the operator marked personal to
 * keep agents off).
 */
export function listOnlineDeviceNames(localName: string = localMachineId()): string[] {
  const names = new Set<string>([normalizeHost(localName)]);
  try {
    const reg = loadDevicesSync();
    for (const [name, d] of Object.entries(reg)) {
      if (!d || typeof d !== 'object') continue;
      const online = d.tailscale?.online;
      // No tailscale snapshot → treat as candidate (registry-only box).
      if (online === false) continue;
      names.add(normalizeHost(name));
    }
  } catch {
    /* registry missing — local only */
  }
  return filterAutoPool([...names]);
}

export interface DeviceAffinityOptions {
  sinceDays?: number;
  alpha?: number;
  /**
   * Eligible hosts (normalized). Defaults to the automatic-placement pool
   * (online devices + local, narrowed by device roles). An explicitly empty
   * list falls back to local — the caller supplied it; an empty DEFAULT pool
   * throws, because roles emptied it on purpose.
   */
  eligibleHosts?: string[];
  localMachine?: string;
  /** Injected affinity (tests). When omitted, reads sessions.db. */
  deviceAffinity?: AffinityRow[];
  rng?: () => number;
  project?: string;
}

export interface DeviceAffinityPlan {
  /** null means run locally (do not pass --device). */
  host: string | null;
  deviceCandidates: WeightedCandidate[];
  pickedDeviceKey: string | null;
}

/** Live placement plan used by the explicit `--device auto` surface. */
export interface DeviceAutoPlan {
  /** Target-local eligible account selectors to preserve across dispatch. */
  accounts?: string[];
  /** null means the local machine won the comparison. */
  host: string | null;
  candidates: Array<{ key: string; loadPercent?: number; installed?: boolean; signedIn?: boolean }>;
  pickedDeviceKey: string;
}

/**
 * The error both automatic-placement resolvers raise when device roles leave no
 * candidate at all. Fail loud: the alternative — quietly running on the local
 * machine — puts the agent on the box the operator marked `personal`.
 */
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
          ? 'no ready harness account'
          : 'ineligible';
    } else if (signal?.timedOut) {
      // A slow link is not an offline box. Saying "unreachable" here sent
      // operators hunting a fleet outage that did not exist (PHNX-3682).
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
  // Name the role narrowing when there is one: a fleet where every box but two
  // is filtered out by a worker mark reads as "the fleet is down" without it.
  // Roster on `pool` so a fleet-wide role default reaches a doc-less device
  // in this error's own candidate set, not just the ones with a doc.
  const marked = describeAutoPool({ roster: pool });
  const poolNote = marked ? ` [pool: ${marked}]` : '';
  // Only talk about usage windows when a device was actually turned away for
  // one. A pool that timed out needs a link/latency hint, not a reset time.
  const scope = timedOutCount === pool.length
    ? `every probe (${pool.length}) exceeded`
    : `${timedOutCount} of ${pool.length} probes exceeded`;
  const hint = timedOutCount > 0
    ? `; ${scope} the probe budget — those devices are likely up but slow to answer`
      + ' (relayed Tailscale paths). Retry, or check `tailscale status` for a direct path.'
    : '; earliest window resets unknown';
  return `agents: no healthy device ${target}${poolNote} — excluded: ${excluded}${hint}`;
}

/**
 * Pick the least-loaded healthy device that can run `agent` when the harness is
 * known. `run auto` omits the agent and treats any ready account on the device
 * as eligible. The local machine participates in the
 * same probe and must pass the same eligibility checks. An empty eligible pool
 * fails loud; automatic placement never silently becomes a local launch.
 */
export async function resolveDeviceAuto(
  agent?: string,
  opts: {
    eligibleHosts?: string[];
    localMachine?: string;
    /** Route only to devices with a row the interactive account picker can launch. */
    accountPicker?: boolean;
    probe?: (pool: string[], agent?: AgentType) => Promise<Map<string, DevicePlacementSignal>>;
    /**
     * Preferred hosts (`auto-launch.preferred`) that get the ranking boost.
     * Defaults to the stored fleet block resolved over the candidate pool;
     * injectable so a test pins it without touching disk.
     */
    preferred?: ReadonlySet<string>;
  } = {},
): Promise<DeviceAutoPlan> {
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const pool = [...new Set((opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost))];
  // The local machine participates in the same probe as every peer — unless a
  // role excludes it. Adding it unconditionally would put agents back on the box
  // the operator marked `personal` precisely to keep them off it.
  if (!pool.includes(local) && isAutoPoolMember(local)) pool.push(local);
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
  // `agents devices prefer <name>` boosts a device in the ranking — resolved
  // over the same pool so a fleet default reaches a doc-less box.
  const preferred = opts.preferred ?? autoLaunchPreferredSet(pool, { roster: pool });
  const picked = pickBestDevice(eligiblePool, [], { signals, agentLabel: agent, preferred });
  return {
    host: picked === local ? null : picked,
    pickedDeviceKey: picked,
    accounts: signals.get(picked)?.accounts,
    candidates: pool.map((key) => ({
      key,
      loadPercent: signals.get(key)?.loadPercent,
      installed: signals.get(key)?.installed,
      signedIn: signals.get(key)?.signedIn,
    })),
  };
}

/**
 * Resolve host for `--device auto`. Does NOT pick harness or accounts.
 *
 * Draws from the same automatic-placement pool as {@link resolveDeviceAuto}, so
 * `agents ssh auto`, the generic `--device auto` passthrough, and `matchHost`'s
 * `auto` sentinel honour device roles too. Throws when roles leave the pool
 * empty — a `null` host here means "run locally", which for a box marked
 * `personal` is the outcome the mark exists to prevent.
 */
export function resolveDeviceAffinity(opts: DeviceAffinityOptions = {}): DeviceAffinityPlan {
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const alpha = opts.alpha ?? DEFAULT_AFFINITY_ALPHA;
  const rng = opts.rng ?? Math.random;
  const sinceDays = opts.sinceDays ?? 14;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  // `listOnlineDeviceNames` always contained the local machine before device
  // roles existed, so an empty default list can only mean roles excluded
  // everything — fail loud, exactly as resolveDeviceAuto does. An explicitly
  // empty `eligibleHosts` is the caller's own list and keeps the historical
  // degrade-to-local behavior.
  const usingDefaultPool = opts.eligibleHosts === undefined;
  const eligible = new Set(
    (opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost),
  );
  if (eligible.size === 0) {
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

  // Hosts with history get launches^α; online hosts with no history explore at weight 1.
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

/** True when a host flag value means affinity pick. */
export function isDeviceAuto(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'auto';
}

const HOST_SLOTS = ['host', 'device', 'on', 'computer'] as const;

export type DeviceAutoHostOptions = {
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  /** @deprecated Hidden alias for `--device auto`. */
  smart?: boolean;
  balanced?: boolean;
  strategy?: string;
};

export type DeviceAutoApplyResult = {
  /** True when automatic placement ran successfully. */
  attempted: boolean;
  /** True when deprecated `--smart` was seen. */
  deprecationSmart: boolean;
  /** Present when affinity resolved without error. */
  banner?: {
    hostLabel: string;
    deviceHint: string;
    acctNote: string;
  };
};

/**
 * Apply `--device auto` (and deprecated `--smart`) onto run options.
 * Mutates `options` in place. Placement failures propagate without rewriting
 * `auto`, so callers fail loud instead of silently launching locally.
 */
export async function applyDeviceAutoToOptions(
  options: DeviceAutoHostOptions,
  deps: {
    resolve?: (accountPicker: boolean) => DeviceAutoPlan | Promise<DeviceAutoPlan>;
    agent?: string;
    accountPickerRequested?: boolean;
  } = {},
): Promise<DeviceAutoApplyResult> {
  let deprecationSmart = false;

  if (options.smart) {
    const anyHost = HOST_SLOTS.some(
      (k) => typeof options[k] === 'string' && options[k]!.trim() !== '',
    );
    if (!anyHost) options.device = 'auto';
    deprecationSmart = true;
  }

  const hasAuto = HOST_SLOTS.some((k) => isDeviceAuto(options[k]));
  if (!hasAuto) {
    return { attempted: false, deprecationSmart };
  }

  const accountPickerRequested = deps.accountPickerRequested ?? false;
  const resolve: (accountPicker: boolean) => DeviceAutoPlan | Promise<DeviceAutoPlan> =
    deps.resolve ?? ((accountPicker) => resolveDeviceAuto(deps.agent, { accountPicker }));
  const plan = await resolve(accountPickerRequested);
  const concrete = plan.host; // null = local
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
    deprecationSmart,
    banner: { hostLabel, deviceHint, acctNote },
  };
}
