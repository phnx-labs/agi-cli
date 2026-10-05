import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const LIVE = process.env.LIVE === '1';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  parsePackageIdentifier,
  getRegistries,
  getEnabledRegistries,
  setRegistry,
  removeRegistry,
  searchMcpRegistries,
  getMcpServerInfo,
  resolvePackage,
  search,
} from '../src/lib/registry.js';
import { DEFAULT_REGISTRIES } from '../src/lib/types.js';

const FIXTURES_DIR = join(tmpdir(), 'agents-cli-test-fixtures');

describe('parsePackageIdentifier', () => {
  it('parses mcp: prefix', () => {
    const result = parsePackageIdentifier('mcp:filesystem');
    expect(result).toEqual({ type: 'mcp', name: 'filesystem' });
  });

  it('parses mcp: prefix with org/name', () => {
    const result = parsePackageIdentifier('mcp:anthropics/mcp-server-git');
    expect(result).toEqual({ type: 'mcp', name: 'anthropics/mcp-server-git' });
  });

  it('parses skill: prefix', () => {
    const result = parsePackageIdentifier('skill:user/repo');
    expect(result).toEqual({ type: 'skill', name: 'user/repo' });
  });

  it('parses plugin: prefix (Phase 5 install umbrella)', () => {
    expect(parsePackageIdentifier('plugin:my-plugin@https://github.com/user/my-plugin.git')).toEqual({
      type: 'plugin',
      name: 'my-plugin@https://github.com/user/my-plugin.git',
    });
    expect(parsePackageIdentifier('plugin:~/Projects/rush-toolkit')).toEqual({
      type: 'plugin',
      name: '~/Projects/rush-toolkit',
    });
    expect(parsePackageIdentifier('plugin:')).toEqual({ type: 'plugin', name: '' });
  });

  it('parses gh: prefix as git', () => {
    const result = parsePackageIdentifier('gh:example-user/.agents');
    expect(result).toEqual({ type: 'git', name: 'gh:example-user/.agents' });
  });

  it('parses https:// URLs as git', () => {
    const result = parsePackageIdentifier('https://github.com/user/repo');
    expect(result).toEqual({ type: 'git', name: 'https://github.com/user/repo' });
  });

  it('parses git@ URLs as git', () => {
    const result = parsePackageIdentifier('git@github.com:user/repo.git');
    expect(result).toEqual({ type: 'git', name: 'git@github.com:user/repo.git' });
  });

  it('parses user/repo format as unknown', () => {
    const result = parsePackageIdentifier('user/repo');
    expect(result).toEqual({ type: 'unknown', name: 'user/repo' });
  });

  it('parses single word as unknown', () => {
    const result = parsePackageIdentifier('filesystem');
    expect(result).toEqual({ type: 'unknown', name: 'filesystem' });
  });
});

describe('DEFAULT_REGISTRIES', () => {
  it('has official MCP registry configured', () => {
    expect(DEFAULT_REGISTRIES.mcp.official).toBeDefined();
    expect(DEFAULT_REGISTRIES.mcp.official.url).toBe('https://registry.modelcontextprotocol.io/v0');
    expect(DEFAULT_REGISTRIES.mcp.official.enabled).toBe(true);
  });

  it('has empty skill registries (no public API)', () => {
    expect(DEFAULT_REGISTRIES.skill).toEqual({});
  });
});

describe('getRegistries', () => {
  it('returns default MCP registries', () => {
    const registries = getRegistries('mcp');
    expect(registries.official).toBeDefined();
    expect(registries.official.url).toBe('https://registry.modelcontextprotocol.io/v0');
  });

  it('returns registries for skill type (includes seeded hermes registry)', () => {
    const registries = getRegistries('skill');
    expect(typeof registries).toBe('object');
    for (const [, config] of Object.entries(registries)) {
      expect(config).toHaveProperty('url');
      expect(config).toHaveProperty('enabled');
    }
  });
});

describe('getEnabledRegistries', () => {
  it('returns only enabled registries', () => {
    const enabled = getEnabledRegistries('mcp');
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled.every((r) => r.config.enabled)).toBe(true);
  });

  it('returns array of enabled skill registries (hermes seeded on first run)', () => {
    const enabled = getEnabledRegistries('skill');
    expect(Array.isArray(enabled)).toBe(true);
    expect(enabled.every((r) => r.config.enabled)).toBe(true);
  });
});

describe.skipIf(!LIVE)('MCP Registry API (live)', () => {
  it('searches for servers', async () => {
    const results = await searchMcpRegistries('github', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results[0]).toHaveProperty('name');
      expect(results[0]).toHaveProperty('type', 'mcp');
      expect(results[0]).toHaveProperty('registry', 'official');
    }
  });

  it('returns empty array for non-existent query', async () => {
    const results = await searchMcpRegistries('xyznonexistent123456789');
    expect(Array.isArray(results)).toBe(true);
  });

  it('gets specific server info', async () => {
    const info = await getMcpServerInfo('filesystem');
    if (info) {
      expect(info).toHaveProperty('name');
    }
  });

  it('search: searches all registry types by default', async () => {
    const results = await search('github', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  it('search: filters by MCP type', async () => {
    const results = await search('github', { type: 'mcp', limit: 5 });
    expect(results.every((r) => r.type === 'mcp')).toBe(true);
  });

  it('resolvePackage: resolves mcp: prefix via registry', async () => {
    const result = await resolvePackage('mcp:filesystem');
    if (result) {
      expect(result.type).toBe('mcp');
    }
  });
});

describe.skipIf(!LIVE)('search (live)', () => {
  it('returns results for skill type when hermes registry is reachable', async () => {
    const results = await search('github', { type: 'skill', limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.every((r) => r.type === 'skill')).toBe(true);
  });
});

describe('resolvePackage', () => {
  it('resolves git source directly', async () => {
    const result = await resolvePackage('gh:user/repo');
    expect(result).toEqual({ type: 'git', source: 'gh:user/repo' });
  });

  it('resolves skill: prefix to git fallback', async () => {
    const result = await resolvePackage('skill:user/repo');
    expect(result).toEqual({ type: 'git', source: 'gh:user/repo' });
  });

  it('resolves plugin: to plugin package (does not hit registries)', async () => {
    const result = await resolvePackage('plugin:my-plugin@https://github.com/user/p.git');
    expect(result).toEqual({
      type: 'plugin',
      source: 'my-plugin@https://github.com/user/p.git',
      pluginSpec: 'my-plugin@https://github.com/user/p.git',
    });
  });

  it('returns null for empty plugin: spec', async () => {
    expect(await resolvePackage('plugin:')).toBeNull();
    expect(await resolvePackage('plugin:   ')).toBeNull();
  });

  it('resolves unknown user/repo to git fallback', async () => {
    const result = await resolvePackage('some-unknown-user/some-repo-123');
    expect(result).toEqual({ type: 'git', source: 'gh:some-unknown-user/some-repo-123' });
  });
});
