/**
 * SSH invocation builder correctness.
 *
 * This is where auth is decided, so the real bugs are security- and
 * connectivity-shaped: password auth must route through the askpass shim and
 * disable pubkey/interactive prompts (else the password never reaches ssh, or
 * ssh hangs on a tty prompt); a Windows command must be wrapped in PowerShell
 * (a bare POSIX command silently fails on cmd); and the target must pass the
 * injection guard.
 */
import { describe, expect, it } from 'vitest';
import { buildAskpassShimBody, buildInteractiveShellCommand, buildSshInvocation, deviceIdentityArgs, fleetDialTarget, isAgentsBrowserDrive, markFleetRemote, sshTargetFor, wrapRemoteCommand, ASKPASS_BUNDLE_ENV, ASKPASS_KEY_ENV, ASKPASS_AGENT_ONLY_ENV } from './connect.js';
import type { DeviceProfile } from './registry.js';
import { assertRemoteControlAllowed } from '../browser/remote-control.js';
import { decodeRenderedPowershell } from '../hosts/remote-cmd.test-fixture.js';

const decodePowerShell = decodeRenderedPowershell;

/** Decode the interactive PowerShell login form: `-NoLogo -NoExit -EncodedCommand …`. */
function decodeInteractivePowerShell(cmd: string): string {
  // The interactive login route is deliberately NOT compressed — it must stay an
  // interactive session — so this one form is the only valid shape here.
  const m = cmd.match(/^powershell -NoLogo -NoExit -EncodedCommand (\S+)$/);
  if (!m) throw new Error(`not an interactive EncodedCommand invocation: ${cmd}`);
  return Buffer.from(m[1]!, 'base64').toString('utf16le');
}

function dev(over: Partial<DeviceProfile> & { name: string }): DeviceProfile {
  return {
    name: over.name,
    platform: over.platform ?? 'linux',
    shell: over.shell ?? 'posix',
    user: over.user,
    address: over.address ?? { via: 'tailscale', dnsName: `${over.name}.ts.net` },
    auth: over.auth ?? { method: 'key' },
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
  };
}

describe('sshTargetFor', () => {
  it('builds user@host and rejects addressless devices', () => {
    expect(sshTargetFor(dev({ name: 'x', user: 'muqsit', address: { via: 'tailscale', dnsName: 'x.ts.net' } }))).toBe('muqsit@x.ts.net');
    expect(sshTargetFor(dev({ name: 'y', address: { via: 'manual', ip: '10.0.0.1' } }))).toBe('10.0.0.1');
    expect(() => sshTargetFor(dev({ name: 'z', address: { via: 'manual' } }))).toThrow(/no address/);
  });
});

describe('fleetDialTarget', () => {
  it('prefers the registry Tailscale dnsName over the bare name (drift-proof)', () => {
    // The whole point: dialing the bare "yosemite-m1" lets a stale ~/.ssh/config
    // block win; dialing the dnsName sidesteps it entirely.
    expect(fleetDialTarget(dev({ name: 'yosemite-m1', user: 'muqsit', address: { via: 'tailscale', dnsName: 'yosemite-m1.ts.net' } })))
      .toBe('muqsit@yosemite-m1.ts.net');
  });

  it('uses the IP when there is no dnsName, and omits an absent user', () => {
    expect(fleetDialTarget(dev({ name: 'm', user: 'muqsit', address: { via: 'manual', ip: '100.74.242.106' } })))
      .toBe('muqsit@100.74.242.106');
    expect(fleetDialTarget(dev({ name: 'm', address: { via: 'tailscale', dnsName: 'm.ts.net' } }))).toBe('m.ts.net');
  });

  it('falls back to the bare name for an address-less manual device (never worse than before)', () => {
    expect(fleetDialTarget(dev({ name: 'yosemite-m1', user: 'muqsit', address: { via: 'manual' } }))).toBe('muqsit@yosemite-m1');
    expect(fleetDialTarget(dev({ name: 'yosemite-m1', address: { via: 'manual' } }))).toBe('yosemite-m1');
  });
});

