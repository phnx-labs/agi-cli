/**
 * Dispatch a headless `agents …` command onto a host over SSH.
 *
 * The command is launched detached (`nohup … &`) writing combined output to a
 * remote log and its exit code to a sibling `.exit` file, so progress survives a
 * dropped connection (followed via offset-tail in progress.ts). This is the
 * offload win: the process/thread/file fan-out happens on the host, not the
 * laptop. `agents run` uses it; `agents teams start --watch --device` reuses the
 * same core so a remote team supervisor keeps running after you disconnect.
 */

import { randomUUID } from 'crypto';
import { sshExec, sshStream, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { hostIdentityArgs, sshTargetFor } from './types.js';
import { ensureHostReady } from './ready.js';
import { encodePowershell, powershellQuote, remoteShellFor, posixEnvExports } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { resolveActor, actorEnv } from '../actor.js';
import { saveTask, updateTask, terminalPatch, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';
import { wrapHostCommandWithCredentials, type HostCredentials } from './credentials.js';
import { hostKeyCheckingOpts } from '../devices/known-hosts.js';
import { deriveMirroredCwd, homeRemainder, remoteCdPrefix } from '../project-root.js';
import { RUN_AUTO_KEYWORD, RUN_AUTO_HOST_RESOLVED_ENV, REMOTE_INTERACTIVE_ENV } from '../types.js';

// The home-relative portability helpers live in project-root.js (the canonical
// home-relative conversion home), reused by the interactive `agents ssh` login
// shell builder (devices/connect.ts) as well as this dispatch layer. Re-exported
// here so existing `hosts/dispatch.js` importers and tests keep resolving them.
export { deriveMirroredCwd, homeRemainder, remoteCdPrefix };

/**
 * Diagnostic helper for RUSH-2441: log the requested agent and initial remote
 * `agents run` argv without changing normal command output.
 */
export function logForwardedArgs(
  kind: string,
  agent: string,
  version: string | undefined,
  args: string[],
  hasPrompt: boolean,
): void {
  if (!process.env.AGENTS_DISPATCH_DEBUG) return;
  const safeArgs = [...args];
  if (safeArgs[0] === 'run' && safeArgs[2] && hasPrompt) {
    safeArgs[2] = '<prompt>';
  }
  for (let i = 0; i < safeArgs.length; i++) {
    if (safeArgs[i] === '--env' && safeArgs[i + 1]) {
      const key = safeArgs[i + 1].split('=', 1)[0];
      safeArgs[i + 1] = `${key}=<redacted>`;
      i++;
    } else if (safeArgs[i] === '--') {
      safeArgs.splice(i + 1, safeArgs.length - i - 1, '<passthrough redacted>');
      break;
    }
  }
  process.stderr.write(
    `[dispatch:${kind}] agent=${agent}${version ? `@${version}` : ''} args=${JSON.stringify(safeArgs)}\n`,
  );
}

// Use $HOME (not ~) so the path is correct whether or not it's quoted and
// regardless of the run's cwd. Task ids are 8 hex chars, so these paths are
// injection-safe to interpolate unquoted into remote commands.
const REMOTE_DIR = '$HOME/.agents/.cache/hosts';

/**
 * Merge the resolved actor's provenance env UNDER a caller-supplied env, so every
 * remote `agents …` invocation forwards `AGENTS_ACTOR*` / `GIT_*` across the SSH
 * hop. Without it the remote re-resolves the actor from the ORIGINATING box's
 * `SSH_CONNECTION` (the wrong IP) and mis-credits the run to the shared machine or
 * `UNRESOLVED@<host>` (RUSH-2028). A caller-supplied value wins on any key
 * collision, mirroring `buildExecEnv`'s `...options.env` precedence (exec.ts).
 */
export function withActorEnv(env?: Record<string, string>): Record<string, string> {
  return { ...actorEnv(resolveActor()), ...terminalIdEnv(), ...(env ?? {}) };
}

/**
 * The shell-export prelude prepended to EVERY remote `agents run` dispatch —
 * actor provenance plus, for a `run auto` dispatch, the chain-hop guard
 * (RUN_AUTO_HOST_RESOLVED_ENV): this dispatch already IS the affinity pick, so
 * the remote CLI must not re-run host affinity and hop to a third host. The
 * guard MUST be a shell export (landing in the remote CLI's own process.env,
 * which `runAutoDefaultsToAffinity` reads) — a forwarded `--env` flag would
 * only reach the spawned agent's env and the remote `run auto` would re-pick.
 * Shared by the interactive (runInteractiveOnHost) and detached
 * (launchDetached) paths so both behave identically.
 *
 * `extra` carries the markers that are true of ONE path rather than both — the
 * interactive dispatch adds REMOTE_INTERACTIVE_ENV, which the remote CLI reads
 * to know its stdio is an ssh link (reconnect target, `--no-follow` pane
 * requirement). It goes through this builder rather than being concatenated on
 * at the call site so every remote env marker is exported the same way, in one
 * place.
 */
export function remoteRunShellPrelude(agent: string, extra: Record<string, string> = {}): string {
  const guard: Record<string, string> = agent === RUN_AUTO_KEYWORD ? { [RUN_AUTO_HOST_RESOLVED_ENV]: '1' } : {};
  const exports = posixEnvExports(withActorEnv({ ...guard, ...extra }));
  return exports ? `${exports}; ` : '';
}

/**
 * Forward the launching editor tab's `AGENT_TERMINAL_ID` across the SSH hop.
 *
 * Factory stamps it on every terminal it spawns, and the remote `agents run`
 * records it in its pid registry (`writePidSessionEntry`) — which is what lets a
 * tab ask the device "which session is MY terminal running?" instead of guessing
 * from local state. Without the forward the remote registry has no terminal id,
 * that question is unanswerable, and the tab is stuck with its spawn-time id even
 * after the agent has moved to a different session (a `/clear`, or an exit and
 * rerun in the same tab).
 *
 * Same shape as the actor provenance above: absent when the launch did not come
 * from a tracked terminal, never fabricated.
 */
function terminalIdEnv(): Record<string, string> {
  const terminalId = process.env.AGENT_TERMINAL_ID?.trim();
  return terminalId ? { AGENT_TERMINAL_ID: terminalId } : {};
}

/**
 * Launch a detached login-shell command in its own Unix session/process group.
 *
 * Node is already a hard requirement for a host that can run `agents`. Its
 * `detached: true` contract calls setsid(2) on Unix, unlike `nohup ... &` under
 * a non-interactive shell where the background wrapper can remain in the SSH
 * shell's process group. Returning the group leader PID makes `kill(-pid)` a
 * reliable whole-tree operation for both normal stops and rollback cleanup.
 */
export function buildDetachedLaunchCommand(inner: string): string {
  const nodeScript = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn('/bin/bash', ['-lc', ${JSON.stringify(inner)}], { detached: true, stdio: 'ignore' });`,
    "child.once('error', error => { console.error(error.message); process.exitCode = 1; });",
    "child.once('spawn', () => { console.log(child.pid); child.unref(); });",
  ].join(' ');
  return `bash -lc ${shellQuote(`node -e ${shellQuote(nodeScript)}`)}`;
}

function windowsRemotePath(path: string): string {
  return path.startsWith('$HOME/')
    ? `(Join-Path $HOME ${powershellQuote(path.slice('$HOME/'.length))})`
    : powershellQuote(path);
}

/** Build the detached PowerShell launch protocol used by Windows SSH hosts. */
export function buildWindowsDetachedLaunchCommand(opts: {
  forwardedArgs: string[];
  remoteCwd?: string;
  mirrorCwd?: boolean;
  remoteLog: string;
  remoteExit: string;
  env: Record<string, string>;
}): string {
  const log = windowsRemotePath(opts.remoteLog);
  const exit = windowsRemotePath(opts.remoteExit);
  const env = Object.entries(opts.env).map(([key, value]) => `$env:${key} = ${powershellQuote(value)}`);
  const cwd = opts.remoteCwd
    ? opts.mirrorCwd
      ? `try { Set-Location -LiteralPath ${powershellQuote(opts.remoteCwd)} } catch { Set-Location -LiteralPath $HOME }`
      : `Set-Location -LiteralPath ${powershellQuote(opts.remoteCwd)}`
    : '';
  const inner = [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'`,
    ...env,
    cwd,
    `$log = ${log}`,
    `$exit = ${exit}`,
    `$code = 1`,
    `try { & ${['agents', ...opts.forwardedArgs].map(powershellQuote).join(' ')} *> $log; if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE } } catch { $_ | Out-File -LiteralPath $log -Append; $code = 1 } finally { Set-Content -LiteralPath $exit -Value $code -NoNewline -Encoding ascii }`,
  ].filter(Boolean).join('; ');
  const encodedInner = encodePowershell(inner);
  const outer = [
    `$dir = Join-Path $HOME '.agents/.cache/hosts'`,
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `Remove-Item -LiteralPath ${exit} -Force -ErrorAction SilentlyContinue`,
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellQuote(`powershell.exe -NoProfile -EncodedCommand ${encodedInner}`)} }`,
    `if ($result.ReturnValue -ne 0) { throw \"Win32_Process.Create failed with code $($result.ReturnValue)\" }`,
    `Write-Output $result.ProcessId`,
  ].join('; ');
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(outer)}`;
}

export interface DispatchResult {
  task: HostTask;
  /** Exit code when followed; undefined when detached (--no-follow). */
  exitCode?: number;
}

function terminateRemoteLaunch(task: HostTask): void {
  if (!task.pid) throw new Error(`Cannot terminate remote task ${task.id}: launch returned no PID.`);
  const pid = task.pid;
  const command = task.remoteShell === 'powershell'
    ? `powershell -NoProfile -EncodedCommand ${encodePowershell(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${windowsRemotePath(task.remoteLog)}, ${windowsRemotePath(task.remoteExit)} -Force -ErrorAction SilentlyContinue`)}`
    : `if kill -TERM -- -${pid} 2>/dev/null; then ` +
      `sleep 1; kill -KILL -- -${pid} 2>/dev/null || true; ` +
    `elif kill -0 -- -${pid} 2>/dev/null; then exit 1; fi; ` +
    `rm -f ${task.remoteLog} ${task.remoteExit}`;
  const result = sshExec(task.target, command, { timeoutMs: 10000, multiplex: true, extraSshArgs: task.identityFile ? ['-i', task.identityFile, '-o', 'IdentitiesOnly=yes'] : undefined });
  if (result.code !== 0) {
    throw new Error(
      `Failed to terminate remote task ${task.id} on ${task.host}: ` +
      `${(result.stderr || result.stdout).trim() || 'ssh error'}`,
    );
  }
}

/** Terminate a detached dispatch that its caller could not persist locally. */
export function terminateDispatchedTask(task: HostTask): void {
  terminateRemoteLaunch(task);
  updateTask(task.id, terminalPatch(143));
}

/**
 * Build the remote shell used by {@link stopDispatchedTask}. Exported for
 * unit tests — the keep-log / no-clobber contract lives in this script.
 *
 * Protocol (printed to stdout for the local caller):
 * - `SIGNALED`  — process group was live; SIGTERM/KILL applied; wrote 143
 * - `ALREADY` + code — group gone; adopted existing `.exit` (never overwrite)
 * - `GONE` — group gone and no `.exit`; write 143 as the local stop outcome
 * Exit 1 if the group is still alive after TERM/KILL (can't stop it).
 */
export function buildStopRemoteCommand(pid: number, remoteExit: string): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid remote task pid: ${pid}`);
  }
  // Only force-write 143 when we actually signaled a live group (or nothing
  // left a code). Never `echo 143` over a real completed-run exit code.
  return (
    `if kill -TERM -- -${pid} 2>/dev/null; then ` +
      `sleep 1; kill -KILL -- -${pid} 2>/dev/null || true; ` +
      `echo 143 > ${remoteExit}; echo SIGNALED; ` +
    `elif kill -0 -- -${pid} 2>/dev/null; then ` +
      `exit 1; ` +
    `else ` +
      `code=$(cat ${remoteExit} 2>/dev/null | tr -d '[:space:]'); ` +
      `if [ -n "$code" ]; then echo "ALREADY $code"; ` +
      `else echo 143 > ${remoteExit}; echo GONE; fi; ` +
    `fi`
  );
}

export function buildWindowsStopRemoteCommand(pid: number, remoteExit: string): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid remote task pid: ${pid}`);
  const exit = windowsRemotePath(remoteExit);
  const script =
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `function Get-DescendantProcessIds([int]$ParentId) { $children = Get-CimInstance Win32_Process -Filter \"ParentProcessId = $ParentId\"; foreach ($child in $children) { Get-DescendantProcessIds $child.ProcessId; $child.ProcessId } }; ` +
    `if ($process) { $descendants = @(Get-DescendantProcessIds ${pid}); foreach ($childId in $descendants) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }; Stop-Process -Id ${pid} -Force; Set-Content -LiteralPath ${exit} -Value 143 -NoNewline -Encoding ascii; Write-Output 'SIGNALED' } ` +
    `elseif (Test-Path -LiteralPath ${exit}) { $code = (Get-Content -LiteralPath ${exit} -Raw).Trim(); if ($code) { Write-Output (\"ALREADY $code\") } else { Set-Content -LiteralPath ${exit} -Value 143 -NoNewline -Encoding ascii; Write-Output 'GONE' } } ` +
    `else { Set-Content -LiteralPath ${exit} -Value 143 -NoNewline -Encoding ascii; Write-Output 'GONE' }`;
  return `powershell -NoProfile -EncodedCommand ${encodePowershell(script)}`;
}

