/**
 * Pick a worker device for offloaded machine work — the suite, a build, any job
 * that pins a box for minutes and must never land on the machine someone is
 * sitting at.
 *
 * This is deliberately NOT `resolveDeviceAuto`. That resolver answers "which box
 * should run this AGENT", so it gates on harness installation and a launch-ready
 * account (`smart-launch.ts:200-210`). A vitest run needs neither: it needs a
 * reachable POSIX box with headroom. Gating a test offload on a signed-in Claude
 * account would exclude a perfectly good worker for a reason that has nothing to
 * do with running tests.
 *
 * What it DOES share, on purpose, is everything that decides *where agents may
 * go*: the same {@link listOnlineDeviceNames} pool (so `role=worker` /
 * `role=personal` marks move this surface too), the same
 * {@link probePoolSignals} reachability+load probe (so one cached fleet probe
 * serves both), and the same {@link pickBestDevice} least-loaded ranking. Before
 * this module, `scripts/test.sh` hand-rolled its own resolver in inline Python
 * and therefore could not offer `--device auto` at all.
 */
import { normalizeHost } from '../machine-id.js';
import { localMachineId } from '../session/origin-machine.js';
import { loadDevicesSync } from './registry.js';
import { isAutoPoolMember } from './pool.js';
import {
  formatEmptyAutoPoolError,
  listOnlineDeviceNames,
} from '../smart-launch.js';
import { pickBestDevice, type DevicePlacementSignal } from '../teams/scheduler.js';
import { probePoolSignals } from '../teams/placement-probe.js';

/** Why a candidate was dropped, for the fail-loud error message. */
export interface WorkerExclusion {
  device: string;
  reason: 'unreachable' | 'probe timed out' | 'overloaded' | 'wrong-platform' | 'interactive';
}

interface WorkerPickPlan {
  /** The chosen device name. Never the local box unless it is an auto-pool member. */
  device: string;
  /** True when the pick IS this machine (the caller should run in place). */
  isLocal: boolean;
  candidates: Array<{ device: string; loadPercent?: number; headroom?: string }>;
  excluded: WorkerExclusion[];
}

interface WorkerPickOptions {
  /** Restrict to these platforms. Defaults to POSIX (`linux`, `macos`). */
  platforms?: string[];
  /** Override the candidate pool (tests). */
  eligibleHosts?: string[];
  localMachine?: string;
  /** Injected probe (tests). */
  probe?: (pool: string[]) => Promise<Map<string, DevicePlacementSignal>>;
}

/**
 * Platforms a bun/vitest offload can actually run on.
 *
 * Windows is excluded by policy, not by accident: `AGENTS.md` states Windows is
 * not a required PR or ordinary-release platform and `tests.yml` runs it only as
 * a `continue-on-error` post-merge smoke. Silently shipping the tree to
 * `win-mini` would produce a confusing failure for a platform whose result
 * nobody gates on.
 */
const POSIX_PLATFORMS = ['linux', 'macos'] as const;

/**
 * Resolve the least-loaded eligible worker.
 *
 * Throws — never returns a degraded answer. An offload helper that quietly
 * decided "no worker, run here" would recreate exactly the failure the offload
 * exists to prevent: the operator believes the work went to the fleet while
 * their laptop is pinned. Callers surface the thrown message verbatim.
 */
export async function resolveWorkerDevice(opts: WorkerPickOptions = {}): Promise<WorkerPickPlan> {
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const pool = [...new Set((opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost))];
  // The local box joins the pool only when a role does not exclude it — the same
  // rule resolveDeviceAuto applies. A box marked `personal` is marked precisely
  // so long jobs stay off it, and that mark must hold for the suite too.
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

  // Platform first: it is a static registry fact, so filtering here keeps the
  // live probe off boxes that could never be picked anyway.
  const onPlatform = pool.filter((device) => {
    const platform = platformOf(device);
    // Unknown platform stays a candidate — a registry-only box with no recorded
    // platform is a gap in the registry, not positive evidence it is Windows.
    if (platform && !wanted.has(platform)) {
      excluded.push({ device, reason: 'wrong-platform' });
      return false;
    }
    return true;
  });
  if (onPlatform.length === 0) throw new Error(formatNoWorkerError(excluded, wanted));

  const signals = await (opts.probe ?? ((p: string[]) => probePoolSignals(p)))(onPlatform);
  const eligible = onPlatform.filter((device) => {
    const signal = signals.get(device);
    if (signal?.reachable !== true) {
      // A probe killed for exceeding its budget says nothing about whether the
      // box is up — on a relayed fleet it usually is. Report the two apart so
      // the message points at the link, not at a fleet outage (PHNX-3682).
      excluded.push({ device, reason: signal?.timedOut ? 'probe timed out' : 'unreachable' });
      return false;
    }
    if (signal.headroom === 'loaded') {
      excluded.push({ device, reason: 'overloaded' });
      return false;
    }
    return true;
  });
  if (eligible.length === 0) throw new Error(formatNoWorkerError(excluded, wanted));

  const device = pickBestDevice(eligible, [], { signals });
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

/** The one no-worker message, naming every candidate and why it was dropped. */
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
