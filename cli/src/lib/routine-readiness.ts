/**
 * Activation readiness for a routine, composed from the target-aware execution
 * context ({@link resolveJobExecutionContext}) plus the harness/target checks a
 * caller can perform on this box (agent installed). This is the gate `add`,
 * `edit`, `doctor`, and `resume` all run before activating a routine: ready →
 * active, any proven blocker → saved paused with a stable code + repair command.
 *
 * Structural context readiness is synchronous for the scheduler. Interactive
 * add/edit/doctor/resume additionally call the live variant below, which probes
 * authentication and Codex's native workspace-trust record before activation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as TOML from 'smol-toml';
import type { JobConfig } from './scheduling/routines.js';
import { resolveJobExecutionContext, resolveHostStrategy } from './scheduling/routines.js';
import { evaluateRoutineReadiness, type RoutineReadinessResult, type RoutineReadiness, type PlacementMode } from './routine-context.js';
import { readAuthHealth, type AuthVerdict } from './auth-health.js';
import { machineId } from './machine-id.js';
import { getVersionHomePath, isVersionInstalled, resolveVersion } from './installations/versions.js';
import { probeLocalFleetAuth } from './auth-health.js';
import { resolveHostRunTarget } from './hosts/run-target.js';
import { hostIdentityArgs, sshTargetFor } from './hosts/types.js';
import { probeHost } from './hosts/ready.js';
import { sshExec, shellQuote } from './ssh-exec.js';
import { encodePowershell, powershellQuote, POWERSHELL_PROGRESS_SILENCE } from './hosts/remote-cmd.js';

/**
 * Verdicts that make a FIRE-TIME auth preflight block the run: the last live
 * probe found the account either server-rejected (`revoked`) or with no
 * credential at all (`unconfigured` — the "Please run /login" / "no account
 * signed in" case, which is the most common way a routine's dispatch account
 * goes dead). Everything else fails OPEN: `rate_limited` is still authenticated,
 * `expired` self-heals on the next refresh, `unverified` means signed-in but no
 * live probe endpoint (codex/grok), and `error` is indeterminate — none of those
 * should stop a fire. This is deliberately BROADER than {@link isDeadVerdict}
 * (display-only, `revoked` alone): a signed-out account must block a fire, not
 * just paint a red cell.
 */
function fireBlockingAuthVerdict(verdict: AuthVerdict): boolean {
  return verdict === 'revoked' || verdict === 'unconfigured';
}

/**
 * Fire-time auth preflight: read the daemon-warmed auth-health cache for the
 * exact (agent, version) a routine has resolved to run, and return an
 * `agent_auth_failed` blocker when that account is provably signed out — so the
 * daemon records a terminal `blocked` run (with the re-login repair) instead of
 * spawning a doomed run that 401s and burns a session (PHNX-3415).
 *
 * Cache-only (no network, no prompt — the daemon refreshes the cache
 * periodically and `fleet ping` writes it), and fails OPEN on a missing or
 * non-blocking verdict so a stale/absent probe never wedges a routine. It is
 * checked AFTER version rotation resolves the account (`launch.chain[0]`), so it
 * judges the identity the run will actually use, never a rotated-past dead pin.
 */
export function fireTimeAuthReadiness(agent: string, version: string): RoutineReadiness | null {
  const health = readAuthHealth(machineId(), agent, version);
  if (!health || !fireBlockingAuthVerdict(health.verdict)) return null;
  const who = health.account ? ` (${health.account})` : '';
  return {
    code: 'agent_auth_failed',
    message: `the ${agent}${who} account is signed out — the last auth probe returned '${health.verdict}', so this run would fail authentication`,
    repair: `agents run ${agent}@${version} -- login`,
  };
}

/**
 * Evaluate whether a routine is ready to activate on this box. `probeAgent`
 * defaults to "is a version of the routine's agent resolvable" via
 * {@link resolveVersion}; pass a stub in tests to exercise the availability path
 * without an installed harness.
 */