/**
 * Stop a running host task from the origin machine (`agents devices stop <id>`).
 *
 * Unlike {@link terminateDispatchedTask} (rollback cleanup after a failed
 * persist), this keeps the remote log so `agents logs <id>` still works,
 * writes a terminal `.exit` marker only when we actually stopped a live group
 * (or no code existed), and never clobbers a real completed-run exit code.
 */
export function stopDispatchedTask(task: HostTask): HostTask {
  if (task.status !== 'running') {
    throw new Error(`Task ${task.id} is already ${task.status}`);
  }
  if (!task.pid) {
    throw new Error(`Cannot stop remote task ${task.id}: launch returned no PID.`);
  }
  const command = task.remoteShell === 'powershell'
    ? buildWindowsStopRemoteCommand(task.pid, task.remoteExit)
    : buildStopRemoteCommand(task.pid, task.remoteExit);
  const result = sshExec(task.target, command, { timeoutMs: 10000, multiplex: true, extraSshArgs: task.identityFile ? ['-i', task.identityFile, '-o', 'IdentitiesOnly=yes'] : undefined });
  if (result.code !== 0) {
    throw new Error(
      `Failed to stop remote task ${task.id} on ${task.host}: ` +
      `${(result.stderr || result.stdout).trim() || 'ssh error'}`,
    );
  }
  const line = result.stdout.trim().split('\n').pop() ?? '';
  let code = 143;
  if (line.startsWith('ALREADY ')) {
    const parsed = parseInt(line.slice('ALREADY '.length), 10);
    if (Number.isFinite(parsed)) code = parsed;
  }
  // SIGNALED / GONE / ALREADY all end with a terminal local record.
  return updateTask(task.id, terminalPatch(code)) ?? { ...task, ...terminalPatch(code) };
}

