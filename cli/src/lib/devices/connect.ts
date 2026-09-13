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
 * Render `cmd` as the single command string ssh sends to the peer.
 *
 * Windows devices speak PowerShell, so the result is run through
 * `powershell -NoProfile -EncodedCommand`; POSIX devices get it as the remote
 * login shell sees it. Returns undefined when no command was given (interactive
 * login).
 *
 * TWO MODES, and the difference is load-bearing rather than a convenience.
 *
 * The default joins the tokens RAW. That is not a bug to be tidied away: every
 * existing caller of `agents ssh` relies on the remote shell interpreting what it
 * is handed — `agents ssh box 'bash -lc "cd x && make"'` arrives as ONE token
 * whose pipeline, globs and redirections the peer's shell must expand. Quoting
 * that would ship the whole line as a literal argument and break it.
 *
 * `{ argv: true }` is for a caller that genuinely holds an argv ARRAY and needs
 * each element delivered as exactly one token. Joining those raw destroys any
 * token containing a space or a metacharacter — `['--title', 'two words']`
 * arrives as three tokens, and `'a & b'` arrives as a backgrounded command — which
 * is what a native client hitting this path actually hit.
 *
 * So fidelity is opt-in at the call site that knows which shape it has, and the
 * quoting itself reuses the canonical helpers (`shellQuote`, {@link pwshQuote})
 * rather than introducing a third escaping scheme.
 */
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
    // Same renderer the Windows `agents` launcher uses, so a long script gets the
    // compressed representation here too rather than only on that path. The
    // interactive login route (`buildInteractiveShellCommand`, -NoExit) is
    // deliberately left alone: it must stay an interactive session.
    return renderPowershellCommand(script);
  }
  return script;
}

/**
 * Single-quote one token for PowerShell's OWN parser. Inside a single-quoted pwsh
 * string the only special character is `'`, escaped by doubling.
 *
 * This is correct for a value PowerShell itself consumes, and NOT sufficient for
 * an argument handed on to a native program — see the Win32 note below.
 */
export function pwshQuote(token: string): string {
  return `'${token.replace(/'/g, "''")}'`;
}

/**
 * Emit a PowerShell script that runs `cmd` with EXACT argv, for either kind of
 * target a Windows peer can name.
 *
 * Windows has no argv array: a process receives ONE string and splits it itself.
 * PowerShell 5.1 rebuilds that string when it invokes a native program, and its
 * serializer is lossy — measured on a real peer, an EMPTY argument is dropped and
 * an embedded `"` is discarded, so the callee's argv silently shifts.
 *
 * The obvious fix, the `--%` stop-parsing token, is NOT used, because measurement
 * killed it three ways:
 *   - it only applies to a NATIVE command, and `agents` on Windows resolves to
 *     `agents.ps1`, so a script target received `--%` as a literal argument and
 *     the whole remainder as one string;
 *   - a token containing a NEWLINE terminates the directive, producing a parser
 *     error;
 *   - it performs cmd-style `%VAR%` expansion, so a literal `%PATH%` became six
 *     arguments — the exact opposite of exact argv.
 *
 * So the script branches on what the peer's own command discovery finds:
 *
 *   - **native executable** — launched through `System.Diagnostics.Process` with a
 *     pre-built `Arguments` string escaped by {@link quoteWin32ExecArg}. .NET hands
 *     that string to `CreateProcess` essentially verbatim, so the child's
 *     `CommandLineToArgvW` reconstructs the tokens exactly; no shell sees it, so
 *     no `%VAR%` expansion and no newline sensitivity. `UseShellExecute = $false`
 *     with no redirection leaves the child on the inherited handles, which is what
 *     lets a binary stdout stream through unchanged.
 *   - **anything else** (a `.ps1`/`.cmd` launcher, a function, a cmdlet, an alias)
 *     — invoked with a splatted PowerShell array. That is an in-process call, so
 *     the native serializer is never involved and every token survives as itself.
 *
 * The exit code is propagated in both branches; a script launcher that sets no
 * `$LASTEXITCODE` is left alone rather than forced to 0.
 */
function pwshExactArgvScript(cmd: string[], prelude: string[]): string {
  // The Agents CLI gets the canonical launcher, not the generic dispatch. On
  // Windows `agents` is an npm `agents.ps1` whose own body splats `$args` into
  // native node.exe — the PowerShell 5.1 lossy path — so even a perfectly
  // splatted call into that script loses an embedded quote one layer deeper.
  // `windowsAgentsInvocation` resolves the package's declared entry and runs it
  // directly, which is the only way the real Agents parser sees exact tokens.
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
/**
 * The provenance prefix as READY SHELL SYNTAX for the device's shell.
 *
 * These tokens are already quoted/escaped for their target shell — a POSIX
 * `K=V` pair is `shellQuote`d here, and a PowerShell assignment is a complete
 * statement with its own doubled quotes. That matters because argv mode quotes
 * every token it is handed: quoting THESE again turns
 * `'AGENTS_ACTOR=Some Name'` into `''\''AGENTS_ACTOR=Some Name'\'''` and turns a
 * pwsh assignment into an inert string literal. So the prelude is composed
 * SEPARATELY from the caller's argv rather than concatenated into it, and this is
 * the single definition both paths use.
 */
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
  // Stamp the consent marker on the REMOTE command, not the local ssh env:
  // SSH_ASKPASS lives on this side; AGENTS_FLEET_REMOTE must be visible to the
  // process that runs on the peer.
  // Provenance is composed as a PRELUDE, not prepended to the argv array. In argv
  // mode every token handed to `wrapRemoteCommand` is quoted, and the prelude is
  // already shell syntax — mixing them in meant the actor pairs were quoted twice
  // (breaking any value with a space or a quote) and the pwsh assignments became
  // inert string literals.
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
