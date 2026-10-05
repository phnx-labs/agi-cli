/** Target enumeration and `--auto` scorer for `agents sessions migrate` (RUSH-1977). Pure decision
 * layer with no ssh, disk or clock, so ranking is unit-testable. The source and the interactive
 * machine (os.hostname()) are never offered as targets. */
import type { Host } from '../hosts/types.js';
import type { DeviceStats, Headroom } from '../devices/health.js';
import { headroom } from '../devices/health.js';
import type { CrabboxBox } from '../crabbox/cli.js';

/** A machine the current session could be relocated onto. */
export interface MigrateTarget {
  /** The `--device` value: a host/device name, or a warm box slug for ephemeral. */
  name: string;
  /** Where the target comes from — a fleet host/device, or a warm crabbox box. */
  kind: 'fleet' | 'ephemeral';
  /** Captured OS string ('darwin'/'linux'/'windows'/…) when known, for platform-match ranking. */
  os?: string;
  /** Live headroom bucket ('idle' is best); 'unknown' when no stats resolved. */
  headroom: Headroom;
  /** The underlying host (fleet targets only). */
  host?: Host;
  /** The underlying warm box (ephemeral targets only). */
  box?: CrabboxBox;
}

/** Inputs the scorer needs about the session being moved and this machine. */
export interface MigrateContext {
  /** os.hostname() of the interactive machine — never a valid target. */
  selfHostname: string;
  /** The source session's host (machine it currently runs on) — never a valid target. */
  sourceHostname?: string;
  /** The source session's OS, for the platform-match bonus. */
  sourceOs?: string;
}

/** Headroom rank: lower is better (idle preferred). 'unknown' sorts last among reachable. */
const HEADROOM_ORDER: Record<Headroom, number> = {
  idle: 0,
  light: 1,
  busy: 2,
  loaded: 3,
  unknown: 4,
};

/** Normalize an os string to a coarse platform token for match comparison. */
function platformOf(os: string | undefined): string | undefined {
  if (!os) return undefined;
  const s = os.toLowerCase();
  if (s.includes('darwin') || s.includes('mac')) return 'darwin';
  if (s.includes('win')) return 'windows';
  if (s.includes('linux')) return 'linux';
  return s;
}

/** Enumerate migrate targets, excluding the interactive machine and the source. Fleet hosts must be
 * dispatchable and not offline; warm ephemeral boxes are always eligible. A missing `statsByName`
 * entry yields 'unknown' headroom: eligible but ranked lower. */
export function enumerateTargets(
  hosts: Host[],
  warmBoxes: CrabboxBox[],
  statsByName: Map<string, DeviceStats>,
  ctx: MigrateContext,
): MigrateTarget[] {
  const excluded = new Set(
    [ctx.selfHostname, ctx.sourceHostname].filter((n): n is string => !!n).map((n) => n.toLowerCase()),
  );

  const fleet: MigrateTarget[] = [];
  for (const host of hosts) {
    if (excluded.has(host.name.toLowerCase())) continue;
    // dispatchable is absent-means-yes; only an explicit false is disqualifying.
    if (host.dispatchable === false) continue;
    if (host.status === 'offline') continue;
    fleet.push({
      name: host.name,
      kind: 'fleet',
      os: host.os,
      headroom: headroom(statsByName.get(host.name)),
      host,
    });
  }

  const ephemeral: MigrateTarget[] = warmBoxes.map((box) => ({
    name: box.slug,
    kind: 'ephemeral',
    // crabbox boxes are Linux; the address is resolved at use time.
    os: 'linux',
    headroom: headroom(statsByName.get(box.slug)),
    box,
  }));

  return [...fleet, ...ephemeral];
}

/** Rank `--auto` targets by platform match with the source, fleet before ephemeral, headroom (idle
 * > light > busy > loaded > unknown), then name. Returns a new array. */
export function rankTargets(targets: MigrateTarget[], ctx: MigrateContext): MigrateTarget[] {
  const srcPlatform = platformOf(ctx.sourceOs);
  const score = (t: MigrateTarget) => {
    const platformMatch = srcPlatform && platformOf(t.os) === srcPlatform ? 0 : 1;
    const kindRank = t.kind === 'fleet' ? 0 : 1;
    return { platformMatch, kindRank, headroomRank: HEADROOM_ORDER[t.headroom], name: t.name };
  };
  return [...targets].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa.platformMatch !== sb.platformMatch) return sa.platformMatch - sb.platformMatch;
    if (sa.kindRank !== sb.kindRank) return sa.kindRank - sb.kindRank;
    if (sa.headroomRank !== sb.headroomRank) return sa.headroomRank - sb.headroomRank;
    return sa.name.localeCompare(sb.name);
  });
}

/** Pick the best `--auto` target, or null if none is eligible. A fully loaded fleet is still
 * returned; the command layer can offer `--lease` on null. */
export function pickBestTarget(
  hosts: Host[],
  warmBoxes: CrabboxBox[],
  statsByName: Map<string, DeviceStats>,
  ctx: MigrateContext,
): MigrateTarget | null {
  const ranked = rankTargets(enumerateTargets(hosts, warmBoxes, statsByName, ctx), ctx);
  return ranked[0] ?? null;
}
