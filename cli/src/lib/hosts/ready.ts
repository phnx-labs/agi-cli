
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sshExec, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { hostIdentityArgs, sshTargetFor } from './types.js';
import { remoteShellFor, buildWindowsAgentsCommand, encodePowershell, powershellQuote, POWERSHELL_PROGRESS_SILENCE } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { AUTH_PROBE_MAX_AGE_MS, isDeadVerdict, type AuthVerdict } from '../auth-health.js';
import { USAGE_STALE_REFUSAL_MAX_AGE_MS } from '../accounting/rotate.js';

export function localCliVersion(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      const data = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string; version?: string };
      if (data.name && data.version) return data.version;
    } catch {
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function buildProbeCommand(os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return `powershell -NoProfile -EncodedCommand ${encodePowershell('[System.Environment]::OSVersion.Platform.ToString()')}`;
  }
  return 'uname -s 2>/dev/null || echo unknown';
}

export function probeHost(target: string, os?: string, extraSshArgs: string[] = []): { reachable: boolean; os?: string } {
  const r = sshExec(target, buildProbeCommand(os), { timeoutMs: 12000, extraSshArgs });
  if (r.code !== 0) return { reachable: false };
  if (remoteShellFor(os) === 'powershell') return { reachable: true, os };
  const uname = r.stdout.trim();
  return { reachable: true, os: uname && uname !== 'unknown' ? uname : undefined };
}

export function buildRemoteVersionCommand(os?: string): string {
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsAgentsCommand({ args: ['--version'] })
    : 'bash -lc "agents --version 2>/dev/null"';
}

export function buildBootstrapCommand(spec: string, os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    const script =
      `${POWERSHELL_PROGRESS_SILENCE}; ` +
      `npm install -g ${powershellQuote(spec)} 2>&1 | Select-Object -Last 3; ` +
      `if (-not (Test-Path "$HOME/.agents/.system")) { agents setup 2>&1 | Select-Object -Last 3 }; ` +
      `agents --version`;
    return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  }
  const script =
    `npm install -g ${shellQuote(spec)} 2>&1 | tail -3; ` +
    `if [ ! -d ~/.agents/.system ]; then agents setup 2>&1 | tail -3 || true; fi; ` +
    `agents --version`;
  return `bash -lc ${shellQuote(script)}`;
}

