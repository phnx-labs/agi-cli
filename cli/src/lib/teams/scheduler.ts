/**
 * Placement scheduler for distributed teams.
 *
 * Decides WHERE an unpinned teammate runs, resolving the create→pin→pool→local
 * cascade from the team's device pool and the live roster. Kept pure and
 * I/O-free (plain data in, a device name or null out) so it is trivially
 * testable and can be called from the hot launch path without SSH round-trips.
 *
 *   1. teammate has an explicit `--device` pin      → that device
 *   2. else the team pool has exactly one device     → that device (whole team)
 *   3. else the team pool has many devices           → best-viable pick
 *   4. else (no pin, no pool)                         → active worker pool
 *
 * Step 3 is cap-, health-, and harness-aware (RUSH-2002). When the caller
 * supplies live {@link DevicePlacementSignal}s (probed reachability, headroom,
 * load/mem, and whether the requested agent is installed + signed in), the pick:
 *   - EXCLUDES an unreachable device, an overloaded one (headroom `loaded`), a
 *     device at its `agents.max-concurrent` cap, and one the requested agent is
 *     not installed on;
 *   - RANKS the survivors by (a) agent installed + signed in, (b) lower load /
 *     memory (by headroom tier, then raw), (c) fewer running teammates, ties
 *     broken by pool order.
 * With no signals it degrades to the original cap-aware least-loaded pick, so
 * the pure roster-count path (and its tests) are unchanged.
 *
 * When every pool device is excluded, the pick FAILS LOUD ({@link
 * NoViableDeviceError}) naming each device's reason — never a silent fall back
 * to local, since the user asked for a remote pool. Pins are the user's own
 * choice and are never second-guessed; a pool of one is respected for
 * load/cap/reachability but still fails loud when the agent is provably not
 * installed there (running it would be futile).
 *
 * A device whose name equals the local machine id is treated as "local" — it
 * resolves to a null placement so the existing local spawn path runs unchanged,
 * letting the local machine participate in a pool as just another member.
 */
import { machineId } from '../machine-id.js';
import type { Headroom } from '../devices/health.js';

/**
 * Live signal for one pool device, gathered by the caller (SSH probes) and
 * passed into the pure pick. Every field is optional/best-effort: a device with
 * no signal is neither excluded nor preferred — it degrades to the roster-count
 * path. `reachable === false` and `installed === false` are the only two
 * exclusion signals here; `headroom` drives the overload exclusion + the load
 * tier of the rank. See {@link DeviceStats}/{@link headroom} in devices/health.
 */
export interface DevicePlacementSignal {
  /** Eligible account selectors resolved on this device. */
  accounts?: string[];
  /** SSH probe answered. `false` → excluded (unreachable). undefined → unknown. */
  reachable?: boolean;
  /**
   * The probe was killed for exceeding its budget rather than failing to
   * connect. Ranking treats it exactly like `reachable:false` — an
   * unresponsive box is still not placeable — but the operator-facing
   * exclusion reason says "probe timed out", not "unreachable" (PHNX-3682).
   */
  timedOut?: boolean;
  /** Headroom bucket from load+memory. `'loaded'` → excluded (overloaded). */
  headroom?: Headroom;
  /** Normalized CPU load percent (finer rank tiebreak within a headroom tier). */
  loadPercent?: number;
  /** Memory pressure percent (used with loadPercent for the load cost). */
  memPercent?: number;
  /** Requested agent installed on the device. `false` → excluded (can't run). */
  installed?: boolean;
  /** Requested agent has at least one launch-ready account. Ranks a ready device first. */
  signedIn?: boolean;
  /** Requested agent has at least one row the interactive account picker can launch. */
  pickerEligible?: boolean;
}

/** Team fields the placement cascade reads (a subset of TeamMeta). */
export interface PlacementTeam {
  devices?: string[];
}

/**
 * Optional placement inputs beyond the team + roster. `maxConcurrent` maps a
 * device name to its `agents.max-concurrent` cap (from the device doc — read
 * locally via `readMaxConcurrentCaps`, never probed over SSH). Teams counts
 * the team's OWN roster against the cap (device-global counting would need an
 * SSH probe per candidate — out of the hot path; AGI EXT auto-launch is the
 * device-wide counter). Only the least-loaded AUTO-PICK (cascade step 3)
 * honors caps: an explicit pin or a pool of one is the user's own choice and
 * is never second-guessed.
 */
