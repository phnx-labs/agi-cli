import { launchIdentityEnv } from '../launch-identity.js';
/** Dispatch a headless `agents …` command onto a host over SSH, detached (`nohup … &`) with
 * output and exit code in remote files so progress survives a dropped connection. `agents run`
 * and `teams start --watch --device` share it. */

import { randomUUID } from 'crypto';
import { sshExec, sshStream, shellQuote } from '../ssh-exec.js';
import type { Host } from './types.js';
import { hostIdentityArgs, sshTargetFor } from './types.js';
import { ensureHostReady } from './ready.js';
import { buildWindowsAgentsCommand, encodePowershell, powershellQuote, remoteShellFor, posixEnvExports, windowsRemotePath, windowsSetLocation } from './remote-cmd.js';
import { resolveRemoteOsSync } from './remote-os.js';
import { resolveActor, actorEnv } from '../actor.js';
import { saveTask, updateTask, terminalPatch, type HostTask } from './tasks.js';
import { followHostTask } from './progress.js';
import { wrapHostCommandWithCredentials, type HostCredentials } from './credentials.js';
import { hostKeyCheckingOpts } from '../devices/known-hosts.js';
import { deriveMirroredCwd, homeRemainder, remoteCdPrefix } from '../project-root.js';
import { RUN_AUTO_KEYWORD, RUN_AUTO_HOST_RESOLVED_ENV, REMOTE_INTERACTIVE_ENV } from '../types.js';

// Re-exported so existing `hosts/dispatch.js` importers and tests keep resolving the home-relative
// helpers from project-root.js.
export { deriveMirroredCwd, homeRemainder, remoteCdPrefix };

/** Diagnostic helper for RUSH-2441: logs the requested agent and initial remote `agents run`
 * argv. */
