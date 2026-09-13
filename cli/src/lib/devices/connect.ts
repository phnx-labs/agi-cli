/**
 * Connection layer for `agents ssh` — turn a device profile into a real ssh
 * invocation, with platform-aware command wrapping and password-from-bundle
 * auth.
 *
 * Auth is genuinely two first-class, non-interactive methods:
 *  - `key`      — the system ssh agent / on-disk keys (BatchMode-friendly).
 *  - `password` — the secret is pulled from a Keychain-backed secrets bundle
 *                 by an askpass shim. The wrapper points `SSH_ASKPASS` at the
 *                 shim and forces its use; ssh calls the shim, the shim calls
 *                 back into `agents ssh __askpass`, which resolves the bundle
 *                 via the existing `readAndResolveBundleEnv` path and prints
 *                 the password to ssh. The password never touches argv or an
 *                 expect buffer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { assertValidSshTarget, shellQuote } from '../ssh-exec.js';
import { resolveActor, actorEnv } from '../actor.js';
import { getCliLaunch } from '../cli-entry.js';
import { encodePwshBase64 } from '../pwsh.js';
import { homeRemainder, remoteCdPrefix } from '../project-root.js';
import { getCacheDir } from '../state.js';
import { hostKeyCheckingOpts } from './known-hosts.js';
import { hostNameFor } from './ssh-config.js';
import { resolveDeviceProfile } from './resolve-profile.js';
import { type DeviceProfile } from './registry.js';

/** Env var the askpass shim reads to know which bundle holds the password. */
export const ASKPASS_BUNDLE_ENV = 'AGENTS_SSH_BUNDLE';
/** Env var the askpass shim reads to know which key in the bundle is the password. */
export const ASKPASS_KEY_ENV = 'AGENTS_SSH_KEY';
/**
 * Env var that forces the askpass bundle resolve to be broker-only (`agentOnly`)
 * regardless of TTY. A read-only stats probe (`agents devices` load/mem columns)
 * sets this so an uncached password-auth device resolves from the already-unlocked
 * secrets broker or degrades to an unreachable row — never a foreground Touch ID
 * sheet. See {@link buildSshInvocation}'s `agentOnly` option and `runAskpass`. (RUSH-1970)
 */
export const ASKPASS_AGENT_ONLY_ENV = 'AGENTS_SSH_AGENT_ONLY';

/**
 * Build the `user@host` (or bare `host`) ssh target for a device and validate
 * it against the shared injection guard. Throws if the device has no address.
 */
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

/**
 * The address a fleet fan-out probe should hand to `ssh` for a device: the
 * registry's known-good Tailscale dnsName/IP (via {@link sshTargetFor}) when
 * present, else the bare name (an address-less manual device dials by name as
 * before — never worse than the old behaviour).
 *
 * Prefer the registry address so a stale `~/.ssh/config` alias can never shadow
 * it: dialing the bare device name lets ssh resolve it through the user's config,
 * where a hand-written `Host <name>` block with a DHCP-drifted LAN IP silently
 * shadows the correct entry, times out, and makes a reachable box look dead.
 * Pure/testable.
 */
export function fleetDialTarget(device: DeviceProfile): string {
  try {
    return sshTargetFor(device);
  } catch {
    const resolved = resolveDeviceProfile(device);
    return resolved.user ? `${resolved.user}@${resolved.name}` : resolved.name;
  }
}

/**
 * Wrap a remote command for the device's shell. Windows devices speak
 * PowerShell, so a bare command is run through `powershell -NoProfile
 * -EncodedCommand`; POSIX devices get the command verbatim (the remote login
 * shell parses it). Returns undefined when no command was given (interactive
 * login).
 */
export function wrapRemoteCommand(device: DeviceProfile, cmd: string[]): string | undefined {
  if (cmd.length === 0) return undefined;
  const joined = cmd.join(' ');
  if (device.shell === 'powershell') {
    return `powershell -NoProfile -EncodedCommand ${encodePwshBase64(joined)}`;
  }
  return joined;
}

/**
 * True when `cmd` is a browser drive: `agents browser …`, `ag browser …`, or
 * the standalone `browser` binary (`cli/package.json` `bin.browser` →
 * `src/browser.ts`), including the quoted single-string form
 * `agents ssh box 'browser …'`. The `--device` passthrough stamps
 * {@link markFleetRemote} on this shape so the far-side consent gate can fire;
 * `agents ssh` must too (PHNX-3065).
 */
