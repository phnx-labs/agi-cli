import { describe, it, expect } from 'vitest';
import { staleRepoError } from './teams.js';

describe('staleRepoError', () => {
  const local = staleRepoError({
    team: 'wave',
    where: 'This checkout (/repo)',
    behind: 3,
    base: 'main',
    sync: 'git -C /repo merge --ff-only origin/main',
  });

  it('names how far behind, and which branch', () => {
    expect(local).toContain('3 commits behind origin/main');
  });

  it('instructs syncing with remote main and shows the sync command', () => {
    expect(local).toMatch(/bring it up to date with remote main/i);
    expect(local).toContain('git -C /repo merge --ff-only origin/main');
  });

  it('offers --confirm as the override', () => {
    expect(local).toContain('--confirm');
  });

  it('threads the team name into the re-run hint', () => {
    expect(local).toContain('agents teams add wave');
  });

  it('pluralizes a single commit correctly', () => {
    const one = staleRepoError({
      team: 'wave',
      where: 'This checkout (/repo)',
      behind: 1,
      base: 'main',
      sync: 'git -C /repo merge --ff-only origin/main',
    });
    expect(one).toContain('1 commit behind');
    expect(one).not.toContain('1 commits');
  });

  it('carries the remote host + ssh sync command for a --device teammate', () => {
    const remote = staleRepoError({
      team: 'wave',
      where: 'The repo on s1 (/home/u/.agents/repos/wave)',
      behind: 71,
      base: 'main',
      sync: "agents ssh s1 'git -C /home/u/.agents/repos/wave merge --ff-only origin/main'",
    });
    expect(remote).toContain('The repo on s1');
    expect(remote).toContain("agents ssh s1 'git -C /home/u/.agents/repos/wave merge --ff-only origin/main'");
  });
});
