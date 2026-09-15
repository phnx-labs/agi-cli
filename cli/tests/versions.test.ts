import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IS_WINDOWS, toPosix } from '../src/lib/platform/index.js';

// Mock state.ts to redirect all paths to temp directory. Stash mutable
// override state on globalThis instead of a top-level const — vitest 4
// hoists vi.mock above local declarations (TDZ error) and Bun's native
// runner doesn't expose vi.hoisted. globalThis is always initialized.
interface VersionsHoistedState {
  TEST_ROOT: string;
  AGENTS_DIR: string;
  PROJECT_AGENTS_DIR: string | null;
  META: { agents?: Record<string, string> };
}
const HOISTED_STATE_KEY = '__agents_cli_versions_test_state__';
const hoistedState: VersionsHoistedState =
  ((globalThis as Record<string, unknown>)[HOISTED_STATE_KEY] as VersionsHoistedState | undefined)
  ?? (((globalThis as Record<string, unknown>)[HOISTED_STATE_KEY] = {
        TEST_ROOT: '',
        AGENTS_DIR: '',
        PROJECT_AGENTS_DIR: null,
        META: {},
      }) as VersionsHoistedState);
let TEST_ROOT = '';
let AGENTS_DIR = '';
let PROJECT_AGENTS_DIR: string | null = null;
let META: { agents?: Record<string, string> } = {};

vi.mock('../src/lib/state.js', () => {
  // Pull from globalThis at call time so vitest's hoisting of vi.mock above
  // the local `hoistedState` binding (TDZ) doesn't break references. Seed
  // the bucket here too — if vitest invokes the factory before the
  // module-body const initializer runs, the consumer's first read still
  // sees a real object instead of undefined.
  const nodeFs = require('node:fs') as typeof import('fs');
  const nodePath = require('node:path') as typeof import('path');
  const gt = globalThis as Record<string, unknown>;
  if (!gt.__agents_cli_versions_test_state__) {
    gt.__agents_cli_versions_test_state__ = {
      TEST_ROOT: '',
      AGENTS_DIR: '',
      PROJECT_AGENTS_DIR: null,
      META: {},
    };
  }
  const state = () => gt.__agents_cli_versions_test_state__ as VersionsHoistedState;
  return {
    get getAgentsDir() { return () => state().AGENTS_DIR; },
    get getSystemAgentsDir() { return () => state().AGENTS_DIR; },
    get getUserAgentsDir() { return () => state().AGENTS_DIR; },
    get getOptionalUserAgentsDir() { return () => state().AGENTS_DIR; },
    get getVersionsDir() { return () => nodePath.join(state().AGENTS_DIR, 'versions'); },
    get getShimsDir() { return () => nodePath.join(state().AGENTS_DIR, 'shims'); },
    get getCommandsDir() { return () => nodePath.join(state().AGENTS_DIR, 'commands'); },
    get getSystemCommandsDir() { return () => nodePath.join(state().AGENTS_DIR, 'commands'); },
    get getUserCommandsDir() { return () => nodePath.join(state().AGENTS_DIR, 'commands'); },
    get getSkillsDir() { return () => nodePath.join(state().AGENTS_DIR, 'skills'); },
    get getSystemSkillsDir() { return () => nodePath.join(state().AGENTS_DIR, 'skills'); },
    get getUserSkillsDir() { return () => nodePath.join(state().AGENTS_DIR, 'skills'); },
    get getHooksDir() { return () => nodePath.join(state().AGENTS_DIR, 'hooks'); },
    get getSystemHooksDir() { return () => nodePath.join(state().AGENTS_DIR, 'hooks'); },
    get getUserHooksDir() { return () => nodePath.join(state().AGENTS_DIR, 'hooks'); },
    get getMemoryDir() { return () => nodePath.join(state().AGENTS_DIR, 'memory'); },
    get getRulesDir() { return () => nodePath.join(state().AGENTS_DIR, 'memory'); },
    get getSystemRulesDir() { return () => nodePath.join(state().AGENTS_DIR, 'memory'); },
    get getUserRulesDir() { return () => nodePath.join(state().AGENTS_DIR, 'memory'); },
    get getResolvedRulesDir() { return () => nodePath.join(state().AGENTS_DIR, 'memory'); },
    get getScopedAgentsDirs() { return () => [{ scope: 'user', path: state().AGENTS_DIR }]; },
    get getMcpDir() { return () => nodePath.join(state().AGENTS_DIR, 'mcp'); },
    get getSystemMcpDir() { return () => nodePath.join(state().AGENTS_DIR, 'mcp'); },
    get getUserMcpDir() { return () => nodePath.join(state().AGENTS_DIR, 'mcp'); },
    get getPermissionsDir() { return () => nodePath.join(state().AGENTS_DIR, 'permissions'); },
    get getSystemPermissionsDir() { return () => nodePath.join(state().AGENTS_DIR, 'permissions'); },
    get getUserPermissionsDir() { return () => nodePath.join(state().AGENTS_DIR, 'permissions'); },
    get getSubagentsDir() { return () => nodePath.join(state().AGENTS_DIR, 'subagents'); },
    get getSystemSubagentsDir() { return () => nodePath.join(state().AGENTS_DIR, 'subagents'); },
    get getUserSubagentsDir() { return () => nodePath.join(state().AGENTS_DIR, 'subagents'); },
    get getPluginsDir() { return () => nodePath.join(state().AGENTS_DIR, 'plugins'); },
    get getPromptcutsPath() { return () => nodePath.join(state().AGENTS_DIR, 'promptcuts.yaml'); },
    get getSystemPromptcutsPath() { return () => nodePath.join(state().AGENTS_DIR, 'promptcuts.yaml'); },
    get getUserPromptcutsPath() { return () => nodePath.join(state().AGENTS_DIR, 'promptcuts.yaml'); },
    get getProjectAgentsDir() { return () => state().PROJECT_AGENTS_DIR; },
    get getEnabledExtraRepos() { return () => []; },
    get ensureAgentsDir() { return () => nodeFs.mkdirSync(state().AGENTS_DIR, { recursive: true }); },
    get readMeta() { return () => state().META; },
    get writeMeta() {
      return (next: { agents?: Record<string, string> }) => {
        state().META = next;
      };
    },
    get recordVersionResources() { return () => {}; },
    get clearVersionResources() { return () => {}; },
    get getVersionResources() { return () => null; },
    get ensureVersionResourcePatterns() { return () => {}; },
    get getActiveRulesPreset() { return () => 'default'; },
    get setActiveRulesPreset() { return () => {}; },
    get getCliVersionCachePath() { return () => nodePath.join(state().AGENTS_DIR, '.cli-version-cache.json'); },
    get getRuntimeStateDir() { return () => nodePath.join(state().AGENTS_DIR, '.cache', 'state'); },
    // droid/muse global-binary paths resolve under the real user home; pin to
    // TEST_ROOT so path helpers stay hermetic in this suite.
    get getHomeDir() { return () => state().TEST_ROOT || require('node:os').homedir(); },
  };
});

// Mock external dependencies that syncResourcesToVersion calls
vi.mock('../src/lib/plugins/plugins.js', () => ({
  discoverPlugins: () => [],
  syncPluginToVersion: () => ({ success: false }),
  isPluginSynced: () => false,
  pluginSupportsAgent: () => false,
  cleanOrphanedPluginSkills: () => [],
}));

