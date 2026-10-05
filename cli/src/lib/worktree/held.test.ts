import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyHeld,
  collectHeldWorktrees,
  summarizeHeld,
  aggregateHeld,
  pushStrandedBranch,
  type HeldWorktree,
} from './held.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-held-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function configureIdentity(repo: string): void {
  git(repo, ['config', 'user.email', 'held-test@example.invalid']);
  git(repo, ['config', 'user.name', 'Held Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
}

function makeRepo(): { repo: string; origin: string } {
  const root = tempDir();
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(origin);
  git(origin, ['init', '--bare', '--initial-branch=main']);

  const repo = path.join(root, 'checkout');
  git(root, ['clone', origin, 'checkout']);
  configureIdentity(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# root\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  fs.mkdirSync(path.join(repo, '.agents', 'worktrees'), { recursive: true });
  return { repo, origin };
}

function addWorktree(repo: string, slug: string): string {
  const wt = path.join(repo, '.agents', 'worktrees', slug);
  git(repo, ['worktree', 'add', '-b', slug, wt, 'main']);
  configureIdentity(wt);
  return wt;
}

function commitInto(wt: string, file: string, body: string, msg: string): void {
  fs.writeFileSync(path.join(wt, file), body);
  git(wt, ['add', '.']);
  git(wt, ['commit', '-m', msg]);
}

describe('classifyHeld (pure)', () => {
  it('surfaces unmerged commits even when the tree is also dirty', () => {
    expect(classifyHeld({ branch: 'b', dirtyFiles: 3, unmergedCommits: 2 })).toEqual({
      bucket: 'unmerged-commits',
      reason: 'unmerged-commits',
    });
  });

  it('an undeterminable merge state fails closed, never "clean"', () => {
    expect(classifyHeld({ branch: 'b', dirtyFiles: 0, unmergedCommits: -1 })).toEqual({
      bucket: 'undeterminable',
      reason: 'merge-state-unknown',
    });
  });

  it('an unreadable status on a merged branch is its own broken-checkout bucket', () => {
    expect(classifyHeld({ branch: 'b', dirtyFiles: -1, unmergedCommits: 0 })).toEqual({
      bucket: 'undeterminable',
      reason: 'status-unreadable',
    });
  });

  it('a dirty-but-merged tree is uncommitted-changes', () => {
    expect(classifyHeld({ branch: 'b', dirtyFiles: 2, unmergedCommits: 0 })).toEqual({
      bucket: 'uncommitted-changes',
      reason: 'uncommitted-changes',
    });
  });

  it('a clean, fully-upstream worktree is not held', () => {
    expect(classifyHeld({ branch: 'b', dirtyFiles: 0, unmergedCommits: 0 })).toBeNull();
  });
});

describe('collectHeldWorktrees (real git)', () => {
  it('breaks the held set into its three buckets instead of one count', async () => {
    const { repo } = makeRepo();

    const stranded = addWorktree(repo, 'phnx-2732-stranded');
    commitInto(stranded, 'feature.ts', 'export const x = 1;\n', 'feat: real work');

    const dirty = addWorktree(repo, 'dirty-tree');
    fs.writeFileSync(path.join(dirty, 'scratch.txt'), 'wip\n');

    const clean = addWorktree(repo, 'already-merged');
    void clean;

    const held = await collectHeldWorktrees(repo);
    const summary = summarizeHeld(held);

    expect(summary.buckets['unmerged-commits'].map((w) => w.name)).toEqual(['phnx-2732-stranded']);
    expect(summary.buckets['uncommitted-changes'].map((w) => w.name)).toEqual(['dirty-tree']);
    expect(held.find((w) => w.name === 'already-merged')).toBeUndefined();

    const strandedRow = summary.buckets['unmerged-commits'][0];
    expect(strandedRow.unmergedCommits).toBe(1);
    expect(strandedRow.hasRemoteBranch).toBe(false);
    expect(strandedRow.branch).toBe('phnx-2732-stranded');
  });

  it('a stranded branch already pushed to origin reads as on-remote (not a push candidate)', async () => {
    const { repo } = makeRepo();
    const wt = addWorktree(repo, 'pushed-branch');
    commitInto(wt, 'a.ts', '1\n', 'feat: work');
    git(wt, ['push', '-u', 'origin', 'pushed-branch']);

    const held = await collectHeldWorktrees(repo);
    const row = held.find((w) => w.name === 'pushed-branch');
    expect(row?.bucket).toBe('unmerged-commits');
    expect(row?.hasRemoteBranch).toBe(true);
  });
});

describe('pushStrandedBranch (real git — the safe recovery action)', () => {
  it('publishes an on-no-remote stranded branch to origin, deleting nothing', async () => {
    const { repo, origin } = makeRepo();
    const wt = addWorktree(repo, 'phnx-2951-lost');
    commitInto(wt, 'lost.ts', 'export const y = 2;\n', 'feat: stranded work');

    const [row] = (await collectHeldWorktrees(repo)).filter((w) => w.name === 'phnx-2951-lost');
    expect(row.hasRemoteBranch).toBe(false);

    const res = await pushStrandedBranch(repo, row);
    expect(res.pushed).toBe(true);

    expect(git(origin, ['branch', '--list', 'phnx-2951-lost'])).toContain('phnx-2951-lost');
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(wt, 'lost.ts'))).toBe(true);

    const again = await pushStrandedBranch(repo, row);
    expect(again.pushed).toBe(false);
    expect(again.reason).toContain('already on origin');
  });

  it('refuses to push a branch that is no longer stranded (re-reads facts)', async () => {
    const { repo } = makeRepo();
    const wt = addWorktree(repo, 'went-clean');
    commitInto(wt, 'a.ts', '1\n', 'feat: work');
    const [row] = (await collectHeldWorktrees(repo)).filter((w) => w.name === 'went-clean');

    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--ff-only', 'went-clean']);
    git(repo, ['push', 'origin', 'main']);

    const res = await pushStrandedBranch(repo, row);
    expect(res.pushed).toBe(false);
    expect(res.reason).toContain('no longer stranded');
  });
});

