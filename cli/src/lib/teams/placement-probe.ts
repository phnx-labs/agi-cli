/**
 * Live pool probing for the teams placement scheduler (RUSH-2002).
 *
 * Gathers one {@link DevicePlacementSignal} per pool device so the pure pick in
 * {@link ./scheduler} can filter unreachable / overloaded / not-installed
 * devices and rank the rest. Two concerns, both best-effort:
 *
 *   - reachability + headroom + load  ← {@link probeFleetStats} (one parallel
 *     SSH fan-out over the pool; the local box is measured directly).
 *   - requested agent installed + account eligibility (when known) ← a one-shot
 *     readiness probe per remote device ({@link buildReadyProbeCommand} →
 *     `agents view`), with the same candidate-readiness gate evaluated locally.
 *
 * The result is cached briefly per (pool, agent-or-any) so a `teams start` wave that
 * places N teammates probes the pool ONCE, not N times — the roster-count part
 * of the rank stays live (the pure pick recounts the roster each call), only the
 * SSH-measured load/harness snapshot is reused within the TTL.
 *
 * All SSH here is via `spawn` (async, kill-bounded) so the whole pool is probed
 * in parallel; a slow or wedged box degrades to "no signal" instead of blocking
 * the launch. The readiness payload is `agents view --json`, so remote and local
 * candidates carry the same installed/sign-in verdict. The dispatcher's usage
 * envelope rides the same round-trip on stdin (`agents __usage-ingest` runs
 * first in the probe, PHNX-4116), so the worker the pick lands on holds current
 * usage numbers at dispatch rather than at the next usage-sync tick.
 */
import { spawn } from 'child_process';
import { buildFleetStatePayload } from '../accounting/usage-sync.js';
import { probeFleetStats, headroom } from '../devices/health.js';
import { loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { buildSshInvocation, writeAskpassShim } from '../devices/connect.js';
import { resolveDeviceProfile } from '../devices/resolve-profile.js';
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

/** Per-remote readiness probe budget — matches the health probe's short window
 * (`agents view` on a warm box is sub-second; a wedged one degrades to unknown). */
export const READY_PROBE_TIMEOUT_MS = 8_000;

/** How long a probed pool snapshot is reused within a `teams start` wave. Short
 * enough that a device coming online / going overloaded is seen next wave, long
 * enough that placing a wave of teammates does not re-fan-out per teammate. */
export const SIGNAL_TTL_MS = 15_000;

interface CacheEntry {
  at: number;
  signals: Map<string, DevicePlacementSignal>;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(pool: string[], agent?: string): string {
  return `${agent ?? 'any-agent'}::${[...pool].map(normalizeHost).sort().join(',')}`;
}

/** Clear the probe cache — for tests and after a device-registry change. */
export function clearPlacementSignalCache(): void {
  cache.clear();
}

/**
 * Whether the requested agent is installed on a REMOTE device, via one SSH
 * readiness probe. `undefined` when the probe could not answer (ssh/login
 * failure) — reachability is then left to {@link probeFleetStats}; `false` when
 * the box answered but agents-cli or the agent is absent (a genuine can't-run).
 */
function probeRemoteReadiness(
  device: DeviceProfile,
  agent: string,
  usagePayload: string,
): Promise<{
  installed: boolean | undefined;
  signedIn: boolean | undefined;
  pickerEligible: boolean | undefined;
}> {
  const unknown = { installed: undefined, signedIn: undefined, pickerEligible: undefined };
  let args: string[];
  let env: Record<string, string>;
  try {
    const shim = writeAskpassShim();
    // The operator config (`platform`) decides the remote shell family, exactly
    // as buildSshInvocation dials it — never the registry's discovered shell.
    const cmd = buildReadyProbeCommand(resolveDeviceProfile(device).shell === 'powershell' ? 'windows' : undefined, { ingestUsage: true });
    // agentOnly: a read-only probe must never force a foreground Touch ID sheet
    // on a password-auth device (mirrors probeDeviceStats in devices/health).
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
    const finish = (value: typeof unknown | { installed: boolean; signedIn: boolean | undefined; pickerEligible: boolean | undefined }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(value);
    };
    // A wedged box degrades to "no signal": SIGTERM at the budget, SIGKILL shortly
    // after, so one dead peer can never hold the whole placement wave open.
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
      if (!probe.version) return finish({ installed: false, signedIn: false, pickerEligible: false });
      const installed = viewHasAgent(probe.view, agent);
      const eligibility = installed
        ? viewAgentAccountEligibility(probe.view, agent)
        : { signedIn: false, pickerEligible: false };
      finish({ installed, ...eligibility });
    });
    child.stdin.on('error', () => { /* peer closed early; the close handler reports it */ });
    child.stdin.end(usagePayload);
  });
}

/**
 * Probe every device in the team pool and return a name→signal map for the pure
 * placement pick. Devices with no data at all are omitted (the pick then neither
 * excludes nor prefers them). Never throws — a probe failure degrades to a
 * missing/partial signal.
 */
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
  // Built once per wave: this box's current usage rows (headed only — a worker
  // dispatcher has none to give), ingested by every remote candidate it probes.
  const usagePayload = JSON.stringify(buildFleetStatePayload({ usageOnly: true }));

  type InstalledInfo = {
    installed: boolean | undefined;
    signedIn: boolean | undefined;
    pickerEligible: boolean | undefined;
  };
  const installed = new Map<string, InstalledInfo>(agent
    ? await Promise.all(
      profiles.map(async (d): Promise<readonly [string, InstalledInfo]> => {
        const isSelf = normalizeHost(d.name) === self;
        if (isSelf) {
          const inst = checkCliAvailable(agent)[0];
          if (!inst) return [d.name, { installed: false, signedIn: false, pickerEligible: false }];
          const candidates = await collectRunCandidates(agent).catch(() => null);
          if (!candidates) {
            return [d.name, { installed: true, signedIn: undefined, pickerEligible: undefined }];
          }
          const readiness = candidates.map((candidate) => readinessFromCandidate(candidate));
          return [d.name, {
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
    if (!s && !inst) continue; // fully unknown device — leave it out of the map
    signals.set(name, {
      reachable: s?.reachable,
      timedOut: s?.timedOut,
      headroom: s ? headroom(s) : undefined,
      loadPercent: s?.loadPercent,
      memPercent: s?.memPercent,
      installed: inst?.installed,
      signedIn: inst?.signedIn,
      pickerEligible: inst?.pickerEligible,
    });
  }

  cache.set(key, { at: now, signals });
  return signals;
}
