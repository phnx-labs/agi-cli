import { describe, expect, it } from 'vitest';
import { firstRunResourceCategories, wholeCategorySelection, type AvailableResources } from './versions.js';

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

  it('says what hooks and permissions do', () => {
    expect(byKey.hooks.displayCount).toContain('can block edits');
    expect(byKey.permissions.displayCount).toBe('2 groups, 189 rules; auto-approves commands such as git push, ssh and curl');
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