export function evaluateActivationReadiness(
  config: JobConfig,
  deps: { probeAgent?: (agent: string) => boolean } = {},
): RoutineReadinessResult {
  const strategy = resolveHostStrategy(config);
  const mode: PlacementMode = strategy;
  // Local placement inspects this box's filesystem; a remote/cloud target defers
  // existence (its filesystem is unreachable here) and checks portability only.
  const context = resolveJobExecutionContext(config, {
    mode,
    probe: mode === 'local' ? undefined : null,
  });

  // A pinned version on LOCAL placement must exist here — accepting a routine
  // whose exact pin is absent just moves the failure to fire time (RUSH-2719).
  // Remote host/fleet targets defer the check: their installs are unreachable
  // from this box until the RUSH-2290 execution-context-on-target resolver.
  const pinnedLocally = mode === 'local' ? config.version : undefined;
  const probeAgent = deps.probeAgent ?? ((agent: string) =>
    pinnedLocally
      ? isVersionInstalled(agent as never, pinnedLocally)
      : resolveVersion(agent as never) !== undefined);
  return evaluateRoutineReadiness(
    context,
    {
      // Command routines have no agent to install; workflow routines dispatch
      // through `agents run` (claude under the hood) and are checked at run time.
      agentInstalled: config.agent && !config.workflow && !config.command
        ? () => probeAgent(config.agent!)
        : undefined,
    },
    { agent: config.agent, version: pinnedLocally },
  );
}

interface RemoteProjectDefinition {
  name: string;
  root?: string;
  defaultPath?: string;
}

/** Parse the target HOME sentinel and the project catalog returned by one SSH call. */
export function parseRemoteProjectSnapshot(stdout: string): { home: string; projects: RemoteProjectDefinition[] } | undefined {
  const lines = stdout.split(/\r?\n/);
  const homeLine = lines.shift();
  if (!homeLine?.startsWith('__HOME__')) return undefined;
  const home = homeLine.slice('__HOME__'.length);
  if (!home) return undefined;
  try {
    const projects = JSON.parse(lines.join('\n')) as unknown;
    if (!Array.isArray(projects)) return undefined;
    if (!projects.every((entry) => entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')) {
      return undefined;
    }
    return { home, projects: projects as RemoteProjectDefinition[] };
  } catch {
    return undefined;
  }
}

/** Build a target-native probe that creates and removes a file in the workspace. */
export function buildRemoteWorkspaceProbe(cwd: string, windows: boolean): string {
  if (windows) {
    return `powershell -NoProfile -EncodedCommand ${encodePowershell(`$d=${powershellQuote(cwd)}; if (-not (Test-Path -LiteralPath $d -PathType Container)) { exit 1 }; $p=Join-Path $d ([IO.Path]::GetRandomFileName()); try { New-Item -ItemType File -Path $p -ErrorAction Stop | Out-Null; Remove-Item -LiteralPath $p -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`)}`;
  }
  const pattern = path.posix.join(cwd, '.agents-routine-readiness.XXXXXX');
  return `probe_path=$(mktemp ${shellQuote(pattern)}) && rm -f "$probe_path"`;
}

/** A successful probe must contain the exact requested postcondition, not merely exit zero. */
export function probeOutputHasSentinel(stdout: string, sentinel: string): boolean {
  const containsExact = (value: unknown): boolean => {
    if (value === sentinel) return true;
    if (Array.isArray(value)) return value.some(containsExact);
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsExact);
    return false;
  };
  return stdout.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === sentinel) return true;
    try { return containsExact(JSON.parse(trimmed)); } catch { return false; }
  });
}