describe('aggregateHeld (pure fleet roll-up)', () => {
  it('stamps each entry with its source device and sums per bucket', () => {
    const mk = (name: string, bucket: HeldWorktree['bucket']): HeldWorktree => ({
      repo: '/r', repoName: 'r', name, path: `/r/.agents/worktrees/${name}`, branch: name,
      bucket, reason: bucket === 'undeterminable' ? 'status-unreadable' : bucket,
      unmergedCommits: bucket === 'unmerged-commits' ? 1 : 0, dirtyFiles: 0,
      hasRemoteBranch: false, ageDays: 5, sizeBytes: 10,
    });
    const agg = aggregateHeld([
      { device: 'yosemite-s0', held: [mk('a', 'unmerged-commits'), mk('b', 'uncommitted-changes')] },
      { device: 'zion', held: [mk('c', 'unmerged-commits')] },
    ]);
    expect(agg.total).toBe(3);
    expect(agg.buckets['unmerged-commits'].map((w) => (w as any).device)).toEqual(['yosemite-s0', 'zion']);
    expect(agg.devices).toEqual([
      { device: 'yosemite-s0', total: 2 },
      { device: 'zion', total: 1 },
    ]);
  });

  it('filtering to one bucket keeps total/devices consistent with the shown rows', () => {
    const mk = (name: string, bucket: HeldWorktree['bucket']): HeldWorktree => ({
      repo: '/r', repoName: 'r', name, path: `/r/.agents/worktrees/${name}`, branch: name,
      bucket, reason: bucket === 'undeterminable' ? 'status-unreadable' : bucket,
      unmergedCommits: bucket === 'unmerged-commits' ? 1 : 0, dirtyFiles: 0,
      hasRemoteBranch: false, ageDays: 1, sizeBytes: 1,
    });
    const perDevice = [
      { device: 'a', held: [mk('u1', 'unmerged-commits'), mk('d1', 'uncommitted-changes')] },
      { device: 'b', held: [mk('u2', 'unmerged-commits')] },
    ];
    const bucket: HeldWorktree['bucket'] = 'unmerged-commits';
    const scoped = perDevice.map((d) => ({ device: d.device, held: d.held.filter((w) => w.bucket === bucket) }));
    const agg = aggregateHeld(scoped);

    expect(agg.total).toBe(2);
    expect(agg.total).toBe(agg.buckets['unmerged-commits'].length);
    expect(agg.buckets['uncommitted-changes']).toEqual([]);
    expect(agg.devices).toEqual([
      { device: 'a', total: 1 },
      { device: 'b', total: 1 },
    ]);
  });
});
