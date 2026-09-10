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
const { listInstalledBrowsers } = await import('../lib/browser/chrome.js');

describe('agents setup command group', () => {
  it('registers the browser/computer/fleet/mine/secrets/accounts/alias/beta capability subcommands', () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    const subs = setup!.commands.map((c) => c.name()).sort();
    // `share` is deliberately absent: artifact-share provisioning moved to
    // `agents artifacts setup` (RUSH-2580). The `share` PHASE stays in the hub.
    // `url-scheme` is the agents:// OS deep-link handler home (PHNX-3949).
    expect(subs).toEqual(['accounts', 'alias', 'beta', 'browser', 'computer', 'fleet', 'mine', 'secrets', 'status', 'url-scheme', 'watchdog']);
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
      'core', 'browser', 'computer', 'secrets', 'accounts', 'fleet', 'share', 'watchdog', 'preferences',
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

  it('uses the configured named browser profile for readiness', async () => {
    const { createProfile } = await import('../lib/browser/profiles.js');
    const { setConfigValue } = await import('../lib/device-config.js');
    await createProfile({
      name: 'work',
      browser: 'custom',
      binary: process.execPath,
      endpoints: ['cdp://127.0.0.1:9333'],
      viewport: { width: 1280, height: 720 },
    });
    setConfigValue('browser.profile', 'work');
    const rows = await getSetupStatus();
    expect(rows.find((row) => row.phase === 'browser')).toMatchObject({ state: 'ready', detail: 'profile work' });
  });

  it('reports a configured browser profile with a missing binary as unavailable', async () => {
    const { updateProfile } = await import('../lib/browser/profiles.js');
    await updateProfile({
      name: 'work',
      browser: 'custom',
      binary: path.join(TEST_HOME, 'missing-browser'),
      endpoints: ['cdp://127.0.0.1:9333'],
      viewport: { width: 1280, height: 720 },
    });
    const rows = await getSetupStatus();
    expect(rows.find((row) => row.phase === 'browser')).toMatchObject({
      state: 'missing',
      detail: 'profile work cannot launch here',
    });
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

describe('listInstalledBrowsers', () => {
  it('returns [] on an unknown platform (no crash on non-mac/linux/win)', () => {
    expect(listInstalledBrowsers('sunos')).toEqual([]);
  });
});