describe('wrapRemoteCommand', () => {
  it('wraps Windows commands in a PowerShell EncodedCommand, leaves POSIX verbatim, undefined for interactive', () => {
    const wrapped = wrapRemoteCommand(dev({ name: 'w', shell: 'powershell' }), ['Write-Output', "'ran'"]);
    expect(wrapped).toMatch(/^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(decodePowerShell(wrapped!)).toBe("Write-Output 'ran'");
    expect(wrapRemoteCommand(dev({ name: 'l', shell: 'posix' }), ['uptime', '-p'])).toBe('uptime -p');
    expect(wrapRemoteCommand(dev({ name: 'i', shell: 'posix' }), [])).toBeUndefined();
  });
});

describe('buildInteractiveShellCommand', () => {
  // RUSH-2412: an interactive `agents ssh <device>` mirrors the caller's
  // home-relative project dir on the target, matching `agents run --device`.
  it('POSIX: best-effort cd into the mirrored dir, then exec a login shell', () => {
    const cmd = buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), '~/src/github.com/muqsitnawaz/agents-cli');
    // `"$HOME"` stays unquoted so the REMOTE shell expands it (target home may
    // differ from the caller's); the remainder is shell-quoted only when it has
    // special chars — a plain path stays bare (same rule as remoteCdPrefix).
    expect(cmd).toBe(`{ cd "$HOME"/src/github.com/muqsitnawaz/agents-cli || cd "$HOME"; } && exec "$SHELL" -l`);
  });

  it('POSIX: the `|| cd "$HOME"` fallback means a missing mirror can never fail the login (acceptance #2)', () => {
    const cmd = buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), '~/src/app')!;
    expect(cmd).toContain('|| cd "$HOME"');
    // The login shell still runs after the fallback cd.
    expect(cmd.endsWith('&& exec "$SHELL" -l')).toBe(true);
  });

  it('POSIX: paths with spaces and shell metacharacters are single-quoted, not expanded (acceptance #3)', () => {
    const cmd = buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), "~/my proj; rm -rf $(x)")!;
    // The whole remainder is one single-quoted literal — no word-splitting, no
    // command substitution, no second cd.
    expect(cmd).toBe(`{ cd "$HOME"/'my proj; rm -rf $(x)' || cd "$HOME"; } && exec "$SHELL" -l`);
  });

  it('returns undefined for the home root itself (a plain login already lands there)', () => {
    expect(buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), '~')).toBeUndefined();
    expect(buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), '$HOME')).toBeUndefined();
  });

  it('returns undefined when there is nothing to mirror (cwd outside the local home)', () => {
    // deriveMirroredCwd returns undefined for a non-home path; the builder then
    // keeps the plain no-command interactive login.
    expect(buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), undefined)).toBeUndefined();
    // A raw absolute path is not home-anchored ⇒ no meaningful remote analogue.
    expect(buildInteractiveShellCommand(dev({ name: 'l', shell: 'posix' }), '/opt/thing')).toBeUndefined();
  });

  it('PowerShell: Set-Location into the mirrored dir when present, interactive (-NoExit) with profile loaded', () => {
    const cmd = buildInteractiveShellCommand(dev({ name: 'w', shell: 'powershell' }), '~/src/app')!;
    // Interactive login keeps the user profile (no -NoProfile), and -NoExit
    // drops to the prompt after Set-Location.
    expect(cmd).toMatch(/^powershell -NoLogo -NoExit -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = decodeInteractivePowerShell(cmd);
    expect(script).toBe(`$d = Join-Path -Path $HOME -ChildPath 'src/app'; if (Test-Path -LiteralPath $d) { Set-Location -LiteralPath $d }`);
  });

  it('PowerShell: a single quote in the path is doubled (injection-safe literal)', () => {
    const script = decodeInteractivePowerShell(buildInteractiveShellCommand(dev({ name: 'w', shell: 'powershell' }), "~/o'brien")!);
    expect(script).toContain("Join-Path -Path $HOME -ChildPath 'o''brien'");
  });
});

