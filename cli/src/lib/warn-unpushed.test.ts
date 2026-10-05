import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUnpushedState, formatUnpushedWarning, warnUnpushedWork, shouldWarnUnpushed } from './warn-unpushed.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

function makeRepoWithRemote(): { work: string; commit: (subject: string) => void } {
  const remote = makeTempDir('warn-unpushed-remote-');
  git(remote, 'init', '--bare', '-b', 'main');
  const work = makeTempDir('warn-unpushed-work-');
  git(work, 'init', '-b', 'main');
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'remote', 'add', 'origin', remote);
  const commit = (subject: string) => {
    fs.writeFileSync(path.join(work, `f-${Date.now()}-${Math.round(performance.now())}.txt`), subject);
    git(work, 'add', '-A');
    git(work, 'commit', '-m', subject);
  };
  return { work, commit };
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('getUnpushedState', () => {
  it('reports a committed-but-unpushed branch, with no upstream', async () => {
    const { work, commit } = makeRepoWithRemote();
    commit('feat: first');

    const state = await getUnpushedState(work);
    expect(state.isRepo).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.hasUpstream).toBe(false);
    expect(state.unpushed.map((c) => c.subject)).toEqual(['feat: first']);
  });

  it('reports nothing once the branch is pushed (upstream set)', async () => {
    const { work, commit } = makeRepoWithRemote();
    commit('feat: first');
    git(work, 'push', '-u', 'origin', 'main');

    const state = await getUnpushedState(work);
    expect(state.hasUpstream).toBe(true);
    expect(state.unpushed).toEqual([]);
    expect(formatUnpushedWarning(state, work)).toBeNull();
  });

  it('does not false-positive when commits are on a remote ref but no upstream is set', async () => {
    const { work, commit } = makeRepoWithRemote();
    commit('feat: first');
    git(work, 'push', 'origin', 'main');
    git(work, 'fetch', 'origin');

    const state = await getUnpushedState(work);
    expect(state.hasUpstream).toBe(false);
    expect(state.unpushed).toEqual([]);
  });

  it('preserves commit subjects that contain spaces (no truncation)', async () => {
    const { work, commit } = makeRepoWithRemote();
    const subject = 'fix(cli): case-insensitive agent name match in resolvePackageIDWithRegistry';
    commit(subject);

    const state = await getUnpushedState(work);
    expect(state.unpushed).toHaveLength(1);
    expect(state.unpushed[0].subject).toBe(subject);
  });

  it('stays silent for a repo with no remote configured', async () => {
    const work = makeTempDir('warn-unpushed-noremote-');
    git(work, 'init', '-b', 'main');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(work, 'a.txt'), 'x');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'local only');

    const state = await getUnpushedState(work);
    expect(state.isRepo).toBe(true);
    expect(state.unpushed).toEqual([]);
  });

  it('returns an inert state for a non-git directory', async () => {
    const dir = makeTempDir('warn-unpushed-nogit-');
    const state = await getUnpushedState(dir);
    expect(state).toEqual({ isRepo: false, branch: null, hasUpstream: false, unpushed: [] });
  });

  it('does not warn on a detached HEAD', async () => {
    const { work, commit } = makeRepoWithRemote();
    commit('feat: first');
    commit('feat: second');
    const head = git(work, 'rev-parse', 'HEAD');
    git(work, 'checkout', head);

    const state = await getUnpushedState(work);
    expect(state.branch).toBeNull();
    expect(formatUnpushedWarning(state, work)).toBeNull();
  });

  it('detects unpushed commits inside a git worktree on a feature branch (the target flow)', async () => {
    const { work, commit } = makeRepoWithRemote();
    commit('chore: base');
    git(work, 'push', '-u', 'origin', 'main');

    const wt = path.join(work, '.wt-feature');
    git(work, 'worktree', 'add', '-b', 'agents/feature', wt, 'HEAD');
    fs.writeFileSync(path.join(wt, 'w.txt'), 'work');
    git(wt, 'add', '-A');
    git(wt, '-c', 'user.email=t@e.co', '-c', 'user.name=T', 'commit', '-m', 'feat: work in worktree');

    const state = await getUnpushedState(wt);
    expect(state.branch).toBe('agents/feature');
    expect(state.hasUpstream).toBe(false);
    expect(state.unpushed.map((c) => c.subject)).toEqual(['feat: work in worktree']);
  });
});

describe('warnUnpushedWork (wired entry point)', () => {
  it('writes a warning to stderr for unpushed work, and nothing once pushed', async () => {
    const { work, commit } = makeRepoWithRemote();
    commit('feat: only');

    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await warnUnpushedWork(work);
      const printed = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain("not pushed to any remote");
      expect(printed).toContain('feat: only');

      spy.mockClear();
      git(work, 'push', '-u', 'origin', 'main');
      await warnUnpushedWork(work);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws on a non-git directory', async () => {
    const dir = makeTempDir('warn-unpushed-safe-');
    await expect(warnUnpushedWork(dir)).resolves.toBeUndefined();
  });
});

describe('shouldWarnUnpushed (the exit-path gate)', () => {
  it('fires for writable headless runs', () => {
    expect(shouldWarnUnpushed('edit', false)).toBe(true);
    expect(shouldWarnUnpushed('skip', false)).toBe(true);
    expect(shouldWarnUnpushed('auto', false)).toBe(true);
  });

  it('stays silent for read-only plan mode, even headless', () => {
    expect(shouldWarnUnpushed('plan', false)).toBe(false);
  });

  it('stays silent for interactive runs, even in a writable mode', () => {
    expect(shouldWarnUnpushed('edit', true)).toBe(false);
    expect(shouldWarnUnpushed('skip', true)).toBe(false);
  });
});

describe('formatUnpushedWarning', () => {
  it('lists commits and the correct push command (no upstream -> push -u)', () => {
    const warning = formatUnpushedWarning(
      {
        isRepo: true,
        branch: 'agents/foo',
        hasUpstream: false,
        unpushed: [{ sha: 'd83c5d4', subject: 'fix: thing' }],
      },
      '/repo',
    );
    expect(warning).not.toBeNull();
    expect(warning).toContain("agent left 1 commit on 'agents/foo'");
    expect(warning).toContain('d83c5d4 fix: thing');
    expect(warning).toContain('git -C "/repo" push -u origin agents/foo');
    expect(warning).toContain('gh pr create --head agents/foo');
  });

  it('uses a bare `git push` when an upstream exists, and caps the list at 5', () => {
    const unpushed = Array.from({ length: 7 }, (_, i) => ({ sha: `sha${i}`, subject: `c${i}` }));
    const warning = formatUnpushedWarning(
      { isRepo: true, branch: 'b', hasUpstream: true, unpushed },
      '/r',
    )!;
    expect(warning).toContain('git -C "/r" push');
    expect(warning).not.toContain('push -u');
    expect(warning).toContain('… and 2 more');
    expect(warning).toContain('agent left 7 commits');
  });
});