/** Options shared by every detached dispatch. */
interface LaunchOptions {
  /** `agents …` args (command name first), each already un-quoted (we quote them). */
  forwardedArgs: string[];
  remoteCwd?: string;
  /** `remoteCwd` was derived from the local cwd — mirror it, don't fail on it. */
  mirrorCwd?: boolean;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
  /** Task-record labels for `agents devices ps`. */
  agentLabel: string;
  promptLabel: string;
  /** Session id the run was launched with, persisted on the task record. */
  sessionId?: string;
  /** Durable `--name` handle, persisted on the task record for name resolution. */
  name?: string;
  /** Copy runtime credentials to the host before the run and shred them after. */
  copyCreds?: HostCredentials;
}

/**
 * The launch + task-record + optional follow core. Both `dispatchToHost` (run)
 * and `dispatchAgentsCommand` (teams) build their `forwardedArgs` and call here,
 * so the nohup/exit-file/offset-tail machinery lives in exactly one place.
 *
 * POSIX hosts use a detached bash process group; Windows hosts use a hidden
 * detached PowerShell process and the same durable log/exit-file protocol.
 */
async function launchDetached(host: Host, target: string, opts: LaunchOptions): Promise<DispatchResult> {
  const remoteShell = remoteShellFor(host.os ?? resolveRemoteOsSync(host.name));
  const id = randomUUID().slice(0, 8);
  const remoteLog = `${REMOTE_DIR}/${id}.log`;
  const remoteExit = `${REMOTE_DIR}/${id}.exit`;

  // Inner command run under a login shell so PATH resolves `agents`. Export the
  // resolved actor provenance first so the detached remote run inherits it
  // instead of re-resolving from this box's SSH_CONNECTION (RUSH-2028); a
  // `run auto` dispatch also gets the chain-hop guard (remoteRunShellPrelude).
  const invocation = ['agents', ...opts.forwardedArgs].map(shellQuote).join(' ');
  const cwd = remoteCdPrefix(opts.remoteCwd, { mirror: opts.mirrorCwd });
  const prelude = remoteRunShellPrelude(opts.agentLabel);
  let inner = `${prelude}${cwd}${invocation} > ${remoteLog} 2>&1; echo $? > ${remoteExit}`;
  if (opts.copyCreds) {
    inner = wrapHostCommandWithCredentials(inner, opts.copyCreds);
  }

  // When credentials ride this launch, verify the host key strictly against the
  // managed pin (the gate in exec.ts already required the host to be pinned) and
  // force a fresh connection — reusing a control socket opened by an earlier
  // accept-new connection would bypass the strict check (RUSH-1767).
  const credHostKeyOpts = opts.copyCreds ? hostKeyCheckingOpts(true) : undefined;

  // Outer: ensure dir, launch the login-shell wrapper as a new process-group
  // leader, and print that leader PID.
  const launch = remoteShell === 'powershell'
    ? buildWindowsDetachedLaunchCommand({
        forwardedArgs: opts.forwardedArgs,
        remoteCwd: opts.remoteCwd,
        mirrorCwd: opts.mirrorCwd,
        remoteLog,
        remoteExit,
        env: withActorEnv(opts.agentLabel === RUN_AUTO_KEYWORD ? { [RUN_AUTO_HOST_RESOLVED_ENV]: '1' } : {}),
      })
    : `mkdir -p ${REMOTE_DIR}; ${buildDetachedLaunchCommand(inner)}`;
  const res = sshExec(target, launch, {
    timeoutMs: 30000,
    multiplex: !opts.copyCreds,
    hostKeyOpts: credHostKeyOpts,
    extraSshArgs: hostIdentityArgs(host),
  });
  if (res.code !== 0) {
    throw new Error(`Failed to launch on "${host.name}": ${(res.stderr || res.stdout).trim() || 'ssh error'}`);
  }
  const pid = parseInt(res.stdout.trim().split('\n').pop() ?? '', 10);

  const task: HostTask = {
    id,
    host: host.name,
    target,
    identityFile: host.identityFile,
    remoteShell,
    agent: opts.agentLabel,
    prompt: opts.promptLabel,
    pid: Number.isFinite(pid) ? pid : undefined,
    sessionId: opts.sessionId,
    name: opts.name,
    remoteLog,
    remoteExit,
    status: 'running',
    createdAt: new Date().toISOString(),
  };
  try {
    saveTask(task);
  } catch (err) {
    try {
      terminateRemoteLaunch(task);
    } catch (cleanupErr) {
      throw new Error(
        `Failed to persist remote task ${task.id}; cleanup also failed: ${(cleanupErr as Error).message}`,
        { cause: err },
      );
    }
    throw err;
  }

  if (opts.follow === false) {
    return { task };
  }

  const exitCode = await followHostTask(target, {
    remoteLog,
    remoteExit,
    taskId: id,
    echo: true,
    timeoutMs: opts.timeoutMs,
    extraSshArgs: hostIdentityArgs(host),
    remoteShell,
  });
  // -1 = the follow window closed while the run continues on the host. Leave the
  // record 'running' (do NOT freeze it terminal) so a later `agents devices ps` / `agents logs`
  // reconcile against the remote `.exit` resolves the true final status.
  const finished = exitCode === -1 ? task : (updateTask(id, terminalPatch(exitCode)) ?? task);
  return { task: finished, exitCode };
}