describe('buildSshInvocation', () => {
  it('key auth uses BatchMode and no askpass env', () => {
    const { args, env } = buildSshInvocation(dev({ name: 'k', user: 'me', auth: { method: 'key' } }), ['uptime'], '/shim');
    expect(args).toContain('BatchMode=yes');
    expect(args).not.toContain('PreferredAuthentications=password');
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(args[args.length - 2]).toBe('me@k.ts.net');
    expect(args[args.length - 1]).toBe('uptime');
  });

  it('key auth passes the device identity file to every OpenSSH invocation', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'keyed', user: 'me', auth: { method: 'key', identityFile: '/keys/fleet worker' } }),
      ['uptime'],
      '/shim',
    );
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 4)).toEqual(['-i', '/keys/fleet worker', '-o', 'IdentitiesOnly=yes']);
    expect(deviceIdentityArgs(dev({ name: 'pw', auth: { method: 'password', identityFile: '/ignored' } }))).toEqual([]);
  });

  it('password auth wires the askpass shim and disables pubkey + extra prompts', () => {
    const { args, env } = buildSshInvocation(
      dev({ name: 'p', user: 'muqsit', auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' } }),
      ['hostname'],
      '/shim/askpass.sh',
    );
    expect(env.SSH_ASKPASS).toBe('/shim/askpass.sh');
    expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(env[ASKPASS_BUNDLE_ENV]).toBe('muqsit');
    expect(env[ASKPASS_KEY_ENV]).toBe('password');
    expect(args).toContain('PubkeyAuthentication=no');
    expect(args).toContain('NumberOfPasswordPrompts=1');
    expect(args).not.toContain('BatchMode=yes');
    // A normal (non-probe) connect must NOT force broker-only: an interactive
    // `agents ssh` still resolves the password via the usual TTY/headless path.
    expect(env[ASKPASS_AGENT_ONLY_ENV]).toBeUndefined();
  });

  // RUSH-1970: a read-only stats probe (the load/mem columns of `agents devices`)
  // must resolve a password bundle broker-only, so it never pops a Touch ID sheet
  // just to render a row. probeDeviceStats (health.ts) calls buildSshInvocation with
  // agentOnly:true; the askpass subprocess reads ASKPASS_AGENT_ONLY_ENV and forces
  // a broker-only resolve regardless of TTY.
  it('agentOnly stats probe of a password device forces a broker-only askpass resolve', () => {
    const { env } = buildSshInvocation(
      dev({ name: 'pinnacles', user: 'muqsit', auth: { method: 'password', bundle: 'muqsit', bundleKey: 'password' } }),
      ['uptime'],
      '/shim/askpass.sh',
      {},
      { agentOnly: true },
    );
    expect(env[ASKPASS_AGENT_ONLY_ENV]).toBe('1');
    // still the normal password wiring — the probe just adds the broker-only flag
    expect(env[ASKPASS_BUNDLE_ENV]).toBe('muqsit');
    expect(env.SSH_ASKPASS).toBe('/shim/askpass.sh');
  });

  it('agentOnly on a key-auth device is a no-op (no bundle, no broker flag)', () => {
    const { env } = buildSshInvocation(
      dev({ name: 'k', user: 'me', auth: { method: 'key' } }),
      ['uptime'],
      '/shim',
      {},
      { agentOnly: true },
    );
    expect(env[ASKPASS_AGENT_ONLY_ENV]).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
  });

  it('Windows password device wraps the command AND keeps the shim', () => {
    const { args, env } = buildSshInvocation(
      dev({ name: 'win-mini', platform: 'windows', shell: 'powershell', user: 'muqsit', auth: { method: 'password', bundle: 'muqsit' } }),
      ['hostname'],
      '/shim',
    );
    expect(decodePowerShell(args[args.length - 1])).toBe('hostname');
    expect(env.SSH_ASKPASS).toBe('/shim');
  });

  it('interactive (no command) adds -tt for a real tty', () => {
    const { args } = buildSshInvocation(dev({ name: 'i', user: 'me', auth: { method: 'key' } }), [], '/shim');
    expect(args).toContain('-tt');
    expect(args[args.length - 1]).toBe('me@i.ts.net');
  });

  it('interactive with a mirror cwd keeps -tt AND appends the cd+login-shell command (RUSH-2412)', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'ys0', user: 'muqsit', auth: { method: 'key' } }),
      [],
      '/shim',
      {},
      { interactiveCwd: '~/src/github.com/muqsitnawaz/agents-cli' },
    );
    // Still a real interactive tty …
    expect(args).toContain('-tt');
    // … dialed to user@host, then the derived mirror command as the LAST arg.
    expect(args[args.length - 2]).toBe('muqsit@ys0.ts.net');
    expect(args[args.length - 1]).toBe(`{ cd "$HOME"/src/github.com/muqsitnawaz/agents-cli || cd "$HOME"; } && exec "$SHELL" -l`);
  });

  it('interactive with a mirror cwd honors an alternate login user', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'ys0', user: 'root', auth: { method: 'key' } }),
      [],
      '/shim',
      {},
      { interactiveCwd: '~/src/app' },
    );
    expect(args[args.length - 2]).toBe('root@ys0.ts.net');
    expect(args[args.length - 1]).toBe(`{ cd "$HOME"/src/app || cd "$HOME"; } && exec "$SHELL" -l`);
  });

  it('interactive with no mirror cwd is unchanged: -tt, no remote command', () => {
    const { args } = buildSshInvocation(dev({ name: 'i', user: 'me', auth: { method: 'key' } }), [], '/shim', {}, {});
    expect(args).toContain('-tt');
    // Last arg is the target itself — no injected command.
    expect(args[args.length - 1]).toBe('me@i.ts.net');
  });

  it('an explicit command IGNORES interactiveCwd — cwd and behavior unchanged (RUSH-2412)', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'ys0', user: 'me', auth: { method: 'key' } }),
      ['uptime'],
      '/shim',
      {},
      { interactiveCwd: '~/src/app' },
    );
    // No tty forced for a command run, and the command is verbatim — no cd prefix.
    expect(args).not.toContain('-tt');
    expect(args[args.length - 1]).toBe('uptime');
  });

  it('password auth without a bundle is a hard error', () => {
    expect(() => buildSshInvocation(dev({ name: 'b', auth: { method: 'password' } }), [], '/shim')).toThrow(/no secrets bundle/);
  });

  it('learns the host key on first connect (accept-new) against the managed store', () => {
    const { args } = buildSshInvocation(dev({ name: 'k', user: 'me' }), ['uptime'], '/shim', { knownHostsFile: '/managed/kh' });
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('UserKnownHostsFile=/managed/kh');
    expect(args).not.toContain('StrictHostKeyChecking=yes');
  });

  it('verifies strictly once the host key is pinned (RUSH-1767: no silent TOFU re-accept)', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'k', user: 'me' }),
      ['uptime'],
      '/shim',
      { pinned: true, knownHostsFile: '/managed/kh' },
    );
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('UserKnownHostsFile=/managed/kh');
    expect(args).not.toContain('StrictHostKeyChecking=accept-new');
  });
});