export function bootstrapAgentsCli(target: string, version: string | null, os?: string, extraSshArgs?: string[]): { ok: boolean; output: string } {
  const spec = version ? `@phnx-labs/agents-cli@${version}` : '@phnx-labs/agents-cli';
  const r = sshExec(target, buildBootstrapCommand(spec, os), { timeoutMs: 300000, extraSshArgs });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

const READY_MARKER = '@@AGENTS_READY@@';

export interface ReadyProbe {
  reachable: boolean;
  version: string | null;
  view: string;
  timedOut?: boolean;
}

export function buildReadyProbeCommand(os?: string, opts: { ingestUsage?: boolean } = {}): string {
  if (remoteShellFor(os) === 'powershell') {
    const ingest = opts.ingestUsage
      ? '$in = [Console]::In.ReadToEnd(); $tmp = $null; ' +
        'try { $tmp = [System.IO.Path]::GetTempFileName(); [System.IO.File]::WriteAllText($tmp, $in); ' +
        'agents __usage-ingest --from $tmp 2>$null } ' +
        'finally { if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } }; '
      : '';
    const script =
      `${POWERSHELL_PROGRESS_SILENCE}; ${ingest}` +
      `agents --version 2>$null; Write-Output "${READY_MARKER}"; ` +
      `agents view --json 2>$null; if ($LASTEXITCODE -ne 0) { agents list 2>$null }`;
    return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
  }
  const script =
    `${opts.ingestUsage ? 'agents __usage-ingest 2>/dev/null; ' : ''}` +
    `agents --version 2>/dev/null; printf '\\n${READY_MARKER}\\n'; ` +
    `agents view --json 2>/dev/null || agents list 2>/dev/null`;
  return `bash -lc ${shellQuote(script)}`;
}

export function readyProbe(target: string, os?: string, extraSshArgs?: string[]): ReadyProbe {
  const r = sshExec(target, buildReadyProbeCommand(os), { timeoutMs: 20000, multiplex: false, extraSshArgs });
  if (r.timedOut) return { reachable: false, version: null, view: '', timedOut: true };
  return parseReadyProbe(r.stdout);
}

export function parseReadyProbe(stdout: string): ReadyProbe {
  const idx = stdout.indexOf(READY_MARKER);
  if (idx === -1) return { reachable: false, version: null, view: '' };
  const version = stdout.slice(0, idx).trim().replace(/^v/, '') || null;
  return { reachable: true, version, view: stdout.slice(idx + READY_MARKER.length) };
}

export function viewHasAgent(view: string, agent: string): boolean {
  return new RegExp(`\\b${agent}\\b`, 'i').test(view);
}

export function isConcreteVersionPin(version?: string | null): boolean {
  if (!version) return false;
  const v = version.trim();
  if (!v) return false;
  if (['latest', 'oldest', 'pinned', 'default', 'all', 'any'].includes(v.toLowerCase())) return false;
  return /^(?!.*\.\.)[A-Za-z0-9._+-]{1,64}$/.test(v);
}

export function viewAgentVersions(view: string, agent: string): string[] | undefined {
  try {
    const rows = JSON.parse(view) as Array<{
      agent?: string;
      versions?: Array<{ version?: string }>;
    }>;
    if (!Array.isArray(rows)) return undefined;
    const row = rows.find((candidate) => candidate.agent?.toLowerCase() === agent.toLowerCase());
    if (!row) return [];
    return (row.versions ?? [])
      .map((entry) => entry.version)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return undefined;
  }
}

export function viewHasAgentVersion(view: string, agent: string, version: string): boolean | undefined {
  const versions = viewAgentVersions(view, agent);
  if (versions !== undefined) return versions.includes(version);
  if (!viewHasAgent(view, agent)) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`).test(view)) return true;
  return undefined;
}

export function missingPinnedVersionMessage(
  hostName: string,
  agent: string,
  version: string,
  installed?: string[],
): string {
  let installedHint = '';
  if (installed) {
    installedHint = installed.length > 0
      ? ` Installed on that box: ${installed.join(', ')}.`
      : ` Agent "${agent}" is not installed there.`;
  }
  return (
    `Pinned ${agent}@${version} is not installed on "${hostName}".${installedHint} ` +
    `Install it on that box: agents ssh ${hostName} -- agents add ${agent}@${version}`
  );
}

interface ViewAgentAccountEligibility {
  signedIn: boolean | undefined;
  pickerEligible: boolean | undefined;
  reason?: string;
}

/**
 * Read the two account gates automatic placement needs from `agents view
 * --json`. A picker may route to a signed-out version because launching it is
 * the login flow, but it must not route to a device whose every signed-in
 * account is throttled.
 *
 * ONE readiness gate, computed on the box that runs (PHNX-4116). The remote box
 * publishes `runReady` — the router's own `collectRunCandidates` →
 * `readinessFromCandidate` verdict over its native slots AND version homes — so
 * this reads that answer rather than re-deriving freshness here. The
 * dispatching box re-deriving from the per-version `versions[]` list was the bug:
 * that list enumerates version homes, misses the account slots a run picks from,
 * and applied a 40-minute usage-freshness refusal a synced-only worker could
 * never satisfy, turning a usage-sync lag into "no ready device" while
 * `--device <name>` on the same box launched fine.
 *
 * An older remote CLI omits `runReady`; the one-release fallback derives the
 * verdict from the per-version list the same way the pre-PHNX-4116 dispatcher
 * did: the strict `launchable` signal (`isLaunchableSignedIn`, PHNX-3466) for
 * sign-in, MINUS a FRESH throttle (`rate_limited`/`out_of_credits` captured
 * within {@link USAGE_STALE_REFUSAL_MAX_AGE_MS}) or a FRESH dead auth verdict
 * (checked within {@link AUTH_PROBE_MAX_AGE_MS}, {@link isDeadVerdict}). A stale
 * reading is UNVERIFIED, not disqualifying (PHNX-4116/#3700), so a usage-sync
 * lag never bars an old-CLI worker `--device <name>` would launch fine — but a
 * throttled-but-launchable worker no longer reads `signedIn: true` and slips
 * into `--device auto`'s pick during a rolling upgrade.
 */
export function viewAgentAccountEligibility(view: string, agent: string, now: number = Date.now()): ViewAgentAccountEligibility {
  try {
    const rows = JSON.parse(view) as Array<{
      agent?: string;
      runReady?: {
        ready?: boolean;
        reason?: string;
        accounts?: Array<{ ready?: boolean; reason?: string }>;
      };
      versions?: Array<{
        signedIn?: boolean;
        launchable?: boolean;
        authVerdict?: AuthVerdict | null;
        authCheckedAt?: number | null;
        usageStatus?: 'available' | 'rate_limited' | 'out_of_credits' | null;
        usageCapturedAt?: string | null;
      }>;
    }>;
    const row = rows.find((candidate) => candidate.agent?.toLowerCase() === agent.toLowerCase());
    if (!row) return { signedIn: undefined, pickerEligible: undefined };

    const runReady = row.runReady;
    if (runReady && typeof runReady.ready === 'boolean') {
      const accounts = runReady.accounts ?? [];
      const pickerEligible = runReady.ready
        || accounts.some((a) => a.reason === 'signed_out' || a.reason === 'revoked');
      return {
        signedIn: runReady.ready,
        pickerEligible,
        reason: runReady.ready ? undefined : runReady.reason,
      };
    }

    const verdicts = (row.versions ?? []).flatMap((version) => {
      if (typeof version.signedIn !== 'boolean') return [];
      const launchable = typeof version.launchable === 'boolean' ? version.launchable : version.signedIn;
      const usageCapturedAt = version.usageCapturedAt ? Date.parse(version.usageCapturedAt) : Number.NaN;
      const usageFresh = Number.isFinite(usageCapturedAt)
        ? now - usageCapturedAt <= USAGE_STALE_REFUSAL_MAX_AGE_MS
        : version.usageCapturedAt === undefined;
      const authFresh = typeof version.authCheckedAt === 'number'
        ? now - version.authCheckedAt <= AUTH_PROBE_MAX_AGE_MS
        : version.authCheckedAt === undefined;
      const throttled = usageFresh
        && (version.usageStatus === 'rate_limited' || version.usageStatus === 'out_of_credits');
      const authBlocked = version.authVerdict !== null
        && version.authVerdict !== undefined
        && authFresh
        && isDeadVerdict(version.authVerdict);
      const ready = launchable && !authBlocked && !throttled;
      return [{ ready, pickerEligible: ready || !launchable || authBlocked }];
    });
    if (verdicts.length === 0) return { signedIn: undefined, pickerEligible: undefined };
    return {
      signedIn: verdicts.some((verdict) => verdict.ready),
      pickerEligible: verdicts.some((verdict) => verdict.pickerEligible),
    };
  } catch {
    return { signedIn: undefined, pickerEligible: undefined };
  }
}

export function viewAgentSignedIn(view: string, agent: string): boolean | undefined {
  return viewAgentAccountEligibility(view, agent).signedIn;
}

interface EnsureReadyOptions {
  agent: string;
  version?: string;
  requireAgent?: boolean;
}

export function evaluateHostAgentInstall(
  view: string,
  opts: EnsureReadyOptions,
  hostName: string,
): { warnings: string[] } {
  const warnings: string[] = [];
  if (isConcreteVersionPin(opts.version)) {
    const version = opts.version!.trim();
    const installed = viewAgentVersions(view, opts.agent);
    const has = viewHasAgentVersion(view, opts.agent, version);
    if (has === true) return { warnings };
    throw new Error(missingPinnedVersionMessage(hostName, opts.agent, version, installed));
  }
  if (!viewHasAgent(view, opts.agent)) {
    const msg = `Agent "${opts.agent}" may not be installed on "${hostName}" (remote \`agents add ${opts.agent}\` to install).`;
    if (opts.requireAgent) throw new Error(msg);
    warnings.push(msg);
  }
  return { warnings };
}

export function ensureHostReady(host: Host, opts: EnsureReadyOptions): { warnings: string[] } {
  const target = sshTargetFor(host);
  const probe = readyProbe(target, host.os ?? resolveRemoteOsSync(host.name), hostIdentityArgs(host));
  if (probe.timedOut) {
    throw new Error(
      `Host "${host.name}" (${target}) did not respond in time — the SSH probe timed out after 20 seconds. ` +
        `The host may be slow to start a login shell (nvm/sdkman init, cold node startup). ` +
        `Retry, or run \`agents ssh ${host.name} agents view\` to confirm manually.`,
    );
  }
  if (!probe.reachable) {
    throw new Error(`Host "${host.name}" (${target}) is not reachable over SSH. Check it's online and key auth works.`);
  }
  if (!probe.version) {
    throw new Error(
      `agents-cli is not installed on "${host.name}". Install it there first — e.g. \`agents devices update\` to roll it out to registered devices.`,
    );
  }
  return evaluateHostAgentInstall(probe.view, opts, host.name);
}
