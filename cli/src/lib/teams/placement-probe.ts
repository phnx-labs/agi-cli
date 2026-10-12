import { spawn } from 'child_process';
import { buildFleetStatePayload } from '../accounting/usage-sync.js';
import { probeFleetStats, headroom, type DeviceStats } from '../devices/health.js';
import { loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { buildSshInvocation, writeAskpassShim } from '../devices/connect.js';
import {
  buildReadyProbeCommand,
  parseReadyProbe,
  viewAgentAccountEligibility,
  viewHasAgent,
} from '../hosts/ready.js';
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

export const SIGNAL_TTL_MS = 15_000;

interface CacheEntry {
  at: number;
  signals: Map<string, DevicePlacementSignal>;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(pool: string[], agent?: string): string {
  return `${agent ?? 'any-agent'}::${[...pool].map(normalizeHost).sort().join(',')}`;
}

export function clearPlacementSignalCache(): void {
  cache.clear();
}

interface ReadinessInfo {
  answered: boolean;
  installed: boolean | undefined;
  signedIn: boolean | undefined;
  pickerEligible: boolean | undefined;
}

function probeRemoteReadiness(
  device: DeviceProfile,
  agent: string,
  usagePayload: string,
): Promise<ReadinessInfo> {
  const unknown: ReadinessInfo = { answered: false, installed: undefined, signedIn: undefined, pickerEligible: undefined };
  let args: string[];
  let env: Record<string, string>;
  try {
    const shim = writeAskpassShim();
    const cmd = buildReadyProbeCommand(device.shell === 'powershell' ? 'windows' : undefined, { ingestUsage: true });
    ({ args, env } = buildSshInvocation(device, [cmd], shim, {}, { agentOnly: true }));
  } catch {
    return Promise.resolve(unknown);
  }
  return new Promise((resolve) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const finish = (value: ReadinessInfo): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };
    const timer = setTimeout(() => child.kill('SIGTERM'), READY_PROBE_TIMEOUT_MS);
    const killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, READY_PROBE_TIMEOUT_MS + 250);
    killTimer.unref?.();
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', () => finish(unknown));
    child.on('close', (code) => {
      if (code !== 0 || !stdout) return finish(unknown);
      const probe = parseReadyProbe(stdout);
      if (!probe.reachable) return finish(unknown);
      if (!probe.version) return finish({ answered: true, installed: false, signedIn: false, pickerEligible: false });
      const installed = viewHasAgent(probe.view, agent);
      const eligibility = installed
        ? viewAgentAccountEligibility(probe.view, agent)
        : { signedIn: false, pickerEligible: false };
      finish({ answered: true, installed, ...eligibility });
    });
    child.stdin.on('error', () => {  });
    child.stdin.end(usagePayload);
  });
}

export function mergePlacementSignal(
  stats: DeviceStats | undefined,
  readiness: ReadinessInfo | undefined,
): DevicePlacementSignal {
  const reachable = readiness?.answered === true ? true : stats?.reachable;
  return {
    reachable,
    timedOut: reachable === true ? undefined : stats?.timedOut,
    headroom: stats ? headroom(stats) : undefined,
    loadPercent: stats?.loadPercent,
    memPercent: stats?.memPercent,
    installed: readiness?.installed,
    signedIn: readiness?.signedIn,
    pickerEligible: readiness?.pickerEligible,
  };
}

export async function probePoolSignals(
  pool: string[],
  agent?: AgentType,
  opts: { force?: boolean; now?: number } = {},
): Promise<Map<string, DevicePlacementSignal>> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(pool, agent);
  const cached = cache.get(key);
  if (!opts.force && cached && now - cached.at < SIGNAL_TTL_MS) return cached.signals;

  const reg = loadDevicesSync();
  const self = normalizeHost(localMachineId());
  const lookup = (name: string): DeviceProfile | undefined =>
    reg[name] ?? reg[normalizeHost(name)];

  const profiles: DeviceProfile[] = [];
  const seen = new Set<string>();
  for (const name of pool) {
    const d = lookup(name);
    if (d && !seen.has(d.name)) {
      profiles.push(d);
      seen.add(d.name);
    }
  }

  const selfProfile = profiles.find((d) => normalizeHost(d.name) === self);
  const stats = await probeFleetStats(profiles, { selfName: selfProfile?.name });
  const usagePayload = JSON.stringify(buildFleetStatePayload({ usageOnly: true }));

  const installed = new Map<string, ReadinessInfo>(agent
    ? await Promise.all(
      profiles.map(async (d): Promise<readonly [string, ReadinessInfo]> => {
        const isSelf = normalizeHost(d.name) === self;
        if (isSelf) {
          const inst = checkCliAvailable(agent)[0];
          if (!inst) return [d.name, { answered: true, installed: false, signedIn: false, pickerEligible: false }];
          const candidates = await collectRunCandidates(agent).catch(() => null);
          if (!candidates) {
            return [d.name, { answered: true, installed: true, signedIn: undefined, pickerEligible: undefined }];
          }
          const readiness = candidates.map((candidate) => readinessFromCandidate(candidate));
          return [d.name, {
            answered: true,
            installed: true,
            signedIn: readiness.some((candidate) => candidate.ready),
            pickerEligible: readiness.some((candidate) => candidate.ready || isSignInRecoverable(candidate)),
          }];
        }
        return [d.name, await probeRemoteReadiness(d, agent, usagePayload)];
      }),
    )
    : [],
  );

  const signals = new Map<string, DevicePlacementSignal>();
  for (const name of pool) {
    const d = lookup(name);
    const s = d ? stats.get(d.name) : undefined;
    const inst = d ? installed.get(d.name) : undefined;
    if (!s && !inst) continue;
    signals.set(name, mergePlacementSignal(s, inst));
  }

  cache.set(key, { at: now, signals });
  return signals;
}
