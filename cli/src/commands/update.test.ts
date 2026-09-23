/**
 * The `agents update` surface. Pins the command shape agents and scripts call
 * (`<agent>@<installed-version>`, `--to`, `--json`) and the two
 * boundaries where a wrong answer is worse than an error: naming an agent that
 * cannot be pinned, and naming an installation that does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';

let home: string;

async function program(): Promise<Command> {
  vi.resetModules();
  const { registerUpdateCommand } = await import('./update.js');
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerUpdateCommand(p);
  return p;
}

/** Run the command exactly as argv would reach it, capturing what the user sees. */
async function run(args: string[]): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(String(a[0])); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(String(a[0])); });
  process.exitCode = undefined;
  try {
    const p = await program();
    await p.parseAsync(['node', 'agents', ...args]);
    return { out: out.join('\n'), err: err.join('\n'), exitCode: process.exitCode };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = undefined;
  }
}

/** A failure must reach the user as one actionable line, never a stack trace. */
async function expectFailure(args: string[], pattern: RegExp): Promise<void> {
  const result = await run(args);
  expect(result.err).toMatch(pattern);
  expect(result.err).not.toMatch(/\bat Command\b/);
  expect(result.exitCode).toBe(1);
}

describe('agents update', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-update-cmd-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('registers update with the documented options and a list subcommand', async () => {
    const update = (await program()).commands.find((c) => c.name() === 'update');
    expect(update).toBeDefined();
    const flags = update!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--to', '--json']));
    expect(update!.commands.map((c) => c.name())).toContain('list');
  });

  it('carries workflow-first help, not a bare flag dump', async () => {
    vi.resetModules();
    const { applyGlobalHelpConventions } = await import('../lib/help.js');
    const { registerUpdateCommand } = await import('./update.js');
    const root = new Command();
    registerUpdateCommand(root);
    applyGlobalHelpConventions(root);

    const help = root.commands.find((c) => c.name() === 'update')!.helpInformation();
    // The taught path is the bare agent (one managed installation); the
    // `@<label>` selector keeps working but is hidden from the examples.
    expect(help).toContain('agents update claude --to 2.1.220');
    expect(help).not.toContain('agents update claude@2.0.65 --to 2.1.220');
    expect(help).not.toContain('--account');
  });

  it('rejects an unknown agent by name', async () => {
    await expectFailure(['update', 'notanagent'], /notanagent/);
  });

  it('takes the run-style <agent>#<account> selector and names an unknown account, not the agent (PHNX-4116)', async () => {
    // `agents update claude#work` used to die with "Unknown agent 'claude#work'"
    // while `agents run claude#work` accepted the same selector.
    await expectFailure(['update', 'claude#work'], /Unknown Claude account 'work'.*agents accounts list claude/);
    await expectFailure(['update', 'claude#'], /Select an account after #/);
  });

  it('rejects a bare @ with no installation', async () => {
    await expectFailure(['update', 'claude@'], /Missing installation/);
  });

  it('refuses a pinned --to for a harness whose installer takes no version', async () => {
    // droid installs one self-updating binary; honouring `--to 1.2.3` is
    // impossible, so it must say so rather than install the current release and
    // report it as the pin.
    await expectFailure(['update', 'droid', '--to', '1.2.3'], /no pinnable releases/);
  });

  it('reports that nothing is installed rather than failing obscurely', async () => {
    await expectFailure(['update', 'claude@2.0.65'], /agents add claude\b/);
  });

  it('names the installations a bare update leaves untouched (PHNX-3940)', async () => {
    vi.resetModules();
    const { createInstallation, recordRelease } = await import('../lib/installations/index.js');
    const { markVersionIsolated } = await import('../lib/installations/versions.js');
    const { describeSkippedInstallations } = await import('./update.js');
    for (const label of ['main', '2.1.112', 'iso']) {
      fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', label, 'home'), { recursive: true });
      recordRelease(createInstallation('claude', label, label), label);
    }
    markVersionIsolated('claude', 'iso');
    const { resolveManagedInstallation } = await import('../lib/installations/index.js');
    const managed = resolveManagedInstallation('claude')!;
    expect(managed.label).toBe('main');

    const line = describeSkippedInstallations('claude', managed.id);
    // The legacy per-version home and the isolated copy are both named; the
    // managed `main` install the bare update moved is not.
    expect(line).toContain('2 other Claude installations');
    expect(line).toContain('claude@2.1.112');
    expect(line).toContain('claude@iso');
    expect(line).not.toContain('claude@main');
    expect(line).toContain('agents update claude@<label>');
  });

  it('returns null when a bare update leaves nothing behind', async () => {
    vi.resetModules();
    const { createInstallation } = await import('../lib/installations/index.js');
    const { describeSkippedInstallations } = await import('./update.js');
    fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', 'main', 'home'), { recursive: true });
    const managed = createInstallation('claude', 'main', 'main');
    expect(describeSkippedInstallations('claude', managed.id)).toBeNull();
  });

  it('a bare target with no installations names the one managed install to create', async () => {
    await expectFailure(['update', 'claude'], /No managed Claude installation\. Install one with: agents add claude/);
  });

  it('a bare target ignores isolated copies — they are not the managed installation (PHNX-3940)', async () => {
    vi.resetModules();
    const { createInstallation } = await import('../lib/installations/index.js');
    const { markVersionIsolated } = await import('../lib/installations/versions.js');
    fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.112', 'home'), { recursive: true });
    createInstallation('claude', '2.1.112', '2.1.112');
    markVersionIsolated('claude', '2.1.112');

    await expectFailure(['update', 'claude'], /No managed Claude installation/);
  });

  it('names both candidates when two installations share a release', async () => {
    vi.resetModules();
    const { createInstallation, recordRelease } = await import('../lib/installations/index.js');
    for (const label of ['1.0.0', '1.0.1']) {
      fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', 'claude', label, 'home'), { recursive: true });
      recordRelease(createInstallation('claude', label, label), '2.1.220');
    }

    const result = await run(['update', 'claude@2.1.220']);
    expect(result.err).toContain('1.0.0 (release 2.1.220)');
    expect(result.err).toContain('1.0.1 (release 2.1.220)');
    expect(result.err).toContain('installation label');
    expect(result.exitCode).toBe(1);
  });

  it('lists installations as JSON with their stable id and current release', async () => {
    const dir = path.join(home, '.agents', '.history', 'versions', 'claude', '2.0.65');
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
    // Reset first: `state.ts` snapshots HOME at module load, so a graph cached
    // by an earlier test would write this record under the previous temp home.
    vi.resetModules();
    const { createInstallation, recordRelease } = await import('../lib/installations/index.js');
    recordRelease(createInstallation('claude', '2.0.65', '2.0.65'), '2.1.220');

    const parsed = JSON.parse((await run(['update', 'list', 'claude', '--json'])).out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ agent: 'claude', label: '2.0.65', releaseVersion: '2.1.220' });
    expect(parsed[0].id).toMatch(/^ins_/);
  });
});