describe('isAgentsBrowserDrive', () => {
  it('matches agents/ag browser argv and the quoted single-string form', () => {
    expect(isAgentsBrowserDrive(['agents', 'browser', 'navigate', '--url', 'https://example.com'])).toBe(true);
    expect(isAgentsBrowserDrive(['ag', 'browser', 'screenshot'])).toBe(true);
    expect(isAgentsBrowserDrive(['agents browser navigate --url https://example.com'])).toBe(true);
  });

  it('matches the standalone browser binary (cli/package.json bin.browser)', () => {
    expect(isAgentsBrowserDrive(['browser', 'navigate', '--url', 'https://evil.example'])).toBe(true);
    expect(isAgentsBrowserDrive(['browser navigate --url https://evil.example'])).toBe(true);
    expect(isAgentsBrowserDrive(['browser', 'screenshot'])).toBe(true);
  });

  it('does not match non-browser commands or an already-prefixed argv', () => {
    expect(isAgentsBrowserDrive([])).toBe(false);
    expect(isAgentsBrowserDrive(['uptime'])).toBe(false);
    expect(isAgentsBrowserDrive(['agents', 'sessions', 'list'])).toBe(false);
    expect(isAgentsBrowserDrive(['env', 'AGENTS_FLEET_REMOTE=1', 'agents', 'browser', 'start'])).toBe(false);
    expect(isAgentsBrowserDrive(['env', 'AGENTS_FLEET_REMOTE=1', 'browser', 'start'])).toBe(false);
  });
});

