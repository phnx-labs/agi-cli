import { describe, it, expect } from 'vitest';
import { checkRepoSlug } from './project-doctor.js';
import type { ProjectDef } from './projects.js';

const def = (over: Partial<ProjectDef> = {}): ProjectDef => ({ name: 'agents-cli', root: '~/src/agents-cli', ...over });

describe('checkRepoSlug', () => {
  it('flags the disagreement that silently reads the wrong repository', () => {
    const f = checkRepoSlug(def({ repo: 'muqsitnawaz/agents-cli' }), 'phnx-labs/agents-cli');
    expect(f?.message).toContain('repo is muqsitnawaz/agents-cli but origin is phnx-labs/agents-cli');
    expect(f?.message).toContain('wrong repository');
    expect(f?.remediation).toBe('agents projects set agents-cli --repo phnx-labs/agents-cli');
  });

  it('says nothing when they agree', () => {
    expect(checkRepoSlug(def({ repo: 'phnx-labs/agents-cli' }), 'phnx-labs/agents-cli')).toBeUndefined();
  });

  it('says nothing when this machine cannot read a remote', () => {
    expect(checkRepoSlug(def({ repo: 'phnx-labs/agents-cli' }), undefined)).toBeUndefined();
    expect(checkRepoSlug(def(), undefined)).toBeUndefined();
  });

  it('offers to adopt the remote when the def has no repo at all', () => {
    const f = checkRepoSlug(def(), 'phnx-labs/agents-cli');
    expect(f?.message).toBe('no repo set; origin is phnx-labs/agents-cli');
    expect(f?.remediation).toBe('agents projects set agents-cli --repo phnx-labs/agents-cli');
  });
});