// The subagent registry (imported transitively via the staleness writer) reads
// every transform binding when it builds its target table at import time, so the
// mock must define them all even though these tests never invoke them
// (listInstalledSubagents returns [] — nothing syncs).
vi.mock('../src/lib/subagents.js', () => ({
  listInstalledSubagents: () => [],
  parseSubagentFrontmatter: () => null,
  transformSubagentForClaude: () => '',
  transformSubagentForCodex: () => '',
  transformSubagentForCopilot: () => '',
  transformSubagentForCursor: () => '',
  transformSubagentForDroid: () => '',
  transformSubagentForGoose: () => '',
  transformSubagentForOpenCode: () => '',
  transformSubagentForAntigravity: () => '',
  syncSubagentToOpenclaw: () => ({ success: false }),
}));

vi.mock('../src/lib/hooks/install.js', () => ({
  parseHookManifest: () => ({}),
  selectHookManifest: (manifest: object) => manifest,
  registerHooksToSettings: () => {},
  installSessionTrackerHookSync: () => ({ installed: true }),
  installSessionTrackerHook: async () => ({ installed: true }),
}));

vi.mock('../src/lib/permissions.js', () => ({
  getDefaultPermissionSet: () => ({ allow: [], deny: [] }),
  applyPermissionsToVersion: () => ({ success: false }),
  PERMISSIONS_CAPABLE_AGENTS: ['claude', 'codex', 'opencode'],
  discoverPermissionGroups: () => [],
  getTotalPermissionRuleCount: () => 0,
  buildPermissionsFromGroups: () => ({ allow: [], deny: [] }),
  CODEX_RULES_FILENAME: '.codex.rules',
  getActivePermissionSetName: () => null,
  getActivePermissionPresetName: () => null,
  readPermissionSetRecipe: () => null,
  PERMISSION_SET_ENV_VAR: 'AGENTS_PERMISSION_SET',
}));

// Override only the two mcp.js exports we need to neutralize; vi.spyOn keeps
// the rest real and avoids vi.importActual / importOriginal which Bun's
// native test runner does not support.
import * as mcpModule from '../src/lib/mcp.js';
vi.spyOn(mcpModule, 'installMcpServers').mockReturnValue({ applied: [] });
vi.spyOn(mcpModule, 'listMcpServerConfigs').mockReturnValue([]);

vi.mock('../src/lib/installations/shims.js', () => ({
  createVersionedAlias: () => {},
  removeVersionedAlias: () => {},
  switchConfigSymlink: () => {},
  getConfigSymlinkVersion: () => null,
}));

import {
  parseAgentSpec,
  resolveAgentVersionTargets,
  resolveInstalledAgentTargets,
  resolveConfiguredAgentTargets,
  resolveVersionAlias,
  resolveVersionAliasLoose,
  compareVersions,
  getNewResources,
  hasNewResources,
  getAvailableResources,
  syncResourcesToVersion,
  getActuallySyncedResources,
  getVersionDir,
  getBinaryPath,
  getVersionHomePath,
  installVersion,
  type AvailableResources,
  type ResourceSelection,
} from '../src/lib/installations/versions.js';
import { AGENTS } from '../src/lib/agents.js';

function installManagedVersion(agent: 'claude' | 'codex', version: string): void {
  const binaryPath = getBinaryPath(agent, version);
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
}

function emptyResources(): AvailableResources {
  return {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    workflows: [],
    promptcuts: false,
  };
}

// --- Setup / Teardown ---

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  AGENTS_DIR = path.join(TEST_ROOT, '.agents');
  PROJECT_AGENTS_DIR = null;
  META = {};
  hoistedState.TEST_ROOT = TEST_ROOT;
  hoistedState.AGENTS_DIR = AGENTS_DIR;
  hoistedState.PROJECT_AGENTS_DIR = PROJECT_AGENTS_DIR;
  hoistedState.META = META;
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});


// ============================================================
// Pure function tests
// ============================================================

describe('parseAgentSpec', () => {
  it('parses agent@version', () => {
    const result = parseAgentSpec('claude@2.0.65');
    expect(result).toEqual({ agent: 'claude', version: '2.0.65' });
  });

  it('defaults to latest when no version given', () => {
    const result = parseAgentSpec('codex');
    expect(result).toEqual({ agent: 'codex', version: 'latest' });
  });

  it('handles explicit latest', () => {
    const result = parseAgentSpec('codex@latest');
    expect(result).toEqual({ agent: 'codex', version: 'latest' });
  });

  it('handles explicit oldest', () => {
    const result = parseAgentSpec('codex@oldest');
    expect(result).toEqual({ agent: 'codex', version: 'oldest' });
  });

  it('normalizes agent name to lowercase', () => {
    const result = parseAgentSpec('CLAUDE@1.0.0');
    expect(result).toEqual({ agent: 'claude', version: '1.0.0' });
  });

  it('returns null for unknown agent', () => {
    expect(parseAgentSpec('fake-agent@1.0.0')).toBeNull();
    expect(parseAgentSpec('gpt@4.0')).toBeNull();
    expect(parseAgentSpec('')).toBeNull();
  });

  it('rejects ambiguous or unsafe version specifiers', () => {
    expect(parseAgentSpec('claude@1.0.0@evil')).toBeNull();
    expect(parseAgentSpec('claude@../escape')).toBeNull();
    expect(parseAgentSpec('claude@1.0.0;touch pwned')).toBeNull();
    expect(parseAgentSpec('claude@1.0.0/pwned')).toBeNull();
  });

  it('parses all valid agents', () => {
    for (const agent of ['claude', 'codex', 'cursor', 'opencode', 'openclaw']) {
      const result = parseAgentSpec(`${agent}@1.0.0`);
      expect(result).not.toBeNull();
      expect(result!.agent).toBe(agent);
    }
  });
});

describe('resolveVersionAlias', () => {
  it('resolves "latest" to the highest installed version', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');
    installManagedVersion('claude', '2.0.5');

    expect(resolveVersionAlias('claude', 'latest')).toBe('2.1.0');
  });

  it('resolves "oldest" to the lowest installed version', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');
    installManagedVersion('claude', '2.0.5');

    expect(resolveVersionAlias('claude', 'oldest')).toBe('2.0.0');
  });

  it('returns undefined for default/empty', () => {
    expect(resolveVersionAlias('claude', 'default')).toBeUndefined();
    expect(resolveVersionAlias('claude', '')).toBeUndefined();
    expect(resolveVersionAlias('claude', undefined)).toBeUndefined();
  });

  it('passes an installed explicit version through unchanged', () => {
    installManagedVersion('codex', '0.1.0');
    installManagedVersion('codex', '0.2.0');

    expect(resolveVersionAlias('codex', '0.1.0')).toBe('0.1.0');
  });
});

