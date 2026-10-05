import * as fs from 'fs';
import * as path from 'path';
import { assertValidSshTarget, shellQuote } from '../ssh-exec.js';
import { resolveActor, actorEnv } from '../actor.js';
import { getCliLaunch } from '../cli-entry.js';
import { encodePwshBase64, pwshLiteral, pwshNativeExecStatements } from '../pwsh.js';
import { quoteWin32ExecArg } from '../platform/exec.js';
import { homeRemainder, remoteCdPrefix } from '../project-root.js';
import { getCacheDir } from '../state.js';
import { hostKeyCheckingOpts } from './known-hosts.js';
import { hostNameFor } from './ssh-config.js';
import { resolveDeviceProfile } from './resolve-profile.js';
import { type DeviceProfile } from './registry.js';
import { renderPowershellCommand, windowsAgentsInvocation } from '../hosts/remote-cmd.js';

export const ASKPASS_BUNDLE_ENV = 'AGENTS_SSH_BUNDLE';
export const ASKPASS_KEY_ENV = 'AGENTS_SSH_KEY';
/**
 * Env var that forces the askpass bundle resolve to be broker-only (`agentOnly`)
 * regardless of TTY. A read-only stats probe (`agents devices` load/mem columns)
 * sets this so an uncached password-auth device resolves from the already-unlocked
 * secrets broker or degrades to an unreachable row — never a foreground Touch ID
 * sheet. See {@link buildSshInvocation}'s `agentOnly` option and `runAskpass`. (RUSH-1970)
 */
export const ASKPASS_AGENT_ONLY_ENV = 'AGENTS_SSH_AGENT_ONLY';

export function sshTargetFor(device: DeviceProfile): string {
  // A registered address is authoritative over any stale same-name SSH config alias.
  const resolved = resolveDeviceProfile(device);
  const host = hostNameFor(resolved);
  if (!host) {
    throw new Error(`Device '${resolved.name}' has no address (dnsName/ip). Run \`agents devices sync\` or \`agents devices add\`.`);
  }
  const target = resolved.user ? `${resolved.user}@${host}` : host;
  assertValidSshTarget(target);
  return target;
}

export function fleetDialTarget(device: DeviceProfile): string {
  try {
    return sshTargetFor(device);
  } catch {
    const resolved = resolveDeviceProfile(device);
    return resolved.user ? `${resolved.user}@${resolved.name}` : resolved.name;
  }
}

export function wrapRemoteCommand(
  device: DeviceProfile,
  cmd: string[],
  opts: { argv?: boolean; prelude?: string[] } = {},
): string | undefined {
  // Raw mode preserves caller shell syntax; argv mode preserves token boundaries.
  if (cmd.length === 0) return undefined;
  const prelude = opts.prelude ?? [];
  let script: string;
  if (opts.argv) {
    if (device.shell === 'powershell') {
      script = pwshExactArgvScript(cmd, prelude);
    } else {
      script = [...prelude, ...cmd.map(shellQuote)].join(' ');
    }
  } else {
    script = [...prelude, ...cmd].join(' ');
  }
  if (device.shell === 'powershell') {
    return renderPowershellCommand(script);
  }
  return script;
}

export function pwshQuote(token: string): string {
  return `'${token.replace(/'/g, "''")}'`;
}

function pwshExactArgvScript(cmd: string[], prelude: string[]): string {
  const bin = cmd[0];
  // Bypass npm's PowerShell shim: its second native hop loses exact argv boundaries.
  if (bin === 'agents' || bin === 'ag') {
    return [...prelude, windowsAgentsInvocation(cmd.slice(1), bin), 'exit $zq'].join('\n');
  }
  const program = pwshQuote(cmd[0]!);
  const rest = cmd.slice(1);
  const splat = rest.length > 0 ? `@(${rest.map(pwshQuote).join(', ')})` : '@()';
  // Native applications need the Win32 emitter; cmdlets and scripts receive a splatted PowerShell array.
  return [
    ...prelude,
    `$ErrorActionPreference='Stop'`,
    `$__c = Get-Command -Name ${program} -ErrorAction Stop`,
    `if ($__c.CommandType -eq 'Application') {`,
    ...pwshNativeExecStatements('$__c.Source', pwshLiteral(rest.map(quoteWin32ExecArg).join(' '))).map((line) => `  ${line}`),
    `  exit $zp.ExitCode`,
    `}`,
    `$__a = ${splat}`,
    `& $__c @__a`,
    `if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
  ].join('\n');
}

export function isAgentsBrowserDrive(cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  const tokens = cmd.length === 1 && /\s/.test(cmd[0]!) ? cmd[0]!.trim().split(/\s+/) : cmd;
  const bin = tokens[0];
  if (bin === 'browser') return true;
  return (bin === 'agents' || bin === 'ag') && tokens[1] === 'browser';
}

export function fleetRemotePrelude(
  device: Pick<DeviceProfile, 'shell'>,
  provenanceEnv: Record<string, string> = actorEnv(resolveActor()),
): string[] {
  // These entries are already shell syntax and must be composed separately from argv quoting.
  if (device.shell === 'powershell') {
    return [
      `$env:AGENTS_FLEET_REMOTE='1';`,
      ...Object.entries(provenanceEnv).map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}';`),
    ];
  }
  return [
    'env',
    'AGENTS_FLEET_REMOTE=1',
    ...Object.entries(provenanceEnv).map(([k, v]) => shellQuote(`${k}=${v}`)),
  ];
}

