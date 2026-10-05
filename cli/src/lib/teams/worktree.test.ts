import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitsBehindDefault, createWorktree, localDefaultBranch, removeWorktree, worktreeCheckoutExists, worktreeExists } from './worktree.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.dev', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

describe('createWorktree base freshness', () => {
  let tmp: string;
  let bare: string;
  let clone: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-wt-')));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');

    git(tmp, ['init', '--bare', bare]);
    const seed = path.join(tmp, 'seed');
    git(tmp, ['clone', bare, seed]);
    git(seed, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(seed, 'base.txt'), 'A\n');
    git(seed, ['add', 'base.txt']);
    git(seed, ['commit', '-m', 'A']);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    git(tmp, ['clone', bare, clone]);
    try {
      git(clone, ['remote', 'set-head', 'origin', '--auto']);
    } catch {
    }
  }, 60_000);

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('localDefaultBranch resolves origin/HEAD to main', async () => {
    expect(await localDefaultBranch(clone)).toBe('main');
  });

  it('bases the worktree on origin/main, not a diverged local HEAD', async () => {
    const originMain = git(clone, ['rev-parse', 'origin/main']);

    fs.writeFileSync(path.join(clone, 'local-only.txt'), 'B\n');
    git(clone, ['add', 'local-only.txt']);
    git(clone, ['commit', '-m', 'B-local-only']);
    const localHead = git(clone, ['rev-parse', 'HEAD']);
    expect(localHead).not.toBe(originMain);

    const wt = await createWorktree(clone, 'teammate-a');
    try {
      const wtHead = git(wt, ['rev-parse', 'HEAD']);
      expect(wtHead).toBe(originMain);
      expect(wtHead).not.toBe(localHead);
      expect(fs.existsSync(path.join(wt, 'local-only.txt'))).toBe(false);
      expect(fs.existsSync(path.join(wt, 'base.txt'))).toBe(true);

      const branch = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
      expect(branch).toBe('agents/teammate-a');
    } finally {
      await removeWorktree(clone, 'teammate-a');
    }
  });

  it('picks up commits that landed on origin after the local clone went stale', async () => {
    const seed2 = path.join(tmp, 'seed2');
    git(tmp, ['clone', bare, seed2]);
    fs.writeFileSync(path.join(seed2, 'newer.txt'), 'fresh\n');
    git(seed2, ['add', 'newer.txt']);
    git(seed2, ['commit', '-m', 'C-on-origin']);
    git(seed2, ['push', 'origin', 'main']);
    const originAfter = git(seed2, ['rev-parse', 'HEAD']);

    const staleOrigin = git(clone, ['rev-parse', 'origin/main']);
    expect(staleOrigin).not.toBe(originAfter);

    const wt = await createWorktree(clone, 'teammate-b');
    try {
      const wtHead = git(wt, ['rev-parse', 'HEAD']);
      expect(wtHead).toBe(originAfter);
      expect(fs.existsSync(path.join(wt, 'newer.txt'))).toBe(true);
    } finally {
      await removeWorktree(clone, 'teammate-b');
    }
  });

  it('rejects invalid worktree names', async () => {
    await expect(createWorktree(clone, '../evil')).rejects.toThrow(/Invalid worktree name/);
  });

  it('never nests a new worktree inside another worktree, even when cwd is already inside one', async () => {
    const wtA = await createWorktree(clone, 'teammate-a');
    try {
      const wtB = await createWorktree(wtA, 'teammate-b');
      try {
        expect(wtB).toBe(path.join(clone, '.agents', 'worktrees', 'teammate-b'));
        expect(wtB.startsWith(wtA)).toBe(false);
        expect(fs.existsSync(path.join(wtA, '.agents', 'worktrees', 'teammate-b'))).toBe(false);
      } finally {
        await removeWorktree(clone, 'teammate-b');
      }
    } finally {
      await removeWorktree(clone, 'teammate-a');
    }
  });

  describe('worktreeExists', () => {
    it('false before anything is created, true once it is', async () => {
      expect(await worktreeExists(clone, 'probe-a')).toBe(false);
      await createWorktree(clone, 'probe-a');
      try {
        expect(await worktreeExists(clone, 'probe-a')).toBe(true);
      } finally {
        await removeWorktree(clone, 'probe-a');
      }
      expect(await worktreeExists(clone, 'probe-a')).toBe(false);
    });

    it('true for a branch with no checkout — the half-created state it exists to catch', async () => {
      git(clone, ['branch', 'agents/probe-b']);
      expect(fs.existsSync(path.join(clone, '.agents', 'worktrees', 'probe-b'))).toBe(false);
      expect(await worktreeExists(clone, 'probe-b')).toBe(true);
      expect(await worktreeCheckoutExists(clone, 'probe-b')).toBe(false);
    });

    it('worktreeCheckoutExists tracks only the directory, never the branch', async () => {
      expect(await worktreeCheckoutExists(clone, 'probe-d')).toBe(false);
      await createWorktree(clone, 'probe-d');
      try {
        expect(await worktreeCheckoutExists(clone, 'probe-d')).toBe(true);
      } finally {
        await removeWorktree(clone, 'probe-d');
      }
      expect(await worktreeCheckoutExists(clone, 'probe-d')).toBe(false);
    });

    it('answers for the MAIN repo from inside another worktree', async () => {
      const wt = await createWorktree(clone, 'probe-c');
      try {
        expect(await worktreeExists(wt, 'probe-c')).toBe(true);
        expect(await worktreeExists(wt, 'probe-none')).toBe(false);
      } finally {
        await removeWorktree(clone, 'probe-c');
      }
    });

    it('rejects invalid worktree names', async () => {
      await expect(worktreeExists(clone, '../evil')).rejects.toThrow(/Invalid worktree name/);
    });
  });
});