describe('resolveVersionAliasLoose', () => {
  it('resolves "oldest" to the lowest installed version', () => {
    installManagedVersion('codex', '0.1.0');
    installManagedVersion('codex', '0.2.0');

    expect(resolveVersionAliasLoose('codex', 'oldest')).toBe('0.1.0');
  });

  it('resolves "latest" to the highest installed version', () => {
    installManagedVersion('codex', '0.1.0');
    installManagedVersion('codex', '0.2.0');

    expect(resolveVersionAliasLoose('codex', 'latest')).toBe('0.2.0');
  });

  it('returns undefined for "oldest"/"latest" when nothing is installed', () => {
    expect(resolveVersionAliasLoose('codex', 'oldest')).toBeUndefined();
    expect(resolveVersionAliasLoose('codex', 'latest')).toBeUndefined();
  });

  it('passes uninstalled explicit versions through unchanged', () => {
    expect(resolveVersionAliasLoose('codex', '9.9.9')).toBe('9.9.9');
  });
});

describe('resolveAgentVersionTargets', () => {
  it('targets the newest installed version for a bare agent with no default', () => {
    installManagedVersion('codex', '0.1.0');
    installManagedVersion('codex', '0.2.0');

    const result = resolveAgentVersionTargets('codex', ['codex']);

    expect(result.selectedAgents).toEqual(['codex']);
    expect(result.versionSelections.get('codex')).toEqual(['0.2.0']);
  });

  it('targets only the requested explicit version', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');

    const result = resolveAgentVersionTargets('claude@2.0.0', ['claude']);

    expect(result.selectedAgents).toEqual(['claude']);
    expect(result.versionSelections.get('claude')).toEqual(['2.0.0']);
  });

  it('resolves agent@default from the configured default version', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');
    META = { agents: { claude: '2.1.0' } };
    hoistedState.META = META;

    const result = resolveAgentVersionTargets('claude@default', ['claude']);

    expect(result.selectedAgents).toEqual(['claude']);
    expect(result.versionSelections.get('claude')).toEqual(['2.1.0']);
  });

  it('keeps explicit versions when all-versions mode is enabled', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');

    const result = resolveAgentVersionTargets('claude@2.0.0', ['claude'], { allVersions: true });

    expect(result.versionSelections.get('claude')).toEqual(['2.0.0']);
  });
});

describe('resolveInstalledAgentTargets', () => {
  it('routes bare unmanaged agents to direct homes', () => {
    const result = resolveInstalledAgentTargets('codex', ['codex']);

    expect(result.selectedAgents).toEqual(['codex']);
    expect(result.directAgents).toEqual(['codex']);
    expect(result.versionSelections.get('codex')).toBeUndefined();
  });

  it('routes explicit versions to managed homes', () => {
    installManagedVersion('codex', '0.1.0');
    installManagedVersion('codex', '0.2.0');

    const result = resolveInstalledAgentTargets('codex@0.2.0', ['codex']);

    expect(result.directAgents).toEqual([]);
    expect(result.versionSelections.get('codex')).toEqual(['0.2.0']);
  });

  it('keeps broad and exact targets together when both are requested', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');
    META = { agents: { claude: '2.1.0' } };
    hoistedState.META = META;

    const result = resolveInstalledAgentTargets('claude,claude@2.0.0', ['claude']);

    expect(result.versionSelections.get('claude')).toEqual(['2.1.0', '2.0.0']);
  });
});

describe('resolveConfiguredAgentTargets', () => {
  it('uses broad agents as default/newest managed targets', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');
    META = { agents: { claude: '2.1.0' } };
    hoistedState.META = META;

    const result = resolveConfiguredAgentTargets(['claude'], undefined, ['claude']);

    expect(result.versionSelections.get('claude')).toEqual(['2.1.0']);
  });

  it('merges configured exact version pins with broad agent targets', () => {
    installManagedVersion('claude', '2.0.0');
    installManagedVersion('claude', '2.1.0');
    META = { agents: { claude: '2.1.0' } };
    hoistedState.META = META;

    const result = resolveConfiguredAgentTargets(
      ['claude'],
      { claude: ['2.0.0'] },
      ['claude'],
    );

    expect(result.versionSelections.get('claude')).toEqual(['2.1.0', '2.0.0']);
  });
});