function alreadyMarked(cmd: string[], device: Pick<DeviceProfile, 'shell'>): boolean {
  if (device.shell === 'powershell') return cmd[0] === `$env:AGENTS_FLEET_REMOTE='1';`;
  return cmd[0] === 'env' && cmd[1] === 'AGENTS_FLEET_REMOTE=1';
}

export function markFleetRemote(
  cmd: string[],
  device: Pick<DeviceProfile, 'shell'>,
  provenanceEnv: Record<string, string> = actorEnv(resolveActor()),
): string[] {
  if (alreadyMarked(cmd, device)) return cmd;
  return [...fleetRemotePrelude(device, provenanceEnv), ...cmd];
}

export function buildInteractiveShellCommand(
  device: DeviceProfile,
  mirrorCwd: string | undefined,
): string | undefined {
  if (!mirrorCwd) return undefined;
  const rest = homeRemainder(mirrorCwd);
  if (rest === null || rest === '') return undefined;

  if (device.shell === 'powershell') {
    const literal = rest.replace(/'/g, "''");
    const script =
      `$d = Join-Path -Path $HOME -ChildPath '${literal}'; ` +
      `if (Test-Path -LiteralPath $d) { Set-Location -LiteralPath $d }`;
    return `powershell -NoLogo -NoExit -EncodedCommand ${encodePwshBase64(script)}`;
  }

  return `${remoteCdPrefix(mirrorCwd, { mirror: true })}exec "$SHELL" -l`;
}

interface SshHostKeyOptions {
  pinned?: boolean;
  knownHostsFile?: string;
}

export function deviceIdentityArgs(device: DeviceProfile): string[] {
  const resolved = resolveDeviceProfile(device);
  return resolved.auth?.method === 'key' && resolved.auth.identityFile
    ? ['-i', resolved.auth.identityFile, '-o', 'IdentitiesOnly=yes']
    : [];
}

export function buildSshInvocation(
  device: DeviceProfile,
  cmd: string[],
  askpassShimPath: string,
  hostKey: SshHostKeyOptions = {},
  opts: { agentOnly?: boolean; interactiveCwd?: string; argv?: boolean } = {},
): { args: string[]; env: Record<string, string> } {
  device = resolveDeviceProfile(device);
  const target = sshTargetFor(device);
  const interactive = cmd.length === 0;
  const needsProvenance = !interactive && isAgentsBrowserDrive(cmd) && !alreadyMarked(cmd, device);
  const prelude = needsProvenance ? fleetRemotePrelude(device) : [];
  const remote = interactive
    ? buildInteractiveShellCommand(device, opts.interactiveCwd)
    : wrapRemoteCommand(device, cmd, { ...(opts.argv ? { argv: true } : {}), ...(prelude.length > 0 ? { prelude } : {}) });
  const env: Record<string, string> = {};
  const args: string[] = [
    ...hostKeyCheckingOpts(hostKey.pinned ?? false, hostKey.knownHostsFile),
    '-o', 'ConnectTimeout=10',
  ];

  if (device.auth.method === 'password') {
    // Passwords stay in forced askpass environment state and never enter process arguments.
    if (!device.auth.bundle) {
      throw new Error(`Device '${device.name}' uses password auth but has no secrets bundle. Set one with \`agents devices config ${device.name} ssh.bundle <name>\`.`);
    }
    env.SSH_ASKPASS = askpassShimPath;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env[ASKPASS_BUNDLE_ENV] = device.auth.bundle;
    env[ASKPASS_KEY_ENV] = device.auth.bundleKey ?? 'password';
    if (opts.agentOnly) env[ASKPASS_AGENT_ONLY_ENV] = '1';
    args.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1');
  } else {
    args.push('-o', 'BatchMode=yes');
    args.push(...deviceIdentityArgs(device));
  }

  if (interactive) args.push('-tt');
  args.push(target);
  if (remote) args.push(remote);
  return { args, env };
}

export function buildAskpassShimBody(
  launch: { command: string; args: string[] } = getCliLaunch(['ssh', '__askpass']),
): string {
  const exec = [launch.command, ...launch.args].map(shellQuote).join(' ');
  return `#!/bin/sh\n# Generated by agents-cli — bridges ssh SSH_ASKPASS back into the CLI.\nexec ${exec}\n`;
}

export function writeAskpassShim(): string {
  const dir = path.join(getCacheDir(), 'devices');
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, 'askpass.sh');
  fs.writeFileSync(shimPath, buildAskpassShimBody(), { mode: 0o700 });
  return shimPath;
}
