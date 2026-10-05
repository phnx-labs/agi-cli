import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as yaml from 'yaml';


const TEST_DIR = join(tmpdir(), 'agents-cli-versions-sync-test');

describe('getActuallySyncedResources', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('detects commands in version home', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const commandsDir = join(versionHome, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'debug.md'), '# Debug command');
    writeFileSync(join(commandsDir, 'plan.md'), '# Plan command');
    writeFileSync(join(commandsDir, 'other.txt'), 'Not a command');

    const files = require('fs').readdirSync(commandsDir)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => f.replace(/\.md$/, ''));

    expect(files).toContain('debug');
    expect(files).toContain('plan');
    expect(files).not.toContain('other');
    expect(files.length).toBe(2);
  });

  it('considers a skill synced when content matches central source', () => {
    const centralSkillsDir = join(TEST_DIR, 'central-skills');
    const versionSkillsDir = join(TEST_DIR, 'claude-home', '.claude', 'skills');
    mkdirSync(join(centralSkillsDir, 'mq'), { recursive: true });
    mkdirSync(join(versionSkillsDir, 'mq'), { recursive: true });
    writeFileSync(join(centralSkillsDir, 'mq', 'SKILL.md'), '# MQ skill');
    writeFileSync(join(versionSkillsDir, 'mq', 'SKILL.md'), '# MQ skill');

    const centralContent = require('fs').readFileSync(join(centralSkillsDir, 'mq', 'SKILL.md'), 'utf-8');
    const versionContent = require('fs').readFileSync(join(versionSkillsDir, 'mq', 'SKILL.md'), 'utf-8');
    expect(centralContent).toBe(versionContent);
  });

  it('considers a skill NOT synced when content differs from central source', () => {
    const centralSkillsDir = join(TEST_DIR, 'central-skills');
    const versionSkillsDir = join(TEST_DIR, 'claude-home', '.claude', 'skills');
    mkdirSync(join(centralSkillsDir, 'sessions'), { recursive: true });
    mkdirSync(join(versionSkillsDir, 'sessions'), { recursive: true });
    writeFileSync(join(centralSkillsDir, 'sessions', 'SKILL.md'), '# Sessions v2 (updated)');
    writeFileSync(join(versionSkillsDir, 'sessions', 'SKILL.md'), '# Sessions v1 (stale)');

    const centralContent = require('fs').readFileSync(join(centralSkillsDir, 'sessions', 'SKILL.md'), 'utf-8');
    const versionContent = require('fs').readFileSync(join(versionSkillsDir, 'sessions', 'SKILL.md'), 'utf-8');
    expect(centralContent).not.toBe(versionContent);
  });

  it('ignores hidden directories in skills dir', () => {
    const versionSkillsDir = join(TEST_DIR, 'claude-home2', '.claude', 'skills');
    mkdirSync(join(versionSkillsDir, 'mq'), { recursive: true });
    mkdirSync(join(versionSkillsDir, '.hidden'), { recursive: true });
    writeFileSync(join(versionSkillsDir, '.hidden-file'), 'hidden');

    const dirs = require('fs').readdirSync(versionSkillsDir, { withFileTypes: true })
      .filter((d: any) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d: any) => d.name);

    expect(dirs).toContain('mq');
    expect(dirs).not.toContain('.hidden');
    expect(dirs.length).toBe(1);
  });

  it('detects permissions from settings.json allow array', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: {
        allow: ['Bash(git *)', 'Bash(npm *)', 'Read(**)'],
        deny: ['Bash(rm *)'],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const content = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const allowRules = content.permissions?.allow || [];

    expect(allowRules.length).toBe(3);
    expect(allowRules).toContain('Bash(git *)');
    expect(allowRules).toContain('Bash(npm *)');
    expect(allowRules).toContain('Read(**)');
  });

  it('returns empty permissions when settings.json has empty allow array', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settings = {
      permissions: {
        allow: [],
        deny: [],
      },
    };
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const content = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf-8'));
    const allowRules = content.permissions?.allow || [];

    expect(allowRules.length).toBe(0);
  });

  it('returns empty permissions when settings.json does not exist', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const claudeDir = join(versionHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, 'settings.json');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('detects hooks in version home', () => {
    const versionHome = join(TEST_DIR, 'claude-home');
    const hooksDir = join(versionHome, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit.sh'), '#!/bin/bash\necho "hook"');
    writeFileSync(join(hooksDir, 'post-build.py'), '#!/usr/bin/env python\nprint("hook")');
    writeFileSync(join(hooksDir, '.hidden'), 'hidden');

    const files = require('fs').readdirSync(hooksDir)
      .filter((f: string) => !f.startsWith('.'));

    expect(files).toContain('pre-commit.sh');
    expect(files).toContain('post-build.py');
    expect(files).not.toContain('.hidden');
    expect(files.length).toBe(2);
  });
});