describe('compareVersions', () => {
  it('sorts by major version', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('sorts by minor version', () => {
    expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0);
  });

  it('sorts by patch version', () => {
    expect(compareVersions('1.0.2', '1.0.1')).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('handles versions with different segment counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0);
  });

  it('handles non-numeric segments gracefully', () => {
    // parseInt('beta', 10) returns NaN -> || 0 makes it 0
    expect(compareVersions('1.0.beta', '1.0.0')).toBe(0);
  });
});

describe('getNewResources', () => {
  it('returns all resources when nothing synced', () => {
    const available: AvailableResources = {
      commands: ['debug', 'plan'],
      skills: ['mq'],
      hooks: ['pre-commit.sh'],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
      subagents: ['researcher'],
      plugins: ['my-plugin'],
      workflows: [],
      promptcuts: false,
    };
    const synced = emptyResources();

    const diff = getNewResources(available, synced);
    expect(diff).toEqual(available);
  });

  it('returns only unsynced resources', () => {
    const available: AvailableResources = {
      commands: ['debug', 'plan', 'clean'],
      skills: ['mq', 'browser'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm', 'NewMCP'],
      permissions: ['01-core', '02-node'],
      subagents: ['researcher', 'writer'],
      plugins: ['p1', 'p2'],
      workflows: [],
      promptcuts: false,
    };
    const synced: AvailableResources = {
      commands: ['debug'],
      skills: ['mq'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
      subagents: ['researcher'],
      plugins: ['p1'],
      workflows: [],
      promptcuts: false,
    };

    const diff = getNewResources(available, synced);
    expect(diff.commands).toEqual(['plan', 'clean']);
    expect(diff.skills).toEqual(['browser']);
    expect(diff.hooks).toEqual([]);
    expect(diff.memory).toEqual([]);
    expect(diff.mcp).toEqual(['NewMCP']);
    expect(diff.permissions).toEqual(['02-node']);
    expect(diff.subagents).toEqual(['writer']);
    expect(diff.plugins).toEqual(['p2']);
  });

  it('returns empty when everything synced', () => {
    const resources: AvailableResources = {
      commands: ['a'],
      skills: ['b'],
      hooks: ['c'],
      memory: ['d'],
      mcp: ['e'],
      permissions: ['f'],
      subagents: ['g'],
      plugins: ['h'],
      workflows: [],
      promptcuts: false,
    };
    const diff = getNewResources(resources, resources);
    expect(diff).toEqual(emptyResources());
  });

  it('excludes project-only entries for kinds that sync intentionally skips', () => {
    // Regression for the "infinite New resources prompt" bug. The available
    // set unions project + user + system layers, but syncResourcesToVersion
    // intentionally excludes the project layer for security on commands,
    // skills, hooks, subagents, plugins, and workflows — so those project-only
    // names would otherwise re-appear as "new" on every run.
    const available: AvailableResources = {
      commands: ['debug', 'project-only-cmd'],
      skills: ['mq', 'project-only-skill'],
      hooks: ['00-shared.sh', 'project-only-hook.sh'],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
      subagents: ['researcher', 'project-only-sub'],
      plugins: ['plug', 'project-only-plug'],
      workflows: ['flow', 'project-only-flow'],
      promptcuts: false,
    };
    const synced = emptyResources();
    const projectOnly = {
      commands: new Set(['project-only-cmd']),
      skills: new Set(['project-only-skill']),
      hooks: new Set(['project-only-hook.sh']),
      subagents: new Set(['project-only-sub']),
      plugins: new Set(['project-only-plug']),
      workflows: new Set(['project-only-flow']),
    };

    const diff = getNewResources(available, synced, projectOnly);
    expect(diff.commands).toEqual(['debug']);
    expect(diff.skills).toEqual(['mq']);
    expect(diff.hooks).toEqual(['00-shared.sh']);
    expect(diff.subagents).toEqual(['researcher']);
    expect(diff.plugins).toEqual(['plug']);
    expect(diff.workflows).toEqual(['flow']);
    // MCP and permissions are unaffected by the project-layer exclusion.
    expect(diff.mcp).toEqual(['Swarm']);
    expect(diff.permissions).toEqual(['01-core']);
  });
});

describe('hasNewResources', () => {
  it('returns false for empty diff', () => {
    expect(hasNewResources(emptyResources())).toBe(false);
  });

  it('returns true when skills are present (always applies)', () => {
    const diff = { ...emptyResources(), skills: ['mq'] };
    expect(hasNewResources(diff)).toBe(true);
    // Skills apply to ALL agents
    expect(hasNewResources(diff, 'openclaw')).toBe(true);
    expect(hasNewResources(diff, 'claude')).toBe(true);
  });

  it('filters commands by agent capability', () => {
    const diff = { ...emptyResources(), commands: ['debug'] };
    // claude supports commands
    expect(hasNewResources(diff, 'claude')).toBe(true);
    // openclaw does NOT support commands
    expect(hasNewResources(diff, 'openclaw')).toBe(false);
  });

  it('filters hooks by agent capability', () => {
    const diff = { ...emptyResources(), hooks: ['pre-commit.sh'] };
    // claude supports hooks
    expect(hasNewResources(diff, 'claude')).toBe(true);
    // codex now supports hooks (version-gate applies at sync time, not here)
    expect(hasNewResources(diff, 'codex')).toBe(true);
    // cursor supports hooks (CLI since 2026-01-16)
    expect(hasNewResources(diff, 'cursor')).toBe(true);
    // amp does NOT support hooks
    expect(hasNewResources(diff, 'amp')).toBe(false);
  });

  it('filters memory by commands capability (same gate)', () => {
    const diff = { ...emptyResources(), memory: ['AGENTS'] };
    // claude supports commands -> memory applies
    expect(hasNewResources(diff, 'claude')).toBe(true);
    // openclaw does NOT support commands -> memory skipped
    expect(hasNewResources(diff, 'openclaw')).toBe(false);
  });

  it('filters MCP by agent capability', () => {
    const diff = { ...emptyResources(), mcp: ['Swarm'] };
    // All agents support MCP
    expect(hasNewResources(diff, 'claude')).toBe(true);
    expect(hasNewResources(diff, 'openclaw')).toBe(true);
  });

  it('filters permissions by agent capability', () => {
    const diff = { ...emptyResources(), permissions: ['01-core'] };
    // claude supports permissions
    expect(hasNewResources(diff, 'claude')).toBe(true);
    // cursor supports permissions (cli-config.json allowlist)
    expect(hasNewResources(diff, 'cursor')).toBe(true);
    // amp does NOT support permissions
    expect(hasNewResources(diff, 'amp')).toBe(false);
  });

  it('filters plugins by agent capability', () => {
    const diff = { ...emptyResources(), plugins: ['my-plugin'] };
    // claude supports plugins
    expect(hasNewResources(diff, 'claude')).toBe(true);
    // codex supports plugins from 0.128.0 onward
    expect(hasNewResources(diff, 'codex')).toBe(true);
    expect(hasNewResources(diff, 'codex', '0.127.0')).toBe(false);
    expect(hasNewResources(diff, 'codex', '0.128.0')).toBe(true);
  });

  it('without agent param, all resource types count', () => {
    expect(hasNewResources({ ...emptyResources(), commands: ['a'] })).toBe(true);
    expect(hasNewResources({ ...emptyResources(), hooks: ['a'] })).toBe(true);
    expect(hasNewResources({ ...emptyResources(), plugins: ['a'] })).toBe(true);
  });
});


// ============================================================
// Path helper tests
// ============================================================

describe('version path helpers', () => {
  it('getVersionDir returns correct path', () => {
    const dir = getVersionDir('claude', '2.0.65');
    expect(dir).toBe(path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65'));
  });

  it('getBinaryPath returns correct binary location', () => {
    const bin = getBinaryPath('claude', '2.0.65');
    expect(toPosix(bin)).toContain('node_modules/.bin/claude');
  });

  it('getBinaryPath for muse is the global self-updating launcher (any version)', () => {
    // Muse installs once under ~/.local/bin/muse (or %USERPROFILE%\bin\muse.exe).
    // Version dirs must resolve to the same path so isGlobalBinaryAgent is true
    // and agents view / isVersionInstalled see the real binary after import.
    const a = getBinaryPath('muse', '0.1.0');
    const b = getBinaryPath('muse', '9.9.9');
    expect(a).toBe(b);
    expect(toPosix(a)).toMatch(/\/(\.local\/bin\/muse|bin\/muse\.exe)$/);
  });

  it('getVersionHomePath returns home subdir', () => {
    const home = getVersionHomePath('claude', '2.0.65');
    expect(toPosix(home).endsWith('/home')).toBe(true);
  });
});


// ============================================================
// getAvailableResources (filesystem-based with mocked dirs)
// ============================================================

describe('getAvailableResources', () => {
  it('finds commands from *.md files', () => {
    const commandsDir = path.join(AGENTS_DIR, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'debug.md'), '---\ndescription: Debug\n---\nDebug prompt');
    fs.writeFileSync(path.join(commandsDir, 'plan.md'), '---\ndescription: Plan\n---\nPlan prompt');
    fs.writeFileSync(path.join(commandsDir, 'notes.txt'), 'not a command');

    const resources = getAvailableResources();
    expect(resources.commands).toContain('debug');
    expect(resources.commands).toContain('plan');
    expect(resources.commands).not.toContain('notes');
  });

  it('finds skills as directories', () => {
    const skillsDir = path.join(AGENTS_DIR, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'mq'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'browser'), { recursive: true });
    fs.mkdirSync(path.join(skillsDir, '.hidden'), { recursive: true }); // should be excluded
    fs.writeFileSync(path.join(skillsDir, 'file.md'), 'not a skill dir');

    const resources = getAvailableResources();
    expect(resources.skills).toContain('mq');
    expect(resources.skills).toContain('browser');
    expect(resources.skills).not.toContain('.hidden');
    expect(resources.skills.length).toBe(2);
  });

  it('finds hooks excluding hidden files', () => {
    const hooksDir = path.join(AGENTS_DIR, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit.sh'), '#!/bin/bash');
    fs.chmodSync(path.join(hooksDir, 'pre-commit.sh'), 0o755);
    fs.writeFileSync(path.join(hooksDir, '.hidden'), 'hidden');

    const resources = getAvailableResources();
    expect(resources.hooks).toContain('pre-commit.sh');
    expect(resources.hooks).not.toContain('.hidden');
  });

  it('lists rule preset names from rules.yaml', () => {
    const rulesDir = path.join(AGENTS_DIR, 'memory');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules: []\n  proactive:\n    subrules: []\n'
    );

    const resources = getAvailableResources();
    expect(resources.memory).toContain('default');
    expect(resources.memory).toContain('proactive');
  });

  it('finds MCP configs from *.yaml and *.yml', () => {
    const mcpDir = path.join(AGENTS_DIR, 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    // Valid MCP configs require name, transport, and transport-specific fields
    fs.writeFileSync(path.join(mcpDir, 'Swarm.yaml'), 'name: Swarm\ntransport: stdio\ncommand: swarm');
    fs.writeFileSync(path.join(mcpDir, 'Other.yml'), 'name: Other\ntransport: http\nurl: http://example.com');
    fs.writeFileSync(path.join(mcpDir, 'readme.txt'), 'not mcp');

    const resources = getAvailableResources();
    expect(resources.mcp).toContain('Swarm');
    expect(resources.mcp).toContain('Other');
    expect(resources.mcp.length).toBe(2);
  });

  it('finds permission groups from permissions/groups/*.yaml', () => {
    const groupsDir = path.join(AGENTS_DIR, 'permissions', 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.writeFileSync(path.join(groupsDir, '01-core.yaml'), 'allow: []');
    fs.writeFileSync(path.join(groupsDir, '02-node.yml'), 'allow: []');

    const resources = getAvailableResources();
    expect(resources.permissions).toContain('01-core');
    expect(resources.permissions).toContain('02-node');
  });

  it('finds subagents with AGENT.md', () => {
    const subagentsDir = path.join(AGENTS_DIR, 'subagents');
    fs.mkdirSync(path.join(subagentsDir, 'researcher'), { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'researcher', 'AGENT.md'), '# Researcher');
    // Directory without AGENT.md should be excluded
    fs.mkdirSync(path.join(subagentsDir, 'incomplete'), { recursive: true });

    const resources = getAvailableResources();
    expect(resources.subagents).toContain('researcher');
    expect(resources.subagents).not.toContain('incomplete');
  });

  it('returns empty arrays when directories do not exist', () => {
    // AGENTS_DIR exists but no subdirectories
    const resources = getAvailableResources();
    expect(resources.commands).toEqual([]);
    expect(resources.skills).toEqual([]);
    expect(resources.hooks).toEqual([]);
    expect(resources.memory).toEqual([]);
    expect(resources.mcp).toEqual([]);
    expect(resources.permissions).toEqual([]);
    expect(resources.subagents).toEqual([]);
    expect(resources.plugins).toEqual([]);
  });

  it('discovers resources from project .agents directory', () => {
    const projectAgents = path.join(TEST_ROOT, 'repo', '.agents');
    fs.mkdirSync(path.join(projectAgents, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(projectAgents, 'commands', 'proj.md'), '# Project command');
    PROJECT_AGENTS_DIR = projectAgents;
    hoistedState.PROJECT_AGENTS_DIR = PROJECT_AGENTS_DIR;

    const resources = getAvailableResources();
    expect(resources.commands).toContain('proj');
  });
});


// ============================================================
// syncResourcesToVersion (the critical function)
// ============================================================

describe('syncResourcesToVersion', () => {
  function setupCentralResources() {
    // Commands
    const commandsDir = path.join(AGENTS_DIR, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'debug.md'), '---\ndescription: Debug things\n---\nDebug prompt with $ARGUMENTS');
    fs.writeFileSync(path.join(commandsDir, 'plan.md'), '---\ndescription: Plan things\n---\nPlan prompt');

    // Skills
    const skillsDir = path.join(AGENTS_DIR, 'skills');
    fs.mkdirSync(path.join(skillsDir, 'mq'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'mq', 'SKILL.md'), '---\nname: mq\n---\nMQ skill');
    fs.mkdirSync(path.join(skillsDir, 'mq', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'mq', 'rules', 'rule1.md'), 'Rule 1 content');

    // Hooks
    const hooksDir = path.join(AGENTS_DIR, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit.sh'), '#!/bin/bash\necho "pre-commit"');
    fs.chmodSync(path.join(hooksDir, 'pre-commit.sh'), 0o755);

    // Rules — composer-model layout: subrules/ + rules.yaml. The state mock
    // points all rules-dir getters at <AGENTS_DIR>/memory, so we write here.
    const rulesDir = path.join(AGENTS_DIR, 'memory');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), '# Agent Instructions\nDo good work.');
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'soul.md'), '# Soul\nBe kind.');
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules: [core, soul]\n'
    );

    // Version home
    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });
    return versionHome;
  }

  describe('commands syncing', () => {
    it('copies markdown commands for claude', () => {
      setupCentralResources();

      const result = syncResourcesToVersion('claude', '2.0.65');

      const versionHome = getVersionHomePath('claude', '2.0.65');
      const commandsDir = path.join(versionHome, '.claude', 'commands');
      expect(result.commands).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'debug.md'))).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'plan.md'))).toBe(true);
      // Content should match source
      const content = fs.readFileSync(path.join(commandsDir, 'debug.md'), 'utf-8');
      expect(content).toContain('Debug prompt');
    });

    it('skips commands for agents without command capability', () => {
      setupCentralResources();
      const versionHome = path.join(AGENTS_DIR, 'versions', 'openclaw', '1.0.0', 'home');
      fs.mkdirSync(versionHome, { recursive: true });

      const result = syncResourcesToVersion('openclaw', '1.0.0');
      expect(result.commands).toBe(false);
    });

    it('syncs only selected commands', () => {
      setupCentralResources();

      const selection: ResourceSelection = { commands: ['debug'] };
      const result = syncResourcesToVersion('claude', '2.0.65', selection);

      const commandsDir = path.join(getVersionHomePath('claude', '2.0.65'), '.claude', 'commands');
      expect(result.commands).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'debug.md'))).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'plan.md'))).toBe(false);
    });

    it('handles selection = "all" correctly', () => {
      setupCentralResources();

      const selection: ResourceSelection = { commands: 'all' };
      const result = syncResourcesToVersion('claude', '2.0.65', selection);

      const commandsDir = path.join(getVersionHomePath('claude', '2.0.65'), '.claude', 'commands');
      expect(result.commands).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'debug.md'))).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'plan.md'))).toBe(true);
    });

    it('skips missing source files gracefully', () => {
      setupCentralResources();

      // Request a command that does not exist
      const selection: ResourceSelection = { commands: ['nonexistent', 'debug'] };
      const result = syncResourcesToVersion('claude', '2.0.65', selection);

      const commandsDir = path.join(getVersionHomePath('claude', '2.0.65'), '.claude', 'commands');
      expect(result.commands).toBe(true); // debug was synced
      expect(fs.existsSync(path.join(commandsDir, 'debug.md'))).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'nonexistent.md'))).toBe(false);
    });

    it('ignores project commands and uses the user/system layer (security defense)', () => {
      // The project `.agents/commands/` layer is intentionally excluded from
      // sync — a cloned public repo could ship a malicious command body that
      // fires when the user invokes the slash command. See commit 1cc35b14.
      // The resolveResource API still surfaces project commands (so `agents
      // commands list` and friends can show them) but the sync pipeline used
      // by the shim only materializes user/system content. This test pins
      // that contract.
      setupCentralResources();
      const projectAgents = path.join(TEST_ROOT, 'project', '.agents');
      fs.mkdirSync(path.join(projectAgents, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(projectAgents, 'commands', 'debug.md'),
        '# Project debug — must NOT land in version home'
      );
      PROJECT_AGENTS_DIR = projectAgents;
      hoistedState.PROJECT_AGENTS_DIR = PROJECT_AGENTS_DIR;
      const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
      fs.mkdirSync(versionHome, { recursive: true });

      syncResourcesToVersion('claude', '2.0.65', undefined, { projectDir: projectAgents, cwd: path.dirname(projectAgents) });

      // debug.md lands because setupCentralResources() planted it in the user
      // layer (line 701, body 'Debug things' / 'Debug prompt with $ARGUMENTS').
      // The synced body must be the user-layer one, not the project marker —
      // that proves the project layer was skipped.
      const commandsDir = path.join(getVersionHomePath('claude', '2.0.65'), '.claude', 'commands');
      const content = fs.readFileSync(path.join(commandsDir, 'debug.md'), 'utf-8');
      expect(content).toContain('Debug things');
      expect(content).not.toContain('Project debug — must NOT land in version home');
    });

    it('empty selection syncs nothing', () => {
      setupCentralResources();

      const selection: ResourceSelection = { commands: [] };
      const result = syncResourcesToVersion('claude', '2.0.65', selection);
      expect(result.commands).toBe(false);
    });
  });

  describe('skills syncing', () => {
    it('copies skill directory recursively', () => {
      setupCentralResources();

      const result = syncResourcesToVersion('claude', '2.0.65');

      const versionHome = getVersionHomePath('claude', '2.0.65');
      const skillDir = path.join(versionHome, '.claude', 'skills', 'mq');
      expect(result.skills).toBe(true);
      expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(skillDir, 'rules', 'rule1.md'))).toBe(true);
      // Content should match
      const content = fs.readFileSync(path.join(skillDir, 'rules', 'rule1.md'), 'utf-8');
      expect(content).toBe('Rule 1 content');
    });

    it('replaces existing skill dir with fresh copy', () => {
      setupCentralResources();

      const versionHome = getVersionHomePath('claude', '2.0.65');
      const skillDir = path.join(versionHome, '.claude', 'skills', 'mq');
      fs.mkdirSync(skillDir, { recursive: true });
      // Write stale content
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'OLD CONTENT');
      fs.writeFileSync(path.join(skillDir, 'stale-file.txt'), 'should be removed');

      syncResourcesToVersion('claude', '2.0.65');

      // Should have fresh content
      expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('MQ skill');
      // Stale file should be gone
      expect(fs.existsSync(path.join(skillDir, 'stale-file.txt'))).toBe(false);
    });

    it('syncs only selected skills', () => {
      setupCentralResources();
      // Add a second skill
      const skillsDir = path.join(AGENTS_DIR, 'skills');
      fs.mkdirSync(path.join(skillsDir, 'browser'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'browser', 'SKILL.md'), '# Browser');

      const selection: ResourceSelection = { skills: ['mq'] };
      syncResourcesToVersion('claude', '2.0.65', selection);

      const versionHome = getVersionHomePath('claude', '2.0.65');
      expect(fs.existsSync(path.join(versionHome, '.claude', 'skills', 'mq', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(versionHome, '.claude', 'skills', 'browser'))).toBe(false);
    });

    it('replaces a parent skills symlink without deleting central skill files', () => {
      setupCentralResources();

      const centralSkillsDir = path.join(AGENTS_DIR, 'skills');
      const versionHome = getVersionHomePath('claude', '2.0.65');
      const versionSkillsDir = path.join(versionHome, '.claude', 'skills');
      fs.mkdirSync(path.dirname(versionSkillsDir), { recursive: true });
      fs.symlinkSync(centralSkillsDir, versionSkillsDir);

      syncResourcesToVersion('claude', '2.0.65', { skills: ['mq'] });

      expect(fs.existsSync(path.join(centralSkillsDir, 'mq', 'SKILL.md'))).toBe(true);
      expect(fs.lstatSync(versionSkillsDir).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(versionSkillsDir, 'mq', 'SKILL.md'))).toBe(true);
    });
  });

  describe('hooks syncing', () => {
    it('copies hooks and preserves executable permission for claude', () => {
      setupCentralResources();

      const result = syncResourcesToVersion('claude', '2.0.65');

      const versionHome = getVersionHomePath('claude', '2.0.65');
      const hookFile = path.join(versionHome, '.claude', 'hooks', 'pre-commit.sh');
      expect(result.hooks).toBe(true);
      expect(fs.existsSync(hookFile)).toBe(true);
      // Check executable permission — Windows has no POSIX exec bit (statSync
      // mode does not carry 0o111), so the copy preserving it is only
      // observable on POSIX.
      if (!IS_WINDOWS) {
        const stat = fs.statSync(hookFile);
        expect(stat.mode & 0o111).toBeGreaterThan(0); // has execute bits
      }
    });

    it('skips hooks for codex versions below minimum floor', () => {
      setupCentralResources();
      const versionHome = path.join(AGENTS_DIR, 'versions', 'codex', '0.113.0', 'home');
      fs.mkdirSync(versionHome, { recursive: true });

      const result = syncResourcesToVersion('codex', '0.113.0');
      expect(result.hooks).toBe(false);
      expect(fs.existsSync(path.join(versionHome, '.codex', 'hooks'))).toBe(false);
    });
  });

  describe('memory syncing', () => {
    it('writes the composed rules file as the agent-specific instruction file for claude', () => {
      setupCentralResources();

      const result = syncResourcesToVersion('claude', '2.0.65');

      const versionHome = getVersionHomePath('claude', '2.0.65');
      // Composer writes a single instruction file per agent.
      expect(result.memory).toContain('CLAUDE.md');
      const content = fs.readFileSync(path.join(versionHome, '.claude', 'CLAUDE.md'), 'utf-8');
      // The default preset includes both subrules — both bodies should be inlined.
      expect(content).toContain('Agent Instructions');
      expect(content).toContain('Be kind');
    });

    it('inlines all subrules listed in the active preset', () => {
      setupCentralResources();

      syncResourcesToVersion('claude', '2.0.65');

      const versionHome = getVersionHomePath('claude', '2.0.65');
      const composed = fs.readFileSync(path.join(versionHome, '.claude', 'CLAUDE.md'), 'utf-8');
      // No per-subrule files are written — only the single composed file.
      expect(fs.existsSync(path.join(versionHome, '.claude', 'core.md'))).toBe(false);
      expect(fs.existsSync(path.join(versionHome, '.claude', 'SOUL.md'))).toBe(false);
      expect(composed).toContain('Do good work');
      expect(composed).toContain('Be kind');
    });

    it('writes openclaw rules to workspace/AGENTS.md (rules cap drives sync, not commands cap)', () => {
      // Previously gated on COMMANDS_CAPABLE_AGENTS, which silently skipped
      // openclaw even though it ships its own memory file. The registry now
      // dispatches off the `rules` capability — openclaw's `{ file:
      // 'workspace/AGENTS.md' }` writes correctly.
      setupCentralResources();
      const versionHome = path.join(AGENTS_DIR, 'versions', 'openclaw', '1.0.0', 'home');
      fs.mkdirSync(versionHome, { recursive: true });

      const result = syncResourcesToVersion('openclaw', '1.0.0');
      expect(result.memory).toEqual(['workspace/AGENTS.md']);
      expect(fs.existsSync(path.join(versionHome, '.openclaw', 'workspace', 'AGENTS.md'))).toBe(true);
    });

    it('overwrites existing instruction file', () => {
      setupCentralResources();
      const versionHome = getVersionHomePath('claude', '2.0.65');
      const claudeDir = path.join(versionHome, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'OLD INSTRUCTIONS');

      syncResourcesToVersion('claude', '2.0.65');

      const content = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('Agent Instructions');
      expect(content).not.toContain('OLD INSTRUCTIONS');
    });
  });

  describe('incremental sync (safe resource sync)', () => {
    it('does not remove existing commands when syncing new ones', () => {
      setupCentralResources();

      // First sync: sync only debug
      syncResourcesToVersion('claude', '2.0.65', { commands: ['debug'] });

      const versionHome = getVersionHomePath('claude', '2.0.65');
      const commandsDir = path.join(versionHome, '.claude', 'commands');
      expect(fs.existsSync(path.join(commandsDir, 'debug.md'))).toBe(true);

      // Second sync: sync only plan
      syncResourcesToVersion('claude', '2.0.65', { commands: ['plan'] });

      // Both should exist
      expect(fs.existsSync(path.join(commandsDir, 'debug.md'))).toBe(true);
      expect(fs.existsSync(path.join(commandsDir, 'plan.md'))).toBe(true);
    });

    it('does not remove existing skills when syncing new ones', () => {
      setupCentralResources();
      // Add second skill
      const skillsDir = path.join(AGENTS_DIR, 'skills');
      fs.mkdirSync(path.join(skillsDir, 'browser'), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'browser', 'SKILL.md'), '# Browser');

      // Sync mq first
      syncResourcesToVersion('claude', '2.0.65', { skills: ['mq'] });
      // Sync browser second
      syncResourcesToVersion('claude', '2.0.65', { skills: ['browser'] });

      const versionHome = getVersionHomePath('claude', '2.0.65');
      expect(fs.existsSync(path.join(versionHome, '.claude', 'skills', 'mq', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(versionHome, '.claude', 'skills', 'browser', 'SKILL.md'))).toBe(true);
    });
  });

  describe('SyncResult shape', () => {
    it('returns correct result structure', () => {
      setupCentralResources();

      const result = syncResourcesToVersion('claude', '2.0.65');

      expect(typeof result.commands).toBe('boolean');
      expect(typeof result.skills).toBe('boolean');
      expect(typeof result.hooks).toBe('boolean');
      expect(typeof result.permissions).toBe('boolean');
      expect(Array.isArray(result.memory)).toBe(true);
      expect(Array.isArray(result.mcp)).toBe(true);
      expect(Array.isArray(result.subagents)).toBe(true);
      expect(Array.isArray(result.plugins)).toBe(true);
    });

    it('returns all-false/empty when selection has empty arrays', () => {
      setupCentralResources();

      const selection: ResourceSelection = {
        commands: [],
        skills: [],
        hooks: [],
        memory: [],
        permissions: [],
        mcp: [],
        subagents: [],
        plugins: [],
      };
      const result = syncResourcesToVersion('claude', '2.0.65', selection);

      expect(result.commands).toBe(false);
      expect(result.skills).toBe(false);
      expect(result.hooks).toBe(false);
      expect(result.permissions).toBe(false);
      expect(result.memory).toEqual([]);
      expect(result.mcp).toEqual([]);
      expect(result.subagents).toEqual([]);
      expect(result.plugins).toEqual([]);
    });
  });
});

