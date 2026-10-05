
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

export function fireTimeAuthReadiness(agent: string, version: string): RoutineReadiness | null {
  // Fire-time auth is cache-only and fail-open unless the last verdict proves signed-out/revoked.
  const health = readAuthHealth(machineId(), agent, version);
  if (!health || !fireBlockingAuthVerdict(health.verdict)) return null;
  const who = health.account ? ` (${health.account})` : '';
  return {
    code: 'agent_auth_failed',
    message: `the ${agent}${who} account is signed out — the last auth probe returned '${health.verdict}', so this run would fail authentication`,
    repair: `agents run ${agent}@${version} -- login`,
  };
}

export function evaluateActivationReadiness(
  config: JobConfig,
  deps: { probeAgent?: (agent: string) => boolean } = {},
): RoutineReadinessResult {
  const strategy = resolveHostStrategy(config);
  const mode: PlacementMode = strategy;
  const context = resolveJobExecutionContext(config, {
    mode,
    probe: mode === 'local' ? undefined : null,
  });

  const pinnedLocally = mode === 'local' ? config.version : undefined;
  const probeAgent = deps.probeAgent ?? ((agent: string) =>
    pinnedLocally
      ? isVersionInstalled(agent as never, pinnedLocally)
      : resolveVersion(agent as never) !== undefined);
  return evaluateRoutineReadiness(
    context,
    {
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

export function buildRemoteWorkspaceProbe(cwd: string, windows: boolean): string {
  if (windows) {
    return `powershell -NoProfile -EncodedCommand ${encodePowershell(`$d=${powershellQuote(cwd)}; if (-not (Test-Path -LiteralPath $d -PathType Container)) { exit 1 }; $p=Join-Path $d ([IO.Path]::GetRandomFileName()); try { New-Item -ItemType File -Path $p -ErrorAction Stop | Out-Null; Remove-Item -LiteralPath $p -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`)}`;
  }
  const pattern = path.posix.join(cwd, '.agents-routine-readiness.XXXXXX');
  return `probe_path=$(mktemp ${shellQuote(pattern)}) && rm -f "$probe_path"`;
}

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

const ROUTINE_AUTH_ACCEPTED: ReadonlySet<AuthVerdict> = new Set<AuthVerdict>([
  'live', 'rate_limited', 'unverified', 'no_evidence',
]);

export function decideRoutineAuthReadiness(
  row: { verdict: AuthVerdict } | undefined,
  launchable: boolean,
): { ok: boolean; reason?: string } {
  // Local and remote probes share absent-row semantics: launchability proves token-backed readiness.
  if (row && ROUTINE_AUTH_ACCEPTED.has(row.verdict)) return { ok: true };
  if (!row) return launchable ? { ok: true } : { ok: false, reason: 'unconfigured' };
  return { ok: false, reason: row.verdict };
}

export function decideHostAuthFromPing(
  stdout: string,
  agent: string,
): { ok: boolean; reason?: string } | null {
  // Unparseable output is a probe failure, never evidence that a credential is absent.
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

export async function evaluateActivationReadinessLive(config: JobConfig): Promise<RoutineReadinessResult> {
  const structural = evaluateActivationReadiness(config);
  if (!structural.ready) return structural;

  const mode = resolveHostStrategy(config);
  if (mode === 'host' && config.host) return evaluateHostActivationReadiness(config);
  if (mode !== 'local' || !config.agent || config.workflow || config.command) return structural;
  const version = resolveVersion(config.agent as never);
  if (!version) return structural;
  const context = resolveJobExecutionContext(config, { mode: 'local' });

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
    // A failed live probe stays distinct from an absent auth row.
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