export function isAgentsBrowserDrive(cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  const tokens = cmd.length === 1 && /\s/.test(cmd[0]!) ? cmd[0]!.trim().split(/\s+/) : cmd;
  const bin = tokens[0];
  if (bin === 'browser') return true;
  return (bin === 'agents' || bin === 'ag') && tokens[1] === 'browser';
}

/**
 * Prefix a remote command with the provenance the far-side browser needs: the
 * `AGENTS_FLEET_REMOTE=1` consent marker AND the caller's resolved actor
 * (`AGENTS_ACTOR*`/`GIT_*`). Without the actor, a task created over
 * `agents ssh <host> 'agents browser …'` is stamped `UNRESOLVED@<host>` because
 * the peer re-resolves identity from its own (empty) env — the same RUSH-2028
 * gap the `--device` dispatch already closes via `withActorEnv`, applied here to
 * the `agents ssh` browser-drive seam so ownership is honest across BOTH paths.
 *
 * `wrapRemoteCommand` joins the argv with spaces (POSIX) or base64-encodes it for
 * PowerShell, so a shell-appropriate prelude rides through both: `env VAR=v …` on
 * POSIX, `$env:VAR='v'; …` on PowerShell. The marker stays the FIRST token so the
 * consent gate and the idempotency guard below both still key on it.
 *
 * `provenanceEnv` is injectable so tests can pin a deterministic actor; it
 * defaults to the live resolved actor. Already-marked argv (the `--device`
 * fan-out stamps the marker before {@link buildSshInvocation}) is left unchanged
 * so nothing is doubled.
 */
export function markFleetRemote(
  cmd: string[],
  device: Pick<DeviceProfile, 'shell'>,
  provenanceEnv: Record<string, string> = actorEnv(resolveActor()),
): string[] {
  if (device.shell === 'powershell') {
    // Exact-match guard, symmetric with the POSIX branch below: the marker token
    // is always this literal, so `startsWith` would only loosen it for no gain.
    if (cmd[0] === `$env:AGENTS_FLEET_REMOTE='1';`) return cmd;
    const prelude = [
      `$env:AGENTS_FLEET_REMOTE='1';`,
      ...Object.entries(provenanceEnv).map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}';`),
    ];
    return [...prelude, ...cmd];
  }
  if (cmd[0] === 'env' && cmd[1] === 'AGENTS_FLEET_REMOTE=1') return cmd;
  const actorTokens = Object.entries(provenanceEnv).map(([k, v]) => shellQuote(`${k}=${v}`));
  return ['env', 'AGENTS_FLEET_REMOTE=1', ...actorTokens, ...cmd];
}

/**
 * Build the remote command that starts an INTERACTIVE LOGIN shell inside a
 * mirrored project directory, falling back to the remote home when that
 * directory is absent. Returns undefined when there is nothing to mirror
 * (`mirrorCwd` is undefined, or resolves to the home root itself) so the caller
 * keeps the plain no-command interactive login.
 *
 * This is the interactive analogue of `agents run --device`'s cwd mirroring, and
 * it reuses the SAME machinery so there is no second resolver: the portable
 * `mirrorCwd` comes from `deriveMirroredCwd`, and — for POSIX — the best-effort
 * `cd` comes from `remoteCdPrefix({ mirror: true })`, whose `|| cd "$HOME"`
 * guarantees a missing checkout never fails the login (acceptance #2). It then
 * replaces the wrapper with a login shell (`exec "$SHELL" -l`); running under
 * the forced tty (`-tt`, see {@link buildSshInvocation}) makes that login shell
 * interactive, so prompt, startup files, and login behavior match a plain
 * `ssh <host>` (acceptance #1).
 *
 * PowerShell hosts get a profile-loading interactive shell (`-NoExit`, and
 * deliberately NOT `-NoProfile` so the user's profile still runs) that
 * `Set-Location`s into the mirrored dir when it exists. The path is carried
 * through `-EncodedCommand` (base64 UTF-16LE), so it is literal and
 * injection-safe regardless of spaces or shell metacharacters (acceptance #3).
 */
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
  /**
   * True when the device's host key is already pinned in the managed
   * known_hosts store — connections then verify with `StrictHostKeyChecking=yes`
   * (a key swap is refused). False (the default) keeps `accept-new` for a
   * genuine first enrollment, whose learned key lands in the managed store and
   * pins the host for every subsequent connect. See {@link hostKeyCheckingOpts}.
   */
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

