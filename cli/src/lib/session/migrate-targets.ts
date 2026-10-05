import type { Host } from '../hosts/types.js';
import type { DeviceStats, Headroom } from '../devices/health.js';
import { headroom } from '../devices/health.js';
import type { CrabboxBox } from '../crabbox/cli.js';

export interface MigrateTarget {
  name: string;
  kind: 'fleet' | 'ephemeral';
  os?: string;
  headroom: Headroom;
  host?: Host;
  box?: CrabboxBox;
}

export interface MigrateContext {
  selfHostname: string;
  sourceHostname?: string;
  sourceOs?: string;
}

const HEADROOM_ORDER: Record<Headroom, number> = {
  idle: 0,
  light: 1,
  busy: 2,
  loaded: 3,
  unknown: 4,
};

function platformOf(os: string | undefined): string | undefined {
  if (!os) return undefined;
  const s = os.toLowerCase();
  if (s.includes('darwin') || s.includes('mac')) return 'darwin';
  if (s.includes('win')) return 'windows';
  if (s.includes('linux')) return 'linux';
  return s;
}

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
    os: 'linux',
    headroom: headroom(statsByName.get(box.slug)),
    box,
  }));

  return [...fleet, ...ephemeral];
}

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

export function pickBestTarget(
  hosts: Host[],
  warmBoxes: CrabboxBox[],
  statsByName: Map<string, DeviceStats>,
  ctx: MigrateContext,
): MigrateTarget | null {
  const ranked = rankTargets(enumerateTargets(hosts, warmBoxes, statsByName, ctx), ctx);
  return ranked[0] ?? null;
}