export interface DispatchOptions {
  agent: string;
  prompt: string;
  /** Explicit agent version pin (e.g. "2.1.207") to forward as `agent@version`. */
  version?: string;
  /** Run strategy (e.g. "balanced") — the remote picks among ITS signed-in accounts. */
  strategy?: string;
  /** Named provider account — the remote resolves it against ITS signed-in versions. */
  account?: string;
  balanced?: boolean;
  fallback?: string;
  mode?: string;
  model?: string;
  /** Reasoning effort — forwarded unless 'auto' (the remote default). */
  effort?: string;
  /** `--env k=v` pairs, forwarded verbatim (the remote CLI parses them). */
  env?: string[];
  /** `--add-dir` grants, already made remote-portable. */
  addDir?: string[];
  /** Agent wall-clock cap, forwarded as `--timeout <duration>` for the REMOTE to enforce. */
  timeout?: string;
  /** Loop family — the loop driver runs on the host. */
  loop?: boolean;
  maxIterations?: string;
  budget?: string;
  until?: string;
  interval?: string;
  /** Remote emits ndjson into its log; the local follow streams it verbatim. */
  json?: boolean;
  verbose?: boolean;
  /** Skip the budget-confirm prompt — a detached remote run can't answer one. */
  yes?: boolean;
  /** Route through the Agent Client Protocol. */
  acp?: boolean;
  /** False forwards --no-auto-secrets (workflow secrets resolve on the REMOTE keychain). */
  autoSecrets?: boolean;
  /** Native-CLI passthrough (everything after `--`), appended last. */
  passthroughArgs?: string[];
  remoteCwd?: string;
  /** `remoteCwd` was derived from the local cwd — mirror it, don't fail on it. */
  mirrorCwd?: boolean;
  /**
   * Force the remote run's NEW session to use this exact id (Claude only, via
   * `agents run --session-id`). Captured on the task record so the run is
   * resumable by id. Mutually exclusive with `resume`.
   */
  sessionId?: string;
  /**
   * Durable `--name <slug>` handle, forwarded to the remote `agents run` and
   * recorded on the local task so `agents logs <name>` / `agents devices ps` resolve it.
   */
  name?: string;
  /** Resume an existing session on the host by id (via `agents run --resume`). */
  resume?: string;
  /**
   * Forward `--emit-session-id` so the remote run prints its resolved session id
   * as a stdout sentinel (hosts/session-marker.ts). The launcher parses that id
   * out of the followed log and stamps it on the task — the join that maps a
   * remote-created session back home for agents that don't take `--session-id`.
   */
  emitSessionId?: boolean;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
  /** Copy runtime credentials to the host before the run and shred them after. */
  copyCreds?: HostCredentials;
}