describe('installVersion', () => {
  it('rejects unsafe versions before creating install directories', async () => {
    const badVersion = '1.0.0;touch-pwned';

    await expect(installVersion('claude', badVersion)).rejects.toThrow(
      `Invalid version: ${JSON.stringify(badVersion)}`
    );

    expect(fs.existsSync(path.join(AGENTS_DIR, 'versions', 'claude'))).toBe(false);
  });

  it('runs configured external installers for non-npm agents and creates a version home', async () => {
    const original = AGENTS.antigravity.installScript;
    AGENTS.antigravity.installScript = 'true VERSION';

    try {
      const result = await installVersion('antigravity', '1.2.3');

      expect(result).toEqual({ success: true, installedVersion: '1.2.3' });
      expect(fs.existsSync(path.join(AGENTS_DIR, 'versions', 'antigravity', '1.2.3', 'home'))).toBe(true);
    } finally {
      AGENTS.antigravity.installScript = original;
    }
  });

  it.skipIf(IS_WINDOWS)('keeps a concrete self-updating install label while recording the current release', async () => {
    // A self-updating agent (no VERSION token in the installer) can't pin. A
    // network-free `true` installer stands in for the real curl/brew script.
    // A stub `agy` (antigravity's actual cliCommand — NOT the agent id) on
    // PATH lets the post-install version probe resolve for real (RUSH-1321's
    // own follow-up fix: installVersion no longer tolerates an unresolvable
    // probe by silently falling back to the literal string 'latest' — see
    // relocateGrokBinaryToVersionHome).
    const original = AGENTS.antigravity.installScript;
    AGENTS.antigravity.installScript = 'true';

    const fakeBinDir = path.join(TEST_ROOT, 'fakebin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const stub = path.join(fakeBinDir, 'agy');
    fs.writeFileSync(stub, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "antigravity 1.9.9"; exit 0; fi\nexit 0\n', 'utf-8');
    fs.chmodSync(stub, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;

    try {
      const result = await installVersion('antigravity', '1.2.3');

      expect(result.success).toBe(true);
      expect(result.installedVersion).toBe('1.2.3');
      expect(result.error ?? '').not.toContain('does not support version-pinned installs');
      const record = JSON.parse(fs.readFileSync(
        path.join(AGENTS_DIR, 'versions', 'antigravity', '1.2.3', 'installation.json'),
        'utf-8',
      ));
      expect(record.label).toBe('1.2.3');
      expect(record.releaseVersion).toBe('1.9.9');
    } finally {
      AGENTS.antigravity.installScript = original;
      process.env.PATH = originalPath;
    }
  });
});


// ============================================================
// getActuallySyncedResources
// ============================================================

describe('getActuallySyncedResources', () => {
  function setupVersionHome(agent: string, version: string) {
    const versionHome = path.join(AGENTS_DIR, 'versions', agent, version, 'home');
    const agentDir = path.join(versionHome, `.${agent}`);
    fs.mkdirSync(agentDir, { recursive: true });
    return { versionHome, agentDir };
  }

  it('detects synced commands in claude version home', () => {
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const commandsDir = path.join(agentDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'debug.md'), '# Debug');
    fs.writeFileSync(path.join(commandsDir, 'plan.md'), '# Plan');
    fs.writeFileSync(path.join(commandsDir, 'notes.txt'), 'not a command');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.commands).toContain('debug');
    expect(synced.commands).toContain('plan');
    expect(synced.commands).not.toContain('notes');
  });

  it('detects skills when content matches central source', () => {
    // Setup central skill
    const centralSkillDir = path.join(AGENTS_DIR, 'skills', 'mq');
    fs.mkdirSync(centralSkillDir, { recursive: true });
    fs.writeFileSync(path.join(centralSkillDir, 'SKILL.md'), '# MQ Skill v2');

    // Setup version skill with matching content
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const versionSkillDir = path.join(agentDir, 'skills', 'mq');
    fs.mkdirSync(versionSkillDir, { recursive: true });
    fs.writeFileSync(path.join(versionSkillDir, 'SKILL.md'), '# MQ Skill v2');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.skills).toContain('mq');
  });

  it('marks skill as NOT synced when content differs', () => {
    // Central has updated content
    const centralSkillDir = path.join(AGENTS_DIR, 'skills', 'mq');
    fs.mkdirSync(centralSkillDir, { recursive: true });
    fs.writeFileSync(path.join(centralSkillDir, 'SKILL.md'), '# MQ Skill v2 (updated)');

    // Version has stale content
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const versionSkillDir = path.join(agentDir, 'skills', 'mq');
    fs.mkdirSync(versionSkillDir, { recursive: true });
    fs.writeFileSync(path.join(versionSkillDir, 'SKILL.md'), '# MQ Skill v1 (stale)');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.skills).not.toContain('mq');
  });

  it('considers skill synced if no central source exists (user-local)', () => {
    // No central skill dir for "custom-skill"
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const versionSkillDir = path.join(agentDir, 'skills', 'custom-skill');
    fs.mkdirSync(versionSkillDir, { recursive: true });
    fs.writeFileSync(path.join(versionSkillDir, 'SKILL.md'), '# Custom');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.skills).toContain('custom-skill');
  });

  it('detects hooks when content matches central source', () => {
    // Central hook
    const centralHooksDir = path.join(AGENTS_DIR, 'hooks');
    fs.mkdirSync(centralHooksDir, { recursive: true });
    fs.writeFileSync(path.join(centralHooksDir, 'pre-commit.sh'), '#!/bin/bash\necho hook');

    // Version hook with same content
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const hooksDir = path.join(agentDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit.sh'), '#!/bin/bash\necho hook');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.hooks).toContain('pre-commit.sh');
  });

  it('marks hook as NOT synced when content differs', () => {
    const centralHooksDir = path.join(AGENTS_DIR, 'hooks');
    fs.mkdirSync(centralHooksDir, { recursive: true });
    fs.writeFileSync(path.join(centralHooksDir, 'pre-commit.sh'), '#!/bin/bash\necho v2');

    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const hooksDir = path.join(agentDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit.sh'), '#!/bin/bash\necho v1');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.hooks).not.toContain('pre-commit.sh');
  });

  it('reports the active preset as synced when the instruction file exists', () => {
    // Version home with composed CLAUDE.md present.
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), '# composed body');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    // Mock returns 'default' from getActiveRulesPreset.
    expect(synced.memory).toContain('default');
  });

  it('reports no synced rules when the instruction file is absent', () => {
    setupVersionHome('claude', '2.0.65');
    // No CLAUDE.md written — composer hasn't run.
    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.memory).toEqual([]);
  });

  it('detects subagents for claude', () => {
    const { agentDir } = setupVersionHome('claude', '2.0.65');
    const agentsDir = path.join(agentDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'researcher.md'), '# Researcher');

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.subagents).toContain('researcher');
  });

  it('returns empty arrays for version home that does not exist', () => {
    const synced = getActuallySyncedResources('claude', '99.99.99');
    expect(synced).toEqual(emptyResources());
  });
});


