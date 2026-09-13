/**
 * Post-rollout verification for `agents fleet update` / `agents devices update`.
 *
 * The rollout runs `agents upgrade --yes` per box and calls a box `ok` on
 * `exit 0` alone ({@link ../devices/fleet.js runFleet}, `fleet.ts:262`), rendered
 * as `ok  exit 0` (`commands/ssh.ts:416`). That exit code says the npm global was
 * upgraded — it says nothing about **which copy `agents` resolves to on that
 * box**. Any install earlier on PATH than the npm global — a stale copy in
 * another node prefix, a Homebrew shim, a hand-made symlink — keeps winning the
 * name after the upgrade. The upgrade then succeeds, the rollout prints `ok`,
 * and every `agents` command on that box still runs the old code (RUSH-2446).
 *
 * `scripts/install.sh` used to be the usual culprit, linking its side-by-side
 * dev build over `~/.local/bin/agents`; it now publishes `agents-dev` instead and
 * cleans up the links it left. This probe stays as the general backstop — it is
 * name-based (`command -v agents`), so it catches every other cause too.
 *
 * So the rollout asks each box one more question after upgrading: what does
 * `agents` resolve to here, and what version does it report? A box whose
 * resolved `agents` is not on the target is reported as **not upgraded**, and a
 * dev stamp is named as such — never counted as a success.
 *
 * Everything below the probe argv is pure: the shell output is parsed and
 * classified without touching a filesystem or a network, so the verdicts are
 * unit-tested against real probe output rather than a mocked fleet.
 */

import { compareVersions } from '../agent-spec/primitives.js';
import { isDevVersionStamp } from '../startup/dev-build.js';
import {
  runLocalCommand,
  runOnDevice,
  type FleetRunResult,
  type FleetTarget,
} from './fleet.js';
import { isSelfHost } from './self-host.js';

/**
 * Line prefixes the probe emits. Prefixed rather than positional because a
 * login shell can print its own banner lines into the same stdout, and a
 * rollout that mis-reads a motd line as a version would report a false verdict.
 */
const PATH_PREFIX = 'agents-rollout-path=';
const VERSION_PREFIX = 'agents-rollout-version=';

/**
 * Argv for the verification probe, run on each box right after its upgrade.
 *
 * Space-joined and evaluated by a shell on both fleet paths — `runOnDevice`
 * hands the tokens to ssh (the remote shell parses them) and `runLocalCommand`
 * joins them under `shell: true` (`fleet.ts:runLocalCommand` docblock) — so the
 * quoting here is the same on the self target and every peer.
 *
 * POSIX only, deliberately: the two `sh` builtins it needs (`command -v`,
 * parameter substitution) do not exist in cmd.exe, so a Windows box yields no
 * parseable output and {@link classifyRolloutVerification} reports it
 * `unverified` rather than silently passing it.
 *
 * `command -v agents` is the resolution the user's own shell performs;
 * `readlink -f` follows the npm/dev bin symlink to the copy that actually runs,
 * falling back to the unresolved path where `readlink -f` is unavailable.
 */
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
  /** Path the box's own `agents` resolves to, symlinks followed. */
  resolvedPath?: string;
  /** Version that resolved copy reports. */
  reportedVersion?: string;
}

/** Parse the probe's stdout. Unlabelled lines (shell banners, motd) are ignored. */
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
  /** The resolved `agents` reports the target version. */
  | 'on-target'
  /** The resolved `agents` is a `scripts/install.sh` dev build shadowing the upgraded global. */
  | 'dev-shadowed'
  /** The resolved `agents` reports some other version — the upgrade did not reach it. */
  | 'not-upgraded'
  /** The probe produced no usable answer, so upgraded-ness is unknown. */
  | 'unverified';

export interface RolloutVerification extends RolloutProbe {
  verdict: RolloutVerdict;
  /** One-line human reason, always set for a non-`on-target` verdict. */
  detail: string;
}

/** A verdict other than `on-target` MUST NOT be reported as a successful rollout. */
export function isRolloutSuccess(verdict: RolloutVerdict): boolean {
  return verdict === 'on-target';
}

/**
 * Resolve the version the rollout was aiming at.
 *
 * An explicit `agents fleet update <version>` names it. A bare
 * `agents fleet update` resolves the `latest` dist-tag independently on every
 * box, so the aggregator never sees a number — it is derived here as the highest
 * **released** version any probed box reports. Dev stamps are excluded from that
 * derivation: a fleet of dev builds must not elect one of them as the target and
 * report itself upgraded. Returns undefined when nothing released was observed,
 * which makes every box `unverified` rather than falsely `on-target`.
 */
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

/**
 * A dist-tag (`latest`, `next`) is not a comparable version. `agents fleet update`
 * accepts either (`fleet.ts:upgradeCommand`), so a tag argument is treated the
 * same as no argument: derive the number from what the fleet reports.
 */
function isDistTag(version: string): boolean {
  return !/^\d/.test(version);
}

/** Classify one box's probe against the rollout target. */
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

/** Probe deadline. The probe is two shell builtins plus `agents --version`. */
const VERIFY_TIMEOUT_MS = 60_000;

interface VerifyFleetRolloutOptions {
  /** Name of THIS machine; its target is probed locally, mirroring `runFleet`. */
  self?: string;
  /** Injectable ssh runner (tests). */
  runner?: typeof runOnDevice;
  /** Injectable local runner (tests). */
  localRunner?: typeof runLocalCommand;
}

/**
 * Probe every box the upgrade reported `ok` and classify what its `agents`
 * actually resolves to. Keyed by device name.
 *
 * Only `ok` boxes are probed: a `skipped` or `failed` row already reports itself
 * loudly, and re-probing it would add a second confusing line for one fault.
 * A probe that throws or exits non-zero yields `unverified`, never `on-target` —
 * "we could not check" and "it is upgraded" are different answers.
 */
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