function codexWorkspaceTrusted(version: string, cwd: string): boolean {
  try {
    const configPath = path.join(getVersionHomePath('codex', version), '.codex', 'config.toml');
    const parsed = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, { trust_level?: string }> | undefined;
    return Object.entries(projects ?? {}).some(([root, project]) => {
      if (project.trust_level !== 'trusted') return false;
      const relative = path.relative(root, cwd);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  } catch {
    return false;
  }
}

/**
 * Verdicts a routine's activation auth check accepts as usable. `no_evidence` is
 * here for robustness (a payload that still carries one), but a box that cannot
 * probe DROPS it in {@link probeLocalFleetAuth}, so the real path for those boxes
 * is the absent-row + launchability fallback in {@link decideRoutineAuthReadiness}
 * (PHNX-4116).
 */
const ROUTINE_AUTH_ACCEPTED: ReadonlySet<AuthVerdict> = new Set<AuthVerdict>([
  'live', 'rate_limited', 'unverified', 'no_evidence',
]);

/**
 * ONE decision the local ({@link evaluateActivationReadinessLive}) and host
 * ({@link evaluateHostActivationReadiness}) readiness paths share, so both reach
 * the SAME answer for the same box (PHNX-4116). `row` is that box's probe verdict
 * for the routine's agent — ABSENT when the box could not probe (a worker's
 * setup-token box, or a headed box that spent its hourly usage-endpoint budget,
 * both drop `no_evidence` in `probeLocalFleetAuth`). `launchable` is whether the
 * box holds a launchable signed-in credential, from the SAME
 * `collectRunCandidates`/`isLaunchableSignedIn` the run router uses — so a
 * token-backed routine on a box that cannot probe stays activatable, a box with
 * no credential at all fails `unconfigured`, and a server rejection (`revoked` —
 * the only present-but-not-accepted verdict these force-probed paths produce)
 * blocks regardless of a token on disk.
 */
export function decideRoutineAuthReadiness(
  row: { verdict: AuthVerdict } | undefined,
  launchable: boolean,
): { ok: boolean; reason?: string } {
  if (row && ROUTINE_AUTH_ACCEPTED.has(row.verdict)) return { ok: true };
  if (!row) return launchable ? { ok: true } : { ok: false, reason: 'unconfigured' };
  return { ok: false, reason: row.verdict };
}

/**
 * Decide a host-placed routine's auth readiness from the REMOTE box's `devices
 * ping --local --json` payload (PHNX-4116). Pure over the payload TEXT so it is
 * unit-tested without SSH: it finds this agent's probe row (ABSENT when the box
 * dropped its `no_evidence` row) and reads the box's per-agent launchability the
 * ping now carries, then runs {@link decideRoutineAuthReadiness} — so a host box
 * that could not probe but holds a token is ready, exactly as the local path
 * decides for the same box. Returns null when the payload cannot be parsed; the
 * caller treats that as a probe failure, never as "no credential".
 */
export function decideHostAuthFromPing(
  stdout: string,
  agent: string,
): { ok: boolean; reason?: string } | null {
  let payload: unknown;
  try { payload = JSON.parse(stdout); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  const { rows, launchable } = payload as {
    rows?: Array<{ agent?: string; health?: { verdict?: AuthVerdict } }>;
    launchable?: string[];
  };
  const verdict = rows?.find((row) => row.agent === agent)?.health?.verdict;
  const row = verdict ? { verdict } : undefined;
  return decideRoutineAuthReadiness(row, launchable?.includes(agent) ?? false);
}

/**
 * Interactive setup/repair readiness. Unlike the scheduler's deterministic
 * structural gate, this completes a real local auth request and reads Codex's
 * native trust record before add/edit/resume can activate the definition.
 */
export async function evaluateActivationReadinessLive(config: JobConfig): Promise<RoutineReadinessResult> {
  const structural = evaluateActivationReadiness(config);
  if (!structural.ready) return structural;

  const mode = resolveHostStrategy(config);
  if (mode === 'host' && config.host) return evaluateHostActivationReadiness(config);
  if (mode !== 'local' || !config.agent || config.workflow || config.command) return structural;
  const version = resolveVersion(config.agent as never);
  if (!version) return structural;
  const context = resolveJobExecutionContext(config, { mode: 'local' });

  // The probe row (absent when this box could not probe — a worker's setup-token
  // box drops `no_evidence`) plus the run-router launchability, run through the
  // ONE decision the host path also uses so both agree for the same box.
  const rows = await probeLocalFleetAuth({ agents: [config.agent as never] });
  const row = rows.find((candidate) => candidate.version === version);
  const { collectRunCandidates } = await import('./accounting/rotate.js');
  const launchable = (await collectRunCandidates(config.agent as never)).some((candidate) => candidate.signedIn);
  const authVerdict = decideRoutineAuthReadiness(row?.health, launchable);

  return evaluateRoutineReadiness(context, {
    agentInstalled: () => true,
    ...(config.agent === 'codex' && context.absoluteCwd
      ? { codexTrusted: () => codexWorkspaceTrusted(version, context.absoluteCwd!) }
      : {}),
    authOk: () => authVerdict,
  }, { agent: config.agent });
}

/** Resolve and probe the actual SSH target used by a host-placed routine. */
export async function evaluateHostActivationReadiness(config: JobConfig): Promise<RoutineReadinessResult> {
  const host = await resolveHostRunTarget(config.host!);
  const target = sshTargetFor(host);
  const identity = hostIdentityArgs(host);
  if (!probeHost(target, host.os, identity).reachable) {
    return evaluateRoutineReadiness(resolveJobExecutionContext(config, { mode: 'host', probe: null }), {
      targetReachable: () => false,
    }, { agent: config.agent });
  }

  const windows = host.os?.toLowerCase().includes('win') ?? false;
  const homeCommand = windows
    ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`${POWERSHELL_PROGRESS_SILENCE}; Write-Output ("__HOME__" + $HOME); & agents projects list --json`)}`
    : `bash -lc ${shellQuote('printf "__HOME__%s\\n" "$HOME"; agents projects list --json')}`;
  const projectResult = sshExec(target, homeCommand, { timeoutMs: 20_000, extraSshArgs: identity });
  if (projectResult.code !== 0) {
    return evaluateRoutineReadiness(resolveJobExecutionContext(config, { mode: 'host', probe: null }), {
      targetReachable: () => false,
    }, { agent: config.agent });
  }
  const snapshot = parseRemoteProjectSnapshot(projectResult.stdout);
  if (!snapshot) {
    return evaluateRoutineReadiness(resolveJobExecutionContext(config, { mode: 'host', probe: null }), {
      targetReachable: () => false,
    }, { agent: config.agent });
  }
  const targetHome = snapshot.home;
  const defs = snapshot.projects;
  const def = config.project ? defs.find((candidate) => candidate.name === config.project) : undefined;
  const projectResolution = config.project
    ? (def ? { defined: true as const, base: def.defaultPath ?? def.root } : { defined: false as const })
    : undefined;
  const unprobed = resolveJobExecutionContext(config, { mode: 'host', targetHome, probe: null, projectResolution });
  if (!unprobed.ready || !unprobed.absoluteCwd) return { context: unprobed, ready: false, readiness: unprobed.readiness };

  const check = buildRemoteWorkspaceProbe(unprobed.absoluteCwd, windows);
  const fsResult = sshExec(target, check, { timeoutMs: 12_000, extraSshArgs: identity });
  if (fsResult.code !== 0) {
    return evaluateRoutineReadiness({ ...unprobed, ready: false, readiness: {
      code: 'workspace_not_writable',
      message: `the execution directory is missing or not writable on ${host.name}: ${unprobed.resolvedCwd}`,
    } });
  }

  if (config.agent && !config.workflow && !config.command) {
    if (config.agent === 'codex') {
      const args = ['run', 'codex', 'Reply with exactly ROUTINE_READY', '--mode', 'plan', '--timeout', '45s', '--json'];
      const command = windows
        ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`${POWERSHELL_PROGRESS_SILENCE}; Set-Location -LiteralPath ${powershellQuote(unprobed.absoluteCwd)}; & agents ${args.map(powershellQuote).join(' ')}`)}`
        : `cd ${shellQuote(unprobed.absoluteCwd)} && agents ${args.map(shellQuote).join(' ')}`;
      const probe = sshExec(target, command, { timeoutMs: 60_000, extraSshArgs: identity });
      if (probe.code !== 0 || !probeOutputHasSentinel(probe.stdout, 'ROUTINE_READY')) {
        const detail = `${probe.stderr}\n${probe.stdout}`.trim();
        const untrusted = detail.includes('trusted directory') || detail.includes('trusted workspace');
        return evaluateRoutineReadiness(unprobed, {
          ...(untrusted ? { codexTrusted: () => false } : { authOk: () => ({ ok: false, reason: detail || 'probe failed' }) }),
        }, { agent: config.agent });
      }
    } else {
      const pingArgs = ['devices', 'ping', '--local', '--json'];
      const command = windows
        ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`${POWERSHELL_PROGRESS_SILENCE}; & agents ${pingArgs.map(powershellQuote).join(' ')}`)}`
        : `agents ${pingArgs.map(shellQuote).join(' ')}`;
      const probe = sshExec(target, command, { timeoutMs: 30_000, extraSshArgs: identity });
      // A ping that could not run or parse is a probe FAILURE, never mistaken for
      // "no credential": block with the failure so the operator sees it. A parsed
      // payload runs the shared decision — an ABSENT row (the remote dropped its
      // `no_evidence`) plus the launchability the ping now carries is ready,
      // exactly as the local path decides for the same box (PHNX-4116).
      const decision = probe.code === 0 ? decideHostAuthFromPing(probe.stdout, config.agent) : null;
      if (!decision) {
        return evaluateRoutineReadiness(unprobed, {
          authOk: () => ({ ok: false, reason: `devices ping --local failed on ${host.name}` }),
        }, { agent: config.agent });
      }
      if (!decision.ok) {
        return evaluateRoutineReadiness(unprobed, {
          authOk: () => decision,
        }, { agent: config.agent });
      }
    }
  }

  return { context: unprobed, ready: true };
}