export interface PlacementOptions {
  /** Worker pool used when the team does not declare an explicit device pool. */
  defaultDevices?: string[];
  maxConcurrent?: Record<string, number>;
  /**
   * Live per-device signals (RUSH-2002). When present, the many-device pick
   * filters unreachable/overloaded/not-installed devices and ranks the rest by
   * health + harness + load. Absent → the pick stays a pure roster count.
   */
  signals?: Map<string, DevicePlacementSignal>;
  /** Human label of the requested agent (e.g. `claude@2.1.112`) for the
   * fail-loud message. */
  agentLabel?: string;
  /**
   * Normalized hosts boosted with `auto-launch.preferred` (set by
   * `agents devices prefer <name>`). A preferred device ranks ahead of a
   * non-preferred one among the eligible survivors — after the signed-in tier
   * (a preferred box that can't run the agent is still no use) and before load,
   * so an operator boost overrides load-based ordering without overriding hard
   * health. Empty/undefined leaves the ranking unchanged. See
   * {@link autoLaunchPreferredSet}.
   */
  preferred?: ReadonlySet<string>;
}

/** Why a device was excluded from the viable set, for the fail-loud message. */
export type ExclusionReason = 'unreachable' | 'probe-timed-out' | 'overloaded' | 'capped' | 'not-installed';

/** A pool device dropped from the auto-pick, with the reason + live detail. */
export interface ExcludedDevice {
  device: string;
  reason: ExclusionReason;
  /** Present for `capped`: `running/cap`. */
  detail?: string;
}

/**
 * No device in the pool can host the teammate. Carries the per-device reasons so
 * the caller can print exactly why the pool is unusable instead of silently
 * degrading to a local run the user did not ask for.
 */
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

/**
 * Whether a failed placement can become viable without changing the team.
 * Capacity and load are time-varying; a pool with at least one such exclusion
 * must remain schedulable so a later supervisor wave can retry it. A pool that
 * is only missing the requested harness is a durable configuration failure.
 */
export function isTransientPlacementBlock(error: unknown): error is NoViableDeviceError {
  return error instanceof NoViableDeviceError
    && error.excluded.some((entry) => entry.reason === 'capped' || entry.reason === 'overloaded');
}

/** Build the user-facing fail-loud message from the per-device reasons. */
export function formatNoViableMessage(excluded: ExcludedDevice[], agentLabel?: string): string {
  const anyNotInstalled = excluded.some((e) => e.reason === 'not-installed');
  const allCapped = excluded.length > 0 && excluded.every((e) => e.reason === 'capped');
  const agent = agentLabel ?? 'the requested agent';
  const perDevice = excluded
    .map((e) => (e.detail ? `${e.device} (${e.reason} ${e.detail})` : `${e.device} (${e.reason})`))
    .join(', ');
  // When the whole pool lacks the agent, lead with the harness message the
  // ticket specifies; otherwise summarize the mixed reasons.
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

/**
 * A roster entry the load counter reads — the shape any teammate satisfies
 * (AgentProcess included). `status` is compared against `'running'` (the
 * AgentStatus.RUNNING value) without importing the enum, keeping this leaf pure.
 */
export interface RosterEntry {
  hostName: string | null;
  status: string;
}

/** True when `device` names the local machine (case-insensitive). */
function isLocalDevice(device: string): boolean {
  return device.toLowerCase() === machineId();
}

/** Count RUNNING teammates per pool device. Pure. A null/empty hostName is a
 * LOCAL teammate — it counts against the pool member that is this machine,
 * otherwise a cap on the local device could never engage. */
function loadByDevice(devices: string[], roster: RosterEntry[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const d of devices) load.set(d, 0);
  for (const r of roster) {
    if (r.status !== 'running') continue;
    const host = r.hostName ? r.hostName : devices.find((d) => isLocalDevice(d));
    if (!host) continue; // local teammate but this machine is not in the pool
    if (load.has(host)) load.set(host, (load.get(host) ?? 0) + 1);
  }
  return load;
}

/**
 * Pool devices excluded from auto-pick because they are at (or over) their
 * `agents.max-concurrent` cap. Returned with the live counts so the caller can
 * state the reason to the user instead of the device silently never winning.
 */
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

/**
 * Pick the least-loaded device from the pool — the one with the fewest RUNNING
 * teammates currently assigned to it. Ties break by pool order (first wins), so
 * an empty pool fills round-robin-ish as teammates launch. Pure: counts the
 * roster, no I/O.
 *
 * With `maxConcurrent`, devices at their cap are excluded; if EVERY device is
 * capped this throws naming each cap and the fix — a loud failure beats a
 * teammate silently landing on a machine its operator capped.
 */
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
  // Iterate the pool in declared order so the first device wins ties.
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

/** Load cost for a signal: worst of load% and mem%, or undefined when neither
 * was probed. The "how full is this box" number the finer rank tiebreak reads. */
function loadCost(s: DevicePlacementSignal | undefined): number | undefined {
  if (!s) return undefined;
  const vals = [s.loadPercent, s.memPercent].filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.max(...vals) : undefined;
}

/** Rank a headroom bucket into a load TIER (lower is less loaded). An unprobed
 * device sits between `light` and `busy` — preferred over a known-busy box but
 * not over a known-idle one. `loaded` is excluded before ranking, so it never
 * reaches here. */
function headroomTier(h: Headroom | undefined): number {
  switch (h) {
    case 'idle': return 0;
    case 'light': return 1;
    case 'busy': return 3;
    default: return 2; // 'unknown' / undefined
  }
}

/**
 * Split the pool into the viable set and the excluded set (with reasons), from
 * the caps + live signals. Pure — the caller decides what to do with an empty
 * viable set. Reasons are checked in a stable order (unreachable → not-installed
 * → overloaded → capped) so a device reports its most fundamental blocker first.
 */
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
      // A probe killed for exceeding its budget is a slow link, not a box that
      // is down. Same exclusion either way — an unresponsive device is still not
      // placeable — but the operator sees which one it was (PHNX-3682).
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

/**
 * Health-, harness-, and load-aware pick over a pool (RUSH-2002). Filters
 * unreachable / overloaded / capped / not-installed devices, then ranks the
 * survivors by: (a) agent signed in, (b) lower load (headroom tier, then raw
 * load cost), (c) fewer running teammates, ties broken by pool order. Throws
 * {@link NoViableDeviceError} when nothing survives — never returns a local
 * fallback. Pure: all I/O is pre-resolved into `opts.signals`.
 */
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
    // A pool excluded ONLY for unreachability is a probe MISS / transient infra
    // blip (a worker went briefly unresponsive during `teams start`), not proof
    // the agent can't RUN there. Per the fail-loud contract — fire only on
    // positive evidence (not-installed / saturated), never on a bare
    // reachability miss — degrade to a best-effort roster-count pick so the wave
    // retries and the real error surfaces at SSH dispatch, instead of a hard
    // exit-1 that strands an all-remote pool on a transient blip.
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
  // Ascending composite sort — the first element is the best placement.
  return [...eligible].sort((a, b) => {
    const sa = signals?.get(a);
    const sb = signals?.get(b);
    // (a) signed-in agent first.
    const signedIn = (sa?.signedIn === true ? 0 : 1) - (sb?.signedIn === true ? 0 : 1);
    if (signedIn !== 0) return signedIn;
    // (a2) operator-preferred device next — `agents devices prefer <name>`
    // boosts a box above its load-equal peers, overriding load-based order.
    const preferred = opts?.preferred;
    if (preferred && preferred.size > 0) {
      const pref = (preferred.has(a) ? 0 : 1) - (preferred.has(b) ? 0 : 1);
      if (pref !== 0) return pref;
    }
    // (b) lower load — coarse headroom tier, then raw load cost.
    const tier = headroomTier(sa?.headroom) - headroomTier(sb?.headroom);
    if (tier !== 0) return tier;
    // (c) fewer running teammates.
    const teammates = (load.get(a) ?? 0) - (load.get(b) ?? 0);
    if (teammates !== 0) return teammates;
    // finer load tiebreak: a known-lower load wins; unknown sits mid (50).
    const cost = (loadCost(sa) ?? 50) - (loadCost(sb) ?? 50);
    if (cost !== 0) return cost;
    // stable: first declared in the pool wins.
    return (order.get(a) ?? 0) - (order.get(b) ?? 0);
  })[0];
}

