import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectKeyFromCwd, repoAgentsDirForCwd, repoRootForCwd, resolveProjectKey } from './project-key.js';
import { projectFromCwd } from './feed/activity.js';
import { overviewProjectKey } from '../commands/sessions.js';

describe('projectKeyFromCwd', () => {
  it('folds a worktree cwd to the repo it branched from', () => {
    expect(projectKeyFromCwd('/Users/m/src/agents-cli/.agents/worktrees/fix-thing')).toBe('agents-cli');
  });

  it('folds a subdirectory INSIDE a worktree to the same repo', () => {
    expect(projectKeyFromCwd('/Users/m/src/agents-cli/.agents/worktrees/fix-thing/cli')).toBe('agents-cli');
  });

  it('resolves a plain repo cwd to its basename', () => {
    expect(projectKeyFromCwd('/Users/m/src/agents-cli')).toBe('agents-cli');
  });

  it('normalizes windows separators and trailing slashes', () => {
    expect(projectKeyFromCwd('C:\\dev\\agents-cli\\.agents\\worktrees\\slug\\')).toBe('agents-cli');
    expect(projectKeyFromCwd('/Users/m/src/agents-cli///')).toBe('agents-cli');
  });

  it('returns undefined for nothing usable', () => {
    expect(projectKeyFromCwd(undefined)).toBeUndefined();
    expect(projectKeyFromCwd('')).toBeUndefined();
    expect(projectKeyFromCwd('/')).toBeUndefined();
    expect(projectKeyFromCwd('   ')).toBeUndefined();
  });

  it('does not fold when the worktree segment leads the path (no repo above it)', () => {
    expect(projectKeyFromCwd('/.agents/worktrees/slug')).toBe('slug');
  });

  it('agrees across the sessions overview and the activity timeline', () => {
    for (const cwd of [
      '/Users/m/src/agents-cli/.agents/worktrees/fix-thing',
      '/Users/m/src/agents-cli/.agents/worktrees/fix-thing/cli',
      '/Users/m/src/rush',
    ]) {
      expect(overviewProjectKey({ cwd })).toBe(projectKeyFromCwd(cwd));
      expect(projectFromCwd(cwd)).toBe(projectKeyFromCwd(cwd));
    }
  });
});

describe('repoAgentsDirForCwd (pure worktree fold — no filesystem)', () => {
  it('folds a worktree cwd to the PRIMARY repo .agents that holds the worktrees', () => {
    expect(repoAgentsDirForCwd('/Users/m/src/agents-cli/.agents/worktrees/fix-thing'))
      .toBe(path.join('/Users/m/src/agents-cli', '.agents'));
  });

  it('folds a subdirectory inside a worktree to the same primary .agents', () => {
    expect(repoAgentsDirForCwd('/Users/m/src/agents-cli/.agents/worktrees/fix-thing/cli/dist'))
      .toBe(path.join('/Users/m/src/agents-cli', '.agents'));
  });

  it('returns undefined for nothing usable', () => {
    expect(repoAgentsDirForCwd(undefined)).toBeUndefined();
    expect(repoAgentsDirForCwd('')).toBeUndefined();
    expect(repoAgentsDirForCwd('   ')).toBeUndefined();
  });
});

describe('repoRootForCwd / resolveProjectKey (a cwd on this machine)', () => {
  let tmp: string;
  let home: string;
  let repo: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-project-key-'));
    home = path.join(tmp, 'home');
    repo = path.join(home, 'src', 'agents-cli');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'apps', 'cli', 'src'), { recursive: true });
    const wt = path.join(repo, '.agents', 'worktrees', 'fix-thing', 'apps');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(repo, '.agents', 'worktrees', 'fix-thing', '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'fix-thing')}\n`);
    fs.mkdirSync(path.join(home, 'src', 'github.com', 'someone'), { recursive: true });
  });

  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds the repo root from a deep subdirectory', () => {
    expect(repoRootForCwd(path.join(repo, 'apps', 'cli', 'src'), home)).toBe(repo);
  });

  it('files a monorepo subdirectory under the REPO, not the leaf dir', () => {
    expect(resolveProjectKey(path.join(repo, 'apps', 'cli'), home)).toBe('agents-cli');
    expect(projectKeyFromCwd(path.join(repo, 'apps', 'cli'))).toBe('cli');
  });

  it('folds a linked worktree back into its repo', () => {
    expect(resolveProjectKey(path.join(repo, '.agents', 'worktrees', 'fix-thing', 'apps'), home))
      .toBe('agents-cli');
  });

  it('falls back to the directory itself when nothing above it is a repo', () => {
    const loose = path.join(home, 'src', 'github.com', 'someone');
    expect(repoRootForCwd(loose, home)).toBeUndefined();
    expect(resolveProjectKey(loose, home)).toBe('someone');
  });

  it('never lets a dotfiles repo at $HOME swallow every directory under it', () => {
    const dotfiles = path.join(home, '.git');
    fs.mkdirSync(dotfiles, { recursive: true });
    try {
      const loose = path.join(home, 'src', 'github.com', 'someone');
      expect(repoRootForCwd(loose, home)).toBeUndefined();
      expect(resolveProjectKey(loose, home)).toBe('someone');
      expect(resolveProjectKey(path.join(repo, 'apps'), home)).toBe('agents-cli');
    } finally {
      fs.rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  it('gives repoAgentsDirForCwd the repo .agents from a monorepo subdir', () => {
    expect(repoAgentsDirForCwd(path.join(repo, 'apps', 'cli', 'src'), home))
      .toBe(path.join(repo, '.agents'));
  });

  it('gives repoAgentsDirForCwd the PRIMARY .agents from inside a linked worktree', () => {
    expect(repoAgentsDirForCwd(path.join(repo, '.agents', 'worktrees', 'fix-thing', 'apps'), home))
      .toBe(path.join(repo, '.agents'));
  });

  it('resolves nothing for a path that does not exist here (another machine)', () => {
    expect(repoRootForCwd('/definitely/not/here/agents-cli', home)).toBeUndefined();
    expect(resolveProjectKey('/definitely/not/here/agents-cli', home)).toBe('agents-cli');
  });

  it('resolves nothing for an empty cwd', () => {
    expect(resolveProjectKey(undefined, home)).toBeUndefined();
    expect(resolveProjectKey('', home)).toBeUndefined();
  });
});
