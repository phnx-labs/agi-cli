/** Connection layer for `agents ssh`: turn a device profile into an ssh invocation with
 * platform-aware command wrapping. Auth is `key` or `password` (Keychain bundle via an askpass
 * shim calling `agents ssh __askpass`). The password never touches argv. */
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

/** Env var the askpass shim reads to know which bundle holds the password. */
export const ASKPASS_BUNDLE_ENV = 'AGENTS_SSH_BUNDLE';
/** Env var the askpass shim reads to know which key in the bundle is the password. */
export const ASKPASS_KEY_ENV = 'AGENTS_SSH_KEY';
/** Forces the askpass bundle resolve to be broker-only (`agentOnly`) regardless of TTY. A read-only
 * stats probe sets it so an uncached password device resolves from the broker or shows
 * unreachable, never a foreground Touch ID sheet (RUSH-1970). */
export const ASKPASS_AGENT_ONLY_ENV = 'AGENTS_SSH_AGENT_ONLY';

/** Build the `user@host` (or bare `host`) ssh target and validate it against the shared injection
 * guard. Throws if the device has no address. */
export function sshTargetFor(device: DeviceProfile): string {
  const resolved = resolveDeviceProfile(device);
  const host = hostNameFor(resolved);
  if (!host) {
    throw new Error(`Device '${resolved.name}' has no address (dnsName/ip). Run \`agents devices sync\` or \`agents devices add\`.`);
  }
  const target = resolved.user ? `${resolved.user}@${host}` : host;
  assertValidSshTarget(target);
  return target;
}

/** The address a fleet fan-out probe hands to `ssh`: the registry's Tailscale dnsName/IP when
 * present, else the bare name. Prefer the registry address so a stale `~/.ssh/config` alias (e.g.
 * a DHCP-drifted LAN IP) cannot shadow it and make a reachable box look dead. Pure. */
export function fleetDialTarget(device: DeviceProfile): string {
  try {
    return sshTargetFor(device);
  } catch {
    const resolved = resolveDeviceProfile(device);
    return resolved.user ? `${resolved.user}@${resolved.name}` : resolved.name;
  }
}

/** Render `cmd` as the single command string ssh sends to the peer: PowerShell `-EncodedCommand`
 * for Windows, the login shell's view for POSIX; undefined means interactive login. Tokens join
 * raw on purpose, since callers rely on remote shell parsing; `{ argv: true }` quotes each token. */
export function wrapRemoteCommand(
  device: DeviceProfile,
  cmd: string[],
  opts: { argv?: boolean; prelude?: string[] } = {},
): string | undefined {
  if (cmd.length === 0) return undefined;
  const prelude = opts.prelude ?? [];
  let script: string;
  if (opts.argv) {
    // Quote EACH caller token so the peer receives it byte-for-byte, then prefix
    // the prelude VERBATIM — it is already shell syntax and re-quoting it would
    // break it (see `fleetRemotePrelude`).
    if (device.shell === 'powershell') {
      script = pwshExactArgvScript(cmd, prelude);
    } else {
      script = [...prelude, ...cmd.map(shellQuote)].join(' ');
    }
  } else {
    // The default joins raw, which is what lets a caller hand the remote shell
    // something to interpret. See the docblock above for why both must exist.
    script = [...prelude, ...cmd].join(' ');
  }
  if (device.shell === 'powershell') {
    // Same renderer as the Windows `agents` launcher, so long scripts get the compressed form. The
    // interactive login route (`buildInteractiveShellCommand`, -NoExit) is left alone.
    return renderPowershellCommand(script);
  }
  return script;
}

/** Single-quote one token for PowerShell's own parser (only `'` is special, escaped by doubling).
 * Not sufficient for an argument handed to a native program; see the Win32 note below. */
export function pwshQuote(token: string): string {
  return `'${token.replace(/'/g, "''")}'`;
}

/** Emit a PowerShell script that runs `cmd` with exact argv. PowerShell 5.1's native-arg serializer
 * is lossy (drops empty args, discards embedded `"`) and `--%` fails for `agents.ps1`. So a native
 * executable runs via `System.Diagnostics.Process`; anything else gets a splatted array. */
