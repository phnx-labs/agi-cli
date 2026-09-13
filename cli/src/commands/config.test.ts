import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = process.cwd();
const entrypoint = path.join(repoRoot, 'src/index.ts');

function runAgents(home: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync('bun', [entrypoint, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      ...extraEnv,
    },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('config command', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-config-test-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('sets and gets a run model default', () => {
    const setOut = runAgents(home, ['config', 'set', 'run.claude@*.model', 'claude-opus-4-8']);
    expect(setOut).toContain('run.claude@*.model');
    expect(setOut).toContain('claude-opus-4-8');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('run:');
    expect(yaml).toContain('claude:*');
    expect(yaml).toContain('model: claude-opus-4-8');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@*.model']);
    expect(getOut).toContain('claude-opus-4-8');
  });

  it('sets and gets a tier override', () => {
    const setOut = runAgents(home, [
      'config',
      'set',
      'run.claude@*.tier.best',
      'claude-opus-4-8',
    ]);
    expect(setOut).toContain('run.claude@*.tier.best');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('model:');
    expect(yaml).toContain('tiers:');
    expect(yaml).toContain('claude:*');
    expect(yaml).toContain('best: claude-opus-4-8');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@*.tier.best']);
    expect(getOut).toContain('claude-opus-4-8');
  });

  it('sets and gets the interactive host', () => {
    runAgents(home, ['config', 'set', 'interactive.host', 'zion']);
    const getOut = runAgents(home, ['config', 'get', 'interactive.host']);
    expect(getOut).toContain('zion');
  });

  it('sets, gets, and unsets the projects root', () => {
    const root = path.join(home, 'src', 'github.com', 'example');
    runAgents(home, ['config', 'set', 'project.root', root]);
    expect(runAgents(home, ['config', 'get', 'project.root'])).toContain('~/src/github.com/example');
    runAgents(home, ['config', 'unset', 'project.root']);
    expect(runAgents(home, ['config', 'get', 'project.root'])).toContain('(unset)');
  });

  it('sets and unsets the browser profile', () => {
    runAgents(home, ['config', 'set', 'browser.profile', 'work']);
    let getOut = runAgents(home, ['config', 'get', 'browser.profile']);
    expect(getOut).toContain('work');

    runAgents(home, ['config', 'unset', 'browser.profile']);
    getOut = runAgents(home, ['config', 'get', 'browser.profile']);
    expect(getOut).toContain('(unset)');
  });

  it('sets, gets and unsets browser.viewer WITHOUT touching browser.profile', () => {
    // Regression guard for a destructive bug: `getConfig`/`unsetConfig` both
    // hardcoded 'browser.profile' in their `case 'browser'` arm, so
    // `config get browser.viewer` reported browser.profile's value as if it were
    // the answer, and `config unset browser.viewer` DELETED browser.profile
    // while printing success. Neither arm is covered by a `never` binding — they
    // switch on parsed.scope, where `case 'browser'` already existed — so only a
    // test catches it.
    runAgents(home, ['config', 'set', 'browser.profile', 'comet-local']);
    runAgents(home, ['config', 'set', 'browser.viewer', 'reading']);

    expect(runAgents(home, ['config', 'get', 'browser.profile'])).toContain('comet-local');
    // The inversion: this used to print comet-local.
    expect(runAgents(home, ['config', 'get', 'browser.viewer'])).toContain('reading');

    // Both must be visible; browser.viewer was silently dropped by the
    // `default: continue` arm of the device-property switch in `config list`.
    const listed = runAgents(home, ['config', 'list']);
    expect(listed).toContain('browser.profile');
    expect(listed).toContain('browser.viewer');

    runAgents(home, ['config', 'unset', 'browser.viewer']);
    expect(runAgents(home, ['config', 'get', 'browser.viewer'])).toContain('(unset)');
    // The destructive half: browser.profile must survive.
    expect(runAgents(home, ['config', 'get', 'browser.profile'])).toContain('comet-local');
  });

  it('sets, gets, lists and unsets the fleet browser hub (browser.device)', () => {
    runAgents(home, ['config', 'set', 'browser.device', 'mac-mini']);
    expect(runAgents(home, ['config', 'get', 'browser.device'])).toContain('mac-mini');

    // Must be enumerated, not just get-able — the browser.viewer invisibility bug.
    expect(runAgents(home, ['config', 'list'])).toContain('browser.device');

    // Lands in the fleet-synced central config block (user scope).
    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('defaultBrowserDevice');

    runAgents(home, ['config', 'unset', 'browser.device']);
    expect(runAgents(home, ['config', 'get', 'browser.device'])).toContain('(unset)');
  });

  it('sets, gets, lists (--json), and unsets an AGI Menu preference (user-scope, fleet-synced)', () => {
    runAgents(home, ['config', 'set', 'menubar.menu.workingRowsShown', '4']);
    expect(runAgents(home, ['config', 'get', 'menubar.menu.workingRowsShown'])).toContain('4');

    // Lands in the fleet-synced central config block (user scope).
    const yaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('menubarMenuWorkingRowsShown');

    // config list --json is the native menu's read surface: [{key,value,hint}].
    const jsonOut = runAgents(home, ['config', 'list', '--json']);
    const parsed = JSON.parse(jsonOut) as Array<{ key: string; value: unknown; hint: string }>;
    const row = parsed.find((r) => r.key === 'menubar.menu.workingRowsShown');
    expect(row).toBeDefined();
    expect(row!.value).toBe(4);
    expect(typeof row!.hint).toBe('string');

    runAgents(home, ['config', 'unset', 'menubar.menu.workingRowsShown']);
    expect(runAgents(home, ['config', 'get', 'menubar.menu.workingRowsShown'])).toContain('(unset)');
    // Unset keys are OMITTED from the list so the native app uses its defaults.
    const after = JSON.parse(runAgents(home, ['config', 'list', '--json'])) as Array<{ key: string }>;
    expect(after.find((r) => r.key === 'menubar.menu.workingRowsShown')).toBeUndefined();
  });

  it('rejects an out-of-set AGI Menu enum value', () => {
    expect(() =>
      runAgents(home, ['config', 'set', 'menubar.menu.groupBy', 'sideways']),
    ).toThrow();
  });

  it('rejects a workingRowsShown outside 2..4', () => {
    expect(() => runAgents(home, ['config', 'set', 'menubar.menu.workingRowsShown', '7'])).toThrow();
  });

  it('sets and lists a device formFactor (shared, fleet-synced)', () => {
    const env = { AGENTS_SYNC_MACHINE_ID: 'testbox' };
    runAgents(home, ['config', 'set', 'devices.testbox.formFactor', 'laptop'], env);
    expect(runAgents(home, ['config', 'get', 'devices.testbox.formFactor'], env)).toContain('laptop');
    expect(runAgents(home, ['config', 'list'], env)).toContain('devices.testbox.formFactor');
  });

  it('rejects an unknown formFactor value', () => {
    const env = { AGENTS_SYNC_MACHINE_ID: 'testbox' };
    expect(() => runAgents(home, ['config', 'set', 'devices.testbox.formFactor', 'tablet'], env)).toThrow();
  });

  it('lists configured values', () => {
    runAgents(home, ['config', 'set', 'run.claude@*.model', 'best']);
    runAgents(home, ['config', 'set', 'run.claude@*.tier.best', 'claude-opus-4-8']);
    runAgents(home, ['config', 'set', 'interactive.host', 'zion']);

    const listOut = runAgents(home, ['config', 'list']);
    expect(listOut).toContain('run.claude@*.model');
    expect(listOut).toContain('best');
    expect(listOut).toContain('run.claude@*.tier.best');
    expect(listOut).toContain('claude-opus-4-8');
    expect(listOut).toContain('interactive.host');
    expect(listOut).toContain('zion');
  });

  it('unsets a run default', () => {
    runAgents(home, ['config', 'set', 'run.claude@*.model', 'best']);
    const unsetOut = runAgents(home, ['config', 'unset', 'run.claude@*.model']);
    expect(unsetOut).toContain('Unset');

    const getOut = runAgents(home, ['config', 'get', 'run.claude@*.model']);
    expect(getOut).toContain('(unset)');
  });

  it('lists a device-scope tmux.enabled after it is set', () => {
    // tmux.enabled is machine-local, so it can only be written for THIS
    // machine — pin the self id so the set and the list agree deterministically.
    const env = { AGENTS_SYNC_MACHINE_ID: 'testbox' };
    runAgents(home, ['config', 'set', 'devices.testbox.tmux', 'off'], env);

    const listOut = runAgents(home, ['config', 'list'], env);
    expect(listOut).toContain('devices.testbox.tmux');
    expect(listOut).toContain('false');

    const jsonOut = runAgents(home, ['config', 'list', '--json'], env);
    expect(jsonOut).toContain('devices.testbox.tmux');
  });

  it('lists browser.profile once for this machine', () => {
    runAgents(home, ['config', 'set', 'browser.profile', 'work']);
    const listOut = runAgents(home, ['config', 'list']);
    // Count how many times the top-level key appears; the self device must not
    // duplicate it as devices.<self>.browser.profile.
    const matches = listOut.match(/browser\.profile/g) ?? [];
    expect(matches.length).toBe(1);
    expect(listOut).not.toMatch(/devices\.[\w-]+\.browser\.profile/);
  });

  it('sets, gets, lists and unsets a device computer.host address (PHNX-4090)', () => {
    const env = { AGENTS_SYNC_MACHINE_ID: 'testbox' };
    runAgents(home, ['config', 'set', 'devices.testbox.computer.host', 'vnc://10.0.0.5:5901'], env);

    expect(runAgents(home, ['config', 'get', 'devices.testbox.computer.host'], env)).toContain('vnc://10.0.0.5:5901');
    const listOut = runAgents(home, ['config', 'list'], env);
    expect(listOut).toContain('devices.testbox.computer.host');

    const yaml = fs.readFileSync(path.join(home, '.agents', 'devices', 'testbox', 'agents.yaml'), 'utf-8');
    expect(yaml).toContain('computerHost');

    runAgents(home, ['config', 'unset', 'devices.testbox.computer.host'], env);
    expect(runAgents(home, ['config', 'get', 'devices.testbox.computer.host'], env)).toContain('(unset)');
  });

  it('rejects a computer.host address with an unsupported scheme', () => {
    const env = { AGENTS_SYNC_MACHINE_ID: 'testbox' };
    expect(() => runAgents(home, ['config', 'set', 'devices.testbox.computer.host', 'cdp://127.0.0.1:9222'], env))
      .toThrow(/computer\.host speaks ssh:\/\/, vnc:\/\/ and tcp:\/\/ only/);
  });

  it('rejects unknown keys', () => {
    expect(() => runAgents(home, ['config', 'get', 'foo.bar'])).toThrow(/Unknown config scope/);
  });

  it('rejects invalid run property', () => {
    expect(() => runAgents(home, ['config', 'set', 'run.claude@*.foo', 'x'])).toThrow(
      /Invalid run config key/,
    );
  });
});
