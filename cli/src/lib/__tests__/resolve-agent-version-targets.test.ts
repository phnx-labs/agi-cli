import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let VERSIONS_DIR: string;
const defaultByAgent: Record<string, string | null> = {};

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getVersionsDir: () => VERSIONS_DIR,
    getGlobalDefault: (agent: string) => defaultByAgent[agent] ?? null,
  };
});

async function loadResolver() {
  const mod = await import('../installations/versions.js');
  return mod.resolveAgentVersionTargets;
}

const CLI_COMMAND: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

function makeFakeInstall(agent: string, version: string) {
  const binDir = path.join(VERSIONS_DIR, agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cli = CLI_COMMAND[agent] ?? agent;
  fs.writeFileSync(path.join(binDir, cli), '#!/bin/sh\n');
  fs.chmodSync(path.join(binDir, cli), 0o755);
}

const AVAILABLE = ['claude', 'codex', 'gemini'] as const;

describe('resolveAgentVersionTargets — @all and literal `all`', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-all-'));
    VERSIONS_DIR = path.join(TEST_ROOT, 'versions');
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
    for (const k of Object.keys(defaultByAgent)) delete defaultByAgent[k];
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('claude@all expands to every installed claude version', async () => {
    makeFakeInstall('claude', '2.1.141');
    makeFakeInstall('claude', '2.1.158');
    makeFakeInstall('claude', '2.1.159');
    defaultByAgent.claude = '2.1.141';

    const resolveAgentVersionTargets = await loadResolver();
    const { selectedAgents, versionSelections } = resolveAgentVersionTargets('claude@all', AVAILABLE as any);

    expect(selectedAgents).toEqual(['claude']);
    const versions = versionSelections.get('claude' as any) ?? [];
    expect(versions.sort()).toEqual(['2.1.141', '2.1.158', '2.1.159']);
  });

  it('literal `all` expands every available agent to every installed version', async () => {
    makeFakeInstall('claude', '2.1.141');
    makeFakeInstall('claude', '2.1.158');
    makeFakeInstall('codex', '0.116.0');

    const resolveAgentVersionTargets = await loadResolver();
    const { selectedAgents, versionSelections } = resolveAgentVersionTargets('all', AVAILABLE as any);

    expect(selectedAgents).toContain('claude');
    expect(selectedAgents).toContain('codex');
    expect((versionSelections.get('claude' as any) ?? []).sort()).toEqual(['2.1.141', '2.1.158']);
    expect(versionSelections.get('codex' as any) ?? []).toEqual(['0.116.0']);
  });

  it('mixed claude@all,codex@2.1.0 keeps each token distinct', async () => {
    makeFakeInstall('claude', '2.1.141');
    makeFakeInstall('claude', '2.1.158');
    makeFakeInstall('codex', '0.115.0');
    makeFakeInstall('codex', '0.116.0');

    const resolveAgentVersionTargets = await loadResolver();
    const { selectedAgents, versionSelections } = resolveAgentVersionTargets(
      'claude@all,codex@0.116.0',
      AVAILABLE as any
    );

    expect(selectedAgents).toEqual(['claude', 'codex']);
    expect((versionSelections.get('claude' as any) ?? []).sort()).toEqual(['2.1.141', '2.1.158']);
    expect(versionSelections.get('codex' as any) ?? []).toEqual(['0.116.0']);
  });

  it('claude@2.1.141 still works (back-compat)', async () => {
    makeFakeInstall('claude', '2.1.141');
    makeFakeInstall('claude', '2.1.158');

    const resolveAgentVersionTargets = await loadResolver();
    const { selectedAgents, versionSelections } = resolveAgentVersionTargets('claude@2.1.141', AVAILABLE as any);

    expect(selectedAgents).toEqual(['claude']);
    expect(versionSelections.get('claude' as any) ?? []).toEqual(['2.1.141']);
  });
});
