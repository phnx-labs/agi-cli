import { spawn } from 'child_process';
import { buildFleetStatePayload } from '../accounting/usage-sync.js';
import { probeFleetStats, headroom, type DeviceStats } from '../devices/health.js';
import { loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { buildSshInvocation, writeAskpassShim } from '../devices/connect.js';
import { resolveDeviceProfile } from '../devices/resolve-profile.js';
import {
  freshReadyProbe,
  freshSnapshotStats,
  placementDemandIsRecent,
  readPlacementSnapshot,
  retainHardwareFacts,
  writePlacementSnapshot,
  type PlacementSnapshot,
  type ReadyProbeEntry,
} from '../devices/stats-cache.js';
import {
  buildReadyProbeCommand,
  compactReadyView,
  hostAnswers,
  parseReadyProbe,
  viewAgentAccountEligibility,
  viewHasAgent,
} from '../hosts/ready.js';
import { resolveHost } from '../hosts/registry.js';
import {
  collectRunCandidates,
  isSignInRecoverable,
  readinessFromCandidate,
} from '../accounting/rotate.js';
import { localMachineId } from '../origin-machine.js';
import { normalizeHost } from '../machine-id.js';
import { checkCliAvailable, type AgentType } from './agents.js';
import type { DevicePlacementSignal } from './scheduler.js';

export const READY_PROBE_TIMEOUT_MS = 8_000;

interface ReadinessInfo {
  answered: boolean;
  installed: boolean | undefined;
  signedIn: boolean | undefined;
  pickerEligible: boolean | undefined;
  reason?: string;
  timedOut?: boolean;
}

function probeRemoteReady(device: DeviceProfile, usagePayload: string): Promise<ReadyProbeEntry> {
  const unknown = (): ReadyProbeEntry => ({ answered: false, version: null, view: '', fetchedAt: Date.now() });
  let args: string[];
  let env: Record<string, string>;
  try {
    const shim = writeAskpassShim();
    const cmd = buildReadyProbeCommand(resolveDeviceProfile(device).shell === 'powershell' ? 'windows' : undefined, { ingestUsage: true });
    ({ args, env } = buildSshInvocation(device, [cmd], shim, {}, { agentOnly: true }));
  } catch {
    return Promise.resolve(unknown());
  }
  return new Promise((resolve) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const finish = (value: ReadyProbeEntry): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, READY_PROBE_TIMEOUT_MS);
    const killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, READY_PROBE_TIMEOUT_MS + 250);
    killTimer.unref?.();
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', () => finish(unknown()));
    child.on('close', (code) => {
      if (timedOut) return finish({ ...unknown(), timedOut: true });
      if (code !== 0 || !stdout) return finish(unknown());
      const probe = parseReadyProbe(stdout);
      if (!probe.reachable) return finish(unknown());
      finish({ answered: true, version: probe.version, view: compactReadyView(probe.view), fetchedAt: Date.now() });
    });
    child.stdin.on('error', () => {  });
    child.stdin.end(usagePayload);
  });
}

export function readinessFromProbe(entry: ReadyProbeEntry, agent: string): ReadinessInfo {
  if (!entry.answered) {
    return { answered: false, installed: undefined, signedIn: undefined, pickerEligible: undefined, timedOut: entry.timedOut };
  }
  if (!entry.version) return { answered: true, installed: false, signedIn: false, pickerEligible: false };
  const installed = viewHasAgent(entry.view, agent);
  const eligibility = installed
    ? viewAgentAccountEligibility(entry.view, agent)
    : { signedIn: false, pickerEligible: false };
  return { answered: true, installed, ...eligibility };
}

export function mergePlacementSignal(
  stats: DeviceStats | undefined,
  readiness: ReadinessInfo | undefined,
): DevicePlacementSignal {
  const reachable = readiness?.answered === true ? true : stats?.reachable;
  return {
    reachable,
    timedOut: reachable === true ? readiness?.timedOut : stats?.timedOut,
    headroom: stats ? headroom(stats) : undefined,
    loadPercent: stats?.loadPercent,
    memPercent: stats?.memPercent,
    memFreeBytes: stats?.memFreeBytes,
    installed: readiness?.installed,
    signedIn: readiness?.signedIn,
    pickerEligible: readiness?.pickerEligible,
    reason: readiness?.reason,
  };
}

export function snapshotSignal(
  snapshot: PlacementSnapshot,
  name: string,
  agent: string | undefined,
  now: number,
): DevicePlacementSignal | undefined {
  const stats = freshSnapshotStats(snapshot, name, now);
  if (!stats) return undefined;
  if (!agent) return { ...mergePlacementSignal(stats, undefined), fromSnapshot: true };
  const probe = freshReadyProbe(snapshot, name, now);
  if (!probe) return undefined;
  return { ...mergePlacementSignal(stats, readinessFromProbe(probe, agent)), fromSnapshot: true };
}