function logForwardedArgs(
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

/** Merge the actor's provenance env under a caller-supplied env so `AGENTS_ACTOR*` / `GIT_*`
 * cross the SSH hop; without it the remote mis-credits the run from the wrong SSH_CONNECTION
 * (RUSH-2028). Caller values win. */
export function withActorEnv(env?: Record<string, string>): Record<string, string> {
  return { ...actorEnv(resolveActor()), ...launchIdentityEnv(), ...(env ?? {}) };
}

/** Shell-export prelude prepended to every remote `agents run`: actor provenance plus, for `run
 * auto`, the chain-hop guard. It must be a shell export so it lands in the remote CLI's
 * process.env; `extra` carries path-specific markers like REMOTE_INTERACTIVE_ENV. */
export function remoteRunShellPrelude(agent: string, extra: Record<string, string> = {}): string {
  const exports = posixEnvExports(remoteRunEnv(agent, extra));
  return exports ? `${exports}; ` : '';
}

/** The env every remote `agents run` carries across the SSH hop; rendered as POSIX exports, or
 * as `$env:` assignments for a Windows peer. */
export function remoteRunEnv(agent: string, extra: Record<string, string> = {}): Record<string, string> {
  const guard: Record<string, string> = agent === RUN_AUTO_KEYWORD ? { [RUN_AUTO_HOST_RESOLVED_ENV]: '1' } : {};
  return withActorEnv({ ...guard, ...extra });
}

/** Launch a detached login-shell command in its own Unix session via Node's `detached: true`
 * (setsid), unlike `nohup … &`, so the group leader PID makes `kill(-pid)` reliably stop the
 * whole tree. */
export function buildDetachedLaunchCommand(inner: string): string {
  const nodeScript = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn('/bin/bash', ['-lc', ${JSON.stringify(inner)}], { detached: true, stdio: 'ignore' });`,
    "child.once('error', error => { console.error(error.message); process.exitCode = 1; });",
    "child.once('spawn', () => { console.log(child.pid); child.unref(); });",
  ].join(' ');
  return `bash -lc ${shellQuote(`node -e ${shellQuote(nodeScript)}`)}`;
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
  const cwd = opts.remoteCwd ? windowsSetLocation(opts.remoteCwd, opts.mirrorCwd) : '';
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

/** Build the remote shell for stopDispatchedTask; the keep-log / no-clobber contract lives here.
 * It prints SIGNALED (applied TERM/KILL, wrote 143), ALREADY + code (adopted existing `.exit`)
 * or GONE (wrote 143), and exits 1 if the group survives. */
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

/** Stop a running host task from the origin (`agents devices stop <id>`): keeps the remote log,
 * writes a terminal `.exit` only if a live group was stopped or none existed, and never
 * clobbers a real exit code. */
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

/** The launch, task-record and optional follow core shared by `dispatchToHost` and
 * `dispatchAgentsCommand`. POSIX hosts use a detached bash group; Windows hosts a hidden
 * detached PowerShell with the same log/exit-file protocol. */
async function launchDetached(host: Host, target: string, opts: LaunchOptions): Promise<DispatchResult> {
  const remoteShell = remoteShellFor(host.os ?? resolveRemoteOsSync(host.name));
  const id = randomUUID().slice(0, 8);
  const remoteLog = `${REMOTE_DIR}/${id}.log`;
  const remoteExit = `${REMOTE_DIR}/${id}.exit`;

  // Run under a login shell so PATH resolves `agents`; export actor provenance first so the remote
  // inherits it (RUSH-2028).
  const invocation = ['agents', ...opts.forwardedArgs].map(shellQuote).join(' ');
  const cwd = remoteCdPrefix(opts.remoteCwd, { mirror: opts.mirrorCwd });
  const prelude = remoteRunShellPrelude(opts.agentLabel);
  let inner = `${prelude}${cwd}${invocation} > ${remoteLog} 2>&1; echo $? > ${remoteExit}`;
  if (opts.copyCreds) {
    inner = wrapHostCommandWithCredentials(inner, opts.copyCreds);
  }

  // With credentials on this launch, verify the host key strictly against the managed pin and force
  // a fresh connection; reusing an accept-new control socket would bypass the check (RUSH-1767).
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
        env: remoteRunEnv(opts.agentLabel),
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
  /** Force the remote run's new session to use this id (Claude only, via `--session-id`) so it
   * is resumable; exclusive with `resume`. */
  sessionId?: string;
  /** Durable `--name <slug>` handle, forwarded to the remote run and recorded locally for
   * `agents logs <name>` and `devices ps`. */
  name?: string;
  /** Resume an existing session on the host by id (via `agents run --resume`). */
  resume?: string;
  /** Forward `--emit-session-id` so the remote prints its session id as a stdout sentinel the
   * launcher stamps on the task, mapping a remote-created session home for agents without
   * `--session-id`. */
  emitSessionId?: boolean;
  /** Stream progress and block until completion (default true). */
  follow?: boolean;
  timeoutMs?: number;
  /** Copy runtime credentials to the host before the run and shred them after. */
  copyCreds?: HostCredentials;
}

/** Build the remote `agents run …` argv for a host dispatch; pure, so flag wiring is testable
 * without SSH. Every field is 'forward' in RUN_OPTION_FORWARDING (remote-cmd.ts); keep in
 * lockstep. `--session-id` and `--resume` are exclusive. */
/** Compose `agent[@version][#account]` so the peer resolves ITS slot (PHNX-3940 T5). */
function runAgentSpecArg(opts: {
  agent: string;
  version?: string;
  account?: string;
  accountPicker?: boolean;
}): string {
  if (opts.accountPicker) return `${opts.agent}#`;
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
  /** Preserve the trailing-# account picker so selection happens on the execution host. */
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

/** Build the remote `agents run …` argv for an interactive dispatch: no `--quiet`, and a prompt
 * only when interactive mode is forced. */
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

/** The remote command of an interactive dispatch, by peer shell. A Windows peer's PowerShell
 * cannot parse the POSIX `||` form, so it gets the rendered PowerShell (env, cwd and argv in
 * one `-EncodedCommand`), like buildWindowsDetachedLaunchCommand. */
export function buildInteractiveRemoteCommand(remoteShell: ReturnType<typeof remoteShellFor>, opts: InteractiveDispatchOptions): string {
  const forwardedArgs = buildInteractiveRunForwardedArgs(opts);
  // Forward actor provenance (RUSH-2028) and REMOTE_INTERACTIVE_ENV, which tells the remote CLI
  // its stdio is this ssh link so it is reconnect-managed and requires the detached pane when
  // there is no TTY. Interactive path only.
  const env = { [REMOTE_INTERACTIVE_ENV]: '1' };
  if (remoteShell === 'powershell') {
    if (opts.copyCreds) throw new Error('--copy-creds cannot ride an interactive dispatch to a Windows host');
    return buildWindowsAgentsCommand({
      args: forwardedArgs,
      env: remoteRunEnv(opts.agent, env),
      cwd: opts.remoteCwd,
      mirrorCwd: opts.mirrorCwd,
    });
  }
  const invocation = ['agents', ...forwardedArgs].map(shellQuote).join(' ');
  const cwd = remoteCdPrefix(opts.remoteCwd, { mirror: opts.mirrorCwd });
  const remoteCmd = `${remoteRunShellPrelude(opts.agent, env)}${cwd}${invocation}`;
  return opts.copyCreds ? wrapHostCommandWithCredentials(remoteCmd, opts.copyCreds) : remoteCmd;
}

/** Run an agent interactively on a host, forwarding the local TTY over SSH, and return the ssh
 * exit code. The remote `agents` CLI owns its tmux wrapping; this machine is only the
 * transport. */
export async function runInteractiveOnHost(host: Host, opts: InteractiveDispatchOptions): Promise<number> {
  const target = sshTargetFor(host);
  // Concrete version pins fail loud here (RUSH-2313) so we never open a TTY
  // to a box that cannot run the pin.
  const { warnings } = ensureHostReady(host, { agent: opts.agent, version: opts.version });
  for (const w of warnings) process.stderr.write(`[hosts] warning: ${w}\n`);

  const remoteCmd = buildInteractiveRemoteCommand(remoteShellFor(host.os ?? resolveRemoteOsSync(host.name)), opts);
  // Credentials ride this stream when --copy-creds is set: verify the host key
  // strictly against the managed pin and force a fresh connection so a stale
  // accept-new control socket can't bypass the check (RUSH-1767).
  const credHostKeyOpts = opts.copyCreds ? hostKeyCheckingOpts(true) : undefined;
  return sshStream(target, remoteCmd, {
    tty: process.stdin.isTTY,
    // Not multiplexed: `ControlPath=cm-%C` shares ONE master per peer, and OpenSSH closes every
    // channel when it dies, so one blink ejected all tabs on a box (RUSH-3125). The one-time ~200ms
    // handshake is cheap for hours-long sessions.
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
  const { warnings } = ensureHostReady(host, { agent: opts.agent, version: opts.version });
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

interface CommandDispatchOptions {
  /** `agents …` args (command name first), already stripped of routing flags. */
  forwardedArgs: string[];
  remoteCwd?: string;
  follow?: boolean;
  timeoutMs?: number;
}

/** Dispatch a long-running `agents <command>` onto a host, detached, for `teams start --watch
 * --device` whose supervisor must outlive the SSH connection. The host is already resolved; a
 * launch failure surfaces remote stderr. */
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
