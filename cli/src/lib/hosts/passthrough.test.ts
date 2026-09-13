import { describe, it, expect, afterEach, vi } from 'vitest';
import { flagValue, maybeRunOnHost, maybeRunStandaloneOnHost, passthroughSshOptions, runFleetPassthrough, buildPassthroughForwardedArgs, renderForwardDecision, OWN_HOST_COMMANDS } from './passthrough.js';
import { machineId } from '../session/sync/config.js';
import type { DeviceProfile, DeviceRegistry } from '../devices/registry.js';

function fakeDevice(name: string, platform: DeviceProfile['platform'], overrides?: Partial<DeviceProfile>): DeviceProfile {
  return {
    name,
    platform,
    shell: platform === 'windows' ? 'powershell' : 'posix',
    address: { via: 'tailscale', dnsName: `${name}.tail.ts.net` },
    auth: { method: 'key' },
    tailscale: { online: true, direct: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeRegistry(devices: DeviceProfile[]): DeviceRegistry {
  return Object.fromEntries(devices.map((d) => [d.name, d]));
}

it('pins the configured identity for --device passthrough streams', () => {
  expect(passthroughSshOptions({ name: 'win-mini', target: 'muqsit@win-mini', identityFile: '/keys/fleet' }, true)).toEqual({
    tty: true,
    multiplex: true,
    extraSshArgs: ['-i', '/keys/fleet', '-o', 'IdentitiesOnly=yes'],
  });
});

describe('buildPassthroughForwardedArgs — sync status does not inherit --yes', () => {
  it('appends --yes to umbrella sync when non-interactive', () => {
    expect(buildPassthroughForwardedArgs('sync', ['sync', '--device', 'peer'], false)).toEqual(['sync', '--yes']);
  });

  it('does not append --yes to sync status when non-interactive (RUSH-2864)', () => {
    expect(buildPassthroughForwardedArgs('sync', ['sync', 'status', '--device', 'peer'], false)).toEqual(['sync', 'status']);
    expect(buildPassthroughForwardedArgs('sync', ['sync', 'status', '--no-tty', '--device', 'peer'], false)).toEqual(['sync', 'status']);
    // Routing flags between group and subcommand must not hide `status`.
    expect(buildPassthroughForwardedArgs('sync', ['sync', '--device', 'peer', 'status'], false)).toEqual(['sync', 'status']);
    expect(buildPassthroughForwardedArgs('sync', ['sync', '-D', 'peer', 'status'], false)).toEqual(['sync', 'status']);
  });

  it('keeps an explicit --yes on sync status', () => {
    expect(buildPassthroughForwardedArgs('sync', ['sync', 'status', '--yes', '--device', 'peer'], false)).toEqual(['sync', 'status', '--yes']);
  });

  it('does not append --yes when interactive', () => {
    expect(buildPassthroughForwardedArgs('sync', ['sync', '--device', 'peer'], true)).toEqual(['sync']);
    expect(buildPassthroughForwardedArgs('sync', ['sync', 'status', '--device', 'peer'], true)).toEqual(['sync', 'status']);
  });
});

describe('renderForwardDecision — read-only renders forward over a pipe, not a PTY (RUSH-3389)', () => {
  const tty = { isTTY: true, noTty: false, columns: 120, rows: 40 };

  it('chooses no PTY and forces color + geometry for view from a real terminal', () => {
    // The bug: `agents view --device X` under ssh -tt vanishes on clean exit. The
    // fix forwards over a pipe and injects FORCE_COLOR/COLUMNS/LINES so the piped
    // remote (isTTY=false) still renders colored and correctly wrapped.
    expect(renderForwardDecision('view', ['view', 'claude', '--device', 'yosemite-s0'], tty)).toEqual({
      noPty: true,
      env: { FORCE_COLOR: '1', COLUMNS: '120', LINES: '40' },
    });
  });

  it('drops FORCE_COLOR under --json so machine output is never tainted', () => {
    expect(renderForwardDecision('view', ['view', 'claude', '--device', 'x', '--json'], tty)).toEqual({
      noPty: true,
      env: { COLUMNS: '120', LINES: '40' },
    });
  });

  it('applies to the other pure renders too (inspect / insights / doctor)', () => {
    for (const cmd of ['inspect', 'insights', 'doctor']) {
      expect(renderForwardDecision(cmd, [cmd, '--device', 'x'], tty).noPty).toBe(true);
    }
  });

  it('keeps the PTY for view --prune (interactive confirm) but not with --yes/--dry-run', () => {
    expect(renderForwardDecision('view', ['view', '--prune', '--device', 'x'], tty).noPty).toBe(false);
    expect(renderForwardDecision('view', ['view', '--prune', '--yes', '--device', 'x'], tty).noPty).toBe(true);
    expect(renderForwardDecision('view', ['view', '--prune', '-y', '--device', 'x'], tty).noPty).toBe(true);
    expect(renderForwardDecision('view', ['view', '--prune', '--dry-run', '--device', 'x'], tty).noPty).toBe(true);
  });

  it('keeps the PTY for a routable NON-render command (teams) — pickers must survive', () => {
    expect(renderForwardDecision('teams', ['teams', 'status', '--device', 'x'], tty).noPty).toBe(false);
    expect(renderForwardDecision('config', ['config', '--device', 'x'], tty).noPty).toBe(false);
  });

  it('does nothing when there is no local terminal (already on the working pipe path)', () => {
    // A genuinely piped local run already streams cleanly and wants no forced
    // color/geometry — the no-PTY path is only about undoing the forced -tt.
    expect(renderForwardDecision('view', ['view', '--device', 'x'], { isTTY: false, noTty: false })).toEqual({ noPty: false });
    expect(renderForwardDecision('view', ['view', '--device', 'x'], { isTTY: true, noTty: true })).toEqual({ noPty: false });
  });

  it('omits COLUMNS/LINES when the terminal reports no geometry', () => {
    expect(renderForwardDecision('view', ['view', '--device', 'x'], { isTTY: true, noTty: false })).toEqual({
      noPty: true,
      env: { FORCE_COLOR: '1' },
    });
  });
});

describe('flagValue', () => {
  it('reads the space-separated long form', () => {
    expect(flagValue(['view', '--device', 'mac'], 'device', 'D')).toBe('mac');
  });
  it('reads the --device=value form', () => {
    expect(flagValue(['view', '--device=mac'], 'device', 'D')).toBe('mac');
  });
  it('reads the -D value and glued -Dmac forms', () => {
    expect(flagValue(['view', '-D', 'mac'], 'device', 'D')).toBe('mac');
    expect(flagValue(['view', '-Dmac'], 'device', 'D')).toBe('mac');
  });
  it('reads --remote-cwd (long-only, no short)', () => {
    expect(flagValue(['sync', '--remote-cwd', '/srv'], 'remote-cwd')).toBe('/srv');
  });
  it('returns undefined when absent', () => {
    expect(flagValue(['view', '--json'], 'device', 'D')).toBeUndefined();
  });
});

describe('maybeRunOnHost — local short-circuits (no SSH attempted)', () => {
  const originalArgv = process.argv.slice();

  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    process.argv = originalArgv.slice();
    process.exitCode = 0;
  });

  it('falls through for OWN_HOST commands (secrets owns its --device)', async () => {
    expect(await maybeRunOnHost('secrets', ['secrets', 'list', '--device', 'mac'])).toBe(false);
  });

  it('leaves feed host lists to the command-level fleet aggregator', async () => {
    expect(await maybeRunOnHost('feed', ['feed', '--device', 'mac', '--json'])).toBe(false);
  });

  it('rejects --device on a non-routable, non-OWN_HOST group with a clear error (not unknown option)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // setup has no remote semantics and no own-device handler — must not fall
    // through to commander (which would print "unknown option '--device'").
    expect(await maybeRunOnHost('setup', ['setup', '--device', 'mac'])).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('falls through for an UNKNOWN command so commander reports it (RUSH-2022)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // `session` is a typo for the very much device-routable `sessions`. The router
    // runs before commander parses, so claiming "does not support --device" here
    // both invents a command and states the opposite of the truth for the one
    // the user meant. It must decline and let `unknown command 'session'` win.
    expect(await maybeRunOnHost('session', ['session', 'resume', '--device', 'mac'])).toBe(false);
    expect(process.exitCode).toBe(0);
    expect(await maybeRunOnHost('zzzznotacommand', ['zzzznotacommand', '--device', 'mac'])).toBe(false);
    expect(process.exitCode).toBe(0);
  });

  it('still rejects --device on a REAL command that has no remote semantics', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // The unknown-command gate above must not weaken this: `menubar` exists, so
    // the flag-support error is the correct, honest answer.
    expect(await maybeRunOnHost('menubar', ['menubar', '--device', 'mac'])).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('returns false when no --device is given', async () => {
    expect(await maybeRunOnHost('view', ['view', 'claude'])).toBe(false);
  });

  it('returns false when no routing flag is given', async () => {
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi'])).toBe(false);
  });

  it('returns false when --device names this very machine (runs locally instead)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(machineId()).toBe('mybox');
    process.argv = ['node', 'agents', 'view', '--device', 'mybox'];
    expect(await maybeRunOnHost('view', ['view', '--device', 'mybox'])).toBe(false);
    // Self-device strips routing flags so local commander never sees them.
    expect(process.argv).toEqual(['node', 'agents', 'view']);
    // case-insensitive: the self-check must not SSH to `MyBox` either
    process.argv = ['node', 'agents', 'view', '--device', 'MyBox'];
    expect(await maybeRunOnHost('view', ['view', '--device', 'MyBox'])).toBe(false);
  });

  it('short-circuits to a local run when --device names this machine (no SSH to itself)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --device naming this machine must short-circuit to a local run — must not SSH to itself.
    process.argv = ['node', 'agents', 'message', 'abc', 'hi', '--device', 'mybox'];
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--device', 'mybox'])).toBe(false);
    expect(process.argv).toEqual(['node', 'agents', 'message', 'abc', 'hi']);
    process.argv = ['node', 'agents', 'message', 'abc', 'hi', '--device=mybox'];
    expect(await maybeRunOnHost('message', ['message', 'abc', 'hi', '--device=mybox'])).toBe(false);
  });

  it('resolves `auto` to a local pick and runs locally, not a self-SSH (RUSH-2185)', async () => {
    // AGENTS_DEVICES_DIR is fork-private and empty (tests/setup.ts) and this
    // machine id has no session history, so resolveDeviceAffinity's only
    // eligible candidate is this machine — a deterministic "picked local"
    // outcome without needing to inject the resolver.
    process.env.AGENTS_SYNC_MACHINE_ID = 'auto-passthrough-test-box';
    process.argv = ['node', 'agents', 'view', '--device', 'auto'];
    expect(await maybeRunOnHost('view', ['view', '--device', 'auto'])).toBe(false);
    // Routing flags stripped exactly like the explicit self-device short-circuit —
    // proves the command runs locally rather than resolving to a real device and
    // SSHing to itself (the bug this test guards: `auto` used to reach
    // resolveTargetHost('auto', ...) unresolved, either self-SSHing when this
    // box happened to be a registered device, or dialing a literal device named
    // "auto" when it wasn't).
    expect(process.argv).toEqual(['node', 'agents', 'view']);
  });

  it('routes repos/repo --device to a non-self target (the RUSH-1691 repro path)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // Invalid target rejected by assertValidSshTarget before SSH — proves
    // repos is in REMOTE_PASSTHROUGH (previously fell through → unknown option).
    for (const cmd of ['repos', 'repo'] as const) {
      const result = await maybeRunOnHost(cmd, [cmd, 'list', '--device', '--evil']);
      expect(result).toBe(true);
      expect(process.exitCode).toBeGreaterThan(0);
      process.exitCode = 0;
    }
  });

  it('falls through for OWN_HOST multi-host aggregators (sessions/feed handle --device themselves)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // sessions/feed handle --device internally — must not be intercepted here.
    expect(await maybeRunOnHost('sessions', ['sessions', '--active', '--device', 'a'])).toBe(false);
    expect(await maybeRunOnHost('feed', ['feed', '--device', 'a', '--json'])).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('falls through for browser — --device is bound at start, not routed here', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('browser', ['browser', 'start', '--device', 'zion'])).toBe(false);
    expect(await maybeRunOnHost('browser', ['browser', 'screenshot', '--device', 'zion'])).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('routes routines --device to a non-self target (rejected by assertValidSshTarget)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --evil starts with '-' so assertValidSshTarget rejects it before any
    // SSH connection is attempted. Returning true with exitCode > 0 proves
    // the routing path was entered, not short-circuited.
    const result = await maybeRunOnHost('routines', ['routines', 'list', '--device', '--evil']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('routes routines --device alias to a non-self target', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    const result = await maybeRunOnHost('routines', ['routines', 'run', 'x', '--device', '--evil']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('does NOT bail on --devices for routines with --device (placement, not fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on routines is placement; --device should still route remotely.
    // The invalid target is rejected by assertValidSshTarget (returns true,
    // exitCode > 0), proving --devices did not bail.
    const result = await maybeRunOnHost('routines', ['routines', 'add', 'x', '--device', '--evil', '--devices', 'a,b']);
    expect(result).toBe(true);
    expect(process.exitCode).toBeGreaterThan(0);
    process.exitCode = 0;
  });

  it('bails on --devices for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    // --devices on a non-routines command triggers the fleet-flag bailout,
    // returning false even with a non-self --device.
    expect(await maybeRunOnHost('list', ['list', '--device', '--evil', '--devices'])).toBe(false);
  });

  it('bails on --hosts for non-routines commands (fan-out)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('list', ['list', '--device', '--evil', '--hosts'])).toBe(false);
  });

  it('bails on --hosts for routines too (generic fleet flag, not placement)', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('routines', ['routines', 'list', '--device', '--evil', '--hosts'])).toBe(false);
  });

  it('rejects --device all on a non-routable command with a clear error', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    const result = await maybeRunOnHost('setup', ['setup', '--device', 'all']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});

describe('maybeRunOnHost — fleet `all` sentinel (injected runners)', () => {
  const originalArgv = process.argv.slice();
  const logs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    process.argv = originalArgv.slice();
    process.exitCode = 0;
    logs.length = 0;
    console.log = originalLog;
  });

  function captureLogs() {
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
  }

  function makeRunner(responses: Record<string, { code: number | null; stdout: string; stderr: string }>) {
    return (device: DeviceProfile, cmd: string[]) => {
      const key = cmd.slice(0, 2).join(' '); // e.g. "agents view"
      const hit = responses[`${device.name}:${key}`] ?? responses[device.name] ?? { code: 0, stdout: '[]', stderr: '' };
      return hit;
    };
  }

  function makeLocalRunner(response: { code: number | null; stdout: string; stderr: string } = { code: 0, stdout: '[]', stderr: '' }) {
    return () => response;
  }

  it('fans out view across every device with --device all', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([
      fakeDevice('zion', 'macos'),
      fakeDevice('mac-mini', 'macos'),
      fakeDevice('yosemite-s0', 'linux'),
    ]);
    const runner = makeRunner({
      'mac-mini:agents view': { code: 0, stdout: JSON.stringify([{ agent: 'kimi', versions: [{ version: '0.4.2', isDefault: true, signedIn: true, email: 'trp.so' }] }]), stderr: '' },
      'yosemite-s0:agents view': { code: 0, stdout: JSON.stringify([{ agent: 'kimi', versions: [{ version: '0.4.1', isDefault: true, signedIn: true, email: 'trp.so' }] }]), stderr: '' },
    });
    const localRunner = makeLocalRunner({
      code: 0,
      stdout: JSON.stringify([{ agent: 'kimi', versions: [{ version: '0.4.3', isDefault: true, signedIn: true, email: 'trp.so' }] }]),
      stderr: '',
    });

    const result = await maybeRunOnHost('view', ['view', 'kimi', '--device', 'all'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner,
    });

    expect(result).toBe(true);
    const output = logs.join('\n');
    expect(output).toContain('view kimi');
    expect(output).toContain('macOS');
    expect(output).toContain('Linux');
    expect(output).toContain('zion');
    expect(output).toContain('mac-mini');
    expect(output).toContain('yosemite-s0');
    expect(output).toContain('← this machine');
  });

  it('fans out with --devices all and --hosts all too', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = makeRunner({ 'mac-mini:agents view': { code: 0, stdout: '[]', stderr: '' } });

    for (const flag of ['--devices all', '--hosts all']) {
      logs.length = 0;
      const [f, v] = flag.split(' ');
      const result = await maybeRunOnHost('view', ['view', f, v], {
        self: 'zion',
        loadDevices: async () => registry,
        runner,
        localRunner: makeLocalRunner(),
      });
      expect(result).toBe(true);
      expect(logs.join('\n')).toContain('mac-mini');
    }
  });

  it('renders offline / no-address devices as skipped rows, never a hang', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([
      fakeDevice('zion', 'macos', { tailscale: { online: true, direct: true } }),
      fakeDevice('pinnacles', 'macos', { tailscale: { online: false, direct: false } }),
      fakeDevice('headless', 'linux', { address: { via: 'manual' } }), // no dns/ip → no-address
    ]);

    const result = await maybeRunOnHost('view', ['view', 'kimi', '--device', 'all'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner: makeRunner({}),
      localRunner: makeLocalRunner({ code: 0, stdout: '[]', stderr: '' }),
    });

    expect(result).toBe(true);
    const output = logs.join('\n');
    expect(output).toContain('pinnacles');
    expect(output).toContain('headless');
    expect(output).toMatch(/offline|no address/);
  });

  it('emits a device-keyed JSON object under --json', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([fakeDevice('zion', 'macos'), fakeDevice('mac-mini', 'macos')]);
    // Remote `agents view <agent> --json` returns a single object, not an array.
    const remotePayload = { agent: 'kimi', versions: [{ version: '0.4.2', isDefault: true, signedIn: false, email: null }], profiles: [] };
    const runner = makeRunner({ 'mac-mini:agents view': { code: 0, stdout: JSON.stringify(remotePayload), stderr: '' } });

    const result = await maybeRunOnHost('view', ['view', 'kimi', '--device', 'all', '--json'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner: makeLocalRunner({ code: 0, stdout: '[]', stderr: '' }),
    });

    expect(result).toBe(true);
    const parsed = JSON.parse(logs[0]);
    expect(parsed['mac-mini']).toEqual(remotePayload);
    expect(parsed.zion).toEqual([]);
  });

  it('still bails on non-all --devices for non-routines commands', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    expect(await maybeRunOnHost('view', ['view', '--devices', 'mac1,mac2'])).toBe(false);
  });

  it('fans out --devices all on routines too', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    captureLogs();
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = makeRunner({ 'mac-mini:agents routines': { code: 0, stdout: '[]', stderr: '' } });

    const result = await maybeRunOnHost('routines', ['routines', 'list', '--devices', 'all'], {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner: makeLocalRunner({ code: 0, stdout: '[]', stderr: '' }),
    });

    expect(result).toBe(true);
    expect(logs.join('\n')).toContain('mac-mini');
  });

});