function pwshExactArgvScript(cmd: string[], prelude: string[]): string {
  // The Agents CLI gets the canonical launcher: on Windows `agents` is an npm `agents.ps1` that
  // splats `$args` into node.exe (the lossy path). `windowsAgentsInvocation` runs the package
  // entry directly so the real parser sees exact tokens.
  const bin = cmd[0];
  if (bin === 'agents' || bin === 'ag') {
    // `windowsAgentsInvocation` leaves the child's code in `$zq`.
    return [...prelude, windowsAgentsInvocation(cmd.slice(1), bin), 'exit $zq'].join('\n');
  }
  const program = pwshQuote(cmd[0]!);
  const rest = cmd.slice(1);
  const splat = rest.length > 0 ? `@(${rest.map(pwshQuote).join(', ')})` : '@()';
  return [
    ...prelude,
    `$ErrorActionPreference='Stop'`,
    `$__c = Get-Command -Name ${program} -ErrorAction Stop`,
    `if ($__c.CommandType -eq 'Application') {`,
    // One emitter for the .NET native-exec block, shared with the Windows
    // `agents` launcher in `hosts/remote-cmd.ts`; a second copy would drift.
    ...pwshNativeExecStatements('$__c.Source', pwshLiteral(rest.map(quoteWin32ExecArg).join(' '))).map((line) => `  ${line}`),
    // `pwshNativeExecStatements` names the process handle `$zp`.
    `  exit $zp.ExitCode`,
    `}`,
    // `@__a` SPLATS the array into separate arguments. `& $__c @(...)` on an
    // array LITERAL does not splat — it passes one array-valued argument, which
    // a real peer reported back as every token collapsed into one.
    `$__a = ${splat}`,
    `& $__c @__a`,
    `if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
  ].join('\n');
}

/** True when `cmd` is a browser drive: `agents browser ...`, `ag browser ...`, or the standalone
 * `browser` binary, including the quoted single-string form. `--device` and `agents ssh` both
 * stamp {@link markFleetRemote} on this shape so the far-side consent check fires (PHNX-3065). */
export function isAgentsBrowserDrive(cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  const tokens = cmd.length === 1 && /\s/.test(cmd[0]!) ? cmd[0]!.trim().split(/\s+/) : cmd;
  const bin = tokens[0];
  if (bin === 'browser') return true;
  return (bin === 'agents' || bin === 'ag') && tokens[1] === 'browser';
}

/** Prefix a remote command with the far-side browser's provenance: the `AGENTS_FLEET_REMOTE=1`
 * consent marker and the caller's resolved actor. Without the actor the peer stamps tasks
 * `UNRESOLVED@<host>` (RUSH-2028). Marker first; already-marked argv is unchanged. */
/** The provenance prefix as ready shell syntax for the device's shell. Tokens are already quoted,
 * and argv mode quotes every token, so requoting corrupts them (and makes a pwsh assignment
 * inert). So the prelude is composed separately from argv; both paths use this one definition. */
export function fleetRemotePrelude(
  device: Pick<DeviceProfile, 'shell'>,
  provenanceEnv: Record<string, string> = actorEnv(resolveActor()),
): string[] {
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

/** True when `cmd` already carries the prelude {@link fleetRemotePrelude} emits. */
function alreadyMarked(cmd: string[], device: Pick<DeviceProfile, 'shell'>): boolean {
  if (device.shell === 'powershell') return cmd[0] === `$env:AGENTS_FLEET_REMOTE='1';`;
  return cmd[0] === 'env' && cmd[1] === 'AGENTS_FLEET_REMOTE=1';
}

export function markFleetRemote(
  cmd: string[],
  device: Pick<DeviceProfile, 'shell'>,
  provenanceEnv: Record<string, string> = actorEnv(resolveActor()),
): string[] {
  // Exact-match guard: the marker token is always this literal, so `startsWith`
  // would only loosen it for no gain.
  if (alreadyMarked(cmd, device)) return cmd;
  return [...fleetRemotePrelude(device, provenanceEnv), ...cmd];
}

/** Build the remote command that starts an interactive login shell in a mirrored project directory,
 * falling back to the remote home; undefined when there is nothing to mirror. PowerShell passes
 * the path via `-EncodedCommand`, so it is literal and injection-safe. */
export function buildInteractiveShellCommand(
  device: DeviceProfile,
  mirrorCwd: string | undefined,
): string | undefined {
  if (!mirrorCwd) return undefined;
  const rest = homeRemainder(mirrorCwd);
  // Only a real sub-path of the home dir is worth mirroring; the home root
  // itself (rest === '') is where a plain login already lands, and a
  // non-home-anchored path (rest === null) has no meaningful remote analogue.
  if (rest === null || rest === '') return undefined;

  if (device.shell === 'powershell') {
    // Single-quoted PowerShell literal: the only escape inside '…' is '' for a
    // literal quote, so this is injection-safe for any path.
    const literal = rest.replace(/'/g, "''");
    const script =
      `$d = Join-Path -Path $HOME -ChildPath '${literal}'; ` +
      `if (Test-Path -LiteralPath $d) { Set-Location -LiteralPath $d }`;
    return `powershell -NoLogo -NoExit -EncodedCommand ${encodePwshBase64(script)}`;
  }

  return `${remoteCdPrefix(mirrorCwd, { mirror: true })}exec "$SHELL" -l`;
}

/** Host-key posture for {@link buildSshInvocation}. */
interface SshHostKeyOptions {
  /** True when the device's host key is already pinned in the managed known_hosts store, so
   * connections use `StrictHostKeyChecking=yes`. False (default) keeps `accept-new` for first
   * enrollment, whose learned key is then pinned. See {@link hostKeyCheckingOpts}. */
  pinned?: boolean;
  /** Managed known_hosts path override (tests). Defaults to the CLI-managed store. */
  knownHostsFile?: string;
}

/** OpenSSH argv that makes an explicit device key authoritative. */
export function deviceIdentityArgs(device: DeviceProfile): string[] {
  const resolved = resolveDeviceProfile(device);
  return resolved.auth?.method === 'key' && resolved.auth.identityFile
    ? ['-i', resolved.auth.identityFile, '-o', 'IdentitiesOnly=yes']
    : [];
}

/** Build the ssh argv and env overlay for a device (pure). Password auth: askpass shim only; host
 * keys pinned in the CLI known_hosts (RUSH-1767). `agentOnly`: no biometric prompt (RUSH-1970).
 * `interactiveCwd` ignored with a `cmd` (RUSH-2412); browser cmds get markFleetRemote (PHNX-3065). */
export function buildSshInvocation(
  device: DeviceProfile,
  cmd: string[],
  askpassShimPath: string,
  hostKey: SshHostKeyOptions = {},
  opts: { agentOnly?: boolean; interactiveCwd?: string; argv?: boolean } = {},
): { args: string[]; env: Record<string, string> } {
  // The effective profile: central config (ssh.*/platform/user) overlaid on
  // the registry's discovery record.
  device = resolveDeviceProfile(device);
  const target = sshTargetFor(device);
  // No cmd ⇒ interactive login. It may still carry a derived cd+login-shell
  // wrapper (interactiveCwd), which is an interactive login too and still needs
  // a real tty below.
  const interactive = cmd.length === 0;
  // Stamp the consent marker on the remote command, not the local ssh env: AGENTS_FLEET_REMOTE
  // must be visible to the process on the peer. Provenance is a prelude, not prepended to argv:
  // argv mode quotes every token, which made pwsh assignments inert.
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

  // An interactive login needs a real tty — whether it starts a bare login
  // shell (no remote command) or the derived cd+login-shell mirror.
  if (interactive) args.push('-tt');
  args.push(target);
  if (remote) args.push(remote);
  return { args, env };
}

/** Build the askpass shim's `#!/bin/sh` body, re-invoking this CLI as `agents ssh __askpass` via
 * {@link getCliLaunch}, never `process.argv[1]`: on a Bun standalone binary that is the virtual
 * `/$bunfs/root/agents`, which gave an empty password. Elements are shell-quoted. Pure. */
export function buildAskpassShimBody(
  launch: { command: string; args: string[] } = getCliLaunch(['ssh', '__askpass']),
): string {
  const exec = [launch.command, ...launch.args].map(shellQuote).join(' ');
  return `#!/bin/sh\n# Generated by agents-cli — bridges ssh SSH_ASKPASS back into the CLI.\nexec ${exec}\n`;
}

/** Write (idempotently) the askpass shim, which re-invokes this CLI as `agents ssh __askpass`. ssh
 * execs it with no usable args, so it carries no secret and only bridges askpass back into the
 * CLI. */
export function writeAskpassShim(): string {
  const dir = path.join(getCacheDir(), 'devices');
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, 'askpass.sh');
  fs.writeFileSync(shimPath, buildAskpassShimBody(), { mode: 0o700 });
  return shimPath;
}
