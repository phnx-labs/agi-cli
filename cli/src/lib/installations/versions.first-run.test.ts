import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  declinedOptInPatterns,
  declinedResources,
  firstRunResourceCategories,
  getAvailableResources,
  getNewResources,
  reopenDeclinedOptIn,
  wholeCategorySelection,
  type AvailableResources,
} from './versions.js';
import { ensureVersionResourcePatterns, getUserAgentsDir, setVersionResourcePatterns } from '../state.js';
import { defaultPatterns } from '../resource-patterns.js';

const available: AvailableResources = {
  commands: ['review'],
  skills: ['plan', 'browser'],
  hooks: ['main-branch-guard', 'rm-guard'],
  memory: ['AGENTS.md'],
  mcp: ['linear'],
  permissions: ['01-core'],
  subagents: ['reviewer'],
  plugins: ['swarm'],
  workflows: [],
  promptcuts: false,
};

describe('firstRunResourceCategories', () => {
  const categories = firstRunResourceCategories('claude', available, [{ ruleCount: 143 }, { ruleCount: 46 }]);
  const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));

  it('leaves hooks and permissions unchecked on a first install', () => {
    expect(byKey.hooks).toMatchObject({ available: true, checked: false });
    expect(byKey.permissions).toMatchObject({ available: true, checked: false });
  });

  it('keeps the other resources checked', () => {
    for (const key of ['commands', 'skills', 'memory', 'mcp', 'subagents', 'plugins']) {
      expect(byKey[key], key).toMatchObject({ available: true, checked: true });
    }
  });
});

describe('wholeCategorySelection', () => {
  const categories = firstRunResourceCategories('claude', available, [{ ruleCount: 10 }]).filter((c) => c.available);
  const defaults = categories.filter((c) => c.checked).map((c) => c.key);

  it('syncs every checked category whole when the defaults are accepted, with no follow-up', () => {
    const selection = wholeCategorySelection(categories, defaults);
    expect(selection).not.toBeNull();
    expect(Object.keys(selection!).sort()).toEqual([...defaults].sort());
    expect(selection!.hooks).toBeUndefined();
    expect(selection!.permissions).toBeUndefined();
  });

  it('syncs everything whole when every category is picked', () => {
    const selection = wholeCategorySelection(categories, categories.map((c) => c.key));
    expect(selection).toMatchObject({ hooks: 'all', permissions: 'all', skills: 'all' });
  });

  it('asks per category for any other pick', () => {
    expect(wholeCategorySelection(categories, ['skills'])).toBeNull();
  });
});

describe('a declined opt-in stays declined', () => {
  const none: AvailableResources = {
    commands: [], skills: [], hooks: [], memory: [], mcp: [], permissions: [],
    subagents: [], plugins: [], workflows: [], promptcuts: false,
  };

  it('survives a later default-fill, is never offered as new, and an explicit add reopens it', () => {
    const hookDir = path.join(getUserAgentsDir(), 'hooks', 'pre-tool-use');
    fs.mkdirSync(hookDir, { recursive: true });
    const hookFile = path.join(hookDir, `guard-${Date.now()}.sh`);
    fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const live = getAvailableResources();
      expect(live.hooks.length).toBeGreaterThan(0);
      const version = `0.0.0-decline-${Date.now()}`;

      ensureVersionResourcePatterns('claude', version, { hooks: defaultPatterns([], false) });
      expect(declinedResources('claude', version, live).hooks.size).toBe(0);

      const categories = firstRunResourceCategories('claude', live, []).filter((c) => c.available);
      setVersionResourcePatterns('claude', version, declinedOptInPatterns(categories, { skills: 'all' }, []));
      ensureVersionResourcePatterns('claude', version, { hooks: defaultPatterns([], false) });

      const declined = declinedResources('claude', version, live);
      expect([...declined.hooks].sort()).toEqual([...live.hooks].sort());
      expect(getNewResources(live, none, undefined, declined).hooks).toEqual([]);
      expect(getNewResources(live, none).hooks.length).toBe(live.hooks.length);

      reopenDeclinedOptIn('claude', version, 'hooks');
      expect(declinedResources('claude', version, live).hooks.size).toBe(0);
    } finally {
      fs.rmSync(hookFile, { force: true });
    }
  });

  it('records negated defaults only for the opt-in categories left unpicked', () => {
    const categories = firstRunResourceCategories('claude', available, [{ ruleCount: 3 }]).filter((c) => c.available);
    expect(declinedOptInPatterns(categories, { skills: 'all' }, ['team'])).toEqual({
      hooks: ['!system:*', '!user:*', '!team:*'],
      permissions: ['!system:*'],
    });
    expect(declinedOptInPatterns(categories, { hooks: 'all', permissions: 'all' }, [])).toEqual({});
  });
});
