import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { planManagedAdd } from './versions.js';

let home: string;

async function program(): Promise<Command> {
  vi.resetModules();
  const { registerVersionsCommands } = await import('./versions.js');
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerVersionsCommands(p);
  return p;
}

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

function makeManagedInstall(agent: string, label: string, release: string): void {
  fs.mkdirSync(path.join(home, '.agents', '.history', 'versions', agent, label, 'home'), { recursive: true });
}

describe('planManagedAdd — one managed installation per harness (PHNX-3940)', () => {
  it('installs main only when the harness has no managed install yet', () => {
    expect(planManagedAdd({ explicitPin: false, managedInstalled: false })).toBe('install');
    expect(planManagedAdd({ explicitPin: true, managedInstalled: false })).toBe('install');
  });

  it('reuses the managed installation on a bare add', () => {
    expect(planManagedAdd({ explicitPin: false, managedInstalled: true })).toBe('reuse');
  });

  it('pins the managed installation on an explicit @release instead of creating a second home', () => {
    expect(planManagedAdd({ explicitPin: true, managedInstalled: true })).toBe('pin');
  });
});

describe('agents add — managed-installation branches', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-add-cmd-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('bare add reuses the existing managed installation and creates no second home', async () => {
    makeManagedInstall('claude', 'main', '2.1.0');
    vi.resetModules();
    const { createInstallation } = await import('../lib/installations/index.js');
    createInstallation('claude', 'main', '2.1.0');

    const result = await run(['add', 'claude']);
    expect(result.out).toContain('already installed');
    expect(result.out).toContain('agents update claude');
    expect(result.err).toBe('');
    expect(fs.readdirSync(path.join(home, '.agents', '.history', 'versions', 'claude'))).toEqual(['main']);
  });

  it('an explicit @release on an unpinnable harness refuses instead of faking the pin', async () => {
    makeManagedInstall('droid', 'main', '0.19.3');
    vi.resetModules();
    const { createInstallation } = await import('../lib/installations/index.js');
    createInstallation('droid', 'main', '0.19.3');

    const result = await run(['add', 'droid@1.2.3']);
    expect(result.out).toContain('no pinnable releases');
    expect(result.exitCode).toBe(1);
    expect(fs.readdirSync(path.join(home, '.agents', '.history', 'versions', 'droid'))).toEqual(['main']);
  });

  it('add <harness>@main names the managed installation itself — reuse, never an npm tag lookup', async () => {
    makeManagedInstall('claude', 'main', '2.1.0');
    vi.resetModules();
    const { createInstallation } = await import('../lib/installations/index.js');
    createInstallation('claude', 'main', '2.1.0');

    const result = await run(['add', 'claude@main']);
    expect(result.out).toContain('already installed');
    expect(result.exitCode).toBeUndefined();
    expect(fs.readdirSync(path.join(home, '.agents', '.history', 'versions', 'claude'))).toEqual(['main']);
  });
});
