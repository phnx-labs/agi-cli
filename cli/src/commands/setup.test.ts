import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// Isolate HOME before importing modules that capture path constants at import.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-setup-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { getSetupStatus, registerSetupCommand, runSetup, runSetupHub } = await import('./setup.js');

describe('agents setup command group', () => {
  it('registers the browser/computer/fleet/mine/secrets/accounts/alias/beta capability subcommands', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    const subs = setup!.commands.map((c) => c.name()).sort();
    // `share` is deliberately absent: artifact sharing moved out to the standalone
    // `artifacts` CLI (PHNX-3992), so the `share` phase is gone from the hub too.
    // `url-scheme` is the agents:// OS deep-link handler home (PHNX-3949).
    expect(subs).toEqual(['accounts', 'alias', 'beta', 'browser', 'computer', 'fleet', 'mine', 'secrets', 'status', 'term', 'url-scheme', 'watchdog']);
  });

  it('keeps the bare `setup` command with its force / no-system-repo flags', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup')!;
    const flags = setup.options.map((o) => o.long).sort();
    expect(flags).toContain('--force');
    expect(flags).toContain('--no-system-repo');
  });

  it('reports real ready/missing rows after core setup already exists', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });

    const rows = await getSetupStatus();
    expect(rows.find((row) => row.phase === 'core')).toMatchObject({ state: 'ready', detail: 'system repo ready' });
    expect(rows.find((row) => row.phase === 'browser')?.state).toBe('missing');
    expect(rows.find((row) => row.phase === 'computer')).toBeDefined();
    expect(rows.map((row) => row.phase)).toEqual([
      'core', 'browser', 'computer', 'secrets', 'term', 'accounts', 'fleet', 'watchdog', 'preferences',
    ]);
  });

  it('re-enters the onboarding hub instead of returning when core is configured', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let hubRuns = 0;
    await runSetup(new Command(), { runHub: async () => { hubRuns += 1; } });
    expect(hubRuns).toBe(1);
  });

  it('starts the daemon on first setup / --force when daemon.enabled', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let starts = 0;
    await runSetup(new Command(), {
      force: true,
      systemRepo: false,
      suppressFooter: true,
      isDaemonEnabledFn: () => true,
      startDaemonFn: () => {
        starts += 1;
        return { pid: 99, method: 'detached' };
      },
    });
    expect(starts).toBe(1);
  });

  it('does not start the daemon on setup when daemon.enabled=false', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let starts = 0;
    await runSetup(new Command(), {
      force: true,
      systemRepo: false,
      suppressFooter: true,
      isDaemonEnabledFn: () => false,
      startDaemonFn: () => {
        starts += 1;
        return { pid: 99, method: 'detached' };
      },
    });
    expect(starts).toBe(0);
  });

  it('does not start the daemon when re-entering the hub without --force', async () => {
    const systemRepo = path.join(TEST_HOME, '.agents', '.system');
    fs.mkdirSync(systemRepo, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: systemRepo });
    let starts = 0;
    await runSetup(new Command(), {
      runHub: async () => {},
      startDaemonFn: () => {
        starts += 1;
        return { pid: 99, method: 'detached' };
      },
    });
    expect(starts).toBe(0);
  });

  it('re-enters the hub, runs a selected wizard seam, then refreshes status', async () => {
    const selected: string[] = [];
    let promptCount = 0;
    await runSetupHub({
      interactive: true,
      selectPhase: async () => (promptCount++ === 0 ? 'browser' : 'exit'),
      runPhase: async (phase) => { selected.push(phase); },
    });
    expect(selected).toEqual(['browser']);
    expect(promptCount).toBe(2);
  });

  it('is ready when the Browser CLI is installed and a default profile is configured', async () => {
    // Readiness is config + standalone presence now (PHNX-4101): the engine owns
    // profile declarations and launchability. BROWSER_BIN points at a resolvable
    // executable so `browserInstalled()` is true deterministically.
    const { setConfigValue } = await import('../lib/device-config.js');
    const prevBin = process.env.BROWSER_BIN;
    process.env.BROWSER_BIN = process.execPath;
    try {
      const { _resetBrowserClientForTest } = await import('../lib/browser-client.js');
      _resetBrowserClientForTest();
      setConfigValue('browser.profile', 'work');
      const rows = await getSetupStatus();
      expect(rows.find((row) => row.phase === 'browser')).toMatchObject({ state: 'ready', detail: 'profile work' });
    } finally {
      if (prevBin === undefined) delete process.env.BROWSER_BIN;
      else process.env.BROWSER_BIN = prevBin;
      const { _resetBrowserClientForTest } = await import('../lib/browser-client.js');
      _resetBrowserClientForTest();
    }
  });

  it('prints status, returns without prompting, and exits nonzero for missing phases outside a TTY', async () => {
    let selected = false;
    try {
      await runSetupHub({
        interactive: false,
        selectPhase: async () => { selected = true; return 'exit'; },
      });
      expect(selected).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
  });
});

describe('agents setup secrets', () => {
  // `agents setup secrets` installs the standalone when missing, then hands
  // off to `secrets migrate`. The wizard is unit-tested in setup-secrets.test.ts;
  // here we pin the registered command surface: the old wizard flags are gone,
  // and a PATH with no `secrets` and no npm fails loud rather than writing prefs.
  it('no longer accepts the removed --backend/--policy wizard flags', async () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    await expect(
      program.parseAsync(['setup', 'secrets', '--backend', 'file'], { from: 'user' }),
    ).rejects.toThrow(/unknown option '--backend'/);
  });

  it('exits non-zero when the standalone `secrets` CLI is not installed and cannot be installed', async () => {
    const originalPath = process.env.PATH;
    const originalBin = process.env.SECRETS_BIN;
    const { _resetSecretsClientForTest } = await import('../lib/secrets-client.js');
    // A PATH with no `secrets` on it and no explicit override — deterministic
    // "not installed" regardless of the machine running this.
    process.env.PATH = '';
    delete process.env.SECRETS_BIN;
    _resetSecretsClientForTest();
    process.exitCode = undefined;
    try {
      const program = new Command();
      program.exitOverride();
      registerSetupCommand(program);

      await program.parseAsync(['setup', 'secrets'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      // Setup did not complete, so no prefs file is written.
      expect(
        fs.existsSync(path.join(TEST_HOME, '.agents', '.history', 'setup', 'secrets.json')),
      ).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalBin === undefined) delete process.env.SECRETS_BIN;
      else process.env.SECRETS_BIN = originalBin;
      _resetSecretsClientForTest();
      process.exitCode = undefined;
    }
  });
});

describe('agents setup fleet', () => {
  it('prints install guidance and exits cleanly when tailscale is unavailable', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const program = new Command();
      program.exitOverride();
      registerSetupCommand(program);

      await program.parseAsync(['setup', 'fleet', '--yes'], { from: 'user' });
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.env.PATH = originalPath;
      process.exitCode = undefined;
    }
  });
});