describe('getNewResources', () => {
  it('returns all resources when nothing is synced', () => {
    const available = {
      commands: ['debug', 'plan', 'clean'],
      skills: ['mq', 'browser'],
      hooks: ['pre-commit.sh'],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core', '02-node'],
    };

    const synced = {
      commands: [],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: [],
    };

    const diff = {
      commands: available.commands.filter(c => !synced.commands.includes(c)),
      skills: available.skills.filter(s => !synced.skills.includes(s)),
      hooks: available.hooks.filter(h => !synced.hooks.includes(h)),
      memory: available.memory.filter(m => !synced.memory.includes(m)),
      mcp: available.mcp.filter(m => !synced.mcp.includes(m)),
      permissions: available.permissions.filter(p => !synced.permissions.includes(p)),
    };

    expect(diff.commands).toEqual(['debug', 'plan', 'clean']);
    expect(diff.skills).toEqual(['mq', 'browser']);
    expect(diff.hooks).toEqual(['pre-commit.sh']);
    expect(diff.memory).toEqual(['AGENTS']);
    expect(diff.mcp).toEqual(['Swarm']);
    expect(diff.permissions).toEqual(['01-core', '02-node']);
  });

  it('returns only new resources when some are already synced', () => {
    const available = {
      commands: ['debug', 'plan', 'clean', 'verify'],
      skills: ['mq', 'browser', 'new-skill'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm', 'NewMCP'],
      permissions: ['01-core', '02-node', '03-python', '99-deny'],
    };

    const synced = {
      commands: ['debug', 'plan'],
      skills: ['mq', 'browser'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core', '02-node'],
    };

    const diff = {
      commands: available.commands.filter(c => !synced.commands.includes(c)),
      skills: available.skills.filter(s => !synced.skills.includes(s)),
      hooks: available.hooks.filter(h => !synced.hooks.includes(h)),
      memory: available.memory.filter(m => !synced.memory.includes(m)),
      mcp: available.mcp.filter(m => !synced.mcp.includes(m)),
      permissions: available.permissions.filter(p => !synced.permissions.includes(p)),
    };

    expect(diff.commands).toEqual(['clean', 'verify']);
    expect(diff.skills).toEqual(['new-skill']);
    expect(diff.hooks).toEqual([]);
    expect(diff.memory).toEqual([]);
    expect(diff.mcp).toEqual(['NewMCP']);
    expect(diff.permissions).toEqual(['03-python', '99-deny']);
  });

  it('returns empty arrays when everything is already synced', () => {
    const available = {
      commands: ['debug', 'plan'],
      skills: ['mq'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
    };

    const synced = {
      commands: ['debug', 'plan'],
      skills: ['mq'],
      hooks: [],
      memory: ['AGENTS'],
      mcp: ['Swarm'],
      permissions: ['01-core'],
    };

    const diff = {
      commands: available.commands.filter(c => !synced.commands.includes(c)),
      skills: available.skills.filter(s => !synced.skills.includes(s)),
      hooks: available.hooks.filter(h => !synced.hooks.includes(h)),
      memory: available.memory.filter(m => !synced.memory.includes(m)),
      mcp: available.mcp.filter(m => !synced.mcp.includes(m)),
      permissions: available.permissions.filter(p => !synced.permissions.includes(p)),
    };

    expect(diff.commands).toEqual([]);
    expect(diff.skills).toEqual([]);
    expect(diff.hooks).toEqual([]);
    expect(diff.memory).toEqual([]);
    expect(diff.mcp).toEqual([]);
    expect(diff.permissions).toEqual([]);
  });
});

describe('hasNewResources', () => {
  it('returns true when there are new commands', () => {
    const diff = {
      commands: ['debug'],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: [],
    };

    const hasNew = Object.values(diff).some(arr => arr.length > 0);
    expect(hasNew).toBe(true);
  });

  it('returns true when there are new permissions', () => {
    const diff = {
      commands: [],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: ['01-core', '02-node'],
    };

    const hasNew = Object.values(diff).some(arr => arr.length > 0);
    expect(hasNew).toBe(true);
  });

  it('returns false when no new resources', () => {
    const diff = {
      commands: [],
      skills: [],
      hooks: [],
      memory: [],
      mcp: [],
      permissions: [],
    };

    const hasNew = Object.values(diff).some(arr => arr.length > 0);
    expect(hasNew).toBe(false);
  });
});

describe('permission group detection from allow rules', () => {
  it('detects which groups are applied based on matching rules', () => {
    const groupRules = {
      '01-core': ['Bash(cat /tmp:*)', 'Bash(ls /tmp:*)'],
      '02-node': ['Bash(npm:*)', 'Bash(node:*)', 'Bash(bun:*)'],
      '03-python': ['Bash(python:*)', 'Bash(pip:*)'],
    };

    const appliedRules = [
      'Bash(cat /tmp:*)',
      'Bash(ls /tmp:*)',
      'Bash(npm:*)',
      'Bash(node:*)',
      'Bash(bun:*)',
    ];

    const appliedGroups: string[] = [];
    for (const [groupName, rules] of Object.entries(groupRules)) {
      const hasRuleFromGroup = rules.some(rule => appliedRules.includes(rule));
      if (hasRuleFromGroup) {
        appliedGroups.push(groupName);
      }
    }

    expect(appliedGroups).toContain('01-core');
    expect(appliedGroups).toContain('02-node');
    expect(appliedGroups).not.toContain('03-python');
  });

  it('returns empty when no rules are applied', () => {
    const groupRules = {
      '01-core': ['Bash(cat /tmp:*)', 'Bash(ls /tmp:*)'],
      '02-node': ['Bash(npm:*)', 'Bash(node:*)'],
    };

    const appliedRules: string[] = [];

    const appliedGroups: string[] = [];
    for (const [groupName, rules] of Object.entries(groupRules)) {
      const hasRuleFromGroup = rules.some(rule => appliedRules.includes(rule));
      if (hasRuleFromGroup) {
        appliedGroups.push(groupName);
      }
    }

    expect(appliedGroups).toEqual([]);
  });
});