describe('runFleetPassthrough — direct unit tests', () => {
  const logs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    logs.length = 0;
    console.log = originalLog;
    process.exitCode = 0;
    delete process.env.AGENTS_SYNC_MACHINE_ID;
  });

  it('uses the output summarizer for insights output command', async () => {
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = (_device: DeviceProfile, cmd: string[]) => {
      if (cmd[1] === 'insights' && cmd[2] === 'output') {
        return {
          code: 0,
          stdout: JSON.stringify({
            machine: 'mac-mini',
            pricingVersion: '2026-01',
            since: '7d',
            burn: { costUsd: 12.5, outputTokens: 3400, tokenCount: 12000, sessionCount: 5, durationMs: 360000 },
            output: { commits: 3, commitShas: [], prsOpened: 0, prsMerged: 0, reposScanned: 2, ghAvailable: true, authors: [], logins: [] },
            breakdown: { by: 'agent', rows: [] },
            uncostedAgents: [],
          }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };

    await runFleetPassthrough(
      'insights',
      ['insights', 'output', '--device', 'all'],
      {},
      {
        self: 'zion',
        loadDevices: async () => registry,
        runner,
        localRunner: () => ({ code: 0, stdout: '{}', stderr: '' }),
      },
    );

    const output = logs.join('\n');
    expect(output).toContain('mac-mini');
    expect(output).toContain('$12.50 burned');
    expect(output).toContain('3.4K output tokens');
  });

  it('uses the sync summarizer for sync command', async () => {
    // RUSH-2700: this is the WIRING test. An earlier revision called
    // summarizeSyncResult directly, so deleting the `command === 'sync'` line in
    // summarizeResult restored the exact bug (every box rendering a flat `ok`)
    // with no test failing. This drives the real fan-out instead, so the roster
    // must actually dispatch to the summarizer; the describe block below was
    // rewritten the same way for the same reason.
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    const runner = (_device: DeviceProfile, cmd: string[]) => {
      if (cmd[1] === 'sync') {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: false,
            mode: 'umbrella',
            reconciled: true,
            declined: ['Copilot@1.0.0: mcp: github: cannot write MCP config: copilot: schema not verified'],
          }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };

    await runFleetPassthrough(
      'sync',
      ['sync', '--device', 'all'],
      {},
      {
        self: 'zion',
        loadDevices: async () => registry,
        runner,
        localRunner: () => ({ code: 0, stdout: '{}', stderr: '' }),
      },
    );

    const output = logs.join('\n');
    expect(output).toContain('mac-mini');
    expect(output).toContain('1 not written');
  });

  it('marks a remote fan-out target with AGENTS_FLEET_REMOTE, but never the self target', async () => {
    console.log = () => {};
    const registry = fakeRegistry([fakeDevice('zion', 'macos'), fakeDevice('mac-mini', 'macos')]);
    const remoteCmds: string[][] = [];
    const selfCmds: string[][] = [];
    const runner = (_d: DeviceProfile, cmd: string[]) => {
      remoteCmds.push(cmd);
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const localRunner = (cmd: string[]) => {
      selfCmds.push(cmd);
      return { code: 0, stdout: '{}', stderr: '' };
    };

    await runFleetPassthrough('browser', ['browser', 'start', '--device', 'all'], {}, {
      self: 'zion',
      loadDevices: async () => registry,
      runner,
      localRunner,
    });

    // The remote (mac-mini) target is driven WITH the fleet-remote marker so its
    // consent gate can fire; the self (zion) target runs locally and stays ungated.
    expect(remoteCmds).toHaveLength(1);
    // Marker leads; actor provenance tokens may ride between it and the command,
    // which is preserved intact at the tail.
    expect(remoteCmds[0].slice(0, 2)).toEqual(['env', 'AGENTS_FLEET_REMOTE=1']);
    expect(remoteCmds[0].slice(-4)).toEqual(['agents', 'browser', 'start', '--json']);
    expect(selfCmds).toHaveLength(1);
    expect(selfCmds[0][0]).toBe('agents');
    expect(selfCmds[0]).not.toContain('AGENTS_FLEET_REMOTE=1');
  });
});

// The standalone `browser` binary (dist/browser.js) never enters index.ts.
// Browser owns `--device` (start binds the task; later verbs reject it), so
// maybeRunStandaloneOnHost must leave the flag on argv except for --help.
describe('maybeRunStandaloneOnHost — standalone binary --device routing (RUSH-2214 / T3)', () => {
  const originalArgv = process.argv.slice();

  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    process.argv = originalArgv.slice();
    process.exitCode = 0;
  });

  it('leaves argv untouched and runs locally when no routing flag is present', async () => {
    process.argv = ['node', 'browser', 'screenshot', '--json'];
    expect(await maybeRunStandaloneOnHost('browser')).toBe(false);
    // No synthetic command token injected, no flag stripped — the local commander
    // program sees exactly what the user typed.
    expect(process.argv).toEqual(['node', 'browser', 'screenshot', '--json']);
  });

  it('leaves --device on argv for start so the command can bind the task', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    process.argv = ['node', 'browser', 'start', '--device', 'zion'];
    expect(await maybeRunStandaloneOnHost('browser')).toBe(false);
    expect(process.argv).toEqual(['node', 'browser', 'start', '--device', 'zion']);
  });

  it('leaves --device on argv for a page verb so the command can reject it', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    process.argv = ['node', 'browser', 'screenshot', '--device', 'zion'];
    expect(await maybeRunStandaloneOnHost('browser')).toBe(false);
    expect(process.argv).toEqual(['node', 'browser', 'screenshot', '--device', 'zion']);
  });

  it('keeps --help local but strips the routing flags so commander parses', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'mybox';
    process.argv = ['node', 'browser', '--device', 'otherbox', '--help'];
    expect(await maybeRunStandaloneOnHost('browser')).toBe(false);
    expect(process.argv).toEqual(['node', 'browser', '--help']);
  });
});

