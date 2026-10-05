import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let VERSIONS_DIR: string;

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getVersionsDir: () => VERSIONS_DIR,
  };
});

async function loadLib() {
  return await import('../installations/versions.js');
}

const CLI_COMMAND: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

function makeFakeInstall(agent: string, version: string): void {
  const binDir = path.join(VERSIONS_DIR, agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cli = CLI_COMMAND[agent] ?? agent;
  fs.writeFileSync(path.join(binDir, cli), '#!/bin/sh\n');
  fs.chmodSync(path.join(binDir, cli), 0o755);
}

describe('VersionNotInstalledError + resolveInstalledAgentTargets @all parity', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vne-'));
    VERSIONS_DIR = path.join(TEST_ROOT, 'versions');
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    vi.resetModules();
  });

  it('resolveAgentVersionTargets throws VersionNotInstalledError with agentId + version', async () => {
    makeFakeInstall('claude', '2.1.141');
    const { resolveAgentVersionTargets, VersionNotInstalledError } = await loadLib();

    try {
      resolveAgentVersionTargets('claude@2.1.999', ['claude']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionNotInstalledError);
      const typed = err as InstanceType<typeof VersionNotInstalledError>;
      expect(typed.agentId).toBe('claude');
      expect(typed.version).toBe('2.1.999');
      expect(typed.installedVersions).toContain('2.1.141');
    }
  });

  it('resolveInstalledAgentTargets throws VersionNotInstalledError with agentId + version', async () => {
    makeFakeInstall('claude', '2.1.141');
    const { resolveInstalledAgentTargets, VersionNotInstalledError } = await loadLib();

    try {
      resolveInstalledAgentTargets('claude@2.1.999', ['claude']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionNotInstalledError);
      const typed = err as InstanceType<typeof VersionNotInstalledError>;
      expect(typed.agentId).toBe('claude');
      expect(typed.version).toBe('2.1.999');
    }
  });

  it('resolveInstalledAgentTargets expands `agent@all` to every installed version', async () => {
    makeFakeInstall('claude', '2.1.141');
    makeFakeInstall('claude', '2.1.158');
    makeFakeInstall('claude', '2.1.200');

    const { resolveInstalledAgentTargets } = await loadLib();
    const result = resolveInstalledAgentTargets('claude@all', ['claude']);

    expect(result.selectedAgents).toEqual(['claude']);
    const versions = result.versionSelections.get('claude');
    expect(versions).toBeDefined();
    expect(new Set(versions)).toEqual(new Set(['2.1.141', '2.1.158', '2.1.200']));
  });

  it('resolveInstalledAgentTargets expands literal `all` across capable agents (skipping uninstalled)', async () => {
    makeFakeInstall('claude', '2.1.141');
    makeFakeInstall('codex', '0.116.0');

    const { resolveInstalledAgentTargets } = await loadLib();
    const result = resolveInstalledAgentTargets('all', ['claude', 'codex', 'gemini']);

    expect(new Set(result.selectedAgents)).toEqual(new Set(['claude', 'codex']));
    expect(result.versionSelections.get('claude')).toEqual(['2.1.141']);
    expect(result.versionSelections.get('codex')).toEqual(['0.116.0']);
    expect(result.versionSelections.has('gemini')).toBe(false);
  });
});