describe('buildSshInvocation — fleet-remote consent marker (PHNX-3065)', () => {
  // The bug: agents ssh <box> agents browser … built an ssh command whose
  // remote argv had no AGENTS_FLEET_REMOTE, so isFleetRemoteInvocation was
  // false on the peer and the consent gate returned before any check.
  it('stamps AGENTS_FLEET_REMOTE on an agents browser drive so the far-side gate can fire', () => {
    const { args, env } = buildSshInvocation(
      dev({ name: 'peer', user: 'me', auth: { method: 'key' } }),
      ['agents', 'browser', 'navigate', '--url', 'https://example.com'],
      '/shim',
    );
    // Marker stays first; actor provenance tokens (PHNX-3317 ownership) may ride
    // between it and the command, so match structurally rather than byte-exact.
    expect(args[args.length - 1]).toMatch(
      /^env AGENTS_FLEET_REMOTE=1 .*agents browser navigate --url https:\/\/example\.com$/,
    );
    // The local ssh-client overlay is askpass-only — the marker must ride the
    // remote command, not this process's env (OpenSSH does not forward it).
    expect(env.AGENTS_FLEET_REMOTE).toBeUndefined();

    const remote = args[args.length - 1] as string;
    const stamped = remote.match(/^env AGENTS_FLEET_REMOTE=(\S+) /);
    expect(stamped?.[1]).toBe('1');
    expect(() =>
      assertRemoteControlAllowed({ env: { AGENTS_FLEET_REMOTE: stamped![1] }, enabled: false }),
    ).toThrow(/remote browser control is off/);
  });

  it('without the marker the gate no-ops — that is the bypass this closes', () => {
    const { args } = buildSshInvocation(
      dev({ name: 'peer', user: 'me', auth: { method: 'key' } }),
      ['uptime'],
      '/shim',
    );
    expect(args[args.length - 1]).toBe('uptime');
    expect(args[args.length - 1]).not.toContain('AGENTS_FLEET_REMOTE');
    expect(() => assertRemoteControlAllowed({ env: {}, enabled: false })).not.toThrow();
  });

  it('marks the ag alias and the quoted single-string form', () => {
    const posix = dev({ name: 'peer', user: 'me', auth: { method: 'key' } });
    expect(buildSshInvocation(posix, ['ag', 'browser', 'screenshot'], '/shim').args.at(-1)).toMatch(
      /^env AGENTS_FLEET_REMOTE=1 .*ag browser screenshot$/,
    );
    expect(
      buildSshInvocation(posix, ['agents browser navigate --url https://example.com'], '/shim').args.at(-1),
    ).toMatch(/^env AGENTS_FLEET_REMOTE=1 .*agents browser navigate --url https:\/\/example\.com$/);
  });

  it('marks the standalone browser binary so agents ssh box browser … is gated too', () => {
    const posix = dev({ name: 'peer', user: 'me', auth: { method: 'key' } });
    expect(
      buildSshInvocation(posix, ['browser', 'navigate', '--url', 'https://evil.example'], '/shim').args.at(-1),
    ).toMatch(/^env AGENTS_FLEET_REMOTE=1 .*browser navigate --url https:\/\/evil\.example$/);
    expect(
      buildSshInvocation(posix, ['browser navigate --url https://evil.example'], '/shim').args.at(-1),
    ).toMatch(/^env AGENTS_FLEET_REMOTE=1 .*browser navigate --url https:\/\/evil\.example$/);

    const remote = buildSshInvocation(
      posix,
      ['browser', 'navigate', '--url', 'https://evil.example'],
      '/shim',
    ).args.at(-1) as string;
    const stamped = remote.match(/^env AGENTS_FLEET_REMOTE=(\S+) /);
    expect(stamped?.[1]).toBe('1');
    expect(() =>
      assertRemoteControlAllowed({ env: { AGENTS_FLEET_REMOTE: stamped![1] }, enabled: false }),
    ).toThrow(/remote browser control is off/);
  });

  it('does not mark agents sessions or an interactive login', () => {
    const posix = dev({ name: 'peer', user: 'me', auth: { method: 'key' } });
    expect(buildSshInvocation(posix, ['agents', 'sessions', 'list'], '/shim').args.at(-1)).toBe(
      'agents sessions list',
    );
    const interactive = buildSshInvocation(posix, [], '/shim');
    expect(interactive.args.at(-1)).toBe('me@peer.ts.net');
    expect(interactive.args.join(' ')).not.toContain('AGENTS_FLEET_REMOTE');
  });

  it('PowerShell dialect carries the marker inside EncodedCommand', () => {
    const { args } = buildSshInvocation(
      dev({
        name: 'win-mini',
        platform: 'windows',
        shell: 'powershell',
        user: 'me',
        auth: { method: 'key' },
      }),
      ['agents', 'browser', 'screenshot'],
      '/shim',
    );
    expect(decodePowerShell(args[args.length - 1] as string)).toMatch(
      /^\$env:AGENTS_FLEET_REMOTE='1'; .*agents browser screenshot$/,
    );
  });

  it('does not double-prefix a command the --device fan-out already marked', () => {
    const posix = dev({ name: 'peer', user: 'me', auth: { method: 'key' } });
    // Fan-out already stamped the marker; a fixed actor keeps the argv deterministic.
    const already = markFleetRemote(['agents', 'browser', 'start'], posix, {
      AGENTS_ACTOR: 'claude@yosemite-m1',
      AGENTS_ACTOR_KIND: 'agent',
    });
    const { args } = buildSshInvocation(posix, already, '/shim');
    // The marker is not doubled (guard keys on the first token), and the already
    // present actor is not re-stamped either.
    expect(args.at(-1)).toBe(
      'env AGENTS_FLEET_REMOTE=1 AGENTS_ACTOR=claude@yosemite-m1 AGENTS_ACTOR_KIND=agent agents browser start',
    );
    expect((args.at(-1) as string).match(/AGENTS_FLEET_REMOTE/g)).toHaveLength(1);
    expect((args.at(-1) as string).match(/AGENTS_ACTOR=/g)).toHaveLength(1);
  });

  it('forwards the caller actor so a task created over `agents ssh` is owned by the real caller, not UNRESOLVED@host (PHNX-3317)', () => {
    const posix = dev({ name: 'peer', user: 'me', auth: { method: 'key' } });
    const marked = markFleetRemote(['agents', 'browser', 'start'], posix, {
      AGENTS_ACTOR: 'claude@yosemite-m1',
      AGENTS_ACTOR_KIND: 'agent',
      AGENTS_ACTOR_NAME: 'Muqsit Nawaz',
    });
    // Marker first (consent gate + idempotency guard key on it), then the actor
    // env, then the command. A value with a space is shell-quoted so wrapRemoteCommand's
    // naive join stays one word on the remote shell.
    expect(marked).toEqual([
      'env',
      'AGENTS_FLEET_REMOTE=1',
      'AGENTS_ACTOR=claude@yosemite-m1',
      'AGENTS_ACTOR_KIND=agent',
      "'AGENTS_ACTOR_NAME=Muqsit Nawaz'",
      'agents',
      'browser',
      'start',
    ]);

    // PowerShell dialect exports each var as its own $env: statement.
    const win = markFleetRemote(['agents', 'browser', 'start'], { shell: 'powershell' }, {
      AGENTS_ACTOR: 'claude@yosemite-m1',
      AGENTS_ACTOR_KIND: 'agent',
    });
    expect(win).toEqual([
      "$env:AGENTS_FLEET_REMOTE='1';",
      "$env:AGENTS_ACTOR='claude@yosemite-m1';",
      "$env:AGENTS_ACTOR_KIND='agent';",
      'agents',
      'browser',
      'start',
    ]);
  });
});