/**
 * Build the remote `agents run …` argv for a host dispatch. Pure so the
 * session-id / resume flag wiring is unit-testable without an SSH round-trip.
 * `--session-id` and `--resume` are mutually exclusive (the CLI rejects both);
 * resume wins when — defensively — both are set.
 *
 * Every field here is classified 'forward' in RUN_OPTION_FORWARDING
 * (remote-cmd.ts) — keep the two in lockstep; run-forwarding.test.ts asserts
 * the table side.
 */
/** Compose `agent[@version][#account]` so the peer resolves ITS slot (PHNX-3940 T5). */
export function runAgentSpecArg(opts: {
  agent: string;
  version?: string;
  account?: string;
  accountPicker?: boolean;
}): string {
  if (opts.accountPicker) return `${opts.agent}@`;
  let spec = opts.agent;
  if (opts.version) spec += `@${opts.version}`;
  if (opts.account) spec += `#${opts.account}`;
  return spec;
}

export function buildRunForwardedArgs(opts: DispatchOptions): string[] {
  const agentArg = runAgentSpecArg(opts);
  const args = ['run', agentArg, opts.prompt, '--quiet'];
  if (opts.mode) args.push('--mode', opts.mode);
  if (opts.model) args.push('--model', opts.model);
  // 'auto' is the remote default — forwarding it would only add noise.
  if (opts.effort && opts.effort !== 'auto') args.push('--effort', opts.effort);
  for (const kv of opts.env ?? []) args.push('--env', kv);
  for (const dir of opts.addDir ?? []) args.push('--add-dir', dir);
  if (opts.timeout) args.push('--timeout', opts.timeout);
  if (opts.strategy) args.push('--strategy', opts.strategy);
  if (opts.account) args.push('--account', opts.account);
  if (opts.balanced) args.push('--balanced');
  if (opts.fallback) args.push('--fallback', opts.fallback);
  if (opts.loop) args.push('--loop');
  if (opts.maxIterations) args.push('--max-iterations', opts.maxIterations);
  if (opts.budget) args.push('--budget', opts.budget);
  if (opts.until) args.push('--until', opts.until);
  if (opts.interval) args.push('--interval', opts.interval);
  if (opts.json) args.push('--json');
  if (opts.verbose) args.push('--verbose');
  if (opts.yes) args.push('--yes');
  if (opts.acp) args.push('--acp');
  if (opts.autoSecrets === false) args.push('--no-auto-secrets');
  if (opts.name) args.push('--name', opts.name);
  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.emitSessionId) args.push('--emit-session-id');
  if (opts.passthroughArgs && opts.passthroughArgs.length > 0) args.push('--', ...opts.passthroughArgs);
  logForwardedArgs('headless', opts.agent, opts.version, args, true);
  return args;
}