// ============================================================
// End-to-end: sync then detect
// ============================================================

describe('sync then detect roundtrip', () => {
  it('synced commands are detected as synced', () => {
    // Setup central commands
    const commandsDir = path.join(AGENTS_DIR, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'debug.md'), '# Debug');
    fs.writeFileSync(path.join(commandsDir, 'plan.md'), '# Plan');

    // Create version home
    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    // Sync
    syncResourcesToVersion('claude', '2.0.65', { commands: 'all' });

    // Detect
    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.commands).toContain('debug');
    expect(synced.commands).toContain('plan');
  });

  it('synced skills are detected as synced', () => {
    const skillsDir = path.join(AGENTS_DIR, 'skills', 'mq');
    fs.mkdirSync(path.join(skillsDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# MQ');
    fs.writeFileSync(path.join(skillsDir, 'rules', 'r1.md'), 'rule');

    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    syncResourcesToVersion('claude', '2.0.65', { skills: 'all' });

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.skills).toContain('mq');
  });

  it('synced rules surface in getActuallySyncedResources', () => {
    const rulesDir = path.join(AGENTS_DIR, 'memory');
    fs.mkdirSync(path.join(rulesDir, 'subrules'), { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'subrules', 'core.md'), '# Instructions');
    fs.writeFileSync(
      path.join(rulesDir, 'rules.yaml'),
      'presets:\n  default:\n    subrules: [core]\n'
    );

    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    syncResourcesToVersion('claude', '2.0.65', { memory: 'all' });

    // The composer wrote ~/.claude/CLAUDE.md — getActuallySyncedResources
    // should detect a synced instruction file at that path.
    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.memory.length).toBeGreaterThan(0);
  });

  it('synced hooks are detected as synced', () => {
    const hooksDir = path.join(AGENTS_DIR, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'check.sh'), '#!/bin/bash\necho check');
    fs.chmodSync(path.join(hooksDir, 'check.sh'), 0o755);

    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    syncResourcesToVersion('claude', '2.0.65', { hooks: 'all' });

    const synced = getActuallySyncedResources('claude', '2.0.65');
    expect(synced.hooks).toContain('check.sh');
  });

  it('getNewResources returns empty after full sync', () => {
    // Setup all resource types
    const commandsDir = path.join(AGENTS_DIR, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'debug.md'), '# Debug');

    const skillsDir = path.join(AGENTS_DIR, 'skills', 'mq');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# MQ');

    const hooksDir = path.join(AGENTS_DIR, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'check.sh'), '#!/bin/bash');

    const memoryDir = path.join(AGENTS_DIR, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'AGENTS.md'), '# Instructions');

    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    // Full sync (no selection = sync all)
    syncResourcesToVersion('claude', '2.0.65');

    // Check
    const available = getAvailableResources();
    const synced = getActuallySyncedResources('claude', '2.0.65');
    const newRes = getNewResources(available, synced);

    expect(newRes.commands).toEqual([]);
    expect(newRes.skills).toEqual([]);
    expect(newRes.hooks).toEqual([]);
    expect(newRes.memory).toEqual([]);
  });

  it('getNewResources shows unsynced resource after central update', () => {
    // Initial setup and sync
    const skillsDir = path.join(AGENTS_DIR, 'skills', 'mq');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# MQ v1');

    const versionHome = path.join(AGENTS_DIR, 'versions', 'claude', '2.0.65', 'home');
    fs.mkdirSync(versionHome, { recursive: true });

    syncResourcesToVersion('claude', '2.0.65', { skills: 'all' });

    // Update central source
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# MQ v2 (updated)');

    // Now the skill should show as "new" (needs re-sync)
    const available = getAvailableResources();
    const synced = getActuallySyncedResources('claude', '2.0.65');
    const newRes = getNewResources(available, synced);

    expect(newRes.skills).toContain('mq');
  });
});