describe('commitsBehindDefault', () => {
  let tmp: string;
  let bare: string;
  let clone: string;

  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-behind-')));
    bare = path.join(tmp, 'remote.git');
    clone = path.join(tmp, 'clone');

    git(tmp, ['init', '--bare', bare]);
    const seed = path.join(tmp, 'seed');
    git(tmp, ['clone', bare, seed]);
    git(seed, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(seed, 'base.txt'), 'A\n');
    git(seed, ['add', 'base.txt']);
    git(seed, ['commit', '-m', 'A']);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    git(tmp, ['clone', bare, clone]);
    try {
      git(clone, ['remote', 'set-head', 'origin', '--auto']);
    } catch {
    }
  }, 60_000);

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function advanceOrigin(): void {
    const seed2 = path.join(tmp, 'seed2');
    git(tmp, ['clone', bare, seed2]);
    fs.writeFileSync(path.join(seed2, 'newer.txt'), 'fresh\n');
    git(seed2, ['add', 'newer.txt']);
    git(seed2, ['commit', '-m', 'C-on-origin']);
    git(seed2, ['push', 'origin', 'main']);
  }

  it('reports 0 behind for an up-to-date clone', async () => {
    const res = await commitsBehindDefault(clone);
    expect(res).toEqual({ behind: 0, base: 'main' });
  });

  it('reports the TRUE behind count even when the local tracking ref is stale (fetches first)', async () => {
    advanceOrigin();
    const staleView = git(clone, ['rev-list', '--count', 'HEAD..origin/main']);
    expect(staleView).toBe('0');

    const res = await commitsBehindDefault(clone);
    expect(res).toEqual({ behind: 1, base: 'main' });
  });

  it('reports 0 behind when the local checkout is AHEAD of origin (unpushed commits)', async () => {
    fs.writeFileSync(path.join(clone, 'local-only.txt'), 'B\n');
    git(clone, ['add', 'local-only.txt']);
    git(clone, ['commit', '-m', 'B-local-only']);
    const res = await commitsBehindDefault(clone);
    expect(res).toEqual({ behind: 0, base: 'main' });
  });

  it('returns null for a directory that is not a git repo', async () => {
    const plain = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(plain);
    expect(await commitsBehindDefault(plain)).toBeNull();
  });

  it('measures the passed linked worktree, not the main checkout', async () => {
    advanceOrigin();

    git(clone, ['fetch', 'origin']);
    const lw = path.join(tmp, 'shared-wt');
    git(clone, ['worktree', 'add', '-b', 'uptodate', lw, 'origin/main']);

    expect((await commitsBehindDefault(clone))?.behind).toBe(1);
    expect((await commitsBehindDefault(lw))?.behind).toBe(0);
  });
});