export interface InteractiveDispatchOptions {
  agent: string;
  /** Explicit agent version pin (e.g. "2.1.207") to forward as `agent@version`. */
  version?: string;
  /** Preserve the trailing-@ account picker so selection happens on the execution host. */
  accountPicker?: boolean;
  /** Explicit run strategy (e.g. "balanced") to forward as `--strategy <strategy>`. */
  strategy?: string;
  /** Named provider account to resolve on the remote host. */
  account?: string;
  /** Optional prompt — forwarded only when the caller explicitly forced interactive mode. */
  prompt?: string;
  mode?: string;
  model?: string;
  /** Reasoning effort to forward as `--effort <effort>`. */
  effort?: string;
  /** Additional directories to grant, already made remote-portable. */
  addDir?: string[];
  /** Stream events as JSON lines. */
  json?: boolean;
  /** Show detailed execution logs. */
  verbose?: boolean;
  /** Kill the agent after this duration, forwarded as `--timeout <duration>`. */
  timeout?: string;
  /** Skip the interactive budget-confirm prompt. */
  yes?: boolean;
  /** Route through the Agent Client Protocol. */
  acp?: boolean;
  remoteCwd?: string;
  /** `remoteCwd` was derived from the local cwd — mirror it, don't fail on it. */
  mirrorCwd?: boolean;
  sessionId?: string;
  name?: string;
  resume?: string;
  passthroughArgs?: string[];
  raw?: boolean;
  /** Forward `--interactive` to the remote so a prompt-bearing run still starts the TUI. */
  forceInteractive?: boolean;
  /** `--env k=v` pairs, forwarded verbatim (the remote CLI parses them). */
  env?: string[];
  balanced?: boolean;
  fallback?: string;
  /** Copy runtime credentials to the host before the run and shred them after. */
  copyCreds?: HostCredentials;
}

