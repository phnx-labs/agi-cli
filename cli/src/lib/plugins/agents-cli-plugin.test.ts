
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'yaml';
import { validateClaudePluginManifest } from './plugin-marketplace.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

const TRIGGER_INTENTS = [
  'run multiple coding agents in parallel',
  'manage multiple Claude Code accounts',
  'I hit my usage limit',
  'resume a session on another machine',
  'pin the agent CLI version',
];

function readJson(rel: string): Record<string, unknown> {
  const abs = path.join(REPO_ROOT, rel);
  expect(fs.existsSync(abs), `${rel} must exist`).toBe(true);
  return JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, unknown>;
}

function readFrontmatter(rel: string): Record<string, unknown> {
  const abs = path.join(REPO_ROOT, rel);
  expect(fs.existsSync(abs), `${rel} must exist`).toBe(true);
  const content = fs.readFileSync(abs, 'utf-8');
  const lines = content.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.slice(1).findIndex((l) => l === '---');
  expect(end, 'frontmatter must be closed').toBeGreaterThanOrEqual(0);
  return (yaml.parse(lines.slice(1, end + 1).join('\n')) ?? {}) as Record<string, unknown>;
}

describe('agents-cli discovery skill + plugin (PHNX-3337)', () => {
  it('plugin.json parses and passes the CLI plugin-manifest validator with no warnings', () => {
    const manifest = readJson('.claude-plugin/plugin.json');
    expect(manifest.name).toBe('agents-cli');
    expect(typeof manifest.description).toBe('string');
    expect((manifest.description as string).length).toBeGreaterThan(20);
    expect(typeof manifest.version).toBe('string');
    expect(validateClaudePluginManifest(manifest)).toEqual([]);
  });

  it('marketplace.json parses, names the agents-cli plugin, and every source resolves to a real plugin dir', () => {
    const market = readJson('.claude-plugin/marketplace.json');
    expect(market.name).toBe('agents-cli');

    const owner = market.owner as { name?: string } | undefined;
    expect(owner?.name, 'marketplace owner.name is required').toBeTruthy();

    const plugins = market.plugins as Array<Record<string, unknown>>;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins.length).toBeGreaterThan(0);

    const agentsCli = plugins.find((p) => p.name === 'agents-cli');
    expect(agentsCli, 'marketplace must list the agents-cli plugin').toBeTruthy();

    for (const p of plugins) {
      expect(typeof p.name, 'each plugin needs a name').toBe('string');
      const source = p.source;
      expect(typeof source, `plugin ${String(p.name)} needs a source path`).toBe('string');
      const pluginDir = path.resolve(REPO_ROOT, source as string);
      expect(fs.existsSync(path.join(pluginDir, '.claude-plugin', 'plugin.json')), `${String(source)}/.claude-plugin/plugin.json`).toBe(true);
      expect(fs.statSync(path.join(pluginDir, 'skills')).isDirectory(), `${String(source)}/skills/`).toBe(true);
    }
  });

  it('SKILL.md carries every literal trigger intent in its description', () => {
    const fm = readFrontmatter('skills/agents-cli/SKILL.md');
    expect(fm.name).toBe('agents-cli');
    const description = fm.description;
    expect(typeof description).toBe('string');
    for (const intent of TRIGGER_INTENTS) {
      expect(description as string, `description must contain trigger intent: "${intent}"`).toContain(intent);
    }
  });

  it('the plugin bundles the discovery skill as a discoverable SKILL.md', () => {
    const skillMd = path.join(REPO_ROOT, 'skills', 'agents-cli', 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);
    expect(fs.statSync(path.join(REPO_ROOT, 'skills')).isDirectory()).toBe(true);
  });
});