describe('buildAskpassShimBody', () => {
  // The bug (#password-auth-on-standalone): the shim used to be hand-rolled from
  // `[process.execPath, process.argv[1], …]`. On a Bun standalone binary
  // process.argv[1] is the virtual embedded entry `/$bunfs/root/agents`, so the
  // shim ran `<binary> /$bunfs/root/agents ssh __askpass`; the CLI saw the
  // virtual path as a subcommand, died with `unknown command '/$bunfs/root/agents'`,
  // printed nothing, and handed ssh an EMPTY password -> Permission denied on
  // every password-auth device. The shim must never carry a /$bunfs path, and
  // must exec the launch argv resolved by getCliLaunch.
  it('standalone binary launch: execs the physical binary, never the /$bunfs virtual entry', () => {
    // getCliLaunch on a standalone build returns { command: <physical binary>, args: ['ssh','__askpass'] }.
    const body = buildAskpassShimBody({ command: '/opt/agents/bin/agents', args: ['ssh', '__askpass'] });
    expect(body).not.toContain('/$bunfs');
    expect(body).toContain("exec /opt/agents/bin/agents ssh __askpass");
    expect(body.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('JS/dev build launch: execs node with the real entry script', () => {
    // getCliLaunch on a JS install returns { command: node, args: [entry,'ssh','__askpass'] }.
    const body = buildAskpassShimBody({ command: '/usr/bin/node', args: ['/app/dist/index.js', 'ssh', '__askpass'] });
    expect(body).not.toContain('/$bunfs');
    expect(body).toContain("exec /usr/bin/node /app/dist/index.js ssh __askpass");
  });

  it('shell-quotes every argv element (paths with spaces stay one word)', () => {
    const body = buildAskpassShimBody({ command: '/opt/my agents/agents', args: ['ssh', '__askpass'] });
    expect(body).toContain("exec '/opt/my agents/agents' ssh __askpass");
  });

  it('default (no arg) resolves through getCliLaunch — never leaks a /$bunfs entry', () => {
    // Whatever the running shape, the real getCliLaunch must not emit a virtual entry.
    const body = buildAskpassShimBody();
    expect(body).not.toContain('/$bunfs');
    expect(body).toMatch(/\bssh __askpass\n$/);
  });
});