/**
 * Build the remote `agents run …` argv for an INTERACTIVE host dispatch. The
 * remote agent sees a TTY, so we omit `--quiet`; the remote CLI will launch its
 * normal interactive TUI / tmux wrapper. A prompt is only included when the
 * caller explicitly forced interactive mode (otherwise the remote CLI would
 * infer headless from the prompt).
 */
export function buildInteractiveRunForwardedArgs(opts: InteractiveDispatchOptions): string[] {
  if (opts.version && opts.accountPicker) {
    throw new Error('Interactive host dispatch cannot combine an account picker with a version pin');
  }
  const agentArg = runAgentSpecArg(opts);
  const args = ['run', agentArg];
  if (opts.prompt && opts.forceInteractive) args.push(opts.prompt);
  if (opts.forceInteractive) args.push('--interactive');
  if (opts.mode) args.push('--mode', opts.mode);
  if (opts.model) args.push('--model', opts.model);
  // 'auto' is the remote default — forwarding it would only add noise.
  if (opts.effort && opts.effort !== 'auto') args.push('--effort', opts.effort);
  for (const kv of opts.env ?? []) args.push('--env', kv);
  for (const dir of opts.addDir ?? []) args.push('--add-dir', dir);
  if (opts.timeout) args.push('--timeout', opts.timeout);
  if (opts.strategy) args.push('--strategy', opts.strategy);
  if (opts.account) args.push('--account', opts.account);
  if (opts.balanced) args.push('--balanced');
  if (opts.fallback) args.push('--fallback', opts.fallback);
  if (opts.json) args.push('--json');
  if (opts.verbose) args.push('--verbose');
  if (opts.yes) args.push('--yes');
  if (opts.acp) args.push('--acp');
  if (opts.name) args.push('--name', opts.name);
  if (opts.resume) args.push('--resume', opts.resume);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.raw) args.push('--raw');
  if (opts.passthroughArgs && opts.passthroughArgs.length > 0) {
    args.push('--', ...opts.passthroughArgs);
  }
  logForwardedArgs('interactive', opts.agent, opts.version, args, Boolean(opts.prompt && opts.forceInteractive));
  return args;
}

/**
 * Run an agent interactively on a host, forwarding the local TTY over SSH.
 * Returns the SSH exit code. The remote `agents` CLI is responsible for its own
 * tmux wrapping; the local machine is just the transport.
 */