async function localReadiness(agent: AgentType): Promise<ReadinessInfo> {
  if (!checkCliAvailable(agent)[0]) return { answered: true, installed: false, signedIn: false, pickerEligible: false };
  const candidates = await collectRunCandidates(agent).catch(() => null);
  if (!candidates) return { answered: true, installed: true, signedIn: undefined, pickerEligible: undefined };
  const readiness = candidates.map((candidate) => readinessFromCandidate(candidate));
  return {
    answered: true,
    installed: true,
    signedIn: readiness.some((candidate) => candidate.ready),
    pickerEligible: readiness.some((candidate) => candidate.ready || isSignInRecoverable(candidate)),
  };
}

async function probeLive(
  profiles: DeviceProfile[],
  selfName: string | undefined,
  withReadiness: boolean,
  demandAt?: number,
): Promise<{ stats: Map<string, DeviceStats>; probes: Map<string, ReadyProbeEntry> }> {
  const remote = profiles.filter((d) => d.name !== selfName);
  const usagePayload = withReadiness && remote.length > 0
    ? JSON.stringify(buildFleetStatePayload({ usageOnly: true }))
    : '';
  const [stats, probed] = await Promise.all([
    profiles.length > 0 ? probeFleetStats(profiles, { selfName }) : Promise.resolve(new Map<string, DeviceStats>()),
    withReadiness
      ? Promise.all(remote.map(async (d) => [d.name, await probeRemoteReady(d, usagePayload)] as const))
      : Promise.resolve([] as Array<readonly [string, ReadyProbeEntry]>),
  ]);
  const prior = readPlacementSnapshot().stats;
  const rows: Record<string, DeviceStats> = {};
  for (const [name, row] of stats) {
    const kept = retainHardwareFacts(row, prior[name]);
    stats.set(name, kept);
    rows[name] = kept;
  }
  const probes = new Map(probed);
  writePlacementSnapshot({ stats: rows, readiness: Object.fromEntries(probes), demandAt });
  return { stats, probes };
}

function resolvePoolProfiles(pool: string[]): { lookup: (name: string) => DeviceProfile | undefined; profiles: DeviceProfile[] } {
  const reg = loadDevicesSync();
  const lookup = (name: string): DeviceProfile | undefined => reg[name] ?? reg[normalizeHost(name)];
  const profiles: DeviceProfile[] = [];
  const seen = new Set<string>();
  for (const name of pool) {
    const d = lookup(name);
    if (d && !seen.has(d.name)) {
      profiles.push(d);
      seen.add(d.name);
    }
  }
  return { lookup, profiles };
}

export async function probePoolSignals(
  pool: string[],
  agent?: AgentType,
  opts: { force?: boolean; now?: number } = {},
): Promise<Map<string, DevicePlacementSignal>> {
  const now = opts.now ?? Date.now();
  const self = normalizeHost(localMachineId());
  const { lookup, profiles } = resolvePoolProfiles(pool);
  const selfProfile = profiles.find((d) => normalizeHost(d.name) === self);

  const snapshot = readPlacementSnapshot();
  const cached = new Map<string, DevicePlacementSignal>();
  const live: DeviceProfile[] = [];
  for (const d of profiles) {
    const signal = d === selfProfile || opts.force ? undefined : snapshotSignal(snapshot, d.name, agent, now);
    if (signal) cached.set(d.name, signal);
    else live.push(d);
  }

  const [{ stats, probes }, selfReadiness] = await Promise.all([
    probeLive(live, selfProfile?.name, agent !== undefined, now),
    agent && selfProfile ? localReadiness(agent) : Promise.resolve(undefined),
  ]);

  const signals = new Map<string, DevicePlacementSignal>();
  for (const name of pool) {
    const d = lookup(name);
    if (!d) continue;
    const fromSnapshot = cached.get(d.name);
    if (fromSnapshot) {
      signals.set(name, fromSnapshot);
      continue;
    }
    const s = stats.get(d.name);
    const probe = probes.get(d.name);
    const inst = d === selfProfile ? selfReadiness : probe && agent ? readinessFromProbe(probe, agent) : undefined;
    if (!s && !inst) continue;
    signals.set(name, mergePlacementSignal(s, inst));
  }
  return signals;
}

export async function refreshPlacementSnapshot(pool: string[], now: number = Date.now()): Promise<number | null> {
  if (!placementDemandIsRecent(readPlacementSnapshot(), now)) return null;
  const self = normalizeHost(localMachineId());
  const remote = resolvePoolProfiles(pool).profiles.filter((d) => normalizeHost(d.name) !== self);
  const { probes } = await probeLive(remote, undefined, true);
  return probes.size;
}

export async function confirmPlacementTarget(name: string): Promise<boolean> {
  const host = await resolveHost(name).catch(() => null);
  if (host && hostAnswers(host)) return true;
  const deviceName = resolvePoolProfiles([name]).profiles[0]?.name ?? name;
  writePlacementSnapshot({
    readiness: { [deviceName]: { answered: false, timedOut: true, version: null, view: '', fetchedAt: Date.now() } },
  });
  return false;
}
