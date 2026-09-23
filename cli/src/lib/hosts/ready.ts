/**
 * Host readiness + bootstrap.
 *
 * Before a dispatch we ensure the box is reachable and has agents-cli. Enrollment
 * can additionally install/upgrade agents-cli to match the local version (version
 * parity) using the same shape as scripts/sandbox.sh. We never copy `.history`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sshExec, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { hostIdentityArgs, sshTargetFor } from './types.js';
import { remoteShellFor, buildWindowsAgentsCommand, encodePowershell, powershellQuote, POWERSHELL_PROGRESS_SILENCE } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';

/** Resolve this CLI's own version by walking up to the nearest package.json. */
export function localCliVersion(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      const data = JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string; version?: string };
      if (data.name && data.version) return data.version;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** ssh command that confirms reachability and echoes the OS. POSIX boxes answer
 * `uname -s`; a Windows target has no `uname` (ssh lands in cmd.exe/PowerShell),
 * so it runs a tiny PowerShell probe. Pure/exported so both branches are
 * unit-testable without ssh. */
export function buildProbeCommand(os?: string): string {
  if (remoteShellFor(os) === 'powershell') {
    return `powershell -NoProfile -EncodedCommand ${encodePowershell('[System.Environment]::OSVersion.Platform.ToString()')}`;
  }
  return 'uname -s 2>/dev/null || echo unknown';
}

/**
 * Reachability + OS probe over ssh. `os` is the caller's hint (device-registry
 * platform / enrolled `HostEntry.os`); when it marks the host Windows we take
 * the PowerShell path and report that known platform, otherwise POSIX + uname.
 */
export function probeHost(target: string, os?: string, extraSshArgs: string[] = []): { reachable: boolean; os?: string } {
  const r = sshExec(target, buildProbeCommand(os), { timeoutMs: 12000, extraSshArgs });
  if (r.code !== 0) return { reachable: false };
  if (remoteShellFor(os) === 'powershell') return { reachable: true, os };
  const uname = r.stdout.trim();
  return { reachable: true, os: uname && uname !== 'unknown' ? uname : undefined };
}

/** ssh command that prints the remote agents-cli version. Pure/exported. */
export function buildRemoteVersionCommand(os?: string): string {
  return remoteShellFor(os) === 'powershell'
    ? buildWindowsAgentsCommand({ args: ['--version'] })
    : 'bash -lc "agents --version 2>/dev/null"';
}

/** ssh command that installs/upgrades agents-cli to `spec` then `agents setup`.
 * PowerShell has no `tail`/`[ -d ]`/`||`, so the Windows branch uses native
 * equivalents (`Select-Object -Last`, `Test-Path`). Pure/exported. */
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

/** Install (or upgrade to) a specific agents-cli version on the remote, then `agents setup`. */
export function bootstrapAgentsCli(target: string, version: string | null, os?: string, extraSshArgs?: string[]): { ok: boolean; output: string } {
  const spec = version ? `@phnx-labs/agents-cli@${version}` : '@phnx-labs/agents-cli';
  const r = sshExec(target, buildBootstrapCommand(spec, os), { timeoutMs: 300000, extraSshArgs });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

/** Sentinel splitting the version output from the agent listing in one probe. */
const READY_MARKER = '@@AGENTS_READY@@';

export interface ReadyProbe {
  /** ssh connected and the remote login shell ran (our sentinel came back). */
  reachable: boolean;
  /** Remote agents-cli version (no leading `v`), or null if not installed. */
  version: string | null;
  /** Raw `agents view`/`list` output, for installed-agent checks. */
  view: string;
  /** True when the ssh probe timed out before the sentinel arrived. */
  timedOut?: boolean;
}

/**
 * Answer every readiness question in ONE ssh round-trip: reachable? (the login
 * shell ran and echoed our sentinel), agents-cli version, and the installed-agent
 * listing. This replaces three sequential probes (`true` + `agents --version` +
 * `agents view`) — 3 handshakes collapse to 1. Reachability keys off the sentinel
 * rather than the exit code, so a command that ran-but-failed is never mistaken
 * for a dead connection (only ssh's own failure drops the sentinel).
 */
/**
 * The one-shot readiness command (version + sentinel + agent listing). The
 * Windows branch emits the sentinel with `Write-Output` and branches on
 * `$LASTEXITCODE` (no `printf`/`||`); `parseReadyProbe` keys off the sentinel
 * substring, so the missing leading newline vs the POSIX `printf '\n…'` form is
 * absorbed by its `.trim()`. Pure/exported so both branches are unit-testable.
 *
 * With `ingestUsage`, the probe first runs `agents __usage-ingest` on the
 * dispatcher's daemon-state envelope, which the caller pipes to stdin
 * (PHNX-4116): the chosen worker then holds the dispatcher's current usage
 * numbers at dispatch instead of waiting for the next 15-minute usage-sync
 * tick. The ingest writes nothing to stdout (only `--reply` does), so the
 * version/sentinel/listing shape `parseReadyProbe` reads is unchanged. On
 * Windows the `agents.ps1` shim drops ssh-piped stdin, so PowerShell reads it
 * into a temp file and hands the verb `--from <path>`.
 */
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
  // Disable multiplexing: a stale control socket can hang the local ssh client
  // until the timeout fires, just like sshExecAsync does for the same reason.
  const r = sshExec(target, buildReadyProbeCommand(os), { timeoutMs: 20000, multiplex: false, extraSshArgs });
  if (r.timedOut) return { reachable: false, version: null, view: '', timedOut: true };
  return parseReadyProbe(r.stdout);
}