/**
 * RUSH-2700: `agents sync --device all` injects `--json` per peer and gets back
 * the corrected `ok` / `declined`, but the roster rendered a flat `ok`
 * regardless — so every box showed green even where a harness's config was
 * never written. That is the fleet-wide silent success the ticket exists to
 * remove, one layer above where the payload was fixed.
 */
describe('sync fan-out roster surfaces a refused write', () => {
  // Driven through the real fan-out, never by calling the summarizer directly:
  // a direct call cannot tell whether `summarizeResult` actually dispatches to
  // it, which is how the first version of these tests stayed green with the
  // wiring deleted.
  async function syncRoster(payload: unknown): Promise<string> {
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.join(' '));
    const registry = fakeRegistry([fakeDevice('mac-mini', 'macos')]);
    await runFleetPassthrough(
      'sync',
      ['sync', '--device', 'all'],
      {},
      {
        self: 'zion',
        loadDevices: async () => registry,
        runner: (_d: DeviceProfile, cmd: string[]) =>
          cmd[1] === 'sync'
            ? { code: 0, stdout: JSON.stringify(payload), stderr: '' }
            : { code: 1, stdout: '', stderr: 'unexpected' },
        localRunner: () => ({ code: 0, stdout: '{}', stderr: '' }),
      },
    );
    return captured.join('\n');
  }

  it('reports the count for an umbrella payload', async () => {
    const out = await syncRoster({
      mode: 'umbrella',
      ok: false,
      declined: ['Copilot@1.0.0: mcp: github: cannot write MCP config: copilot: ...'],
    });
    expect(out).toContain('1 not written');
  });

  it('reports the count across versions for an agent-all payload', async () => {
    const out = await syncRoster({
      mode: 'agent-all',
      ok: false,
      versions: [
        { version: '1.0.0', declined: ['mcp: a: cannot write MCP config: copilot: ...'] },
        { version: '1.1.0', declined: ['mcp: b: cannot write MCP config: copilot: ...'] },
      ],
    });
    expect(out).toContain('2 not written');
  });

  it('stays ok when nothing was refused', async () => {
    expect(await syncRoster({ mode: 'umbrella', ok: true, declined: [] })).not.toContain('not written');
    expect(await syncRoster({ mode: 'agent-all', ok: true, versions: [{ declined: [] }] })).not.toContain('not written');
  });

  it('stays ok for a peer whose payload predates the field', async () => {
    // An older agents-cli on the far side sends no `declined`; the roster must
    // render as before rather than throw.
    expect(await syncRoster({ mode: 'umbrella', ok: true })).not.toContain('not written');
    expect(await syncRoster(null)).not.toContain('not written');
  });
});

// PHNX-4090: computer/browser/secrets each resolve --device to the standalone
// engine's own --host address grammar (no fleet registry on that side) — a
// regression here would route --device through the generic SSH passthrough
// instead, which knows nothing about vnc://, tcp://, or the engine's argv shape.
describe('OWN_HOST_COMMANDS keeps computer/browser/secrets local', () => {
  it('lists computer, browser and secrets so their own --device handling runs', () => {
    expect(OWN_HOST_COMMANDS.has('computer')).toBe(true);
    expect(OWN_HOST_COMMANDS.has('browser')).toBe(true);
    expect(OWN_HOST_COMMANDS.has('secrets')).toBe(true);
  });

  it('does NOT list view — `agents view --device <name>` still SSHes the whole command, not a --host rewrite', () => {
    expect(OWN_HOST_COMMANDS.has('view')).toBe(false);
  });
});