/**
 * Resolve where a teammate runs. Returns `{ device: null }` only when the
 * explicitly/default-selected device is the local machine, and
 * `{ device: <name> }` for a remote placement. See the cascade in the module
 * header. Throws {@link NoViableDeviceError} when a required pool has no viable
 * host — the caller surfaces it at `teams start` rather than falling back local.
 */
export function resolvePlacement(
  team: PlacementTeam,
  explicitDevice: string | null,
  roster: RosterEntry[],
  opts?: PlacementOptions,
): { device: string | null } {
  // 1. Explicit pin wins — even without a pool — and is never second-guessed
  //    (the remote `agents run` surfaces any install/health issue there).
  if (explicitDevice) {
    return { device: isLocalDevice(explicitDevice) ? null : explicitDevice };
  }
  const pool = team.devices?.length ? team.devices : (opts?.defaultDevices ?? []);
  // An omitted pool means automatic worker placement, never implicit local.
  if (pool.length === 0) throw new NoViableDeviceError([], opts?.agentLabel);
  // 2. Pool of one → the whole team runs there. Respect the choice for
  //    load/cap/reachability, but still fail loud when the agent is provably
  //    NOT installed there — running it would be futile.
  if (pool.length === 1) {
    if (opts?.signals?.get(pool[0])?.installed === false) {
      throw new NoViableDeviceError([{ device: pool[0], reason: 'not-installed' }], opts.agentLabel);
    }
    return { device: isLocalDevice(pool[0]) ? null : pool[0] };
  }
  // 3. Many → best viable pick. With live signals, this is health-, harness-,
  //    and load-aware; without them it degrades to the cap-aware roster count.
  const picked = opts?.signals
    ? pickBestDevice(pool, roster, opts)
    : pickLeastLoaded(pool, roster, opts?.maxConcurrent);
  return { device: isLocalDevice(picked) ? null : picked };
}