/** Pure parser for `readyProbe` output (unit-tested without ssh). */
export function parseReadyProbe(stdout: string): ReadyProbe {
  const idx = stdout.indexOf(READY_MARKER);
  if (idx === -1) return { reachable: false, version: null, view: '' };
  const version = stdout.slice(0, idx).trim().replace(/^v/, '') || null;
  return { reachable: true, version, view: stdout.slice(idx + READY_MARKER.length) };
}

/** True if `view` output lists the named agent (word-boundary, case-insensitive). */
export function viewHasAgent(view: string, agent: string): boolean {
  return new RegExp(`\\b${agent}\\b`, 'i').test(view);
}

/**
 * True when `version` is a concrete pin the remote must already have installed
 * (e.g. `0.145.0`, `2.1.207`). Aliases (`latest` / `oldest` / `pinned` /
 * `default` / `all` / `any`) resolve against the remote's own install set and
 * are not preflight-checked here.
 */
export function isConcreteVersionPin(version?: string | null): boolean {
  if (!version) return false;
  const v = version.trim();
  if (!v) return false;
  // Keep in lockstep with agent-spec AGENT_QUALIFIERS (+ `any` filter token).
  if (['latest', 'oldest', 'pinned', 'default', 'all', 'any'].includes(v.toLowerCase())) return false;
  // Same shape agent-spec accepts for an exact pin (no path traversal / spaces).
  return /^(?!.*\.\.)[A-Za-z0-9._+-]{1,64}$/.test(v);
}

/**
 * Installed version strings for `agent` from `agents view --json` output.
 * Returns `[]` when the agent row is absent, `undefined` when `view` is not
 * JSON (text `agents list` fallback) so callers can degrade.
 */
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

/**
 * Whether a concrete `agent@version` is installed according to remote view
 * output. JSON path is authoritative; text listing falls back to a whole-token
 * version match. `undefined` only when the text path has the agent but no
 * version token to confirm against (callers treat that as unverified).
 */
