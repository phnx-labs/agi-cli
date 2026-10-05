/** Activation readiness for a routine: the target-aware execution context plus harness checks
 * possible on this box. The check `add`, `edit`, `doctor` and `resume` run before activating: ready
 * -> active, any blocker -> saved paused with a stable code and repair command. */

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

/** Verdicts that block a FIRE-TIME auth preflight: `revoked` or `unconfigured` (no credential).
 * All else fails OPEN (`rate_limited` is authenticated, `expired` self-heals, `unverified` and
 * `error` are indeterminate). Broader than the display-only {@link isDeadVerdict}. */
function fireBlockingAuthVerdict(verdict: AuthVerdict): boolean {
  return verdict === 'revoked' || verdict === 'unconfigured';
}

/** Fire-time auth preflight: reads the daemon-warmed auth-health cache for the exact agent and
 * version; a provably signed-out account yields an `agent_auth_failed` blocker, not a doomed 401
 * (PHNX-3415). Cache-only, fails OPEN, checked after version rotation. */
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

/** Evaluate whether a routine is ready to activate on this box. `probeAgent` defaults to whether a
 * version of the routine's agent resolves via {@link resolveVersion}; tests pass a stub to avoid
 * needing an installed harness. */
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

  // A pinned version on LOCAL placement must exist here, else the failure just moves to fire time
  // (RUSH-2719). Remote host/fleet targets defer the check: their installs are unreachable from
  // this box until the RUSH-2290 target-side resolver.
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

/** Verdicts a routine's activation auth check accepts. `no_evidence` is here for robustness, but a
 * box that can't probe DROPS it in {@link probeLocalFleetAuth}, so the real path for those boxes is
 * the absent-row + launchability fallback in {@link decideRoutineAuthReadiness} (PHNX-4116). */
const ROUTINE_AUTH_ACCEPTED: ReadonlySet<AuthVerdict> = new Set<AuthVerdict>([
  'live', 'rate_limited', 'unverified', 'no_evidence',
]);

/** ONE decision shared by local and host readiness (PHNX-4116). `row` is the box's probe verdict,
 * ABSENT when it couldn't probe; `launchable` comes from `isLaunchableSignedIn`. A token-backed
 * routine on a non-probing box stays activatable; none fails `unconfigured`; `revoked` blocks. */
export function decideRoutineAuthReadiness(
  row: { verdict: AuthVerdict } | undefined,
  launchable: boolean,
): { ok: boolean; reason?: string } {
  if (row && ROUTINE_AUTH_ACCEPTED.has(row.verdict)) return { ok: true };
  if (!row) return launchable ? { ok: true } : { ok: false, reason: 'unconfigured' };
  return { ok: false, reason: row.verdict };
}

/** Decide a host-placed routine's auth readiness from the REMOTE box's `devices ping --local --json`
 * payload (PHNX-4116); pure over the text so it tests without SSH. Null when unparseable, which the
 * caller treats as a probe failure, never "no credential". */
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

/** Interactive setup/repair readiness: unlike the scheduler's deterministic structural check, this
 * completes a real local auth request and reads Codex's native trust record before add/edit/resume
 * can activate. */
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
      // A ping that couldn't run or parse is a probe FAILURE, never "no credential": block with it.
      // A parsed payload runs the shared decision; an ABSENT row plus launchability is ready, as
      // locally (PHNX-4116).
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
