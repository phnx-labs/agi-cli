
import { compareVersions } from '../agent-spec/primitives.js';
import { isDevVersionStamp } from '../startup/dev-build.js';
import {
  runLocalCommand,
  runOnDevice,
  type FleetRunResult,
  type FleetTarget,
} from './fleet.js';
import { isSelfHost } from './self-host.js';

const PATH_PREFIX = 'agents-rollout-path=';
const VERSION_PREFIX = 'agents-rollout-version=';

export function rolloutVerifyCommand(): string[] {
  const script = [
    'p=$(command -v agents || true)',
    'r=$(readlink -f "$p" 2>/dev/null || echo "$p")',
    `echo ${PATH_PREFIX}$r`,
    `echo ${VERSION_PREFIX}$(agents --version 2>/dev/null || true)`,
  ].join('; ');
  return ['sh', '-c', `'${script}'`];
}

interface RolloutProbe {
  resolvedPath?: string;
  reportedVersion?: string;
}

export function parseRolloutVerifyOutput(stdout: string): RolloutProbe {
  const probe: RolloutProbe = {};
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(PATH_PREFIX)) {
      const value = line.slice(PATH_PREFIX.length).trim();
      if (value) probe.resolvedPath = value;
    } else if (line.startsWith(VERSION_PREFIX)) {
      const value = line.slice(VERSION_PREFIX.length).trim();
      if (value) probe.reportedVersion = value;
    }
  }
  return probe;
}

export type RolloutVerdict =
  | 'on-target'
  | 'dev-shadowed'
  | 'not-upgraded'
  | 'unverified';

export interface RolloutVerification extends RolloutProbe {
  verdict: RolloutVerdict;
  detail: string;
}

export function isRolloutSuccess(verdict: RolloutVerdict): boolean {
  return verdict === 'on-target';
}

export function resolveRolloutTarget(
  explicitVersion: string | undefined,
  probes: RolloutProbe[],
): string | undefined {

  if (explicitVersion && !isDistTag(explicitVersion)) return explicitVersion;
  let best: string | undefined;
  for (const probe of probes) {
    const version = probe.reportedVersion;
    if (!version || isDevVersionStamp(version)) continue;
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

function isDistTag(version: string): boolean {
  return !/^\d/.test(version);
}

export function classifyRolloutVerification(
  probe: RolloutProbe,
  targetVersion: string | undefined,
): RolloutVerification {

  const { resolvedPath, reportedVersion } = probe;
  if (!reportedVersion) {
    return {
      ...probe,
      verdict: 'unverified',
      detail: resolvedPath
        ? `resolved ${resolvedPath} but it reported no version`
        : 'could not resolve `agents` on this box',
    };
  }
  if (!targetVersion) {
    return {
      ...probe,
      verdict: 'unverified',
      detail: `runs ${reportedVersion}; no target version to compare against`,
    };
  }
  if (reportedVersion === targetVersion) {
    return { ...probe, verdict: 'on-target', detail: `runs ${reportedVersion}` };
  }
  if (isDevVersionStamp(reportedVersion)) {
    return {
      ...probe,
      verdict: 'dev-shadowed',
      detail:
        `NOT upgraded — \`agents\` resolves to a dev build (${reportedVersion})` +
        `${resolvedPath ? ` at ${resolvedPath}` : ''}, shadowing the upgraded ${targetVersion} global`,
    };
  }
  return {
    ...probe,
    verdict: 'not-upgraded',
    detail:
      `NOT upgraded — \`agents\` runs ${reportedVersion}, target ${targetVersion}` +
      `${resolvedPath ? ` (resolves to ${resolvedPath})` : ''}`,
  };
}

const VERIFY_TIMEOUT_MS = 60_000;

interface VerifyFleetRolloutOptions {
  self?: string;
  runner?: typeof runOnDevice;
  localRunner?: typeof runLocalCommand;
}

export function verifyFleetRollout(
  targets: FleetTarget[],
  results: FleetRunResult[],
  explicitVersion: string | undefined,
  opts: VerifyFleetRolloutOptions = {},
): Map<string, RolloutVerification> {
  const runner = opts.runner ?? runOnDevice;
  const localRunner = opts.localRunner ?? runLocalCommand;
  const upgraded = new Set(results.filter((r) => r.status === 'ok').map((r) => r.name));
  const cmd = rolloutVerifyCommand();

  const probes = new Map<string, RolloutProbe>();
  for (const t of targets) {
    const name = t.device.name;
    if (t.skip || !upgraded.has(name)) continue;
    try {
      const isSelf = (opts.self !== undefined && name === opts.self) || isSelfHost(name);
      const res = isSelf
        ? localRunner(cmd, { timeoutMs: VERIFY_TIMEOUT_MS })
        : runner(t.device, cmd, { timeoutMs: VERIFY_TIMEOUT_MS });
      probes.set(name, parseRolloutVerifyOutput(res.stdout));
    } catch {
      probes.set(name, {});
    }
  }

  const target = resolveRolloutTarget(explicitVersion, [...probes.values()]);
  const out = new Map<string, RolloutVerification>();
  for (const [name, probe] of probes) {
    out.set(name, classifyRolloutVerification(probe, target));
  }
  return out;
}