export function viewHasAgentVersion(view: string, agent: string, version: string): boolean | undefined {
  const versions = viewAgentVersions(view, agent);
  if (versions !== undefined) return versions.includes(version);
  if (!viewHasAgent(view, agent)) return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b${escaped}\\b`).test(view)) return true;
  return undefined;
}

/** Actionable fail-loud message for a missing remote pin (RUSH-2313). */
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

/** Account eligibility extracted from one device's `agents view --json`. */
interface ViewAgentAccountEligibility {
  /** At least one account can launch immediately. */
  signedIn: boolean | undefined;
  /** At least one account can launch immediately or enter the harness login flow. */
  pickerEligible: boolean | undefined;
  /**
   * The remote box's own aggregate exclusion reason when it is not signed in
   * (`runReady.reason` — e.g. `all signed_out`), for the operator-facing
   * placement error. Undefined when ready, absent, or on an older remote CLI.
   */
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
 * An older remote CLI omits `runReady`; the one-release fallback trusts the
 * strict per-version `launchable` signal (`isLaunchableSignedIn`, PHNX-3466) for
 * sign-in and leaves the finer picker decision to the remote's own run path.
 */
export function viewAgentAccountEligibility(view: string, agent: string): ViewAgentAccountEligibility {
  try {
    const rows = JSON.parse(view) as Array<{
      agent?: string;
      runReady?: {
        ready?: boolean;
        reason?: string;
        accounts?: Array<{ ready?: boolean; reason?: string }>;
      };
      versions?: Array<{ signedIn?: boolean; launchable?: boolean }>;
    }>;
    const row = rows.find((candidate) => candidate.agent?.toLowerCase() === agent.toLowerCase());
    if (!row) return { signedIn: undefined, pickerEligible: undefined };

    const runReady = row.runReady;
    if (runReady && typeof runReady.ready === 'boolean') {
      // A signed-out / revoked account is picker-eligible even when not ready —
      // launching it IS the login flow. A throttled account is not.
      const accounts = runReady.accounts ?? [];
      const pickerEligible = runReady.ready
        || accounts.some((a) => a.reason === 'signed_out' || a.reason === 'revoked');
      return {
        signedIn: runReady.ready,
        pickerEligible,
        reason: runReady.ready ? undefined : runReady.reason,
      };
    }

    // One-release fallback for an older remote CLI without `runReady`.
    const launchables = (row.versions ?? []).flatMap((version) => {
      if (typeof version.signedIn !== 'boolean') return [];
      // Prefer the strict per-version launch signal; fall back to the display
      // `signedIn` for a CLI old enough to omit `launchable` too.
      return [typeof version.launchable === 'boolean' ? version.launchable : version.signedIn];
    });
    if (launchables.length === 0) return { signedIn: undefined, pickerEligible: undefined };
    return { signedIn: launchables.some(Boolean), pickerEligible: true };
  } catch {
    return { signedIn: undefined, pickerEligible: undefined };
  }
}

export function viewAgentSignedIn(view: string, agent: string): boolean | undefined {
  return viewAgentAccountEligibility(view, agent).signedIn;
}

interface EnsureReadyOptions {
  agent: string;
  /**
   * Explicit version pin (e.g. `"0.145.0"`). Concrete pins fail loud when the
   * remote does not have that version installed so a detached `--no-follow`
   * dispatch never reports "Dispatched" for a pin the box cannot run
   * (RUSH-2313). Aliases (`latest` / …) are left for the remote CLI to resolve.
   */
  version?: string;
  /** Throw instead of warn when the agent isn't installed remotely. */
  requireAgent?: boolean;
}

/**
 * Pure readiness verdict for the agent/version half of {@link ensureHostReady}
 * (unit-tested without SSH). Returns warnings for soft agent-missing cases, or
 * throws (via the caller's `throw new Error`) when a concrete pin is missing.
 */
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
    // Missing or unverifiable pin: fail loud. Detached host dispatch used to
    // print "Dispatched" and only die in the remote log ("codex@0.145.0 is not
    // installed") — whole fleet drains no-op'd under that silent success.
    throw new Error(missingPinnedVersionMessage(hostName, opts.agent, version, installed));
  }
  if (!viewHasAgent(view, opts.agent)) {
    const msg = `Agent "${opts.agent}" may not be installed on "${hostName}" (remote \`agents add ${opts.agent}\` to install).`;
    if (opts.requireAgent) throw new Error(msg);
    warnings.push(msg);
  }
  return { warnings };
}

/**
 * Verify a host can run the agent: reachable + agents-cli present. Throws with an
 * actionable message otherwise. Agent-not-installed is a warning by default (the
 * remote `agents run` will surface it); pass requireAgent to make it fatal.
 * A concrete `version` pin always fails loud when that version is absent
 * (RUSH-2313) — never a silent "Dispatched" for a pin the box cannot run.
 *
 * One ssh round-trip (`readyProbe`) covers all three checks.
 */
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
