/** Tests resolveAgentTargetsAutoInstalling, the wrapper that catches VersionNotInstalledError,
 * prompts (or auto-installs with --yes) and retries the resolver. Only installVersion (shells out
 * to npm) is mocked; the rest uses real fs in a tmpdir. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let VERSIONS_DIR: string;
const installVersionMock = vi.fn();

vi.mock('../../lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/state.js')>();
  return {
    ...actual,
    getVersionsDir: () => VERSIONS_DIR,
  };
});

vi.mock('../../lib/installations/versions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/installations/versions.js')>();
  return {
    ...actual,
    installVersion: installVersionMock,
  };
});

async function loadUtils() {
  return await import('../utils.js');
}

function makeFakeInstall(agent: string, version: string): void {
  const binDir = path.join(VERSIONS_DIR, agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cli = agent === 'claude' ? 'claude' : agent;
  fs.writeFileSync(path.join(binDir, cli), '#!/bin/sh\n');
  fs.chmodSync(path.join(binDir, cli), 0o755);
}

describe('resolveAgentTargetsAutoInstalling', () => {
  let savedStdinTty: boolean | undefined;
  let savedStdoutTty: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-install-'));
    VERSIONS_DIR = path.join(TEST_ROOT, 'versions');
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    installVersionMock.mockReset();
    savedStdinTty = process.stdin.isTTY;
    savedStdoutTty = process.stdout.isTTY;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinTty, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutTty, configurable: true });
    exitSpy.mockRestore();
  });

  it('passes through when every requested version is already installed', async () => {
    makeFakeInstall('claude', '2.1.141');
    const { resolveAgentTargetsAutoInstalling } = await loadUtils();

    const result = await resolveAgentTargetsAutoInstalling('claude@2.1.141', ['claude'], { yes: true });

    expect(result).not.toBeNull();
    expect(result!.selectedAgents).toEqual(['claude']);
    expect(installVersionMock).not.toHaveBeenCalled();
  });

  it('with --yes, auto-installs the missing version then resolves', async () => {
    makeFakeInstall('claude', '2.1.141');
    // Simulate a successful install — also materialise the version on disk
    // so the post-install resolve() actually finds it.
    installVersionMock.mockImplementation(async (agent: string, version: string) => {
      makeFakeInstall(agent, version);
      return { success: true, installedVersion: version };
    });

    const { resolveAgentTargetsAutoInstalling } = await loadUtils();
    const result = await resolveAgentTargetsAutoInstalling('claude@2.1.999', ['claude'], { yes: true });

    expect(installVersionMock).toHaveBeenCalledTimes(1);
    expect(installVersionMock).toHaveBeenCalledWith('claude', '2.1.999', expect.any(Function));
    expect(result).not.toBeNull();
    expect(result!.selectedAgents).toEqual(['claude']);
    expect(result!.versionSelections.get('claude')).toEqual(['2.1.999']);
  });

  it('in non-TTY without --yes, exits 1 instead of silently installing', async () => {
    makeFakeInstall('claude', '2.1.141');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    const { resolveAgentTargetsAutoInstalling } = await loadUtils();

    await expect(resolveAgentTargetsAutoInstalling('claude@2.1.999', ['claude'])).rejects.toThrow(/process\.exit\(1\)/);
    expect(installVersionMock).not.toHaveBeenCalled();
  });

  it('with --yes, aborts (process.exit(1)) when installVersion reports failure', async () => {
    makeFakeInstall('claude', '2.1.141');
    installVersionMock.mockResolvedValue({ success: false, installedVersion: '', error: 'npm 404' });

    const { resolveAgentTargetsAutoInstalling } = await loadUtils();

    await expect(resolveAgentTargetsAutoInstalling('claude@2.1.999', ['claude'], { yes: true })).rejects.toThrow(/process\.exit\(1\)/);
    expect(installVersionMock).toHaveBeenCalledTimes(1);
  });

  it('happy paths skip the install pre-flight entirely (no extra IO)', async () => {
    makeFakeInstall('claude', '2.1.141');
    const { resolveAgentTargetsAutoInstalling } = await loadUtils();

    // bare agent, @default, @all, literal `all` — none of these are "specific missing version"
    await resolveAgentTargetsAutoInstalling('claude', ['claude'], { yes: true });
    await resolveAgentTargetsAutoInstalling('claude@all', ['claude'], { yes: true });
    await resolveAgentTargetsAutoInstalling('all', ['claude'], { yes: true });

    expect(installVersionMock).not.toHaveBeenCalled();
  });
});