export async function runInteractiveOnHost(host: Host, opts: InteractiveDispatchOptions): Promise<number> {
  const target = sshTargetFor(host);
  // Concrete version pins fail loud here (RUSH-2313) so we never open a TTY
  // to a box that cannot run the pin.
  const { warnings } = ensureHostReady(host, { agent: opts.agent, version: opts.version, account: opts.account });
  for (const w of warnings) process.stderr.write(`[hosts] warning: ${w}\n`);

  const invocation = ['agents', ...buildInteractiveRunForwardedArgs(opts)].map(shellQuote).join(' ');
  const cwd = remoteCdPrefix(opts.remoteCwd, { mirror: opts.mirrorCwd });
  // Forward actor provenance so the interactive remote run inherits it rather
  // than re-resolving from this box's SSH_CONNECTION (RUSH-2028); a `run auto`
  // dispatch also gets the chain-hop guard (remoteRunShellPrelude).
  //
  // REMOTE_INTERACTIVE_ENV rides the same prelude and tells the remote CLI its
  // stdio is this ssh link: it marks the run as reconnect-managed (a drop is
  // answered by reconnect.ts, which rejoins the live pane or resumes the
  // session in place) and, when the launcher has no TTY (CI, scripts), requires
  // the detached pane that is the run's only interface. Since PHNX-3316 it no
  // longer forces the tmux wrap on a TTY-followed run — the peer's
  // tmux.enabled decides that. Set here, on the interactive path only:
  // `launchDetached` already setsids the headless one.
  const prelude = remoteRunShellPrelude(opts.agent, { [REMOTE_INTERACTIVE_ENV]: '1' });
  let remoteCmd = `${prelude}${cwd}${invocation}`;
  if (opts.copyCreds) {
    remoteCmd = wrapHostCommandWithCredentials(remoteCmd, opts.copyCreds);
  }
  // Credentials ride this stream when --copy-creds is set: verify the host key
  // strictly against the managed pin and force a fresh connection so a stale
  // accept-new control socket can't bypass the check (RUSH-1767).
  const credHostKeyOpts = opts.copyCreds ? hostKeyCheckingOpts(true) : undefined;
  return sshStream(target, remoteCmd, {
    tty: process.stdin.isTTY,
    // NOT multiplexed. `ControlPath=cm-%C` hashes only local host / remote host
    // / port / user, so every agent tab pointed at a peer shares ONE master —
    // and OpenSSH closes every channel on it the instant that master dies. One
    // blink therefore ejected all six tabs on a box at once, which is what made
    // a brief outage read as "all my agents exited" (RUSH-3125). The handshake
    // this gives up is a one-time ~200ms on a session that runs for hours;
    // probes and fan-outs keep the shared master, where it actually pays.
    multiplex: false,
    hostKeyOpts: credHostKeyOpts,
    extraSshArgs: hostIdentityArgs(host),
  });
}

/** Dispatch an `agents run <agent> "<prompt>"` onto a host (the `run --device` path). */
export async function dispatchToHost(host: Host, opts: DispatchOptions): Promise<DispatchResult> {
  const target = sshTargetFor(host);
  // Concrete agent@version pins fail loud before we print "Dispatched" and
  // leave a dead remote log (RUSH-2313). Aliases stay remote-resolved.
  const { warnings } = ensureHostReady(host, { agent: opts.agent, version: opts.version, account: opts.account });
  for (const w of warnings) process.stderr.write(`[hosts] warning: ${w}\n`);

  return launchDetached(host, target, {
    forwardedArgs: buildRunForwardedArgs(opts),
    remoteCwd: opts.remoteCwd,
    mirrorCwd: opts.mirrorCwd,
    follow: opts.follow,
    timeoutMs: opts.timeoutMs,
    agentLabel: opts.agent,
    promptLabel: opts.prompt,
    name: opts.name,
    // On resume the remote session keeps its existing id; record that id so the
    // task stays mapped to the same session.
    sessionId: opts.resume ?? opts.sessionId,
    copyCreds: opts.copyCreds,
  });
}

export interface CommandDispatchOptions {
  /** `agents …` args (command name first), already stripped of routing flags. */
  forwardedArgs: string[];
  remoteCwd?: string;
  follow?: boolean;
  timeoutMs?: number;
}

/**
 * Dispatch an arbitrary long-running `agents <command>` onto a host detached —
 * used for `teams start --watch --device`, whose supervisor must outlive the SSH
 * connection. Reachability is assumed (the caller has already resolved the host);
 * a launch failure surfaces the remote stderr.
 */
export async function dispatchAgentsCommand(host: Host, opts: CommandDispatchOptions): Promise<DispatchResult> {
  const target = sshTargetFor(host);
  return launchDetached(host, target, {
    forwardedArgs: opts.forwardedArgs,
    remoteCwd: opts.remoteCwd,
    follow: opts.follow,
    timeoutMs: opts.timeoutMs,
    agentLabel: opts.forwardedArgs[0] ?? 'agents',
    promptLabel: opts.forwardedArgs.join(' '),
  });
}