/**
 * Build the argv (after the `ssh` program name) and the environment overlay
 * for connecting to a device. For password auth this points `SSH_ASKPASS` at
 * the shim and disables pubkey + the host's interactive password prompt so the
 * shim is the only auth path. Pure (no spawn) so it is unit-testable.
 *
 * Host-key checking runs against the CLI-managed known_hosts store (never the
 * user's `~/.ssh/known_hosts`): strict once `hostKey.pinned` is set, else
 * `accept-new` to learn+pin the key on first connect (RUSH-1767).
 *
 * `opts.agentOnly` marks the connection as a read-only probe: for password auth
 * it sets {@link ASKPASS_AGENT_ONLY_ENV} in the overlay so the askpass resolve
 * stays broker-only and never pops a foreground biometric (RUSH-1970).
 *
 * `opts.interactiveCwd` is the portable (`~/…`) directory to mirror on an
 * interactive login (no `cmd`) — from `deriveMirroredCwd(process.cwd())`. When
 * it names a real home-relative sub-path, the login starts there via
 * {@link buildInteractiveShellCommand} (best-effort — a missing dir falls back
 * to the remote home), matching `agents run --device`. It is ignored when a `cmd`
 * is given: an explicit command keeps its current cwd (the remote home) and its
 * behavior unchanged (RUSH-2412).
 *
 * An `agents browser …` / `ag browser …` / standalone `browser …` command is
 * prefixed with {@link markFleetRemote} so the far-side consent gate sees
 * `AGENTS_FLEET_REMOTE=1` the same way `browser --device` does. The local `env`
 * overlay here is for the ssh *client* (askpass); it cannot carry the marker —
 * OpenSSH does not forward arbitrary env (PHNX-3065).
 */
export function buildSshInvocation(
  device: DeviceProfile,
  cmd: string[],
  askpassShimPath: string,
  hostKey: SshHostKeyOptions = {},
  opts: { agentOnly?: boolean; interactiveCwd?: string } = {},
): { args: string[]; env: Record<string, string> } {
  // The effective profile: central config (ssh.*/platform/user) overlaid on
  // the registry's discovery record.
  device = resolveDeviceProfile(device);
  const target = sshTargetFor(device);
  // No cmd ⇒ interactive login. It may still carry a derived cd+login-shell
  // wrapper (interactiveCwd), which is an interactive login too and still needs
  // a real tty below.
  const interactive = cmd.length === 0;
  // Stamp the consent marker on the REMOTE command, not the local ssh env:
  // SSH_ASKPASS lives on this side; AGENTS_FLEET_REMOTE must be visible to the
  // process that runs on the peer.
  const remoteCmd = !interactive && isAgentsBrowserDrive(cmd) ? markFleetRemote(cmd, device) : cmd;
  const remote = interactive
    ? buildInteractiveShellCommand(device, opts.interactiveCwd)
    : wrapRemoteCommand(device, remoteCmd);
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

/**
 * Build the askpass shim's `#!/bin/sh` body: a script that re-invokes this CLI
 * as `agents ssh __askpass`. The relaunch argv comes from {@link getCliLaunch},
 * never a hand-rolled `[process.execPath, process.argv[1], …]` — on a Bun
 * standalone binary `process.argv[1]` is the *virtual* embedded entry
 * `/$bunfs/root/agents`, which the CLI would then receive as a bogus subcommand
 * (`unknown command '/$bunfs/root/agents'`), print nothing, and hand ssh an
 * empty password. `getCliLaunch` resolves the physical executable so the shim
 * works on both the standalone and JS/dev builds. Every argv element is
 * shell-quoted. Pure (takes the launch as a parameter) so it is unit-testable.
 */
export function buildAskpassShimBody(
  launch: { command: string; args: string[] } = getCliLaunch(['ssh', '__askpass']),
): string {
  const exec = [launch.command, ...launch.args].map(shellQuote).join(' ');
  return `#!/bin/sh\n# Generated by agents-cli — bridges ssh SSH_ASKPASS back into the CLI.\nexec ${exec}\n`;
}

/**
 * Write (idempotently) the askpass shim — a tiny executable that re-invokes
 * this CLI as `agents ssh __askpass`. ssh execs `SSH_ASKPASS` with no usable
 * args, so the shim carries no secret itself; it only bridges ssh's askpass
 * protocol back into the CLI, which then resolves the bundle.
 */
export function writeAskpassShim(): string {
  const dir = path.join(getCacheDir(), 'devices');
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, 'askpass.sh');
  fs.writeFileSync(shimPath, buildAskpassShimBody(), { mode: 0o700 });
  return shimPath;
}
